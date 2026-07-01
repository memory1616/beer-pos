const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  
  // Check customers with June 2026 stats >= 300L (tier threshold)
  const sql = "SELECT cms.customer_id, c.name, cms.total_liters, cms.reward_claimed, cms.reward_claimed_liters FROM customer_monthly_stats cms JOIN customers c ON c.id = cms.customer_id WHERE cms.year = 2026 AND cms.month = 6 AND cms.total_liters >= 300 ORDER BY cms.total_liters DESC;";
  const encoded = Buffer.from(sql).toString('base64');
  conn.exec('echo "' + encoded + '" | base64 -d > /tmp/q.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q.sql && rm /tmp/q.sql', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('end', () => {
      console.log('Customers >= 300L in June 2026:');
      console.log('ID | Name | Total Liters | Reward Claimed | Reward Liters');
      console.log(out || 'No customers');
      console.log('\nTier thresholds: 300L = 10L reward, 500L = 20L reward');
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
