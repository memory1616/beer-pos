const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

// Columns cần thêm
const migrations = [
  // sales table
  { table: 'sales', col: 'created_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'sales', col: 'updated_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'sales', col: 'version', type: 'INTEGER', default: 'DEFAULT 1' },
  { table: 'sales', col: 'deleted', type: 'INTEGER', default: 'DEFAULT 0' },
  { table: 'sales', col: 'sale_time', type: 'TEXT', default: null },
  // customers table
  { table: 'customers', col: 'created_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'customers', col: 'updated_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'customers', col: 'version', type: 'INTEGER', default: 'DEFAULT 1' },
  { table: 'customers', col: 'deleted', type: 'INTEGER', default: 'DEFAULT 0' },
  { table: 'customers', col: 'monthly_expected', type: 'INTEGER', default: null },
  // products table
  { table: 'products', col: 'created_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'products', col: 'updated_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'products', col: 'version', type: 'INTEGER', default: 'DEFAULT 1' },
  { table: 'products', col: 'deleted', type: 'INTEGER', default: 'DEFAULT 0' },
  // expenses table
  { table: 'expenses', col: 'created_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'expenses', col: 'updated_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'expenses', col: 'version', type: 'INTEGER', default: 'DEFAULT 1' },
  { table: 'expenses', col: 'deleted', type: 'INTEGER', default: 'DEFAULT 0' },
  // purchases table
  { table: 'purchases', col: 'created_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'purchases', col: 'updated_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'purchases', col: 'version', type: 'INTEGER', default: 'DEFAULT 1' },
  { table: 'purchases', col: 'deleted', type: 'INTEGER', default: 'DEFAULT 0' },
  // payments table
  { table: 'payments', col: 'created_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'payments', col: 'updated_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'payments', col: 'version', type: 'INTEGER', default: 'DEFAULT 1' },
  { table: 'payments', col: 'deleted', type: 'INTEGER', default: 'DEFAULT 0' },
  // devices table
  { table: 'devices', col: 'created_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'devices', col: 'updated_at', type: 'TEXT', default: 'DEFAULT CURRENT_TIMESTAMP' },
  { table: 'devices', col: 'version', type: 'INTEGER', default: 'DEFAULT 1' },
  { table: 'devices', col: 'deleted', type: 'INTEGER', default: 'DEFAULT 0' },
];

// Tạo script SQL
let sql = '-- Fix missing columns\n';
for (const m of migrations) {
  const defaultStr = m.default ? ` ${m.default}` : '';
  sql += `-- ${m.table}.${m.col}\n`;
  sql += `ALTER TABLE ${m.table} ADD COLUMN ${m.col} ${m.type}${defaultStr};\n`;
}

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  // Check missing columns first
  const cmd = `cd ~/beer-pos && node -e "
const db = require('./database');
const tables = ['sales','customers','products','expenses','purchases','payments','devices'];
const cols = { sales:['created_at','updated_at','version','deleted','sale_time'], customers:['created_at','updated_at','version','deleted','monthly_expected'], products:['created_at','updated_at','version','deleted'], expenses:['created_at','updated_at','version','deleted'], purchases:['created_at','updated_at','version','deleted'], payments:['created_at','updated_at','version','deleted'], devices:['created_at','updated_at','version','deleted'] };
for(const t of tables) {
  const existing = db.prepare('PRAGMA table_info('+t+')').all().map(c=>c.name);
  const missing = cols[t].filter(c=>!existing.includes(c));
  if(missing.length) console.log(t+': MISSING '+missing.join(', '));
  else console.log(t+': OK');
}
"`;
  conn.exec(cmd, (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('end', () => {
      console.log(out);
      conn.end();
    });
  });
}).on('error', err => {
  console.error('SSH error:', err.message);
}).connect({
  host: SERVER,
  port: 22,
  username: USER,
  password: PASS,
  readyTimeout: 30000
});
