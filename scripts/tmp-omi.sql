.mode list
.headers off
SELECT '=== LINK TEST GROUP vao khach Nhi Nho (#43):';
INSERT OR REPLACE INTO debt_customer_groups (customer_id, platform, group_id, group_name, status)
VALUES (43, 'zalo_personal', '6afe6913fca59218a5d662b0', '[NHOM TEST] Bia Tươi Gia Huy, binhnguyen, Tùng', 'active');
SELECT '=== KET QUA:';
SELECT id || ' | cust=' || customer_id || ' | ' || group_id || ' | ' || group_name || ' | ' || status
FROM debt_customer_groups WHERE group_id = '6afe6913fca59218a5d662b0';
