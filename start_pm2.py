import subprocess
import time

# Check PM2
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'pm2 list'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("PM2:", r.stdout[:500] if r.stdout else "No output")

# Try start
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && pm2 start server.js'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=30
)
print("Start:", r2.stdout[:500] if r2.stdout else "OK")

# Wait
time.sleep(5)

# Test
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'curl -s "http://localhost:3000/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18" | head -c 500'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("\nAPI:", r3.stdout[:300] if r3.stdout else "Empty")
