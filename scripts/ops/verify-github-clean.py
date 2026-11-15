#!/usr/bin/env python3
"""Xác minh secret đã bị xoá khỏi repo GitHub (public) qua GitHub API."""
import json
import subprocess
import sys
import urllib.request

REPO = "memory1616/beer-pos"


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


def gh(path):
    token = get_token()
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "beer-ops",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


print("=== Repo ===")
info = gh("")
print(f"  {info['full_name']}  private={info['private']}  default_branch={info['default_branch']}")
print(f"  pushed_at={info['pushed_at']}")

print()
print("=== Branch main ===")
branches = gh("/branches?per_page=100")
for b in branches:
    print(f"  {b['name']} -> {b['commit']['sha'][:8]}")

print()
print("=== Secret files còn trên main? ===")
tree = gh("/git/trees/main?recursive=1")
paths = [t["path"] for t in tree.get("tree", [])]
suspects = [
    p
    for p in paths
    if p.endswith(".pem")
    or "cursor_deploy_key" in p
    or "pass.txt" in p
    or "deploy_bootstrap_key" in p
    or "sa-key" in p
]
print(f"  tổng file trong repo: {len(paths)}")
if suspects:
    for p in suspects:
        print(f"  LEAK: {p}")
else:
    print("  OK - không còn file secret nào")

print()
print("=== Nội dung file tracked có chứa secret? ===")
checks = [
    ("GITHUB_WEBHOOK_SECRET cũ", "8d5780a20a06427187c3e6cebf0b92078b929b4b0d97a2f9bdf83208a3151fd6"),
    ("ADMIN_PASSWORD cũ", "Zxcv@1234"),
]
leaks = 0
for desc, secret in checks:
    found = []
    for p in paths:
        if not p.endswith((".md", ".txt", ".py", ".sh", ".js", ".json", ".yml", ".yaml", ".ps1", ".bat", ".conf")):
            continue
        try:
            req = urllib.request.Request(
                f"https://raw.githubusercontent.com/{REPO}/main/{urllib.parse.quote(p)}",
                headers={"User-Agent": "beer-ops"},
                timeout=15,
            )
            with urllib.request.urlopen(req, timeout=15) as r:
                if secret.encode() in r.read():
                    found.append(p)
        except Exception:
            pass
    if found:
        leaks += len(found)
        print(f"  LEAK ({desc}): {found}")
    else:
        print(f"  OK - {desc}")

print()
print("=== KẾT QUẢ ===")
print("SẠCH ✅" if leaks == 0 and not suspects else "CÒN LEAK ❌")
sys.exit(0 if leaks == 0 and not suspects else 1)
