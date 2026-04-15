# BeerPOS Cloud Sync - Deployment Guide

## Vấn đề
Local development (localhost) và Production server (VPS) sử dụng SQLite database riêng biệt.
- Local: `database.sqlite` (trống)
- VPS: `database.sqlite` (có dữ liệu bán hàng thực tế)

## Giải pháp
Cấu hình Cloud Sync để Local browser có thể đọc/ghi dữ liệu từ VPS server.

---

## Các bước đã thực hiện

### 1. Đã sửa `.env` (Local)
```env
CLOUD_SERVER_URL=http://103.75.183.57:3000
```

### 2. Đã sửa `ecosystem.config.js` (VPS)
```javascript
CLOUD_DOMAIN: 'http://103.75.183.57:3000'
ADMIN_DOMAIN: '103.75.183.57'
ALLOWED_ORIGIN: '*'  // Cho phép sync từ mọi nơi
```

### 3. Đã sửa `server.js`
- CORS: `Access-Control-Allow-Origin: *` cho phép cross-origin requests

### 4. Đã sửa `public/sync.js`
- `fetch('/api/sync/push')` → `fetch(`${cloudUrl}/api/sync/push`)`
- `fetch('/api/sync/pull')` → `fetch(`${cloudUrl}/api/sync/pull`)`
- `fetch('/api/ping')` → `fetch(`${cloudUrl}/api/ping`)`

---

## Triển khai lên VPS

### Bước 1: Upload code lên VPS
```bash
# Sử dụng scp hoặc git deploy
scp -r ./beer-pos root@103.75.183.57:/root/
```

### Bước 2: Cài đặt dependencies
```bash
ssh root@103.75.183.57
cd /root/beer-pos
npm install
```

### Bước 3: Cấu hình ecosystem.config.js (đã có sẵn)
```bash
# Edit nếu cần
nano ecosystem.config.js
```

### Bước 4: Khởi động với PM2
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Bước 5: Kiểm tra server
```bash
curl http://103.75.183.57:3000/api/ping
```

---

## Kết nối Local với VPS

### Cách 1: Truy cập trực tiếp VPS (Khuyến nghị)
Mở trình duyệt và truy cập:
```
http://103.75.183.57:3000
```
→ Browser sẽ sử dụng SQLite DB trên VPS (có dữ liệu)

### Cách 2: Local browser kết nối đến VPS Cloud
1. Mở Local BeerPOS: `http://localhost:3000`
2. Mở Developer Console (F12) → Console tab
3. Chạy lệnh:
```javascript
localStorage.setItem('cloudUrl', 'http://103.75.183.57:3000');
location.reload();
```

### Cách 3: Copy database từ VPS về Local
```bash
# Trên VPS
scp /root/beer-pos/database.sqlite root@localhost:/path/to/local/beer-pos/
```
Sau đó khởi động lại local server.

---

## Kiểm tra Sync hoạt động

### Trên Local browser (đã kết nối cloud):
1. Mở Dashboard → ⚙️ → Tab ☁️
2. Kiểm tra status: "Đã kết nối Cloud"
3. Click "Sync Now" để đồng bộ

### Kiểm tra bằng API:
```bash
# Check sync status
curl http://103.75.183.57:3000/api/sync/status

# Check sales
curl http://103.75.183.57:3000/api/sales
```

---

## Xử lý lỗi thường gặp

### Lỗi: CORS blocked
→ Đã fix: `Access-Control-Allow-Origin: *`

### Lỗi: Không tìm thấy /api/sync/push
→ Kiểm tra cloudUrl đúng format: `http://103.75.183.57:3000` (có http, không có trailing slash)

### Lỗi: Database trống sau sync
→ Chạy `syncNow()` trong console
→ Hoặc kiểm tra `hasOrderedFirstSync` flag trong localStorage

---

## Files đã sửa đổi

| File | Thay đổi |
|------|----------|
| `.env` | Thêm `CLOUD_SERVER_URL` |
| `ecosystem.config.js` | Cập nhật `CLOUD_DOMAIN`, `ALLOWED_ORIGIN: *` |
| `server.js` | CORS headers mở cho sync |
| `public/sync.js` | Dùng `cloudUrl` thay vì relative path |
| `deploy/.env.production` | Tạo mới với config VPS |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  LOCAL BROWSER (localhost:3000)                           │
│       ↓ fetch về localhost                                │
│   Local SQLite (trống)                                    │
│                                                             │
│  HOẶC kết nối cloud:                                      │
│       ↓ fetch về 103.75.183.57:3000                       │
│   VPS SQLite (có dữ liệu) ←──────── Sync                  │
└─────────────────────────────────────────────────────────────┘
```