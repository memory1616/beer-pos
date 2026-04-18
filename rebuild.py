import subprocess

# Rebuild better-sqlite3
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && npm rebuild better-sqlite3'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=120
)
print("=== Rebuild result ===")
print(r.stdout[-1000:] if r.stdout else "No output")
print(r.stderr[-1000:] if r.stderr else "")

# Restart PM2
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'pm2 restart beer-pos'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=30
)
print("\n=== PM2 restart ===")
print(r2.stdout if r2.stdout else "OK")
