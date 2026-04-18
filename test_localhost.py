import subprocess

# Test directly on server
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'curl -s http://localhost:3000/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18 | head -c 500'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Direct to localhost ===")
print(r.stdout if r.stdout else "No output")

# Also test nginx redirect
r2 = subprocess.run(
    ['curl', '-s', '-L', '-H', 'Host: admin.biatuoitayninh.store',
     'http://103.75.183.57/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18 | head -c 500'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("\n=== Via nginx with Host header ===")
print(r2.stdout if r2.stdout else "No output")
