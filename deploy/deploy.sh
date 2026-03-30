#!/bin/bash
# ============================================================
# BeerPOS Auto-Deploy Script
# Run manually or triggered by webhook
# ============================================================

set -e

APP_DIR="/root/beer-pos"
SERVICE_NAME="beer-pos"
DEPLOY_LOG="/var/log/beerpos-deploy.log"

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
    echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$DEPLOY_LOG" 2>/dev/null || true
}
log_step() { log "${GREEN}[STEP]${NC} $1"; }
log_warn()  { log "${YELLOW}[WARN]${NC} $1"; }
log_error() { log "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Check if running as root ──
if [ "$EUID" -ne 0 ]; then
    log_warn "Not running as root - some commands may fail"
fi

# ── 1. Pull latest code ──
log_step "Pulling latest code from git..."
cd "$APP_DIR" 2>/dev/null || log_error "Cannot cd to $APP_DIR"

# Check for uncommitted changes
if ! git diff --quiet HEAD 2>/dev/null; then
    log_warn "Uncommitted changes found - stashing..."
    git stash
    STASHED=1
else
    STASHED=0
fi

# Pull with retry
GIT_PULL_OUTPUT=""
for i in 1 2 3; do
    if GIT_PULL_OUTPUT=$(git pull origin main 2>&1); then
        break
    fi
    log_warn "Git pull attempt $i failed, retrying..."
    sleep 2
done

if echo "$GIT_PULL_OUTPUT" | grep -q "Already up to date."; then
    log "No new commits to deploy"
    if [ $STASHED -eq 1 ]; then
        git stash pop
    fi
    exit 0
fi

log "Git pull output: $GIT_PULL_OUTPUT"

# Restore stashed changes
if [ $STASHED -eq 1 ]; then
    git stash pop 2>/dev/null || true
fi

# ── 2. Install dependencies (if needed) ──
if [ -f "package.json" ] && [ "package.json" -nt "node_modules" ]; then
    log_step "Installing npm dependencies..."
    npm install --production 2>&1 | tail -5
fi

# ── 3. Restart PM2 ──
log_step "Restarting BeerPOS via PM2..."

# Try reload first (graceful), fall back to restart
if pm2 describe "$SERVICE_NAME" > /dev/null 2>&1; then
    pm2 reload "$SERVICE_NAME" --update-env 2>&1 || \
    pm2 restart "$SERVICE_NAME" --update-env 2>&1 || \
    pm2 start ecosystem.config.js 2>&1
else
    log_warn "PM2 service not found - starting fresh..."
    pm2 start ecosystem.config.js 2>&1
fi

pm2 save 2>&1 || true

# ── 3b. Đồng bộ landing + static cho nginx (root /var/www/beer-pos)
# Nếu không bước này: trang chủ vẫn là landing.html CŨ, thiếu FAB/chatbot dù git đã pull
WEB_ROOT="/var/www/beer-pos"
log_step "Syncing public → nginx web root ($WEB_ROOT)..."
mkdir -p "$WEB_ROOT/images" "$WEB_ROOT/landing-assets" "$WEB_ROOT/videos"
cp -f "$APP_DIR/public/landing.html" "$WEB_ROOT/landing.html"
[ -d "$APP_DIR/public/images" ] && cp -rf "$APP_DIR/public/images/"* "$WEB_ROOT/images/" 2>/dev/null || true
[ -d "$APP_DIR/public/landing-assets" ] && cp -rf "$APP_DIR/public/landing-assets/"* "$WEB_ROOT/landing-assets/" 2>/dev/null || true
log "${GREEN}✓${NC} landing.html + static synced"

# ── 4. Wait and verify ──
log_step "Verifying deployment..."
sleep 3

# Check if PM2 is running
if pm2 describe "$SERVICE_NAME" | grep -q "online"; then
    log "${GREEN}✓${NC} BeerPOS is online"
else
    log_error "BeerPOS is NOT running properly"
fi

# Health check
for i in 1 2 3; do
    if curl -sf http://127.0.0.1:3000/api/ping > /dev/null 2>&1; then
        log "${GREEN}✓${NC} Health check passed"
        break
    fi
    sleep 2
done

# ── Done ──
log "${GREEN}[SUCCESS]${NC} Deployment complete at $(date)"
echo "---"
