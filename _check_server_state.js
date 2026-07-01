const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  const cmd = `sqlite3 /root/beer-pos/database.sqlite "SELECT * FROM promotion_settings WHERE id=1;" 2>&1; echo "---"; sqlite3 /root/beer-pos/database.sqlite "SELECT id,promotion_enabled,reward_enabled,reward_tier,reward_claimed FROM customers WHERE id=8;" 2>&1; echo "---"; sqlite3 /root/beer-pos/database.sqlite "SELECT * FROM pending_rewards WHERE customer_id=8;" 2>&1; echo "---"; sqlite3 /root/beer-pos/database.sqlite "SELECT * FROM customer_monthly_stats WHERE customer_id=8 AND year=2026 AND month=6;" 2>&1`;
  conn.exec(cmd, (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('end', () => { console.log(out); conn.end(); });
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
