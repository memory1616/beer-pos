#!/usr/bin/env python3
"""Đồng bộ .env local với secret mới đã rotate trên production.

- ADMIN_PASSWORD: copy từ server (chỉ chạy khi bạn đã lưu mật khẩu mới)
- SESSION_SECRET / JWT_SECRET: sinh mới (không nhất thiết khớp production)
- GITHUB_WEBHOOK_SECRET: copy từ server (cần cho test webhook local)

Không bao giờ in giá trị secret ra stdout.
"""
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENV_LOCAL = os.path.join(REPO, ".env")

KEYS = ["ADMIN_PASSWORD", "SESSION_SECRET", "JWT_SECRET", "GITHUB_WEBHOOK_SECRET"]


def ssh(cmd):
    proc = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "beer-server", cmd],
        capture_output=True,
        text=True,
        timeout=60,
        stdin=subprocess.DEVNULL,
    )
    return proc.returncode, proc.stdout, proc.stderr


rc, out, err = ssh(
    "cd /var/www/beer-pos && for k in ADMIN_PASSWORD SESSION_SECRET JWT_SECRET "
    "GITHUB_WEBHOOK_SECRET; do "
    "grep -E \"^$k=\" .env | head -1; done"
)
if rc != 0:
    print("ERROR reading server .env:", err.strip())
    sys.exit(1)

server_values = {}
for line in out.splitlines():
    if "=" in line:
        k, v = line.split("=", 1)
        server_values[k.strip()] = v.strip()

missing = [k for k in KEYS if k not in server_values or not server_values[k]]
if missing:
    print("ERROR: server .env thiếu:", ", ".join(missing))
    sys.exit(1)

if not os.path.exists(ENV_LOCAL):
    print(f"ERROR: {ENV_LOCAL} not found")
    sys.exit(1)

with open(ENV_LOCAL, "r", encoding="utf-8") as f:
    content = f.read()

updated = []
for key in KEYS:
    val = server_values[key]
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    if pattern.search(content):
        content = pattern.sub(f"{key}={val}", content)
        updated.append(key)
    else:
        content += f"\n{key}={val}\n"
        updated.append(key + " (added)")

with open(ENV_LOCAL, "w", encoding="utf-8") as f:
    f.write(content)

print("Đã cập nhật .env local:", ", ".join(updated))
print("Giá trị KHÔNG được in ra stdout (kiểm tra file .env nếu cần)")
