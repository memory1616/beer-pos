const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  
  // Check customer 8 June stats
  const sql = "SELECT * FROM customer_monthly_stats WHERE customer_id = 8 AND year = 2026 AND month = 6;";
  const encoded = Buffer.from(sql).toString('base64');
  conn.exec('echo "' + encoded + '" | base64 -d > /tmp/q.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q.sql && rm /tmp/q.sql', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('end', () => {
      console.log('Customer 8 June 2026 stats:');
      console.log(out);
      
      // Calculate actual liters from sales
      const sql2 = "SELECT COALESCE(SUM(si.quantity), 0) as total FROM sales s JOIN sale_items si ON si.sale_id = s.id JOIN products p ON p.id = si.product_id WHERE s.customer_id = 8 AND s.type = 'sale' AND s.archived = 0 AND s.promo_type IS DISTINCT FROM 'MONTHLY_BONUS' AND si.price > 0 AND p.type = 'keg' AND strftime('%Y', datetime(s.date, '+7 hours')) = '2026' AND strftime('%m', datetime(s.date, '+7 hours')) = '06';";
      const encoded2 = Buffer.from(sql2).toString('base64');
      conn.exec('echo "' + encoded2 + '" | base64 -d > /tmp/q2.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q2.sql && rm /tmp/q2.sql', (err2, stream2) => {
        let out2 = '';
        stream2.on('data', d => out2 += d);
        stream2.on('end', () => {
          console.log('\nActual liters from sales June 2026:', out2);
          
          // Show all customer_monthly_stats
          const sql3 = "SELECT cms.*, c.name FROM customer_monthly_stats cms JOIN customers c ON c.id = cms.customer_id WHERE cms.year = 2026 AND cms.month = 6 AND cms.total_liters > 0 ORDER BY cms.total_liters DESC LIMIT 10;";
          const encoded3 = Buffer.from(sql3).toString('base64');
          conn.exec('echo "' + encoded3 + '" | base64 -d > /tmp/q3.sql && sqlite3 /root/beer-pos/database.sqlite < /tmp/q3.sql && rm /tmp/q3.sql', (err3, stream3) => {
            let out3 = '';
            stream3.on('data', d => out3 += d);
            stream3.on('end', () => {
              console.log('\nAll customers with volume June 2026:');
              console.log(out3 || 'None');
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
