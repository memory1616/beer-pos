import subprocess

# Check which database is being used by the app
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && grep -n "database" database.js | head -20'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Database config ===")
print(r.stdout)

# Check pm2 env
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'pm2 show beer-pos | grep -E "script path|env"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== PM2 config ===")
print(r2.stdout)

# Check all sqlite files
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'find ~/beer-pos -name "*.sqlite*" -ls'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== All SQLite files ===")
print(r3.stdout)

# Check size of database.sqlite vs database/ folder
r4 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'ls -la ~/beer-pos/*.sqlite* ~/beer-pos/database/'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== DB file sizes ===")
print(r4.stdout)
