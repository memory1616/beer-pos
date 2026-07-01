const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  // Test the query with the exact pattern
  const sql = "SELECT id, customer_id, note, reward_liters_used FROM sales WHERE archived = 0 AND promo_type = 'MONTHLY_BONUS' AND reward_liters_used > 0 AND (note LIKE '%tháng 6/%2026%');";
  const encoded = Buffer.from(sql).toString('base64');
  conn.exec('echo "' + encoded + '" | base64 -d > /tmp/q.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q.sql && rm /tmp/q.sql', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('end', () => {
      console.log('Matching sales:', out || '(empty)');
      
      // Also try a broader pattern
      const sql2 = "SELECT id, customer_id, note, reward_liters_used FROM sales WHERE archived = 0 AND promo_type = 'MONTHLY_BONUS' AND reward_liters_used > 0 AND note LIKE '%tháng%6%2026%';";
      const encoded2 = Buffer.from(sql2).toString('base64');
      conn.exec('echo "' + encoded2 + '" | base64 -d > /tmp/q2.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q2.sql && rm /tmp/q2.sql', (err2, stream2) => {
        let out2 = '';
        stream2.on('data', d => out2 += d);
        stream2.stderr.on('data', d => out2 += d);
        stream2.on('end', () => {
          console.log('Broader pattern:', out2 || '(empty)');
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
