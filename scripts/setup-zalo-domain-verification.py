#!/usr/bin/env python3
"""
Cài đặt nginx location để serve file xác thực domain Zalo OA.

Bối cảnh:
  Khi đăng ký Zalo Official Account (OA), Zalo yêu cầu xác thực website của
  doanh nghiệp bằng cách yêu cầu host 1 file HTML ở ROOT domain, ví dụ:
      https://biatuoitayninh.store/zalo_verifierXXXX.html
  File này chứa meta tag:
      <meta property="zalo-platform-site-verification" content="XXXX" />

Vấn đề:
  - File nằm trong thư mục `public/` → Express static phục vụ được, NHƯNG
    domain gốc thường chạy nginx với `return 301 https://...` cho mọi request
    HTTP. Zalo bot đôi khi không follow redirect → verification fail.

Giải pháp:
  Thêm `location = /<verifier>` vào server block `listen 80` để serve file
  TRỰC TIẾP từ disk (bypass redirect). Đồng thời giữ nguyên HTTPS vì file
  cũng đã được serve qua Express static.

Dùng:
  python3 scripts/setup-zalo-domain-verification.py <verifier-filename>
  VD:  python3 scripts/setup-zalo-domain-verification.py zalo_verifierOCI75BdpBZX6vAbklFOoPcxPv5c2hpy0CZKs.html

Yêu cầu:
  - Chạy trên server production (root)
  - File verifier đã tồn tại tại /var/www/beer-pos/public/<tên file>
  - Đã backup nginx config trước khi chạy
"""

import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

CONF = Path('/etc/nginx/sites-available/beerpos.conf')
PUBLIC_ROOT = Path('/var/www/beer-pos/public')


def die(msg, code=1):
    print(f'✗ {msg}')
    sys.exit(code)


def main():
    if len(sys.argv) < 2:
        die(f'Usage: {sys.argv[0]} <verifier-filename>')

    verifier = sys.argv[1].strip()

    # Chống path traversal
    if not re.fullmatch(r'[A-Za-z0-9._-]+\.html', verifier):
        die(f'Tên file không hợp lệ: {verifier}')

    if not (PUBLIC_ROOT / verifier).is_file():
        die(f'Không tìm thấy file: {PUBLIC_ROOT / verifier}')

    if not CONF.is_file():
        die(f'Không tìm thấy nginx config: {CONF}')

    content = CONF.read_text(encoding='utf-8')

    if verifier in content:
        print('ℹ Location đã tồn tại, không cần làm gì.')
        return 0

    # Tìm server block listen 80
    anchor = (
        '    # Redirect everything else to HTTPS\n'
        '    location / {\n'
        '        return 301 https://$host$request_uri;\n'
        '    }'
    )
    if anchor not in content:
        die('Không tìm thấy block "Redirect everything else to HTTPS" trong nginx config.\n'
            '  Hãy kiểm tra cấu trúc file thủ công và chỉnh script cho phù hợp.')

    # Backup
    backup = CONF.with_suffix(f'.conf.bak.zaloverifier.{time.strftime("%Y%m%d_%H%M%S")}')
    shutil.copy2(CONF, backup)
    print(f'✓ Đã backup: {backup}')

    block = (
        '    # Zalo OA domain verification file - serve truc tiep tren HTTP (khong redirect).\n'
        '    # Zalo bot kiem tra file nay o root domain de xac thuc website cua OA.\n'
        f'    location = /{verifier} {{\n'
        f'        root {PUBLIC_ROOT};\n'
        '        default_type text/html;\n'
        '        add_header Cache-Control "public, max-age=3600";\n'
        '    }\n'
        '\n'
    )

    CONF.write_text(content.replace(anchor, block + anchor, 1), encoding='utf-8')
    print(f'✓ Đã thêm location = /{verifier}')

    # Test & reload
    test = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
    if test.returncode != 0:
        print(test.stderr)
        shutil.copy2(backup, CONF)  # rollback
        die('nginx -t thất bại → đã rollback config.', 1)

    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    print('✓ nginx đã reload')

    return 0


if __name__ == '__main__':
    sys.exit(main())
