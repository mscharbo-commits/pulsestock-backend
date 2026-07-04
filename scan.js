// PulseStock Universe Scanner — run nightly: node scan.js
// v2.1 fixed
// Full scoring: Polygon (technicals + news) + Market/Sector context + Haiku AI ranking

const https = require('https');
const http = require('http');

const POLY_KEY = process.env.POLYGON_API_KEY || 'qpe_fbt2WsRl8D2YquOMzbzYlWcywazt';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const TICKER_URL = 'https://raw.githubusercontent.com/mscharbo-commits/pulsestock-study-data/main/ticker_universe.json';

function fetchJson(url, opts = {}) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 10000);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      method: opts.method || 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', ...opts.headers }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        clearTimeout(timeout);
        try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(null); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function poly(ep) {
  await delay(120);
  return fetchJson(`https://api.polygon.io${ep}`, {
    headers: { 'Authorization': `Bearer ${POLY_KEY}` }
  });
}

async function sb(method, table, data, params = '') {
  return fetchJson(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: data ? JSON.stringify(data) : undefined
  });
}

// ── MARKET CONTEXT (runs once at scan start) ──
async function getMarketContext() {
  console.log('[Scan] Fetching market context (SPY, VIX, sector ETFs)...');
  
  const [spy, vix, xlk, xlf, xle, xlv, xli, xlp, xlu, xlb, xly, xlre, xlc] = await Promise.all([
    poly('/v2/aggs/ticker/SPY/prev'),
    poly('/v2/aggs/ticker/VIXY/prev'), // VIX proxy ETF
    poly('/v2/aggs/ticker/XLK/prev'),  // Tech
    poly('/v2/aggs/ticker/XLF/prev'),  // Financials
    poly('/v2/aggs/ticker/XLE/prev'),  // Energy
    poly('/v2/aggs/ticker/XLV/prev'),  // Healthcare
    poly('/v2/aggs/ticker/XLI/prev'),  // Industrials
    poly('/v2/aggs/ticker/XLP/prev'),  // Consumer Staples
    poly('/v2/aggs/ticker/XLU/prev'),  // Utilities
    poly('/v2/aggs/ticker/XLB/prev'),  // Materials
    poly('/v2/aggs/ticker/XLY/prev'),  // Consumer Discretionary
    poly('/v2/aggs/ticker/XLRE/prev'), // Real Estate
    poly('/v2/aggs/ticker/XLC/prev')   // Communication
  ]);

  const getReturn = (d) => {
    const r = d?.results?.[0];
    if (!r || !r.o) return null;
    return ((r.c - r.o) / r.o * 100).toFixed(2);
  };

  const spyRet = getReturn(spy);
  const vixLevel = vix?.results?.[0]?.c;

  const sectorReturns = {
    'XLK (Tech)': getReturn(xlk),
    'XLF (Financials)': getReturn(xlf),
    'XLE (Energy)': getReturn(xle),
    'XLV (Healthcare)': getReturn(xlv),
    'XLI (Industrials)': getReturn(xli),
    'XLP (Staples)': getReturn(xlp),
    'XLU (Utilities)': getReturn(xlu),
    'XLB (Materials)': getReturn(xlb),
    'XLY (Discretionary)': getReturn(xly),
    'XLRE (Real Estate)': getReturn(xlre),
    'XLC (Communication)': getReturn(xlc)
  };

  // Identify leading and lagging sectors
  const sorted = Object.entries(sectorReturns)
    .filter(([,v]) => v !== null)
    .sort((a,b) => parseFloat(b[1]) - parseFloat(a[1]));

  const leading = sorted.slice(0, 3).map(([k,v]) => `${k}:+${v}%`).join(', ');
  const lagging = sorted.slice(-3).map(([k,v]) => `${k}:${v}%`).join(', ');

  const regime = parseFloat(spyRet) > 0.3 ? 'BULL' : parseFloat(spyRet) < -0.3 ? 'BEAR' : 'NEUTRAL';
  const vixWarning = vixLevel && vixLevel > 20 ? `HIGH VIX (${vixLevel}) — reduce position sizing, wider stops` : `Low volatility (VIX proxy: ${vixLevel || '?'})`;

  const context = {
    spyReturn: spyRet,
    regime,
    vixLevel,
    vixWarning,
    leading,
    lagging,
    sectorReturns,
    summary: `Market: SPY${spyRet >= 0 ? '+' : ''}${spyRet}% (${regime}). ${vixWarning}. Leading sectors: ${leading}. Lagging: ${lagging}.`
  };

  console.log(`[Market] ${context.summary}`);
  return context;
}

// ── NEWS FETCHER ──
async function getTickerNews(ticker) {
  await delay(100);
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
  const d = await poly(`/v2/reference/news?ticker=${ticker}&published_utc.gte=${weekAgo}&limit=5&sort=published_utc&order=desc`);
  const articles = d?.results || [];
  if (!articles.length) return null;
  // Return just the headlines for Haiku to analyze
  return articles.map(a => a.title).slice(0, 5).join(' | ');
}

// ── POLYGON DATA ──
async function getPrevDay(ticker) {
  const d = await poly(`/v2/aggs/ticker/${ticker}/prev`);
  return d?.results?.[0] || null;
}

async function getTickerDetails(ticker) {
  const d = await poly(`/v3/reference/tickers/${ticker}`);
  return d?.results || null;
}

async function getSnapshot(ticker) {
  const d = await poly(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
  return d?.ticker || null;
}

async function getFinancials(ticker) {
  const d = await poly(`/vX/reference/financials?ticker=${ticker}&limit=4&timeframe=quarterly`);
  return d?.results || null;
}

// ── HAIKU BATCH SCORER ──
async function haikuScore(batch, strategy, marketContext) {
  if (!ANTHROPIC_KEY || !batch.length) return {};

  const weights = {
    momentum:   { tech: 30, fundamental: 25, news: 25, sector: 20 },
    compounder: { tech: 20, fundamental: 40, news: 15, sector: 25 },
    catalyst:   { tech: 25, fundamental: 15, news: 45, sector: 15 }
  };
  const w = weights[strategy];

  const stratRules = {
    momentum: `MOMENTUM GROWTH RULES:
- TECHNICALS (${w.tech}%): Price structure HH/HL is paramount. VWAP above = institutional buying. RSI 45-75 building not exhausted. Relative strength vs sector ETF positive. PENALIZE heavily: downtrends, broken structure, RSI>80 exhausted.
- FUNDAMENTALS (${w.fundamental}%): Must show 2+ consecutive quarters of revenue growth. Positive EPS trend. Reasonable valuation. PENALIZE: negative revenue growth, earnings misses, China-domiciled companies (score 0-10 max).
- NEWS (${w.news}%): Score HIGH for: earnings beats, guidance raises, analyst upgrades, product launches, major contract wins. Score LOW for: general market commentary, price target reiterations with no change, irrelevant mentions. Score NEAR ZERO for: earnings misses, guidance cuts, lawsuits, SEC investigations, CEO departure.
- SECTOR (${w.sector}%): Heavily favor sectors currently leading the market. PENALIZE sectors with negative momentum. ${marketContext.summary}`,

    compounder: `QUALITY COMPOUNDER RULES:
- TECHNICALS (${w.tech}%): Technical setup confirms entry timing only. Not overbought (RSI<76). Not in downtrend. Near VWAP (not extended). 
- FUNDAMENTALS (${w.fundamental}%): Durable moat required (network effects/switching costs/brand/patents). Positive FCF. Expanding margins. ROIC>WACC. Low debt. Score utilities (XLU) and REITs lower as they lack growth moats. Score 0-10 for commoditized businesses.
- NEWS (${w.news}%): Use primarily as RED FLAG DETECTOR. Score VERY LOW for: guidance cuts, margin compression, key management departure, competitive threat news, regulatory issues. Score neutral (50) for no meaningful news. Score higher for moat-strengthening news (new patent, contract, partnership).
- SECTOR (${w.sector}%): Favor sectors with durable long-term tailwinds (tech, healthcare, financials with moats). ${marketContext.summary}`,

    catalyst: `CATALYST SWING RULES:
- TECHNICALS (${w.tech}%): VWAP above is the PRIMARY gate — if below VWAP score 0-15 max. RSI 40-70 with building momentum. Fresh relative strength breakout. Crowd not yet fully positioned. PENALIZE: already extended 15%+ from VWAP, utilities (wrong sector for catalyst swing), downtrends.
- FUNDAMENTALS (${w.fundamental}%): Only context for the 3-10 day hold. Positive business trajectory helps but is secondary. 
- NEWS (${w.news}%): THIS IS THE MOST IMPORTANT DIMENSION FOR CATALYST SWING. Score VERY HIGH (80-95) for: confirmed earnings date within 10 days, FDA decision pending, confirmed product launch, stock split effective, analyst day, major contract announcement, index inclusion. Score HIGH (60-75) for: strong recent news flow showing momentum building, analyst upgrades, positive sector news. Score LOW (10-30) for: no meaningful news, general market mentions. UTILITIES SCORE 0-15 ON NEWS regardless of other factors — they are wrong strategy fit.
- SECTOR (${w.sector}%): Strongly favor sectors with active catalysts and momentum. PENALIZE utilities (XLU), staples (XLP), REITs for catalyst swing — wrong profile entirely. ${marketContext.summary}`
  };

  const tickerLines = batch.map(t => {
    const d = t.data;
    const news = t.news ? `News: "${t.news.substring(0, 150)}"` : 'News: none available';
    return `${t.ticker}: VWAP${d.vwapAbove?'↑ABOVE':'↓BELOW'} DayMom${d.dayMomentum>0?'+':''}${d.dayMomentum}% RevGrowth${d.revenueGrowth?(d.revenueGrowth*100).toFixed(0)+'%':'unknown'} MktCap${d.marketCap?'$'+Math.round(d.marketCap/1e9)+'B':'unknown'} | ${news}`;
  }).join('\n');

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: `You are a stock screener. Apply these rules strictly:\n${stratRules[strategy]}\n\nCRITICAL: Every ticker in your response MUST have a UNIQUE score. Do not assign the same score to multiple tickers. Rank them precisely from best to worst fit for this strategy. Respond ONLY with a JSON object.`,
    messages: [{
      role: 'user',
      content: `Score each ticker 0-100 for ${strategy} strategy. EVERY score must be unique — differentiate precisely based on the evidence. Utilities like WEC/ATO/DUK/AEE score 0-20 for catalyst strategy.\n\nTickers to score:\n${tickerLines}\n\nReturn JSON only with unique scores: {"TICK1": 87, "TICK2": 74, "TICK3": 61, ...} — NO duplicate values allowed.`
    }]
  });

  const result = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body
  });

  const text = result?.content?.find(b => b.type === 'text')?.text || '';
  try {
    const clean = text.replace(/```json\n?/g,'').replace(/```/g,'').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    return JSON.parse(clean.substring(start, end+1));
  } catch(e) { return {}; }
}

// ── MAIN ──
async function main() {
  console.log('[Scan] Starting PulseStock universe scan...');
  console.log('[Scan] Sources: Polygon (price/VWAP/news/financials) + Haiku AI (strategy scoring)');

  const universe = await fetchJson(TICKER_URL);
  const tickers = universe?.all || [];
  console.log(`[Scan] ${tickers.length} tickers to scan`);

  // Get market context FIRST — used in all Haiku scoring
  const marketContext = await getMarketContext();

  const today = new Date().toISOString().split('T')[0];
  const strategies = ['momentum', 'compounder', 'catalyst'];

  // Phase 1: Collect data for all tickers
  console.log('\n[Scan] Phase 1: Collecting Polygon data...');
  const allData = {};
  let processed = 0;

  for (const ticker of tickers) {
    processed++;

    const prev = await getPrevDay(ticker);
    if (!prev || !prev.c || prev.c <= 0 || !prev.vw) {
      if (processed % 500 === 0) console.log(`[Scan] ${processed}/${tickers.length} — ${Object.keys(allData).length} valid`);
      continue;
    }

    // Quality filters
    if (!prev.v || prev.v < 500000) { if (processed % 500 === 0) console.log(`[Scan] ${processed}/${tickers.length} — ${Object.keys(allData).length} valid`); continue; }
    if (!prev.h || !prev.l) { if (processed % 500 === 0) console.log(`[Scan] ${processed}/${tickers.length} — ${Object.keys(allData).length} valid`); continue; }
    const dayRangePct = (prev.h - prev.l) / prev.l * 100;
    if (dayRangePct < 0.5 || dayRangePct > 25) { if (processed % 500 === 0) console.log(`[Scan] ${processed}/${tickers.length} — ${Object.keys(allData).length} valid`); continue; }
    const vwapDev = Math.abs(prev.c - prev.vw) / prev.vw * 100;
    if (vwapDev > 20) { if (processed % 500 === 0) console.log(`[Scan] ${processed}/${tickers.length} — ${Object.keys(allData).length} valid`); continue; }

    const vwapAbove = prev.c > prev.vw;
    const dayMomentum = parseFloat(((prev.c - prev.o) / prev.o * 100).toFixed(2));

    // Get snapshot for 52W range position (critical for structure gate)
    const snap = await getSnapshot(ticker);
    const w52h = snap?.day?.h || snap?.prevDay?.h || null; // use day high as proxy
    const todayHigh = snap?.day?.h || null;
    const todayLow = snap?.day?.l || null;
    
    // Get 52W range from reference endpoint
    const details = await getTickerDetails(ticker);
    const marketCap = details?.market_cap || null;
    const sharesFl = details?.share_class_shares_outstanding || null;

    // Compute 52W range position using Polygon aggregates (1 year)
    const yearAgo = new Date(Date.now() - 365*86400000).toISOString().split('T')[0];
    const today52 = new Date().toISOString().split('T')[0];
    const aggs = await poly('/v2/aggs/ticker/'+ticker+'/range/1/day/'+yearAgo+'/'+today52+'?adjusted=true&sort=asc&limit=252');
    let rangePos = null;
    if (aggs?.results?.length > 10) {
      const highs = aggs.results.map(r => r.h);
      const lows = aggs.results.map(r => r.l);
      const yearHigh = Math.max(...highs);
      const yearLow = Math.min(...lows);
      if (yearHigh > yearLow) {
        rangePos = parseFloat(((prev.c - yearLow) / (yearHigh - yearLow) * 100).toFixed(1));
      }
    }

    // Get financials for established companies
    let revenueGrowth = null;
    let marginTrend = null;
    if (marketCap && marketCap > 5e7) {
      const financials = await getFinancials(ticker);
      if (financials && financials.length >= 2) {
        const q1rev = financials[0]?.financials?.income_statement?.revenues?.value;
        const q2rev = financials[1]?.financials?.income_statement?.revenues?.value;
        if (q1rev && q2rev && q2rev > 0) revenueGrowth = parseFloat(((q1rev - q2rev) / q2rev).toFixed(3));
        const q1ni = financials[0]?.financials?.income_statement?.net_income_loss?.value;
        const q2ni = financials[1]?.financials?.income_statement?.net_income_loss?.value;
        if (q1ni !== null && q2ni !== null) marginTrend = q1ni > q2ni ? 'expanding' : 'contracting';
      }
    }

    // Get news
    const news = await getTickerNews(ticker);

    allData[ticker] = {
      price: prev.c, vwap: prev.vw, vwapAbove, dayMomentum,
      volume: prev.v, marketCap, revenueGrowth, marginTrend, news,
      rangePos, sharesFl
    };

    if (processed % 100 === 0) {
      console.log(`[Scan] Phase 1: ${processed}/${tickers.length} — ${Object.keys(allData).length} valid`);
    }
  }

  console.log(`\n[Scan] Phase 1 complete: ${Object.keys(allData).length} tickers with valid data`);

  // Phase 2 & 3: Filter + AI score per strategy
  for (const strategy of strategies) {
    console.log(`\n[Scan] Processing ${strategy}...`);

    const filtered = Object.keys(allData).filter(t => {
      const d = allData[t];
      // Apply SAME hard gates Sonnet uses — so 75%+ of candidates pass deep dive
      if (strategy === 'momentum') {
        if (!d.vwapAbove) return false;                    // must be above VWAP
        if (d.volume < 1000000) return false;              // minimum volume
        if (d.rangePos !== null && d.rangePos < 55) return false;  // must be in uptrend
        return true;
      }
      if (strategy === 'compounder') {
        if (!d.marketCap || d.marketCap < 1e9) return false;  // $1B+ market cap
        if (d.rangePos !== null && d.rangePos < 40) return false;  // not in deep downtrend
        return true;
      }
      if (strategy === 'catalyst') {
        if (!d.vwapAbove) return false;                    // VWAP hard gate
        if (d.volume < 500000) return false;               // minimum volume
        if (d.rangePos !== null && (d.rangePos < 30 || d.rangePos > 85)) return false; // not at extremes
        return true;
      }
      return true;
    });

    console.log(`[Scan] ${strategy}: ${filtered.length} pass mechanical filter`);

    // Haiku scoring in batches of 15 (smaller for better differentiation)
    const aiScores = {};
    if (ANTHROPIC_KEY && filtered.length > 0) {
      console.log(`[Scan] ${strategy}: AI scoring with market context + news...`);
      const BATCH = 15;
      for (let i = 0; i < filtered.length; i += BATCH) {
        const batch = filtered.slice(i, i+BATCH).map(t => ({
          ticker: t,
          data: allData[t],
          news: allData[t].news
        }));
        const scores = await haikuScore(batch, strategy, marketContext);
        Object.assign(aiScores, scores);
        if (i % 150 === 0 && i > 0) console.log(`[Scan] ${strategy}: AI scored ${i}/${filtered.length}`);
        await delay(200);
      }
    }

    // Rank by AI score (primary) + mechanical boost
    const ranked = filtered.map(t => {
      const d = allData[t];
      const aiScore = aiScores[t] || 0;
      let mech = 0;
      if (d.vwapAbove) mech += 20;
      if (d.dayMomentum > 0) mech += 15;
      if (d.revenueGrowth && d.revenueGrowth > 0) mech += 20;
      if (d.marginTrend === 'expanding') mech += 10;
      if (d.marketCap && d.marketCap > 1e9) mech += 10;
      if (d.news) mech += 5; // has recent news

      const combined = aiScore > 0 ? (mech * 0.25) + (aiScore * 0.75) : mech;
      return {
        ticker: t, score: parseFloat(combined.toFixed(2)),
        price: d.price, vwap: d.vwap, vwapAbove: d.vwapAbove,
        revenueGrowth: d.revenueGrowth, marketCap: d.marketCap,
        hasNews: !!d.news,
        reason: `AI:${aiScore||'?'} VWAP${d.vwapAbove?'↑':'↓'} Mom${d.dayMomentum>0?'+':''}${d.dayMomentum}% Rev${d.revenueGrowth?(d.revenueGrowth*100).toFixed(0)+'%':'?'} News:${d.news?'yes':'no'}`
      };
    }).sort((a,b) => b.score - a.score);

    // Apply minimum score cutoff — only genuinely high-conviction candidates
    const MIN_SCORE = 65;
    const qualified = ranked.filter(r => r.score >= MIN_SCORE);
    console.log(`[Scan] ${strategy}: ${ranked.length} ranked, ${qualified.length} above ${MIN_SCORE} threshold — Top 5: ${(qualified.length ? qualified : ranked).slice(0,5).map(r=>r.ticker+'('+r.score+')').join(', ')}`);

    // Use qualified list, fall back to top 50 if too few qualify
    const toSave = qualified.length >= 10 ? qualified : ranked.slice(0, 50);

    // Save to Supabase
    await sb('DELETE', 'pre_screened_candidates', null, `?strategy_id=eq.${strategy}&trading_date=eq.${today}`);
    for (let i = 0; i < toSave.length; i++) {
      const c = toSave[i];
      await sb('POST', 'pre_screened_candidates', {
        strategy_id: strategy, ticker: c.ticker, rank: i+1,
        screen_score: c.score, screen_reason: c.reason,
        price: c.price, trading_date: today
      });
      if (i % 100 === 0 && i > 0) console.log(`[Scan] ${strategy}: saved ${i}/${ranked.length}`);
    }
    console.log(`[Scan] ${strategy}: saved ${toSave.length} qualified candidates (score >= ${MIN_SCORE})`);
  }

  console.log('\n[Scan] Complete!');
  process.exit(0);
}

main().catch(e => { console.error('[Scan] Fatal:', e.message); process.exit(1); });
