#!/usr/bin/env node
/**
 * scripts/ops/setup-github-deploy-secrets.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tạo/cập nhật 4 secrets của GitHub Actions để workflow deploy chạy được:
 *   VPS_HOST, VPS_USER, VPS_PORT, VPS_SSH_KEY
 *
 * Secrets được mã hoá bằng RSA-OAEP với public key của repo (libsodium
 * sealed_box tương đương) — GitHub dùng thuật toán sodium sealed box.
 *
 * Yêu cầu: token GitHub có scope `repo` (lấy qua `git credential fill`).
 * Chạy:  node scripts/ops/setup-github-deploy-secrets.js
 */
const https = require('https');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'memory1616/beer-pos';
const API = `https://api.github.com/repos/${REPO}`;

// ── Lấy token từ git credential manager ──────────────────────────────────
function getToken() {
  const input = 'protocol=https\nhost=github.com\nusername=memory1616\n\n';
  const out = execSync('git credential fill', { input, encoding: 'utf8' });
  const m = out.match(/^password=(.*)$/m);
  if (!m) throw new Error('Không lấy được GitHub token từ git credential manager');
  return m[1].trim();
}

// ── Mã hoá theo sodium sealed box (X25519 + XSalsa20-Poly1305) ───────────
// Node chưa có sodium sẵn → dùng libsodium-wrappers.
// Public key trả về từ GitHub (`/actions/secrets/public-key`) ĐÃ là key
// curve25519 (không phải ed25519) → dùng thẳng crypto_box_seal.
function sealBox(plaintext, b64PublicKey) {
  const sodium = require('libsodium-wrappers');
  const pub = sodium.from_base64(b64PublicKey, sodium.base64_variants.ORIGINAL);
  const cipher = sodium.crypto_box_seal(
    sodium.from_string(plaintext),
    pub
  );
  return sodium.to_base64(cipher, sodium.base64_variants.ORIGINAL);
}

function api(pathname, method, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      `${API}${pathname}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'beer-pos-setup',
          'Content-Type': 'application/json',
          'Content-Length': data ? Buffer.byteLength(data) : 0,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`${method} ${pathname} -> ${res.statusCode}: ${raw.slice(0, 300)}`));
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const sodium = require('libsodium-wrappers');
  await sodium.ready;
  const token = getToken();

  const keyPath = process.env.DEPLOY_SSH_KEY_PATH ||
    path.join(process.env.USERPROFILE || process.env.HOME, '.ssh', 'id_ed25519_github');
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Không tìm thấy private key tại: ${keyPath}`);
  }
  const privateKey = fs.readFileSync(keyPath, 'utf8');

  const { key_id, key } = await api('/actions/secrets/public-key', 'GET', null, token);

  const secrets = {
    VPS_HOST: process.env.VPS_HOST || '103.195.236.38',
    VPS_USER: process.env.VPS_USER || 'root',
    VPS_PORT: process.env.VPS_PORT || '22',
    VPS_SSH_KEY: privateKey,
  };

  for (const [name, value] of Object.entries(secrets)) {
    const encrypted_value = sealBox(value, key);
    await api(`/actions/secrets/${name}`, 'PUT', { encrypted_value, key_id }, token);
    console.log(`  OK  ${name}`);
  }
  console.log('Đã cấu hình xong 4 secrets:', Object.keys(secrets).join(', '));
}

main().catch((err) => {
  console.error('LỖI:', err.message);
  process.exit(1);
});
