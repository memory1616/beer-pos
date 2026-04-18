import subprocess

# Test with redirect follow
r = subprocess.run(
    ['curl', '-s', '-L', 'http://103.75.183.57/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18'],
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Report API (with redirect) ===")
print(r.stdout[:2000] if r.stdout else r.stderr)

# Also check the pm2 logs
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'pm2 logs beer-pos --lines 20 --nostream'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== PM2 logs ===")
print(r2.stdout[-2000:] if r2.stdout else r2.stderr)
