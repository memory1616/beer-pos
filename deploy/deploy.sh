#!/bin/bash
# ============================================================
# BeerPOS Production Deploy Script
# Zero-downtime · Cache-busting · Safe sync
# ============================================================

set -euo pipefail

APP_DIR="/root/beer-pos"
SERVICE_NAME="beer-pos"
DEPLOY_LOG="/var/log/beerpos-deploy.log"

# ── Colors ──────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ── Logging ──────────────────────────────────────────────────────────────
ensure_log() { mkdir -p "$(dirname "$DEPLOY_LOG")" && touch "$DEPLOY_LOG"; }

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo -e "${BLUE}$msg${NC}"
    echo "$msg" >> "$DEPLOY_LOG" 2>/dev/null || true
}
log_step() { log "${GREEN}[STEP]${NC} $1"; }
log_warn() { log "${YELLOW}[WARN]${NC} $1"; }
log_error(){ log "${RED}[ERROR]${NC} $1" >&2; exit 1; }
log_ok()   { log "${GREEN}✓${NC} $1"; }

# ── 0. Init ──────────────────────────────────────────────────────────────
ensure_log
log "${BOLD}========================================${NC}"
log "${BOLD}  BeerPOS Deploy — $(date '+%Y-%m-%d %H:%M:%S')${NC}"
log "${BOLD}========================================${NC}"

if [ "$EUID" -ne 0 ]; then
    log_warn "Not running as root — some commands may fail"
fi

# ── 1. Git update (reset-hard avoids CRLF merge conflicts) ──────────────
log_step "Fetching & resetting to origin/main..."
cd "$APP_DIR" || log_error "Cannot cd to $APP_DIR"

git fetch origin main
git reset --hard origin/main

VERSION_HASH=$(git rev-parse --short HEAD)
COMMIT_MSG=$(git log -1 --format='%s')
log "Git updated to ${CYAN}${VERSION_HASH}${NC} — $COMMIT_MSG"

# ── 2. NPM install ──────────────────────────────────────────────────────
if [ -f "package.json" ]; then
    if [ ! -d "node_modules" ] || [ "package-lock.json" -nt "node_modules" ]; then
        log_step "Installing npm dependencies..."
        npm install --production 2>&1 | tail -5
        log_ok "Dependencies installed"
    else
        log "Dependencies up-to-date, skipping install"
    fi

    # Run build step if defined
    if grep -q '"build"' package.json 2>/dev/null; then
        log_step "Running build step..."
        npm run build 2>&1 | tail -10
        log_ok "Build complete"
    fi
fi

# ── 3. Cache-bust all HTML files ────────────────────────────────────────
log_step "Applying cache-bust hash ($VERSION_HASH) to HTML assets..."

find "$APP_DIR/public" -name "*.html" -type f | while read -r html_file; do
    log "  Patching: $html_file"
    # Use | as delimiter to avoid escaping / inside regex
    # Matches: src="/css/..." or href="/js/..." etc. — appends ?v=HASH
    for prefix in css js icons landing-assets images; do
        sed -i -E 's~(src|href)="/('$prefix'/[^?"]*)(\?[^"]*)?"~\1="/\2?v='"$VERSION_HASH"'"~g' \
            "$html_file"
    done
done
log_ok "Cache-bust applied to all HTML files"

# ── 4. Sync static files ────────────────────────────────────────────────
WEB_ROOT="/var/www/beer-pos"
log_step "Syncing public -> nginx web root ($WEB_ROOT)..."
mkdir -p "$WEB_ROOT"

if command -v rsync >/dev/null 2>&1; then
    rsync -a "$APP_DIR/public/" "$WEB_ROOT/"
else
    cp -rf "$APP_DIR/public/"* "$WEB_ROOT/" 2>/dev/null || true
fi
log_ok "Static files synced"

# ── 5. Reload Nginx (no downtime) ────────────────────────────────────────
log_step "Testing & reloading Nginx..."
if nginx -t 2>&1; then
    nginx -s reload 2>&1 || log_warn "Nginx reload failed — may need manual restart"
    log_ok "Nginx reloaded"
else
    log_error "Nginx config test failed — not reloading"
fi

# ── 6. Restart PM2 (zero-downtime) ──────────────────────────────────────
log_step "Restarting BeerPOS via PM2 (zero-downtime)..."

# Use pm2 jlist + jq to check if service is truly running (pm2 describe can lie on corrupted state)
if command -v jq >/dev/null 2>&1 && pm2 jlist 2>/dev/null | jq -e '.[] | select(.name == "'"$SERVICE_NAME"'" and .pm2_env?.status == "online")' >/dev/null 2>&1; then
    log "PM2 service '$SERVICE_NAME' is online — reloading..."
    if pm2 reload "$SERVICE_NAME" --update-env 2>&1; then
        log_ok "PM2 reload successful"
    else
        log_warn "PM2 reload failed — attempting restart..."
        if pm2 restart "$SERVICE_NAME" --update-env 2>&1; then
            log_ok "PM2 restart successful"
        else
            log_warn "PM2 restart failed — clearing stale state and starting fresh..."
            pm2 delete "$SERVICE_NAME" 2>/dev/null || true
            pm2 start ecosystem.config.js 2>&1 || log_error "PM2 start failed"
        fi
    fi
else
    log_warn "PM2 service '$SERVICE_NAME' not online — clearing and starting fresh..."
    pm2 delete "$SERVICE_NAME" 2>/dev/null || true
    pm2 start ecosystem.config.js 2>&1 || log_error "PM2 start failed"
fi

pm2 save 2>&1 || true

# ── 7. Health check ──────────────────────────────────────────────────────
log_step "Running health checks..."
HEALTH_OK=false

# 7a. API ping
for i in 1 2 3 4 5; do
    if curl -sf --max-time 5 http://127.0.0.1:3000/api/ping > /dev/null 2>&1; then
        log_ok "API health check passed (attempt $i)"
        HEALTH_OK=true
        break
    fi
    sleep 2
done

if [ "$HEALTH_OK" = false ]; then
    log_warn "API health check failed after 5 attempts"
fi

# 7b. Nginx root
if curl -sf --max-time 5 http://127.0.0.1/ > /dev/null 2>&1; then
    log_ok "Nginx root responding"
else
    log_warn "Nginx root check failed — investigate nginx config"
fi

# ── Done ─────────────────────────────────────────────────────────────────
log ""
log "${GREEN}${BOLD}========================================${NC}"
log "${GREEN}${BOLD}  Deploy SUCCESS${NC}"
log "${GREEN}${BOLD}  Commit : $VERSION_HASH${NC}"
log "${GREEN}${BOLD}  Deployed at: $(date '+%Y-%m-%d %H:%M:%S')${NC}"
log "${GREEN}${BOLD}========================================${NC}"
echo ""
