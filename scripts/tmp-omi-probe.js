const svc = require('../src/services/OmiCallService');

const BASE = 'https://social-network-v1-stg.omicrm.com';
const APIKEY = svc.getConfig().apiKey;

async function main() {
  // 1) Lấy token thật (copy logic từ service để thấy raw)
  const authRes = await fetch('https://public-v1-stg.omicall.com/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: APIKEY, tenantId: '', lng: 'vi' }),
  });
  const authRaw = await authRes.text();
  console.log('AUTH status:', authRes.status);
  console.log('AUTH raw:', authRaw.slice(0, 300));
  const authJson = JSON.parse(authRaw);
  const token = (authJson.payload || {}).access_token;
  console.log('TOKEN:', token ? token.slice(0, 20) + '...' : 'NONE');

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-api-key': APIKEY,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // 2) Lấy channel hiện tại
  console.log('\n=== /omnichannel/channel/get_all:');
  for (const host of [BASE, 'https://public-v1-stg.omicall.com']) {
    try {
      const res = await fetch(`${host}/omnichannel/channel/get_all`, {
        method: 'POST', headers, body: JSON.stringify({}),
      });
      const raw = await res.text();
      console.log(`--- ${host} -> ${res.status}`);
      if (!/^\s*<(!doctype|html)/i.test(raw)) console.log(raw.slice(0, 900));
      else console.log('(HTML)');
    } catch (e) { console.log(host, 'ERR', e.message); }
  }

  // 3) Tra cứu conv -> lay channel_id cua chinh conversation
  console.log('\n=== search_v4 cho conv 6afe6913fca59218a5d662ad:');
  try {
    const res = await fetch(`${BASE}/omi_v2/omnichannel/search_v4?page=1&size=100`, {
      method: 'POST', headers,
      body: JSON.stringify({
        types: [], keyword: '', is_session: false, channel_ids: [], is_blocked: false,
        sort: { field_code: 'last_message_time', is_asc: false },
      }),
    });
    const raw = await res.text();
    console.log('status', res.status);
    if (!/^\s*<(!doctype|html)/i.test(raw)) {
      const j = JSON.parse(raw);
      const p = j.payload || {};
      const convRoot = p.conversations || p;
      const items = Array.isArray(convRoot) ? convRoot : convRoot.items || [];
      console.log('items:', items.length);
      for (const it of items.slice(0, 8)) {
        const c = it.conv || {};
        console.log('id=', it.id, '| conv_id=', c.conv_id, '| name=', c.name || c.title, '| channel=', JSON.stringify(c.channel || c.channel_id || null).slice(0, 120), '| has_member=', c.has_member);
      }
    } else console.log('(HTML)');
  } catch (e) { console.log('ERR', e.message); }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
