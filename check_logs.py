import subprocess

# Check PM2 logs
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'pm2 logs beer-pos --lines 30 --nostream 2>&1 | tail -50'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== PM2 Logs ===")
print(r.stdout[-2000:] if r.stdout else "No output")
print(r.stderr[-500:] if r.stderr else "")

# Check if server is running
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'pm2 jlist'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("\n=== PM2 Status ===")
print(r2.stdout[-500:] if r2.stdout else "No output")
