#!/bin/bash
# ============================================================
# BeerPos Database Backup Script
# - Dump SQLite database using safe online backup API
# - Compress with gzip
# - Keep last 7 backups (server-side)
# - Reports file size + duration
# ============================================================

set -euo pipefail

# --- Config ---
APP_DIR="/var/www/beer-pos"
DB_FILE="$APP_DIR/database.sqlite"
BACKUP_DIR="$APP_DIR/backups"
LOG_FILE="$APP_DIR/logs/backup.log"
KEEP_COUNT=7

# --- Ensure dirs ---
mkdir -p "$BACKUP_DIR" "$APP_DIR/logs"

# --- Logging ---
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "========================================="
log "Backup started"

# --- Validate source DB ---
if [[ ! -f "$DB_FILE" ]]; then
    log "ERROR: Database file not found: $DB_FILE"
    exit 1
fi

DB_SIZE=$(du -h "$DB_FILE" | cut -f1)
log "Source DB: $DB_FILE ($DB_SIZE)"

# --- Generate filename ---
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
BACKUP_FILE="$BACKUP_DIR/database_${TIMESTAMP}.sqlite.gz"

# --- SQLite online backup (.backup is atomic/safe) ---
TMP_SQLITE="$BACKUP_DIR/.tmp_${TIMESTAMP}.sqlite"
START=$(date +%s)

log "Running sqlite3 .backup..."
sqlite3 "$DB_FILE" ".backup '$TMP_SQLITE'"

# --- Verify backup integrity ---
INTEGRITY=$(sqlite3 "$TMP_SQLITE" "PRAGMA integrity_check;" 2>&1 || echo "FAIL")
if [[ "$INTEGRITY" != "ok" ]]; then
    log "ERROR: Integrity check failed: $INTEGRITY"
    rm -f "$TMP_SQLITE"
    exit 1
fi

# --- Compress ---
log "Compressing..."
gzip -9 -c "$TMP_SQLITE" > "$BACKUP_FILE"
rm -f "$TMP_SQLITE"

END=$(date +%s)
DUR=$((END - START))
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)

log "Backup SUCCESS: $BACKUP_FILE ($BACKUP_SIZE) in ${DUR}s"

# --- Cleanup old backups (keep last $KEEP_COUNT) ---
cd "$BACKUP_DIR"
ls -t database_*.sqlite.gz 2>/dev/null | tail -n +$((KEEP_COUNT + 1)) | while read -r OLD; do
    log "Removing old backup: $OLD"
    rm -f "$OLD"
done

# --- Summary ---
TOTAL=$(ls -1 database_*.sqlite.gz 2>/dev/null | wc -l)
log "Total backups retained: $TOTAL"
ls -lh "$BACKUP_DIR"/database_*.sqlite.gz | tail -n 5
log "========================================="

# --- Output full path for cron/scripting consumers ---
echo "$BACKUP_FILE"