import subprocess

# Query recent sales
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT id, date, total, type, status FROM sales ORDER BY id DESC LIMIT 15;"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== RECENT SALES ===")
print(r.stdout)

# Query today's sales
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT COUNT(*) as cnt, SUM(total) as sum FROM sales WHERE date(date) = date(\"now\", \"+7 hours\") AND type = \"sale\";"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== TODAY SALES (with +7 hours) ===")
print(r2.stdout)

# Query today's sales with localtime
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && sqlite3 database.sqlite "SELECT COUNT(*) as cnt, SUM(total) as sum FROM sales WHERE date(date) = date(\"now\", \"localtime\") AND type = \"sale\";"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== TODAY SALES (with localtime) ===")
print(r3.stdout)

# Check current date on server
r4 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'date'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== SERVER DATE ===")
print(r4.stdout)
