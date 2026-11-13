#!/usr/bin/env python3
"""Quét lịch sử git tìm secret đã lộ.

Nguyên tắc bảo mật
-------------------
File này KHÔNG chứa bất kỳ giá trị secret plaintext nào. Danh sách secret cần quét
nằm trong file LOCAL `scripts/ops/secret-fingerprints.local.json` (đã .gitignore).

Nếu file local không tồn tại → script vẫn chạy được các kiểm tra:
  - path đáng ngờ (tên file kiểu secret)
  - private key marker (header PEM)
  - blob reachable chứa chuỗi dài giống secret
...và báo SKIP phần so sánh giá trị cụ thể.

Vì sao không nhúng sẵn danh sách (dù base64/hex)?
--------------------------------------------------
Base64/hex KHÔNG phải bảo mật — ai có file cũng giải mã được, và file đó lại nằm
trong git history sau khi đã push. Nếu muốn repo sạch thật sự thì danh sách phải
nằm ngoài git hoàn toàn.

Phạm vi quét
-------------
Chỉ quét blob REACHABLE từ refs (git rev-list --all --objects). Blob dangling
(dangling/dangling blob) đã bị `git gc` prune nhưng vẫn có thể tồn tại trong
object DB cục bộ — chúng KHÔNG còn nằm trong lịch sử push lên GitHub nên không
được tính là leak (được báo riêng ở phần cuối).

Cách dùng
----------
    python scripts/ops/scan-history-secrets.py              # quét
    python scripts/ops/scan-history-secrets.py --local-path # in đường dẫn file local
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCAL_FILE = HERE / "secret-fingerprints.local.json"

# ── Cấu hình path đáng ngờ ───────────────────────────────────────────────
SUSPICIOUS_PATHS = re.compile(
    rb"(^|/)(pass\.txt|cursor_deploy_key(\.pub)?|_new_deploy_key(\.pub)?|_gen_key\.bat"
    rb"|deploy_bootstrap_key(\.pub)?|[^/]*\.pem|.*sa-key.*)$"
)

# Dấu hiệu private key THẬT (header PEM ở đầu dòng).
# Phải khớp ở đầu dòng để không false-positive với script chứa header dạng
# string literal (ví dụ gen_key.js sinh OpenSSH private key format).
PRIVATE_KEY_MARKERS = re.compile(
    rb"(?m)^-----BEGIN (RSA |OPENSSH |DSA |EC |ENCRYPTED )?PRIVATE KEY-----\s*$"
)

# Chuỗi dài giống secret (hex >= 32, base64 >= 40, ssh key body >= 60).
# Chỉ dùng để CẢNH BÁO, không kết luận leak — cần đối chiếu danh sách local.
SECRET_SHAPE = re.compile(
    rb"(?<![A-Za-z0-9+/=])[A-Fa-f0-9]{32,}(?![A-Za-z0-9+/=])"
    rb"|(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])"
)


def load_local_secrets():
    """Đọc danh sách secret từ file local. Trả về list[(label, bytes)]."""
    if not LOCAL_FILE.exists():
        return None
    try:
        data = json.loads(LOCAL_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"  WARN: đọc {LOCAL_FILE.name} lỗi: {e}")
        return None

    out = []
    for entry in data.get("secrets", []):
        label = entry.get("label", "?")
        if "value" in entry and entry["value"]:
            out.append((label, entry["value"].encode("utf-8")))
        elif entry.get("value_b64"):
            import base64

            try:
                out.append((label, base64.b64decode(entry["value_b64"])))
            except Exception:
                print(f"  WARN: {label} — value_b64 không giải mã được")
    return out


def git(*args):
    return subprocess.run(["git", *args], capture_output=True).stdout


def reachable_blobs():
    """Trả về dict {sha: path} cho mọi blob reachable từ refs."""
    raw = git("rev-list", "--all", "--objects")
    # Bước 1: path cho mọi object reachable
    paths = {}
    shas = []
    for line in raw.splitlines():
        parts = line.split(b" ", 1)
        if not parts:
            continue
        sha = parts[0].decode()
        shas.append(sha)
        if len(parts) == 2:
            paths[sha] = parts[1].decode("utf-8", "replace")

    # Bước 2: lọc type=blob bằng MỘT lần gọi batch-check (nhanh hơn gọi từng blob)
    proc = subprocess.run(
        ["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
        input="\n".join(shas).encode(),
        capture_output=True,
    )
    blobs = {}
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == b"blob":
            sha = parts[0].decode()
            blobs[sha] = paths.get(sha, "?")
    return blobs


def object_type(sha):
    return git("cat-file", "-t", sha).decode().strip()


def read_blobs(shas):
    """Đọc nội dung blob theo lô (nhanh hơn gọi 1 process/blob)."""
    contents = {}
    BATCH = 500
    for i in range(0, len(shas), BATCH):
        chunk = shas[i : i + BATCH]
        proc = subprocess.run(
            ["git", "cat-file", "--batch"],
            input="\n".join(chunk).encode(),
            capture_output=True,
        )
        data = proc.stdout
        pos = 0
        for obj in chunk:
            nl = data.find(b"\n", pos)
            if nl < 0:
                break
            header = data[pos:nl].split()
            size = int(header[2]) if len(header) >= 3 else 0
            body = data[nl + 1 : nl + 1 + size]
            pos = nl + 1 + size + 1
            contents[obj] = body
    return contents

def dangling_blob_count():
    """Đếm blob dangling (không reachable) — thông tin, KHÔNG tính là leak."""
    out = git("fsck", "--unreachable", "--no-progress")
    n = 0
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[1] == "blob":
            n += 1
    return n


def main():
    if "--local-path" in sys.argv:
        print(LOCAL_FILE)
        return 0

    secrets = load_local_secrets()

    print("=== 1. Path đáng ngờ trong lịch sử ===")
    raw = git("rev-list", "--all", "--objects")
    paths = set()
    for line in raw.splitlines():
        parts = line.split(b" ", 1)
        if len(parts) == 2 and SUSPICIOUS_PATHS.search(parts[1]):
            paths.add(parts[1].decode("utf-8", "replace"))
    if paths:
        for p in sorted(paths):
            print(f"  LEAK PATH: {p}")
    else:
        print("  OK - không có path đáng ngờ")

    print()
    print("=== 2. Quét nội dung blob reachable ===")
    reach = reachable_blobs()
    shas = list(reach.keys())
    print(f"  {len(shas)} blob reachable từ refs")
    bodies = read_blobs(shas)

    total = 0

    # 2a. Private key marker
    key_hits = []
    for sha, body in bodies.items():
        if PRIVATE_KEY_MARKERS.search(body):
            key_hits.append((sha, reach[sha]))
    print()
    print("=== 3. Private key material ===")
    if key_hits:
        print(f"  LEAK: {len(key_hits)} blob chứa private key")
        for sha, path in key_hits[:5]:
            print(f"    {sha}  {path}")
        total += len(key_hits)
    else:
        print("  OK - không còn private key")

    # 2b. Giá trị secret cụ thể (chỉ khi có file local)
    print()
    print("=== 4. Giá trị secret cụ thể ===")
    if secrets is None:
        print(f"  SKIP - thiếu file local {LOCAL_FILE.name}")
        print("       (tạo file local rồi chạy lại để quét đầy đủ)")
    else:
        for label, pattern in secrets:
            hits = [(sha, reach[sha]) for sha, body in bodies.items() if pattern in body]
            if hits:
                print(f"  LEAK VALUE ({label}): {len(hits)} blob")
                for sha, path in hits[:5]:
                    print(f"    {sha}  {path}")
                total += len(hits)
            else:
                print(f"  OK - {label}")

    # 2c. Chuỗi hình dạng secret (cảnh báo, cần đối chiếu)
    print()
    print("=== 5. Chuỗi hình dạng secret (CẢNH BÁO — cần đối chiếu) ===")
    shape_hits = []
    for sha, body in bodies.items():
        m = SECRET_SHAPE.search(body)
        if m:
            shape_hits.append((sha, reach[sha], m.group()[:24].decode("utf-8", "replace")))
    print(f"  {len(shape_hits)} blob chứa chuỗi dài dạng hex/base64")
    for sha, path, sample in shape_hits[:8]:
        print(f"    {sha}  {path}  ({sample}…)")
    if not shape_hits:
        print("  OK")

    print()
    print("=== 6. Blob dangling (KHÔNG tính là leak — đã prune khỏi lịch sử push) ===")
    print(f"  {dangling_blob_count()} dangling blob trong object DB cục bộ")

    print()
    print("=== KẾT QUẢ ===")
    if total == 0:
        print("SẠCH ✅ (0 leak trong lịch sử push)")
        return 0
    print(f"CÒN {total} leak ❌")
    return 1


if __name__ == "__main__":
    sys.exit(main())
