const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  conn.exec('sqlite3 /root/beer-pos/database.sqlite "SELECT * FROM reward_history WHERE customer_id=8;" 2>&1', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('end', () => {
      console.log('reward_history:', out || '(empty)');
      conn.exec('sqlite3 /root/beer-pos/database.sqlite "SELECT * FROM promotions WHERE customer_id=8;" 2>&1', (err2, stream2) => {
        let out2 = '';
        stream2.on('data', d => out2 += d);
        stream2.stderr.on('data', d => out2 += d);
        stream2.on('end', () => {
          console.log('promotions:', out2 || '(empty)');
          conn.exec('sqlite3 /root/beer-pos/database.sqlite "SELECT id,date,promo_type,promo_free_liters FROM sales WHERE customer_id=8 AND archived=0 ORDER BY id DESC LIMIT 5;" 2>&1', (err3, stream3) => {
            let out3 = '';
            stream3.on('data', d => out3 += d);
            stream3.stderr.on('data', d => out3 += d);
            stream3.on('end', () => {
              console.log('recent sales:', out3);
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
