#!/usr/bin/env bash
# Xoá cascade các bảng con trỏ tới driver_staff đã bị xoá.
# Lưu ý: cột FK là `driver_id` (không phải driver_staff_id).
set -uo pipefail
cd /var/www/beer-pos

echo '=== FK vi phạm hiện tại ==='
sqlite3 database.sqlite "PRAGMA foreign_key_check"

echo
echo '=== dòng salary nào trỏ tới driver_staff đã xoá ==='
sqlite3 -header database.sqlite "SELECT s.id, s.driver_id, s.year, s.month, s.total, s.status, s.created_at, (SELECT COUNT(*) FROM driver_staff d WHERE d.id=s.driver_id) AS driver_exists FROM driver_monthly_salary s"

echo
echo '=== xoá ==='
sqlite3 database.sqlite "DELETE FROM driver_monthly_salary WHERE driver_id NOT IN (SELECT id FROM driver_staff)"

echo
echo '=== FK check lại ==='
sqlite3 database.sqlite "PRAGMA foreign_key_check"
echo "số dòng FK vi phạm: $(sqlite3 database.sqlite 'PRAGMA foreign_key_check' | wc -l)"
echo '=== integrity ==='
sqlite3 database.sqlite "PRAGMA integrity_check"

echo
echo '=== dữ liệu nghiệp vụ không đổi? ==='
sqlite3 database.sqlite "SELECT 'sales_active=' || COUNT(*) FROM sales WHERE archived=0"
sqlite3 database.sqlite "SELECT 'sales_total=' || COUNT(*) FROM sales"
sqlite3 database.sqlite "SELECT 'customers=' || COUNT(*) FROM customers"
sqlite3 database.sqlite "SELECT 'revenue=' || IFNULL(SUM(total),0) FROM sales WHERE archived=0"
sqlite3 database.sqlite "SELECT 'driver_staff=' || COUNT(*) FROM driver_staff"
sqlite3 database.sqlite "SELECT 'salary_rows=' || COUNT(*) FROM driver_monthly_salary"
sqlite3 database.sqlite "SELECT 'salary_kept=' || COUNT(*) FROM driver_monthly_salary WHERE driver_id IN (SELECT id FROM driver_staff)"
