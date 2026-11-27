const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'database.sqlite');
const db = new Database(dbPath, { readonly: true });

console.log('=== debt_notification_jobs columns ===');
console.log(db.prepare("PRAGMA table_info(debt_notification_jobs)").all().map((c) => c.name + ' ' + c.type + (c.notnull ? ' NOT NULL' : '') + (c.pk ? ' PK' : '')).join('\n'));

console.log('\n=== indexes ===');
console.log(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='debt_notification_jobs'").all().map((i) => i.name).join('\n'));

console.log('\n=== unique constraints ===');
console.log(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='debt_notification_jobs' AND sql LIKE '%UNIQUE%'").all().map((i) => i.sql).join('\n'));

console.log('\n=== debt_customer_groups indexes ===');
console.log(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='debt_customer_groups'").all().map((i) => (i.sql || i.name)).join('\n'));

console.log('\n=== migration 069 applied? ===');
const tbls = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%migration%' OR name LIKE '%schema%'").all();
console.log('migration-ish tables:', JSON.stringify(tbls));
const migs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='debt_notification_jobs'").all();
console.log('debt_notification_jobs exists:', migs.length === 1);

console.log('\n=== row counts ===');
console.log('debt_notification_jobs:', db.prepare('SELECT COUNT(*) c FROM debt_notification_jobs').get().c);
console.log('debt_customer_groups:', db.prepare('SELECT COUNT(*) c FROM debt_customer_groups').get().c);
console.log('debt_notifications:', db.prepare('SELECT COUNT(*) c FROM debt_notifications').get().c);

console.log('\n=== duplicate check (1:1 constraint) ===');
const dupC = db.prepare('SELECT customer_id, COUNT(*) c FROM debt_customer_groups GROUP BY customer_id HAVING c > 1').all();
const dupG = db.prepare('SELECT group_id, COUNT(*) c FROM debt_customer_groups GROUP BY group_id HAVING c > 1').all();
console.log('duplicate customer_id:', JSON.stringify(dupC));
console.log('duplicate group_id:', JSON.stringify(dupG));

console.log('\n=== existing group mappings ===');
console.log(JSON.stringify(db.prepare('SELECT id, customer_id, group_id, group_name, status FROM debt_customer_groups LIMIT 20').all(), null, 2));

db.close();
