import subprocess

# Debug API response
r = subprocess.run(
    ['curl', '-s', '-L',
     'http://103.75.183.57/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18'],
    capture_output=True,
    timeout=15
)
output = r.stdout.decode('utf-8', errors='replace') if r.stdout else ''

# Write to file
with open('api_response.txt', 'w', encoding='utf-8') as f:
    f.write(output)

# Count sales
sales_count = output.count('"customer_name"')
print(f"Response length: {len(output)}")
print(f"Sales count: {sales_count}")

# Look for revenue
import re
totals = re.findall(r'"total":\s*([0-9.]+)', output)
if totals:
    print(f"Totals found: {totals}")

# Look for profit
profits = re.findall(r'"profit":\s*([0-9.]+)', output)
if profits:
    print(f"Profits found: {profits[:5]}")
