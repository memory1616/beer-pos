const svc = require('../src/services/OmiCallService');
const APIKEY = svc.getConfig().apiKey;
const KEY = encodeURIComponent(APIKEY);

const strategies = [
  { label: 'POST ?apiKey + body', method: 'POST', url: `https://public-v1-stg.omicall.com/api/auth?apiKey=${KEY}`, body: { apiKey: APIKEY, tenantId: '', lng: 'vi' } },
  { label: 'POST body', method: 'POST', url: 'https://public-v1-stg.omicall.com/api/auth', body: { apiKey: APIKEY, tenantId: '', lng: 'vi' } },
  { label: 'GET ?apiKey', method: 'GET', url: `https://public-v1-stg.omicall.com/api/auth?apiKey=${KEY}`, body: null },
  { label: 'GET ?apiKey (public-v1 PRODUCTION)', method: 'GET', url: `https://public-v1.omicall.com/api/auth?apiKey=${KEY}`, body: null },
  { label: 'POST ?apiKey (public-v1 PRODUCTION)', method: 'POST', url: `https://public-v1.omicall.com/api/auth?apiKey=${KEY}`, body: { apiKey: APIKEY, tenantId: '', lng: 'vi' } },
];

(async () => {
  for (const s of strategies) {
    try {
      const res = await fetch(s.url, {
        method: s.method,
        headers: { Accept: 'application/json', ...(s.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(s.body ? { body: JSON.stringify(s.body) } : {}),
      });
      const raw = await res.text();
      console.log(`\n--- ${s.label}`);
      console.log(`    http=${res.status}`);
      console.log(`    raw=${raw.slice(0, 400)}`);
    } catch (e) {
      console.log(`\n--- ${s.label}\n    FETCH_FAIL ${e.message}`);
    }
  }
})();
