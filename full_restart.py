import subprocess

# Full PM2 restart
commands = [
    'pm2 stop all',
    'pm2 delete all',
    'cd ~/beer-pos && pm2 start ecosystem.config.js',
    'sleep 3',
    'pm2 list'
]

cmd = ' && '.join(commands)
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57', cmd],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=60
)
print("PM2 output:", r.stdout[:1000] if r.stdout else "No output")

# Check listening ports
r2 = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'ss -tlnp | grep 3000'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
print("\nPort 3000:", r2.stdout if r2.stdout else "Not listening")
