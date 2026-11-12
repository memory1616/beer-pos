"""Full PM2 restart trên server production (qua SSH key, không dùng mật khẩu).

Dùng alias `beer-server` trong ~/.ssh/config — xem docs/BEER_CLEANUP_PLAN.md §12.
"""

import subprocess

SSH = ["ssh", "-o", "StrictHostKeyChecking=no", "beer-server"]

# Full PM2 restart
commands = [
    "pm2 stop all",
    "pm2 delete all",
    "cd /var/www/beer-pos && pm2 start ecosystem.config.js",
    "sleep 3",
    "pm2 list",
]
cmd = " && ".join(commands)
r = subprocess.run(
    SSH + [cmd],
    capture_output=True,
    text=True,
    timeout=60,
)
print("PM2 output:", (r.stdout or "")[:1000] or "No output")
if r.stderr:
    print("PM2 stderr:", r.stderr[:500])

# Check listening ports
r2 = subprocess.run(
    SSH + ["ss -tlnp | grep 3000"],
    capture_output=True,
    text=True,
    timeout=20,
)
print("\nPort 3000:", (r2.stdout or "").strip() or "Not listening")
