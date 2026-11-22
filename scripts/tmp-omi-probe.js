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
  'TEST ...d662b0': '6afe6913fca59218a5d662b0',
  'FAIL ...d662ad': '6afe6913fca59218a5d662ad',
};

(async () => {
  const token = await getToken();
  const headers = {
    'Content-Type': 'application/json', Accept: 'application/json',
    'x-api-key': APIKEY, Authorization: `Bearer ${token}`,
  };

  const found = {};
  for (const [label, id] of Object.entries(TARGETS)) {
    for (const dir of [false, true]) {
      for (let page = 1; page <= 5 && !found[label]; page++) {
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
        if (hit) found[label] = hit;
      }
    }
  }

  for (const [label, it] of Object.entries(found)) {
    const c = it.conv || {};
    console.log(`\n=== ${label}`);
    console.log('  conv_type      =', JSON.stringify(c.conv_type));
    console.log('  conv_sub_type  =', JSON.stringify(c.conv_sub_type));
    console.log('  provider       =', JSON.stringify(c.provider));
    console.log('  status         =', JSON.stringify(c.status));
    console.log('  is_blocked     =', c.is_blocked);
    console.log('  is_deleted     =', c.is_deleted);
    console.log('  receiving_group_id =', JSON.stringify(c.receiving_group_id));
    console.log('  distributing_group_id =', JSON.stringify(c.distributing_group_id));
    console.log('  social_user_id =', JSON.stringify(c.social_user_id));
    console.log('  chat_x_id      =', JSON.stringify(c.chat_x_id));
    console.log('  total_message_size =', c.total_message_size);
    console.log('  last_message   =', JSON.stringify(c.last_message).slice(0, 300));
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
