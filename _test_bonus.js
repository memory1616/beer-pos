const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  conn.exec('curl -s "http://localhost:3000/report/bonus-report?month=7&year=2026"', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('end', () => {
      console.log('Bonus report:', out);
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
