const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  // Find beer-pos directory and check pm2 process
  const cmd = `pm2 jlist 2>&1 | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{const p=JSON.parse(d);p.forEach(x=>console.log(x.pm2_env.pm_cwd,x.name,JSON.stringify(x.pm2_env.env)))}catch(e){console.log(d)}" 2>&1; echo "---"; ls -la /root/beer-pos/ 2>&1`;
  conn.exec(cmd, (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += d);
    stream.on('end', () => {
      console.log(out);
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
