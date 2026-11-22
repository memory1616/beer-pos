.mode list
.headers off
SELECT '=== GROUP 6afe6913fca59218a5d662b0:';
SELECT id || ' | cust=' || customer_id || ' | ' || platform || ' | ' || group_id || ' | ' || COALESCE(group_name,'-') || ' | ' || status
FROM debt_customer_groups WHERE group_id = '6afe6913fca59218a5d662b0';
SELECT '=== ALL GROUPS (id/name):';
SELECT id || ' | cust=' || customer_id || ' | ' || group_id || ' | ' || COALESCE(group_name,'-') FROM debt_customer_groups ORDER BY id DESC;
