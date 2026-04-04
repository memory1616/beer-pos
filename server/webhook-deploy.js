#!/usr/bin/env node
// webhook-deploy.js — Nhận GitHub webhook → chạy deploy.sh + pm2 restart
// Đặt trong /opt/webhook/ hoặc /root/beer-pos/webhook-deploy.js

const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');

const PORT       = process.env.WEBHOOK_PORT    || 3939;
const SECRET     = process.env.WEBHOOK_SECRET  || '';
const GIT_DIR    = '/root/beer-pos';           // Thư mục repo git
const DEPLOY_SCRIPT = '/root/beer-pos/deploy.sh'; // Script deploy có sẵn

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

function verifySignature(payload, signature) {
  if (!SECRET) return true;
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

function deploy() {
  try {
    log('INFO', '🔄 Pulling latest code...');
    execSync('git pull origin main', { cwd: GIT_DIR, stdio: 'inherit' });

    log('INFO', '🚀 Running deploy.sh...');
    execSync(DEPLOY_SCRIPT, { cwd: GIT_DIR, stdio: 'inherit' });

    log('INFO', '✅ Deploy complete!');
    return { ok: true };
  } catch (err) {
    log('ERROR', '❌ Deploy failed: ' + err.message);
    return { ok: false, error: err.message };
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('✅ Webhook OK — beer-pos\n');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const sig = req.headers['x-hub-signature-256'] || '';
    if (!verifySignature(body, sig)) {
      log('WARN', '⛔ Invalid signature');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const event = req.headers['x-github-event'] || '';
    if (event !== 'push') {
      log('INFO', `Ignoring '${event}'`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    log('INFO', '📦 Push detected — starting deploy');
    const result = deploy();
    res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
});

server.listen(PORT, () => {
  log('INFO', `🌐 Listening on port ${PORT}`);
  log('INFO', `📂 Repo: ${GIT_DIR}`);
  log('INFO', `📜 Deploy script: ${DEPLOY_SCRIPT}`);
  if (!SECRET) log('WARN', '⚠️  No WEBHOOK_SECRET set — signatures NOT verified');
});