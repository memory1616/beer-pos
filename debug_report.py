import subprocess

# Test the exact query from report.js
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT s.id, s.date, s.total, s.archived, s.customer_id FROM sales s WHERE s.archived = 0 AND date(datetime(s.date, \\"+7 hours\\")) >= date(\\"2026-04-18\\") AND date(datetime(s.date, \\"+7 hours\\")) <= date(\\"2026-04-18\\") AND (s.status IS NULL OR s.status != \\"returned\\") ORDER BY s.date DESC;"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Report query result (2026-04-18) ===")
print(r.stdout)

# Sum the result
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT COUNT(*) as cnt, SUM(total) as sum FROM sales WHERE archived = 0 AND date(datetime(date, \\"+7 hours\\")) >= date(\\"2026-04-18\\") AND date(datetime(date, \\"+7 hours\\")) <= date(\\"2026-04-18\\") AND (status IS NULL OR status != \\"returned\\");"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Count and Sum ===")
print(r2.stdout)

# Check datetime calculation
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT id, date, datetime(date, \\"+7 hours\\") as vn_date, date(datetime(date, \\"+7 hours\\")) as vn_date_only FROM sales WHERE date >= \\"2026-04-18\\" AND date < \\"2026-04-19\\" ORDER BY id DESC;"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Date with +7 hours ===")
print(r3.stdout)
