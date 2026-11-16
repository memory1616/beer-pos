/**
 * Trace request headers của /api/driver/* để xem token có được gửi không.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const BASE = 'http://localhost:3000';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9404;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpGet(url) {
  return new Promise((res2, rej) => http.get(url, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res2(d)); }).on('error', rej));
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString());
      if (m.id && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.p.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); reject(new Error('timeout ' + method)); } }, 30000); }); }
}

(async () => {
  const userDataDir = path.join(os.tmpdir(), 'beer-hdr-' + PORT);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch (e) {} };
  process.on('exit', cleanup);
  for (let i = 0; i < 40; i++) { try { await httpGet(`http://127.0.0.1:${PORT}/json/version`); break; } catch (e) { await sleep(250); } }
  const targets = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`));
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (r.url.includes('/api/driver/')) {
        const h = r.headers || {};
        console.log('REQ', r.method, r.url.replace(BASE, ''));
        console.log('   Authorization:', h['Authorization'] || h['authorization'] || '(KHÔNG CÓ)');
        console.log('   Cookie:', (h['Cookie'] || h['cookie'] || '(không)').slice(0, 80));
      }
    }
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + '/auth/driver' });
  await sleep(2000);
  // Điền form đăng nhập thật
  await cdp.send('Runtime.evaluate', { expression: `
    (function(){
      var u = document.querySelector('input[name="username"], #username, input[type="text"]');
      var p = document.querySelector('input[name="password"], #password, input[type="password"]');
      if (u) { u.value='qa_driver'; u.dispatchEvent(new Event('input',{bubbles:true})); }
      if (p) { p.value='QaDriver2026'; p.dispatchEvent(new Event('input',{bubbles:true})); }
      return 'filled:' + !!u + ',' + !!p;
    })()`, returnByValue: true });
  const fill = await cdp.send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0,300)', returnByValue: true });
  console.log('FORM:', fill.result.value);
  await sleep(500);
  await cdp.send('Runtime.evaluate', { expression: `
    (function(){
      var b = document.querySelector('button[type="submit"], form button, .btn--primary, #login-btn');
      if (b) { b.click(); return 'clicked'; }
      return 'no button';
    })()`, returnByValue: true });
  await sleep(3500);
  const url = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  console.log('SAU LOGIN URL:', url.result.value);
  const ls = await cdp.send('Runtime.evaluate', { expression: "localStorage.getItem('driver_session_token') ? 'có token' : 'KHÔNG token'", returnByValue: true });
  console.log('localStorage:', ls.result.value);
  const ck = await cdp.send('Runtime.evaluate', { expression: 'document.cookie', returnByValue: true });
  console.log('cookie:', ck.result.value);

  cleanup(); process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
