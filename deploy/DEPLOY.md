# BeerPOS — Hướng dẫn Deploy lên VPS

> **Workflow mới (2026-06-18):** Dùng SCP + SSH key (không cần GitHub SSH key trên VPS).

---

## 📋 Mục lục
1. [Workflow tổng quan](#workflow-tổng-quan)
2. [Quick Start](#quick-start)
3. [Cấu trúc file deploy](#cấu-trúc-file-deploy)
4. [Setup SSH key](#setup-ssh-key)
5. [Deploy một file](#deploy-một-file)
6. [Deploy toàn bộ](#deploy-toàn-bộ)
7. [Migration database](#migration-database)
8. [Update nginx config](#update-nginx-config)
9. [Rollback](#rollback)
10. [Troubleshooting](#troubleshooting)

---

## Workflow tổng quan

```
┌──────────┐  SCP (SSH key)  ┌──────────┐
│  Local   │ ───────────────>│   VPS    │
│ Windows  │                 │ Ubuntu   │
│ (D:\Beer)│<──── ssh ──────│ /root/   │
└──────────┘   restart pm2   │ beer-pos │
                             └──────────┘

1. Local: edit files
2. Local: chạy deploy_local.ps1
3. Script: SCP files → ~/beer-pos_new/
4. Script: SSH + chạy deploy.sh
5. Server: backup old → swap new → restart pm2 → health check
```

**KHÔNG cần:** GitHub SSH key, password, git pull trên server.

---

## Quick Start

```powershell
# Deploy 1 file
.\deploy\deploy_local.ps1 -Path ".\views\qr-settings.html"

# Deploy 1 file JS
.\deploy\deploy_local.ps1 -Path ".\public\js\sales.js"

# Deploy toàn bộ (trừ node_modules, .git, backups, *.sqlite)
.\deploy\deploy_local.ps1 -All

# Bỏ qua confirm
.\deploy\deploy_local.ps1 -Path ".\routes\api\settings.js" -SkipConfirm
```

---

## Cấu trúc file deploy

```
deploy/
├── deploy.sh              # Script chính chạy TRÊN server
├── deploy_local.ps1       # Script Windows tổng quát (gọi SCP + SSH)
├── deploy_qr_pool.sh      # Script riêng cho QR Pool (giữ làm tham khảo)
├── migrate_add_tier.sh    # Migration: add tier column
├── migrate_tier.bat       # Wrapper Windows cho migrate_add_tier.sh
├── nginx/
│   └── beerpos.conf       # Nginx config (copy vào /etc/nginx/sites-available/)
├── DEPLOY.md              # File này
├── .env.production        # Template env cho production
└── post-receive           # Git hook (legacy, không dùng)
```

---

## Setup SSH key

Xem chi tiết ở `deploy/DEPLOY.md` cũ. Tóm tắt:

```powershell
# 1. Generate key (nếu chưa có)
ssh-keygen -t ed25519

# 2. Copy public key lên server
type $HOME\.ssh\id_ed25519.pub | ssh root@103.75.183.57 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Sau khi setup, test:
```powershell
ssh root@103.75.183.57 "echo OK"
```

---

## Deploy một file

**Bước 1:** Sửa file local trong `D:\Beer\...`

**Bước 2:** Chạy script:
```powershell
.\deploy\deploy_local.ps1 -Path ".\views\qr-settings.html"
```

**Bước 3:** Confirm `y` khi được hỏi.

**Bước 4:** Script tự động:
- SCP file → `/root/beer-pos_new/`
- SSH + chạy `deploy.sh`
- `deploy.sh`:
  - Backup file cũ → `/root/beer-pos/.backup/`
  - Copy file mới vào vị trí
  - `node -c` syntax check
  - `pm2 restart beer-pos`
  - `curl /health` verify

**Bước 5:** Nếu thấy `DEPLOY SUCCESS` là xong.

---

## Deploy toàn bộ

```powershell
.\deploy\deploy_local.ps1 -All
```

Script sẽ sync TẤT CẢ files (trừ `node_modules`, `.git`, `coverage`, `.backup`, `*.sqlite*`, `*.db`, `*.log`).

**⚠️ Cảnh báo:** Lệnh này sync toàn bộ project. Dùng khi:
- Setup lần đầu
- Sau khi thay đổi nhiều file
- Sau khi pull code mới từ git

**Không dùng** khi chỉ sửa 1-2 file (chậm + rủi ro overwrite).

---

## Migration database

```powershell
# Windows
.\deploy\migrate_tier.bat

# Hoặc thủ công qua SSH
ssh root@103.75.183.57 "bash /root/beer-pos/deploy/migrate_add_tier.sh"
```

Script sẽ:
- Auto-detect DB path (`database.sqlite` hoặc `data/beerpos.db`)
- Check column đã tồn tại chưa (idempotent)
- `ALTER TABLE` nếu chưa có
- `pm2 restart beer-pos`

---

## Update nginx config

```bash
# 1. Copy file mới
scp .\deploy\nginx\beerpos.conf root@103.75.183.57:/etc/nginx/sites-available/beerpos.conf.new

# 2. Backup + swap
ssh root@103.75.183.57
cp /etc/nginx/sites-available/beerpos.conf /etc/nginx/sites-available/beerpos.conf.bak.$(date +%Y%m%d)
cp /etc/nginx/sites-available/beerpos.conf.new /etc/nginx/sites-available/beerpos.conf

# 3. Test + reload
nginx -t && systemctl reload nginx
```

**⚠️ Lưu ý:** KHÔNG xoá `beerpos.conf` cũ khi chưa test kỹ.

---

## Rollback

Nếu deploy mới bị lỗi, server tự động giữ backup ở `/root/beer-pos/.backup/`:

```bash
ssh root@103.75.183.57
ls -la /root/beer-pos/.backup/        # Xem các bản backup
cp /root/beer-pos/.backup/server.js.bak.20260618_123456 /root/beer-pos/server.js
pm2 restart beer-pos
```

Hoặc chạy lại `deploy_local.ps1` với bản cũ ở local.

---

## Troubleshooting

### Lỗi "Permission denied" khi SCP
- Kiểm tra SSH key đã add vào server chưa
- Test: `ssh -o BatchMode=yes root@103.75.183.57 echo OK`

### Lỗi "SYNTAX ERROR" trong deploy.sh
- Server tự động restore từ backup
- Xem log: `ssh root@server 'pm2 logs beer-pos --lines 50'`

### Lỗi "Health FAILED" sau deploy
- Server vẫn chạy bản cũ (rollback an toàn)
- Check logs: `ssh root@server 'pm2 logs beer-pos --lines 100 --nostream --raw'`

### Lỗi "Cannot find database" khi migrate
- Set biến: `ssh root@server "DB_PATH=/root/beer-pos/database.sqlite bash deploy/migrate_add_tier.sh"`

### Deploy chậm
- Dùng `-Path <file>` thay vì `-All` khi chỉ sửa ít file

### PM2 không restart
- Check logs: `pm2 logs beer-pos`
- Restart thủ công: `pm2 restart beer-pos --update-env`

---

## Files KHÔNG nên dùng (legacy)

| File | Lý do |
|---|---|
| `deploy/post-receive` | Git hook cũ - workflow mới dùng SCP |
| `deploy/deploy.bat` | Còn dùng `git push` (cũ) |
| `.github/workflows/deploy.yml` | GitHub Actions cũ - không có secrets |
| `_tmp_investigate_ssh.py` | Script debug - đã xong việc |
| `deploy_server_fix.py` | Đã update dùng SSH key (còn dùng được) |
| `deploy_fix.py` | Đã update dùng SSH key (còn dùng được) |
