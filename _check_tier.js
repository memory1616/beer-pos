const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  
  // Check reward tiers from settings
  const sql = "SELECT value FROM settings WHERE key = 'rewardTiers';";
  const encoded = Buffer.from(sql).toString('base64');
  conn.exec('echo "' + encoded + '" | base64 -d > /tmp/q.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q.sql && rm /tmp/q.sql', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('end', () => {
      console.log('Reward Tiers:');
      try {
        const tiers = JSON.parse(out);
        tiers.forEach(t => {
          console.log(`  - ${t.name}: >= ${t.threshold}L`);
        });
      } catch(e) {
        console.log(out);
      }
      
      // Check customers with June 2026 stats who have volume > 0
      const sql2 = "SELECT cms.customer_id, c.name, cms.total_liters, cms.reward_claimed FROM customer_monthly_stats cms JOIN customers c ON c.id = cms.customer_id WHERE cms.year = 2026 AND cms.month = 6 AND cms.total_liters > 0 ORDER BY cms.total_liters DESC;";
      const encoded2 = Buffer.from(sql2).toString('base64');
      conn.exec('echo "' + encoded2 + '" | base64 -d > /tmp/q2.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q2.sql && rm /tmp/q2.sql', (err2, stream2) => {
        let out2 = '';
        stream2.on('data', d => out2 += d);
        stream2.on('end', () => {
          console.log('\nCustomers with volume in June 2026:');
          console.log('ID | Name | Total Liters | Reward Claimed');
          console.log(out2);
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
