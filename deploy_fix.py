import subprocess

# Copy the fixed file to server
r = subprocess.run(
    ['scp', '-o', 'StrictHostKeyChecking=no',
     'D:/Beer/routes/report.js',
     'root@103.75.183.57:~/beer-pos/routes/report.js'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=30
)
print("=== Copy result ===")
print(r.stdout)
print(r.stderr)

# Restart PM2 on server
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'pm2 restart beer-pos'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=30
)
print("=== PM2 restart ===")
print(r2.stdout)
print(r2.stderr)

# Wait and test
import time
time.sleep(3)

# Verify the fix
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     "cd ~/beer-pos && grep -A5 'type ===' routes/report.js"],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Verify fix ===")
print(r3.stdout)
