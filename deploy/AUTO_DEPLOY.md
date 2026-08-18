# BeerPOS - Auto Deploy Guide (tá»•ng há»£p)

> **Cáº­p nháº­t 2026-08-18:** Há»‡ thá»‘ng auto deploy Ä‘Ã£ Ä‘Æ°á»£c chuáº©n hoÃ¡.
> CÃ³ **2 cÃ¡ch chÃ­nh** Ä‘á»ƒ deploy, má»—i cÃ¡ch phá»¥c vá»¥ má»™t má»¥c Ä‘Ã­ch khÃ¡c nhau.

---

## ðŸŽ¯ Hai cÃ¡ch deploy chÃ­nh

### CÃ¡ch 1: Push lÃªn `main` â†’ Tá»± Ä‘á»™ng deploy (KHUYáº¾N NGHá»Š)

```
Local (D:\Beer)  â”€â”€git pushâ”€â”€>  GitHub  â”€â”€webhookâ”€â”€>  Server
                                                         â”‚
                                                         â””â”€> bash deploy/deploy.sh
                                                              â”œâ”€ git pull
                                                              â”œâ”€ backup files
                                                              â”œâ”€ syntax check
                                                              â”œâ”€ npm install (náº¿u cáº§n)
                                                              â”œâ”€ pm2 restart
                                                              â””â”€ curl /health
```

**Cáº§n setup:**
1. VPS cÃ³ git repo á»Ÿ `~/beer-pos` vá»›i remote trá» vá» GitHub
2. TrÃªn GitHub repo â†’ Settings â†’ Webhooks â†’ Add:
   - Payload URL: `http://<server>:3000/deploy` (hoáº·c domain náº¿u cÃ³ HTTPS)
   - Content type: `application/json`
   - Secret: pháº£i **khá»›p** vá»›i `GITHUB_WEBHOOK_SECRET` trong `.env` trÃªn server
   - Events: chá»‰ tick "Push events"
3. Server `.env` cÃ³ `GITHUB_WEBHOOK_SECRET=<chuá»—i random 32+ kÃ½ tá»±>`

ðŸ“– **Chi tiáº¿t tá»«ng bÆ°á»›c setup GitHub webhook UI:** xem [`deploy/GITHUB_WEBHOOK_SETUP.md`](GITHUB_WEBHOOK_SETUP.md)

**CÃ¡ch test nhanh:**
```bash
# Tá»« local - test webhook trÆ°á»›c khi thá»±c sá»± push
curl -X POST https://admin.biatuoitayninh.store/deploy \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: sha256=<tÃ­nh báº±ng HMAC>" \
  -d '{"ref":"refs/heads/main","head_commit":{"id":"test","message":"manual test"}}'

# Xem tráº¡ng thÃ¡i deploy
curl https://admin.biatuoitayninh.store/deploy/status

# Xem log 100 dÃ²ng gáº§n nháº¥t
curl https://admin.biatuoitayninh.store/deploy/log?lines=100
```

### CÃ¡ch 2: Manual SCP tá»« Windows (dÃ¹ng khi cáº§n deploy nhanh khÃ´ng qua Git)

```
Local (PowerShell)  â”€â”€scpâ”€â”€>  ~/beer-pos_new/  â”€â”€sshâ”€â”€>  bash deploy.sh
```

**Lá»‡nh thÆ°á»ng dÃ¹ng:**
```powershell
# Deploy 1 file (nhanh nháº¥t)
.\deploy\deploy_local.ps1 -Path ".\views\qr-settings.html"

# Deploy nhiá»u file
.\deploy\deploy_local.ps1 -Path ".\public\js\sales.js"
.\deploy\deploy_local.ps1 -Path ".\routes\api\settings.js"

# Deploy toÃ n bá»™ (CHÃš Ã: khÃ´ng gá»“m .env, *.sqlite, node_modules)
.\deploy\deploy_local.ps1 -All -SkipConfirm

# DÃ¹ng SSH Host alias (Ä‘Ã£ config sáºµn trong ~/.ssh/config)
.\deploy\deploy_local.ps1 -All -UseHostAlias

# Trigger manual qua webhook (cáº§n biáº¿t DEPLOY_WEBHOOK_SECRET)
curl -X POST https://admin.biatuoitayninh.store/webhook/deploy \
  -H "Authorization: Bearer $DEPLOY_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"message":"manual deploy"}'
```

---

## ðŸ“ Cáº¥u trÃºc file deploy

```
deploy/
â”œâ”€â”€ deploy.sh              # Script chÃ­nh cháº¡y TRÃŠN server (cáº£ 2 cÃ¡ch Ä‘á»u dÃ¹ng)
â”œâ”€â”€ deploy_local.ps1       # Script Windows cho Manual SCP
â”œâ”€â”€ migrate_add_tier.sh    # Migration: add tier column (idempotent)
â”œâ”€â”€ migrate_tier.bat       # Wrapper Windows cho migration
â”œâ”€â”€ nginx/
â”‚   â””â”€â”€ beerpos.conf       # Nginx config (SSL + admin + public)
â”œâ”€â”€ .env.production        # Template env cho production
â”œâ”€â”€ DEPLOY.md              # HÆ°á»›ng dáº«n deploy cï¿½ (legacy, cÃ²n Ä‘á»ƒ tham kháº£o)
â”œâ”€â”€ AUTO_DEPLOY.md         # File nÃ y
â””â”€â”€ post-receive           # Git hook (legacy - khÃ´ng dÃ¹ng)
```

**Root directory:**
```
.github/workflows/deploy.yml   # GitHub Actions (alternative cho cÃ¡ch 1)
server.js                       # Webhook endpoint (cÃ¡ch 1 + cÃ¡ch 2 token)
ecosystem.config.js             # PM2 config
```

---

## âš™ï¸ Setup ban Ä‘áº§u (chá»‰ lÃ m 1 láº§n)

### TrÃªn VPS

```bash
# 1. Clone repo (hoáº·c copy code lÃªn /var/www/beer-pos hoáº·c ~/beer-pos)
mkdir -p ~/beer-pos && cd ~/beer-pos
git clone git@github.com:<user>/<repo>.git .

# 2. Setup SSH key cho GitHub
ssh-keygen -t ed25519 -C "deploy@beerpos" -f ~/.ssh/github_deploy
cat ~/.ssh/github_deploy.pub   # Copy lÃªn GitHub â†’ Settings â†’ Deploy keys

# 3. Táº¡o .env tá»« template
cp .env.example .env
nano .env   # Sá»­a cÃ¡c giÃ¡ trá»‹, Ä‘áº·c biá»‡t:
           # - GITHUB_WEBHOOK_SECRET = random 32+ kÃ½ tá»±
           # - DEPLOY_WEBHOOK_SECRET = random 32+ kÃ½ tá»±
           # - ADMIN_PASSWORD, JWT_SECRET

# 4. CÃ i deps + start PM2
npm install --production
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # cháº¡y lá»‡nh sudo mÃ  nÃ³ in ra

# 5. Verify
curl http://127.0.0.1:3000/health
curl https://admin.biatuoitayninh.store/deploy/status
```

### TrÃªn Windows (cho Manual SCP)

```powershell
# 1. SSH key (Ä‘Ã£ cÃ³ sáºµn trong d:\Beer\cursor_deploy_key)
# Náº¿u chÆ°a cÃ³, generate:
ssh-keygen -t ed25519 -f "$HOME\.ssh\id_ed25519"

# 2. Copy public key lÃªn server
type $HOME\.ssh\id_ed25519.pub | ssh root@103.75.183.57 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# 3. Test
ssh root@103.75.183.57 "echo OK"

# 4. (Optional) Config SSH Host alias Ä‘á»ƒ gá»n hÆ¡n
# File: C:\Users\ADMIN\.ssh\config
# Ná»™i dung:
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

## ðŸ” Endpoints debug

| Endpoint | MÃ´ táº£ | Auth |
|----------|-------|------|
| `GET /health` | Health check toÃ n diá»‡n (DB, backup, deploy status) | Public |
| `GET /api/ping` | Ping Ä‘Æ¡n giáº£n | Public |
| `GET /deploy/status` | Tráº¡ng thÃ¡i deploy hiá»‡n táº¡i + láº§n cuá»‘i | Public |
| `GET /deploy/log?lines=100` | Log deploy gáº§n nháº¥t | Public |
| `POST /deploy` | GitHub webhook (HMAC SHA256) | GitHub |
| `POST /webhook/deploy` | Token webhook | Bearer token |

**VÃ­ dá»¥ response `/deploy/status`:**
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

## ðŸ›¡ï¸ TÃ­nh nÄƒng báº£o máº­t

| TÃ­nh nÄƒng | MÃ´ táº£ |
|-----------|-------|
| **GitHub HMAC SHA256** | `POST /deploy` xÃ¡c minh `x-hub-signature-256` |
| **Token Bearer** | `POST /webhook/deploy` yÃªu cáº§u `DEPLOY_WEBHOOK_SECRET` |
| **Idempotency** | CÃ¹ng `X-Deploy-ID` (hoáº·c trong payload) bá»‹ bá» qua trong 5 phÃºt |
| **Rate limit** | Sau má»—i deploy thÃ nh cÃ´ng, webhook bá»‹ cháº·n 30s |
| **Lock file** | `/tmp/beerpos-deploy.lock` - chá»‘ng 2 deploy cháº¡y Ä‘á»“ng thá»i |
| **Branch filter** | Chá»‰ deploy khi push lÃªn `main` (GitHub webhook tá»± check) |
| **Database protection** | `database.sqlite`, `beer.db` KHÃ”NG BAO GIá»œ bá»‹ overwrite tá»« staging |
| **Backup trÆ°á»›c deploy** | Má»—i láº§n deploy backup ~15 file critical vÃ o `.backup/` (giá»¯ 50 file gáº§n nháº¥t) |
| **Syntax check** | Cháº¡y `node -c` cho táº¥t cáº£ JS trÆ°á»›c khi restart PM2; rollback náº¿u fail |
| **Health check** | Sau restart, curl `/health` â†’ náº¿u khÃ´ng 200 thÃ¬ exit code 6 |

---

## ðŸ› Troubleshooting

### Deploy khÃ´ng cháº¡y sau khi push

```bash
# 1. Kiá»ƒm tra GitHub webhook cÃ³ gá»­i request khÃ´ng
#    VÃ o GitHub â†’ repo â†’ Settings â†’ Webhooks â†’ Recent deliveries

# 2. Kiá»ƒm tra secret cÃ³ khá»›p khÃ´ng
ssh root@server "grep GITHUB_WEBHOOK_SECRET /var/www/beer-pos/.env"

# 3. Test trá»±c tiáº¿p
ssh root@server "curl -X POST http://127.0.0.1:3000/deploy/status"
# Xem deploy status
```

### Deploy fail á»Ÿ bÆ°á»›c syntax check

```bash
# Xem log chi tiáº¿t
ssh root@server "cat /var/www/beer-pos/logs/deploy-webhook.log | tail -50"
ssh root@server "cat /var/www/beer-pos/logs/deploy.log | tail -50"

# Restore manually tá»« backup
ssh root@server "ls -t /var/www/beer-pos/.backup/ | head -10"
ssh root@server "cp /var/www/beer-pos/.backup/server.js.bak.<timestamp> /var/www/beer-pos/server.js"
ssh root@server "pm2 restart beer-pos"
```

### Deploy fail á»Ÿ bÆ°á»›c health check

```bash
# Xem log PM2
ssh root@server "pm2 logs beer-pos --lines 100 --nostream"

# Kiá»ƒm tra process cÃ³ cháº¡y khÃ´ng
ssh root@server "pm2 status"
ssh root@server "ss -tlnp | grep 3000"

# Manual restart
ssh root@server "pm2 restart beer-pos --update-env"
```

### Manual SCP khÃ´ng káº¿t ná»‘i Ä‘Æ°á»£c

```powershell
# Test SSH
ssh -v root@103.75.183.57 "echo OK"

# Náº¿u bÃ¡o "Permission denied"
type $HOME\.ssh\id_ed25519.pub | ssh root@103.75.183.57 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# Náº¿u bÃ¡o "Connection refused"
# â†’ Server cháº¿t hoáº·c firewall cháº·n port 22. VÃ o Hostinger panel check.
```

### Lock file bá»‹ stuck (deploy cÅ© chÆ°a dá»n)

```bash
# Xem lock
ssh root@server "cat /tmp/beerpos-deploy.lock"
ssh root@server "ps -p <PID>"

# XoÃ¡ náº¿u process khÃ´ng tá»“n táº¡i
ssh root@server "rm -f /tmp/beerpos-deploy.lock"
```

---

## ðŸ“ Files KHÃ”NG nÃªn dÃ¹ng (legacy - Ä‘á»ƒ tham kháº£o)

| File | LÃ½ do xáº¿p vÃ o legacy |
|------|----------------------|
| `deploy/post-receive` | Git hook cÅ© - workflow má»›i dÃ¹ng webhook |
| `deploy/deploy.bat` | CÃ²n dÃ¹ng `git push` (cÅ©) |
| `deploy/DEPLOY.md` | HÆ°á»›ng dáº«n cÅ©, Ä‘Ã£ cÃ³ AUTO_DEPLOY.md |
| `server_deploy.py` | Deploy báº±ng tar.gz - thay báº±ng deploy_local.ps1 |
| `ssh_run.py` | Helper SSH chung - dÃ¹ng cho debug, khÃ´ng pháº£i deploy |
| `.github/workflows/deploy.yml` | Alternative cho webhook - chá»‰ dÃ¹ng náº¿u cáº§n CI/CD phá»©c táº¡p |

---

## ðŸ”„ So sÃ¡nh cÃ¡c cÃ¡ch deploy

| TiÃªu chÃ­ | GitHub Push (CÃ¡ch 1) | Manual SCP (CÃ¡ch 2) | GitHub Action |
|----------|----------------------|---------------------|----------------|
| **Tá»‘c Ä‘á»™** | ~30s (sau khi GitHub forward webhook) | ~10-30s | ~60-90s (clone + deploy) |
| **ÄÆ¡n giáº£n** | Push bÃ¬nh thÆ°á»ng | Cáº§n cháº¡y lá»‡nh PowerShell | Cáº§n config secrets trÃªn GitHub |
| **An toÃ n** | HMAC + idempotency + lock | SSH key + manual confirm | SSH key |
| **Khi nÃ o dÃ¹ng** | Deploy bÃ¬nh thÆ°á»ng | Deploy nÃ³ng 1 file, khÃ´ng muá»‘n commit | CI/CD vá»›i tests/matrix |
| **Rollback** | Push revert commit | Copy file cÅ© lÃªn staging | Re-run workflow |

**Khuyáº¿n nghá»‹:** DÃ¹ng **CÃ¡ch 1** cho 95% trÆ°á»ng há»£p. Chá»‰ dÃ¹ng **CÃ¡ch 2** khi:
- Test nhanh 1 file khÃ´ng muá»‘n commit
- KhÃ´ng cÃ³ internet Ä‘á»ƒ push lÃªn GitHub
- Cáº§n bypass rate limit 30s