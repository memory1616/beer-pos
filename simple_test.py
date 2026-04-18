import subprocess

# Simple test - check if server responds
r = subprocess.run(
    ['curl', '-s', '-w', '%{http_code}', '-o', 'NUL',
     'http://103.75.183.57/'],
    capture_output=True,
    timeout=10
)
print("Homepage status:", r.stdout)

# Check report API count
r2 = subprocess.run(
    ['curl', '-s', '-L',
     'http://103.75.183.57/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18'],
    capture_output=True,
    timeout=15
)
output = r2.stdout
# Extract sales count
import re
sales_match = re.search(r'"sales"\s*:\s*\[(.*?)\]', output, re.DOTALL)
if sales_match:
    items = sales_match.group(1)
    count = items.count('"id"')
    print("Sales count today:", count)

# Extract total revenue
total_match = re.search(r'"total"[:\s]*(\d+)', output)
if total_match:
    print("Total revenue found in response")

# Show raw snippet
print("\nRaw response snippet:")
print(output[:500] if output else "No response")
