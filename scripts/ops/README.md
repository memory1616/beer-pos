# Hướng dẫn cài Watchdog + Auto-start cho beer-pos

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
