const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  
  // Reset reward_claimed for customer 8 month 6
  const sql = "UPDATE customer_monthly_stats SET reward_claimed = 0, reward_claimed_at = NULL, reward_claimed_liters = 0, reward_claimed_sale_id = NULL WHERE customer_id = 8 AND year = 2026 AND month = 6;";
  const encoded = Buffer.from(sql).toString('base64');
  conn.exec('echo "' + encoded + '" | base64 -d > /tmp/q.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q.sql && rm /tmp/q.sql', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('end', () => {
      console.log('Reset reward_claimed for customer 8, month 6:', out || 'OK');
      
      // Also clear reward_history
      const sql2 = "DELETE FROM reward_history WHERE customer_id = 8;";
      const encoded2 = Buffer.from(sql2).toString('base64');
      conn.exec('echo "' + encoded2 + '" | base64 -d > /tmp/q2.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q2.sql && rm /tmp/q2.sql', (err2, stream2) => {
        let out2 = '';
        stream2.on('data', d => out2 += d);
        stream2.on('end', () => {
          console.log('Clear reward_history:', out2 || 'OK');
          
          // Verify
          const sql3 = "SELECT reward_claimed FROM customer_monthly_stats WHERE customer_id = 8 AND year = 2026 AND month = 6;";
          const encoded3 = Buffer.from(sql3).toString('base64');
          conn.exec('echo "' + encoded3 + '" | base64 -d > /tmp/q3.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q3.sql && rm /tmp/q3.sql', (err3, stream3) => {
            let out3 = '';
            stream3.on('data', d => out3 += d);
            stream3.on('end', () => {
              console.log('Verify reward_claimed:', out3);
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
