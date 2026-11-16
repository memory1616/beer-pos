/**
 * Kiểm tra chi tiết: token có tồn tại trong localStorage sau khi navigate không,
 * và fetch thủ công từ trong trang có kèm Authorization không.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const BASE = 'http://localhost:3000';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9405;
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
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); reject(new Error('timeout ' + method)); } }, 20000); }); }
}

(async () => {
  const login = await fetch(BASE + '/auth/driver', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'qa_driver', password: 'QaDriver2026' }) });
  const token = (await login.json()).token;
  console.log('token len', token && token.length);

  const userDataDir = path.join(os.tmpdir(), 'beer-chk-' + PORT);
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
    if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/driver/')) {
      const h = m.params.request.headers;
      console.log('  REQ', m.params.request.url.replace(BASE, ''), '| Authorization:', (h.Authorization || h.authorization || 'KHÔNG CÓ').slice(0, 30));
    }
    if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/driver/')) {
      console.log('  RESP', m.params.response.status, m.params.response.url.replace(BASE, ''));
    }
  });

  // Đặt token TRƯỚC khi navigate (dùng Page.addScriptToEvaluateOnNewDocument để chắc chắn)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('driver_session_token', ${JSON.stringify(token)}); } catch (e) {}`,
  });

  await cdp.send('Page.navigate', { url: BASE + '/driver/giao-hang' });
  await sleep(4000);

  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async function(){
      var t = localStorage.getItem('driver_session_token');
      var out = { hasToken: !!t, len: (t||'').length, cookie: document.cookie, url: location.href };
      try {
        var res = await fetch('/api/driver/me', { headers: { 'Authorization': 'Bearer ' + t }, credentials: 'include', cache: 'no-store' });
        out.manualMe = res.status;
      } catch (e) { out.manualMe = 'ERR ' + e.message; }
      out.drvToken = window.Drv && window.Drv.getToken ? (window.Drv.getToken() ? 'có' : 'null') : 'no Drv';
      return JSON.stringify(out);
    })()`,
    awaitPromise: true, returnByValue: true,
  });
  console.log('STATE:', r.result.value);

  cleanup(); process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
