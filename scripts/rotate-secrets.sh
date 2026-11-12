#!/usr/bin/env bash
# Rotate ADMIN_PASSWORD / SESSION_SECRET / JWT_SECRET trong .env production.
# Chạy trực tiếp trên server:  bash /var/www/beer-pos/scripts/rotate-secrets.sh
#
# In mật khẩu admin mới ra stdout — chỉ chạy thủ công, KHÔNG log vào file.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/var/www/beer-pos/.env}"
cd "$(dirname "$ENV_FILE")"

gen_hex() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }

# Mật khẩu mạnh: loại bỏ ký tự dễ nhầm (0/O, 1/l/I), luôn có hoa + thường + số + ký tự đặc biệt
gen_password() {
  node -e "
const c = require('crypto');
const A = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const S = '!@#\$%^&*-_=+';
let p;
do {
  p = Array.from(c.randomBytes(20), b => A[b % A.length]).join('');
  if (!/[A-Z]/.test(p) || !/[a-z]/.test(p) || !/[0-9]/.test(p)) continue;
  p = p.slice(0, 17) + S[c.randomInt(S.length)];
  break;
} while (true);
console.log(p);
"
}

set_or_replace() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "${key}" "${val}" >> "$ENV_FILE"
  fi
}

ADMIN_PASSWORD="$(gen_password)"
set_or_replace SESSION_SECRET "$(gen_hex 32)"
set_or_replace JWT_SECRET "$(gen_hex 32)"
set_or_replace ADMIN_PASSWORD "$ADMIN_PASSWORD"

echo "--- secret keys present ---"
grep -oE '^(SESSION_SECRET|JWT_SECRET|ADMIN_PASSWORD)=' "$ENV_FILE" | sort -u
echo
echo "--- new ADMIN_PASSWORD (lưu lại ngay) ---"
echo "$ADMIN_PASSWORD"
