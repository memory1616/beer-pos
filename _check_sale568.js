const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  conn.exec('sqlite3 /root/beer-pos/database.sqlite "SELECT * FROM sale_items WHERE sale_id=568;" 2>&1', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('end', () => {
      console.log('sale_items 568:', out || '(empty)');
      conn.exec('sqlite3 /root/beer-pos/database.sqlite "SELECT * FROM sales WHERE id=568;" 2>&1', (err2, stream2) => {
        let out2 = '';
        stream2.on('data', d => out2 += d);
        stream2.stderr.on('data', d => out2 += d);
        stream2.on('end', () => {
          console.log('sale 568:', out2);
          conn.exec('sqlite3 /root/beer-pos/database.sqlite ".schema sale_items" 2>&1', (err3, stream3) => {
            let out3 = '';
            stream3.on('data', d => out3 += d);
            stream3.stderr.on('data', d => out3 += d);
            stream3.on('end', () => {
              console.log('sale_items schema:', out3);
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
