import subprocess

# Check the exact date values - all dates
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT id, date, length(date) as len FROM sales ORDER BY id DESC LIMIT 10;"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== All dates with length ===")
print(r.stdout)

# Check for today's sales
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT id, date, total, type FROM sales WHERE date >= \\"2026-04-18\\" AND date < \\"2026-04-19\\" ORDER BY id DESC;"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Sales with >= and < ===")
print(r2.stdout)

# Check how many with date(date) work
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT id, date, date(date) as d, typeof(date(date)) FROM sales ORDER BY id DESC LIMIT 10;"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== date(date) result ===")
print(r3.stdout)
