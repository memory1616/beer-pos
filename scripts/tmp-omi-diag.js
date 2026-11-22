const db = require('../database');

console.log('--- 20 lan gui gan nhat:');
const rows = db.prepare(
  'SELECT id, customer_name, group_id, event_type, status, substr(COALESCE(message,\'\'),1,60) AS msg, substr(COALESCE(error,\'\'),1,160) AS err, created_at FROM debt_notifications ORDER BY id DESC LIMIT 20'
).all();
for (const r of rows) {
  console.log(
    `#${r.id} ${r.created_at} | ${r.customer_name || '-'} | grp=${r.group_id || '-'} | ${r.event_type} | ${r.status}`
  );
  console.log(`     msg: ${r.msg}`);
  if (r.err) console.log(`     ERR: ${r.err}`);
}

console.log('\n--- Thong ke status:');
console.log(JSON.stringify(db.prepare('SELECT status, COUNT(*) AS c FROM debt_notifications GROUP BY status').all()));

console.log('\n--- Cac loi khac nhau:');
console.log(JSON.stringify(db.prepare('SELECT error, COUNT(*) AS c FROM debt_notifications WHERE error IS NOT NULL AND error <> "" GROUP BY error ORDER BY c DESC LIMIT 10').all(), null, 1));

console.log('\n--- Cai dat OmiCall:');
for (const k of ['omicall_api_key', 'omicall_base_url', 'debt_notify_enabled', 'debt_notify_channel', 'debt_notify_manual_debt']) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  const v = r ? r.value : '(null)';
  console.log(`${k} = ${k === 'omicall_api_key' ? String(v).slice(0, 6) + '***' : v}`);
}

console.log('\n--- Nhom Zalo da gan (platform zalo_personal):');
console.log(JSON.stringify(db.prepare("SELECT customer_id, customer_name, group_id FROM debt_customer_groups WHERE platform = 'zalo_personal' LIMIT 20").all(), null, 1));
