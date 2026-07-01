#!/bin/bash
# ============================================================
# Migration: Add tier column to customers table
# ============================================================
# Detect DB path automatically (database.sqlite in project root)

set -e

VPS_PATH="$HOME/beer-pos"

# Find DB (priority: env > database.sqlite > data/beerpos.db)
if [ -n "$DB_PATH" ]; then
  DB="$DB_PATH"
elif [ -f "$VPS_PATH/database.sqlite" ]; then
  DB="$VPS_PATH/database.sqlite"
elif [ -f "$VPS_PATH/data/beerpos.db" ]; then
  DB="$VPS_PATH/data/beerpos.db"
else
  echo "ERROR: Cannot find database. Set DB_PATH or place DB in $VPS_PATH/"
  exit 1
fi

echo "================================================"
echo "  Migration: Add tier column to customers"
echo "================================================"
echo "Database: $DB"

# Check if column already exists
HAS_COL=$(sqlite3 "$DB" "PRAGMA table_info(customers);" 2>/dev/null | grep -c " tier " || true)
if [ "$HAS_COL" -gt "0" ]; then
  echo "  Column 'tier' already exists - skip"
else
  echo "  Adding column 'tier'..."
  sqlite3 "$DB" "ALTER TABLE customers ADD COLUMN tier TEXT DEFAULT 'normal';"
  if [ $? -eq 0 ]; then
    echo "  OK: column added"
  else
    echo "  FAILED"
    exit 1
  fi
fi

# Verify
echo ""
echo "  Sample rows:"
sqlite3 "$DB" "SELECT id, name, tier FROM customers LIMIT 3;" 2>&1

echo ""
echo "  Restarting PM2..."
pm2 restart beer-pos --update-env

echo ""
echo "  Migration complete"