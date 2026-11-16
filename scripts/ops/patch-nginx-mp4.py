"""Patch nginx config: chuan hoa location .mp4|webm|ogg.

- Bo `directio 512` (can gay loi media streaming).
- Bo `add_header Content-Type` va `add_header Accept-Ranges` (nguyen tu khong
  duoc phep -> Chrome bao MEDIA_ELEMENT_ERROR: Format error).
- Giu `root /var/www/beer-pos/public` (khong co root -> 404 moi file video).
"""
import sys

path = sys.argv[1]
lines = open(path, encoding="utf-8").read().split("\n")

start = None
for i, ln in enumerate(lines):
    if "location ~* \\.(mp4|webm|ogg)$" in ln:
        start = i
        break

if start is None:
    print("ERROR: khong tim thay location mp4")
    sys.exit(1)

# Tim dong dong `    }` ket thuc block
end = None
for j in range(start + 1, len(lines)):
    if lines[j].strip() == "}":
        end = j
        break

if end is None:
    print("ERROR: khong tim thay dong ket thuc block")
    sys.exit(1)

new_block = r"""    # Video files
    location ~* \.(mp4|webm|ogg)$ {
        # QUAN TRONG: file video nam trong /var/www/beer-pos/public/ ->
        # phai tro root ve public, neu khong location nay khong co root
        # -> nginx roi ve /var/www/html -> 404 cho moi file .mp4.
        root /var/www/beer-pos/public;
        types { video/mp4 mp4; video/webm webm; application/ogg ogg; }
        # KHONG add_header Content-Type / Accept-Ranges:
        #   nginx da tu phat Content-Type tu mime.types va Accept-Ranges tu core.
        #   add_header tao THEM header trung -> Chrome bao
        #   "MEDIA_ELEMENT_ERROR: Format error" du file mp4 hoan toan hop le.
        add_header Access-Control-Allow-Origin "*" always;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable" always;
        access_log off;
        sendfile on;
        tcp_nopush on;
    }""".split("\n")

out = lines[:start] + new_block + lines[end + 1:]
open(path, "w", encoding="utf-8").write("\n".join(out))
print(f"patched mp4 location (lines {start + 1}-{end + 1})")
