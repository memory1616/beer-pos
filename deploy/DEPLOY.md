# BeerPOS — Hướng dẫn Deploy lên VPS

## Mục lục
1. [Chuẩn bị VPS](#1-chuẩn-bị-vps)
2. [Cài đặt Node.js & PM2](#2-cài-đặt-nodejs--pm2)
3. [Cài đặt Nginx](#3-cài-đặt-nginx)
4. [Cài SSL (Let's Encrypt)](#4-cài-ssl-let-encrypt)
5. [Deploy ứng dụng](#5-deploy-ứng-dụng)
6. [Cấu hình domain](#6-cấu-hình-domain)
7. [Thiết bị kết nối từ xa](#7-thiết-bị-kết-nối-từ-xa)
8. [Bảo trì & Cập nhật](#8-bảo-trì--cập-nhật)

---

## 1. Chuẩn bị VPS

Yêu cầu tối thiểu:
- **OS**: Ubuntu 22.04 LTS (khuyến nghị)
- **RAM**: 1GB+
- **CPU**: 1 core
- **Disk**: 10GB+
- **Domain**: Đã trỏ DNS về IP VPS

Kiểm tra đã trỏ DNS đúng:
```bash
nslookup your-domain.com
```
Kết quả phải trả về IP của VPS.

---

## 2. Cài đặt Node.js & PM2

```bash
# Cài Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Kiểm tra
node -v   # v20.x.x
npm -v

# Cài PM2 (process manager)
sudo npm install -g pm2
pm2 install pm2-logrotate
pm2 set pm2-logrotate max_size 10M
pm2 set pm2-logrotate retain 7
```

---

## 3. Cài đặt Nginx

```bash
sudo apt update && sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

---

## 4. Cài SSL (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx

# Tạo SSL (thay your-domain.com)
sudo certbot --nginx -d your-domain.com

# Certbot sẽ hỏi: nhập email, đồng ý terms, chọn redirect HTTP→HTTPS
# Tự động gia hạn mỗi 90 ngày ✓
```

Nếu chưa có SSL, tạm thời test với self-signed:
```bash
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/ssl/private/nginx-selfsigned.key \
  -out /etc/ssl/certs/nginx-selfsigned.crt
```

---

## 5. Deploy ứng dụng

### 5.1 Tạo thư mục & clone code

```bash
# Tạo thư mục
sudo mkdir -p /var/www/beerpos
sudo chown $USER:$USER /var/www/beerpos

# Clone hoặc copy code (nếu dùng git)
cd /var/www/beerpos
git clone https://github.com/YOUR_USERNAME/beerpos.git .
```

### 5.2 Cài đặt dependencies

```bash
npm install --production
```

### 5.3 Cấu hình .env

```bash
cp deploy/.env.production .env
nano .env
```

Điền các giá trị:
```bash
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
IS_CLOUD_SERVER=true
CLOUD_MODE=true
CLOUD_DOMAIN=https://your-domain.com
SESSION_SECRET=generate-a-long-random-string-here
DISTRIBUTOR_NAME=BeerPOS
ALLOWED_ORIGIN=https://your-domain.com
TRUST_PROXY=true
```

Tạo SESSION_SECRET:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 5.4 Khởi động với PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # Chạy lệnh output để PM2 tự khởi động khi reboot
```

Kiểm tra:
```bash
pm2 status
pm2 logs beerpos --lines 20
```

### 5.5 Cấu hình Nginx

```bash
# Copy config và thay YOUR_DOMAIN.COM
sudo cp /var/www/beerpos/deploy/nginx.conf /etc/nginx/sites-available/beerpos

# Chỉnh sửa domain trong config
sudo nano /etc/nginx/sites-available/beerpos
# Thay YOUR_DOMAIN.COM bằng domain thật của bạn

# Enable site
sudo ln -sf /etc/nginx/sites-available/beerpos /etc/nginx/sites-enabled/

# Test & reload
sudo nginx -t
sudo systemctl reload nginx
```

---

## 6. Cấu hình Domain

Trong panel DNS của nhà cung cấp domain:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | @ | YOUR_VPS_IP | 300 |
| A | www | YOUR_VPS_IP | 300 |

Đợi 5-30 phút để DNS propagate.

---

## 7. Thiết bị kết nối từ xa

### Thiết bị tự động tìm thấy (nếu trong LAN):
- Mở **Dashboard → ☁️ Cloud** → **Tìm Cloud trong mạng LAN**

### Thiết bị từ xa (khác LAN):
1. Mở **Dashboard → ☁️ Cloud**
2. Nhấn **"Nhập URL Cloud"**
3. Nhập: `https://your-domain.com`
4. Nhấn **Kết nối**
5. Thiết bị sẽ tự đồng bộ lần đầu

---

## 8. Bảo trì & Cập nhật

### Cập nhật code
```bash
# Trên VPS
cd /var/www/beerpos
git pull
pm2 reload beerpos
```

### Xem logs
```bash
pm2 logs beerpos --lines 100 --nostream
tail -f logs/error.log
```

### Backup database
```bash
# Tự động backup hàng ngày lúc 23:00 (đã cấu hình trong server.js)
ls /var/www/beerpos/backup/

# Backup thủ công
cp /var/www/beerpos/database.sqlite /var/www/beerpos/backup/backup-$(date +%Y%m%d).db
```

### Khởi động lại sau reboot
```bash
pm2 resurrect
```

### Theo dõi trạng thái
```bash
pm2 monit
```

---

## 9. Auto-Deploy (Git Push tự động)

### Cách hoạt động

Có **2 cách** để auto-deploy khi bạn `git push`:

#### Cách 1: Git Post-Receive Hook (Khuyến nghị)

**Trên Server:**
```bash
# Copy hook file
cp /var/www/beerpos/deploy/post-receive ~/.git/hooks/post-receive
chmod +x ~/.git/hooks/post-receive

# Tạo log file
sudo touch /var/log/beerpos-deploy.log
sudo chmod 666 /var/log/beerpos-deploy.log
```

**Trên Local (Windows/Mac):**
```bash
# Push như bình thường
git push origin main
# → Server sẽ tự động pull và restart!
```

#### Cách 2: Webhook Endpoint

**Trên Server:**
```bash
# Đảm bảo đã có DEPLOY_WEBHOOK_SECRET trong .env
# Restart app để áp dụng
pm2 restart beerpos
```

**Trên Local:**
```bash
# Cài đặt secret trong deploy.bat
# Sau đó uncomment dòng curl trong deploy.bat
# Hoặc gọi thủ công:
curl -X POST https://your-domain.com/webhook/deploy \
  -H "Authorization: Bearer YOUR_SECRET"
```

### Sử dụng deploy.bat (Windows)

```bash
# Deploy không có message
deploy\deploy.bat

# Deploy với message
deploy\deploy.bat "Fix login bug"

# Deploy và trigger webhook
# 1. Edit deploy\deploy.bat, thay YOUR_SECRET
# 2. Uncomment dòng curl
# 3. Chạy:
deploy\deploy.bat "Your commit message"
```

### Kiểm tra deploy log
```bash
tail -f /var/log/beerpos-deploy.log
```

### Xem deploy history
```bash
grep "SUCCESS" /var/log/beerpos-deploy.log
```

---

## Kiểm tra cuối cùng

```bash
# API health check
curl https://your-domain.com/api/ping
# → {"ok":true,"timestamp":"..."}

# /api/discover
curl https://your-domain.com/api/discover
# → {"cloud":true,"isCloudServer":true,...}
```
