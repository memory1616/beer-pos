/**
 * Truy vết các request HTTP thất bại (4xx/5xx) trên từng trang Driver Portal.
 * Dùng: node scripts/ops/trace-driver-http.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:3000';
const USER = process.env.DRV_USER || 'qa_driver';
const PASS = process.env.DRV_PASS || 'QaDriver2026';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9403;
const ROUTES = ['giao-hang', 'khach-hang', 'ban-hang'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); }).on('error', reject);
  });
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString());
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000); }); }
}

(async () => {
  const login = await fetch(BASE + '/auth/driver', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const token = (await login.json()).token;
  if (!token) { console.error('login fail'); process.exit(1); }

  const userDataDir = path.join(os.tmpdir(), 'beer-trace-' + PORT);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  for (let i = 0; i < 40; i++) { try { await httpGet(`http://127.0.0.1:${PORT}/json/version`); break; } catch (e) { await sleep(250); } }
  const targets = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`));
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');

  let failures = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r.status >= 400) failures.push({ status: r.status, url: r.url, type: r.mimeType });
    }
    if (m.method === 'Network.loadingFailed') {
      failures.push({ status: 'FAIL', url: m.params.requestId, err: m.params.errorText });
    }
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + '/auth/driver' });
  await sleep(1500);
  await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem('driver_session_token', ${JSON.stringify(token)});` });

  for (const route of ROUTES) {
    failures = [];
    await cdp.send('Page.navigate', { url: `${BASE}/driver/${route}` });
    await sleep(3500);
    console.log(`\n=== /driver/${route} — ${failures.length} request lỗi ===`);
    failures.forEach(f => console.log(`  ${f.status} ${f.url}${f.err ? ' :: ' + f.err : ''}`));
  }
  cleanup(); process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
