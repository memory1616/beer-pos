/**
 * Kiểm tra tương tác responsive: menu hamburger, chat FAB, sticky CTA, link neo.
 * Chạy: node scripts/responsive-interaction-test.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const URL_TARGET = process.argv[2] || 'http://biatuoitayninh.store.localhost:3000/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9400 + (Number(process.env.QA_PORT_OFFSET) || 0);
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
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }
      }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result.value;
  }
}

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'beer-rqa-' + PORT)}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    'about:blank',
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

  let fails = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) fails++;
  };

  // ── MOBILE 390px ────────────────────────────────────────────────
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Page.navigate', { url: URL_TARGET });
  await sleep(1500);

  let r = await cdp.eval(`(() => {
    const links = document.getElementById('navLinks');
    const before = getComputedStyle(links).display;
    document.querySelector('.mobile-menu-btn').click();
    const after = getComputedStyle(links).display;
    const expanded = document.querySelector('.mobile-menu-btn').getAttribute('aria-expanded');
    return { before, after, expanded };
  })()`);
  check('Mobile: menu hamburger mở dropdown', r.before === 'none' && r.after === 'flex', `display ${r.before} → ${r.after}`);
  check('Mobile: aria-expanded cập nhật', r.expanded === 'true', `aria-expanded=${r.expanded}`);

  r = await cdp.eval(`(() => {
    document.querySelector('.nav-links a').click();
    return getComputedStyle(document.getElementById('navLinks')).display;
  })()`);
  check('Mobile: đóng menu khi bấm link neo', r === 'none', `display=${r}`);

  r = await cdp.eval(`(() => {
    document.querySelector('.chat-fab').click();
    const box = document.getElementById('chatBox');
    const cs = getComputedStyle(box);
    const rect = box.getBoundingClientRect();
    return { open: box.classList.contains('open'), display: cs.display, w: Math.round(rect.width), h: Math.round(rect.height) };
  })()`);
  check('Mobile: chatbot mở, full-sheet', r.open && r.display === 'flex' && r.w === 390, `${r.w}x${r.h}`);

  r = await cdp.eval(`(() => {
    document.querySelector('.chat-close').click();
    return getComputedStyle(document.getElementById('chatBox')).display;
  })()`);
  check('Mobile: đóng chatbot', r === 'none', `display=${r}`);

  r = await cdp.eval(`(() => {
    const sticky = document.querySelector('.sticky-cta').getBoundingClientRect();
    const btns = [...document.querySelectorAll('.sticky-btn')].map(b => {
      const x = b.getBoundingClientRect();
      return { text: b.textContent.trim().slice(0,10), w: Math.round(x.width), h: Math.round(x.height), visible: x.top >= 0 && x.bottom <= window.innerHeight + 1 };
    });
    return { stickyTop: Math.round(sticky.top), stickyBottom: Math.round(sticky.bottom), vh: window.innerHeight, btns };
  })()`);
  check('Mobile: thanh CTA dính đáy màn hình', Math.abs(r.stickyBottom - r.vh) <= 2, `bottom=${r.stickyBottom} vh=${r.vh}`);
  check('Mobile: 2 nút CTA nằm trong viewport & ≥44px',
    r.btns.length === 2 && r.btns.every(b => b.visible && b.h >= 44),
    r.btns.map(b => `${b.text}:${b.w}x${b.h}`).join(', '));

  // Kiểm tra CTA không che nội dung footer
  r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 600));
      const last = document.querySelector('.footer-bottom');
      const lb = last.getBoundingClientRect();
      const sticky = document.querySelector('.sticky-cta').getBoundingClientRect();
      return { lastBottom: Math.round(lb.bottom), stickyTop: Math.round(sticky.top), overlapped: lb.bottom > sticky.top + 1 };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }).then((x) => x.result.value);
  check('Mobile: thanh CTA không che chữ footer', !r.overlapped, `footer bottom=${r.lastBottom} sticky top=${r.stickyTop}`);

  // ── DESKTOP 1366px ──────────────────────────────────────────────
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.send('Page.navigate', { url: URL_TARGET });
  await sleep(1500);

  r = await cdp.eval(`(() => {
    const nav = document.querySelector('.nav-links').getBoundingClientRect();
    const call = document.querySelector('.nav-call-desktop').getBoundingClientRect();
    const mb = document.querySelector('.mobile-menu-btn');
    const hero = document.querySelector('.hero-grid');
    const cols = getComputedStyle(hero).gridTemplateColumns.split(' ').length;
    return {
      linksVisible: getComputedStyle(document.querySelector('.nav-links')).display,
      navW: Math.round(nav.width), callVisible: getComputedStyle(document.querySelector('.nav-call-desktop')).display,
      callW: Math.round(call.width), menuBtnHidden: getComputedStyle(mb).display === 'none',
      heroCols: cols
    };
  })()`);
  check('Desktop: menu ngang hiện', r.linksVisible === 'flex', `display=${r.linksVisible}`);
  check('Desktop: hamburger ẩn', r.menuBtnHidden === true);
  check('Desktop: hotline trong header hiện', r.callVisible !== 'none', `display=${r.callVisible}`);
  check('Desktop: hero 2 cột', r.heroCols === 2, `cols=${r.heroCols}`);

  r = await cdp.eval(`(() => {
    const sticky = document.querySelector('.sticky-cta').getBoundingClientRect();
    const chat = document.querySelector('.chat-fab').getBoundingClientRect();
    return { stickyLeft: Math.round(sticky.left), stickyW: Math.round(sticky.width), chatBottom: Math.round(chat.bottom), vh: window.innerHeight };
  })()`);
  check('Desktop: sticky CTA là cột nổi (không phủ full-width)',
    r.stickyW < 200 && r.stickyLeft > 1000, `left=${r.stickyLeft} w=${r.stickyW}`);
  check('Desktop: chat FAB không chồng sticky CTA', r.chatBottom < r.vh - 60, `chatBottom=${r.chatBottom} vh=${r.vh}`);

  r = await cdp.eval(`(() => {
    document.querySelector('.chat-fab').click();
    const b = document.getElementById('chatBox').getBoundingClientRect();
    return { w: Math.round(b.width), right: Math.round(window.innerWidth - b.right), inViewport: b.right <= window.innerWidth && b.left >= 0 };
  })()`);
  check('Desktop: chatbot mở trong viewport', r.inViewport && r.w === 340, `w=${r.w}`);

  // ── Ảnh: kiểm tra srcset chọn đúng bề rộng ──────────────────────
  for (const w of [320, 768, 1366]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: w < 820 });
    await cdp.send('Page.navigate', { url: URL_TARGET });
    await sleep(1200);
    const im = await cdp.eval(`(() => {
      const el = document.querySelector('.hero-img');
      return { src: el.currentSrc.split('/').pop(), nat: el.naturalWidth, disp: Math.round(el.getBoundingClientRect().width) };
    })()`);
    check(`Ảnh hero @${w}px: chọn biến thể phù hợp (không phóng quá 2x)`,
      im.nat <= im.disp * 2.2, `currentSrc=${im.src} nat=${im.nat} disp=${im.disp}`);
  }

  console.log(`\nTỔNG LỖI: ${fails}`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  ws.close(); cleanup();
  process.exit(fails ? 1 : 0);
})();
