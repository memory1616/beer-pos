/**
 * QA responsive tự động cho public/landing.html.
 *
 * Dùng Chrome headless + raw CDP (module `ws`, đã có sẵn trong node_modules).
 * Kiểm tra ở các bề rộng: 320 / 375 / 390 / 430 / 768 / 1024 / 1366 / 1920
 *
 * Chạy: node scripts/responsive-qa.js [url]
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

const URL_TARGET = process.argv[2] || 'http://biatuoitayninh.store.localhost:3000/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333 + (Number(process.env.QA_PORT_OFFSET) || 0);

const WIDTHS = [
  { w: 320, h: 640, label: 'Mobile nhỏ (iPhone SE)' },
  { w: 375, h: 667, label: 'Mobile (iPhone SE2/8)' },
  { w: 390, h: 844, label: 'Mobile (iPhone 12/13/14)' },
  { w: 430, h: 932, label: 'Mobile lớn (iPhone 15 Pro Max)' },
  { w: 768, h: 1024, label: 'Tablet (iPad mini dọc)' },
  { w: 1024, h: 768, label: 'Tablet ngang / laptop nhỏ' },
  { w: 1366, h: 768, label: 'Laptop' },
  { w: 1920, h: 1080, label: 'Desktop lớn' },
];

/** Script đo trong trang */
const MEASURE = `(() => {
  const vw = window.innerWidth;
  const docW = document.documentElement.scrollWidth;
  const bodyW = document.body.scrollWidth;

  // 1. Phần tử tràn ngang
  const overflow = [];
  document.querySelectorAll('body *').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    if (r.right > vw + 1.5 || r.left < -1.5) {
      // bỏ qua phần tử nằm trong vùng cuộn ngang có chủ đích
      let p = el.parentElement, inScroller = false;
      while (p && p !== document.body) {
        const pcs = getComputedStyle(p);
        if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll') { inScroller = true; break; }
        p = p.parentElement;
      }
      if (inScroller) return;
      overflow.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.toString().slice(0, 60)) || '',
        left: Math.round(r.left),
        right: Math.round(r.right),
        w: Math.round(r.width)
      });
    }
  });

  const vis = sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      display: cs.display,
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
      w: Math.round(r.width), h: Math.round(r.height)
    };
  };

  const tapTargets = [];
  document.querySelectorAll('a.btn, button, .sticky-btn, .nav-call, .mobile-menu-btn, .chat-fab, .nav-links a').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.height < 44) tapTargets.push({ tag: el.tagName.toLowerCase(), cls: (el.className||'').toString().slice(0,40), h: Math.round(r.height) });
  });

  const h1 = document.querySelector('h1');
  const smallTexts = [];
  document.querySelectorAll('p, span, b, li, a, figcaption, small, td, th').forEach(el => {
    if (!el.textContent.trim()) return;
    if (el.children.length) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const fs = parseFloat(cs.fontSize);
    if (fs < 11) smallTexts.push({ tag: el.tagName.toLowerCase(), fs: fs, txt: el.textContent.trim().slice(0,30) });
  });

  const imgs = [];
  document.querySelectorAll('img').forEach(el => {
    const r = el.getBoundingClientRect();
    imgs.push({
      src: el.currentSrc || el.src,
      nat: el.naturalWidth,
      disp: Math.round(r.width),
      ratio: el.naturalWidth ? +(r.width / el.naturalWidth).toFixed(2) : null,
      broken: el.complete && el.naturalWidth === 0
    });
  });

  const grid = sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return getComputedStyle(el).gridTemplateColumns;
  };

  return {
    vw, docW, bodyW,
    horizontalScroll: docW > vw + 1,
    overflow: overflow.slice(0, 12),
    overflowCount: overflow.length,
    menuBtn: vis('.mobile-menu-btn'),
    navLinks: vis('.nav-links'),
    navCall: vis('.nav-call'),
    navCallDesktop: vis('.nav-call-desktop'),
    sticky: vis('.sticky-cta'),
    chatFab: vis('.chat-fab'),
    h1Font: h1 ? getComputedStyle(h1).fontSize : null,
    h1Lines: h1 ? Math.round(h1.getBoundingClientRect().height / parseFloat(getComputedStyle(h1).lineHeight)) : 0,
    advCols: grid('.adv-grid'),
    prodCols: grid('.prod-grid'),
    processCols: grid('.process-grid'),
    heroCols: grid('.hero-grid'),
    footerCols: grid('.footer-grid'),
    tapTargets: tapTargets.slice(0, 12),
    tapCount: tapTargets.length,
    smallTexts: smallTexts.slice(0, 8),
    smallCount: smallTexts.length,
    imgs,
    bodyPadBottom: getComputedStyle(document.body).paddingBottom
  };
})()`;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, 30000);
    });
  }
}

(async () => {
  const userDataDir = path.join(os.tmpdir(), 'beer-responsive-qa-' + PORT);
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => { try { chrome.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  // Chờ DevTools sẵn sàng
  let ver = null;
  for (let i = 0; i < 40; i++) {
    try { ver = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/version`)); break; }
    catch (e) { await sleep(250); }
  }
  if (!ver) { console.error('Không kết nối được Chrome DevTools'); cleanup(); process.exit(1); }

  const targets = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`));
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  const cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  const consoleErrors = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(msg.params.entry.text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.text + ' ' +
        (msg.params.exceptionDetails.exception?.description || ''));
    }
  });

  const results = [];

  for (const bp of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: bp.w, height: bp.h, deviceScaleFactor: 1, mobile: bp.w < 820,
    });
    if (bp.w < 820) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    } else {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }

    await cdp.send('Page.navigate', { url: URL_TARGET });
    await sleep(1400);
    // Trigger reveal + scroll để các section dọn render
    await cdp.send('Runtime.evaluate', {
      expression: `window.scrollTo(0, 0);
        document.querySelectorAll('.reveal').forEach(e => e.classList.add('visible'));
        window.dispatchEvent(new Event('scroll'));`,
    });
    await sleep(400);

    const res = await cdp.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
    const m = res.result.value;
    results.push({ bp, m });

    // Ảnh chụp tại breakpoint
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const dir = path.join(__dirname, '..', '.qa-shots');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `landing-${bp.w}.png`), Buffer.from(shot.data, 'base64'));
    } catch (e) { /* ignore */ }
  }

  // ── In báo cáo ──
  let fail = 0;
  for (const { bp, m } of results) {
    const issues = [];
    if (m.horizontalScroll) issues.push(`TRÀN NGANG: doc ${m.docW} > vw ${m.vw}`);
    if (m.overflowCount > 0) issues.push(`${m.overflowCount} phần tử tràn: ` + m.overflow.map(o => `${o.tag}.${o.cls}[${o.left}→${o.right}]`).join(', '));
    if (m.smallCount > 0) issues.push(`${m.smallCount} chữ < 11px: ` + m.smallTexts.map(t => `${t.tag}:${t.fs}px`).join(', '));
    if (m.tapCount > 0) issues.push(`${m.tapCount} touch target < 44px: ` + m.tapTargets.map(t => `${t.cls||t.tag}:${t.h}px`).join(', '));
    const broken = m.imgs.filter(i => i.broken);
    if (broken.length) issues.push(`${broken.length} ảnh lỗi: ` + broken.map(b => b.src).join(', '));
    const menuOk = bp.w < 1024 ? (m.menuBtn && m.menuBtn.visible && m.navLinks && !m.navLinks.visible) : (!m.menuBtn || !m.menuBtn.visible);
    if (!menuOk) issues.push(`Menu sai: btn=${JSON.stringify(m.menuBtn)} links=${JSON.stringify(m.navLinks)}`);
    // Hero phải 1 cột ở mobile, 2 cột ở desktop
    const heroCols = m.heroCols ? m.heroCols.split(' ').length : 0;
    if (bp.w < 1024 && heroCols !== 1) issues.push(`Hero phải 1 cột ở ${bp.w}px (đang ${m.heroCols})`);
    if (bp.w >= 1024 && heroCols !== 2) issues.push(`Hero phải 2 cột ở ${bp.w}px (đang ${m.heroCols})`);

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`${bp.w}px — ${bp.label}`);
    console.log(`  scrollWidth=${m.docW} innerWidth=${m.vw}  h1=${m.h1Font} (~${m.h1Lines} dòng)`);
    console.log(`  hero=${m.heroCols} | adv=${m.advCols} | prod=${m.prodCols} | process=${m.processCols} | footer=${m.footerCols}`);
    console.log(`  menuBtn=${m.menuBtn ? m.menuBtn.visible : 'n/a'} navLinks=${m.navLinks ? m.navLinks.visible : 'n/a'} sticky=${m.sticky ? m.sticky.visible : 'n/a'} chatFab=${m.chatFab ? m.chatFab.visible : 'n/a'}`);
    console.log(`  body padding-bottom=${m.bodyPadBottom}`);
    console.log(`  ảnh: ${m.imgs.length} (thiếu/chưa tải: ${m.imgs.filter(i => i.nat === 0).length})`);
    if (issues.length === 0) {
      console.log('  ✅ KHÔNG CÓ VẤN ĐỀ');
    } else {
      fail += issues.length;
      issues.forEach((i) => console.log(`  ❌ ${i}`));
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`Console errors: ${consoleErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e) => console.log('  ! ' + e));
  console.log(`\nTỔNG VẤN ĐỀ: ${fail}`);

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  ws.close();
  cleanup();
  process.exit(0);
})();
