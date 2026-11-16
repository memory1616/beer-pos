/**
 * Inject mock delivery cards into the real Driver Portal page to verify
 * the action-row layout (with / without phone number).
 * Dùng: node scripts/ops/audit-driver-actions.js [route] [width] [height]
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:3999';
const USER = process.env.DRV_USER || 'qa_driver';
const PASS = process.env.DRV_PASS || 'QaDriver2026';
const ROUTE = process.argv[2] || 'giao-hang';
const W = parseInt(process.argv[3] || '1440', 10);
const H = parseInt(process.argv[4] || '900', 10);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9412;
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
}

const MOCK = `(function(){
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];});}
  var D='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21 3 6"/><line x1="9" x2="9" y1="3" y2="18"/><line x1="15" x2="15" y1="6" y2="21"/></svg>';
  var C='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
  var G='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a2 2 0 0 0 1-1v-3.65a2 2 0 0 0-.22-.62l-3.48-4.35A2 2 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>';
  function card(name, phone, gps){
    var pb = phone
      ? '<a class="ds-btn--call" href="tel:'+esc(phone.replace(/\\s+/g,''))+'" title="Gọi '+esc(phone)+'">'+C+'<span class="ds-btn__text">'+esc(phone)+'</span></a>'
      : '<span class="ds-btn--call is-disabled" aria-disabled="true" title="Khách không có số điện thoại">'+C+'<span class="ds-btn__text">Không có SĐT</span></span>';
    return '<article class="ds-delivery"><div class="ds-delivery__head"><div class="ds-delivery__name">'+esc(name)+'</div></div>'+
      '<div class="ds-delivery__addr">🏠 Đường Nguyễn Trung Trực, Tây Ninh</div>'+
      '<div class="ds-delivery__info"><span class="ds-delivery__total">120.000đ</span></div>'+
      '<div class="ds-delivery__actions">'+
      (gps?'<a class="ds-btn--dir" href="#">'+D+'<span class="ds-btn__text">Chỉ đường</span></a>':'<span class="ds-btn--dir is-disabled">'+D+'<span class="ds-btn__text">Chỉ đường</span></span>')+
      pb+'<button class="ds-btn--deliver" type="button">'+G+'<span class="ds-btn__text">Giao hàng</span></button></div></article>';
  }
  var list=document.getElementById('list');
  if(!list) return 'no #list';
  list.innerHTML = card('KHÁCH CÓ SĐT','0901234567',true)+card('KHÁCH KHÔNG CÓ SĐT','',true)+card('KHÁCH SĐT DÀI','0901234567 / 09123456789',true)+card('KHÁCH KHÔNG GPS','0909999888',false);
  return 'ok';
})()`;

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDir = path.join(os.tmpdir(), 'qa-audit-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`));
      const t = list.find((x) => x.type === 'page');
      if (t) { wsUrl = t.webSocketDebuggerUrl; break; }
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 768 }, sessionId);

  // login
  await cdp.send('Page.navigate', { url: `${BASE}/auth/driver` }, sessionId);
  await sleep(2500);
  const login = await cdp.send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async()=>{const r=await fetch('/auth/driver',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({username:'${USER}',password:'${PASS}'})});const j=await r.json().catch(()=>({}));if(j&&j.token){localStorage.setItem('driver_token',j.token);localStorage.setItem('driver_user',JSON.stringify(j.user||{}));}return j;})()`,
  }, sessionId);
  console.log('login:', JSON.stringify(login.result.value).slice(0, 200));

  await cdp.send('Page.navigate', { url: `${BASE}/driver/${ROUTE}` }, sessionId);
  await sleep(4000);
  const inj = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: MOCK }, sessionId);
  console.log('inject:', inj.result.value);
  await sleep(800);

  const meas = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.ds-delivery__actions'),function(r){
      return Array.prototype.map.call(r.children,function(b){var q=b.getBoundingClientRect();var t=b.querySelector('.ds-btn__text');return b.className+' w='+Math.round(q.width)+' h='+Math.round(q.height)+' txt='+b.textContent.trim().slice(0,18)+(t&&t.scrollWidth>Math.ceil(t.getBoundingClientRect().width)+1?' CLIP':'');});
    }))`,
  }, sessionId);
  console.log(meas.result.value);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const file = path.join(OUT_DIR, `audit-actions-${ROUTE}-${W}x${H}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('Đã lưu:', file);
  ws.close(); chrome.kill(); await sleep(300); process.exit(0);
})();
