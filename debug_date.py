import subprocess

# Check the date format in database vs current date
queries = [
    # Current date on server
    'date("now")',
    # Date with +7 hours
    'date("now", "+7 hours")',
    # Date from sales
    'SELECT date FROM sales ORDER BY id DESC LIMIT 5;',
    # Try matching
    'SELECT COUNT(*) FROM sales WHERE date(date) = "2026-04-18" AND type = "sale";',
    # Try with different format
    'SELECT COUNT(*) FROM sales WHERE date = "2026-04-18";',
    # Try to see what date is being stored
    'SELECT id, date, typeof(date) FROM sales ORDER BY id DESC LIMIT 5;',
    # Check strftime
    "SELECT strftime('%Y-%m-%d', date) FROM sales ORDER BY id DESC LIMIT 5;",
    # Compare
    'SELECT id, date, strftime("%Y-%m-%d", "now") as server_now, strftime("%Y-%m-%d", "now", "+7 hours") as server_now_plus7 FROM sales ORDER BY id DESC LIMIT 3;',
]

for q in queries:
    r = subprocess.run(
        ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
         f'cd ~/beer-pos && sqlite3 database.sqlite "{q}"'],
        input='Zxcv@1234\n',
        capture_output=True,
        text=True,
        timeout=20
    )
    print(f"=== {q[:60]}... ===" if len(q) > 60 else f"=== {q} ===")
    print(r.stdout)
