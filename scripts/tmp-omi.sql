.mode list
.headers off
SELECT '=== COUNT: ' || COUNT(*) FROM debt_notifications;
SELECT '=== STATUS: ' || status || ' = ' || COUNT(*) FROM debt_notifications GROUP BY status;
SELECT '=== ERRORS:';
SELECT id || ' | ' || created_at || ' | ' || COALESCE(customer_name,'-') || ' | grp=' || COALESCE(group_id,'-') || ' | ' || event_type || ' | ' || status
  || ' | msg=' || substr(COALESCE(message,''),1,40)
  || ' | err=' || substr(COALESCE(error,''),1,220)
FROM debt_notifications ORDER BY id DESC LIMIT 15;
SELECT '=== SETTINGS:';
SELECT key || ' = ' || CASE WHEN key = 'omicall_api_key' THEN substr(value,1,6) || '***' ELSE value END FROM settings WHERE key LIKE 'omicall%' OR key LIKE 'debt_notify%';
SELECT '=== GROUPS:';
SELECT customer_id || ' | ' || COALESCE(customer_name,'-') || ' | ' || platform || ' | ' || group_id FROM debt_customer_groups ORDER BY id DESC LIMIT 20;
