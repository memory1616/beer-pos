import subprocess

# Just restart PM2
commands = [
    'cd ~/beer-pos && pm2 restart beer-pos',
]

r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57', ' && '.join(commands)],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("Restart:", r.returncode)

# Wait
import time
time.sleep(5)

# Test
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'curl -s http://localhost:3000/report/data?type=custom&startDate=2026-04-18 2>&1 | grep -c "sales" || echo "0"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("Sales found:", r2.stdout)
