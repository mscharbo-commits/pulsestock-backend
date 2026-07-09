const https = require('https');

const KEY = process.env.POLYGON_API_KEY || '2c90554e-b7d3-485f-a497-b350eb8136f5';

function fetchJson(url) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      headers: { 'Authorization': `Bearer ${KEY}`, 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log('Status:', res.statusCode);
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    });
    req.on('error', e => { console.log('Error:', e.message); resolve(null); });
    req.end();
  });
}

async function test() {
  console.log('Testing Polygon key:', KEY.substring(0,8)+'...');
  const d = await fetchJson('https://api.polygon.io/v2/aggs/ticker/AAPL/prev');
  console.log('Result:', JSON.stringify(d)?.substring(0,200));
}

test();
