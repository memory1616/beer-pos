const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  
  // Check sale 569 promo_type
  const sql = "SELECT id, customer_id, date, promo_type, reward_liters_used, note FROM sales WHERE id = 569;";
  const encoded = Buffer.from(sql).toString('base64');
  conn.exec('echo "' + encoded + '" | base64 -d > /tmp/q.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q.sql && rm /tmp/q.sql', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('end', () => {
      console.log('Sale 569:', out);
      
      // Check for MONTHLY_BONUS in July 2026
      const sql2 = "SELECT COUNT(*) as cnt FROM sales WHERE customer_id = 8 AND type = 'sale' AND archived = 0 AND promo_type = 'MONTHLY_BONUS' AND strftime('%Y', datetime(date, '+7 hours')) = '2026' AND strftime('%m', datetime(date, '+7 hours')) = '07';";
      const encoded2 = Buffer.from(sql2).toString('base64');
      conn.exec('echo "' + encoded2 + '" | base64 -d > /tmp/q2.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q2.sql && rm /tmp/q2.sql', (err2, stream2) => {
        let out2 = '';
        stream2.on('data', d => out2 += d);
        stream2.on('end', () => {
          console.log('MONTHLY_BONUS count in July:', out2);
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
