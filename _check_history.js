const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  
  // Check reward_history for customer 8
  const sql = "SELECT * FROM reward_history WHERE customer_id = 8 ORDER BY claimed_at DESC;";
  const encoded = Buffer.from(sql).toString('base64');
  conn.exec('echo "' + encoded + '" | base64 -d > /tmp/q.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q.sql && rm /tmp/q.sql', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('end', () => {
      console.log('Reward history customer 8:', out);
      
      // Check sales in July 2026
      const sql2 = "SELECT id, date, promo_type, reward_liters_used, note FROM sales WHERE customer_id = 8 AND strftime('%Y-%m', date) = '2026-07' ORDER BY id DESC;";
      const encoded2 = Buffer.from(sql2).toString('base64');
      conn.exec('echo "' + encoded2 + '" | base64 -d > /tmp/q2.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q2.sql && rm /tmp/q2.sql', (err2, stream2) => {
        let out2 = '';
        stream2.on('data', d => out2 += d);
        stream2.on('end', () => {
          console.log('\nSales July 2026:', out2);
          
          // Check customer_monthly_stats
          const sql3 = "SELECT * FROM customer_monthly_stats WHERE customer_id = 8 AND year = 2026;";
          const encoded3 = Buffer.from(sql3).toString('base64');
          conn.exec('echo "' + encoded3 + '" | base64 -d > /tmp/q3.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q3.sql && rm /tmp/q3.sql', (err3, stream3) => {
            let out3 = '';
            stream3.on('data', d => out3 += d);
            stream3.on('end', () => {
              console.log('\nCustomer 8 monthly stats:', out3);
              conn.end();
            });
          });
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
