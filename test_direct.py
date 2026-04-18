import subprocess

# Test API directly
r = subprocess.run(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57',
     'curl -s "http://localhost:3000/report/data?type=custom&startDate=2026-04-18&endDate=2026-04-18"'],
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=20
)
output = r.stdout if r.stdout else ''

# Save to file
with open('api_direct.txt', 'w', encoding='utf-8', errors='replace') as f:
    f.write(output)

print(f"Response length: {len(output)}")
print(f"First 500 chars:")
print(output[:500])
