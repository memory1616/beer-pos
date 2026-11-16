/**
 * Audit layout Driver Portal ở nhiều khổ PC (headless Chrome + CDP).
 * Kiểm tra: tràn ngang, phần tử bị che, nút quá nhỏ, text quá nhỏ, lưới vỡ.
 *
 * Dùng: node scripts/ops/audit-driver-pc.js
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
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9402;
const OUT_DIR = path.join(__dirname, '..', '..', '.qa-shots');

const ROUTES = ['giao-hang', 'khach-hang', 'ban-hang', 'tai-khoan'];
const SIZES = [
  { w: 1024, h: 768, label: 'Laptop nhỏ' },
  { w: 1280, h: 800, label: 'Laptop' },
  { w: 1440, h: 900, label: 'Laptop lớn' },
  { w: 1920, h: 1080, label: 'Desktop' },
];

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
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
    });
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
    if (r.width === 0 || r.height === 0) return;
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

  // Phần tử bị che bởi fixed/sticky overlay (bottom nav, app bar)
  const occluded = [];
  const overlays = [...document.querySelectorAll('body *')].filter(el => {
    const cs = getComputedStyle(el);
    return (cs.position === 'fixed' || cs.position === 'sticky') &&
           parseFloat(cs.zIndex || '0') > 10 && el.getBoundingClientRect().height > 0;
  });
  overlays.forEach(ov => {
    const or_ = ov.getBoundingClientRect();
    document.querySelectorAll('button, a.btn, .ds-btn, .ds-row__title, .ds-label, input, select').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const ox = Math.min(r.right, or_.right) - Math.max(r.left, or_.left);
      const oy = Math.min(r.bottom, or_.bottom) - Math.max(r.top, or_.top);
      if (ox > r.width * 0.6 && oy > r.height * 0.6) {
        occluded.push({ el: el.tagName.toLowerCase() + '.' + (el.className||'').toString().slice(0,40), by: (ov.className||'').toString().slice(0,40), pct: Math.round(oy / r.height * 100) });
      }
    });
  });

  // Nút quá nhỏ (&lt; 32px chiều cao) trên desktop
  const smallBtns = [];
  document.querySelectorAll('button, a.ds-btn, .ds-btn, .drv-btn').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.height < 32 || r.width < 32) {
      smallBtns.push({ el: el.tagName.toLowerCase() + '.' + (el.className||'').toString().slice(0,40), w: Math.round(r.width), h: Math.round(r.height), txt: (el.textContent||'').trim().slice(0,18) });
    }
  });

  // Text quá nhỏ
  const smallText = [];
  document.querySelectorAll('p, span, div, label, small, td, th, li, a, button').forEach(el => {
    if (el.children.length) return;
    const t = (el.textContent||'').trim();
    if (!t) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const fs = parseFloat(cs.fontSize);
    if (fs < 11) smallText.push({ cls: (el.className||'').toString().slice(0,40), fs, txt: t.slice(0,26) });
  });

  const main = document.querySelector('.ds-main');
  const grid = [];
  document.querySelectorAll('.ds-main > *, .ds-grid, [class*="__grid"]').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'grid' || cs.display === 'inline-grid') {
      grid.push({ cls: (el.className||'').toString().slice(0,50), cols: cs.gridTemplateColumns });
    }
  });

  return JSON.stringify({
    url: location.href, vw, vh, docW,
    horizontalScroll: docW > vw + 1,
    overflowCount: overflow.length, overflow: overflow.slice(0, 6),
    occludedCount: occluded.length, occluded: occluded.slice(0, 6),
    smallBtnCount: smallBtns.length, smallBtns: smallBtns.slice(0, 8),
    smallTextCount: smallText.length, smallText: smallText.slice(0, 8),
    mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
    grids: grid.slice(0, 6)
  });
})()`;

(async () => {
  const login = await fetch(BASE + '/auth/driver', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const data = await login.json();
  if (!data.token) { console.error('Đăng nhập thất bại', JSON.stringify(data)); process.exit(1); }
  const token = data.token;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const userDataDir = path.join(os.tmpdir(), 'beer-audit-' + PORT);
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
  if (!ver) { console.error('Không kết nối Chrome'); cleanup(); process.exit(1); }

  const targets = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`));
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  let errors = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
  });

  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('driver_session_token', ${JSON.stringify(token)}); } catch (e) {}`,
  });

  let issues = 0;
  for (const sz of SIZES) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: sz.w, height: sz.h, deviceScaleFactor: 1, mobile: false });
    for (const route of ROUTES) {
      errors = [];
      await cdp.send('Page.navigate', { url: `${BASE}/driver/${route}` });
      await sleep(2600);
      const m = await cdp.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
      let info = {};
      try { info = JSON.parse(m.result.value || '{}'); } catch (_) {}
      const bad = info.overflowCount > 0 || info.occludedCount > 0 || (info.smallBtnCount > 0) || (info.smallTextCount > 0) || errors.length > 0 || info.horizontalScroll;
      if (bad) issues++;
      console.log(`${bad ? '⚠️ ' : '✅ '}${sz.w}x${sz.h} ${route.padEnd(11)} | overflow=${info.overflowCount} occluded=${info.occludedCount} smallBtn=${info.smallBtnCount} smallText=${info.smallTextCount} err=${errors.length}`);
      if (info.overflow?.length) console.log('    overflow:', JSON.stringify(info.overflow));
      if (info.occluded?.length) console.log('    occluded:', JSON.stringify(info.occluded));
      if (info.smallBtns?.length) console.log('    smallBtns:', JSON.stringify(info.smallBtns));
      if (info.smallText?.length) console.log('    smallText:', JSON.stringify(info.smallText));
      if (errors.length) console.log('    errors:', JSON.stringify(errors.slice(0, 3)));

      if (route === 'giao-hang' && (sz.w === 1440 || sz.w === 1920)) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT_DIR, `pc-${route}-${sz.w}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
  }
  console.log(`\n=== Có vấn đề: ${issues}/${SIZES.length * ROUTES.length} ===`);
  cleanup();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
