# BeerPOS - Auto Deploy Guide (tổng hợp)

> **Cập nhật 2026-08-18:** Hệ thống auto deploy đã được chuẩn hoá.
> Có **2 cách chính** để deploy, mỗi cách phục vụ một mục đích khác nhau.

---

## 🎯 Hai cách deploy chính

### Cách 1: Push lên `main` → Tự động deploy (KHUYẾN NGHỊ)

```
Local (D:\Beer)  ──git push──>  GitHub  ──webhook──>  Server
                                                         │
                                                         └─> bash deploy/deploy.sh
                                                              ├─ git pull
                                                              ├─ backup files
                                                              ├─ syntax check
                                                              ├─ npm install (nếu cần)
                                                              ├─ pm2 restart
                                                              └─ curl /health
```

**Cần setup:**
1. VPS có git repo ở `~/beer-pos` với remote trỏ về GitHub
2. Trên GitHub repo → Settings → Webhooks → Add:
   - Payload URL: `https://admin.biatuoitayninh.store/deploy`
   - Content type: `application/json`
   - Secret: phải **khớp** với `GITHUB_WEBHOOK_SECRET` trong `.env` trên server
   - Events: chỉ tick "Push events"
3. Server `.env` có `GITHUB_WEBHOOK_SECRET=<chuỗi random 32+ ký tự>`

**Cách test nhanh:**
```bash
# Từ local - test webhook trước khi thực sự push
curl -X POST https://admin.biatuoitayninh.store/deploy \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: sha256=<tính bằng HMAC>" \
  -d '{"ref":"refs/heads/main","head_commit":{"id":"test","message":"manual test"}}'

# Xem trạng thái deploy
curl https://admin.biatuoitayninh.store/deploy/status

# Xem log 100 dòng gần nhất
curl https://admin.biatuoitayninh.store/deploy/log?lines=100
```

### Cách 2: Manual SCP từ Windows (dùng khi cần deploy nhanh không qua Git)

```
Local (PowerShell)  ──scp──>  ~/beer-pos_new/  ──ssh──>  bash deploy.sh
```

**Lệnh thường dùng:**
```powershell
# Deploy 1 file (nhanh nhất)
.\deploy\deploy_local.ps1 -Path ".\views\qr-settings.html"

# Deploy nhiều file
.\deploy\deploy_local.ps1 -Path ".\public\js\sales.js"
.\deploy\deploy_local.ps1 -Path ".\routes\api\settings.js"

# Deploy toàn bộ (CHÚ Ý: không gồm .env, *.sqlite, node_modules)
.\deploy\deploy_local.ps1 -All -SkipConfirm

# Dùng SSH Host alias (đã config sẵn trong ~/.ssh/config)
.\deploy\deploy_local.ps1 -All -UseHostAlias

# Trigger manual qua webhook (cần biết DEPLOY_WEBHOOK_SECRET)
curl -X POST https://admin.biatuoitayninh.store/webhook/deploy \
  -H "Authorization: Bearer $DEPLOY_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"message":"manual deploy"}'
```

---

## 📁 Cấu trúc file deploy

```
deploy/
├── deploy.sh              # Script chính chạy TRÊN server (cả 2 cách đều dùng)
├── deploy_local.ps1       # Script Windows cho Manual SCP
├── migrate_add_tier.sh    # Migration: add tier column (idempotent)
├── migrate_tier.bat       # Wrapper Windows cho migration
├── nginx/
│   └── beerpos.conf       # Nginx config (SSL + admin + public)
├── .env.production        # Template env cho production
├── DEPLOY.md              # Hướng dẫn deploy c� (legacy, còn để tham khảo)
├── AUTO_DEPLOY.md         # File này
└── post-receive           # Git hook (legacy - không dùng)
```

**Root directory:**
```
.github/workflows/deploy.yml   # GitHub Actions (alternative cho cách 1)
server.js                       # Webhook endpoint (cách 1 + cách 2 token)
ecosystem.config.js             # PM2 config
```

---

## ⚙️ Setup ban đầu (chỉ làm 1 lần)

### Trên VPS

```bash
# 1. Clone repo (hoặc copy code lên /var/www/beer-pos hoặc ~/beer-pos)
mkdir -p ~/beer-pos && cd ~/beer-pos
git clone git@github.com:<user>/<repo>.git .

# 2. Setup SSH key cho GitHub
ssh-keygen -t ed25519 -C "deploy@beerpos" -f ~/.ssh/github_deploy
cat ~/.ssh/github_deploy.pub   # Copy lên GitHub → Settings → Deploy keys

# 3. Tạo .env từ template
cp .env.example .env
nano .env   # Sửa các giá trị, đặc biệt:
           # - GITHUB_WEBHOOK_SECRET = random 32+ ký tự
           # - DEPLOY_WEBHOOK_SECRET = random 32+ ký tự
           # - ADMIN_PASSWORD, JWT_SECRET

# 4. Cài deps + start PM2
npm install --production
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # chạy lệnh sudo mà nó in ra

# 5. Verify
curl http://127.0.0.1:3000/health
curl https://admin.biatuoitayninh.store/deploy/status
```

### Trên Windows (cho Manual SCP)

```powershell
# 1. SSH key (đã có sẵn trong d:\Beer\cursor_deploy_key)
# Nếu chưa có, generate:
ssh-keygen -t ed25519 -f "$HOME\.ssh\id_ed25519"

# 2. Copy public key lên server
type $HOME\.ssh\id_ed25519.pub | ssh root@103.75.183.57 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# 3. Test
ssh root@103.75.183.57 "echo OK"

# 4. (Optional) Config SSH Host alias để gọn hơn
# File: C:\Users\ADMIN\.ssh\config
# Nội dung:
#   Host beer-server
#       HostName 103.75.183.57
#       User root
#       IdentityFile D:/Beer/cursor_deploy_key
#       IdentitiesOnly yes
#       StrictHostKeyChecking no

# 5. Test deploy
.\deploy\deploy_local.ps1 -Path ".\server.js" -SkipConfirm
```

---

## 🔍 Endpoints debug

| Endpoint | Mô tả | Auth |
|----------|-------|------|
| `GET /health` | Health check toàn diện (DB, backup, deploy status) | Public |
| `GET /api/ping` | Ping đơn giản | Public |
| `GET /deploy/status` | Trạng thái deploy hiện tại + lần cuối | Public |
| `GET /deploy/log?lines=100` | Log deploy gần nhất | Public |
| `POST /deploy` | GitHub webhook (HMAC SHA256) | GitHub |
| `POST /webhook/deploy` | Token webhook | Bearer token |

**Ví dụ response `/deploy/status`:**
```json
{
  "ok": true,
  "state": {
    "status": "success",
    "trigger": "github",
    "ref": "refs/heads/main",
    "started_at": "2026-08-18T07:00:00.000Z",
    "finished_at": "2026-08-18T07:00:42.000Z",
    "last_deploy_id": "1692337200000-abc123",
    "last_deploy_at": "2026-08-18T07:00:00.000Z",
    "rate_limit_until": null,
    "error": null
  },
  "server": {
    "hostname": "vps-abc",
    "uptime_seconds": 86400,
    "node_version": "v20.20.2"
  }
}
```

---

## 🛡️ Tính năng bảo mật

| Tính năng | Mô tả |
|-----------|-------|
| **GitHub HMAC SHA256** | `POST /deploy` xác minh `x-hub-signature-256` |
| **Token Bearer** | `POST /webhook/deploy` yêu cầu `DEPLOY_WEBHOOK_SECRET` |
| **Idempotency** | Cùng `X-Deploy-ID` (hoặc trong payload) bị bỏ qua trong 5 phút |
| **Rate limit** | Sau mỗi deploy thành công, webhook bị chặn 30s |
| **Lock file** | `/tmp/beerpos-deploy.lock` - chống 2 deploy chạy đồng thời |
| **Branch filter** | Chỉ deploy khi push lên `main` (GitHub webhook tự check) |
| **Database protection** | `database.sqlite`, `beer.db` KHÔNG BAO GIỜ bị overwrite từ staging |
| **Backup trước deploy** | Mỗi lần deploy backup ~15 file critical vào `.backup/` (giữ 50 file gần nhất) |
| **Syntax check** | Chạy `node -c` cho tất cả JS trước khi restart PM2; rollback nếu fail |
| **Health check** | Sau restart, curl `/health` → nếu không 200 thì exit code 6 |

---

## 🐛 Troubleshooting

### Deploy không chạy sau khi push

```bash
# 1. Kiểm tra GitHub webhook có gửi request không
#    Vào GitHub → repo → Settings → Webhooks → Recent deliveries

# 2. Kiểm tra secret có khớp không
ssh root@server "grep GITHUB_WEBHOOK_SECRET /var/www/beer-pos/.env"

# 3. Test trực tiếp
ssh root@server "curl -X POST http://127.0.0.1:3000/deploy/status"
# Xem deploy status
```

### Deploy fail ở bước syntax check

```bash
# Xem log chi tiết
ssh root@server "cat /var/www/beer-pos/logs/deploy-webhook.log | tail -50"
ssh root@server "cat /var/www/beer-pos/logs/deploy.log | tail -50"

# Restore manually từ backup
ssh root@server "ls -t /var/www/beer-pos/.backup/ | head -10"
ssh root@server "cp /var/www/beer-pos/.backup/server.js.bak.<timestamp> /var/www/beer-pos/server.js"
ssh root@server "pm2 restart beer-pos"
```

### Deploy fail ở bước health check

```bash
# Xem log PM2
ssh root@server "pm2 logs beer-pos --lines 100 --nostream"

# Kiểm tra process có chạy không
ssh root@server "pm2 status"
ssh root@server "ss -tlnp | grep 3000"

# Manual restart
ssh root@server "pm2 restart beer-pos --update-env"
```

### Manual SCP không kết nối được

```powershell
# Test SSH
ssh -v root@103.75.183.57 "echo OK"

# Nếu báo "Permission denied"
type $HOME\.ssh\id_ed25519.pub | ssh root@103.75.183.57 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# Nếu báo "Connection refused"
# → Server chết hoặc firewall chặn port 22. Vào Hostinger panel check.
```

### Lock file bị stuck (deploy cũ chưa dọn)

```bash
# Xem lock
ssh root@server "cat /tmp/beerpos-deploy.lock"
ssh root@server "ps -p <PID>"

# Xoá nếu process không tồn tại
ssh root@server "rm -f /tmp/beerpos-deploy.lock"
```

---

## 📝 Files KHÔNG nên dùng (legacy - để tham khảo)

| File | Lý do xếp vào legacy |
|------|----------------------|
| `deploy/post-receive` | Git hook cũ - workflow mới dùng webhook |
| `deploy/deploy.bat` | Còn dùng `git push` (cũ) |
| `deploy/DEPLOY.md` | Hướng dẫn cũ, đã có AUTO_DEPLOY.md |
| `server_deploy.py` | Deploy bằng tar.gz - thay bằng deploy_local.ps1 |
| `ssh_run.py` | Helper SSH chung - dùng cho debug, không phải deploy |
| `.github/workflows/deploy.yml` | Alternative cho webhook - chỉ dùng nếu cần CI/CD phức tạp |

---

## 🔄 So sánh các cách deploy

| Tiêu chí | GitHub Push (Cách 1) | Manual SCP (Cách 2) | GitHub Action |
|----------|----------------------|---------------------|----------------|
| **Tốc độ** | ~30s (sau khi GitHub forward webhook) | ~10-30s | ~60-90s (clone + deploy) |
| **Đơn giản** | Push bình thường | Cần chạy lệnh PowerShell | Cần config secrets trên GitHub |
| **An toàn** | HMAC + idempotency + lock | SSH key + manual confirm | SSH key |
| **Khi nào dùng** | Deploy bình thường | Deploy nóng 1 file, không muốn commit | CI/CD với tests/matrix |
| **Rollback** | Push revert commit | Copy file cũ lên staging | Re-run workflow |

**Khuyến nghị:** Dùng **Cách 1** cho 95% trường hợp. Chỉ dùng **Cách 2** khi:
- Test nhanh 1 file không muốn commit
- Không có internet để push lên GitHub
- Cần bypass rate limit 30s
