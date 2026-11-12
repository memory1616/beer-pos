# Normalize line endings + quyền file thực thi
#
# Vấn đề: file .sh/.bat được commit trên Windows với CRLF → khi scp lên Linux
# và chạy bằng bash sẽ lỗi "syntax error near unexpected token $'do\r'".
# File này chuẩn hoá LF cho các file script shell + đảm bảo quyền +x.
#
#   python fix_eol.py            # chuẩn hoá tất cả .sh
#   python fix_eol.py --check    # chỉ báo cáo, không sửa

import os
import stat
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CHECK_ONLY = "--check" in sys.argv

SHELL_SCRIPTS = [
    "scripts/gen-secrets.sh",
    "scripts/server-backup.sh",
    "scripts/pm2-start.sh",
    "scripts/pm2-startup.sh",
    "scripts/check-backup-server.sh",
    "scripts/final-status.sh",
    "scripts/fix-env-prod.sh",
    "scripts/harden-ssh.sh",
    "scripts/nginx-setup.sh",
    "scripts/test-login-local.sh",
    "scripts/verify-web.sh",
    "scripts/wait-and-verify.sh",
    "server-backup.sh",
    "ssh-check.sh",
    "scripts/ops/watchdog.sh",
]

fixed = []
skipped = []
missing = []

for rel in SHELL_SCRIPTS:
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        missing.append(rel)
        continue

    with open(path, "rb") as f:
        data = f.read()

    if b"\r\n" in data:
        if not CHECK_ONLY:
            data = data.replace(b"\r\n", b"\n")
            with open(path, "wb") as f:
                f.write(data)
        fixed.append(rel)
    else:
        skipped.append(rel)

    if not CHECK_ONLY and os.name != "nt":
        mode = os.stat(path).st_mode
        os.chmod(path, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

if CHECK_ONLY:
    print("=== CRLF found (would be fixed) ===")
    for r in fixed:
        print("  ", r)
    print(f"\n{len(fixed)} file(s) cần chuẩn hoá LF")
else:
    print(f"Đã chuẩn hoá LF: {len(fixed)} file(s)")
    for r in fixed:
        print("  ", r)
    print(f"Đã đúng LF: {len(skipped)} file(s)")

if missing:
    print(f"\nKhông tồn tại (bỏ qua): {', '.join(missing)}")

# Kiểm tra .gitattributes
ga = os.path.join(ROOT, ".gitattributes")
if not os.path.exists(ga):
    print("\n⚠️  Chưa có .gitattributes — nên thêm rule '*.sh text eol=lf'")
