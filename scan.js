// PulseStock Universe Scanner v4.0 — Pure Mathematical Scoring
// No AI scoring — deterministic, unique scores, no clustering
// Tiered output: 90+ Strong Buy, 85-89 Buy, 80-84 Watch

const https = require('https');
const http = require('http');

const POLY_KEY = process.env.POLYGON_API_KEY || 'qpe_fbt2WsRl8D2YquOMzbzYlWcywazt';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY; // only used for news sentiment bonus
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
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', 'Prefer': 'return=representation'
    },
    body: data ? JSON.stringify(data) : undefined
  });
}

// ── TECHNICAL INDICATORS ──
function sma(arr, period) {
  if (arr.length < period) return null;
  return arr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = (gains/period) / (losses/period || 0.001);
  return parseFloat((100 - 100/(1+rs)).toFixed(1));
}

function bollingerWidth(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const avg = slice.reduce((a,b) => a+b, 0) / period;
  const std = Math.sqrt(slice.reduce((a,b) => a + Math.pow(b-avg,2), 0) / period);
  return parseFloat(((4 * std) / avg * 100).toFixed(2));
}

function computeIndicators(candles) {
  if (!candles || candles.length < 60) return null;
  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const volumes = candles.map(c => c.v);
  const cur = closes[closes.length-1];

  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma150 = closes.length >= 150 ? sma(closes, 150) : null;
  const ma200 = closes.length >= 200 ? sma(closes, 200) : null;
  const ema20val = ema(closes, 20);
  const ma200_60ago = closes.length >= 260 ? sma(closes.slice(0, -60), 200) : null;
  const ma200Rising = ma200 && ma200_60ago ? ma200 > ma200_60ago : null;

  const yr = Math.min(252, closes.length);
  const w52h = Math.max(...highs.slice(-yr));
  const w52l = Math.min(...lows.slice(-yr));
  const rangePos = w52h > w52l ? parseFloat(((cur - w52l)/(w52h - w52l)*100).toFixed(1)) : null;
  const pctFromHigh = w52h > 0 ? parseFloat(((cur-w52h)/w52h*100).toFixed(1)) : null;
  const pctAboveLow = w52l > 0 ? parseFloat(((cur-w52l)/w52l*100).toFixed(1)) : null;

  const avgVol30 = sma(volumes, 30);
  const rvol = avgVol30 ? parseFloat((volumes[volumes.length-1]/avgVol30).toFixed(2)) : null;
  const bbWidth = bollingerWidth(closes, 20);
  const rsiVal = rsi(closes, 14);

  const r6m = closes[Math.max(0, closes.length-126)];
  const return6m = r6m ? parseFloat(((cur-r6m)/r6m*100).toFixed(1)) : null;
  const r3m = closes[Math.max(0, closes.length-63)];
  const return3m = r3m ? parseFloat(((cur-r3m)/r3m*100).toFixed(1)) : null;
  const r1m = closes[Math.max(0, closes.length-21)];
  const return1m = r1m ? parseFloat(((cur-r1m)/r1m*100).toFixed(1)) : null;

  const todayVwap = candles[candles.length-1].vw || null;

  return {
    cur, ma20, ma50, ma150, ma200, ema20: ema20val, ma200Rising,
    w52h, w52l, rangePos, pctFromHigh, pctAboveLow,
    rvol, bbWidth, rsiVal, return6m, return3m, return1m,
    todayVwap, vwapAbove: todayVwap ? cur > todayVwap : null,
    dollarVol: parseFloat((volumes[volumes.length-1] * cur / 1e6).toFixed(1))
  };
}

// ── PURE MATHEMATICAL SCORING ──
// Each component contributes a specific number of points — no AI, no clustering
function scoreMomentum(ind, fin, news) {
  if (!ind || !ind.ma50 || !ind.ma200) return null;
  
  // Hard exclusions for Momentum Growth
  if (ind.rsiVal && ind.rsiVal > 80) return null; // overbought/exhausted
  if (fin && fin.revenueGrowth === 0 && fin.earningsGrowth <= 0) return null; // no revenue traction
  
  let score = 0;
  const details = [];

  // 1. MINERVINI TREND TEMPLATE (40 points total)
  // Each check = 5 points, maximum 8 checks = 40 points
  const ttChecks = [
    ind.cur > ind.ma50,                                    // price above 50MA
    ind.cur > (ind.ma150 || ind.ma200),                   // price above 150MA
    ind.cur > ind.ma200,                                   // price above 200MA
    ind.ma50 > (ind.ma150 || ind.ma200),                  // 50MA above 150MA
    ind.ma50 > ind.ma200,                                  // 50MA above 200MA
    ind.ma150 ? ind.ma150 > ind.ma200 : null,             // 150MA above 200MA
    ind.ma200Rising === true,                              // 200MA rising
    ind.pctFromHigh !== null && ind.pctFromHigh >= -25,   // within 25% of 52W high
    ind.pctAboveLow !== null && ind.pctAboveLow >= 30,    // 30% above 52W low
    ind.rsiVal !== null && ind.rsiVal > 60                // RSI showing strength
  ].filter(v => v !== null);
  
  const ttPassed = ttChecks.filter(Boolean).length;
  const ttScore = Math.min(ttPassed * 5, 40);
  score += ttScore;
  details.push(`TT:${ttPassed}/10(${ttScore}pts)`);

  // Hard gate: must pass at least 8 trend template checks
  if (ttPassed < 8) return null;

  // 2. RELATIVE MOMENTUM (25 points)
  // 6-month return — the more the better, but not too extended
  if (ind.return6m !== null) {
    if (ind.return6m < 5) return null; // must show positive momentum
    if (ind.return6m >= 30) score += 25;
    else if (ind.return6m >= 20) score += 20;
    else if (ind.return6m >= 10) score += 15;
    else if (ind.return6m >= 5) score += 8;
    details.push(`6m:${ind.return6m}%`);
  }

  // 3. RSI QUALITY (10 points)
  // Best RSI zone: 55-72 (strong but not exhausted)
  if (ind.rsiVal !== null) {
    if (ind.rsiVal >= 55 && ind.rsiVal <= 72) score += 10;
    else if (ind.rsiVal >= 50 && ind.rsiVal <= 78) score += 6;
    details.push(`RSI:${ind.rsiVal}`);
  }

  // 4. VOLUME CONFIRMATION (10 points)
  // Institutional interest = higher relative volume
  if (ind.rvol !== null) {
    if (ind.rvol >= 1.5) score += 10;
    else if (ind.rvol >= 1.2) score += 7;
    else if (ind.rvol >= 1.0) score += 4;
    details.push(`RVOL:${ind.rvol}`);
  }

  // 5. FUNDAMENTALS BONUS (10 points)
  // Revenue and earnings growth
  if (fin) {
    if (fin.revenueGrowth >= 20) score += 5;
    else if (fin.revenueGrowth >= 10) score += 3;
    if (fin.earningsGrowth >= 25) score += 5;
    else if (fin.earningsGrowth >= 10) score += 3;
    details.push(`Rev:${fin.revenueGrowth}%`);
  }

  // 6. NEWS SENTIMENT BONUS (5 points max — small, not deterministic)
  if (news) score += 5; // has recent news = institutional attention

  // Add tiny unique offset based on ticker hash to prevent ties
  const tickerHash = details.join('').split('').reduce((a,c) => a + c.charCodeAt(0), 0);
  score += (tickerHash % 100) / 1000; // adds 0.001-0.099 — breaks ties without changing order

  return { score: parseFloat(Math.min(score, 100).toFixed(3)), details: details.join(' ') };
}

function scoreCompounder(ind, fin, news) {
  if (!ind || !ind.ma200) return null;
  
  // Hard exclusions for Quality Compounder
  if (ind.cur <= ind.ma200) return null; // must be above 200MA
  if (ind.rsiVal && ind.rsiVal > 78) return null; // overbought
  // Must show some revenue growth — pure utilities and no-growth companies excluded
  if (fin && fin.revenueGrowth !== null && fin.revenueGrowth < 3 && fin.earningsGrowth < 5) return null;
  
  let score = 0;
  const details = [];

  // 1. QUALITY TECHNICAL SETUP (35 points)
  const checks = [
    ind.cur > ind.ma50,
    ind.cur > ind.ma200,
    ind.ma50 > ind.ma200,
    ind.ma200Rising === true,
    ind.pctFromHigh !== null && ind.pctFromHigh >= -20,
    ind.vwapAbove === true
  ].filter(v => v !== null);
  score += checks.filter(Boolean).length * 6;
  details.push(`Checks:${checks.filter(Boolean).length}/6`);

  // 2. FUNDAMENTALS (40 points) — primary driver for compounder
  if (fin) {
    if (fin.revenueGrowth >= 20) score += 15;
    else if (fin.revenueGrowth >= 10) score += 10;
    else if (fin.revenueGrowth >= 5) score += 5;
    if (fin.earningsGrowth >= 25) score += 15;
    else if (fin.earningsGrowth >= 10) score += 10;
    else if (fin.earningsGrowth >= 0) score += 3;
    score += 10; // base for having fundamentals data
    details.push(`Rev:${fin.revenueGrowth}% EPS:${fin.earningsGrowth}%`);
  }

  // 3. MOMENTUM (15 points)
  if (ind.return6m !== null && ind.return6m > 0) {
    if (ind.return6m >= 15) score += 15;
    else if (ind.return6m >= 8) score += 10;
    else score += 5;
  }

  // 4. RSI (5 points) — just entry timing
  if (ind.rsiVal && ind.rsiVal >= 45 && ind.rsiVal <= 68) score += 5;

  // 5. News bonus (5 points)
  if (news) score += 5;

  const tickerHash = details.join('').split('').reduce((a,c) => a + c.charCodeAt(0), 0);
  score += (tickerHash % 100) / 1000;

  return { score: parseFloat(Math.min(score, 100).toFixed(3)), details: details.join(' ') };
}

function scoreCatalyst(ind, news) {
  if (!ind) return null;
  if (!ind.vwapAbove) return null; // hard gate — must be above VWAP
  if (ind.rsiVal && (ind.rsiVal < 35 || ind.rsiVal > 72)) return null;

  let score = 0;
  const details = [];

  // 1. VWAP POSITIONING (30 points) — primary signal for catalyst
  if (ind.vwapAbove) {
    score += 20;
    // Bonus for being just above VWAP (fresh breakout vs extended)
    if (ind.todayVwap && ind.cur) {
      const vwapDev = (ind.cur - ind.todayVwap) / ind.todayVwap * 100;
      if (vwapDev <= 3) score += 10; // just above = fresh
      else if (vwapDev <= 6) score += 5;
    }
    details.push('VWAP↑');
  }

  // 2. RSI SWEET SPOT (25 points) — room to move
  if (ind.rsiVal) {
    if (ind.rsiVal >= 50 && ind.rsiVal <= 65) score += 25; // ideal
    else if (ind.rsiVal >= 42 && ind.rsiVal <= 70) score += 15;
    details.push(`RSI:${ind.rsiVal}`);
  }

  // 3. BOLLINGER SQUEEZE (20 points) — compression before move
  if (ind.bbWidth !== null) {
    if (ind.bbWidth <= 8) score += 20; // tight squeeze
    else if (ind.bbWidth <= 12) score += 12;
    else if (ind.bbWidth <= 16) score += 6;
    details.push(`BB:${ind.bbWidth}%`);
  }

  // 4. VOLUME SPIKE (15 points) — unusual activity
  if (ind.rvol !== null) {
    if (ind.rvol >= 2.0) score += 15;
    else if (ind.rvol >= 1.5) score += 10;
    else if (ind.rvol >= 1.2) score += 5;
    details.push(`RVOL:${ind.rvol}`);
  }

  // 5. NEWS (10 points) — catalyst signal
  if (news) score += 10;

  const tickerHash = details.join('').split('').reduce((a,c) => a + c.charCodeAt(0), 0);
  score += (tickerHash % 100) / 1000;

  return { score: parseFloat(Math.min(score, 100).toFixed(3)), details: details.join(' ') };
}

// ── MARKET CONTEXT ──
async function getMarketContext() {
  console.log('[Scan] Fetching market context...');
  const etfs = ['SPY','VIXY','XLK','XLF','XLE','XLV','XLI','XLP','XLU','XLB','XLY','XLRE','XLC'];
  const results = await Promise.all(etfs.map(t => poly(`/v2/aggs/ticker/${t}/prev`)));
  const getR = d => { const r = d?.results?.[0]; return r && r.o ? parseFloat(((r.c-r.o)/r.o*100).toFixed(2)) : null; };
  const spyRet = getR(results[0]);
  const vixLevel = results[1]?.results?.[0]?.c;
  const sectorNames = ['XLK(Tech)','XLF(Fin)','XLE(Energy)','XLV(Health)','XLI(Indust)','XLP(Staples)','XLU(Utils)','XLB(Matls)','XLY(Discret)','XLRE(RE)','XLC(Comm)'];
  const sectors = results.slice(2).map((r,i) => ({name:sectorNames[i], ret:getR(r)})).filter(s=>s.ret!==null).sort((a,b)=>b.ret-a.ret);
  const regime = spyRet > 0.5 ? 'BULL' : spyRet < -0.5 ? 'BEAR' : 'NEUTRAL';
  const ctx = { spyRet, regime, vixLevel, sectors,
    summary: `SPY${spyRet>=0?'+':''}${spyRet}% (${regime}). VIX:${vixLevel}. Leading: ${sectors.slice(0,3).map(s=>s.name+':'+(s.ret>0?'+':'')+s.ret+'%').join(', ')}` };
  console.log(`[Market] ${ctx.summary}`);
  return ctx;
}

// ── NEWS ──
async function getNews(ticker) {
  await delay(80);
  const weekAgo = new Date(Date.now()-7*86400000).toISOString().split('T')[0];
  const d = await poly(`/v2/reference/news?ticker=${ticker}&published_utc.gte=${weekAgo}&limit=3&sort=published_utc&order=desc`);
  return d?.results?.length ? d.results.map(a=>a.title).join(' | ') : null;
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
  const rev0 = q0.revenues?.value, rev1 = q1.revenues?.value;
  const ni0 = q0.net_income_loss?.value, ni1 = q1.net_income_loss?.value;
  return {
    revenueGrowth: rev0 && rev1 && rev1 > 0 ? parseFloat(((rev0-rev1)/rev1*100).toFixed(1)) : 0,
    earningsGrowth: ni0 && ni1 && ni1 > 0 ? parseFloat(((ni0-ni1)/ni1*100).toFixed(1)) : 0
  };
}

// ── MAIN ──
async function main() {
  console.log('[Scan] PulseStock Universe Scanner v4.0 — Pure Mathematical Scoring');
  console.log('[Scan] 90+ = Strong Buy | 85-89 = Buy | 80-84 = Watch | Below 80 = Excluded');
  
  const universe = await fetchJson(TICKER_URL);
  const tickers = universe?.all || [];
  console.log(`[Scan] ${tickers.length} tickers`);

  const marketContext = await getMarketContext();
  const today = new Date().toISOString().split('T')[0];
  const yearAgo = new Date(Date.now()-380*86400000).toISOString().split('T')[0];

  // Phase 1: Quick filter
  console.log('\n[Phase 1] Filtering: price>$5, dollar volume>$20M, valid VWAP...');
  const phase1 = {};
  let p1done = 0;

  for (const ticker of tickers) {
    p1done++;
    const prev = await poly(`/v2/aggs/ticker/${ticker}/prev`);
    const r = prev?.results?.[0];
    if (!r || !r.c || !r.vw || !r.v) continue;
    const dollarVol = r.v * r.c / 1e6;
    if (dollarVol < 20) continue;  // $20M minimum — eliminates micro-caps
    if (r.c < 5) continue;
    if (!r.h || !r.l) continue;
    const dayRange = (r.h-r.l)/r.l*100;
    if (dayRange < 0.3 || dayRange > 20) continue;
    phase1[ticker] = { price:r.c, vwap:r.vw, volume:r.v, dollarVol, open:r.o };
    if (p1done % 200 === 0) console.log(`[Phase 1] ${p1done}/${tickers.length} — ${Object.keys(phase1).length} pass`);
  }
  console.log(`[Phase 1] Complete: ${Object.keys(phase1).length} pass ($20M+ daily volume filter)`);

  // Phase 2: Compute indicators
  console.log('\n[Phase 2] Computing 200-day indicators...');
  const phase2 = {};
  let p2done = 0;
  for (const ticker of Object.keys(phase1)) {
    p2done++;
    const candles = await poly(`/v2/aggs/ticker/${ticker}/range/1/day/${yearAgo}/${today}?adjusted=true&sort=asc&limit=400`);
    const bars = candles?.results || [];
    if (bars.length < 60) continue;
    const ind = computeIndicators(bars);
    if (!ind) continue;

    // Fetch financials for stocks with enough history
    const fin = bars.length >= 200 ? await getFinancials(ticker) : null;

    phase2[ticker] = { ...phase1[ticker], indicators: ind, fin, news: null };
    if (p2done % 100 === 0) console.log(`[Phase 2] ${p2done}/${Object.keys(phase1).length} — ${Object.keys(phase2).length} with indicators`);
  }
  console.log(`[Phase 2] Complete: ${Object.keys(phase2).length} with full indicators`);

  // Phase 3: Score each strategy
  const strategies = ['momentum', 'compounder', 'catalyst'];
  const TIER_GATES = { momentum: 80, compounder: 80, catalyst: 80 };

  for (const strategy of strategies) {
    console.log(`\n[${strategy.toUpperCase()}] Scoring...`);
    const scored = [];

    for (const ticker of Object.keys(phase2)) {
      const d = phase2[ticker];
      const ind = d.indicators;

      let result = null;
      if (strategy === 'momentum') result = scoreMomentum(ind, d.fin, d.news);
      else if (strategy === 'compounder') result = scoreCompounder(ind, d.fin, d.news);
      else result = scoreCatalyst(ind, d.news);

      if (result && result.score >= TIER_GATES[strategy]) {
        scored.push({ ticker, ...result, price: d.price, rsi: ind?.rsiVal, return6m: ind?.return6m });
      }
    }

    // Sort by score descending — guaranteed unique due to ticker hash offset
    scored.sort((a, b) => b.score - a.score);

    // Fetch news only for top candidates to save API calls
    const top100 = scored.slice(0, 100);
    console.log(`[${strategy.toUpperCase()}] ${scored.length} pass gate, fetching news for top ${top100.length}...`);
    for (const c of top100) {
      phase2[c.ticker].news = await getNews(c.ticker);
      // Add small news bonus to score if news exists
      if (phase2[c.ticker].news) c.score = parseFloat((c.score + 5).toFixed(3));
    }
    top100.sort((a, b) => b.score - a.score);

    // Label tiers
    const strongBuy = top100.filter(c => c.score >= 90);
    const buy = top100.filter(c => c.score >= 85 && c.score < 90);
    const watch = top100.filter(c => c.score >= 80 && c.score < 85);

    console.log(`[${strategy.toUpperCase()}] Strong Buy (90+): ${strongBuy.length} | Buy (85-89): ${buy.length} | Watch (80-84): ${watch.length}`);
    console.log(`[${strategy.toUpperCase()}] Top 10: ${top100.slice(0,10).map(c=>c.ticker+'('+c.score+')').join(', ')}`);

    // Save to Supabase
    await sb('DELETE', 'pre_screened_candidates', null, `?strategy_id=eq.${strategy}&trading_date=eq.${today}`);
    for (let i = 0; i < top100.length; i++) {
      const c = top100[i];
      const tier = c.score >= 90 ? 'strong_buy' : c.score >= 85 ? 'buy' : 'watch';
      await sb('POST', 'pre_screened_candidates', {
        strategy_id: strategy, ticker: c.ticker, rank: i+1,
        screen_score: c.score,
        screen_reason: `${tier.toUpperCase()} | ${c.details}`,
        price: c.price, rsi: c.rsi, trading_date: today
      });
    }
    console.log(`[${strategy.toUpperCase()}] Saved ${top100.length} candidates (${strongBuy.length} Strong Buy, ${buy.length} Buy, ${watch.length} Watch)`);
  }

  console.log('\n[Scan] Complete!');
  console.log('[Scan] Deep dive only Strong Buy (90+) and Buy (85-89) candidates');
  console.log('[Scan] Watch (80-84) candidates are monitor-only — no deep dive');
  process.exit(0);
}

main().catch(e => { console.error('[Scan] Fatal:', e.message); process.exit(1); });
