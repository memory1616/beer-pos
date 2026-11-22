.mode list
.headers off
SELECT '=== SCHEMA sales:';
SELECT sql FROM sqlite_master WHERE type='table' AND name='sales';
SELECT '=== TABLES delivery/region:';
SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'delivery%' OR name LIKE 'business_reg%' OR name LIKE 'cron%' OR name LIKE '%schedule%');
