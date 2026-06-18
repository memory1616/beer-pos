#!/bin/bash
# ============================================================
# BeerPOS - Server-side deploy script (unified)
# ============================================================
# HÃ¡Â»â€” trÃ¡Â»Â£ 2 cÃ†Â¡ chÃ¡ÂºÂ¿ deploy:
#   A. Auto-deploy (webhook/GitHub Action): git fetch + git pull
#   B. Manual SCP (deploy_local.ps1): ~/beer-pos_new/ Ã„â€˜ÃƒÂ£ cÃƒÂ³ files
#
# Quy trÃƒÂ¬nh:
#   1. PhÃƒÂ¡t hiÃ¡Â»â€¡n cÃ†Â¡ chÃ¡ÂºÂ¿ (HAS_NEW = cÃƒÂ³ staging directory?)
#   2. NÃ¡ÂºÂ¿u KHÃƒâ€NG cÃƒÂ³ staging: git fetch + git reset --hard origin/main
#   3. Backup current files
#   4. Copy tÃ¡Â»Â« staging (nÃ¡ÂºÂ¿u cÃƒÂ³) HOÃ¡ÂºÂ¶C tÃ¡Â»Â« git working tree
#   5. npm install (nÃ¡ÂºÂ¿u package.json Ã„â€˜Ã¡Â»â€¢i)
#   6. Restart PM2 + health check
# ============================================================

set -e

VPS_PATH="$HOME/beer-pos"
NEW_PATH="$HOME/beer-pos_new"
BACKUP_DIR="$VPS_PATH/.backup"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
HEALTH_URL="http://127.0.0.1:3000/health"
GIT_BRANCH="${GIT_BRANCH:-main}"
LOG_PREFIX="[DEPLOY $TIMESTAMP]"

# Ã¢â€â‚¬Ã¢â€â‚¬ Helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
log()  { echo "$LOG_PREFIX $1"; }
ok()   { echo "$LOG_PREFIX [OK] $1"; }
warn() { echo "$LOG_PREFIX [WARN] $1"; }
err()  { echo "$LOG_PREFIX [ERROR] $1" >&2; }

echo ""
echo "================================================"
echo "  BeerPOS Auto Deploy - $TIMESTAMP"
echo "================================================"

# ---- 0. Sanity check ----
if [ ! -d "$VPS_PATH" ]; then
  err "$VPS_PATH not found. Is this run on the server?"
  exit 1
fi
ok "Server: $(hostname)  Path: $VPS_PATH"

# ---- 1. PhÃƒÂ¡t hiÃ¡Â»â€¡n cÃ†Â¡ chÃ¡ÂºÂ¿ deploy ----
HAS_NEW=0
if [ -d "$NEW_PATH" ] && [ -n "$(ls -A "$NEW_PATH" 2>/dev/null)" ]; then
  HAS_NEW=1
  log "[1/7] Mode: MANUAL SCP Ã¢â‚¬â€ staging directory $NEW_PATH cÃƒÂ³ files"
  ls -la "$NEW_PATH" | head -10
else
  log "[1/7] Mode: GIT PULL Ã¢â‚¬â€ sÃ¡ÂºÂ½ fetch + reset tÃ¡Â»Â« origin/$GIT_BRANCH"
fi

# ---- 2. Git pull (nÃ¡ÂºÂ¿u khÃƒÂ´ng cÃƒÂ³ staging) ----
if [ "$HAS_NEW" = "0" ]; then
  log "[2/7] Git pull tÃ¡Â»Â« origin/$GIT_BRANCH..."
  cd "$VPS_PATH"

  # Ã„ÂÃ¡ÂºÂ£m bÃ¡ÂºÂ£o lÃƒÂ  git repo
  if [ ! -d ".git" ]; then
    err "$VPS_PATH khÃƒÂ´ng phÃ¡ÂºÂ£i git repo. KhÃƒÂ´ng thÃ¡Â»Æ’ git pull."
    err "HÃƒÂ£y chÃ¡ÂºÂ¡y manual SCP deploy (deploy_local.ps1) hoÃ¡ÂºÂ·c init git repo."
    exit 1
  fi

  # Check git remote cÃƒÂ³ sÃ¡ÂºÂµn khÃƒÂ´ng
  if ! git remote get-url origin >/dev/null 2>&1; then
    err "Git remote 'origin' chÃ†Â°a Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ¥u hÃƒÂ¬nh"
    exit 1
  fi

  # CÃ¡ÂºÂ¥u hÃƒÂ¬nh git user (cÃ¡ÂºÂ§n thiÃ¡ÂºÂ¿t cho mÃ¡Â»â„¢t sÃ¡Â»â€˜ operations)
  git config user.name  "BeerPOS Deploy"     2>/dev/null || true
  git config user.email "deploy@beerpos.local" 2>/dev/null || true

  # LÃ†Â°u commit hiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i Ã„â€˜Ã¡Â»Æ’ so sÃƒÂ¡nh
  OLD_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  log "   Current HEAD: $OLD_COMMIT"

  # Fetch tÃ¡Â»Â« remote
  log "   git fetch origin $GIT_BRANCH..."
  if ! git fetch origin "$GIT_BRANCH" 2>&1; then
    err "git fetch FAILED. KiÃ¡Â»Æ’m tra SSH key (github) hoÃ¡ÂºÂ·c network"
    err "Test: ssh -T git@github.com"
    exit 2
  fi

  # Reset vÃ¡Â»Â origin/main (hard reset Ã„â€˜Ã¡Â»Æ’ Ã„â€˜Ã¡ÂºÂ£m bÃ¡ÂºÂ£o working tree khÃ¡Â»â€ºp remote)
  log "   git reset --hard origin/$GIT_BRANCH..."
  if ! git reset --hard "origin/$GIT_BRANCH" 2>&1; then
    err "git reset FAILED"
    exit 2
  fi

  NEW_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  log "   New HEAD:     $NEW_COMMIT"
  if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then
    log "   Ã¢Å¡Â¡ KhÃƒÂ´ng cÃƒÂ³ commit mÃ¡Â»â€ºi (HEAD khÃƒÂ´ng Ã„â€˜Ã¡Â»â€¢i) Ã¢â‚¬â€ skip phÃ¡ÂºÂ§n cÃƒÂ²n lÃ¡ÂºÂ¡i"
    ok "Nothing to deploy Ã¢â‚¬â€ code Ã„â€˜ÃƒÂ£ lÃƒÂ  mÃ¡Â»â€ºi nhÃ¡ÂºÂ¥t"
    exit 0
  fi
  ok "Git pull xong: $OLD_COMMIT Ã¢â€ â€™ $NEW_COMMIT"
else
  log "[2/7] Skip git pull (manual mode Ã¢â‚¬â€ Ã„â€˜ÃƒÂ£ cÃƒÂ³ staging files)"
  cd "$VPS_PATH"
  OLD_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
fi

# ---- 3. Backup current state ----
log ""
log "[3/7] Backing up current files to $BACKUP_DIR ..."
mkdir -p "$BACKUP_DIR"
for f in server.js database.js database/migration.js package.json \
         views/qr-settings.html views/sales.html views/dashboard.html \
         public/js/sales.js public/js/layout.js public/version.json \
         routes/api/settings.js routes/api/sales.js; do
  if [ -f "$VPS_PATH/$f" ]; then
    cp "$VPS_PATH/$f" "$BACKUP_DIR/$(basename $f).bak.$TIMESTAMP"
  fi
done
ok "Backup xong"

# ---- 4. Deploy new files ----
log ""
log "[4/7] Deploying new files..."
if [ "$HAS_NEW" = "1" ]; then
  cd "$NEW_PATH"
  for item in $(ls -A); do
    src="$NEW_PATH/$item"
    dst="$VPS_PATH/$item"
    if [ -d "$src" ]; then
      mkdir -p "$dst"
      cp -r "$src"/. "$dst"/
      log "   dir:  $item/"
    else
      cp "$src" "$dst"
      log "   file: $item"
    fi
  done
else
  # Git pull mode: files Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c reset vÃ¡Â»Â Ã„â€˜ÃƒÂºng HEAD. Verify bÃ¡ÂºÂ±ng git status.
  cd "$VPS_PATH"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    warn "Working tree cÃƒÂ³ uncommitted changes Ã¢â‚¬â€ sÃ¡ÂºÂ½ bÃ¡Â»â€¹ mÃ¡ÂºÂ¥t khi restart:"
    git status --short | head -20
  fi
  log "   (no copy step Ã¢â‚¬â€ files Ã„â€˜ÃƒÂ£ Ã¡Â»Å¸ trÃ¡ÂºÂ¡ng thÃƒÂ¡i git clean)"
fi
ok "Files deployed"

# ---- 5. Syntax check ----
log ""
log "[5/7] Syntax checking Node files..."
cd "$VPS_PATH"
SYNTAX_ERROR=0
for js in server.js database.js database/migration.js; do
  if [ -f "$js" ]; then
    if ! node -c "$js" 2>/dev/null; then
      err "SYNTAX ERROR: $js"
      log "   Restoring from backup..."
      LATEST=$(ls -t "$BACKUP_DIR/$(basename $js)".bak.* 2>/dev/null | head -1)
      if [ -n "$LATEST" ]; then
        cp "$LATEST" "$VPS_PATH/$js"
        ok "   Restored $js from $LATEST"
      fi
      SYNTAX_ERROR=1
    else
      ok "   $js"
    fi
  fi
done
if [ "$SYNTAX_ERROR" = "1" ]; then
  err "Syntax errors found Ã¢â‚¬â€ deploy ABORTED"
  exit 3
fi

# ---- 6. npm install (nÃ¡ÂºÂ¿u package.json Ã„â€˜Ã¡Â»â€¢i) ----
log ""
log "[6/7] Checking dependencies..."
if [ -f "$VPS_PATH/package.json" ]; then
  PKG_HASH_OLD=$(sha256sum "$BACKUP_DIR/package.json.bak.$TIMESTAMP" 2>/dev/null | cut -d' ' -f1 || echo "")
  PKG_HASH_NEW=$(sha256sum "$VPS_PATH/package.json" | cut -d' ' -f1)
  if [ "$PKG_HASH_OLD" != "$PKG_HASH_NEW" ]; then
    log "   package.json changed Ã¢â‚¬â€ running npm install --production..."
    cd "$VPS_PATH"
    if ! npm install --production --no-audit --no-fund 2>&1 | tail -15; then
      err "npm install FAILED"
      exit 4
    fi
    npm rebuild better-sqlite3 2>&1 | tail -5 || true
    ok "npm install xong"
  else
    ok "   package.json unchanged Ã¢â‚¬â€ skip npm install"
  fi
else
  warn "package.json khÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã¢â‚¬â€ skip"
fi

# ---- 7. Cleanup + restart PM2 + health check ----
log ""
log "[7/7] Cleanup + restart PM2..."
if [ "$HAS_NEW" = "1" ]; then
  rm -rf "$NEW_PATH"
  log "   Removed $NEW_PATH"
fi

# Restart PM2
log "   pm2 restart beer-pos..."
if ! pm2 restart beer-pos --update-env 2>&1 | tail -10; then
  err "pm2 restart FAILED"
  exit 5
fi
sleep 3

# Health check
log ""
log "=== Health check ==="
pm2 status | grep beer-pos || true

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  ok "Health: OK ($HEALTH_URL -> 200)"
else
  err "Health: FAILED ($HEALTH_URL -> $HTTP_CODE)"
  err "Check: pm2 logs beer-pos --lines 50"
  exit 6
fi

# Final commit hash
NEW_COMMIT=$(cd "$VPS_PATH" && git rev-parse HEAD 2>/dev/null || echo "unknown")
echo ""
echo "================================================"
ok "DEPLOY SUCCESS - $TIMESTAMP"
ok "Old HEAD: $OLD_COMMIT"
ok "New HEAD: $NEW_COMMIT"
echo "================================================"
