#!/bin/bash
DB=/var/www/beer-pos/database.sqlite
echo "=== cust44 full row"
sqlite3 -header -line "$DB" "SELECT id,name,keg_balance,horizontal_fridge,vertical_fridge,deposit,debt,archived FROM customers WHERE id=44;"
echo "=== all devices (any customer)"
sqlite3 -header "$DB" "SELECT id,name,type,status,customer_id,deleted FROM devices ORDER BY id;"
echo "=== devices cust44 (any status)"
sqlite3 -header "$DB" "SELECT id,name,type,status,customer_id,deleted,assigned_date FROM devices WHERE customer_id=44 OR name LIKE '%Tủ%' ORDER BY id;"
