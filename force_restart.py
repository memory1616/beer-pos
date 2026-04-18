import subprocess

# Force stop and start PM2
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && pm2 stop beer-pos && sleep 1 && pm2 start ecosystem.config.js && sleep 3 && pm2 list'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=30
)
print("=== PM2 restart ===")
print(r.stdout if r.stdout else "OK")

# Check server response
r2 = subprocess.run(
    ['curl', '-s', '-H', 'Accept: application/json',
     'http://103.75.183.57/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18'],
    capture_output=True,
    timeout=15
)
output = r2.stdout.decode('utf-8', errors='replace') if r2.stdout else ''

# Write to file
with open('server_response.txt', 'w', encoding='utf-8') as f:
    f.write(output)

print(f"Response length: {len(output)}")
print(f"First 200 chars: {output[:200]}")
