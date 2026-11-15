#!/usr/bin/env bash
# Wait for apt to finish and verify tools
echo "Waiting for apt processes..."
while pgrep -x apt-get >/dev/null || pgrep -x apt >/dev/null || pgrep -x dpkg >/dev/null; do sleep 5; echo "still waiting... $(date)"; done
echo "APT_DONE"
echo "=== Tools ==="
which node npm pm2 sqlite3 nginx certbot
echo "=== Versions ==="
node --version 2>&1
npm --version 2>&1
pm2 --version 2>&1
sqlite3 --version 2>&1
nginx -v 2>&1
echo "=== Done ==="