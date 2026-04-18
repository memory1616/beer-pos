import subprocess

# Check if file was copied correctly
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'grep -n "custom" ~/beer-pos/routes/report.js'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== File content ===")
print(r.stdout)

# Check PM2 status
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'pm2 status'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== PM2 status ===")
print(r2.stdout)

# Try to restart
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'pm2 restart beer-pos && sleep 2 && pm2 status'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=30
)
print("=== PM2 restart ===")
print(r3.stdout)
