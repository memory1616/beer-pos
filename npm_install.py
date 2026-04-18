import subprocess

# Full npm install
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && npm install'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=180
)
print("npm install:", r.returncode)
if r.stderr:
    print("Errors:", r.stderr[-500:])

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
