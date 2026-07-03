// PulseStock Universe Scanner — runs as Railway cron job
// Scans all tickers for each strategy, saves top 50 to Supabase
// Run independently from the main server to avoid memory issues

const https = require('https');
const http = require('http');

const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const FHK = 'd8fhh6hr01qn443a0bngd8fhh6hr01qn443a0bo0';
const TICKER_URL = 'https://raw.githubusercontent.com/mscharbo-commits/pulsestock-study-data/main/ticker_universe.json';

function fetchJson(url, opts = {}) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 8000);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { clearTimeout(timeout); try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(null); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function sb(method, table, data, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  return fetchJson(url, { method, headers, body: data ? JSON.stringify(data) : undefined });
}

async function getQuote(ticker) {
  await new Promise(r => setTimeout(r, 200));
  return fetchJson(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FHK}`);
}

async function getMetric(ticker) {
  await new Promise(r => setTimeout(r, 200));
  const d = await fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FHK}`);
  return d && d.metric ? d.metric : null;
}

function scoreForStrategy(quote, metric, strategy) {
  if (!quote || !quote.c || quote.c < 5) return null;
  const price = quote.c;
  const prevClose = quote.pc || price;
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
    if (rangePos < 45 || (rsi && (rsi < 40 || rsi > 80))) return null;
    score = rangePos * 0.4;
    if (rsi && rsi >= 50 && rsi <= 72) score += 25;
    if (vwapAbove) score += 20;
    if (beta && beta > 0.8 && beta < 2.0) score += 15;
  } else if (strategy === 'compounder') {
    if (rangePos < 35 || (rsi && rsi > 76)) return null;
    score = rangePos * 0.35;
    if (rsi && rsi >= 40 && rsi <= 68) score += 30;
    if (vwapAbove) score += 20;
    if (beta && beta < 1.2) score += 15;
  } else if (strategy === 'catalyst') {
    if (!vwapAbove || rangePos < 30 || rangePos > 92 || (rsi && (rsi < 35 || rsi > 72))) return null;
    score = 35;
    if (rsi && rsi >= 42 && rsi <= 68) score += 35;
    score += (100 - Math.abs(rangePos - 60)) * 0.3;
  }

  if (score < 20) return null;
  return {
    score: parseFloat(score.toFixed(2)), price,
    rangePos: parseFloat(rangePos.toFixed(1)),
    rsi: rsi ? parseFloat(rsi.toFixed(1)) : null,
    reason: `Range:${rangePos.toFixed(0)}% RSI:${rsi?.toFixed(0)||'?'} VWAP:${vwapAbove?'above':'below'}`
  };
}

async function main() {
  console.log('[Scan] Starting universe scan...');
  const universe = await fetchJson(TICKER_URL);
  const tickers = universe && universe.all ? universe.all : [];
  console.log(`[Scan] ${tickers.length} tickers to scan`);

  const today = new Date().toISOString().split('T')[0];
  const strategies = ['momentum', 'compounder', 'catalyst'];
  const allScored = { momentum: [], compounder: [], catalyst: [] };

  // Process sequentially one ticker at a time — memory efficient
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];

    // Fetch both quote and metric for this ticker
    const quote = await getQuote(ticker);
    if (!quote || !quote.c || quote.c < 5) continue; // skip invalid/penny stocks

    const metric = await getMetric(ticker);

    // Score for all 3 strategies in one pass
    for (const strategy of strategies) {
      const result = scoreForStrategy(quote, metric, strategy);
      if (result) allScored[strategy].push({ ticker, ...result });
    }

    if (i % 100 === 0) {
      const counts = strategies.map(s => `${s}:${allScored[s].length}`).join(' ');
      console.log(`[Scan] ${i}/${tickers.length} — ${counts}`);
    }
  }

  // Save top 50 per strategy
  for (const strategy of strategies) {
    const sorted = allScored[strategy].sort((a, b) => b.score - a.score).slice(0, 50);
    console.log(`[Scan] ${strategy}: ${sorted.length} candidates`);

    await sb('DELETE', 'pre_screened_candidates', null, `?strategy_id=eq.${strategy}&trading_date=eq.${today}`);

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      await sb('POST', 'pre_screened_candidates', {
        strategy_id: strategy, ticker: c.ticker, rank: i + 1,
        screen_score: c.score, screen_reason: c.reason,
        price: c.price, range_position: c.rangePos, rsi: c.rsi,
        trading_date: today
      });
    }
    console.log(`[Scan] ${strategy}: saved ${sorted.length} to Supabase`);
  }

  console.log('[Scan] Complete!');
  process.exit(0);
}

main().catch(e => { console.error('[Scan] Fatal:', e.message); process.exit(1); });
