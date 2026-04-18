import subprocess

# Run server directly to see error
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && node server.js 2>&1 | head -30'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=30
)
print("=== Direct node output ===")
print(r.stdout[:2000] if r.stdout else "No output")
print(r.stderr[:500] if r.stderr else "")
