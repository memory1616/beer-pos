#!/usr/bin/env bash
# Lọc secret khỏi toàn bộ lịch sử git bằng git filter-repo.
#
# ⚠️  DANG LÀM VIỆC TRÊN REPO — chạy trên clone sạch, không chạy trên repo
#     đang có chỉnh sửa chưa commit.
#
# Thứ tự:
#   1. clone --mirror backup
#   2. filter-repo: xoá file secret + thay nội dung secret trong file text
#   3. verify: quét lại toàn bộ history, không còn secret nào
#   4. force-push + báo user phải re-clone
#
# ── Bảo mật ────────────────────────────────────────────────────────────────
# Script này KHÔNG chứa giá trị secret nào. Danh sách thay thế nằm ở file
# LOCAL `scripts/ops/secret-replacements.local.txt` (đã .gitignore).
# Nếu file local thiếu → script dừng với thông báo rõ ràng.
set -euo pipefail

REPO_DIR="${1:-$(pwd)}"
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPLACEMENTS="$OPS_DIR/secret-replacements.local.txt"

cd "$REPO_DIR"

if [ ! -f "$REPLACEMENTS" ]; then
  echo "ERROR: thiếu file local $REPLACEMENTS"
  echo "  Tạo file này (KHÔNG commit) với format: <secret>==>***REMOVED***"
  exit 1
fi

echo '=== 1. backup ==='
BACKUP_DIR="${BEER_BACKUP_DIR:-/d/Beer-backup.git}"
if [ ! -d "$BACKUP_DIR" ]; then
  git clone --mirror "$REPO_DIR" "$BACKUP_DIR"
  echo "backup tạo tại $BACKUP_DIR"
else
  echo "backup đã tồn tại: $BACKUP_DIR"
fi

echo
echo '=== 2. filter-repo ==='
git filter-repo --force \
  --path-glob 'glob:*.pem' --invert-paths \
  --path 'cursor_deploy_key' --path 'cursor_deploy_key.pub' --invert-paths \
  --path '_new_deploy_key' --path '_new_deploy_key.pub' --invert-paths \
  --path 'pass.txt' --invert-paths \
  --path '_gen_key.bat' --invert-paths \
  --path 'scripts/ops/secret-replacements.txt' --invert-paths \
  --replace-text "$REPLACEMENTS" \
  --tag-rename-filter ':(tag)^$' --force

echo
echo '=== 3. verify ==='
if python3 "$OPS_DIR/scan-history-secrets.py"; then
  echo "verify: SẠCH"
else
  echo "verify: CÒN LEAK — cần xử lý thêm"
  exit 1
fi

echo
echo '=== 4. commit summary ==='
git log --oneline -5
echo
echo "filter-repo xong."
