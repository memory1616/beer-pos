/**
 * Chụp QA page ở nhiều viewport (headless Chrome + CDP).
 * Dùng: node scripts/ops/shot-qa-actions.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:3999';
const PAGE = process.env.PAGE || '/qa-actions-tmp.html';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9411;
const OUT_DIR = path.join(__dirname, '..', '..', '.qa-shots');
const VIEWPORTS = [
  { name: 'mobile-360', w: 360, h: 780, mobile: true },
  { name: 'mobile-390', w: 390, h: 844, mobile: true },
  { name: 'mobile-414', w: 414, h: 896, mobile: true },
  { name: 'tablet-768', w: 768, h: 1024, mobile: false },
  { name: 'laptop-1280', w: 1280, h: 800, mobile: false },
  { name: 'desktop-1440', w: 1440, h: 900, mobile: false },
  { name: 'desktop-1920', w: 1920, h: 1080, mobile: false },
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
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout ' + method));
        }
      }, 20000);
    });
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDir = path.join(os.tmpdir(), 'qa-actions-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`));
      const target = list.find((t) => t.type === 'page');
      if (target) { wsUrl = target.webSocketDebuggerUrl; break; }
    } catch (_) { /* ignore */ }
    await sleep(300);
  }
  if (!wsUrl) { console.error('chrome not ready'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.on('open', r));
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  const report = [];
  for (const vp of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile,
    }, sessionId);
    await cdp.send('Page.navigate', { url: BASE + PAGE }, sessionId);
    await sleep(1800);
    const { result } = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.ds-delivery__actions'),function(r){
        return Array.prototype.map.call(r.children,function(b){
          var q=b.getBoundingClientRect();
          var t=b.querySelector('.ds-btn__text');
          var tw=t?t.getBoundingClientRect().width:0;
          return {cls:b.className,w:Math.round(q.width),h:Math.round(q.height),txt:b.textContent.trim().slice(0,18),clipped:!!(t&&t.scrollWidth>Math.ceil(tw)+1)};
        });
      }))`,
    }, sessionId);
    const rows = JSON.parse(result.value);
    // Mỗi hàng: "Chỉ đường" và "Giao hàng" phải cùng rộng & cùng cao;
    // nút "Gọi" cùng cao, và rộng bằng (3 cột) hoặc rộng hơn (chiếm cả hàng).
    const ok = rows.every((r) => {
      if (r.length !== 3) return false;
      const [dir, call, del] = r;
      if (dir.h !== del.h || call.h !== dir.h) return false;
      if (dir.w !== del.w) return false;
      return call.w === dir.w || call.w > dir.w;
    });
    const clipped = rows.every((r) => r.every((b) => !b.clipped));
    report.push({ vp: vp.name, ok: ok && clipped, rows });
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(OUT_DIR, `qa-actions-${vp.name}.png`), Buffer.from(data, 'base64'));
  }
  console.log(JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'qa-actions-report.json'), JSON.stringify(report, null, 2), 'utf8');
  ws.close();
  chrome.kill();
  await sleep(300);
  process.exit(0);
})();
