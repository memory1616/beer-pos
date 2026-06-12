#!/usr/bin/env python3
import paramiko

host, port = '103.75.183.57', 22
user, pw = 'root', 'Zxcv@1234'

cmds = [
    'cd ~/beer-pos && git log -3 --oneline',
    'cd ~/beer-pos && grep -n "archived = 0" routes/api/purchases.js',
    'cd ~/beer-pos && grep -n "Reverse stock" routes/api/purchases.js',
    'pm2 status beer-pos',
    'curl -s http://127.0.0.1:3000/health 2>&1',
]

try:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, port=port, username=user, password=pw, timeout=10)
    print("Connected!")

    for cmd in cmds:
        print(f'\n$ {cmd}')
        stdin, stdout, stderr = client.exec_command(cmd, timeout=20)
        out = stdout.read()
        err = stderr.read()
        if out:
            print(out.decode('utf-8', 'replace').strip())
        if err:
            print('ERR:', err.decode('utf-8', 'replace').strip())

    client.close()
    print('\nDone!')
except Exception as e:
    print(f'Error: {e}')
