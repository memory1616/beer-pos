#!/usr/bin/env python3
"""Kiểm tra GitHub API bằng credential từ git credential manager."""
import json
import subprocess
import sys
import urllib.request


def get_token():
    proc = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True,
        text=True,
        timeout=30,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1].strip()
    return None


token = get_token()
if not token:
    print("NO TOKEN")
    sys.exit(1)

print("token length:", len(token))

req = urllib.request.Request(
    "https://api.github.com/repos/memory1616/beer-pos",
    headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "beer-ops",
    },
)
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
        print("API OK")
        print("  repo:", data.get("full_name"))
        print("  private:", data.get("private"))
        print("  perms:", data.get("permissions"))
except urllib.error.HTTPError as e:
    print("API HTTPError:", e.code, e.reason)
    try:
        print(e.read().decode()[:400])
    except Exception:
        pass
except Exception as e:
    print("API error:", type(e).__name__, e)
