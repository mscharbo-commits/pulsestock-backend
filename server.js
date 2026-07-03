// PulseStock Research Backend — Railway always-on server
// Lightweight server — scan runs as separate Railway cron job
const https = require('https');
const http = require('http');

const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const FHK = 'd8fhh6hr01qn443a0bngd8fhh6hr01qn443a0bo0';
const PORT = process.env.PORT || 8080;

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 8000);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', (e) => { clearTimeout(timeout); resolve(null); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function sb(method, table, data, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const headers = {
    'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json', 'Prefer': 'return=representation'
  };
  try {
    return await fetchJson(url, { method, headers, body: data ? JSON.stringify(data) : undefined });
  } catch(e) { return null; }
}

async function getQuote(ticker) {
  await new Promise(r => setTimeout(r, 150));
  try {
    const d = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FHK}`);
    return d && d.c > 0 ? d : null;
  } catch(e) { return null; }
}

// Stop monitor — lightweight, runs every 5 mins
async function checkAllStops() {
  const now = new Date();
  const etHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const etMin = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }));
  const etDay = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (['Sat','Sun'].includes(etDay)) return;
  if (!(etHour > 9 || (etHour === 9 && etMin >= 30)) || etHour >= 16) return;

  const openPicks = await sb('GET', 'study_picks', null, '?status=eq.open&select=id,ticker,stop_loss,target_price,entry_price,strategy_id,sector,gen_number,date');
  if (!openPicks || !openPicks.length) return;

  for (const pick of openPicks) {
    const q = await getQuote(pick.ticker);
    if (!q) continue;
    const stop = parseFloat(pick.stop_loss) || 0;
    const target = parseFloat(pick.target_price) || 0;
    let exitPrice = null, exitReason = null;
    if (stop && q.l <= stop) { exitPrice = stop; exitReason = 'stop_hit'; }
    else if (target && q.h >= target) { exitPrice = target; exitReason = 'target_hit'; }
    if (!exitPrice) continue;
    const entry = parseFloat(pick.entry_price) || 0;
    const returnPct = entry ? parseFloat(((exitPrice-entry)/entry*100).toFixed(2)) : 0;
    await sb('PATCH', 'study_picks', { status:'closed', exit_price:exitPrice, return_pct:returnPct, exit_reason:exitReason, exit_date:new Date().toISOString() }, `?id=eq.${pick.id}`);
    await sb('POST', 'closed_trades', { strategy_id:pick.strategy_id, ticker:pick.ticker, entry_price:entry, exit_price:exitPrice, return_pct:returnPct, exit_reason:exitReason, portfolio:pick.strategy_id, sector:pick.sector||'', gen_number:pick.gen_number });
    console.log(`[Stops] CLOSED: ${pick.ticker} @ $${exitPrice} (${returnPct}%) — ${exitReason}`);
  }
}

// HTTP server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS'); res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
    return;
  }

  if (url.pathname === '/check-stops') {
    await checkAllStops();
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'done' }));
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
    const tickers = (url.searchParams.get('tickers') || '').split(',').filter(Boolean).slice(0, 10);
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
    const d = await fetchJson(`https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${end}&token=${FHK}`);
    res.writeHead(200);
    res.end(JSON.stringify(d || {}));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`PulseStock backend running on port ${PORT}`);
});

// Stop check every 5 minutes
setInterval(() => checkAllStops().catch(() => {}), 5 * 60 * 1000);
setTimeout(() => checkAllStops().catch(() => {}), 15000);
