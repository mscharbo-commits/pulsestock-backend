// PulseStock Research Backend — Railway always-on server
const https = require('https');
const http = require('http');

const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const FHK = 'd8fhh6hr01qn443a0bngd8fhh6hr01qn443a0bo0';
const TICKER_URL = 'https://raw.githubusercontent.com/mscharbo-commits/pulsestock-study-data/main/ticker_universe.json';
const PORT = process.env.PORT || 8080;

// ── HTTP HELPER with timeout ──
function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Request timeout')), 10000);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', (e) => { clearTimeout(timeout); reject(e); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Socket timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── SUPABASE ──
async function sb(method, table, data, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
  try {
    const r = await fetchJson(url, { method, headers, body: data ? JSON.stringify(data) : undefined });
    return r.body;
  } catch(e) { console.error(`[SB] ${method} ${table} failed:`, e.message); return null; }
}

// ── FINNHUB ──
async function getQuote(ticker) {
  try {
    await new Promise(r => setTimeout(r, 100));
    const r = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FHK}`);
    return r.body && r.body.c > 0 ? r.body : null;
  } catch (e) { return null; }
}

async function getMetric(ticker) {
  try {
    await new Promise(r => setTimeout(r, 100));
    const r = await fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FHK}`);
    return r.body && r.body.metric ? r.body.metric : null;
  } catch (e) { return null; }
}

// ── UNIVERSE ──
let universeCache = null;
async function getUniverse() {
  if (universeCache) return universeCache;
  const r = await fetchJson(TICKER_URL);
  universeCache = (r.body && r.body.all) ? r.body.all : [];
  console.log(`[Universe] Loaded ${universeCache.length} tickers`);
  return universeCache;
}

// ── MECHANICAL SCORE (Finnhub only, no AI cost) ──
async function scoreForStrategy(ticker, strategy) {
  const quote = await getQuote(ticker);
  if (!quote || !quote.c || quote.c < 5) return null;

  const price = quote.c;
  const prevClose = quote.pc || price;
  const metric = await getMetric(ticker);
  if (!metric) return null;

  const w52h = metric['52WeekHigh'] ? parseFloat(metric['52WeekHigh']) : null;
  const w52l = metric['52WeekLow'] ? parseFloat(metric['52WeekLow']) : null;
  const rsi = metric['rsi14d'] ? parseFloat(metric['rsi14d']) : null;
  const beta = metric['beta'] ? parseFloat(metric['beta']) : null;

  if (!w52h || !w52l || w52h <= w52l) return null;

  const rangePos = ((price - w52l) / (w52h - w52l)) * 100;
  const vwapAbove = price > prevClose;
  let score = 0;

  if (strategy === 'momentum') {
    if (rangePos < 45) return null; // must be in uptrend
    if (rsi && (rsi < 40 || rsi > 80)) return null; // RSI out of range
    score = rangePos * 0.4;
    if (rsi && rsi >= 50 && rsi <= 72) score += 25;
    if (vwapAbove) score += 20;
    if (beta && beta > 0.8 && beta < 2.0) score += 15;
  } else if (strategy === 'compounder') {
    if (rangePos < 35) return null;
    if (rsi && rsi > 76) return null; // overbought
    score = rangePos * 0.35;
    if (rsi && rsi >= 40 && rsi <= 68) score += 30;
    if (vwapAbove) score += 20;
    if (beta && beta < 1.2) score += 15; // prefer lower beta for long holds
  } else if (strategy === 'catalyst') {
    if (!vwapAbove) return null; // hard gate: must be above VWAP
    if (rangePos < 30 || rangePos > 92) return null;
    if (rsi && (rsi < 35 || rsi > 72)) return null;
    score = vwapAbove ? 35 : 0;
    if (rsi && rsi >= 42 && rsi <= 68) score += 35;
    score += (100 - Math.abs(rangePos - 60)) * 0.3;
  }

  if (score < 20) return null;

  return {
    ticker, strategy, score: parseFloat(score.toFixed(2)),
    price, rangePos: parseFloat(rangePos.toFixed(1)),
    rsi: rsi ? parseFloat(rsi.toFixed(1)) : null,
    vwapAbove,
    reason: `Range:${rangePos.toFixed(0)}% RSI:${rsi?.toFixed(0)||'?'} VWAP:${vwapAbove?'above':'below'}`
  };
}

// ── DAILY SCREEN ──
let screenRunning = false;

async function runDailyScreen() {
  if (screenRunning) { console.log('[Screen] Already running, skipping'); return; }
  const etDay = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (['Sat', 'Sun'].includes(etDay)) { console.log('[Screen] Weekend, skipping'); return; }

  screenRunning = true;
  const today = new Date().toISOString().split('T')[0];
  console.log(`[Screen] Starting daily scan for ${today}...`);

  try {
    const universe = await getUniverse();
    const strategies = ['momentum', 'compounder', 'catalyst'];

    for (const strategy of strategies) {
      console.log(`[Screen] Scanning ${universe.length} tickers for ${strategy}...`);
      const scored = [];

      // Process in batches of 50 to keep memory low
      // Process in parallel batches of 10 for speed
      for (let i = 0; i < universe.length; i += 10) {
        const batch = universe.slice(i, i + 10);
        const results = await Promise.all(batch.map(t => scoreForStrategy(t, strategy).catch(() => null)));
        results.forEach(r => { if (r) scored.push(r); });
        if (i % 200 === 0) {
          console.log(`[Screen] ${strategy}: ${i}/${universe.length} done, ${scored.length} candidates`);
        }
        // Small delay between batches to avoid rate limits
        await new Promise(r => setTimeout(r, 100));
      }

      scored.sort((a, b) => b.score - a.score);
      const top50 = scored.slice(0, 50);
      console.log(`[Screen] ${strategy}: ${top50.length} candidates found, saving...`);

      // Clear old and insert new
      await sb('DELETE', 'pre_screened_candidates', null, `?strategy_id=eq.${strategy}&trading_date=eq.${today}`);

      for (let i = 0; i < top50.length; i++) {
        const c = top50[i];
        await sb('POST', 'pre_screened_candidates', {
          strategy_id: strategy, ticker: c.ticker,
          rank: i + 1, screen_score: c.score,
          screen_reason: c.reason, price: c.price,
          range_position: c.rangePos, rsi: c.rsi,
          trading_date: today
        });
      }
      console.log(`[Screen] ${strategy}: saved ${top50.length} candidates`);
    }
    console.log(`[Screen] Daily scan complete for ${today}`);
  } catch(e) {
    console.error('[Screen] Error:', e.message);
  } finally {
    screenRunning = false;
  }
}

// ── STOP MONITOR ──
async function checkAllStops() {
  const now = new Date();
  const etHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const etMin = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }));
  const etDay = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const isMarketHours = !['Sat','Sun'].includes(etDay) &&
    (etHour > 9 || (etHour === 9 && etMin >= 30)) && etHour < 16;
  if (!isMarketHours) return;

  const openPicks = await sb('GET', 'study_picks', null, '?status=eq.open&select=*');
  if (!openPicks || !openPicks.length) return;

  for (const pick of openPicks) {
    const quote = await getQuote(pick.ticker);
    if (!quote) continue;
    const stop = parseFloat(pick.stop_loss) || 0;
    const target = parseFloat(pick.target_price) || 0;
    let exitPrice = null, exitReason = null;
    if (stop && quote.l <= stop) { exitPrice = stop; exitReason = 'stop_hit'; }
    else if (target && quote.h >= target) { exitPrice = target; exitReason = 'target_hit'; }
    if (!exitPrice) continue;

    const entry = parseFloat(pick.entry_price) || 0;
    const returnPct = entry ? parseFloat(((exitPrice-entry)/entry*100).toFixed(2)) : 0;
    await sb('PATCH', 'study_picks', { status:'closed', exit_price:exitPrice, return_pct:returnPct, exit_reason:exitReason, exit_date:new Date().toISOString() }, `?id=eq.${pick.id}`);
    await sb('POST', 'closed_trades', { strategy_id:pick.strategy_id, ticker:pick.ticker, entry_price:entry, exit_price:exitPrice, return_pct:returnPct, exit_reason:exitReason, portfolio:pick.strategy_id, sector:pick.sector||'', gen_number:pick.gen_number });
    console.log(`[Stops] CLOSED: ${pick.ticker} @ $${exitPrice} (${returnPct}%) — ${exitReason}`);
  }
}

// ── HTTP SERVER ──
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString(), screenRunning }));
    return;
  }

  if (url.pathname === '/check-stops') {
    await checkAllStops();
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'done' }));
    return;
  }

  if (url.pathname === '/run-screen') {
    if (screenRunning) {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'already running' }));
      return;
    }
    // Run async — don't await so request returns immediately
    runDailyScreen().catch(e => console.error('[Screen]', e.message));
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'screen started', time: new Date().toISOString() }));
    return;
  }

  if (url.pathname === '/candidates') {
    const strategy = url.searchParams.get('strategy') || 'momentum';
    const today = new Date().toISOString().split('T')[0];
    const candidates = await sb('GET', 'pre_screened_candidates', null,
      `?strategy_id=eq.${strategy}&trading_date=eq.${today}&order=rank.asc&limit=50`);
    res.writeHead(200);
    res.end(JSON.stringify(candidates || []));
    return;
  }

  if (url.pathname === '/prices') {
    const tickers = (url.searchParams.get('tickers') || '').split(',').filter(Boolean).slice(0, 20);
    const results = {};
    for (const t of tickers) {
      const q = await getQuote(t);
      if (q) results[t] = { c: q.c, h: q.h, l: q.l, pc: q.pc };
    }
    res.writeHead(200);
    res.end(JSON.stringify(results));
    return;
  }

  if (url.pathname === '/earnings-calendar') {
    const today = new Date().toISOString().split('T')[0];
    const end = new Date(Date.now() + 10*86400000).toISOString().split('T')[0];
    const r = await fetchJson(`https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${end}&token=${FHK}`).catch(() => ({ body: {} }));
    res.writeHead(200);
    res.end(JSON.stringify(r.body || {}));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`PulseStock backend running on port ${PORT}`);
  console.log(`Endpoints: /health /check-stops /run-screen /candidates /prices /earnings-calendar`);
});

// Check stops every 5 minutes
setInterval(() => checkAllStops().catch(e => console.error('[Stops]', e.message)), 5 * 60 * 1000);

// Schedule daily scan at 8am ET
function scheduleDailyScreen() {
  const now = new Date();
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const next8am = new Date(etNow);
  next8am.setHours(8, 0, 0, 0);
  if (etNow >= next8am) next8am.setDate(next8am.getDate() + 1);
  const msUntil = next8am - etNow;
  console.log(`[Screen] Next daily scan in ${Math.round(msUntil/60000)} minutes`);
  setTimeout(() => {
    runDailyScreen().catch(e => console.error('[Screen]', e.message));
    setInterval(() => runDailyScreen().catch(e => console.error('[Screen]', e.message)), 24*60*60*1000);
  }, msUntil);
}

scheduleDailyScreen();
setTimeout(() => checkAllStops().catch(() => {}), 15000);
