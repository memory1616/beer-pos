#!/bin/bash
# ============================================================
# BeerPOS - Server-side deploy script (unified)
# ============================================================
# Ho tro 2 cach deploy:
#   A. Auto-deploy (webhook): git fetch + git reset --hard origin/main
#   B. Manual SCP (deploy_local.ps1): ~/beer-pos_new/ da co files
#
# Quy trinh:
#   0. Lock file - chong concurrent deploy
#   1. Phat hien cach deploy (HAS_NEW = co staging directory?)
#   2. Neu KHONG co staging: git fetch + git reset --hard origin/main
#   3. Backup current files
#   4. Copy tu staging (neu co) HOAC tu git working tree
#   5. Syntax check (node -c)
#   6. npm install (neu package.json doi)
#   7. Bump version.json, restart PM2, health check
#
# Signal handling:
#   - SIGHUP / SIGPIPE: cleanup + exit (tranh partial state)
#   - EXIT trap: remove lock file
# ============================================================

# NOTE: KHONG dùng 'set -o pipefail' - nó gây SIGPIPE khi output lớn
# (vd khi SCP upload nhieu files, ls -A in 300+ items)
# Thay vào đó, dung `|| true` cho các command pipe không critical.
set -eu

# Signal traps - cleanup neu bi interrupt
cleanup_on_signal() {
    local sig=$1
    err "Script interrupted by SIG$sig - cleaning up"
    # Lock file sẽ được trap EXIT xóa
    exit 130
}
trap 'cleanup_on_signal HUP' SIGHUP
trap 'cleanup_on_signal PIPE' SIGPIPE
trap 'cleanup_on_signal INT' SIGINT
trap 'cleanup_on_signal TERM' SIGTERM

# VPS_PATH - thư mục app trên server. Đặt qua env VPS_PATH_OVERRIDE nếu khác default.
# Mặc định: /var/www/beer-pos (production)
# Fallback: /root/beer-pos (cũ, nếu quên update)
VPS_PATH="${VPS_PATH_OVERRIDE:-}"
if [ -z "$VPS_PATH" ]; then
    if [ -d "/var/www/beer-pos" ]; then
        VPS_PATH="/var/www/beer-pos"
    elif [ -d "$HOME/beer-pos" ]; then
        VPS_PATH="$HOME/beer-pos"
    else
        VPS_PATH="$HOME/beer-pos"  # default fallback
    fi
fi
NEW_PATH="${VPS_PATH}_new"
BACKUP_DIR="$VPS_PATH/.backup"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
HEALTH_URL="http://127.0.0.1:3000/health"
GIT_BRANCH="${GIT_BRANCH:-main}"
LOCK_FILE="/tmp/beerpos-deploy.lock"
LOG_PREFIX="[DEPLOY $TIMESTAMP]"
DEPLOY_LOG="$VPS_PATH/logs/deploy.log"

# ---- Helpers ----
log()  { echo "$LOG_PREFIX $1"; }
ok()   { echo "$LOG_PREFIX [OK] $1"; }
warn() { echo "$LOG_PREFIX [WARN] $1"; }
err()  { echo "$LOG_PREFIX [ERROR] $1" >&2; }

# Append to log file
log_to_file() {
    mkdir -p "$(dirname "$DEPLOY_LOG")"
    echo "$LOG_PREFIX $1" >> "$DEPLOY_LOG"
}

# ---- 0. Lock (chong concurrent deploy) ----
if [ -f "$LOCK_FILE" ]; then
    OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        err "Another deploy is running (PID $OLD_PID). Exit."
        exit 99
    fi
    warn "Stale lock file found - removing"
    rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

echo ""
echo "================================================"
echo "  BeerPOS Auto Deploy - $TIMESTAMP"
echo "================================================"

# ---- 1. Sanity check ----
if [ ! -d "$VPS_PATH" ]; then
    err "$VPS_PATH not found. Is this run on the server?"
    exit 1
fi
ok "Server: $(hostname)  Path: $VPS_PATH"
log_to_file "Deploy started - $(date)"

# ---- 2. Phat hien cach deploy ----
HAS_NEW=0
# Check if staging directory has content (use 'find' instead of 'ls -A' for safety)
if [ -d "$NEW_PATH" ] && [ -n "$(find "$NEW_PATH" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    HAS_NEW=1
    log "[1/7] Mode: MANUAL SCP - staging directory $NEW_PATH co files"
    # Limit output to first 10 items (may be huge otherwise)
    find "$NEW_PATH" -mindepth 1 -maxdepth 1 | head -10 | while IFS= read -r f; do
        ls -la "$f" 2>/dev/null | head -1
    done
else
    log "[1/7] Mode: GIT PULL - se fetch + reset tu origin/$GIT_BRANCH"
fi

# ---- 3. Git pull (neu khong co staging) ----
if [ "$HAS_NEW" = "0" ]; then
    log "[2/7] Git pull tu origin/$GIT_BRANCH..."
    cd "$VPS_PATH"

    # Dam bao la git repo
    if [ ! -d ".git" ]; then
        err "$VPS_PATH khong phai git repo. Khong the git pull."
        err "Hay chay manual SCP deploy (deploy_local.ps1) hoac init git repo."
        exit 1
    fi

    # Check git remote co san khong
    if ! git remote get-url origin >/dev/null 2>&1; then
        err "Git remote 'origin' chua duoc cau hinh"
        exit 2
    fi

    # Cau hinh git user (can thiet cho mot so operations)
    git config user.name  "BeerPOS Deploy"     2>/dev/null || true
    git config user.email "deploy@beerpos.local" 2>/dev/null || true

    # Luu commit hien tai de so sanh
    OLD_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
    log "   Current HEAD: $OLD_COMMIT"

    # Fetch tu remote
    log "   git fetch origin $GIT_BRANCH..."
    if ! git fetch origin "$GIT_BRANCH" 2>&1 | tail -5; then
        err "git fetch FAILED. Kiem tra SSH key (github) hoac network"
        err "Test: ssh -T git@github.com"
        exit 2
    fi

    # Reset ve origin/main (hard reset de dam bao working tree khop remote)
    log "   git reset --hard origin/$GIT_BRANCH..."
    if ! git reset --hard "origin/$GIT_BRANCH" 2>&1 | tail -5; then
        err "git reset FAILED"
        exit 2
    fi

    NEW_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
    log "   New HEAD:     $NEW_COMMIT"
    if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then
        log "   Khong co commit moi (HEAD khong doi) - skip phan con lai"
        ok "Nothing to deploy - code da la moi nhat"
        log_to_file "Deploy skipped - no new commits"
        exit 0
    fi
    ok "Git pull xong: $OLD_COMMIT -> $NEW_COMMIT"
    log_to_file "Git pull: $OLD_COMMIT -> $NEW_COMMIT"
else
    log "[2/7] Skip git pull (manual mode - da co staging files)"
    cd "$VPS_PATH"
    OLD_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
fi

# ---- 4. Backup current state ----
log ""
log "[3/7] Backing up current files to $BACKUP_DIR ..."
mkdir -p "$BACKUP_DIR"

# Files can backup (gom nhom: server entry, db, views, public/js, routes)
BACKUP_FILES=(
    "server.js"
    "database.js"
    "database/migration.js"
    "package.json"
    "ecosystem.config.js"
    ".env"
    "views/qr-settings.html"
    "views/sales.html"
    "views/dashboard.html"
    "views/promo-settings.html"
    "views/customer-detail.html"
    "public/js/sales.js"
    "public/js/layout.js"
    "public/version.json"
    "routes/api/settings.js"
    "routes/api/sales.js"
)

BACKUP_COUNT=0
for f in "${BACKUP_FILES[@]}"; do
    if [ -f "$VPS_PATH/$f" ]; then
        base=$(basename "$f")
        parent=$(dirname "$f" | tr '/' '_')
        suffix="${parent}_${base}"
        cp "$VPS_PATH/$f" "$BACKUP_DIR/${suffix}.bak.$TIMESTAMP"
        BACKUP_COUNT=$((BACKUP_COUNT + 1))
    fi
done
ok "Backup xong: $BACKUP_COUNT files"

# Cleanup old backups (>50 files)
OLD_BACKUPS=$(ls -t "$BACKUP_DIR"/*.bak.* 2>/dev/null | tail -n +51 || true)
if [ -n "$OLD_BACKUPS" ]; then
    echo "$OLD_BACKUPS" | xargs -r rm -f
    log "   Cleanup: removed $(echo "$OLD_BACKUPS" | wc -l) old backups"
fi

# ---- 5. Deploy new files ----
log ""
log "[4/7] Deploying new files..."
if [ "$HAS_NEW" = "1" ]; then
    # CRITICAL: Never overwrite beer.db / database.sqlite (the actual database)
    # Also exclude sensitive / generated files
    EXCLUDE_DIRS="node_modules .git coverage .backup backups __pycache__ logs .husky .cursor deploy scripts"
    EXCLUDE_FILES="beer.db database.sqlite database.sqlite-shm database.sqlite-wal database_live.sqlite database_check.sqlite database_server.sqlite database_new.sqlite temp_restore.db package-lock.json *.bak *.pem *.key *.gz *.zip *.tar"

    cd "$NEW_PATH"

    # Use 'find' instead of 'ls -A' for safety with large directories.
    # 'find -maxdepth 1' lists only top-level (no recursion), avoids issues with:
    #   - 'ls -A' breaking on filenames with spaces/special chars
    #   - 'set -o pipefail' causing SIGPIPE on large output
    #   - command substitution size limits
    while IFS= read -r item; do
        # find in ra "./ten_file" -> strip leading "./"
        item="${item#./}"

        # Skip excluded items
        skip=0
        for ex_dir in $EXCLUDE_DIRS; do
            if [ "$item" = "$ex_dir" ]; then
                skip=1
                break
            fi
        done
        if [ "$skip" = "0" ]; then
            for ex_file in $EXCLUDE_FILES; do
                # shellcheck disable=SC2254
                case "$item" in
                    $ex_file)
                        skip=1
                        ;;
                esac
            done
        fi
        if [ "$skip" = "1" ]; then
            log "   skip:  $item (protected)"
            continue
        fi

        src="$NEW_PATH/$item"
        dst="$VPS_PATH/$item"
        if [ -d "$src" ]; then
            mkdir -p "$dst"
            # Copy contents, do not delete existing files in dst
            cp -r "$src"/. "$dst"/
            log "   dir:  $item/"
        else
            cp "$src" "$dst"
            log "   file: $item"
        fi
    done < <(find . -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)

    # Safety: NEVER touch the actual database file
    if [ -f "$NEW_PATH/database.sqlite" ] || [ -f "$NEW_PATH/beer.db" ]; then
        warn "   database file in staging - IGNORED (live DB is on server)"
    fi
else
    # Git pull mode: files da duoc reset ve dung HEAD
    cd "$VPS_PATH"
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        warn "Working tree co uncommitted changes - se bi mat khi restart:"
        git status --short | head -20
    fi
    log "   (no copy step - files o trang thai git clean)"
fi
ok "Files deployed"
log_to_file "Files deployed"

# ---- 6. Syntax check ----
log ""
log "[5/7] Syntax checking Node files..."
cd "$VPS_PATH"
SYNTAX_ERROR=0
SYNTAX_FILES=("server.js" "database.js" "database/migration.js")
for js in "${SYNTAX_FILES[@]}"; do
    if [ -f "$js" ]; then
        if ! node -c "$js" 2>/dev/null; then
            err "SYNTAX ERROR: $js"
            log "   Restoring from backup..."
            # Find latest backup with matching name
            base=$(basename "$js")
            LATEST=$(ls -t "$BACKUP_DIR"/*"${base}".bak.* 2>/dev/null | head -1 || true)
            if [ -n "$LATEST" ]; then
                cp "$LATEST" "$VPS_PATH/$js"
                ok "   Restored $js from $LATEST"
            else
                err "   No backup found for $js - manual fix needed"
            fi
            SYNTAX_ERROR=1
        else
            ok "   $js"
        fi
    fi
done

# Check all routes/*.js and middleware/*.js too (lightweight check)
for js in routes/*.js middleware/*.js; do
    if [ -f "$js" ]; then
        if ! node -c "$js" 2>/dev/null; then
            err "SYNTAX ERROR: $js"
            SYNTAX_ERROR=1
        fi
    fi
done

if [ "$SYNTAX_ERROR" = "1" ]; then
    err "Syntax errors found - deploy ABORTED"
    log_to_file "Deploy ABORTED - syntax errors"
    exit 3
fi

# ---- 7. npm install (neu package.json doi) ----
log ""
log "[6/7] Checking dependencies..."
if [ -f "$VPS_PATH/package.json" ]; then
    PKG_HASH_OLD=""
    PKG_HASH_NEW=$(sha256sum "$VPS_PATH/package.json" | cut -d' ' -f1)

    # Find latest backup of package.json
    LATEST_PKG_BAK=$(ls -t "$BACKUP_DIR"/*"package.json".bak.* 2>/dev/null | head -1 || true)
    if [ -n "$LATEST_PKG_BAK" ] && [ -f "$LATEST_PKG_BAK" ]; then
        PKG_HASH_OLD=$(sha256sum "$LATEST_PKG_BAK" | cut -d' ' -f1)
    fi

    if [ "$PKG_HASH_OLD" != "$PKG_HASH_NEW" ]; then
        log "   package.json changed - running npm install --production..."
        cd "$VPS_PATH"
        if ! npm install --production --no-audit --no-fund 2>&1 | tail -15; then
            err "npm install FAILED"
            log_to_file "Deploy FAILED - npm install error"
            exit 4
        fi
        # better-sqlite3 needs rebuild for the Node binary
        npm rebuild better-sqlite3 2>&1 | tail -5 || warn "npm rebuild better-sqlite3 skipped"
        ok "npm install xong"
        log_to_file "npm install completed"
    else
        ok "   package.json unchanged - skip npm install"
    fi
else
    warn "package.json khong tim thay - skip"
fi

# ---- 8. Bump version.json + restart PM2 + health check ----
log ""
log "[7/7] Cleanup + restart PM2..."

# Bump version.json build so browsers pick up new assets after restart
if [ -f "$VPS_PATH/public/version.json" ]; then
    BUILD_ID=$(date +%Y%m%d%H%M%S)
    node -e "
        const fs = require('fs');
        const p = process.argv[1];
        const build = process.argv[2];
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        j.build = build;
        j.date = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    " "$VPS_PATH/public/version.json" "$BUILD_ID" 2>/dev/null && log "   version.json build -> $BUILD_ID" || warn "version.json bump skipped"
fi

# Clean staging directory
if [ "$HAS_NEW" = "1" ]; then
    rm -rf "$NEW_PATH"
    log "   Removed $NEW_PATH"
fi

# Verify pm2 is installed
if ! command -v pm2 >/dev/null 2>&1; then
    err "pm2 not found. Install with: npm install -g pm2"
    exit 5
fi

# Restart PM2 - prefer ecosystem.config.js if available
log "   pm2 restart beer-pos..."
if [ -f "$VPS_PATH/ecosystem.config.js" ]; then
    if ! pm2 restart ecosystem.config.js --update-env 2>&1 | tail -10; then
        err "pm2 restart FAILED (ecosystem.config.js)"
        log_to_file "Deploy FAILED - pm2 restart error"
        exit 5
    fi
else
    if ! pm2 restart beer-pos --update-env 2>&1 | tail -10; then
        err "pm2 restart FAILED"
        log_to_file "Deploy FAILED - pm2 restart error"
        exit 5
    fi
fi

# Wait for app to come up
sleep 4

# Health check
log ""
log "=== Health check ==="
pm2 status | grep beer-pos || true

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    ok "Health: OK ($HEALTH_URL -> 200)"
    log_to_file "Health check OK"
else
    err "Health: FAILED ($HEALTH_URL -> $HTTP_CODE)"
    err "Check: pm2 logs beer-pos --lines 50"
    log_to_file "Deploy FAILED - health check returned $HTTP_CODE"
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
log_to_file "Deploy SUCCESS - $OLD_COMMIT -> $NEW_COMMIT"
