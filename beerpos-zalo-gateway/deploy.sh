#!/usr/bin/env bash
# =============================================================================
# Deploy beerpos-zalo-gateway (service Zalo messaging rieng).
# Chay tren VPS:  bash /var/www/beer-pos/beerpos-zalo-gateway/deploy.sh
#
# Luu y:
#  - KHONG dung deploy.sh cua BeerPOS (app chinh) — script nay chi lo gateway.
#  - Script cua app chinh KHONG deploy gateway (EXCLUDE_DIRS khong chan, nhung
#    gateway co file rieng + node_modules rieng + .env rieng).
#  - Idempotent: chay lai nhieu lan deu OK.
# =============================================================================
set -uo pipefail

GW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$GW_DIR/logs/deploy.log"
LOCK_FILE="/tmp/beerpos-gateway-deploy.lock"

mkdir -p "$GW_DIR/logs" "$GW_DIR/data"

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
err()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG_FILE" >&2; }
ok()   { echo "[$(date '+%Y-%m-%d %H:%M:%S')] OK: $*" | tee -a "$LOG_FILE"; }

# ---- 0. Lock (khong cho 2 deploy chay dong thoi) --------------------------
if [ -f "$LOCK_FILE" ]; then
  old_pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    err "Deploy khac dang chay (pid=$old_pid). Bo qua."
    exit 7
  fi
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ---- 1. San co gia tri ---------------------------------------------------
cd "$GW_DIR" || { err "Khong cd duoc $GW_DIR"; exit 1; }

if [ ! -f .env ]; then
  err "Thieu file .env. Tao tu .env.example va set ADMIN_API_KEY + INTEGRATION_API_KEY."
  exit 1
fi

# ---- 2. npm install -------------------------------------------------------
log "npm install..."
if npm install --production --no-audit --no-fund >>"$LOG_FILE" 2>&1; then
  ok "npm install xong"
else
  err "npm install FAILED - xem $LOG_FILE"
  exit 2
fi

# ---- 3. Migrate schema ----------------------------------------------------
log "Migrate schema..."
if node scripts/migrate.js >>"$LOG_FILE" 2>&1; then
  ok "Migrate xong"
else
  err "Migrate FAILED - xem $LOG_FILE"
  exit 3
fi

# ---- 4. Syntax check ------------------------------------------------------
log "Syntax check..."
if ! node -c src/server.js >>"$LOG_FILE" 2>&1; then
  err "Syntax ERROR trong src/server.js"
  exit 4
fi
ok "Syntax OK"

# ---- 5. PM2 restart -------------------------------------------------------
if ! command -v pm2 >/dev/null 2>&1; then
  err "pm2 khong tim thay. Cai: npm install -g pm2"
  exit 5
fi

if pm2 describe beerpos-zalo-gateway >/dev/null 2>&1; then
  log "pm2 restart beerpos-zalo-gateway..."
  pm2 restart ecosystem.config.js --update-env >>"$LOG_FILE" 2>&1 || {
    err "pm2 restart FAILED"; exit 6;
  }
else
  log "pm2 start beerpos-zalo-gateway..."
  pm2 start ecosystem.config.js >>"$LOG_FILE" 2>&1 || {
    err "pm2 start FAILED"; exit 6;
  }
fi
pm2 save >>"$LOG_FILE" 2>&1
ok "PM2 da cap nhat"

# ---- 6. Health check ------------------------------------------------------
HOST=$(grep -E '^HOST=' .env | cut -d= -f2 | tr -d '"'"'"' \r')
HOST=${HOST:-127.0.0.1}
PORT=$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '"'"'"' \r')
PORT=${PORT:-3100}

log "Health check http://$HOST:$PORT/health ..."
# Cho server kip khoi dong (node + migrate + worker) truoc khi probe.
code="000"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$HOST:$PORT/health" || echo "000")
  if [ "$code" = "200" ]; then
    break
  fi
  log "  attempt $attempt: health=$code, thu lai sau 2s..."
  sleep 2
done
if [ "$code" = "200" ]; then
  ok "Health OK (200)"
  log "Deploy SUCCESS - gateway chay tai http://$HOST:$PORT"
  exit 0
fi

err "Health FAILED (code=$code) - xem pm2 logs beerpos-zalo-gateway"
exit 8
