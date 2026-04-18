import subprocess

ssh_cmd = [
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'PreferredAuthentications=password',
    '-o', 'PubkeyAuthentication=no',
    'root@103.75.183.57',
    'cd ~/beer-pos && ls -la && sqlite3 database.sqlite "SELECT id, date, total, type FROM sales ORDER BY id DESC LIMIT 15;"'
]

result = subprocess.run(
    ssh_cmd,
    input='Zxcv@1234\n',
    capture_output=True,
    text=True,
    timeout=30
)
print("STDOUT:", result.stdout)
print("STDERR:", result.stderr)
