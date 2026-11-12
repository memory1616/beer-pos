#!/usr/bin/env python3
"""Quét nhanh toàn bộ object database git tìm secret đã lộ.

Dùng `git cat-file --batch-all-objects --batch-check` để liệt kê blob,
rồi `git cat-file --batch` để đọc nội dung — nhanh hơn gọi 1 tiếng trình/blob.
"""
import re
import subprocess
import sys

SECRET_VALUES = [
    ("GITHUB_WEBHOOK_SECRET cũ", b"***REMOVED***"),
    ("ADMIN_PASSWORD cũ", b"***REMOVED***"),
    ("cursor_deploy_key public body", b"***REMOVED***"),
]

SUSPICIOUS_PATHS = re.compile(
    rb"(^|/)(pass\.txt|cursor_deploy_key(\.pub)?|_new_deploy_key(\.pub)?|_gen_key\.bat"
    rb"|deploy_bootstrap_key(\.pub)?|[^/]*\.pem|.*sa-key.*)$"
)

# Dấu hiệu private key THẬT (bắt đầu bằng header PEM ở đầu dòng).
# Phải khớp ở đầu dòng để không false-positive với script chứa header dạng
# string literal (ví dụ gen_key.js sinh OpenSSH private key format).
PRIVATE_KEY_MARKERS = re.compile(
    rb"(?m)^-----BEGIN (RSA |OPENSSH |DSA |EC |ENCRYPTED )?PRIVATE KEY-----\s*$"
)

# ── 1. Liệt kê toàn bộ blob ───────────────────────────────────
listing = subprocess.run(
    ["git", "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    capture_output=True,
).stdout.decode("utf-8", "replace")

blobs = []
for line in listing.splitlines():
    parts = line.split()
    if len(parts) >= 3 and parts[1] == "blob":
        blobs.append((parts[0], int(parts[2])))

print(f"=== Quét {len(blobs)} blob ===")

# ── 2. Đọc nội dung theo lô ───────────────────────────────────
hits = {desc: [] for desc, _ in SECRET_VALUES}
key_hits = []
BATCH = 500
for i in range(0, len(blobs), BATCH):
    chunk = blobs[i : i + BATCH]
    names = "\n".join(o for o, _ in chunk)
    proc = subprocess.run(
        ["git", "cat-file", "--batch"],
        input=names.encode(),
        capture_output=True,
    )
    data = proc.stdout
    pos = 0
    for obj, size in chunk:
        nl = data.find(b"\n", pos)
        if nl < 0:
            break
        header = data[pos:nl]
        body_start = nl + 1
        body = data[body_start : body_start + size]
        pos = body_start + size + 1
        for desc, pattern in SECRET_VALUES:
            if pattern in body:
                hits[desc].append(obj)
        if PRIVATE_KEY_MARKERS.search(body):
            key_hits.append(obj)

# ── 3. Path đáng ngờ ──────────────────────────────────────────
paths = set()
out = subprocess.run(
    ["git", "rev-list", "--all", "--objects"],
    capture_output=True,
).stdout
for line in out.splitlines():
    parts = line.split(b" ", 1)
    if len(parts) == 2 and SUSPICIOUS_PATHS.search(parts[1]):
        paths.add(parts[1].decode("utf-8", "replace"))

# ── 4. Báo cáo ────────────────────────────────────────────────
total = 0
print()
print("=== Path đáng ngờ ===")
if paths:
    for p in sorted(paths):
        print(f"  LEAK PATH: {p}")
    total += len(paths)
else:
    print("  OK")

print()
print("=== Giá trị secret trong blob ===")
for desc, _ in SECRET_VALUES:
    if hits[desc]:
        print(f"  LEAK VALUE ({desc}): {len(hits[desc])} blob")
        for o in hits[desc][:5]:
            print(f"    {o}")
        total += len(hits[desc])
    else:
        print(f"  OK - {desc}")

print()
print("=== Private key material ===")
if key_hits:
    print(f"  LEAK: {len(key_hits)} blob chứa private key")
    for o in key_hits[:5]:
        print(f"    {o}")
    total += len(key_hits)
else:
    print("  OK - không còn private key")

print()
print("=== KẾT QUẢ ===")
print("SẠCH ✅" if total == 0 else f"CÒN {total} leak ❌")
sys.exit(0 if total == 0 else 1)
