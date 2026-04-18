import subprocess
import time

# Check if server is running
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'pm2 jlist | grep -o "\"status\":\"[^\"]*\"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("PM2 status:", r.stdout.strip() if r.stdout else "No output")

# Check errors
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cat ~/beer-pos/logs/err.log 2>/dev/null | tail -20'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("\nError log:", r2.stdout[-1000:] if r2.stdout else "No errors")

# Wait a bit more
time.sleep(5)

# Try again
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'curl -s "http://localhost:3000/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18" | head -c 500'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("\nAPI response:", r3.stdout[:300] if r3.stdout else "Empty")
