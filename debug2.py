import subprocess

# Simple test to see what's happening
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 -header -column database.sqlite "SELECT id, date, total, type FROM sales WHERE date LIKE \\"2026-04-18%\\" ORDER BY id DESC;"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Sales on 2026-04-18 ===")
print(r.stdout)
print(r.stderr)

# Count with LIKE
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT COUNT(*) as cnt FROM sales WHERE date LIKE \\"2026-04-18%\\" AND type=\\"sale\\";"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Count with LIKE ===")
print(r2.stdout)

# Sum with LIKE
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT SUM(total) as sum FROM sales WHERE date LIKE \\"2026-04-18%\\" AND type=\\"sale\\";"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Sum with LIKE ===")
print(r3.stdout)

# Check what query dashboard.js uses
r4 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT COUNT(*) FROM sales WHERE type=\\"sale\\" AND archived=0 AND date(date)=\\"2026-04-18\\";"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Query like dashboard uses ===")
print(r4.stdout)
