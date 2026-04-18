import subprocess

# Check node version
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'node --version && npm --version && which node'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("Versions:", r.stdout.strip() if r.stdout else "N/A")

# Check better-sqlite3
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'ls -la ~/beer-pos/node_modules/better-sqlite3/build/Release/'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("better-sqlite3 build:", r2.stdout if r2.stdout else "No output")

# Try to load better-sqlite3
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && node -e "require(\'better-sqlite3\'); console.log(\'OK\')"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("better-sqlite3 test:", r3.stdout.strip() if r3.stdout else "FAIL")
print(r3.stderr[:200] if r3.stderr else "")
