const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  const cmd = `sqlite3 /root/beer-pos/database.sqlite "
ALTER TABLE sales ADD COLUMN sale_time TEXT;
ALTER TABLE sales ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE sales ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE sales ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE sales ADD COLUMN deleted INTEGER DEFAULT 0;
ALTER TABLE customers ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE customers ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE customers ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE customers ADD COLUMN deleted INTEGER DEFAULT 0;
ALTER TABLE customers ADD COLUMN monthly_expected INTEGER;
ALTER TABLE products ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE products ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE products ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE products ADD COLUMN deleted INTEGER DEFAULT 0;
ALTER TABLE expenses ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE expenses ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE expenses ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE expenses ADD COLUMN deleted INTEGER DEFAULT 0;
ALTER TABLE purchases ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE purchases ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE purchases ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE purchases ADD COLUMN deleted INTEGER DEFAULT 0;
ALTER TABLE payments ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE payments ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE payments ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE payments ADD COLUMN deleted INTEGER DEFAULT 0;
ALTER TABLE devices ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE devices ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE devices ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE devices ADD COLUMN deleted INTEGER DEFAULT 0;
" 2>&1; echo "EXIT:$?"`;
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
