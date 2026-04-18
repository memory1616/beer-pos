import subprocess
import sys

# Commands to execute on server
commands = '''cd ~/beer-pos && pwd && ls -la && echo "=== RECENT SALES ===" && sqlite3 database.sqlite "SELECT id, date, total, type FROM sales ORDER BY id DESC LIMIT 20;" && echo "=== TODAY SALES ===" && sqlite3 database.sqlite "SELECT COUNT(*) as cnt, SUM(total) as sum FROM sales WHERE date(date) = date('now', '+7 hours') AND type = 'sale';" && echo "=== TODAY with localtime ===" && sqlite3 database.sqlite "SELECT COUNT(*) as cnt, SUM(total) as sum FROM sales WHERE date(date) = date('now', 'localtime') AND type = 'sale';"'''

# Run SSH with password using pexpect-like approach
# Create a script that will provide the password
script = f'''
import subprocess
import sys

proc = subprocess.Popen(
    ['ssh', '-o', 'StrictHostKeyChecking=no', 'root@103.75.183.57', '{commands}'],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    universal_newlines=True
)

# Send password
stdout, _ = proc.communicate(input='Zxcv@1234\\n', timeout=20)
print(stdout)
'''

exec(script)
