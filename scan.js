// PulseStock Scanner v6 — Polygon only, clean and simple
const https = require('https');
const POLY = process.env.POLYGON_API_KEY || 'qpe_fbt2WsRl8D2YquOMzbzYlWcywazt';
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const TICKER_URL = 'https://raw.githubusercontent.com/mscharbo-commits/pulsestock-study-data/main/ticker_universe.json';

function get(url) {
  return new Promise(resolve => {
    const req = https.request(url, { headers: { 'Authorization': `Bearer ${POLY}`, 'User-Agent': 'Mozilla/5.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function sb(method, table, data, params = '') {
  return new Promise(resolve => {
    const body = data ? JSON.stringify(data) : null;
    const req = https.request(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
      method,
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    if (body) req.write(body);
    req.end();
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('[Scan] Starting with Polygon key:', POLY.substring(0,8)+'...');
  
  // Test Polygon first
  const test = await get('https://api.polygon.io/v2/aggs/ticker/AAPL/prev');
  if (!test || !test.results) {
    console.error('[Scan] FATAL: Polygon not working. Status:', JSON.stringify(test)?.substring(0,100));
    process.exit(1);
  }
  console.log('[Scan] Polygon working. AAPL prev close: $' + test.results[0].c);

  // Load universe
  const uni = await get(TICKER_URL);
  const tickers = uni?.all || [];
  console.log('[Scan] ' + tickers.length + ' tickers');

  const today = new Date().toISOString().split('T')[0];
  const yearAgo = new Date(Date.now() - 380*86400000).toISOString().split('T')[0];

  // Collect data
  const data = {};
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    await delay(130);
    const prev = await get(`https://api.polygon.io/v2/aggs/ticker/${t}/prev`);
    const r = prev?.results?.[0];
    if (!r || !r.c || !r.vw || r.c < 5) continue;
    if ((r.v * r.c) < 5e6) continue; // min $5M dollar volume

    // Get 6-month return from candle history
    await delay(130);
    const hist = await get(`https://api.polygon.io/v2/aggs/ticker/${t}/range/1/day/${yearAgo}/${today}?adjusted=true&sort=asc&limit=130`);
    const bars = hist?.results || [];
    if (bars.length < 60) continue;

    const cur = r.c;
    const vwap = r.vw;
    const high52 = Math.max(...bars.map(b => b.h));
    const low52 = Math.min(...bars.map(b => b.l));
    const rangePos = high52 > low52 ? (cur - low52) / (high52 - low52) * 100 : null;
    const pctFromHigh = high52 > 0 ? (cur - high52) / high52 * 100 : null;
    const pctAboveLow = low52 > 0 ? (cur - low52) / low52 * 100 : null;
    const vwapAbove = cur > vwap;
    const r6m = bars.length >= 126 ? (cur - bars[bars.length-126].c) / bars[bars.length-126].c * 100 : null;
    const r3m = bars.length >= 63 ? (cur - bars[bars.length-63].c) / bars[bars.length-63].c * 100 : null;

    // RSI from closes
    const closes = bars.map(b => b.c);
    let gains = 0, losses = 0;
    for (let j = closes.length - 14; j < closes.length; j++) {
      const diff = closes[j] - closes[j-1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const rsi = losses === 0 ? 100 : parseFloat((100 - 100/(1+(gains/14)/(losses/14))).toFixed(1));

    data[t] = { cur, vwap, vwapAbove, rangePos, pctFromHigh, pctAboveLow, r6m, r3m, rsi, dollarVol: r.v * cur / 1e6 };

    if ((i+1) % 100 === 0) console.log(`[Scan] ${i+1}/${tickers.length} — ${Object.keys(data).length} valid`);
  }

  console.log('[Scan] Phase 1 done: ' + Object.keys(data).length + ' valid tickers');

  // Score per strategy
  const strategies = {
    momentum: d => {
      if (!d.vwapAbove) return null;
      if (!d.rangePos || d.rangePos < 55) return null;
      if (!d.pctFromHigh || d.pctFromHigh < -25) return null;
      if (!d.rsi || d.rsi < 50 || d.rsi > 80) return null;
      if (!d.r6m || d.r6m < 5) return null;
      let s = 0;
      s += Math.min(d.rangePos * 0.3, 25);
      s += d.pctFromHigh >= -10 ? 15 : d.pctFromHigh >= -20 ? 8 : 3;
      s += (d.pctAboveLow||0) >= 30 ? 10 : 0;
      s += d.rsi >= 55 && d.rsi <= 72 ? 15 : 8;
      s += d.vwapAbove ? 15 : 0;
      s += d.r6m >= 30 ? 20 : d.r6m >= 20 ? 14 : d.r6m >= 10 ? 8 : 4;
      return s;
    },
    compounder: d => {
      if (!d.rangePos || d.rangePos < 40) return null;
      if (!d.rsi || d.rsi > 78) return null;
      let s = 0;
      s += Math.min(d.rangePos * 0.35, 30);
      s += d.rsi >= 45 && d.rsi <= 68 ? 20 : 10;
      s += d.vwapAbove ? 20 : 0;
      s += d.pctFromHigh >= -15 ? 15 : d.pctFromHigh >= -25 ? 8 : 3;
      s += (d.r6m||0) >= 15 ? 15 : (d.r6m||0) >= 5 ? 8 : 0;
      return s;
    },
    catalyst: d => {
      if (!d.vwapAbove) return null;
      if (!d.rsi || d.rsi < 35 || d.rsi > 72) return null;
      if (!d.rangePos || d.rangePos < 25 || d.rangePos > 92) return null;
      const dev = d.vwap > 0 ? (d.cur - d.vwap) / d.vwap * 100 : 5;
      let s = 0;
      s += dev <= 2 ? 30 : dev <= 5 ? 20 : 12;
      s += d.rsi >= 50 && d.rsi <= 65 ? 30 : 18;
      s += (100 - Math.abs(d.rangePos - 60)) * 0.25;
      s += (d.r6m||0) >= 10 ? 12 : (d.r6m||0) >= 0 ? 6 : 0;
      return s;
    }
  };

  for (const [strat, scoreFn] of Object.entries(strategies)) {
    const scored = [];
    for (const [ticker, d] of Object.entries(data)) {
      const raw = scoreFn(d);
      if (raw === null) continue;
      // Unique offset
      const hash = ticker.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
      const score = parseFloat(Math.min(raw + (hash%100)/1000, 100).toFixed(3));
      if (score >= 70) scored.push({ ticker, score, rsi: d.rsi, rangePos: d.rangePos, r6m: d.r6m, price: d.cur });
    }
    scored.sort((a,b) => b.score - a.score);
    const top = scored.slice(0, 100);
    const sb_cnt = top.filter(c=>c.score>=85).length;
    const buy_cnt = top.filter(c=>c.score>=80&&c.score<85).length;
    const watch_cnt = top.filter(c=>c.score>=70&&c.score<80).length;
    console.log(`[${strat}] ${scored.length} qualify → top ${top.length}: ${sb_cnt} Strong(85+) ${buy_cnt} Buy(80-84) ${watch_cnt} Watch(70-79)`);
    console.log(`[${strat}] Top 10: ${top.slice(0,10).map(c=>c.ticker+'('+c.score+')').join(', ')}`);

    await sb('DELETE', 'pre_screened_candidates', null, `?strategy_id=eq.${strat}&trading_date=eq.${today}`);
    for (let i = 0; i < top.length; i++) {
      const c = top[i];
      const tier = c.score>=85?'STRONG_BUY':c.score>=80?'BUY':'WATCH';
      await sb('POST', 'pre_screened_candidates', {
        strategy_id: strat, ticker: c.ticker, rank: i+1,
        screen_score: c.score, screen_reason: `${tier} R6m:${c.r6m?.toFixed(0)||'?'}% RSI:${c.rsi} Range:${c.rangePos?.toFixed(0)||'?'}%`,
        price: c.price, rsi: c.rsi, range_position: c.rangePos, trading_date: today
      });
    }
    console.log(`[${strat}] Saved ${top.length} candidates`);
  }

  console.log('[Scan] Complete!');
  process.exit(0);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
