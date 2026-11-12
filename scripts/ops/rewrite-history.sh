#!/usr/bin/env bash
# Lọc secret khỏi toàn bộ lịch sử git bằng git filter-repo.
#
# ⚠️  DANG LÀM VIỆC TRÊN REPO — chạy trên clone sạch, không chạy trên repo
#     đang có chỉnh sửa chưa commit.
#
# Thứ tự:
#   1. clone --mirror backup (D:\Beer-backup.git)
#   2. filter-repo: xoá file secret + thay nội dung secret trong file text
#   3. verify: quét lại toàn bộ history, không còn secret nào
#   4. force-push + báo user phải re-clone
set -euo pipefail

cd "$1"
REPO_DIR="$1"

echo '=== 1. backup ==='
if [ ! -d /d/Beer-backup.git ]; then
  git clone --mirror "$REPO_DIR" /d/Beer-backup.git
  echo 'backup tạo tại /d/Beer-backup.git'
else
  echo 'backup đã tồn tại: /d/Beer-backup.git'
fi

echo
echo '=== 2. filter-repo ==='
git filter-repo --force \
  --path-glob 'glob:*.pem' --invert-paths \
  --path 'cursor_deploy_key' --path 'cursor_deploy_key.pub' --invert-paths \
  --path '_new_deploy_key' --path '_new_deploy_key.pub' --invert-paths \
  --path 'pass.txt' --invert-paths \
  --path '_gen_key.bat' --invert-paths \
  --replace-text ../scripts/ops/secret-replacements.txt \
  --tag-rename-filter ':(tag)^$' --force

echo
echo '=== 3. verify ==='
FAIL=0
for s in '***REMOVED***' '***REMOVED***'; do
  N=$(git rev-list --all --objects | while read -r obj path; do
        git cat-file -p "$obj" 2>/dev/null | grep -qF "$s" && echo "$path"
      done | sort -u | wc -l)
  echo "  '$s' -> $N file chứa giá trị này"
  [ "$N" -gt 0 ] && FAIL=1
done

echo
echo '=== 4. commit summary ==='
git log --oneline -5
echo
echo "filter-repo xong. FAIL=$FAIL"
