// PulseStock Universe Scanner — run nightly on Mac: node scan.js
// Full scoring: Yahoo Finance (float/short/fundamentals) + Finnhub (technicals) + Haiku (AI ranking)

const https = require('https');
const http = require('http');

const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FHK = 'd8fhh6hr01qn443a0bngd8fhh6hr01qn443a0bo0';
const TICKER_URL = 'https://raw.githubusercontent.com/mscharbo-commits/pulsestock-study-data/main/ticker_universe.json';

// ── HTTP HELPER ──
function fetchJson(url, opts = {}) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 10000);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      method: opts.method || 'GET',
      headers: opts.headers || { 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        clearTimeout(timeout);
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(null); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SUPABASE ──
async function sb(method, table, data, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  return fetchJson(url, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      'User-Agent': 'Mozilla/5.0'
    },
    body: data ? JSON.stringify(data) : undefined
  });
}

// ── FINNHUB ──
async function getFinnhubMetrics(ticker) {
  await delay(250);
  const d = await fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FHK}`);
  return d && d.metric ? d.metric : null;
}

async function getFinnhubQuote(ticker) {
  await delay(250);
  const d = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FHK}`);
  return d && d.c > 0 ? d : null;
}

// ── YAHOO FINANCE ──
async function getYahooData(ticker) {
  await delay(200);
  // Yahoo Finance quoteSummary with key modules
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics,financialData,summaryDetail`;
  const d = await fetchJson(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com'
    }
  });
  if (!d || !d.quoteSummary || !d.quoteSummary.result) return null;
  const result = d.quoteSummary.result[0];
  const stats = result.defaultKeyStatistics || {};
  const financial = result.financialData || {};
  const detail = result.summaryDetail || {};
  return {
    floatShares: stats.floatShares?.raw || null,
    shortPercent: stats.shortPercentOfFloat?.raw || null,
    shortRatio: stats.shortRatio?.raw || null,
    beta: stats.beta?.raw || null,
    revenueGrowth: financial.revenueGrowth?.raw || null,
    grossMargins: financial.grossMargins?.raw || null,
    operatingMargins: financial.operatingMargins?.raw || null,
    debtToEquity: financial.debtToEquity?.raw || null,
    currentRatio: financial.currentRatio?.raw || null,
    returnOnEquity: financial.returnOnEquity?.raw || null,
    freeCashflow: financial.freeCashflow?.raw || null,
    forwardPE: detail.forwardPE?.raw || null,
    dividendYield: detail.dividendYield?.raw || null,
    avgVolume: detail.averageVolume?.raw || null,
    marketCap: detail.marketCap?.raw || null
  };
}

// ── HAIKU AI BATCH SCORER ──
async function haikuscore(tickers, strategy, techData) {
  if (!ANTHROPIC_KEY) {
    console.log('[Haiku] No API key — skipping AI scoring, using mechanical scores only');
    return {};
  }

  const strategyContext = {
    momentum: 'You are scoring stocks for a MOMENTUM GROWTH strategy (10-60 day hold). Prioritize: (1) Price structure — confirmed uptrend with higher highs/higher lows, (2) Relative strength vs sector and market, (3) VWAP positioning — price above VWAP shows institutional buying, (4) Strong recent earnings momentum — 2+ consecutive quarters of growth, (5) Sector/regime alignment with Bull Low Vol market. Penalize: downtrends, broken structure, China ADRs, negative EPS revisions, high debt.',
    compounder: 'You are scoring stocks for a QUALITY COMPOUNDER strategy (long-term hold). Prioritize: (1) Durable competitive moat — network effects, switching costs, brand, patents, (2) Free cash flow positive and growing, (3) ROIC above WACC, (4) Expanding margins, (5) Management quality and capital allocation track record. Penalize: high debt, shrinking margins, commoditized businesses, poor FCF.',
    catalyst: 'You are scoring stocks for a CATALYST SWING strategy (3-10 day hold). Prioritize: (1) VWAP positioning — price above VWAP signals smart money in position, (2) RSI 40-70 with building momentum not exhausted, (3) Fresh relative strength breakout vs sector, (4) Price structure intact, (5) Any near-term catalyst (earnings, FDA, launch, split, analyst day) as a bonus. Penalize: downtrends, extended moves already up 20%+, illiquid names.'
  };

  const tickerList = tickers.map(t => {
    const d = techData[t] || {};
    return `${t}: Range${d.rangePos?.toFixed(0)||'?'}% RSI${d.rsi?.toFixed(0)||'?'} VWAP${d.vwapAbove?'↑':'↓'} RevGrowth${d.revenueGrowth?(d.revenueGrowth*100).toFixed(0)+'%':'?'} Margins${d.grossMargins?(d.grossMargins*100).toFixed(0)+'%':'?'} Short${d.shortPercent?(d.shortPercent*100).toFixed(1)+'%':'?'} Float${d.floatShares?Math.round(d.floatShares/1e6)+'M':'?'}`;
  }).join('\n');

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: strategyContext[strategy] + ' Respond ONLY with a JSON object mapping ticker to score 0-100. No explanation.',
    messages: [{
      role: 'user',
      content: `Score each ticker 0-100 for ${strategy} strategy fit. Higher = better candidate for deep dive.\n${tickerList}\n\nReturn JSON only: {"TICK1": 85, "TICK2": 42, ...}`
    }]
  });

  const result = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    },
    body
  });

  if (!result || !result.content) return {};
  const text = result.content.find(b => b.type === 'text')?.text || '';
  try {
    const clean = text.replace(/```json\n?/g,'').replace(/```/g,'').trim();
    return JSON.parse(clean);
  } catch(e) { return {}; }
}

// ── MAIN SCAN ──
async function main() {
  console.log('[Scan] Starting full universe scan...');
  console.log('[Scan] Data sources: Finnhub (technicals) + Yahoo Finance (fundamentals/float/short) + Haiku (AI scoring)');

  const universe = await fetchJson(TICKER_URL);
  const tickers = universe?.all || [];
  console.log(`[Scan] ${tickers.length} tickers to scan`);

  const today = new Date().toISOString().split('T')[0];
  const strategies = ['momentum', 'compounder', 'catalyst'];

  // Collect all data in one pass — fetch quote+metrics+yahoo for each ticker once
  console.log('\n[Scan] Phase 1: Collecting data for all tickers...');
  const allData = {};
  let processed = 0;
  let skipped = 0;

  for (const ticker of tickers) {
    processed++;

    // Get Finnhub quote
    const quote = await getFinnhubQuote(ticker);
    if (!quote || !quote.c || quote.c <= 0) { skipped++; continue; }

    // Get Finnhub metrics
    const metric = await getFinnhubMetrics(ticker);
    if (!metric) { skipped++; continue; }

    const w52h = metric['52WeekHigh'] ? parseFloat(metric['52WeekHigh']) : null;
    const w52l = metric['52WeekLow'] ? parseFloat(metric['52WeekLow']) : null;
    const rsi = metric['rsi14d'] ? parseFloat(metric['rsi14d']) : null;

    // Quality filter — must have meaningful data
    if (!w52h || !w52l || !rsi || w52h <= w52l) { skipped++; continue; }
    if ((w52h - w52l) / w52l < 0.05) { skipped++; continue; } // filter frozen stocks

    const rangePos = ((quote.c - w52l) / (w52h - w52l)) * 100;
    const vwapAbove = quote.c > (quote.pc || quote.c);

    // Get Yahoo Finance data (float, short interest, fundamentals)
    const yahoo = await getYahooData(ticker);

    allData[ticker] = {
      price: quote.c,
      dayHigh: quote.h,
      dayLow: quote.l,
      prevClose: quote.pc,
      rangePos: parseFloat(rangePos.toFixed(1)),
      rsi: parseFloat(rsi.toFixed(1)),
      beta: metric['beta'] ? parseFloat(metric['beta']) : null,
      vwapAbove,
      w52h, w52l,
      // EPS/Revenue from Finnhub metrics
      epsGrowthTTM: metric['epsGrowthTTMYoy'] || null,
      revenueGrowthTTM: metric['revenueGrowthTTMYoy'] || null,
      peRatioTTM: metric['peTTM'] || null,
      // From Yahoo
      floatShares: yahoo?.floatShares || null,
      shortPercent: yahoo?.shortPercent || null,
      shortRatio: yahoo?.shortRatio || null,
      revenueGrowth: yahoo?.revenueGrowth || null,
      grossMargins: yahoo?.grossMargins || null,
      operatingMargins: yahoo?.operatingMargins || null,
      debtToEquity: yahoo?.debtToEquity || null,
      returnOnEquity: yahoo?.returnOnEquity || null,
      freeCashflow: yahoo?.freeCashflow || null,
      forwardPE: yahoo?.forwardPE || null,
      avgVolume: yahoo?.avgVolume || null,
      marketCap: yahoo?.marketCap || null
    };

    if (processed % 100 === 0) {
      console.log(`[Scan] Phase 1: ${processed}/${tickers.length} processed, ${Object.keys(allData).length} with valid data`);
    }
  }

  console.log(`\n[Scan] Phase 1 complete: ${Object.keys(allData).length} tickers with valid data (${skipped} skipped)`);

  // Phase 2: Mechanical pre-filter per strategy
  console.log('\n[Scan] Phase 2: Mechanical filtering per strategy...');

  for (const strategy of strategies) {
    const validTickers = Object.keys(allData).filter(t => {
      const d = allData[t];
      if (strategy === 'momentum') {
        return d.rangePos >= 45 && d.rsi >= 40 && d.rsi <= 80 && d.vwapAbove;
      } else if (strategy === 'compounder') {
        return d.rangePos >= 30 && d.rsi <= 78;
      } else { // catalyst
        return d.vwapAbove && d.rangePos >= 25 && d.rangePos <= 93 && d.rsi >= 35 && d.rsi <= 73;
      }
    });

    console.log(`[Scan] ${strategy}: ${validTickers.length} pass mechanical filter`);

    // Phase 3: Haiku AI scoring in batches of 25
    console.log(`[Scan] Phase 3: Haiku AI scoring ${validTickers.length} ${strategy} candidates...`);
    const aiScores = {};
    const BATCH = 25;

    for (let i = 0; i < validTickers.length; i += BATCH) {
      const batch = validTickers.slice(i, i + BATCH);
      const techData = {};
      batch.forEach(t => { techData[t] = allData[t]; });
      const scores = await haikuscore(batch, strategy, techData);
      Object.assign(aiScores, scores);
      if (i % 100 === 0) console.log(`[Scan] ${strategy} AI scoring: ${i}/${validTickers.length}`);
      await delay(500); // brief pause between Haiku batches
    }

    // Phase 4: Combine mechanical + AI scores, rank
    const scored = validTickers.map(t => {
      const d = allData[t];
      const aiScore = aiScores[t] || 0;

      // Mechanical score (0-100)
      let mechScore = 0;
      mechScore += Math.min(d.rangePos, 100) * 0.3;
      if (d.rsi >= 50 && d.rsi <= 72) mechScore += 20;
      if (d.vwapAbove) mechScore += 15;
      if (d.beta && d.beta > 0.5 && d.beta < 2.5) mechScore += 10;
      if (d.shortPercent && d.shortPercent > 0.05) mechScore += 5; // high short = squeeze potential

      // Combined score: 40% mechanical, 60% AI (when available)
      const combined = aiScore > 0
        ? (mechScore * 0.4) + (aiScore * 0.6)
        : mechScore;

      return {
        ticker: t,
        score: parseFloat(combined.toFixed(2)),
        mechScore: parseFloat(mechScore.toFixed(2)),
        aiScore: aiScore || null,
        price: d.price,
        rangePos: d.rangePos,
        rsi: d.rsi,
        vwapAbove: d.vwapAbove,
        shortPercent: d.shortPercent,
        floatShares: d.floatShares,
        revenueGrowth: d.revenueGrowth || d.revenueGrowthTTM,
        grossMargins: d.grossMargins,
        reason: `Mech:${mechScore.toFixed(0)} AI:${aiScore||'?'} Range:${d.rangePos}% RSI:${d.rsi} VWAP:${d.vwapAbove?'↑':'↓'} Short:${d.shortPercent?(d.shortPercent*100).toFixed(1)+'%':'?'}`
      };
    }).sort((a, b) => b.score - a.score);

    console.log(`[Scan] ${strategy}: ${scored.length} ranked candidates (top 3: ${scored.slice(0,3).map(s=>s.ticker+'='+s.score).join(', ')})`);

    // Save all ranked candidates to Supabase
    await sb('DELETE', 'pre_screened_candidates', null, `?strategy_id=eq.${strategy}&trading_date=eq.${today}`);

    for (let i = 0; i < scored.length; i++) {
      const c = scored[i];
      await sb('POST', 'pre_screened_candidates', {
        strategy_id: strategy,
        ticker: c.ticker,
        rank: i + 1,
        screen_score: c.score,
        screen_reason: c.reason,
        price: c.price,
        range_position: c.rangePos,
        rsi: c.rsi,
        trading_date: today
      });
    }
    console.log(`[Scan] ${strategy}: saved ${scored.length} ranked candidates to Supabase`);
  }

  console.log('\n[Scan] Complete! All strategies ranked and saved to Supabase.');
  process.exit(0);
}

main().catch(e => {
  console.error('[Scan] Fatal error:', e.message);
  process.exit(1);
});
