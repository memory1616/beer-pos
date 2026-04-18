import subprocess

# Check if server is listening on port 3000
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'netstat -tlnp | grep 3000'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("=== Port 3000 status ===")
print(r.stdout if r.stdout else "Not listening")

# Check PM2 detailed status
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'pm2 show beer-pos | grep -E "status|port|uptime"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("\n=== PM2 Details ===")
print(r2.stdout if r2.stdout else "No output")

# Try curl with verbose
r3 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'curl -v http://localhost:3000/ 2>&1 | head -20'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("\n=== Curl verbose ===")
print(r3.stdout[:1000] if r3.stdout else "No output")
