/**
 * Phát hiện vòng lặp reload trên Driver Portal.
 * Theo dõi Page.frameNavigated / Page.loadEventFired trong N giây.
 *
 * Dùng: node scripts/ops/check-reload-loop.js [route] [seconds]
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:3000';
const USER = process.env.DRV_USER || 'qa_driver';
const PASS = process.env.DRV_PASS || 'QaDriver2026';
const ROUTE = process.argv[2] || 'driver';
const SECS = parseInt(process.argv[3] || '12', 10);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9406;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpGet(url) {
  return new Promise((res2, rej) => http.get(url, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res2(d)); }).on('error', rej));
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString());
      if (m.id && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } }); }
  send(method, params = {}, t = 20000) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.p.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); reject(new Error('timeout ' + method)); } }, t); }); }
  async evaluate(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, 20000);
    return r.result && r.result.value;
  }
}

(async () => {
  const userDataDir = path.join(os.tmpdir(), 'beer-loop-' + PORT);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch (e) {} };
  process.on('exit', cleanup);
  for (let i = 0; i < 40; i++) { try { await httpGet(`http://127.0.0.1:${PORT}/json/version`); break; } catch (e) { await sleep(250); } }
  const targets = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`));
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Network.enable');

  const navs = [];
  const logs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Page.frameNavigated' && m.params.frame.parentId === undefined) {
      navs.push({ url: m.params.frame.url, ts: Date.now() });
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      if (/DRIVER|reload|vòng lặp|loop|401|Unauthorized/i.test(txt)) logs.push(txt.slice(0, 200));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('ERR ' + m.params.entry.text.slice(0, 160));
  });

  // Đăng nhập trước (để bắt được cả vòng lặp sau login)
  await cdp.send('Page.navigate', { url: BASE + '/auth/driver' });
  await sleep(1800);
  const auth = await cdp.evaluate(`(async function(){
    var r = await fetch('/auth/driver', { method:'POST', headers:{'Content-Type':'application/json'},
      credentials:'include', body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}}) });
    var d = await r.json();
    if (d && d.token) { localStorage.setItem('driver_session_token', d.token); return 'OK'; }
    return 'FAIL';
  })()`, true);
  console.log('Auth:', auth);

  navs.length = 0;
  const target = BASE + (ROUTE === 'driver' ? '/driver' : '/driver/' + ROUTE);
  console.log('Mở:', target);
  await cdp.send('Page.navigate', { url: target });
  await sleep(SECS * 1000);

  console.log(`\n=== ${SECS}s: ${navs.length} lần điều hướng ===`);
  navs.forEach((n, i) => console.log(`  ${i + 1}. ${n.url}`));

  const uniq = [...new Set(navs.map(n => n.url))];
  console.log('URL duy nhất:', JSON.stringify(uniq));
  console.log('RELOAD LOOP:', navs.length > 5 ? '⚠️ CÓ (' + navs.length + ' lần)' : '✅ không');
  if (logs.length) console.log('Logs:', JSON.stringify([...new Set(logs)].slice(0, 8), null, 1));

  cleanup(); process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
