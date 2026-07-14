// morning-routine.js — Railway cron job
// Runs every weekday at 8am ET (13:00 UTC)
// 1. Scans full universe for all 3 strategies
// 2. Auto-generates picks for each strategy
// 3. Saves picks to Supabase

const https = require('https');

const STUDY_URL = 'https://pulsestock-study.vercel.app';
const ANT_KEY = process.env.ANT_KEY || process.env.ANTHROPIC_API_KEY;
const POLY_KEY = process.env.POLYGON_API_KEY || 'qpe_fbt2WsRl8D2YquOMzbzYlWcywazt';
const FINNHUB = process.env.FINNHUB_KEY || 'd95c889r01qihq3l33k0d95c889r01qihq3l33kg';
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const TICKER_URL = 'https://raw.githubusercontent.com/mscharbo-commits/pulsestock-study-data/main/ticker_universe.json';

function fetch(url, opts = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.request(url, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runMorningScan() {
  console.log('[Morning] Starting morning routine:', new Date().toISOString());
  const today = new Date().toISOString().split('T')[0];
  
  // Step 1: Get universe
  const uni = await fetch(TICKER_URL);
  const tickers = uni?.all || [];
  console.log(`[Morning] Universe: ${tickers.length} tickers`);

  // Step 2: Get earnings calendar for catalyst boost
  const future14 = new Date(Date.now() + 14*86400000).toISOString().split('T')[0];
  const cal = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${future14}&token=${FINNHUB}`);
  const earningsTickers = (cal?.earningsCalendar || []).map(e => e.symbol).filter(Boolean).join(',');
  console.log(`[Morning] Earnings calendar: ${earningsTickers.split(',').length} companies`);

  // Step 3: Scan in batches of 15
  const results = { momentum: [], compounder: [], catalyst: [] };
  const BATCH = 15;
  let processed = 0;

  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH).join(',');
    let url = `${STUDY_URL}/api/scan?batch=${batch}&date=${today}`;
    if (earningsTickers) url += `&earningsTickers=${encodeURIComponent(earningsTickers.substring(0, 2000))}`;
    
    const data = await fetch(url);
    if (data) {
      ['momentum', 'compounder', 'catalyst'].forEach(s => {
        if (data[s]) results[s] = results[s].concat(data[s]);
      });
    }
    processed += BATCH;
    if (processed % 300 === 0) console.log(`[Morning] Scanned ${processed}/${tickers.length}`);
    await delay(100);
  }

  // Step 4: Deduplicate and save top 100 per strategy
  for (const strat of ['momentum', 'compounder', 'catalyst']) {
    const seen = {};
    const deduped = results[strat]
      .sort((a, b) => b.score - a.score)
      .filter(c => { if (seen[c.ticker]) return false; seen[c.ticker] = true; return true; })
      .slice(0, 100);

    console.log(`[Morning] ${strat}: ${deduped.length} candidates`);

    // Clear old
    await fetch(`${SUPABASE_URL}/rest/v1/pre_screened_candidates?strategy_id=eq.${strat}&trading_date=eq.${today}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });

    // Save new
    for (let i = 0; i < deduped.length; i++) {
      const c = deduped[i];
      await fetch(`${SUPABASE_URL}/rest/v1/pre_screened_candidates`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ strategy_id: strat, ticker: c.ticker, rank: i+1, screen_score: c.score, screen_reason: (c.score>=85?'STRONG_BUY':c.score>=80?'BUY':'WATCH')+' RSI:'+c.rsi+' Range:'+c.rangePos+'%', price: c.price, rsi: c.rsi, range_position: c.rangePos, trading_date: today })
      });
    }
    console.log(`[Morning] Saved ${deduped.length} ${strat} candidates`);
  }

  // Step 5: Auto-generate picks for each strategy
  console.log('[Morning] Starting auto-pick generation...');
  await autoGeneratePicks(today);
  console.log('[Morning] Morning routine complete!');
}

async function autoGeneratePicks(today) {
  const strategies = ['momentum', 'compounder', 'catalyst'];
  
  for (const strat of strategies) {
    console.log(`[Morning] Auto-generating picks for ${strat}...`);
    
    // Get candidates
    const candidates = await fetch(`${SUPABASE_URL}/rest/v1/pre_screened_candidates?strategy_id=eq.${strat}&trading_date=eq.${today}&order=rank.asc&limit=100`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (!candidates?.length) { console.log(`[Morning] No candidates for ${strat}`); continue; }

    // Get current gen and rules
    const genData = await fetch(`${SUPABASE_URL}/rest/v1/generations?strategy_id=eq.${strat}&order=gen_number.desc&limit=1`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const gen = genData?.[0]?.gen_number || 1;

    const rulesData = await fetch(`${SUPABASE_URL}/rest/v1/rules?strategy_id=eq.${strat}&is_active=eq.true&order=created_at.desc&limit=20`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const rules = (rulesData || []).map(r => r.rule_text).join(' | ');

    // Get held positions
    const heldData = await fetch(`${SUPABASE_URL}/rest/v1/study_picks?strategy_id=eq.${strat}&status=eq.open&select=ticker`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const held = (heldData || []).map(p => p.ticker);

    // Get declined this gen
    const declinedData = await fetch(`${SUPABASE_URL}/rest/v1/declined_tickers?strategy_id=eq.${strat}&gen_number=eq.${gen}&select=ticker`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const declined = (declinedData || []).map(d => d.ticker);

    // Get macro context
    const macro = await getMacroContext();

    let published = 0;
    const TARGET = 5; // generate up to 5 picks per strategy per morning

    for (const candidate of candidates) {
      if (published >= TARGET) break;
      const ticker = candidate.ticker;
      if (held.includes(ticker) || declined.includes(ticker)) continue;

      // Get news
      const weekAgo = new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
      const news = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${weekAgo}&to=${today}&token=${FINNHUB}`);
      const headlines = Array.isArray(news) ? news.slice(0,3).map(n=>n.headline).join(' | ') : 'No recent news';

      // Get quote
      const quote = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB}`);
      const price = quote?.c || candidate.price;

      // Deep dive with Sonnet + web search
      const prompt = buildPrompt(ticker, strat, price, candidate, headlines, rules, held, macro);
      const pick = await deepDive(ticker, strat, prompt);
      
      if (!pick) { console.log(`[Morning] ${ticker}: deep dive failed`); continue; }

      if (pick.declined || pick.confidence < 80) {
        console.log(`[Morning] ${ticker}: declined (${pick.confidence}%)`);
        // Save to declined
        await fetch(`${SUPABASE_URL}/rest/v1/declined_tickers`, {
          method: 'POST',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ strategy_id: strat, ticker, gen_number: gen, date: today })
        });
        continue;
      }

      // Save pick
      const pickRecord = {
        id: `${ticker}_${gen}_${Date.now()}`,
        ticker, strategy_id: strat, gen_number: gen,
        status: 'open', action: 'BUY',
        entry_price: price,
        target_price: pick.target_price || price * 1.08,
        stop_loss: pick.stop_loss || price * 0.965,
        confidence: pick.confidence,
        reasoning: pick.reasoning || '',
        key_risk: pick.key_risk || '',
        sector: pick.sector || '',
        timeframe: pick.timeframe || '',
        date: new Date().toISOString(),
        regime_context: macro.substring(0, 100)
      };

      const saved = await fetch(`${SUPABASE_URL}/rest/v1/study_picks`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify(pickRecord)
      });

      if (saved) {
        published++;
        console.log(`[Morning] ✓ ${ticker} @ $${price} — ${pick.confidence}% conf — SAVED`);
      }

      await delay(2000); // respect rate limits
    }

    console.log(`[Morning] ${strat}: ${published} picks published`);
    await delay(3000);
  }
}

async function getMacroContext() {
  const symbols = ['SPY', 'QQQ', 'VIX', 'XLK', 'XLF', 'XLE', 'XLV'];
  const quotes = await Promise.all(symbols.map(s => 
    fetch(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${FINNHUB}`)
  ));
  const spy = quotes[0], qqq = quotes[1], vix = quotes[2];
  const pct = q => q && q.pc > 0 ? ((q.c - q.pc)/q.pc*100).toFixed(2) : '0';
  const regime = parseFloat(pct(spy)) > 0.3 ? 'BULL' : parseFloat(pct(spy)) < -0.3 ? 'BEAR' : 'NEUTRAL';
  return `Market: SPY${pct(spy)}% (${regime}), QQQ${pct(qqq)}%, VIX=${vix?.c?.toFixed(1)||'?'}. Use web_search for current news and global macro context.`;
}

function buildPrompt(ticker, strat, price, candidate, headlines, rules, held, macro) {
  const stratConfig = {
    momentum: 'Momentum Growth — 10-60 day hold, 80% confidence gate. Look for: strong uptrend, institutional momentum, catalyst or breakout, sector leadership.',
    compounder: 'Quality Compounder — 90+ day hold, 80% confidence gate. Look for: durable moat, high ROE, expanding margins, reasonable valuation, consistent revenue growth.',
    catalyst: 'Catalyst Swing — 3-10 day hold, 80% confidence gate. Must have: confirmed earnings or catalyst within 14 days, above VWAP, RSI room to run.'
  };

  return `${macro}

Strategy: ${stratConfig[strat]}
${rules ? 'Learned rules: ' + rules : ''}
Already held (DO NOT pick): ${held.join(',')}

Analyze ${ticker} for ${strat} strategy.
Current price: $${price}
Scan data: RSI=${candidate.rsi}, Range Position=${candidate.rangePos}%, 6m Return=${candidate.r6m}%
Recent news: ${headlines}

Use web_search to find current fundamentals, analyst ratings, earnings dates, and any material news.

Return JSON only:
{"ticker":"${ticker}","action":"BUY","entry_price":${price},"target_price":0,"stop_loss":0,"sector":"","timeframe":"","confidence":0,"declined":false,"decline_reason":null,"reasoning":"100-150 words","key_risk":"1-2 sentences"}`;
}

async function deepDive(ticker, strat, prompt) {
  const systemPrompts = {
    momentum: 'You are a momentum growth stock analyst. Use web_search to get current data. Be decisive. Return valid JSON only.',
    compounder: 'You are a quality compounder analyst focused on durable businesses. Use web_search to get current fundamentals. Return valid JSON only.',
    catalyst: 'You are a catalyst swing trader. Use web_search to verify earnings dates and catalysts. Return valid JSON only.'
  };

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: systemPrompts[strat],
    messages: [{ role: 'user', content: prompt }],
    use_search: true
  });

  const response = await fetch(`${STUDY_URL}/api/claude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });

  if (!response) return null;
  const text = response.content?.find?.(b => b.type === 'text')?.text || '';
  try {
    const start = text.indexOf('{'); const end = text.lastIndexOf('}');
    return JSON.parse(text.substring(start, end + 1));
  } catch(e) { return null; }
}

// Schedule: run at 8am ET (13:00 UTC) on weekdays
function shouldRunNow() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  return day >= 1 && day <= 5 && utcHour === 13 && utcMin < 5;
}

// Check every minute
setInterval(async () => {
  if (shouldRunNow()) {
    console.log('[Morning] Triggering morning routine...');
    runMorningScan().catch(e => console.error('[Morning] Error:', e.message));
  }
}, 60 * 1000);

console.log('[Morning] Morning routine scheduler active — runs weekdays at 8am ET');
module.exports = { runMorningScan };
