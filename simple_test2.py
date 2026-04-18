import subprocess
import re

# Check report API
r = subprocess.run(
    ['curl', '-s', '-L', 'http://103.75.183.57/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18'],
    capture_output=True,
    timeout=15
)

output = r.stdout.decode('utf-8', errors='ignore') if r.stdout else ''

# Count sales
sales_count = output.count('"id"')
print(f"Sales count in response: {sales_count}")

# Find total
total_match = re.search(r'"total"\s*:\s*([0-9.]+)', output)
if total_match:
    print(f"Total found: {total_match.group(1)}")

# Show first 800 chars
print("\nResponse (first 800 chars):")
print(output[:800])
