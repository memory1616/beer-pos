import subprocess

# Debug API response more carefully
r = subprocess.run(
    ['curl', '-s', '-L',
     'http://103.75.183.57/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18'],
    capture_output=True,
    timeout=15
)
output = r.stdout.decode('utf-8', errors='replace') if r.stdout else ''

print(f"Response length: {len(output)}")
print(f"First 1000 chars:")
print(output[:1000])

# Check if it's JSON
if output.strip().startswith('{') or output.strip().startswith('['):
    print("\n==> Response is JSON")
else:
    print("\n==> Response is NOT JSON (might be HTML or error)")
