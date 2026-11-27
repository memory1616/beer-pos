# Hướng dẫn cài Watchdog + Auto-start cho beer-pos

## 0. ⚠️ AN TOÀN DỮ LIỆU — KHÔNG GHI VÀO DB VẬN HÀNH (từ 2026-11-27)

> **Nguyên tắc: "KHÔNG được đụng đến dữ liệu chính."**

Mọi script trong `scripts/ops/` đều phải qua **guard** trước khi mở DB.
Guard nằm ở `src/utils/dbWriteGuard.js` (shim: `scripts/ops/guard.js`).

### Cách chạy an toàn

```bash
# 1) CHẠY TRÊN BẢN SAO (khuyến nghị cho mọi script kiểm thử)
set DB_PATH=<đường dẫn file .sqlite sao>
node scripts/ops/xxx.js

# 2) Script CHỈ ĐỌC — không cần DB_PATH, không chặn
#    (đã cấu hình allowWrite: false trong từng script)

# 3) Ghi CÓ CHỦ ĐÍCH lên DB thật — phải có cờ tường minh
node scripts/ops/xxx.js --allow-prod-write
```

### Ma trận quyền

| Tình huống | Kết quả |
|---|---|
| Script ghi, không `DB_PATH`, không cờ | ❌ **BỊ CHẶN** (throw `DB_WRITE_GUARD_BLOCKED`) |
| Script ghi, `DB_PATH` → bản sao | ✅ Chạy bình thường |
| `NODE_ENV=production` | ❌ **CHẶN TUYỆT ĐỐI** (không cờ nào vượt được) |
| `DB_PATH` trỏ DB thật + `--allow-prod-write` | ✅ Được (có log audit cảnh báo) |
| Script chỉ đọc (`allowWrite: false`) | ✅ Chạy (đọc không làm hỏng dữ liệu) |

### Thêm guard vào script mới

```javascript
// ĐẶT TRƯỚC require database — require DB cũng chạy migration (ghi)!
const guard = require('../../src/utils/dbWriteGuard');
guard.requireSafeDb({ context: 'ghi dữ liệu: ten-script.js', allowWrite: true });
const db = require('../../database');
```

### ⚠️ Script Node chạy trực tiếp trên server

`require('database')` khởi động **cron job nền** (backup 2AM, promotion backfill)
→ process **không bao giờ thoát** → treo terminal. Luôn set:

```javascript
process.env.DISABLE_BACKGROUND_JOBS = '1';
```

Hoặc dùng `sqlite3` CLI cho truy vấn chỉ đọc.

---

## 1. PM2 tự khởi động cùng OS (sau reboot)

```bash
pm2 save              # lưu danh sách process hiện tại
pm2 startup systemd -u root --hp /root
systemctl enable pm2-root
systemctl is-enabled pm2-root   # → enabled
```

## 2. Watchdog cron (tự restart nếu app crash / OOM)

Script: `scripts/ops/watchdog.sh` → cài vào `/usr/local/bin/beerpos-watchdog.sh`

```bash
install -m 755 scripts/ops/watchdog.sh /usr/local/bin/beerpos-watchdog.sh

# Thêm cron (mỗi 5 phút)
(crontab -l 2>/dev/null | grep -v 'beerpos-watchdog' || true; \
 echo '*/5 * * * * /usr/local/bin/beerpos-watchdog.sh >/dev/null 2>&1') | crontab -

crontab -l | grep beerpos-watchdog
```

### Watchdog làm gì

| Tình huống | Hành động |
|---|---|
| App không còn trong PM2 | `pm2 resurrect` (khôi phục từ `dump.pm2`) |
| App status ≠ `online` | `pm2 restart beer-pos` |
| App dùng > 600MB RAM | `pm2 restart` (tránh OOM-killer giết cả máy) |

Log ghi tại `/var/log/beerpos-watchdog.log`.

## 3. Backup DB (đã có sẵn)

```
0 16 * * * /usr/local/bin/server-backup.sh >/dev/null 2>&1
```

Backup lưu tại `/var/www/beer-pos/backups/`, giữ 7 bản gần nhất.

## Kiểm tra tổng thể

```bash
pm2 list | grep beer-pos
systemctl is-active pm2-root nginx
crontab -l
curl -s -o /dev/null -w '%{http_code}\n' https://admin.biatuoitayninh.store/sale
```
