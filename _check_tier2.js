const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  
  // List all settings
  const sql = "SELECT * FROM settings;";
  const encoded = Buffer.from(sql).toString('base64');
  conn.exec('echo "' + encoded + '" | base64 -d > /tmp/q.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q.sql && rm /tmp/q.sql', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('end', () => {
      console.log('All settings:');
      console.log(out);
      
      // Check customers with June 2026 stats
      const sql2 = "SELECT cms.customer_id, c.name, cms.total_liters, cms.reward_claimed FROM customer_monthly_stats cms JOIN customers c ON c.id = cms.customer_id WHERE cms.year = 2026 AND cms.month = 6 AND cms.total_liters > 0 ORDER BY cms.total_liters DESC LIMIT 20;";
      const encoded2 = Buffer.from(sql2).toString('base64');
      conn.exec('echo "' + encoded2 + '" | base64 -d > /tmp/q2.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q2.sql && rm /tmp/q2.sql', (err2, stream2) => {
        let out2 = '';
        stream2.on('data', d => out2 += d);
        stream2.on('end', () => {
          console.log('\nCustomers with volume in June 2026:');
          console.log(out2 || 'No customers');
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
