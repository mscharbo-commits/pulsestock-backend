// Quick test to see what Yahoo Finance returns from Node.js
const https = require('https');

function fetchJson(url, headers = {}) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 10000);
    const req = https.request(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/html,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timeout);
        const raw = Buffer.concat(chunks);
        try {
          // Handle gzip
          const zlib = require('zlib');
          if (res.headers['content-encoding'] === 'gzip') {
            zlib.gunzip(raw, (err, buf) => {
              if (err) resolve(null);
              else { try { resolve(JSON.parse(buf.toString())); } catch(e) { resolve(null); } }
            });
          } else {
            resolve(JSON.parse(raw.toString()));
          }
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', (e) => { clearTimeout(timeout); console.log('Error:', e.message); resolve(null); });
    req.end();
  });
}

async function test() {
  console.log('Testing Yahoo Finance v8 chart endpoint...');
  const d = await fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1d&range=5d');
  if (d) {
    console.log('v8 chart: SUCCESS');
    const meta = d?.chart?.result?.[0]?.meta;
    console.log('Price:', meta?.regularMarketPrice);
    console.log('52W High:', meta?.fiftyTwoWeekHigh);
    console.log('52W Low:', meta?.fiftyTwoWeekLow);
  } else {
    console.log('v8 chart: FAILED');
  }

  console.log('\nTesting Yahoo Finance v10 quoteSummary...');
  const d2 = await fetchJson('https://query1.finance.yahoo.com/v10/finance/quoteSummary/NVDA?modules=defaultKeyStatistics,financialData,summaryDetail');
  if (d2?.quoteSummary?.result) {
    console.log('v10 summary: SUCCESS');
    const stats = d2.quoteSummary.result[0].defaultKeyStatistics;
    const financial = d2.quoteSummary.result[0].financialData;
    console.log('Float:', stats?.floatShares?.raw);
    console.log('Short %:', stats?.shortPercentOfFloat?.raw);
    console.log('Revenue Growth:', financial?.revenueGrowth?.raw);
    console.log('Gross Margins:', financial?.grossMargins?.raw);
  } else {
    console.log('v10 summary: FAILED');
    console.log('Response:', JSON.stringify(d2)?.substring(0, 200));
  }
}

test().catch(console.error);
