.mode list
.headers off
SELECT '=== TEST GROUP IN DB:';
SELECT id || ' | cust=' || customer_id || ' | ' || platform || ' | ' || group_id || ' | ' || COALESCE(group_name,'-') || ' | ' || status
FROM debt_customer_groups WHERE group_id = '6afe6913fca59218a5d662b0';
SELECT '=== CUSTOMERS:';
SELECT id || ' | ' || name FROM customers WHERE id IN (7, 34, 43, 50);
