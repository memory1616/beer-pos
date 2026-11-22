const svc = require('../src/services/OmiCallService');
const APIKEY = svc.getConfig().apiKey;
const KEY = encodeURIComponent(APIKEY);
const BASE = 'https://social-network-v1-stg.omicrm.com';

async function getToken() {
  const res = await fetch(`https://public-v1-stg.omicall.com/api/auth?apiKey=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiKey: APIKEY, tenantId: '', lng: 'vi' }),
  });
  const j = await res.json();
  return (j.payload || {}).access_token;
}

const TARGETS = {
  'TEST  ...d662b0': '6afe6913fca59218a5d662b0',
  'FAIL  ...d662ad': '6afe6913fca59218a5d662ad',
};

(async () => {
  const token = await getToken();
  const headers = {
    'Content-Type': 'application/json', Accept: 'application/json',
    'x-api-key': APIKEY, Authorization: `Bearer ${token}`,
  };

  console.log('=== channel/get_all (chi doc):');
  const chRes = await fetch(`${BASE}/omnichannel/channel/get_all`, { method: 'POST', headers, body: '{}' });
  const chJson = await chRes.json();
  const zp = (chJson.payload || {}).zalo_personal || [];
  console.log('zalo_personal:', JSON.stringify(zp, null, 1).slice(0, 1200));

  console.log('\n=== search_v4: tim conv cua 2 nhom tren (chi doc):');
  for (const [label, id] of Object.entries(TARGETS)) {
    let found = null;
    for (const dir of [false, true]) {
      for (let page = 1; page <= 5 && !found; page++) {
        const res = await fetch(`${BASE}/omi_v2/omnichannel/search_v4?page=${page}&size=100`, {
          method: 'POST', headers,
          body: JSON.stringify({ types: [], keyword: '', is_session: false, channel_ids: [], is_blocked: false, sort: { field_code: 'last_message_time', is_asc: dir } }),
        });
        const raw = await res.text();
        if (/^\s*<(!doctype|html)/i.test(raw)) break;
        const p = (JSON.parse(raw).payload) || {};
        const root = p.conversations || p;
        const items = Array.isArray(root) ? root : root.items || [];
        if (!items.length) break;
        const hit = items.find((it) => String(it.id || '') === id);
        if (hit) { found = hit; break; }
      }
    }
    if (!found) { console.log(`\n--- ${label} (${id}): KHONG TIM THAY trong search_v4`); continue; }
    const c = found.conv || {};
    console.log(`\n--- ${label} (${id}):`);
    console.log('    conv_id=', c.conv_id, '| name=', c.name);
    console.log('    channel_id=', c.channel_id);
    console.log('    has_member=', c.has_member, '| members=', JSON.stringify(c.members || []).slice(0, 300));
    console.log('    conv keys=', Object.keys(c).join(','));
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
