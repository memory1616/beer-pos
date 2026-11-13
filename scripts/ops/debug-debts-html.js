#!/usr/bin/env node
/** Tìm nguồn lỗi "giaohang01 is not defined" trong HTML trang /debts. */
const http = require('http');

const url = process.argv[2] || 'http://localhost:3000/debts';

http.get(url, (res) => {
  let body = '';
  res.on('data', (c) => (body += c));
  res.on('end', () => {
    console.log('HTTP', res.statusCode, '| bytes:', body.length);

    const lines = body.split('\n');
    lines.forEach((l, i) => {
      if (/giaohang01/.test(l)) {
        console.log(`\n[dòng ${i + 1}]`);
        console.log(l.trim().slice(0, 400));
      }
    });

    // Liệt kê mọi onclick
    console.log('\n--- onclick handlers ---');
    const found = new Set();
    const re = /onclick\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(body)) !== null) found.add(m[1]);
    [...found].forEach((v) => console.log('  ', v));

    // preload
    console.log('\n--- preload links ---');
    const re2 = /<link[^>]*rel=["']?preload["']?[^>]*>/gi;
    let m2;
    while ((m2 = re2.exec(body)) !== null) console.log('  ', m2[0]);
  });
}).on('error', (e) => console.error('ERR', e.message));
