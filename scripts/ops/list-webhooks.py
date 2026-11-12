#!/usr/bin/env python3
"""Liệt kê webhook của repo GitHub (dùng token từ git credential manager)."""
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
repo = "memory1616/beer-pos"

req = urllib.request.Request(
    f"https://api.github.com/repos/{repo}/hooks",
    headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "beer-ops",
    },
)
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        hooks = json.load(r)
except Exception as e:
    print("ERR:", e)
    sys.exit(1)

if not hooks:
    print("NO WEBHOOKS CONFIGURED")
for h in hooks:
    cfg = h.get("config", {})
    print(f"id={h['id']}")
    print(f"  name        = {h.get('name')}")
    print(f"  active      = {h.get('active')}")
    print(f"  events      = {h.get('events')}")
    print(f"  url         = {cfg.get('url')}")
    print(f"  content_type= {cfg.get('content_type')}")
    print(f"  insecure_ssl= {cfg.get('insecure_ssl')}")
