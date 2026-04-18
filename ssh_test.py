import subprocess
import os

# First test basic SSH connection
print("Testing basic SSH connection...")
test_cmd = [
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    '-v',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    'root@103.75.183.57',
    'echo "Connection test"'
]

try:
    result = subprocess.run(
        test_cmd,
        capture_output=True,
        text=True,
        timeout=15
    )
    print("STDOUT:", result.stdout)
    print("STDERR:", result.stderr[:500] if result.stderr else "")
except subprocess.TimeoutExpired:
    print("SSH connection timed out - server may not be reachable or SSH not available")
except Exception as e:
    print(f"Error: {e}")
