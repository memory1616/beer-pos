#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Sinh & cập nhật secret trong .env trên server production.
#
#   ssh beer-server "bash /var/www/beer-pos/scripts/gen-secrets.sh"
#   ssh beer-server "bash /var/www/beer-pos/scripts/gen-secrets.sh --admin-password"
#   ssh beer-server "bash /var/www/beer-pos/scripts/gen-secrets.sh --webhook-secret"
#
# ⚠️ --webhook-secret làm GitHub webhook NGỪNG hoạt động tới khi bạn cập nhật
#    lại Secret trong GitHub UI (Settings → Webhooks). Chỉ dùng khi sẵn sàng.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/beer-pos}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
PRINT=0
ROTATE_ADMIN=0
ROTATE_WEBHOOK=0

for arg in "$@"; do
  case "$arg" in
    --print)            PRINT=1 ;;
    --admin-password)   ROTATE_ADMIN=1 ;;
    --webhook-secret)   ROTATE_WEBHOOK=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

cd "$APP_DIR"
[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found" >&2; exit 1; }

gen_hex() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
gen_pw()  { node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"; }

# set_or_replace <KEY> <VALUE>
set_or_replace() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "${key}" "${val}" >> "$ENV_FILE"
  fi
}

# ── Secrets luôn phải có (dùng cho session + JWT) ───────────
set_or_replace SESSION_SECRET "$(gen_hex 32)"
set_or_replace JWT_SECRET "$(gen_hex 32)"

# ── ADMIN_PASSWORD (chỉ khi được yêu cầu) ────────────────────
if [ "$ROTATE_ADMIN" = "1" ]; then
  set_or_replace ADMIN_PASSWORD "$(gen_pw)"
fi

# ── GITHUB_WEBHOOK_SECRET (chỉ khi được yêu cầu) ────────────
if [ "$ROTATE_WEBHOOK" = "1" ]; then
  set_or_replace GITHUB_WEBHOOK_SECRET "$(gen_hex 32)"
fi

# ── In kết quả ───────────────────────────────────────────────
if [ "$PRINT" = "1" ]; then
  echo "=== .env secrets (values) ==="
  grep -E '^(SESSION_SECRET|JWT_SECRET|GITHUB_WEBHOOK_SECRET|ADMIN_PASSWORD)=' "$ENV_FILE"
else
  echo "=== .env secret keys present ==="
  grep -oE '^(SESSION_SECRET|JWT_SECRET|GITHUB_WEBHOOK_SECRET|ADMIN_PASSWORD)=' "$ENV_FILE" | sort -u
fi

echo
echo "Nhớ: PM2 cần restart để nạp env mới:"
echo "  pm2 restart ecosystem.config.js --update-env"
