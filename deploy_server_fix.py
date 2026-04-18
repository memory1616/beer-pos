import subprocess

# Copy server.js
r = subprocess.run(
    ['scp', '-o', 'StrictHostKeyChecking=no',
     'D:/Beer/server.js',
     'root@103.75.183.57:~/beer-pos/server.js'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=30
)
print("Copy:", r.returncode)

# Restart
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'pm2 restart beer-pos'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=30
)
print("Restart:", r2.returncode)

# Wait
import time
time.sleep(5)

# Test API
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'curl -s "http://localhost:3000/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18" > /tmp/api_result2.txt'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("API test:", r3.returncode)

# Copy result
r4 = subprocess.run(
    ['scp', '-o', 'StrictHostKeyChecking=no',
     'root@103.75.183.57:/tmp/api_result2.txt',
     'D:/Beer/'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("Copy result:", r4.returncode)
