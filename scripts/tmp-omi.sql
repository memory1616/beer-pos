.mode list
.headers off
SELECT '=== SCHEMA debt_notifications:';
SELECT sql FROM sqlite_master WHERE type='table' AND name='debt_notifications';
SELECT '=== SCHEMA debt_customer_groups:';
SELECT sql FROM sqlite_master WHERE type='table' AND name='debt_customer_groups';
SELECT '=== FAILED ROWS:';
SELECT * FROM debt_notifications WHERE status='failed' ORDER BY id DESC LIMIT 5;
