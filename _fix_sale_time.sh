#!/bin/bash
# Fix sale_time column on server
cd ~/beer-pos

# Check if column exists
HAS_COL=$(sqlite3 beer.db "PRAGMA table_info(sales);" | grep -c "sale_time" || true)
echo "Has sale_time: $HAS_COL"

if [ "$HAS_COL" = "0" ]; then
    echo "Adding sale_time column..."
    sqlite3 beer.db "ALTER TABLE sales ADD COLUMN sale_time TEXT;"
    echo "Column added!"
fi

# Update existing sales with 00:00 if NULL
UPDATED=$(sqlite3 beer.db "UPDATE sales SET sale_time = '00:00:00' WHERE sale_time IS NULL; SELECT changes();")
echo "Updated $UPDATED rows with default time"

# Show recent sales
echo -e "\nRecent sales:"
sqlite3 beer.db "SELECT id, date, sale_time FROM sales ORDER BY id DESC LIMIT 3;"

# Restart PM2
echo -e "\nRestarting PM2..."
pm2 restart beer-pos
echo "Done!"
