import subprocess

# Save to file on server
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'curl -s "http://localhost:3000/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18" > /tmp/api_result.txt && wc -c /tmp/api_result.txt && head -c 500 /tmp/api_result.txt'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("Result:", r.stdout if r.stdout else "No output")

# Copy file back
r2 = subprocess.run(
    ['scp', '-o', 'StrictHostKeyChecking=no',
     'root@103.75.183.57:/tmp/api_result.txt',
     'D:/Beer/'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("Copy:", r2.returncode)
