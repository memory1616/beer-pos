.mode list
.headers off
SELECT '=== SENT ROWS:';
SELECT id || ' | ' || created_at || ' | ' || COALESCE(customer_name,'-') || ' | grp=' || COALESCE(group_id,'-') || ' | ' || event_type || ' | ' || status || ' | err=' || COALESCE(error,'')
FROM debt_notifications WHERE status='sent' ORDER BY id DESC LIMIT 12;
SELECT '=== ALL GROUPS:';
SELECT id || ' | cust=' || customer_id || ' | ' || platform || ' | ' || group_id || ' | ' || COALESCE(group_name,'-') || ' | ' || status
FROM debt_customer_groups ORDER BY id DESC LIMIT 25;
