/**
 * Theo dõi chuỗi điều hướng (redirect chain) trên Driver Portal — không cần đăng nhập.
 * Dùng: node scripts/ops/trace-redirect-chain.js [url]
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const TARGET = process.argv[2] || 'https://giaohang.biatuoitayninh.store/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9407;
const SECS = parseInt(process.argv[3] || '15', 10);

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
  const userDataDir = path.join(os.tmpdir(), 'beer-rd-' + PORT);
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
  const reqs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Page.frameNavigated' && m.params.frame.parentId === undefined) {
      navs.push(m.params.frame.url);
    }
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 300 && m.params.response.status < 400) {
      reqs.push(m.params.response.status + ' ' + m.params.response.url + ' -> ' + (m.params.response.headers.location || m.params.response.headers.Location || '?'));
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      logs.push(m.params.type + ': ' + txt.slice(0, 220));
    }
    if (m.method === 'Log.entryAdded') logs.push('LOG[' + m.params.entry.level + ']: ' + m.params.entry.text.slice(0, 180));
  });

  console.log('Mở:', TARGET);
  await cdp.send('Page.navigate', { url: TARGET });
  await sleep(SECS * 1000);

  console.log(`\n=== ${SECS}s — ${navs.length} lần điều hướng ===`);
  navs.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
  const uniq = [...new Set(navs)];
  console.log('URL duy nhất (' + uniq.length + '):', JSON.stringify(uniq, null, 1));
  console.log('\nHTTP 3xx:');
  reqs.forEach(r => console.log('  ' + r));
  console.log('\nConsole:');
  [...new Set(logs)].slice(0, 15).forEach(l => console.log('  ' + l));

  const finalUrl = await cdp.evaluate('location.href');
  const guard = await cdp.evaluate("sessionStorage.getItem('drv_redirect_guard')");
  console.log('\nURL cuối:', finalUrl);
  console.log('redirect guard:', guard);

  cleanup(); process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
