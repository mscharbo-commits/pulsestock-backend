// PulseStock Universe Scanner v3.0 — Minervini/CAN SLIM Foundation
// Run nightly: node scan.js
// Phase 1: Quick filter (VWAP, volume, price)
// Phase 2: Fetch 200-day candles for survivors
// Phase 3: Compute MAs, Trend Template, Bollinger Bands, relative strength
// Phase 4: Strategy-specific filters
// Phase 5: Haiku AI scoring with news + market context

const https = require('https');
const http = require('http');

const POLY_KEY = process.env.POLYGON_API_KEY || 'qpe_fbt2WsRl8D2YquOMzbzYlWcywazt';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const TICKER_URL = 'https://raw.githubusercontent.com/mscharbo-commits/pulsestock-study-data/main/ticker_universe.json';

function fetchJson(url, opts = {}) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 12000);
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

// ── TECHNICAL INDICATOR CALCULATIONS ──
function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
}

function bollingerBands(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const avg = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: avg + 2 * stdDev,
    middle: avg,
    lower: avg - 2 * stdDev,
    bandwidth: (4 * stdDev) / avg * 100 // % width — low = squeeze
  };
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

function computeAllIndicators(candles) {
  if (!candles || candles.length < 50) return null;
  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const volumes = candles.map(c => c.v);
  const current = closes[closes.length - 1];

  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma150 = sma(closes, 150);
  const ma200 = sma(closes, 200);
  const ema20 = ema(closes, 20);

  // 200-day MA trend: compare current 200MA to 60 days ago
  const ma200_60dAgo = candles.length >= 260 ? sma(closes.slice(0, -60), 200) : null;
  const ma200Rising = ma200 && ma200_60dAgo ? ma200 > ma200_60dAgo : null;

  // 52-week stats
  const year = Math.min(252, candles.length);
  const yearHighs = highs.slice(-year);
  const yearLows = lows.slice(-year);
  const w52High = Math.max(...yearHighs);
  const w52Low = Math.min(...yearLows);
  const rangePos = w52High > w52Low ? parseFloat(((current - w52Low) / (w52High - w52Low) * 100).toFixed(1)) : null;
  const pctFromHigh = w52High > 0 ? parseFloat(((current - w52High) / w52High * 100).toFixed(1)) : null;
  const pctAboveLow = w52Low > 0 ? parseFloat(((current - w52Low) / w52Low * 100).toFixed(1)) : null;

  // Volume analysis
  const avgVol30 = sma(volumes, 30);
  const todayVol = volumes[volumes.length - 1];
  const rvol = avgVol30 ? parseFloat((todayVol / avgVol30).toFixed(2)) : null;

  // Bollinger Bands
  const bb = bollingerBands(closes, 20);

  // RSI
  const rsiVal = rsi(closes, 14);

  // 6-month return (relative momentum)
  const sixMonthAgo = closes[Math.max(0, closes.length - 126)];
  const return6m = sixMonthAgo ? parseFloat(((current - sixMonthAgo) / sixMonthAgo * 100).toFixed(1)) : null;

  // 3-month return
  const threeMonthAgo = closes[Math.max(0, closes.length - 63)];
  const return3m = threeMonthAgo ? parseFloat(((current - threeMonthAgo) / threeMonthAgo * 100).toFixed(1)) : null;

  // VWAP (today's - use last candle vw if available)
  const todayVwap = candles[candles.length - 1].vw || null;
  const vwapAbove = todayVwap ? current > todayVwap : null;

  return {
    current, ma20, ma50, ma150, ma200, ema20,
    ma200Rising, w52High, w52Low, rangePos,
    pctFromHigh, pctAboveLow, rvol, bb, rsiVal,
    return6m, return3m, todayVwap, vwapAbove, avgVol30,
    // Dollar volume
    dollarVol: parseFloat((todayVol * current / 1e6).toFixed(1)) // in millions
  };
}

// ── MINERVINI TREND TEMPLATE ──
function trendTemplateScore(ind) {
  if (!ind || !ind.ma50 || !ind.ma150 || !ind.ma200) return { passes: false, score: 0, details: 'insufficient MA data' };
  
  const checks = {
    priceAboveMa50: ind.current > ind.ma50,
    priceAboveMa150: ind.current > ind.ma150,
    priceAboveMa200: ind.current > ind.ma200,
    ma50AboveMa150: ind.ma50 > ind.ma150,
    ma50AboveMa200: ind.ma50 > ind.ma200,
    ma150AboveMa200: ind.ma150 > ind.ma200,
    ma200Rising: ind.ma200Rising === true,
    within25OfHigh: ind.pctFromHigh !== null && ind.pctFromHigh >= -25,
    above30FromLow: ind.pctAboveLow !== null && ind.pctAboveLow >= 30,
    rsiAbove70: ind.rsiVal !== null && ind.rsiVal > 70
  };

  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  const passes = passed >= 8; // require 8 of 10

  return {
    passes,
    score: parseFloat((passed / total * 100).toFixed(1)),
    passed,
    total,
    details: Object.entries(checks).filter(([,v]) => !v).map(([k]) => k).join(', ')
  };
}

// ── MARKET CONTEXT ──
async function getMarketContext() {
  console.log('[Scan] Fetching market context...');
  const etfs = ['SPY', 'VIXY', 'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLP', 'XLU', 'XLB', 'XLY', 'XLRE', 'XLC'];
  const results = await Promise.all(etfs.map(t => poly(`/v2/aggs/ticker/${t}/prev`)));
  
  const getReturn = (d) => {
    const r = d?.results?.[0];
    return r && r.o ? parseFloat(((r.c - r.o) / r.o * 100).toFixed(2)) : null;
  };

  const spyRet = getReturn(results[0]);
  const vixLevel = results[1]?.results?.[0]?.c;
  const sectorNames = ['XLK(Tech)', 'XLF(Fin)', 'XLE(Energy)', 'XLV(Health)', 'XLI(Indust)', 'XLP(Staples)', 'XLU(Utils)', 'XLB(Matls)', 'XLY(Discret)', 'XLRE(RE)', 'XLC(Comm)'];
  const sectorReturns = results.slice(2).map((r, i) => ({ name: sectorNames[i], ret: getReturn(r) }))
    .filter(s => s.ret !== null).sort((a, b) => b.ret - a.ret);

  const regime = spyRet > 0.5 ? 'BULL' : spyRet < -0.5 ? 'BEAR' : 'NEUTRAL';
  const vixWarning = vixLevel > 20 ? `HIGH VIX ${vixLevel} — reduce sizing` : `VIX ${vixLevel} — normal`;
  const leading = sectorReturns.slice(0, 3).map(s => `${s.name}:${s.ret > 0 ? '+' : ''}${s.ret}%`).join(', ');
  const lagging = sectorReturns.slice(-3).map(s => `${s.name}:${s.ret}%`).join(', ');

  const ctx = { spyRet, regime, vixLevel, vixWarning, leading, lagging, sectorReturns,
    summary: `SPY${spyRet >= 0 ? '+' : ''}${spyRet}% (${regime}). ${vixWarning}. Leading: ${leading}. Lagging: ${lagging}.` };
  console.log(`[Market] ${ctx.summary}`);
  return ctx;
}

// ── NEWS ──
async function getNews(ticker) {
  await delay(80);
  const weekAgo = new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
  const d = await poly(`/v2/reference/news?ticker=${ticker}&published_utc.gte=${weekAgo}&limit=5&sort=published_utc&order=desc`);
  const articles = d?.results || [];
  return articles.length ? articles.map(a => a.title).slice(0, 4).join(' | ') : null;
}

// ── FINANCIALS ──
async function getFinancials(ticker) {
  await delay(80);
  const d = await poly(`/vX/reference/financials?ticker=${ticker}&limit=4&timeframe=quarterly`);
  const results = d?.results || [];
  if (results.length < 2) return null;
  const q0 = results[0]?.financials?.income_statement;
  const q1 = results[1]?.financials?.income_statement;
  if (!q0 || !q1) return null;
  const rev0 = q0.revenues?.value;
  const rev1 = q1.revenues?.value;
  const ni0 = q0.net_income_loss?.value;
  const ni1 = q1.net_income_loss?.value;
  return {
    revenueGrowth: rev0 && rev1 && rev1 > 0 ? parseFloat(((rev0 - rev1) / rev1 * 100).toFixed(1)) : null,
    earningsGrowth: ni0 && ni1 && ni1 > 0 ? parseFloat(((ni0 - ni1) / ni1 * 100).toFixed(1)) : null,
    marginTrend: ni0 && ni1 ? (ni0 > ni1 ? 'expanding' : 'contracting') : null
  };
}

// ── HAIKU SCORER ──
async function haikuScore(batch, strategy, marketContext) {
  if (!ANTHROPIC_KEY || !batch.length) return {};

  const stratRules = {
    momentum: `MOMENTUM GROWTH — Minervini/CAN SLIM methodology. Score HIGHEST for:
- Full Trend Template compliance (all MAs aligned, above 50/150/200 MAs, 200MA rising)
- Price within 15% of 52-week high (fresh strength, not extended recovery)
- 6-month return top quartile (relative momentum leader)
- EPS growth >20% and revenue growth >15% (fundamental catalyst)
- RVOL >1.5 on up days (institutional buying)
- Industry/sector leadership (in leading sector per market context)
Score NEAR ZERO for: downtrends, broken MA structure, China ADRs, negative earnings, lagging sectors.`,

    compounder: `QUALITY COMPOUNDER — Buffett/Munger methodology. Score HIGHEST for:
- Durable competitive moat (network effects, switching costs, brand, patents, cost advantage)
- FCF positive and growing consistently
- ROE >15%, margins expanding or stable
- Low debt (D/E < 1.0 preferred)
- Revenue growth >10% consistently
- Reasonable valuation vs growth rate
- Trading near VWAP (not overbought entry)
Score NEAR ZERO for: commoditized businesses, shrinking margins, high debt, no moat.`,

    catalyst: `CATALYST SWING — Smart money technical setup. Score HIGHEST for:
- Price above VWAP (institutional net buyers — PRIMARY gate)
- RSI 40-65 (room to move, not exhausted)
- Bollinger Band squeeze (low bandwidth = compression before move)
- RVOL spike (unusual institutional activity)
- Price near 52-week high but consolidating (not extended)
- Near-term dated catalyst within 10 days (earnings, FDA, launch, split)
Score NEAR ZERO for: utilities, REITs, CEFs, below VWAP, RSI >75 (exhausted), downtrends.`
  };

  const tickerLines = batch.map(t => {
    const d = t.data; const ind = d.indicators;
    const tt = d.trendTemplate;
    return `${t.ticker}: TrendTemplate=${tt?.score||'?'}%(${tt?.passed||0}/10) MA50${ind?.ma50?'$'+ind.ma50.toFixed(0):'?'} MA200${ind?.ma200?'$'+ind.ma200.toFixed(0):'?'} RSI=${ind?.rsiVal||'?'} RVOL=${ind?.rvol||'?'} 52WHigh=${ind?.pctFromHigh||'?'}% 6mRet=${ind?.return6m||'?'}% BB=${ind?.bb?.bandwidth?.toFixed(1)||'?'}% RevGrow=${d.fin?.revenueGrowth||'?'}% EPSGrow=${d.fin?.earningsGrowth||'?'}% News=${t.news?'"'+t.news.substring(0,100)+'"':'none'}`;
  }).join('\n');

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: `${stratRules[strategy]}\n\nMarket context: ${marketContext.summary}\n\nAssign unique scores 0-100. No two tickers same score. Differentiate precisely. JSON only.`,
    messages: [{ role: 'user', content: `Score these tickers for ${strategy}. Every score must be UNIQUE:\n${tickerLines}\n\nReturn JSON: {"TICK1":87,"TICK2":74,...} — NO duplicates.` }]
  });

  const result = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body
  });

  const text = result?.content?.find(b => b.type === 'text')?.text || '';
  try {
    const start = text.indexOf('{'); const end = text.lastIndexOf('}');
    return JSON.parse(text.substring(start, end + 1));
  } catch(e) { return {}; }
}

// ── MAIN ──
async function main() {
  console.log('[Scan] PulseStock Universe Scanner v3.0 — Minervini/CAN SLIM Foundation');
  const universe = await fetchJson(TICKER_URL);
  const tickers = universe?.all || [];
  console.log(`[Scan] ${tickers.length} tickers`);

  const marketContext = await getMarketContext();
  const today = new Date().toISOString().split('T')[0];
  const yearAgo = new Date(Date.now() - 380*86400000).toISOString().split('T')[0]; // 380 days for 200 MA buffer

  // ── PHASE 1: Quick filter — just prev day data ──
  console.log('\n[Phase 1] Quick filter: price, volume, VWAP...');
  const phase1 = {};
  let p1done = 0;

  for (const ticker of tickers) {
    p1done++;
    const prev = await poly(`/v2/aggs/ticker/${ticker}/prev`);
    const r = prev?.results?.[0];
    if (!r || !r.c || !r.vw) continue;

    const dollarVol = (r.v * r.c) / 1e6; // millions
    if (dollarVol < 5) continue;  // minimum $5M daily dollar volume
    if (r.c < 2) continue;        // no sub-$2 stocks
    if (!r.h || !r.l) continue;
    const dayRange = (r.h - r.l) / r.l * 100;
    if (dayRange < 0.3 || dayRange > 20) continue; // filter frozen or halted

    phase1[ticker] = { price: r.c, vwap: r.vw, volume: r.v, dollarVol, open: r.o };
    if (p1done % 200 === 0) console.log(`[Phase 1] ${p1done}/${tickers.length} — ${Object.keys(phase1).length} pass`);
  }
  console.log(`[Phase 1] Complete: ${Object.keys(phase1).length} pass quick filter`);

  // ── PHASE 2: Fetch candle history + compute all indicators ──
  console.log('\n[Phase 2] Fetching 200-day candles + computing indicators...');
  const phase2 = {};
  let p2done = 0;
  const p1tickers = Object.keys(phase1);

  for (const ticker of p1tickers) {
    p2done++;
    const candles = await poly(`/v2/aggs/ticker/${ticker}/range/1/day/${yearAgo}/${today}?adjusted=true&sort=asc&limit=400`);
    const bars = candles?.results || [];

    if (bars.length < 60) continue; // need at least 60 days

    const ind = computeAllIndicators(bars);
    if (!ind) continue;

    // Fetch financials (for established companies)
    const fin = phase1[ticker].dollarVol > 10 ? await getFinancials(ticker) : null;

    // Compute trend template score
    const trendTemplate = trendTemplateScore(ind);

    phase2[ticker] = {
      ...phase1[ticker],
      indicators: ind,
      trendTemplate,
      fin,
      news: null // fetch in phase 3 only for finalists
    };

    if (p2done % 50 === 0) console.log(`[Phase 2] ${p2done}/${p1tickers.length} — ${Object.keys(phase2).length} with indicators`);
  }
  console.log(`[Phase 2] Complete: ${Object.keys(phase2).length} with full indicator data`);

  // ── PHASE 3 & 4: Strategy-specific filters + AI scoring ──
  const strategies = ['momentum', 'compounder', 'catalyst'];

  for (const strategy of strategies) {
    console.log(`\n[${strategy.toUpperCase()}] Applying strategy filters...`);

    // Strategy-specific hard gates — SAME criteria Sonnet uses to decline
    const filtered = Object.keys(phase2).filter(t => {
      const d = phase2[t];
      const ind = d.indicators;
      const tt = d.trendTemplate;
      if (!ind) return false;

      if (strategy === 'momentum') {
        // Minervini Trend Template — must pass at least 7 of 10 checks
        if (!tt || tt.passed < 7) return false;
        // Price within 25% of 52-week high
        if (ind.pctFromHigh === null || ind.pctFromHigh < -25) return false;
        // RSI must show strength
        if (ind.rsiVal === null || ind.rsiVal < 50) return false;
        // Dollar volume minimum $20M for liquidity
        if (d.dollarVol < 20) return false;
        return true;
      }

      if (strategy === 'compounder') {
        // Must be above key MAs for entry timing
        if (!ind.ma50 || !ind.ma200 || ind.current < ind.ma200) return false;
        // Not overbought
        if (ind.rsiVal && ind.rsiVal > 78) return false;
        // Meaningful size
        if (d.dollarVol < 10) return false;
        return true;
      }

      if (strategy === 'catalyst') {
        // VWAP is the hard gate — smart money must be in
        if (!ind.vwapAbove) return false;
        // RSI must have room to move
        if (ind.rsiVal === null || ind.rsiVal < 35 || ind.rsiVal > 72) return false;
        // Not near 52W lows (broken structure)
        if (ind.rangePos !== null && ind.rangePos < 30) return false;
        // Minimum liquidity
        if (d.dollarVol < 5) return false;
        return true;
      }

      return false;
    });

    console.log(`[${strategy.toUpperCase()}] ${filtered.length} pass hard gates`);

    // Fetch news only for finalists
    console.log(`[${strategy.toUpperCase()}] Fetching news for ${filtered.length} candidates...`);
    for (const ticker of filtered) {
      phase2[ticker].news = await getNews(ticker);
    }

    // Haiku AI scoring in batches of 12
    const aiScores = {};
    if (ANTHROPIC_KEY && filtered.length > 0) {
      const BATCH = 12;
      for (let i = 0; i < filtered.length; i += BATCH) {
        const batch = filtered.slice(i, i + BATCH).map(t => ({
          ticker: t, data: phase2[t], news: phase2[t].news
        }));
        const scores = await haikuScore(batch, strategy, marketContext);
        Object.assign(aiScores, scores);
        if (i % 60 === 0 && i > 0) console.log(`[${strategy.toUpperCase()}] AI scored ${i}/${filtered.length}`);
        await delay(300);
      }
    }

    // Rank: 70% AI score + 30% mechanical (trend template score)
    const ranked = filtered.map(t => {
      const d = phase2[t];
      const ind = d.indicators;
      const tt = d.trendTemplate;
      const aiScore = aiScores[t] || 0;
      const mechScore = tt?.score || 0;
      const combined = aiScore > 0 ? (aiScore * 0.70) + (mechScore * 0.30) : mechScore;

      return {
        ticker: t,
        score: parseFloat(combined.toFixed(2)),
        price: d.price,
        trendTemplateScore: tt?.score,
        trendTemplatePassed: tt?.passed,
        rsi: ind?.rsiVal,
        return6m: ind?.return6m,
        rvol: ind?.rvol,
        bbWidth: ind?.bb?.bandwidth?.toFixed(1),
        pctFromHigh: ind?.pctFromHigh,
        revenueGrowth: d.fin?.revenueGrowth,
        earningsGrowth: d.fin?.earningsGrowth,
        hasNews: !!d.news,
        reason: `TT:${tt?.passed||0}/10(${tt?.score||0}%) RSI:${ind?.rsiVal||'?'} 6m:${ind?.return6m||'?'}% RVOL:${ind?.rvol||'?'} Hi:${ind?.pctFromHigh||'?'}% Rev:${d.fin?.revenueGrowth||'?'}% AI:${aiScore||'mech'}`
      };
    }).sort((a, b) => b.score - a.score);

    // Apply minimum score cutoff matching strategy confidence gates
    const MIN_SCORES = { momentum: 75, compounder: 78, catalyst: 78 };
    const MIN_SCORE = MIN_SCORES[strategy] || 75;
    const qualified = ranked.filter(r => r.score >= MIN_SCORE);
    const toSave = qualified.length >= 5 ? qualified : ranked.slice(0, 15);
    console.log(`[${strategy.toUpperCase()}] ${ranked.length} scored, ${toSave.length} above ${MIN_SCORE} threshold`);

    console.log(`[${strategy.toUpperCase()}] ${ranked.length} ranked, ${toSave.length} qualify (score >= ${MIN_SCORE})`);
    // Re-rank top candidates together to break score ties
    if (ANTHROPIC_KEY && toSave.length > 1) {
      const top20 = toSave.slice(0, 20);
      const reRankBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: 'You are ranking pre-screened stocks. Give each a UNIQUE score 0-100. No ties allowed. Respond JSON only.',
        messages: [{ role: 'user', content: `Re-rank these ${strategy} candidates with unique scores. Every score must differ by at least 1 point:
${top20.map(r => r.ticker+':'+r.score).join(',')}
Return JSON: {"TICK1":95,"TICK2":91,...} — ALL unique.` }]
      });
      const reRankResult = await fetchJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: reRankBody
      });
      const reRankText = reRankResult?.content?.find(b => b.type === 'text')?.text || '';
      try {
        const start = reRankText.indexOf('{'); const end = reRankText.lastIndexOf('}');
        const newScores = JSON.parse(reRankText.substring(start, end+1));
        top20.forEach(r => { if (newScores[r.ticker]) r.score = parseFloat(newScores[r.ticker].toFixed(2)); });
        top20.sort((a, b) => b.score - a.score);
        // Update toSave with re-ranked top 20
        toSave.splice(0, top20.length, ...top20);
      } catch(e) {}
    }
    console.log(`[${strategy.toUpperCase()}] Top 5: ${toSave.slice(0, 5).map(r => r.ticker + '(' + r.score + ')').join(', ')}`);

    // Save to Supabase
    await sb('DELETE', 'pre_screened_candidates', null, `?strategy_id=eq.${strategy}&trading_date=eq.${today}`);
    for (let i = 0; i < toSave.length; i++) {
      const c = toSave[i];
      await sb('POST', 'pre_screened_candidates', {
        strategy_id: strategy, ticker: c.ticker, rank: i + 1,
        screen_score: c.score, screen_reason: c.reason,
        price: c.price, range_position: c.pctFromHigh,
        rsi: c.rsi, trading_date: today
      });
    }
    console.log(`[${strategy.toUpperCase()}] Saved ${toSave.length} candidates to Supabase`);
  }

  console.log('\n[Scan] Complete!');
  process.exit(0);
}

main().catch(e => { console.error('[Scan] Fatal:', e.message); process.exit(1); });
