/**
 * Chụp màn hình Driver Portal ở khổ PC (headless Chrome + CDP).
 *
 * Dùng: node scripts/ops/shot-driver-pc.js [route] [width] [height]
 *   route: giao-hang | khach-hang | ban-hang | home  (mặc định giao-hang)
 *
 * Đăng nhập thật trong browser (fetch từ chính origin) → nhận cả cookie
 * `driver_session_token` lẫn token trả về (đưa vào localStorage).
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:3000';
const USER = process.env.DRV_USER || 'qa_driver';
const PASS = process.env.DRV_PASS || 'QaDriver2026';
const ROUTE = process.argv[2] || 'giao-hang';
const W = parseInt(process.argv[3] || '1440', 10);
const H = parseInt(process.argv[4] || '900', 10);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9401;
const OUT_DIR = path.join(__dirname, '..', '..', '.qa-shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    });
  }
  send(method, params = {}, timeout = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, timeout);
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise,
    }, 25000);
    return r.result && r.result.value;
  }
}

const MEASURE = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const docW = document.documentElement.scrollWidth;
  const overflow = [];
  document.querySelectorAll('body *').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    if (r.right > vw + 1.5 || r.left < -1.5) {
      let p = el.parentElement, inScroller = false;
      while (p && p !== document.body) {
        const pcs = getComputedStyle(p);
        if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll') { inScroller = true; break; }
        p = p.parentElement;
      }
      if (inScroller) return;
      overflow.push({ tag: el.tagName.toLowerCase(), cls: (el.className||'').toString().slice(0,70), left: Math.round(r.left), right: Math.round(r.right) });
    }
  });
  const smallBtns = [];
  document.querySelectorAll('button, a.ds-btn, .ds-btn, .drv-btn').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.height < 32 || r.width < 32) {
      smallBtns.push({ el: el.tagName.toLowerCase() + '.' + (el.className||'').toString().slice(0,40), w: Math.round(r.width), h: Math.round(r.height), txt: (el.textContent||'').trim().slice(0,16) });
    }
  });
  const smallText = [];
  document.querySelectorAll('p, span, div, label, small, td, th, li, a, button, h1, h2, h3').forEach(el => {
    if (el.children.length) return;
    const t = (el.textContent||'').trim();
    if (!t) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const fs = parseFloat(cs.fontSize);
    if (fs < 11) smallText.push({ cls: (el.className||'').toString().slice(0,40), fs, txt: t.slice(0,24) });
  });
  const main = document.querySelector('.ds-main');
  const sidebar = document.querySelector('.ds-sidebar');
  return JSON.stringify({
    url: location.href, vw, vh, docW,
    horizontalScroll: docW > vw + 1,
    overflowCount: overflow.length, overflow: overflow.slice(0, 6),
    smallBtnCount: smallBtns.length, smallBtns: smallBtns.slice(0, 8),
    smallTextCount: smallText.length, smallText: smallText.slice(0, 8),
    mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
    mainCols: main ? getComputedStyle(main).gridTemplateColumns : null,
    sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : null,
    sidebarVisible: sidebar ? getComputedStyle(sidebar).display !== 'none' : false
  });
})()`;

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const userDataDir = path.join(os.tmpdir(), 'beer-shot-' + PORT);
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  let ver = null;
  for (let i = 0; i < 40; i++) {
    try { ver = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/version`)); break; }
    catch (e) { await sleep(250); }
  }
  if (!ver) { console.error('Không kết nối được Chrome'); cleanup(); process.exit(1); }

  const targets = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`));
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  const cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  const errors = [];
  const failedReqs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      failedReqs.push(m.params.response.status + ' ' + m.params.response.url.replace(BASE, ''));
    }
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });

  // 1. Mở trang login rồi đăng nhập qua fetch cùng-origin (nhận cookie + token)
  await cdp.send('Page.navigate', { url: BASE + '/auth/driver' });
  await sleep(1800);

  const auth = await cdp.evaluate(`(async function(){
    try {
      var res = await fetch('/auth/driver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} })
      });
      var data = await res.json();
      if (data && data.token) {
        localStorage.setItem('driver_session_token', data.token);
        return 'OK ' + data.username;
      }
      return 'FAIL ' + JSON.stringify(data);
    } catch (e) { return 'ERR ' + e.message; }
  })()`, true);
  console.log('Auth:', auth);
  if (!String(auth).startsWith('OK')) { cleanup(); process.exit(1); }

  // 2. Điều hướng tới trang cần chụp
  await cdp.send('Page.navigate', { url: `${BASE}/driver/${ROUTE}` });
  await sleep(4000);

  const finalUrl = await cdp.evaluate('location.href');
  console.log('URL:', finalUrl);

  const info = JSON.parse(await cdp.evaluate(MEASURE) || '{}');
  console.log('Đo:', JSON.stringify(info, null, 2));
  console.log('Console errors:', errors.length, errors.slice(0, 4));
  console.log('HTTP >=400:', failedReqs.length, failedReqs.slice(0, 6));

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT_DIR, `driver-${ROUTE}-${W}x${H}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('Đã lưu:', file);

  cleanup();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
