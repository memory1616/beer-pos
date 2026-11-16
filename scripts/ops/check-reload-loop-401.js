/**
 * Mô phỏng session hết hạn giữa chừng (401) → kiểm tra không reload vòng lặp.
 * Dùng: node scripts/ops/check-reload-loop-401.js
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
const PORT = 9408;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpGet(url) {
  return new Promise((res2, rej) => http.get(url, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res2(d)); }).on('error', rej));
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map();
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString());
      if (m.id && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } }); }
  send(method, params = {}, t = 25000) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.p.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); reject(new Error('timeout ' + method)); } }, t); }); }
  async evaluate(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    return r.result && r.result.value;
  }
}

(async () => {
  const userDataDir = path.join(os.tmpdir(), 'beer-loop401-' + PORT);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch (e) {} };
  process.on('exit', cleanup);
  for (let i = 0; i < 40; i++) { try { await httpGet(`http://127.0.0.1:${PORT}/json/version`); break; } catch (e) { await sleep(250); } }
  const targets = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`));
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');

  const navs = [];
  const redirects = [];
  const logs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Page.frameNavigated' && m.params.frame.parentId === undefined) navs.push(m.params.frame.url);
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 300 && m.params.response.status < 400) {
      redirects.push(m.params.response.status + ' ' + m.params.response.url + ' -> ' + (m.params.response.headers.location || m.params.response.headers.Location || '?'));
    }
    if (m.method === 'Page.frameRequestedNavigation' && m.params.frame) {
      const f = m.params.frame;
      logs.push('NAV-REQ ' + f.url + ' initiator=' + JSON.stringify(m.params.initiator || {}).slice(0, 200));
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      logs.push(m.params.type + ': ' + txt.slice(0, 200));
    }
  });

  // 1. Đăng nhập → lấy token thật
  await cdp.send('Page.navigate', { url: BASE + '/auth/driver' });
  await sleep(1800);
  const token = await cdp.evaluate(`(async function(){
    var r = await fetch('/auth/driver', { method:'POST', headers:{'Content-Type':'application/json'},
      credentials:'include', body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}}) });
    var d = await r.json();
    return (d && d.token) ? d.token : '';
  })()`, true);
  console.log('Token:', token ? 'có (' + token.length + ' ký tự)' : 'KHÔNG có');
  if (!token) { cleanup(); process.exit(1); }

  // 2. Đặt token hỏng (session không tồn tại) → mọi API sẽ 401
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('driver_session_token', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'); } catch(e){}`,
  });

  navs.length = 0;
  await cdp.send('Page.navigate', { url: BASE + '/driver/giao-hang' });
  await sleep(12000);

  console.log(`\n=== 12s: ${navs.length} lần điều hướng (session hỏng) ===`);
  navs.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
  const uniq = [...new Set(navs)];
  console.log('URL duy nhất:', JSON.stringify(uniq));
  console.log('HTTP 3xx:');
  redirects.forEach(r => console.log('  ' + r));
  console.log('Console:');
  [...new Set(logs)].slice(0, 10).forEach(l => console.log('  ' + l));
  console.log('RELOAD LOOP:', navs.length > 5 ? '⚠️ CÓ (' + navs.length + ')' : '✅ không');
  const finalUrl = await cdp.evaluate('location.href');
  console.log('URL cuối:', finalUrl);
  console.log('token còn trong localStorage?', await cdp.evaluate("!!localStorage.getItem('driver_session_token')"));

  cleanup(); process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
