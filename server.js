// PulseStock Research Backend — Railway always-on server
// Handles: stop/target monitoring every 5 mins during market hours
//          daily universe pre-screen at 8am ET for all three strategies
//          price API endpoint for research.html

const https = require('https');
const http = require('http');

// ── CONFIG ──
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FHK = 'd8fhh6hr01qn443a0bngd8fhh6hr01qn443a0bo0';
const TICKER_UNIVERSE_URL = 'https://raw.githubusercontent.com/mscharbo-commits/pulsestock-study-data/main/ticker_universe.json';
const PORT = process.env.PORT || 3000;

// ── HTTP HELPER ──
function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options = {
      method: opts.method || 'GET',
      headers: opts.headers || {}
    };
    if (url.includes('?')) {
      const u = new URL(url);
      options.hostname = u.hostname;
      options.path = u.pathname + u.search;
      options.port = u.port || (url.startsWith('https') ? 443 : 80);
    }
    const req = mod.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
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
  const r = await fetchJson(url, { method, headers, body: data ? JSON.stringify(data) : undefined });
  return r.body;
}

// ── FINNHUB ──
async function getQuote(ticker) {
  try {
    await new Promise(r => setTimeout(r, 250)); // rate limit
    const r = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FHK}`);
    return r.body && r.body.c ? r.body : null;
  } catch (e) { return null; }
}

async function getMetric(ticker) {
  try {
    await new Promise(r => setTimeout(r, 250));
    const r = await fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FHK}`);
    return r.body && r.body.metric ? r.body.metric : null;
  } catch (e) { return null; }
}

// ── ANTHROPIC ──
async function claudeScreen(systemPrompt, userPrompt) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });
  const r = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body
  });
  const content = r.body && r.body.content;
  if (!content) throw new Error('No content from Claude');
  const textBlock = content.find(b => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

// ── UNIVERSE ──
let universeCache = null;
async function getUniverse() {
  if (universeCache) return universeCache;
  const r = await fetchJson(TICKER_UNIVERSE_URL);
  universeCache = r.body && r.body.all ? r.body.all : [];
  return universeCache;
}

// ── MECHANICAL PRE-SCREEN (no API cost) ──
// Uses only Finnhub data to score candidates quickly
async function mechanicalScore(ticker, strategy) {
  const quote = await getQuote(ticker);
  if (!quote || !quote.c || quote.c < 5) return null; // skip penny stocks

  const price = quote.c;
  const dayLow = quote.l;
  const dayHigh = quote.h;
  const prevClose = quote.pc;

  const metric = await getMetric(ticker);
  const w52h = metric && metric['52WeekHigh'] ? parseFloat(metric['52WeekHigh']) : null;
  const w52l = metric && metric['52WeekLow'] ? parseFloat(metric['52WeekLow']) : null;
  const rsi = metric && metric['rsi14d'] ? parseFloat(metric['rsi14d']) : null;
  const beta = metric && metric['beta'] ? parseFloat(metric['beta']) : null;

  // 52-week range position (0-100%)
  let rangePos = null;
  if (w52h && w52l && w52h > w52l) {
    rangePos = ((price - w52l) / (w52h - w52l)) * 100;
  }

  // VWAP estimate (previous close as daily proxy)
  const vwapBias = price > prevClose ? 1 : -1; // 1 = above, -1 = below

  let score = 0;
  let reason = '';

  if (strategy === 'momentum') {
    // Needs: uptrend (range pos > 55%), RSI 45-75, above VWAP
    if (!rangePos || rangePos < 40) return null; // hard gate: not in downtrend
    score += Math.min(rangePos, 100) * 0.4; // range position weight
    if (rsi && rsi >= 45 && rsi <= 75) score += 25;
    if (vwapBias > 0) score += 15;
    if (beta && beta > 0.8 && beta < 2.5) score += 10;
    reason = `Range:${rangePos?.toFixed(0)}% RSI:${rsi?.toFixed(0)} VWAP:${vwapBias > 0 ? 'above' : 'below'}`;

  } else if (strategy === 'compounder') {
    // Needs: quality setup, not overbought (range pos 40-85%), RSI not >75
    if (!rangePos || rangePos < 30) return null;
    if (rsi && rsi > 78) return null; // overbought, wait for pullback
    score += Math.min(rangePos, 85) * 0.4;
    if (rsi && rsi >= 40 && rsi <= 70) score += 25;
    if (vwapBias > 0) score += 20;
    reason = `Range:${rangePos?.toFixed(0)}% RSI:${rsi?.toFixed(0)} VWAP:${vwapBias > 0 ? 'above' : 'below'}`;

  } else if (strategy === 'catalyst') {
    // Needs: VWAP above (smart money in), RSI 40-70 (room to move), not extended
    if (!rangePos || rangePos < 25 || rangePos > 95) return null;
    if (vwapBias < 0) return null; // hard gate: must be above VWAP
    score += vwapBias > 0 ? 30 : 0;
    if (rsi && rsi >= 40 && rsi <= 70) score += 35;
    score += (100 - Math.abs(rangePos - 60)) * 0.3; // prefer mid-range
    reason = `Range:${rangePos?.toFixed(0)}% RSI:${rsi?.toFixed(0)} VWAP:above`;
  }

  return { ticker, score, reason, price, rangePos, rsi, vwapBias };
}

// ── DAILY UNIVERSE SCAN ──
async function runDailyScreen() {
  const today = new Date().toISOString().split('T')[0];
  const etHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const etDay = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });

  if (['Sat', 'Sun'].includes(etDay)) {
    console.log(`[Screen] Weekend — skipping daily screen`);
    return;
  }

  console.log(`[Screen] Starting daily universe scan for ${today}...`);
  const universe = await getUniverse();
  const strategies = ['momentum', 'compounder', 'catalyst'];

  for (const strategy of strategies) {
    console.log(`[Screen] Scanning ${universe.length} tickers for ${strategy}...`);
    const scored = [];
    let processed = 0;

    // Process in batches to avoid rate limiting
    for (const ticker of universe) {
      const result = await mechanicalScore(ticker, strategy);
      if (result && result.score > 20) {
        scored.push(result);
      }
      processed++;
      if (processed % 100 === 0) {
        console.log(`[Screen] ${strategy}: ${processed}/${universe.length} processed, ${scored.length} candidates so far`);
      }
    }

    // Sort by score descending, take top 50
    scored.sort((a, b) => b.score - a.score);
    const top50 = scored.slice(0, 50);

    console.log(`[Screen] ${strategy}: ${top50.length} top candidates identified`);

    // Clear today's existing candidates for this strategy
    await sb('DELETE', 'pre_screened_candidates',
      null, `?strategy_id=eq.${strategy}&trading_date=eq.${today}`);

    // Insert new candidates
    for (let i = 0; i < top50.length; i++) {
      const c = top50[i];
      await sb('POST', 'pre_screened_candidates', {
        strategy_id: strategy,
        ticker: c.ticker,
        rank: i + 1,
        screen_score: parseFloat(c.score.toFixed(2)),
        screen_reason: c.reason,
        price: c.price,
        range_position: c.rangePos ? parseFloat(c.rangePos.toFixed(1)) : null,
        rsi: c.rsi ? parseFloat(c.rsi.toFixed(1)) : null,
        trading_date: today
      });
    }

    console.log(`[Screen] ${strategy}: saved ${top50.length} candidates to Supabase`);
  }

  console.log(`[Screen] Daily scan complete for ${today}`);
}

// ── STOP/TARGET MONITOR ──
async function checkAllStops() {
  const etHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const etMin = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }));
  const etDay = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const isMarketHours = !['Sat', 'Sun'].includes(etDay) &&
    (etHour > 9 || (etHour === 9 && etMin >= 30)) && etHour < 16;

  if (!isMarketHours) return { skipped: true };

  const openPicks = await sb('GET', 'study_picks', null, '?status=eq.open&select=*');
  if (!openPicks || !openPicks.length) return { checked: 0, closed: [] };

  const results = { checked: openPicks.length, closed: [] };

  for (const pick of openPicks) {
    const quote = await getQuote(pick.ticker);
    if (!quote) continue;

    const stop = parseFloat(pick.stop_loss) || 0;
    const target = parseFloat(pick.target_price) || 0;
    const dayLow = quote.l || quote.c;
    const dayHigh = quote.h || quote.c;

    let exitPrice = null, exitReason = null;
    if (stop && dayLow <= stop) { exitPrice = stop; exitReason = 'stop_hit'; }
    else if (target && dayHigh >= target) { exitPrice = target; exitReason = 'target_hit'; }

    if (exitPrice) {
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

      results.closed.push({ ticker: pick.ticker, exitPrice, returnPct: returnPct.toFixed(2), reason: exitReason });
      console.log(`[Stops] CLOSED: ${pick.ticker} @ $${exitPrice} (${returnPct.toFixed(2)}%) — ${exitReason}`);
    }
  }

  if (results.closed.length) console.log(`[Stops] Closed ${results.closed.length} positions`);
  return results;
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
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
    return;
  }

  if (url.pathname === '/check-stops') {
    const result = await checkAllStops();
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === '/run-screen') {
    // Manual trigger for testing — also runs automatically at 8am
    runDailyScreen().catch(e => console.error('[Screen] Error:', e.message));
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'screen started', time: new Date().toISOString() }));
    return;
  }

  if (url.pathname === '/candidates') {
    const strategy = url.searchParams.get('strategy') || 'momentum';
    const today = new Date().toISOString().split('T')[0];
    const candidates = await sb('GET', 'pre_screened_candidates',
      null, `?strategy_id=eq.${strategy}&trading_date=eq.${today}&order=rank.asc&limit=50`);
    res.writeHead(200);
    res.end(JSON.stringify(candidates || []));
    return;
  }

  if (url.pathname === '/prices') {
    const tickers = (url.searchParams.get('tickers') || '').split(',').filter(Boolean);
    const results = {};
    for (const ticker of tickers.slice(0, 20)) {
      const q = await getQuote(ticker);
      if (q) results[ticker] = { c: q.c, h: q.h, l: q.l, pc: q.pc };
    }
    res.writeHead(200);
    res.end(JSON.stringify(results));
    return;
  }

  if (url.pathname === '/earnings-calendar') {
    const today = new Date().toISOString().split('T')[0];
    const end = new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];
    const r = await fetchJson(`https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${end}&token=${FHK}`);
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

// ── SCHEDULED JOBS ──
// Check stops every 5 minutes
setInterval(checkAllStops, 5 * 60 * 1000);

// Daily screen at 8:00 AM ET
function scheduleDailyScreen() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const next8am = new Date(et);
  next8am.setHours(8, 0, 0, 0);
  if (et >= next8am) next8am.setDate(next8am.getDate() + 1);
  const msUntil8am = next8am - et;
  console.log(`[Screen] Next daily scan in ${Math.round(msUntil8am / 60000)} minutes`);
  setTimeout(() => {
    runDailyScreen().catch(e => console.error('[Screen] Error:', e.message));
    setInterval(() => {
      runDailyScreen().catch(e => console.error('[Screen] Error:', e.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil8am);
}

scheduleDailyScreen();

// Run stop check once on startup after 10 seconds
setTimeout(checkAllStops, 10000);
