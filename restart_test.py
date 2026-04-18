import subprocess

# Restart PM2
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'cd ~/beer-pos && pm2 restart beer-pos && sleep 3 && echo "RESTARTED OK"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=30
)
print(r.stdout if r.stdout else "OK - restarted")

# Test API
r2 = subprocess.run(
    ['curl', '-s', '-L', 'http://103.75.183.57/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18'],
    capture_output=True,
    timeout=15
)
output = r2.stdout.decode('utf-8', errors='replace') if r2.stdout else ''
# Count sales entries
count = output.count('"customer_name"')
print(f"Sales returned: {count}")

# Check if we have total
import re
total_match = re.search(r'"total":\s*([0-9.]+)', output)
if total_match:
    print(f"Total revenue: {float(total_match.group(1)):,.0f} VND")
