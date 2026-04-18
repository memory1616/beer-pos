import subprocess
import json

# Test the report API with today filter
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'curl -s "http://localhost:3000/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18" | head -c 1000'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Report API response ===")
print(r.stdout)

# Test with curl from local
r2 = subprocess.run(
    ['curl', '-s', 'http://103.75.183.57/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18'],
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Curl from local ===")
print(r2.stdout[:500] if r2.stdout else r2.stderr)
