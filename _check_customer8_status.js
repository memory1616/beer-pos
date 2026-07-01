const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  
  // Check customer 8 stats
  const sql = "SELECT * FROM customer_monthly_stats WHERE customer_id = 8 AND year = 2026 AND month = 6;";
  const encoded = Buffer.from(sql).toString('base64');
  conn.exec('echo "' + encoded + '" | base64 -d > /tmp/q.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q.sql && rm /tmp/q.sql', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('end', () => {
      console.log('Customer 8 June stats:', out);
      
      // Check pending rewards
      const sql2 = "SELECT * FROM pending_rewards WHERE customer_id = 8;";
      const encoded2 = Buffer.from(sql2).toString('base64');
      conn.exec('echo "' + encoded2 + '" | base64 -d > /tmp/q2.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q2.sql && rm /tmp/q2.sql', (err2, stream2) => {
        let out2 = '';
        stream2.on('data', d => out2 += d);
        stream2.on('end', () => {
          console.log('Pending rewards:', out2 || '(empty)');
          
          // Check reward_history
          const sql3 = "SELECT * FROM reward_history WHERE customer_id = 8 ORDER BY claimed_at DESC LIMIT 5;";
          const encoded3 = Buffer.from(sql3).toString('base64');
          conn.exec('echo "' + encoded3 + '" | base64 -d > /tmp/q3.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q3.sql && rm /tmp/q3.sql', (err3, stream3) => {
            let out3 = '';
            stream3.on('data', d => out3 += d);
            stream3.on('end', () => {
              console.log('Reward history:', out3 || '(empty)');
              
              // Check recent sales for customer 8
              const sql4 = "SELECT id, date, total, promo_type, reward_liters_used, note FROM sales WHERE customer_id = 8 AND date >= '2026-07-01' ORDER BY id DESC LIMIT 5;";
              const encoded4 = Buffer.from(sql4).toString('base64');
              conn.exec('echo "' + encoded4 + '" | base64 -d > /tmp/q4.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q4.sql && rm /tmp/q4.sql', (err4, stream4) => {
                let out4 = '';
                stream4.on('data', d => out4 += d);
                stream4.on('end', () => {
                  console.log('Recent sales July:', out4 || '(no sales)');
                  conn.end();
                });
              });
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
