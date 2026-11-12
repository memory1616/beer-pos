// Smoke test: server khởi động, các route từng bị shadow trả 200, login admin OK.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = path.join(__dirname, '..');

function loadEnv() {
  const p = path.join(APP_DIR, '.env');
  const env = {};
  if (fs.existsSync(p)) {
    fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  }
  return env;
}
const fileEnv = loadEnv();

const checks = [
  ['GET', '/api/sync/status', [200]],
  ['GET', '/api/customers/alerts', [200]],
  ['GET', '/api/promotions/near-tier', [200]],
  ['GET', '/api/session/check-migration', [200]],
  ['GET', '/api/sales/export', [200]],
  ['GET', '/api/segments', [200]],
  ['GET', '/login', [200]],
  ['GET', '/sw.v2.js', [200]],
  // /sw.js phải trả 200 (không redirect) — Chrome chặn SW script sau redirect
  ['GET', '/sw.js', [200]],
  ['GET', '/js/vendor/dexie.min.js', [200]],
  ['GET', '/js/realtime.js', [200]],
  ['GET', '/js/realtime-client.js', [404]],
  ['GET', '/js/api.js', [404]],
  ['GET', '/css/ui-components.css', [404]],
];

async function waitForServer(timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + '/login');
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: { ...process.env, ...fileEnv, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });

  const up = await waitForServer();
  if (!up) {
    console.log('SERVER DID NOT START');
    console.log(out.split('\n').slice(-25).join('\n'));
    child.kill();
    process.exit(1);
  }

  let pass = 0, fail = 0;
  for (const [method, p, allowed] of checks) {
    try {
      const r = await fetch(BASE + p, { method });
      const ok = allowed.includes(r.status);
      const snippet = (await r.text()).slice(0, 90).replace(/\s+/g, ' ');
      console.log(`${ok ? 'PASS' : 'FAIL'} ${method} ${p} -> ${r.status} | ${snippet}`);
      ok ? pass++ : fail++;
    } catch (e) {
      console.log(`FAIL ${method} ${p} -> ${e.message}`);
      fail++;
    }
  }

  const user = fileEnv.ADMIN_USER || 'admin';
  const pw = fileEnv.ADMIN_PASSWORD;
  if (pw) {
    try {
      const r = await fetch(BASE + '/auth/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pw }),
      });
      const ok = r.ok;
      const body = await r.text();
      console.log(`${ok ? 'PASS' : 'FAIL'} POST /auth/ (${user}) -> ${r.status} | ${body.slice(0, 90)}`);
      ok ? pass++ : fail++;
    } catch (e) {
      console.log(`FAIL login -> ${e.message}`);
      fail++;
    }
  } else {
    console.log('SKIP login test (không có ADMIN_PASSWORD trong .env)');
  }

  console.log(`\n=== SMOKE: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) console.log('--- server log tail ---\n' + out.split('\n').slice(-20).join('\n'));
  child.kill();
  process.exit(fail > 0 ? 1 : 0);
})();
