const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  const cmd = `
    cd ~/beer-pos && \
    echo "=== Database file info ===" && \
    ls -la beer.db && \
    file beer.db && \
    echo "" && \
    echo "=== Check with Node.js ===" && \
    node -e "
      const Database = require('better-sqlite3');
      const db = new Database('beer.db', { readonly: true });
      const customers = db.prepare('SELECT COUNT(*) as c FROM customers').get();
      const products = db.prepare('SELECT COUNT(*) as p FROM products').get();
      const sales = db.prepare('SELECT COUNT(*) as s FROM sales').get();
      const invoices = db.prepare('SELECT COUNT(*) as i FROM invoices').get();
      console.log('Customers:', customers.c);
      console.log('Products:', products.p);
      console.log('Sales:', sales.s);
      console.log('Invoices:', invoices.i);
      
      // Show some sample data
      const lastInv = db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT 1').get();
      console.log('Last invoice:', JSON.stringify(lastInv, null, 2));
      db.close();
    " && \
    echo "" && \
    echo "=== PM2 Logs (last 10 lines) ===" && \
    pm2 logs beer-pos --lines 10 --nostream
  `;

  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('Exec error:', err.message); conn.end(); return; }

    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', () => conn.end());
  });
}).on('error', (err) => {
  console.error('SSH error:', err.message);
  process.exit(1);
}).connect({
  host: SERVER,
  port: 22,
  username: USER,
  password: PASS,
  readyTimeout: 30000
});
