import subprocess
import time
time.sleep(3)

# Test API
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'curl -s "http://localhost:3000/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
output = r.stdout if r.stdout else ''

with open('api_result.txt', 'w', encoding='utf-8', errors='replace') as f:
    f.write(output)

print(f"Response length: {len(output)}")

# Count sales
sales_count = output.count('"id"')
print(f"Sales found: {sales_count}")

# Find totals
import re
totals = re.findall(r'"total":\s*([0-9.]+)', output)
if totals:
    print(f"Totals: {totals}")

# Show snippet
print("\nSnippet:")
print(output[:300])
