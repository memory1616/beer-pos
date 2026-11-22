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

(async () => {
  const token = await getToken();
  console.log('TOKEN OK:', token ? 'yes' : 'no');

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-api-key': APIKEY,
    Authorization: `Bearer ${token}`,
  };

  // 1) channel get_all
  console.log('\n=== channel/get_all:');
  let channelId = '';
  try {
    const res = await fetch(`${BASE}/omnichannel/channel/get_all`, { method: 'POST', headers, body: JSON.stringify({}) });
    const raw = await res.text();
    console.log('http=', res.status);
    if (!/^\s*<(!doctype|html)/i.test(raw)) {
      const j = JSON.parse(raw);
      const p = j.payload || {};
      console.log('keys:', Object.keys(p));
      const zp = p.zalo_personal || [];
      console.log('zalo_personal count:', Array.isArray(zp) ? zp.length : 'n/a');
      for (const ch of (zp || []).slice(0, 5)) {
        console.log('  uid=', ch.uid, '| name=', ch.name || ch.channel_name, '| status=', ch.status, '| connected=', ch.connected);
      }
      if (zp && zp[0]) channelId = String(zp[0].uid || zp[0].channel_id || zp[0]._id || '');
    } else console.log('(HTML)');
  } catch (e) { console.log('ERR', e.message); }
  console.log('channelId =', channelId);

  // 2) search_v4 -> lay conv + channel cua conv
  console.log('\n=== search_v4 (desc):');
  try {
    const res = await fetch(`${BASE}/omi_v2/omnichannel/search_v4?page=1&size=50`, {
      method: 'POST', headers,
      body: JSON.stringify({ types: [], keyword: '', is_session: false, channel_ids: [], is_blocked: false, sort: { field_code: 'last_message_time', is_asc: false } }),
    });
    const raw = await res.text();
    console.log('http=', res.status);
    if (!/^\s*<(!doctype|html)/i.test(raw)) {
      const j = JSON.parse(raw);
      const p = j.payload || {};
      const root = p.conversations || p;
      const items = Array.isArray(root) ? root : root.items || [];
      console.log('items:', items.length);
      for (const it of items.slice(0, 10)) {
        const c = it.conv || {};
        console.log('  id=', it.id, '| conv_id=', c.conv_id, '| name=', (c.name || '').slice(0, 30), '| channel_id=', c.channel_id || JSON.stringify(c.channel).slice(0, 80), '| has_member=', c.has_member, '| members=', (c.members || []).length);
      }
    } else console.log('(HTML)');
  } catch (e) { console.log('ERR', e.message); }

  // 3) GUI TIN THU - voi group da biet la OK (6afe6913fca59218a5d662ad)
  console.log('\n=== GUI TIN THU (group 6afe6913fca59218a5d662ad):');
  const conv = '6afe6913fca59218a5d662ad';
  const bodies = [
    { label: 'conv_id+channel_id+text', body: { conv_id: conv, channel_id: channelId, text: '[TEST] gui lai OmiCall' } },
    { label: 'conv_id+text', body: { conv_id: conv, text: '[TEST] gui lai OmiCall' } },
  ];
  for (const bv of bodies) {
    try {
      const res = await fetch(`${BASE}/omni_conv/message/send_text?lng=vi`, {
        method: 'POST', headers, body: JSON.stringify(bv.body),
      });
      const raw = await res.text();
      console.log(`--- ${bv.label}: http=${res.status}`);
      console.log(`    ${raw.slice(0, 500)}`);
    } catch (e) { console.log(`--- ${bv.label}: ERR ${e.message}`); }
  }
})();
