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

    # Always rebuild native modules (better-sqlite3, etc.) to match current Node.js
    # CRITICAL: NEVER ignore rebuild failures — binary incompatibility crashes the server
    log_step "Rebuilding native modules for current Node.js version..."

    NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")
    log "Detected Node.js version: $NODE_VERSION"

    # Force reinstall better-sqlite3 to get the correct prebuilt binary for the current Node version
    # Delete all existing native binaries first to ensure clean state
    log "Cleaning old native module binaries..."
    find node_modules -name "*.node" -type f -delete 2>/dev/null || true
    find node_modules/better-sqlite3 -name "build" -type d -exec rm -rf {} + 2>/dev/null || true
    rm -rf node_modules/better-sqlite3/prebuilds 2>/dev/null || true

    # Uninstall then reinstall — downloads the correct prebuilt binary for the current Node version
    NPM_REBUILD_OUTPUT=$(npm uninstall better-sqlite3 2>&1 && npm install better-sqlite3 2>&1) || {
        log_error "Native module install FAILED. Server will NOT start with incompatible binary."
        log ""
        log "=== Install output ==="
        log "$NPM_REBUILD_OUTPUT"
        log "========================"
        log ""
        log "Troubleshooting steps:"
        log "  1. Check Node.js version: node --version"
        log "  2. Try manual: npm uninstall better-sqlite3 && npm install better-sqlite3"
        log "  3. Check node-gyp: npm install -g node-gyp"
        log ""
        log_error "Deploy aborted — server would crash on startup"
    }
    log "Install output: $(echo "$NPM_REBUILD_OUTPUT" | tail -3)"

    # Verify the binary ABI matches current Node
    log_step "Verifying native module ABI compatibility..."
    NODE_ABI=$(node -p "process.versions.modules" 2>/dev/null || echo "unknown")
    BINARY_PATH=$(node -e "try{console.log(require.resolve('better-sqlite3'))}catch(e){console.log('not-found')}" 2>/dev/null)
    if [ "$BINARY_PATH" != "not-found" ] && [ "$BINARY_PATH" != "unknown" ]; then
        BINARY_ABI=$(node -e "const fs=require('fs');const b=fs.readFileSync('$BINARY_PATH');console.log(b.readUInt32LE(4))" 2>/dev/null || echo "unknown")
        log "Node ABI: $NODE_ABI  |  Binary ABI: $BINARY_ABI  |  Binary: $BINARY_PATH"
        if [ "$NODE_ABI" == "$BINARY_ABI" ]; then
            log_ok "better-sqlite3 ABI verified (ABI=$NODE_ABI)"
        else
            log_error "ABI mismatch! Node=$NODE_ABI Binary=$BINARY_ABI — binary will crash on load"
        fi
    else
        # Fallback: try to require it
        if node -e "require('better-sqlite3')" 2>/dev/null; then
            log_ok "better-sqlite3 loaded successfully"
        else
            log_error "better-sqlite3 verification FAILED — cannot load the module"
        fi
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

# ── 5. Pre-deploy health check ──────────────────────────────────────────
log_step "Checking current server health..."
if curl -sf --max-time 3 http://127.0.0.1:3000/api/ping > /dev/null 2>&1; then
    log_ok "Server is healthy before deploy"
    WAS_HEALTHY=true
else
    log_warn "Server health check failed — server may already be down"
    WAS_HEALTHY=false
fi

# ── 6. Restart PM2 (with rollback capability) ───────────────────────────
log_step "Restarting BeerPOS via PM2..."

# Save current commit hash before restart for rollback reference
PREV_COMMIT=$(git rev-parse origin/main^1 2>/dev/null || echo "unknown")
log "Previous deploy commit: $PREV_COMMIT"

# Use delete+start instead of stop+start to ensure new ecosystem.config.js
# settings (e.g. interpreter path) take effect, not just process restart
if pm2 describe beer-pos > /dev/null 2>&1; then
    log "Deleting old BeerPOS PM2 process..."
    pm2 delete beer-pos 2>&1 || true
fi

log "Starting BeerPOS via PM2..."
pm2 start ecosystem.config.js 2>&1 || log_error "PM2 start failed"

# Wait for process to initialize
sleep 3

# Check if process is running and healthy
if pm2 describe beer-pos 2>/dev/null | grep -q "online"; then
    log_ok "BeerPOS process started successfully"
else
    log_warn "BeerPOS process may not have started properly"
    pm2 logs beer-pos --lines 20 --nostream 2>&1 || true
    fi
else
    log "BeerPOS not running — starting fresh..."
    pm2 start ecosystem.config.js 2>&1 || log_error "PM2 start failed"
    sleep 3
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
    log_error "Deploy FAILED — attempting rollback to previous deploy..."

    # Rollback: restore previous git state
    log "Rolling back to commit: $PREV_COMMIT"
    cd "$APP_DIR" || log_error "Cannot cd to $APP_DIR for rollback"

    git reset --hard "$PREV_COMMIT" 2>&1 || log_error "Git rollback failed"

    # Re-install for rolled-back version
    log_step "Re-installing dependencies for rolled-back version..."
    find node_modules -name "*.node" -type f -delete 2>/dev/null || true
    find node_modules/better-sqlite3 -name "build" -type d -exec rm -rf {} + 2>/dev/null || true
    rm -rf node_modules/better-sqlite3/prebuilds 2>/dev/null || true
    npm uninstall better-sqlite3 2>&1 | tail -1 || true
    npm install --production 2>&1 | tail -3 || true

    # Restart PM2 with rolled-back version (delete first to refresh interpreter)
    log "Restarting BeerPOS with rolled-back version..."
    pm2 delete beer-pos 2>/dev/null || true
    pm2 start ecosystem.config.js 2>&1 || log_error "PM2 start after rollback failed"
    pm2 save 2>&1 || true

    sleep 5

    # Verify rollback worked
    if curl -sf --max-time 5 http://127.0.0.1:3000/api/ping > /dev/null 2>&1; then
        log ""
        log "${RED}${BOLD}========================================${NC}"
        log "${RED}${BOLD}  Deploy FAILED — ROLLED BACK${NC}"
        log "${RED}${BOLD}  Previous commit: $PREV_COMMIT${NC}"
        log "${RED}${BOLD}  Server is now running the old version${NC}"
        log "${RED}${BOLD}========================================${NC}"
        log ""
        log "Investigate the failed commit before deploying again."
        log_error "Deploy failed and was rolled back"
    else
        log_error "Rollback itself failed — SERVER IS DOWN — MANUAL INTERVENTION REQUIRED"
    fi
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
