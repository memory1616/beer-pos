import subprocess
import pty
import os
import select
import time

# Create a pseudo-terminal
master, slave = pty.openpty()

# Start SSH process
proc = subprocess.Popen(
    ['C:\\Windows\\System32\\OpenSSH\\ssh.exe',
     '-o', 'StrictHostKeyChecking=no',
     'root@103.75.183.57',
     'cd ~/beer-pos && pwd && ls -la'],
    stdin=slave,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    close_fds=True
)

os.close(slave)

# Send password after prompt
time.sleep(2)
password_sent = False
output = b''

while True:
    ready, _, _ = select.select([proc.stdout], [], [], 1)
    if ready:
        chunk = os.read(master, 4096)
        output += chunk
        print(chunk.decode('utf-8', errors='replace'), end='', flush=True)

        # Check if password prompt appeared
        if b'password:' in output.lower() and not password_sent:
            time.sleep(0.5)
            os.write(master, b'Zxcv@1234\n')
            password_sent = True
            time.sleep(0.5)

    if proc.poll() is not None:
        break
    time.sleep(0.1)

os.close(master)
print("\n=== DONE ===")
