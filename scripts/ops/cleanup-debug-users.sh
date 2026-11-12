#!/usr/bin/env bash
# Xóa tài khoản debug còn sót trên production + session của admin cũ.
set -uo pipefail
cd /var/www/beer-pos

echo '--- trước khi xóa ---'
sqlite3 -header database.sqlite "SELECT id, username, role, created_at FROM app_users"

for u in tmp_verify_01 prod_verify_452586; do
  n=$(sqlite3 database.sqlite "SELECT COUNT(*) FROM app_users WHERE username='$u'")
  if [ "$n" -gt 0 ]; then
    sqlite3 database.sqlite "DELETE FROM auth_sessions WHERE app_user_id IN (SELECT id FROM app_users WHERE username='$u')"
    sqlite3 database.sqlite "DELETE FROM app_users WHERE username='$u'"
    echo "đã xóa user: $u"
  else
    echo "không có user: $u"
  fi
done

echo
echo '--- sau khi xóa ---'
sqlite3 -header database.sqlite "SELECT id, username, role, created_at FROM app_users"

echo
echo '--- xóa session ADMIN cũ (đăng nhập bằng mật khẩu cũ) ---'
sqlite3 database.sqlite "DELETE FROM auth_sessions WHERE role='ADMIN'"
echo "sessions còn lại: $(sqlite3 database.sqlite 'SELECT COUNT(*) FROM auth_sessions')"

echo
echo '--- sessions theo user ---'
sqlite3 -header database.sqlite "SELECT u.username, COUNT(s.token) AS sessions FROM app_users u LEFT JOIN auth_sessions s ON s.app_user_id=u.id GROUP BY u.id"

echo
echo '--- integrity ---'
sqlite3 database.sqlite "PRAGMA integrity_check"
sqlite3 database.sqlite "PRAGMA foreign_key_check" | wc -l
