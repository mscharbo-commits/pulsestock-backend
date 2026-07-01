// PulseStock Research Backend
// Railway always-on Node.js server
// Handles: stop/target monitoring every 5 mins during market hours
//          price API (no CORS/rate limit issues)
//          daily universe pre-screen at 8am ET

const https = require('https');
const http = require('http');

// ── CONFIG ──
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const FHK = 'd8fhh6hr01qn443a0bngd8fhh6hr01qn443a0bo0';
const PORT = process.env.PORT || 3000;

// ── HELPERS ──
function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function sb(method, table, data, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
  return fetchJson(url, { method, headers, body: data ? JSON.stringify(data) : undefined });
}

async function getQuote(ticker) {
  try {
    const d = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FHK}`);
    return d && d.c ? d : null;
  } catch (e) { return null; }
}

// ── STOP/TARGET MONITOR ──
async function checkAllStops() {
  const now = new Date();
  const etHour = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  const etMin = now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' });
  const etDay = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const hour = parseInt(etHour);
  const isMarketHours = !['Sat','Sun'].includes(etDay) && (hour > 9 || (hour === 9 && parseInt(etMin) >= 30)) && hour < 16;

  if (!isMarketHours) {
    console.log(`[${new Date().toISOString()}] Outside market hours — skipping stop check`);
    return { skipped: true, reason: 'outside market hours' };
  }

  console.log(`[${new Date().toISOString()}] Running stop/target check...`);
  const openPicks = await sb('GET', 'study_picks', null, '?status=eq.open&select=*');
  if (!openPicks || !openPicks.length) return { checked: 0, closed: [] };

  const results = { checked: openPicks.length, closed: [], errors: [] };

  // Stagger calls to avoid Finnhub rate limit — 250ms between each
  for (const pick of openPicks) {
    await new Promise(r => setTimeout(r, 250));
    const quote = await getQuote(pick.ticker);
    if (!quote) continue;

    const price = quote.c;
    const dayLow = quote.l || price;
    const dayHigh = quote.h || price;
    const stop = parseFloat(pick.stop_loss) || 0;
    const target = parseFloat(pick.target_price) || 0;

    let exitPrice = null, exitReason = null;
    if (stop && dayLow <= stop) { exitPrice = stop; exitReason = 'stop_hit'; }
    else if (target && dayHigh >= target) { exitPrice = target; exitReason = 'target_hit'; }

    if (exitPrice && exitReason) {
      const entry = parseFloat(pick.entry_price) || 0;
      const returnPct = entry ? ((exitPrice - entry) / entry * 100) : 0;

      await sb('PATCH', 'study_picks', {
        status: 'closed', exit_price: exitPrice,
        return_pct: parseFloat(returnPct.toFixed(2)),
        exit_reason: exitReason, exit_date: new Date().toISOString()
      }, `?id=eq.${pick.id}`);

      await sb('POST', 'closed_trades', {
        strategy_id: pick.strategy_id, ticker: pick.ticker,
        entry_price: entry, exit_price: exitPrice,
        return_pct: parseFloat(returnPct.toFixed(2)),
        exit_reason: exitReason, portfolio: pick.strategy_id,
        sector: pick.sector || '', gen_number: pick.gen_number,
        days_held: pick.date ? Math.round((Date.now() - new Date(pick.date).getTime()) / 86400000) : 0
      });

      results.closed.push({ ticker: pick.ticker, strategy: pick.strategy_id, exitPrice, returnPct: returnPct.toFixed(2), reason: exitReason });
      console.log(`  CLOSED: ${pick.ticker} @ $${exitPrice} (${returnPct.toFixed(2)}%) — ${exitReason}`);
    }
  }

  console.log(`  Done: checked ${results.checked}, closed ${results.closed.length}`);
  return results;
}

// ── PRICE API (called by research.html to avoid browser rate limits) ──
async function handlePriceRequest(tickers, res) {
  const results = {};
  for (const ticker of tickers.slice(0, 50)) { // max 50 per request
    await new Promise(r => setTimeout(r, 250));
    const q = await getQuote(ticker);
    if (q) results[ticker] = { c: q.c, h: q.h, l: q.l, pc: q.pc };
  }
  return results;
}

// ── HTTP SERVER ──
const server = http.createServer(async (req, res) => {
  // CORS headers so research.html can call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
    return;
  }

  if (url.pathname === '/check-stops') {
    const result = await checkAllStops();
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === '/prices') {
    const tickers = (url.searchParams.get('tickers') || '').split(',').filter(Boolean);
    const result = await handlePriceRequest(tickers, res);
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === '/earnings-calendar') {
    const today = new Date().toISOString().split('T')[0];
    const end = new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];
    const data = await fetchJson(`https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${end}&token=${FHK}`);
    res.writeHead(200);
    res.end(JSON.stringify(data || {}));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`PulseStock backend running on port ${PORT}`);
});

// ── CRON: check stops every 5 minutes ──
setInterval(checkAllStops, 5 * 60 * 1000);

// Run once on startup
setTimeout(checkAllStops, 5000);
