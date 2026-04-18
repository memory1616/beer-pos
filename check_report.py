import subprocess

# Check report page data
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT * FROM sales WHERE date >= \\"2026-04-18\\" AND date < \\"2026-04-19\\";"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== ALL sales today (all fields) ===")
print(r.stdout)

# Check what report API returns
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && grep -n "today" routes/report.js | head -20'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Report route - today references ===")
print(r2.stdout)
