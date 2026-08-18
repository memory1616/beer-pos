# Hướng Dẫn Setup GitHub Webhook cho Auto Deploy

> Mục tiêu: Khi push code lên GitHub → server tự động deploy.

---

## 📋 Thông Tin Cần Có

| Mục | Giá trị |
|---|---|
| **GitHub repo** | `your-username/beer-pos` (thay b�ng tên repo thực tế) |
| **Server public URL** | `http://103.75.183.57:3000` (hoặc domain nếu có HTTPS) |
| **Webhook endpoint** | `POST http://103.75.183.57:3000/deploy` |
| **Secret** | `8d5780a20a06427187c3e6cebf0b92078b929b4b0d97a2f9bdf83208a3151fd6` |

⚠️ **Lưu ý bảo mật**:
- Secret ở trên là `GITHUB_WEBHOOK_SECRET` trong file `.env` trên server.
- Server hiện không có HTTPS (chỉ HTTP) → GitHub cho phép nhưng phải chấp nhận rủi ro.
- **Khuyến nghị**: Dùng Cloudflare Tunnel hoặc nginx + Let's Encrypt nếu cần HTTPS.

---

## 🚀 Setup Webhook trên GitHub

### Bước 1: Truy cập Settings → Webhooks

1. Mở repo GitHub của bạn (vd: `https://github.com/your-username/beer-pos`)
2. Click tab **Settings** (⚙️) ở trên cùng
3. Trong menu trái, click **Webhooks** (nằm dưới nhóm "Code and automation")
4. Click nút **Add webhook** (màu xanh)

### Bước 2: Cấu hình Webhook

Điền các trường sau:

| Field | Value | Ghi chú |
|---|---|---|
| **Payload URL** | `http://103.75.183.57:3000/deploy` | Endpoint webhook server |
| **Content type** | `application/json` | Mặc định |
| **Secret** | `8d5780a20a06427187c3e6cebf0b92078b929b4b0d97a2f9bdf83208a3151fd6` | Phải khớp với `GITHUB_WEBHOOK_SECRET` trên server |
| **SSL verification** | Disable (nếu HTTP) | GitHub yêu cầu HTTPS, nhưng có thể tắt để test |
| **Which events...** | "Just the push event" | Chỉ cần push, không cần PR |
| **Active** | ✅ Checked | Bật |

### Bước 3: Lưu & Test

1. Click **Add webhook** (màu xanh)
2. Sau khi tạo, click vào webhook vừa tạo → tab **Recent deliveries**
3. GitHub sẽ tự động gửi **ping** event (màu đỏ nếu fail)
4. Nếu thấy ✅ response 200 = thành công

---

## 🧪 Test Webhook (sau khi setup)

### Test 1: Từ GitHub UI

Sau khi setup xong, click **Redeliver** trên 1 ping delivery để test lại.

### Test 2: Touch 1 file rồi push

```bash
# Từ máy local
cd d:\Beer
echo "Test $(date)" >> README.md
git add README.md
git commit -m "test: trigger webhook"
git push origin main
```

Sau ~3-5 giây, kiểm tra:

```bash
# Status deploy
ssh beer-server "curl -s http://127.0.0.1:3000/deploy/status"

# Tail log
ssh beer-server "curl -s http://127.0.0.1:3000/deploy/log?lines=30"
```

### Test 3: Test thủ công (không cần GitHub)

```bash
# Local từ server (giả lập GitHub payload)
ssh beer-server "python3 -c '
import hmac, hashlib, json, urllib.request
secret = \"8d5780a20a06427187c3e6cebf0b92078b929b4b0d97a2f9bdf83208a3151fd6\"
payload = {\"ref\":\"refs/heads/main\", \"after\":\"abc123\", \"head_commit\":{\"message\":\"manual test\", \"id\":\"abc123\"}}
body = json.dumps(payload).encode()
sig = \"sha256=\" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
req = urllib.request.Request(\"http://127.0.0.1:3000/deploy\", data=body,
  headers={\"Content-Type\":\"application/json\", \"X-GitHub-Event\":\"push\", \"X-Hub-Signature-256\":sig})
r = urllib.request.urlopen(req, timeout=10)
print(r.status, r.read().decode())
'"
```

---

## 🔐 Tăng Cường Bảo Mật (Khuyến Nghị)

### Option 1: HTTPS qua Cloudflare Tunnel (FREE)

Cloudflare Tunnel cho phép expose server nội bộ ra HTTPS mà không cần config nginx:

```bash
# Cài cloudflared trên server
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Login + create tunnel
cloudflared tunnel login
cloudflared tunnel create beer-pos
cloudflared tunnel route dns beer-pos beer.your-domain.com

# Run tunnel (point to localhost:3000)
cloudflared tunnel --url http://localhost:3000 run beer-pos
```

Sau đó update GitHub webhook URL thành `https://beer.your-domain.com/deploy`.

### Option 2: nginx + Let's Encrypt

Nếu server có public IP và domain:

```bash
# Cài certbot
sudo apt install certbot python3-certbot-nginx

# Generate cert
sudo certbot --nginx -d beer.your-domain.com
```

Update nginx config reverse proxy `127.0.0.1:3000`.

---

## 🐛 Troubleshooting

### Webhook không trigger (status fail trên GitHub)

```bash
# 1. Check server có chạy không
ssh beer-server "curl -s http://127.0.0.1:3000/health"

# 2. Check PM2 status
ssh beer-server "pm2 status"

# 3. Check log webhook
ssh beer-server "tail -50 /var/www/beer-pos/logs/deploy.log"

# 4. Check error log
ssh beer-server "pm2 logs beer-pos --lines 50 --nostream | tail -30"
```

### Lỗi "Invalid signature"

- Secret trên GitHub phải **khớp chính xác** với `GITHUB_WEBHOOK_SECRET` trong `/var/www/beer-pos/.env`
- Restart PM2 sau khi đổi secret: `pm2 restart beer-pos`

### Lỗi "SSL verification failed"

- GitHub yêu cầu HTTPS. Workaround: Disable SSL verification trong webhook settings
- Hoặc setup Cloudflare Tunnel (xem Option 1 ở trên)

### Lỗi "Connection refused" / "Timed out"

- Firewall trên server có thể block port 3000. Mở port:
  ```bash
  sudo ufw allow 3000/tcp
  ```
- Hoặc dùng Cloudflare Tunnel để bypass firewall.

---

## 📊 Monitoring

Sau khi setup, theo dõi deploy qua:

```bash
# Real-time log
ssh beer-server "pm2 logs beer-pos --lines 0"

# Deploy state
ssh beer-server "curl -s http://127.0.0.1:3000/deploy/status | python3 -m json.tool"

# Recent deploy logs
ssh beer-server "curl -s 'http://127.0.0.1:3000/deploy/log?lines=50'"
```

GitHub cũng track deliveries ở **Settings → Webhooks → Recent deliveries** (response code, headers, payload).
