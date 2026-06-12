#!/bin/bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/beer-pos}"
BACKUP_ROOT="${DEPLOY_BACKUP_DIR:-$APP_DIR/.deploy-backups}"
BRANCH="${DEPLOY_BRANCH:-main}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"

mkdir -p "$BACKUP_ROOT"
cd "$APP_DIR"

backup_worktree_if_needed() {
  local has_changes=""
  has_changes="$(git status --porcelain)"

  if [ -z "$has_changes" ]; then
    echo "=== Working tree clean ==="
    return 0
  fi

  echo "=== Backing up local changes ==="
  mkdir -p "$BACKUP_DIR"

  git status --short > "$BACKUP_DIR/status.txt"
  git diff > "$BACKUP_DIR/working.diff"
  git diff --staged > "$BACKUP_DIR/staged.diff"

  git status --porcelain -z | while IFS= read -r -d '' entry; do
    local path="${entry:3}"
    [ -z "$path" ] && continue

    if [[ "$path" == *" -> "* ]]; then
      path="${path##* -> }"
    fi

    if [[ "$path" == .deploy-backups/* || "$path" == .deploy-backups ]]; then
      continue
    fi

    if [ -e "$path" ]; then
      mkdir -p "$BACKUP_DIR/files/$(dirname "$path")"
      cp -a "$path" "$BACKUP_DIR/files/$path"
    fi
  done

  git reset --hard "origin/$BRANCH"
  git clean -fd

  echo "Backed up changes to $BACKUP_DIR"
}

echo "=== Fetching latest code ==="
git fetch origin "$BRANCH"

backup_worktree_if_needed

echo "=== Syncing to origin/$BRANCH ==="
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "=== Installing dependencies ==="
npm ci --omit=dev

echo "=== Rebuilding native modules (better-sqlite3) ==="
npm rebuild better-sqlite3

echo "=== Restarting PM2 ==="
pm2 restart beer-pos

echo "=== Waiting for app startup ==="
sleep 3

echo "=== Smoke test localhost /login ==="
curl -fsS -I http://127.0.0.1:3000/login > /dev/null

echo "=== Ensuring nginx is running ==="
if ! systemctl is-active --quiet nginx; then
  systemctl start nginx
fi

echo "=== Smoke test public /login ==="
curl -fkSs -I https://admin.biatuoitayninh.store/login > /dev/null

echo "=== Deploy complete ==="
