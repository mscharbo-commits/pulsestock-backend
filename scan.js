// PulseStock Universe Scanner v5.0
// Uses main platform API (pulsestock-nu.vercel.app) as data source
// All data already working there — no separate Polygon/Finnhub calls needed

const https = require('https');
const http = require('http');

const MAIN_API = 'https://pulsestock-nu.vercel.app/api';
const POLY_KEY = process.env.POLYGON_API_KEY || 'qpe_fbt2WsRl8D2YquOMzbzYlWcywazt';
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

// ── FETCH FROM MAIN PLATFORM ──
async function getMetrics(ticker) {
  await delay(200); // rate limit
  return fetchJson(`${MAIN_API}/metrics?ticker=${ticker}`);
}

async function getProfile(ticker) {
  await delay(150);
  return fetchJson(`${MAIN_API}/company?ticker=${ticker}`);
}

async function getNews(ticker) {
  await delay(150);
  const d = await fetchJson(`${MAIN_API}/news?ticker=${ticker}&days=7`);
  return Array.isArray(d) && d.length ? d.slice(0,3).map(n=>n.headline||'').join(' | ') : null;
}

// ── MARKET CONTEXT (from Polygon directly — works server-side) ──
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
    leadingSectors: sectors.slice(0,3).map(s=>s.name),
    summary: `SPY${spyRet>=0?'+':''}${spyRet}% (${regime}). VIX:${vixLevel}. Leading: ${sectors.slice(0,3).map(s=>s.name+':'+(s.ret>0?'+':'')+s.ret+'%').join(', ')}` };
  console.log(`[Market] ${ctx.summary}`);
  return ctx;
}

// ── PURE MATHEMATICAL SCORING ──
function scoreMomentum(met, profile, ind6m) {
  if (!met) return null;

  const price = parseFloat(met.price) || 0;
  const w52h = parseFloat(met.week52HighRaw) || 0;
  const w52l = parseFloat(met.week52LowRaw) || 0;
  const vwap = parseFloat(met.todayVWAP) || 0;
  const rsi = parseFloat(met.rsi14) || 0;
  const beta = parseFloat(met.beta) || 0;
  const sector = profile?.sector || profile?.finnhubIndustry || '';

  if (!price || !w52h || !w52l) return null;

  // Hard exclusions
  if (sector.toLowerCase().includes('utility')) return null;
  if (sector.toLowerCase().includes('real estate')) return null;
  if (rsi > 80) return null; // overbought

  const rangePos = w52h > w52l ? ((price - w52l) / (w52h - w52l) * 100) : null;
  const pctFromHigh = w52h > 0 ? ((price - w52h) / w52h * 100) : null;
  const pctAboveLow = w52l > 0 ? ((price - w52l) / w52l * 100) : null;
  const vwapAbove = vwap > 0 ? price > vwap : null;

  let score = 0;
  const details = [];

  // 1. MINERVINI CHECKS using what metrics gives us (20 points)
  // We don't have MAs from metrics, use range position as proxy
  if (rangePos !== null) {
    if (rangePos >= 70) score += 20; // strong uptrend
    else if (rangePos >= 55) score += 14;
    else if (rangePos >= 45) score += 8;
    else return null; // not in uptrend
    details.push(`Range:${rangePos.toFixed(0)}%`);
  }

  // 2. DISTANCE FROM HIGH (15 points) — within 15% of high is ideal
  if (pctFromHigh !== null) {
    if (pctFromHigh >= -10) score += 15;
    else if (pctFromHigh >= -15) score += 10;
    else if (pctFromHigh >= -25) score += 5;
    else return null; // too far from high
    details.push(`Hi:${pctFromHigh.toFixed(0)}%`);
  }

  // 3. ABOVE LOW (10 points)
  if (pctAboveLow !== null && pctAboveLow >= 30) {
    score += 10;
    details.push(`AbvLo:${pctAboveLow.toFixed(0)}%`);
  }

  // 4. RSI QUALITY (15 points)
  if (rsi >= 55 && rsi <= 72) score += 15;
  else if (rsi >= 50 && rsi <= 78) score += 8;
  details.push(`RSI:${rsi}`);

  // 5. VWAP (15 points)
  if (vwapAbove === true) score += 15;
  else if (vwapAbove === false) score -= 5;
  details.push(`VWAP:${vwapAbove?'↑':'↓'}`);

  // 6. 6-MONTH RETURN from Polygon (25 points)
  if (ind6m !== null) {
    if (ind6m >= 30) score += 25;
    else if (ind6m >= 20) score += 18;
    else if (ind6m >= 10) score += 12;
    else if (ind6m >= 5) score += 6;
    else return null; // need positive momentum
    details.push(`6m:${ind6m}%`);
  }

  // Add unique offset
  const hash = details.join('').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  score += (hash % 100) / 1000;

  return { score: parseFloat(Math.min(score, 100).toFixed(3)), details: details.join(' ') };
}

function scoreCompounder(met, profile, ind6m) {
  if (!met) return null;

  const price = parseFloat(met.price) || 0;
  const w52h = parseFloat(met.week52HighRaw) || 0;
  const w52l = parseFloat(met.week52LowRaw) || 0;
  const vwap = parseFloat(met.todayVWAP) || 0;
  const rsi = parseFloat(met.rsi14) || 0;
  const roe = parseFloat(met.roe) || 0;
  const netMargin = parseFloat(met.netMargin) || 0;
  const sector = profile?.sector || '';

  if (!price || !w52h || !w52l) return null;
  if (sector.toLowerCase().includes('utility')) return null;
  if (rsi > 78) return null;

  const rangePos = w52h > w52l ? ((price - w52l) / (w52h - w52l) * 100) : null;
  const vwapAbove = vwap > 0 ? price > vwap : null;

  let score = 0;
  const details = [];

  // 1. PRICE STRUCTURE (25 points)
  if (rangePos !== null) {
    if (rangePos >= 50) score += 25;
    else if (rangePos >= 35) score += 15;
    else return null;
    details.push(`Range:${rangePos.toFixed(0)}%`);
  }

  // 2. QUALITY METRICS (35 points)
  if (roe >= 20) score += 20;
  else if (roe >= 15) score += 14;
  else if (roe >= 10) score += 8;
  details.push(`ROE:${roe}%`);

  if (netMargin >= 20) score += 15;
  else if (netMargin >= 10) score += 10;
  else if (netMargin >= 5) score += 5;
  details.push(`Margin:${netMargin}%`);

  // 3. MOMENTUM (20 points)
  if (ind6m !== null && ind6m >= 5) {
    if (ind6m >= 20) score += 20;
    else if (ind6m >= 10) score += 13;
    else score += 6;
    details.push(`6m:${ind6m}%`);
  }

  // 4. RSI ENTRY TIMING (10 points)
  if (rsi >= 45 && rsi <= 68) score += 10;
  details.push(`RSI:${rsi}`);

  // 5. VWAP (10 points)
  if (vwapAbove === true) score += 10;
  details.push(`VWAP:${vwapAbove?'↑':'↓'}`);

  const hash = details.join('').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  score += (hash % 100) / 1000;

  return { score: parseFloat(Math.min(score, 100).toFixed(3)), details: details.join(' ') };
}

function scoreCatalyst(met, profile, ind6m) {
  if (!met) return null;

  const price = parseFloat(met.price) || 0;
  const w52h = parseFloat(met.week52HighRaw) || 0;
  const w52l = parseFloat(met.week52LowRaw) || 0;
  const vwap = parseFloat(met.todayVWAP) || 0;
  const rsi = parseFloat(met.rsi14) || 0;
  const sector = profile?.sector || '';

  if (!price || !vwap || price <= vwap) return null; // VWAP hard gate
  if (rsi < 35 || rsi > 72) return null;

  const rangePos = w52h > w52l ? ((price - w52l) / (w52h - w52l) * 100) : null;
  if (rangePos !== null && (rangePos < 25 || rangePos > 92)) return null;

  let score = 0;
  const details = [];

  // VWAP positioning (35 points)
  const vwapDev = ((price - vwap) / vwap * 100);
  if (vwapDev <= 2) score += 35; // just above
  else if (vwapDev <= 5) score += 25;
  else score += 15;
  details.push(`VWAPdev:${vwapDev.toFixed(1)}%`);

  // RSI sweet spot (30 points)
  if (rsi >= 50 && rsi <= 65) score += 30;
  else if (rsi >= 42 && rsi <= 70) score += 18;
  details.push(`RSI:${rsi}`);

  // Range position (20 points) — prefer middle of range
  if (rangePos !== null) {
    score += (100 - Math.abs(rangePos - 60)) * 0.2;
    details.push(`Range:${rangePos.toFixed(0)}%`);
  }

  // 6m momentum (15 points)
  if (ind6m !== null && ind6m > 0) {
    if (ind6m >= 15) score += 15;
    else if (ind6m >= 5) score += 8;
    details.push(`6m:${ind6m}%`);
  }

  const hash = details.join('').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  score += (hash % 100) / 1000;

  return { score: parseFloat(Math.min(score, 100).toFixed(3)), details: details.join(' ') };
}

// ── MAIN ──
async function main() {
  console.log('[Scan] PulseStock Universe Scanner v5.0');
  console.log('[Scan] Data source: Main platform APIs (Finnhub + Polygon combined)');
  console.log('[Scan] 90+ = Strong Buy | 85-89 = Buy | 80-84 = Watch');

  const universe = await fetchJson(TICKER_URL);
  const tickers = universe?.all || [];
  console.log(`[Scan] ${tickers.length} tickers`);

  const marketContext = await getMarketContext();
  const today = new Date().toISOString().split('T')[0];
  const yearAgo = new Date(Date.now()-380*86400000).toISOString().split('T')[0];

  // Phase 1: Get metrics from main platform + 6m return from Polygon
  console.log('\n[Phase 1] Fetching data from main platform...');
  const allData = {};
  let done = 0;

  for (const ticker of tickers) {
    done++;

    // Get combined metrics from main platform
    const met = await getMetrics(ticker);
    if (!met || !met.price) {
      if (done % 200 === 0) console.log(`[Phase 1] ${done}/${tickers.length} — ${Object.keys(allData).length} valid`);
      continue;
    }

    const price = parseFloat(met.price) || 0;
    if (price < 5) { if (done % 200 === 0) console.log(`[Phase 1] ${done}/${tickers.length} — ${Object.keys(allData).length} valid`); continue; }

    // Check dollar volume
    const avgVol = parseFloat(met.avgVolRaw) || 0;
    if (avgVol * price / 1e6 < 20) { // less than $20M avg daily dollar volume
      if (done % 200 === 0) console.log(`[Phase 1] ${done}/${tickers.length} — ${Object.keys(allData).length} valid`);
      continue;
    }

    // Get 6-month return from Polygon (candle data)
    let ind6m = null;
    try {
      const candles = await poly(`/v2/aggs/ticker/${ticker}/range/1/day/${yearAgo}/${today}?adjusted=true&sort=asc&limit=200`);
      const bars = candles?.results || [];
      if (bars.length >= 126) {
        const cur = bars[bars.length-1].c;
        const ago = bars[bars.length-126].c;
        ind6m = ago > 0 ? parseFloat(((cur-ago)/ago*100).toFixed(1)) : null;
      }
    } catch(e) {}

    // Get company profile for sector
    const profile = await getProfile(ticker);

    allData[ticker] = { met, profile, ind6m, price };

    if (done % 100 === 0) console.log(`[Phase 1] ${done}/${tickers.length} — ${Object.keys(allData).length} valid`);
  }
  console.log(`[Phase 1] Complete: ${Object.keys(allData).length} tickers with valid data`);

  // Phase 2: Score and rank
  const strategies = ['momentum', 'compounder', 'catalyst'];

  for (const strategy of strategies) {
    console.log(`\n[${strategy.toUpperCase()}] Scoring...`);
    const scored = [];

    for (const [ticker, d] of Object.entries(allData)) {
      let result = null;
      if (strategy === 'momentum') result = scoreMomentum(d.met, d.profile, d.ind6m);
      else if (strategy === 'compounder') result = scoreCompounder(d.met, d.profile, d.ind6m);
      else result = scoreCatalyst(d.met, d.profile, d.ind6m);

      if (result && result.score >= 80) {
        scored.push({ ticker, ...result, price: d.price });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top100 = scored.slice(0, 100);

    // Fetch news for top candidates
    console.log(`[${strategy.toUpperCase()}] ${scored.length} pass gate — fetching news for top ${Math.min(top100.length, 50)}...`);
    for (const c of top100.slice(0, 50)) {
      const news = await getNews(c.ticker);
      if (news) c.score = parseFloat((c.score + 3).toFixed(3)); // small news bonus
    }
    top100.sort((a, b) => b.score - a.score);

    const strongBuy = top100.filter(c => c.score >= 90);
    const buy = top100.filter(c => c.score >= 85 && c.score < 90);
    const watch = top100.filter(c => c.score >= 80 && c.score < 85);

    console.log(`[${strategy.toUpperCase()}] Strong Buy (90+): ${strongBuy.length} | Buy (85-89): ${buy.length} | Watch (80-84): ${watch.length}`);
    console.log(`[${strategy.toUpperCase()}] Top 10: ${top100.slice(0,10).map(c=>c.ticker+'('+c.score+')').join(', ')}`);

    await sb('DELETE', 'pre_screened_candidates', null, `?strategy_id=eq.${strategy}&trading_date=eq.${today}`);
    for (let i = 0; i < top100.length; i++) {
      const c = top100[i];
      const tier = c.score >= 90 ? 'STRONG_BUY' : c.score >= 85 ? 'BUY' : 'WATCH';
      await sb('POST', 'pre_screened_candidates', {
        strategy_id: strategy, ticker: c.ticker, rank: i+1,
        screen_score: c.score,
        screen_reason: `${tier} | ${c.details}`,
        price: c.price, trading_date: today
      });
    }
    console.log(`[${strategy.toUpperCase()}] Saved ${top100.length} candidates`);
  }

  console.log('\n[Scan] Complete!');
  process.exit(0);
}

main().catch(e => { console.error('[Scan] Fatal:', e.message); process.exit(1); });
