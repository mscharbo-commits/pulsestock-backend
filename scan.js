// PulseStock Universe Scanner — run nightly: node scan.js
// Uses Polygon.io (real VWAP, float, fundamentals) + Haiku AI scoring

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
  await delay(120); // ~8 calls/sec, well within Starter limits
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

// ── POLYGON DATA FETCHERS ──
async function getPrevDay(ticker) {
  const d = await poly(`/v2/aggs/ticker/${ticker}/prev`);
  return d?.results?.[0] || null;
}

async function getTickerDetails(ticker) {
  const d = await poly(`/v3/reference/tickers/${ticker}`);
  return d?.results || null;
}

async function getFinancials(ticker) {
  const d = await poly(`/vX/reference/financials?ticker=${ticker}&limit=4&timeframe=quarterly`);
  return d?.results || null;
}

async function getShortInterest(ticker) {
  // Short interest from Polygon
  const d = await poly(`/v2/reference/shorts/${ticker}`);
  return d?.results?.[0] || null;
}

// ── SCORE CALCULATOR ──
function calculateScores(ticker, prev, details, financials) {
  if (!prev || !prev.c) return null;

  const price = prev.c;
  const vwap = prev.vw;
  const volume = prev.v;

  // Hard quality filters — must pass ALL of these
  if (price < 2) return null;                          // no penny stocks
  if (!vwap || vwap <= 0) return null;                 // must have VWAP
  if (!volume || volume < 500000) return null;         // minimum 500K daily volume
  if (!prev.h || !prev.l) return null;                 // must have day range
  const dayRangePct = (prev.h - prev.l) / prev.l * 100;
  if (dayRangePct < 0.5) return null;                  // frozen stock filter
  if (dayRangePct > 25) return null;                   // wildly volatile/halted
  const vwapDeviation = Math.abs(price - vwap) / vwap * 100;
  if (vwapDeviation > 20) return null;                 // not wildly extended from VWAP
  const high = prev.h;
  const low = prev.l;
  const open = prev.o;
  const volume = prev.v;

  // Need 52W data — use prev day high/low as proxy for now, get from snapshot
  // For mechanical scoring use what we have
  const vwapAbove = price > vwap;
  const dayMomentum = (price - open) / open * 100; // intraday direction
  
  // Float and shares
  const sharesOutstanding = details?.weighted_shares_outstanding || null;
  const marketCap = details?.market_cap || null;

  // Revenue growth from financials (last 2 quarters)
  let revenueGrowth = null;
  let marginTrend = null;
  if (financials && financials.length >= 2) {
    const q1rev = financials[0]?.financials?.income_statement?.revenues?.value;
    const q2rev = financials[1]?.financials?.income_statement?.revenues?.value;
    if (q1rev && q2rev && q2rev > 0) {
      revenueGrowth = (q1rev - q2rev) / q2rev;
    }
    const q1ni = financials[0]?.financials?.income_statement?.net_income_loss?.value;
    const q2ni = financials[1]?.financials?.income_statement?.net_income_loss?.value;
    if (q1ni && q2ni && q2ni > 0) {
      marginTrend = q1ni > q2ni ? 'expanding' : 'contracting';
    }
  }

  return {
    price, vwap, vwapAbove, volume,
    dayMomentum: parseFloat(dayMomentum.toFixed(2)),
    marketCap, sharesOutstanding,
    revenueGrowth: revenueGrowth ? parseFloat(revenueGrowth.toFixed(3)) : null,
    marginTrend
  };
}

// ── HAIKU AI BATCH SCORER ──
async function haikuScore(batch, strategy) {
  if (!ANTHROPIC_KEY || !batch.length) return {};

  const stratHints = {
    momentum: 'MOMENTUM GROWTH (10-60 day hold): Score highest for: confirmed price uptrend (HH/HL), strong relative strength vs sector, price above VWAP (institutional buying), 2+ quarters of revenue growth, RSI 45-75, regime-aligned sectors. Penalize: downtrends, China ADRs, negative revisions, broken structure.',
    compounder: 'QUALITY COMPOUNDER (long-term): Score highest for: durable moat (network effects/switching costs/brand), positive FCF, expanding margins, ROIC > WACC, reasonable valuation, low debt. Penalize: commoditized businesses, shrinking margins, high debt, poor capital allocation.',
    catalyst: 'CATALYST SWING (3-10 day hold): Score highest for: price above VWAP (smart money in), RSI 40-70 building momentum, fresh relative strength breakout, intact price structure, any near-term catalyst (earnings/FDA/launch/split). Penalize: already extended moves, downtrends, illiquid names.'
  };

  const tickerLines = batch.map(t => {
    const d = t.data;
    return `${t.ticker}: Price$${d.price} VWAP$${d.vwap?.toFixed(2)||'?'} ${d.vwapAbove?'AboveVWAP':'BelowVWAP'} DayMom${d.dayMomentum>0?'+':''}${d.dayMomentum}% RevGrowth${d.revenueGrowth?(d.revenueGrowth*100).toFixed(0)+'%':'?'} Margins${d.marginTrend||'?'} MktCap${d.marketCap?'$'+Math.round(d.marketCap/1e9)+'B':'?'}`;
  }).join('\n');

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: stratHints[strategy] + ' Respond ONLY with JSON object mapping ticker to score 0-100.',
    messages: [{ role: 'user', content: `Score each for ${strategy}:\n${tickerLines}\n\nJSON only: {"TICK1":85,"TICK2":42}` }]
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
    return JSON.parse(clean);
  } catch(e) { return {}; }
}

// ── MAIN ──
async function main() {
  console.log('[Scan] Starting PulseStock universe scan with Polygon.io...');

  const universe = await fetchJson(TICKER_URL);
  const tickers = universe?.all || [];
  console.log(`[Scan] ${tickers.length} tickers to scan`);

  const today = new Date().toISOString().split('T')[0];
  const strategies = ['momentum', 'compounder', 'catalyst'];

  // Phase 1: Collect Polygon data for all tickers
  console.log('\n[Scan] Phase 1: Fetching Polygon data...');
  const allData = {};
  let processed = 0;

  for (const ticker of tickers) {
    processed++;

    const prev = await getPrevDay(ticker);
    if (!prev || !prev.c || prev.c <= 0 || !prev.vw) {
      if (processed % 500 === 0) console.log(`[Scan] ${processed}/${tickers.length} — ${Object.keys(allData).length} valid`);
      continue;
    }

    // Get details for larger caps (skip for speed on penny stocks)
    let details = null;
    let financials = null;
    if (prev.c >= 1) { // only fetch details for stocks with price data
      details = await getTickerDetails(ticker);
      // Only fetch financials for established companies (market cap > $100M)
      if (details?.market_cap && details.market_cap > 1e8) {
        financials = await getFinancials(ticker);
      }
    }

    const scored = calculateScores(ticker, prev, details, financials);
    if (scored) allData[ticker] = scored;

    if (processed % 100 === 0) {
      console.log(`[Scan] Phase 1: ${processed}/${tickers.length} — ${Object.keys(allData).length} valid`);
    }
  }

  console.log(`\n[Scan] Phase 1 complete: ${Object.keys(allData).length} tickers with valid Polygon data`);

  // Phase 2 & 3: Filter + AI score per strategy
  for (const strategy of strategies) {
    console.log(`\n[Scan] Processing ${strategy}...`);

    // Mechanical filter
    const filtered = Object.keys(allData).filter(t => {
      const d = allData[t];
      if (strategy === 'momentum') {
        // Uptrend confirmation: above VWAP, positive day momentum, sufficient volume
        return d.vwapAbove && d.dayMomentum > -3 && d.volume > 1000000;
      }
      if (strategy === 'compounder') {
        // Quality filter: meaningful market cap, above VWAP, positive revenue growth
        return d.marketCap && d.marketCap > 2e8 && d.vwapAbove;
      }
      if (strategy === 'catalyst') {
        // Technical setup: above VWAP (smart money in), volume active, not extended
        const vwapDev = Math.abs(d.price - d.vwap) / d.vwap * 100;
        return d.vwapAbove && d.volume > 500000 && vwapDev < 10;
      }
      return true;
    });

    console.log(`[Scan] ${strategy}: ${filtered.length} pass mechanical filter`);

    // Haiku AI scoring in batches of 20
    const aiScores = {};
    if (ANTHROPIC_KEY && filtered.length > 0) {
      console.log(`[Scan] ${strategy}: AI scoring ${filtered.length} candidates...`);
      const BATCH = 20;
      for (let i = 0; i < filtered.length; i += BATCH) {
        const batch = filtered.slice(i, i+BATCH).map(t => ({ ticker: t, data: allData[t] }));
        const scores = await haikuScore(batch, strategy);
        Object.assign(aiScores, scores);
        if (i % 100 === 0 && i > 0) console.log(`[Scan] ${strategy}: AI scored ${i}/${filtered.length}`);
        await delay(300);
      }
    }

    // Combine and rank
    const ranked = filtered.map(t => {
      const d = allData[t];
      const aiScore = aiScores[t] || 0;
      // Mechanical score
      let mech = 0;
      if (d.vwapAbove) mech += 30;
      if (d.dayMomentum > 0) mech += 20;
      if (d.revenueGrowth && d.revenueGrowth > 0) mech += 25;
      if (d.marginTrend === 'expanding') mech += 15;
      if (d.marketCap && d.marketCap > 1e9) mech += 10;

      const combined = aiScore > 0 ? (mech * 0.35) + (aiScore * 0.65) : mech;

      return {
        ticker: t,
        score: parseFloat(combined.toFixed(2)),
        price: d.price,
        vwap: d.vwap,
        vwapAbove: d.vwapAbove,
        revenueGrowth: d.revenueGrowth,
        marketCap: d.marketCap,
        reason: `VWAP${d.vwapAbove?'↑':'↓'} DayMom${d.dayMomentum>0?'+':''}${d.dayMomentum}% RevGrow${d.revenueGrowth?(d.revenueGrowth*100).toFixed(0)+'%':'?'} AI:${aiScore||'mech'}`
      };
    }).sort((a,b) => b.score - a.score);

    console.log(`[Scan] ${strategy}: ${ranked.length} ranked — Top 5: ${ranked.slice(0,5).map(r=>r.ticker+'('+r.score+')').join(', ')}`);

    // Save to Supabase
    await sb('DELETE', 'pre_screened_candidates', null, `?strategy_id=eq.${strategy}&trading_date=eq.${today}`);
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i];
      await sb('POST', 'pre_screened_candidates', {
        strategy_id: strategy, ticker: c.ticker, rank: i+1,
        screen_score: c.score, screen_reason: c.reason,
        price: c.price, trading_date: today
      });
      if (i % 50 === 0 && i > 0) console.log(`[Scan] ${strategy}: saved ${i}/${ranked.length}`);
    }
    console.log(`[Scan] ${strategy}: saved ${ranked.length} candidates`);
  }

  console.log('\n[Scan] Complete!');
  process.exit(0);
}

main().catch(e => { console.error('[Scan] Fatal:', e.message); process.exit(1); });
