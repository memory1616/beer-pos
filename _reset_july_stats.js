const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  // Update customer_monthly_stats July 2026 to reset reward_claimed
  conn.exec('sqlite3 /root/beer-pos/database.sqlite "UPDATE customer_monthly_stats SET reward_claimed=0, reward_claimed_at=NULL, reward_claimed_liters=0, reward_claimed_sale_id=NULL WHERE customer_id=8 AND year=2026 AND month=7;" 2>&1', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('end', () => {
      console.log('Updated stats:', out || 'OK');
      // Verify
      conn.exec('sqlite3 /root/beer-pos/database.sqlite "SELECT * FROM customer_monthly_stats WHERE customer_id=8 AND year=2026 AND month=7;" 2>&1', (err2, stream2) => {
        let out2 = '';
        stream2.on('data', d => out2 += d);
        stream2.stderr.on('data', d => out2 += d);
        stream2.on('end', () => {
          console.log('Stats July 2026 now:', out2);
          conn.end();
        });
      });
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
