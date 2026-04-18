import subprocess

# Get PM2 error logs
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cat ~/beer-pos/logs/err.log | tail -50'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Error logs ===")
print(r.stdout[-2000:] if r.stdout else "No error log")

# Get PM2 output logs
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cat ~/beer-pos/logs/out.log | tail -50'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("\n=== Output logs ===")
print(r2.stdout[-2000:] if r2.stdout else "No output log")

# Try API again
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'curl -s "http://localhost:3000/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18" | wc -c'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("\n=== API response size ===")
print(r3.stdout if r3.stdout else "0")
