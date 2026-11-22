const svc = require('../src/services/OmiCallService');
const APIKEY = svc.getConfig().apiKey;
const KEY = encodeURIComponent(APIKEY);
const BASE = 'https://social-network-v1-stg.omicrm.com';

(async () => {
  const res = await fetch(`https://public-v1-stg.omicall.com/api/auth?apiKey=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiKey: APIKEY, tenantId: '', lng: 'vi' }),
  });
  const token = ((await res.json()).payload || {}).access_token;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': APIKEY, Authorization: `Bearer ${token}` };

  const r = await fetch(`${BASE}/omi_v2/omnichannel/search_v4?page=1&size=100`, {
    method: 'POST', headers,
    body: JSON.stringify({ types: [], keyword: 'Bia Tươi Gia Huy', is_session: false, channel_ids: [], is_blocked: false, sort: { field_code: 'last_message_time', is_asc: false } }),
  });
  const p = (JSON.parse(await r.text()).payload) || {};
  const root = p.conversations || p;
  const items = Array.isArray(root) ? root : root.items || [];
  for (const it of items.slice(0, 6)) {
    const c = it.conv || {};
    console.log(`id=${it.id} | conv_id=${c.conv_id} | name=${c.name} | has_member=${c.has_member}`);
  }
})();
