#!/usr/bin/env python3
"""Rotate GITHUB_WEBHOOK_SECRET trên server production VÀ trên GitHub webhook config.

Thứ tự (quan trọng):
  1. Sinh secret mới
  2. Cập nhật GitHub webhook config trước (GitHub sẽ ký payload bằng secret mới)
  3. Cập nhật .env trên server
  4. Restart PM2

Nếu làm ngược thứ tự, có khoảng thời gian webhook push sẽ bị reject (401).
"""
import json
import secrets
import subprocess
import sys
import urllib.request

REPO = "memory1616/beer-pos"
HOOK_ID = 606172906
SSH_TARGET = "beer-server"
ENV_FILE = "/var/www/beer-pos/.env"


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


def gh(method, url, token, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "beer-ops",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode()
        return json.loads(body) if body else {}


def ssh(cmd):
    proc = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", SSH_TARGET, cmd],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return proc.returncode, proc.stdout, proc.stderr


def set_env_on_server(key, value):
    """Thay giá trị key trong .env trên server (idempotent)."""
    rc, out, err = ssh(
        f"cd /var/www/beer-pos && "
        f"if grep -q '^{key}=' {ENV_FILE}; then "
        f"sed -i 's|^{key}=.*|{key}={value}|' {ENV_FILE}; "
        f"else echo '{key}={value}' >> {ENV_FILE}; fi && "
        f"grep -c '^{key}=' {ENV_FILE}"
    )
    return rc == 0, out.strip(), err.strip()


token = get_token()
if not token:
    print("ERROR: no GitHub token")
    sys.exit(1)

new_secret = secrets.token_hex(32)
print(f"new secret generated ({len(new_secret)} chars)")

# ── 1. Lấy config webhook hiện tại ────────────────────────────
hook = gh("GET", f"https://api.github.com/repos/{REPO}/hooks/{HOOK_ID}", token)
cfg = hook["config"]
payload = {
    "config": {
        "url": cfg["url"],
        "content_type": cfg.get("content_type", "json"),
        "secret": new_secret,
        "insecure_ssl": cfg.get("insecure_ssl", "0"),
    },
    "events": hook["events"],
    "active": hook["active"],
}

# ── 2. Cập nhật GitHub trước ──────────────────────────────────
updated = gh("PATCH", f"https://api.github.com/repos/{REPO}/hooks/{HOOK_ID}", token, payload)
print("GitHub webhook updated:", updated.get("id"), "active:", updated.get("active"))

# ── 3. Cập nhật .env trên server ──────────────────────────────
ok, out, err = set_env_on_server("GITHUB_WEBHOOK_SECRET", new_secret)
if not ok:
    print("ERROR updating server .env:", err)
    sys.exit(1)
print("server .env updated (rows:", out, ")")

# ── 4. Restart PM2 ────────────────────────────────────────────
rc, out, err = ssh("cd /var/www/beer-pos && pm2 restart ecosystem.config.js --update-env 2>&1 | tail -5")
print("pm2 restart:", out.strip() or err.strip())

print()
print("NEW GITHUB_WEBHOOK_SECRET =", new_secret)
print("(đã lưu vào .env trên server + GitHub webhook config)")
