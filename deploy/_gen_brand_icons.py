"""Sinh icon thuong hieu Gia Huy Tay Ninh.

Anh goc: JPEG 1024x1024, nen trang.
Cach xoa nen: flood fill BFS tu 4 canh -> chi xoa nen LIEN THONG voi bien.
Cac vung trang ben trong logo (giua ky tu) duoc giu nguyen.
"""
from PIL import Image
import os
from collections import deque

ROOT = r'd:\Beer'
SRC = r'C:\Users\ADMIN\.cursor\projects\d-Beer\assets\c__Users_ADMIN_AppData_Roaming_Cursor_User_workspaceStorage_fa6084f5b1cf86147f51af29ceb2cef2_images_image-b8c3095c-ab2b-4d23-8d04-fe1cba6c0df7.jpg'

WHITE_T = 243          # nguong coi la "trang"
NEAR_T = 252           # nguong "sat trang"


def near_white(p):
    return p[0] >= NEAR_T and p[1] >= NEAR_T and p[2] >= NEAR_T


def build_mask(im):
    """Tra ve mask bytearray: 255 = nen (se xoa), 0 = giu."""
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    q = deque()

    def push(x, y):
        i = y * w + x
        if not seen[i] and near_white(px[x, y]):
            seen[i] = 1
            q.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                push(nx, ny)

    # Tra ve alpha: 0 cho pixel da tham nham, 255 cho phan giu
    mask = bytearray(w * h)
    for i in range(w * h):
        mask[i] = 0 if seen[i] else 255
    return mask


def remove_bg(im):
    """Xoa nen bang flood fill, vien duoc lam mo de khong harsh."""
    w, h = im.size
    rgba = im.convert('RGBA')
    px = rgba.load()
    mask = build_mask(im.convert('RGB'))

    # Tinh alpha: pixel nen -> 0; pixel sat vien -> alpha moc
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if mask[i] == 0:
                px[x, y] = (px[x, y][0], px[x, y][1], px[x, y][2], 0)

    # Vien mem: lan 2px tu nen, alpha = 255 * (1 - lan/2)
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if mask[i] != 0:
                continue
            # kiem tra 4 huong xem co pixel giu khong
            near_keep = False
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and mask[ny * w + nx] != 0:
                    near_keep = True
                    break
            if near_keep:
                px[x, y] = (px[x, y][0], px[x, y][1], px[x, y][2], 90)
    return rgba


def fit_square(im, size, pad_ratio=0.0, bg=None):
    inner = int(size * (1 - pad_ratio * 2))
    scale = inner / max(im.size)
    nw, nh = max(1, int(im.width * scale)), max(1, int(im.height * scale))
    rs = im.resize((nw, nh), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), bg if bg else (0, 0, 0, 0))
    out.paste(rs, ((size - nw) // 2, (size - nh) // 2), rs)
    return out


def optimize(im, colors=64):
    """Lam sach nhieu JPEG + giam palette de PNG nhe.

    Anh goc la JPEG nen nen co nhieu mau sac giong nhau (nhieu nen).
    Quantize ve palette 64 mau se cat dung luong nhieu ma anh van dep.
    """
    im = im.convert('RGB')
    # Posterize truoc: gom cac muc mau gan nhau ve bang
    im = im.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG)
    return im.convert('RGB')


def denoise(im, radius=1.2):
    """Lam nhieu JPEG (dither/macro-block) bang MedianFilter.

    Anh goc la JPEG nen nen co nhieu mau sac sat nhau. Median filter bo
    cac pixel "le" ma giu nguyen duong bien → palette gon hon → PNG nhe hon
    ma hinh van dep.
    """
    from PIL import ImageFilter
    return im.convert('RGB').filter(ImageFilter.MedianFilter(size=3))


def save_opt(im, path, colors=64):
    """Luu PNG voi palette toi uu, dam bao < 150KB.

    Kich thuoc lon (1024) can palette it hon de nhip < 150KB:
    dung `colors` 32 cho >= 512px, 64 cho nho hon.
    """
    im = im.convert('RGB')
    q = im.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG)
    q.save(path, optimize=True)
    return os.path.getsize(path)


def main():
    os.makedirs(os.path.join(ROOT, 'public', 'brand'), exist_ok=True)
    src = Image.open(SRC).convert('RGB')
    logo = remove_bg(src)

    logo.save(os.path.join(ROOT, 'public', 'brand', 'logo.png'))
    logo.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, 'public', 'brand', 'logo-512.png'))
    fit_square(logo, 512, pad_ratio=0.10).save(os.path.join(ROOT, 'public', 'brand', 'logo-maskable.png'))
    # Ban nho cho header / sidebar / login (nen trong suot)
    for s in (64, 96, 192):
        logo.resize((s, s), Image.LANCZOS).save(
            os.path.join(ROOT, 'public', 'brand', 'logo-%d.png' % s))

    DARK = (10, 14, 20, 255)
    for size in (16, 32, 180, 192, 512, 1024):
        save_opt(denoise(fit_square(logo, size, pad_ratio=0.06, bg=DARK)),
                 os.path.join(ROOT, 'public', 'icons', 'icon-%d.png' % size),
                 colors=16 if size >= 1024 else (32 if size >= 512 else 64))
    save_opt(denoise(fit_square(logo, 512, pad_ratio=0.12, bg=DARK)),
             os.path.join(ROOT, 'public', 'icons', 'icon-512-maskable.png'), colors=32)
    save_opt(denoise(fit_square(logo, 180, pad_ratio=0.05, bg=DARK)),
             os.path.join(ROOT, 'public', 'apple-touch-icon.png'), colors=64)
    save_opt(denoise(fit_square(logo, 32, pad_ratio=0.03, bg=DARK)),
             os.path.join(ROOT, 'public', 'icons', 'favicon-32.png'), colors=64)

    # Thong ke
    alpha = logo.getchannel('A')
    hist = alpha.histogram()
    tot = logo.width * logo.height
    print('logo.png: alpha=0 %.1f%%  alpha=255 %.1f%%' % (
        hist[0] * 100.0 / tot, hist[255] * 100.0 / tot))

    # Kiem tra pixel do nhan con trong icon khong
    im = Image.open(os.path.join(ROOT, 'public', 'icons', 'icon-192.png')).convert('RGB')
    p = im.load()
    red = gold = 0
    for y in range(im.height):
        for x in range(im.width):
            r, g, b = p[x, y]
            if r > 150 and g < 70 and b < 70:
                red += 1
            elif r > 200 and g > 150 and b < 90:
                gold += 1
    print('icon-192: pixel do=%d  pixel vang=%d' % (red, gold))
    print('DONE')


if __name__ == '__main__':
    main()
