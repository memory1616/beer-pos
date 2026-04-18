import subprocess

# Check sales TODAY - only non-archived
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 -header -column database.sqlite "SELECT id, date, total, type, archived FROM sales WHERE date >= \\"2026-04-18\\" AND date < \\"2026-04-19\\" ORDER BY id DESC;"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== ALL sales today (including archived) ===")
print(r.stdout)

# Count non-archived sales today
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT COUNT(*) as non_archived FROM sales WHERE date >= \\"2026-04-18\\" AND date < \\"2026-04-19\\" AND archived = 0 AND type = \\"sale\\";"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Non-archived sales count ===")
print(r2.stdout)

# Sum non-archived sales today
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT SUM(total) as sum FROM sales WHERE date >= \\"2026-04-18\\" AND date < \\"2026-04-19\\" AND archived = 0 AND type = \\"sale\\";"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Non-archived sales sum ===")
print(r3.stdout)

# Check archived sales today
r4 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 -header -column database.sqlite "SELECT id, date, total, type, archived FROM sales WHERE date >= \\"2026-04-18\\" AND date < \\"2026-04-19\\" AND archived = 1;"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Archived sales today ===")
print(r4.stdout)
