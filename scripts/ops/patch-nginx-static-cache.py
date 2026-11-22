#!/usr/bin/env python3
"""
Patch nginx config trên server: tách JS/CSS (no-cache) khỏi ảnh (cache 30d).

QUY TẮC (2026-11-22): Trước đây tất cả static assets (js|css|png|...) đều được
cache 30 ngày "immutable" → user KHÔNG nhận được JS/CSS mới sau mỗi deploy
(đã gây ra bug KM quán mới không áp dụng). Nay:
  - JS/CSS → "no-cache, must-revalidate" (revalidate theo ETag → luôn lấy bản mới)
  - Ảnh/icon/font → giữ cache 30d "immutable"

Chạy: python3 scripts/ops/patch-nginx-static-cache.py
"""
import re
import shutil
import sys

PATH = "/etc/nginx/sites-available/beerpos.conf"

OLD_BLOCK = """    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        proxy_pass http://beerpos_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
        access_log off;
    }"""

NEW_BLOCK = """    location ~* \\.(js|css)$ {
        proxy_pass http://beerpos_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        expires -1;
        add_header Cache-Control "no-cache, must-revalidate" always;
        access_log off;
    }

    location ~* \\.(png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        proxy_pass http://beerpos_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
        access_log off;
    }"""

# Biến thể cho block static-file (root-based, không proxy_pass)
OLD_BLOCK_ROOT = """    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
        access_log off;
    }"""

NEW_BLOCK_ROOT = """    location ~* \\.(js|css)$ {
        expires -1;
        add_header Cache-Control "no-cache, must-revalidate" always;
        access_log off;
    }

    location ~* \\.(png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
        access_log off;
    }"""


def main():
    try:
        with open(PATH, "r", encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        print(f"[patch-nginx] NOT FOUND: {PATH}")
        sys.exit(1)

    original = content
    count_proxy = content.count(OLD_BLOCK)
    count_root = content.count(OLD_BLOCK_ROOT)

    content = content.replace(OLD_BLOCK, NEW_BLOCK)
    content = content.replace(OLD_BLOCK_ROOT, NEW_BLOCK_ROOT)

    if content == original:
        print("[patch-nginx] Already patched (no change)")
        sys.exit(0)

    backup = PATH + ".bak.staticcache"
    shutil.copy2(PATH, backup)

    with open(PATH, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"[patch-nginx] patched {PATH}")
    print(f"[patch-nginx]   proxy blocks: {count_proxy}, root blocks: {count_root}")
    print(f"[patch-nginx]   backup: {backup}")


if __name__ == "__main__":
    main()
