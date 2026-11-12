# DRIVER PORTAL — Hướng dẫn triển khai

> Bia Tươi Tây Ninh — Driver Portal `giaohang.biatuoitayninh.store`
> Dùng chung backend + database với BeerPOS `admin.biatuoitayninh.store`.

---

## 1. Kiến trúc

```
                    ┌──────────────────────────┐
  admin.biatuoitayninh.store          giaohang.biatuoitayninh.store
                    │                          │
                    │   Nginx (2 server block)  │
                    └──────┬───────────────────┘
                           │  proxy_pass → 127.0.0.1:3000
                           │  header X-App-Mode: admin | driver
                           ▼
                ┌──────────────────────────────┐
                │  BeerPOS Express (server.js)  │
                │  ────────────────────────────│
                │  getAppMode(req)              │
                │    admin → views/dashboard.html│
                │    driver → views/driver/*    │
                │                              │
                │  /api/driver/*  (requireAuth  │
                │      + requireDriver + scope) │
                │                              │
                │  /api/*  → optionalAuth       │
                │           → apiGuard  (403    │
                │             cho DRIVER)        │
                │           → attachSanitizer    │
                │               (gỡ cost_price,  │
                │                profit, revenue) │
                └──────────────┬───────────────┘
                               ▼
                  ┌────────────────────────┐
                  │  database.sqlite       │
                  │  (MỘT database duy nhất)│
                  │  + app_users           │
                  │  + delivery_records    │
                  │  + delivery_record_items│
                  │  + delivery_events     │
                  │  + sales.driver_username│
                  │  + sales.delivery_status│
                  └────────────────────────┘
```

**Nguyên tắc bất biến:**
- MỘT database (`database.sqlite`). Không clone, không DB thứ hai.
- Driver dùng lại **nguyên văn** logic Sale của `routes/api/sales.js`
  (forward nội bộ) → không viết lại thuật toán thưởng / khuyến mãi / công nợ.
- Phân quyền thực hiện ở **BACKEND** (403 từ server), không phải ẩn UI.

---

## 2. File đã tạo / chỉnh sửa

### Tạo mới
| File | Vai trò |
|---|---|
| `database/migrations/043_driver_portal.js` | Migration idempotent: `app_users`, `delivery_records`, `delivery_record_items`, `delivery_events`, cột `role`/`app_user_id` trên `auth_sessions`, cột `driver_username`/`delivery_status` trên `sales` |
| `middleware/permissions.js` | RBAC + sanitizer: role constants, permission catalogue, `optionalAuth`, `apiGuard`, `attachSanitizer`, `adminPageGuard`, `salesScopeClause` |
| `src/utils/password.js` | Hash/verify mật khẩu bằng `crypto.scrypt` (`scrypt$N$r$p$salt$hash`) |
| `src/utils/appMode.js` | Phát hiện app mode (`admin`/`public`/`driver`) — ưu tiên `Host` header, dùng chung giữa `server.js` và test |
| `src/services/UserService.js` | CRUD tài khoản tài xế trong `app_users` |
| `src/services/DeliveryService.js` | State machine giao hàng + audit `delivery_events` + đồng bộ keg |
| `routes/api/driver.js` | Toàn bộ API Driver Portal (`/api/driver/*`) |
| `routes/driverAuth.js` | Đăng nhập/đăng xuất riêng (`/auth/driver`) |
| `scripts/create-driver.js` | CLI quản lý tài khoản tài xế |
| `routes/api/admin.js` | API ADMIN quản lý tài khoản tài xế (`/api/admin/drivers`) |
| `views/driver/*.html` | 5 trang: login, trang chủ, bán hàng, giao hàng, khách hàng |
| `public/js/driver/*.js` | 5 module: core, home, sale, delivery, customers |
| `public/css/driver.css` | Design system mobile-first cho Driver Portal |
| `tests/driver-portal.test.js` | 60 test case RBAC / sanitization / delivery / integrity / quản lý tài xế |

### Chỉnh sửa
| File | Thay đổi |
|---|---|
| `server.js` | Thêm app mode `driver`, mount `/api/driver` + `/api/admin`, `optionalAuth`+`apiGuard`+`attachSanitizer`, `adminPageGuard`, route trang `/driver/*` |
| `middleware/auth.js` | `login()` hỗ trợ `app_users` (role DRIVER **và** role ADMIN), `adminOnly`/`driverOnly`, session lưu `role`+`app_user_id`, cookie `driver_session_token` host-only |
| `routes/login.js` | `login(..., { adminOnly: true })` → tài xế KHÔNG đăng nhập được ở domain admin |
| `database.js` | Wire `runDriverPortalMigration(db)` |
| `database/migration.js` | Export `runDriverPortalMigration` |

---

## 3. API đã sử dụng

### Driver Portal (yêu cầu role DRIVER, scope theo `driver_username`)
| Method | Path | Mô tả |
|---|---|---|
| GET | `/auth/driver` | Trang đăng nhập tài xế |
| POST | `/auth/driver` | Đăng nhập → set cookie `driver_session_token` (host-only) |
| GET/POST | `/auth/driver/logout` | Đăng xuất |
| GET | `/api/driver/me` | Hồ sơ tài xế |
| GET | `/api/driver/dashboard` | Chỉ số vận hành (KHÔNG doanh thu/lợi nhuận) |
| GET | `/api/driver/sales` | Danh sách đơn **của chính mình** |
| GET | `/api/driver/sales/:id` | Chi tiết đơn của mình (403 `DRIVER_SCOPE` nếu của tài xế khác) |
| POST | `/api/driver/sales` | **Tạo đơn** → forward sang `POST /api/sales` (dùng lại logic chuẩn) |
| PUT | `/api/driver/sales/:id` | Sửa đơn của mình → forward `PUT /api/sales/:id` |
| DELETE | `/api/driver/sales/:id` | Huỷ đơn của mình → forward `DELETE /api/sales/:id` |
| GET | `/api/driver/customers` | Tìm khách (tên / SĐT / địa chỉ) |
| GET | `/api/driver/customers/:id` | Chi tiết khách + lịch sử mua (không giá vốn) |
| POST | `/api/driver/customers` | Tạo khách mới |
| GET | `/api/driver/products` | Danh sách sản phẩm (không `cost_price`) |
| GET | `/api/driver/prices?customerId=` | Giá bán riêng của khách |
| GET | `/api/driver/deliveries` | Đơn cần giao hôm nay |
| GET | `/api/driver/deliveries/history` | Lịch sử giao |
| POST | `/api/driver/deliveries` | Tạo record giao (idempotent — không nhân đôi) |
| GET | `/api/driver/deliveries/:id` | Chi tiết đơn giao |
| PATCH | `/api/driver/deliveries/:id/status` | Đổi trạng thái (`PENDING→IN_PROGRESS→DELIVERED/FAILED/DISCREPANCY`) |
| POST | `/api/driver/deliveries/:id/confirm` | Xác nhận số lượng giao + vỏ thu |
| POST | `/api/driver/deliveries/:id/discrepancy` | Ghi nhận thiếu / thừa / hư hỏng |
| POST | `/api/driver/deliveries/:id/kegs` | Cập nhật số vỏ đã thu (đồng bộ `keg_stats` + `customers.keg_balance`) |
| POST | `/api/driver/payments` | Thu tiền công nợ (dùng lại `DebtService.payDebt`) |
| GET | `/api/driver/debts/:customerId` | Công nợ của 1 khách |

### Tái sử dụng (KHÔNG viết lại)
`POST /api/sales` · `PUT /api/sales/:id` · `DELETE /api/sales/:id` ·
`PromotionService` (khuyến mãi + thưởng sản lượng) · `DebtService` (công nợ) ·
`deleteSaleRestoringInventory` (hoàn kho khi huỷ) · `updateCustomerKegBalance`.

---

## 4. Permission đã tạo

### Role
- `ADMIN` — toàn quyền (`PERMISSIONS.ADMIN = ['*']`)
- `DRIVER` — danh sách quyền hạn chế bên dưới

### Quyền DRIVER được phép
```
SALE_VIEW · SALE_CREATE · SALE_UPDATE
DELIVERY_VIEW · DELIVERY_CREATE · DELIVERY_UPDATE
CUSTOMER_VIEW · CUSTOMER_CREATE
PRODUCT_VIEW · INVENTORY_VIEW · ORDER_HISTORY_VIEW
```

### Quyền DRIVER bị chặn (backend trả 403 `DRIVER_FORBIDDEN`)
```
COST_VIEW · PROFIT_VIEW · REVENUE_REPORT_VIEW · FINANCIAL_REPORT_VIEW
ADMIN_VIEW · USER_MANAGEMENT · SYSTEM_SETTINGS · SUPPLIER_VIEW
DATABASE_BACKUP · INVENTORY_COST_VIEW
```

### 3 lớp bảo vệ
1. **`apiGuard`** — whitelist path. DRIVER chỉ được dùng `/api/driver/*`
   (+ `/api/auth/me`, `/api/ping`, `/api/discover`). Tất cả path admin
   (`/api/analytics`, `/api/expenses`, `/api/backup`, `/api/settings`,
   `/api/state`, `/api/sales`, `/api/products`, `/api/customers`,
   `/api/kegs`, `/api/promotions`, `/api/routing`, `/api/devices`, `/api/batch`,
   `/api/sync`, `/api/purchases`, `/api/report`, `/api/segments`, …) → **403**.
2. **`attachSanitizer`** — wrap `res.json` của DRIVER, gỡ đệ quy mọi field
   `cost_price`, `costPrice`, `profit`, `totalProfit`, `grossProfit`, `netProfit`,
   `margin`, `marginPercent`, `profitMargin`, `totalRevenue`, `revenue`,
   `purchase_price`, `totalCost`, …
3. **`adminPageGuard`** — DRIVER mở trang HTML quản trị (`/dashboard`,
   `/report`, `/expenses`, `/stock`, `/products`, `/backup`, …) → **403**.

Ngoài ra `requireDriver` trong `routes/api/driver.js` chặn session không phải
DRIVER, và mọi route đều scope theo `sales.driver_username = req.user.username`.

### Field bị gỡ khỏi response DRIVER
`FORBIDDEN_FIELDS` + `FORBIDDEN_ARRAY_KEYS` trong `middleware/permissions.js`.

---

## 5. Cách tạo tài khoản tài xế

```bash
cd /path/to/BeerPOS

# Tạo
node scripts/create-driver.js create tai_xe_01 "MatKhau@123" "Nguyen Van A" "0900123456"

# Đổi mật khẩu
node scripts/create-driver.js reset-password tai_xe_01 "MatKhauMoi@456"

# Kho / mở khoá
node scripts/create-driver.js disable tai_xe_01
node scripts/create-driver.js enable  tai_xe_01

# Xem danh sách / chi tiết
node scripts/create-driver.js list
node scripts/create-driver.js info tai_xe_01
```

Mật khẩu luôn được hash bằng `scrypt` — **không lưu plaintext**.
Đăng nhập tại `https://giaohang.biatuoitayninh.store/auth/driver`.

### Phân quyền tài xế
Phân quyền thực hiện bằng **role** (`app_users.role`):
- `role = 'DRIVER'` → vào Driver Portal, bị chặn toàn bộ API/trang quản trị.
- Muốn thu hồi quyền: `disable` tài khoản (session cũ vẫn còn hiệu lực tới khi
  hết hạn — dùng `DELETE FROM auth_sessions WHERE username = ?` nếu cần cưỡng
  buộc đăng xuất).

### 5.1. Quản lý tài xế từ API (ADMIN)

Ngoài CLI, quản trị viên có thể quản lý tài xế qua API `/api/admin/drivers`.
Endpoint này **chỉ ADMIN** được gọi — tài xế nhận `403 DRIVER_FORBIDDEN` từ
`apiGuard` (vì `/api/admin` không nằm trong whitelist `DRIVER_ALLOWED_API_PREFIXES`).

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/admin/drivers` | Danh sách tài khoản (không có `password_hash`) |
| GET | `/api/admin/drivers/:id` | Chi tiết một tài khoản |
| POST | `/api/admin/drivers` | Tạo tài khoản tài xế (`username`, `password`, `fullName`, `phone`) |
| PUT | `/api/admin/drivers/:id` | Sửa hồ sơ / khoá / đổi `role` |
| POST | `/api/admin/drivers/:id/reset-password` | Đặt lại mật khẩu |
| DELETE | `/api/admin/drivers/:id` | Khoá tài khoản (soft delete + huỷ session) |
| GET | `/api/admin/drivers/:id/sessions` | Phiên đăng nhập đang hoạt động |

```bash
curl -X POST https://admin.biatuoitayninh.store/api/admin/drivers \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"username":"tai_xe_01","password":"TaiXe@2026","fullName":"Nguyễn Văn A","phone":"0900123456"}'
```

> Lưu ý: `middleware/auth.js` hỗ trợ đăng nhập cho cả tài khoản `role = 'ADMIN'`
> lưu trong `app_users` (ngoài tài khoản `.env`), nhưng tài khoản ADMIN
> **không** được đăng nhập qua Driver Portal (`driverOnly`).

---

## 6. DNS

```
Type    Name        Value
A       giaohang    <IP_SERVER_BIATUOITAININH>
```

Hoặc CNAME trỏ cùng server. **KHÔNG** dùng wildcard `*.biatuoitayninh.store`
nếu muốn `admin` và `giaohang` là 2 app khác nhau (đã dùng 2 `server_block` riêng).

Kiểm tra:
```bash
nslookup giaohang.biatuoitayninh.store
```

---

## 7. Nginx

Thêm `server_block` mới (KHÔNG sửa `admin` cũ):

```nginx
# ── Driver Portal ────────────────────────────────────────────────────────
server {
    listen 80;
    listen [::]:80;
    server_name giaohang.biatuoitayninh.store;

    # ACME challenge cho SSL
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # QUAN TRỌNG: đánh dấu app mode cho Express
        proxy_set_header X-App-Mode   'driver';
        proxy_set_header Host         $host;
        proxy_set_header X-Real-IP   $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Socket.IO (nếu dùng realtime)
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 300s;
        proxy_cache off;
    }
}

# ── HTTPS (sinh tự động bởi certbot --nginx) ─────────────────────────────
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name giaohang.biatuoitayninh.store;

    ssl_certificate     /etc/letsencrypt/live/giaohang.biatuoitayninh.store/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/giaohang.biatuoitayninh.store/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header X-App-Mode   'driver';
        proxy_set_header Host         $host;
        proxy_set_header X-Real-IP   $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 300s;
        proxy_cache off;
    }
}
```

### SSL
```bash
sudo certbot --nginx -d giaohang.biatuoitayninh.store
# hoặc thủ công:
sudo certbot certonly --nginx -d giaohang.biatuoitayninh.store
sudo nginx -t && sudo systemctl reload nginx
```

### Kiểm tra header đã đúng
```bash
curl -I -H "Host: giaohang.biatuoitayninh.store" http://127.0.0.1:3000/driver
# HTTP/1.1 200 ... (không phải redirect về admin)
```

---

## 8. Triển khai

### 8.1. Backup (BẮT BUỘC, làm trước mọi thứ)
```bash
cd /path/to/BeerPOS

# Backup database
cp database.sqlite "backups/database_$(date +%Y%m%d_%H%M%S).sqlite"
# hoặc dùng gzip
gzip -c database.sqlite > "backups/database_$(date +%Y%m%d_%H%M%S).sqlite.gz"

# Backup source code
cd ..
tar -czf beerpos_src_$(date +%Y%m%d_%H%M%S).tar.gz BeerPOS --exclude=node_modules --exclude=.git
```

### 8.2. Staging
```bash
git checkout feature/driver-portal
npm ci                      # thêm supertest nếu chưa có
npx jest tests/driver-portal.test.js --forceExit
node -e "require('./server'); setTimeout(()=>process.exit(0),2000)"  # smoke start
```

Chạy staging ở port khác (VD 3001) với `X-App-Mode: driver` để kiểm thử đầy đủ
trước khi đụng production.

### 8.3. Production
```bash
cd /path/to/BeerPOS
git checkout feature/driver-portal
git pull origin feature/driver-portal
npm install --production
sudo systemctl stop beerpos   # hoặc: pm2 stop beerpos

# Migration chạy TỰ ĐỘNG khi app khởi động (idempotent, chỉ ADD)
sudo systemctl start beerpos  # hoặc: pm2 restart beerpos

# Kiểm tra
curl -s http://127.0.0.1:3000/api/ping
pm2 logs beerpos --lines 50
```

### 8.4. Tạo tài khoản tài xế (trên production)
```bash
cd /path/to/BeerPOS
node scripts/create-driver.js create tai_xe_01 "MatKhau@123" "Nguyen Van A" "09xxxxxxx"
```

### 8.5. DNS + Nginx + SSL
Theo mục 6 & 7 ở trên. Thêm `DRIVER_DOMAIN` vào `.env` production:
```
DRIVER_DOMAIN=giaohang.biatuoitayninh.store
```

### 8.6. Xác minh sau deploy
```bash
# Driver bị chặn API admin (kỳ vọng 403)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <TOKEN_DRIVER>" \
  http://127.0.0.1:3000/api/analytics

# Driver bị chặn trang quản trị (kỳ vọng 403)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <TOKEN_DRIVER>" \
  -H "Host: giaohang.biatuoitayninh.store" \
  http://127.0.0.1:3000/dashboard
```

---

## 9. Rollback

### 9.1. Rollback nhanh (chỉ code, giữ nguyên dữ liệu)
```bash
cd /path/to/BeerPOS
git checkout main
git pull origin main
sudo systemctl restart beerpos   # hoặc: pm2 restart beerpos
```

Migration là **additive** (chỉ thêm bảng/cột) → code cũ vẫn chạy bình thường,
dữ liệu tài xế và lịch sử giao hàng được giữ nguyên.

### 9.2. Rollback đầy đủ (bao gồm schema)
```bash
cd /path/to/BeerPOS
git checkout main
sudo systemctl stop beerpos

# Khôi phục database từ backup
cp backups/database_YYYYMMDD_HHMMSS.sqlite database.sqlite

sudo systemctl start beerpos
```

### 9.3. Gỡ hẳn Driver Portal khỏi nginx
```bash
sudo rm /etc/nginx/sites-enabled/giaohang
sudo nginx -t && sudo systemctl reload nginx
```
Gỡ DNS record `giaohang` nếu không dùng nữa.

### 9.4. Xóa bảng driver (CHỈ khi muốn dọn hoàn toàn)
```bash
sqlite3 database.sqlite <<'SQL'
PRAGMA foreign_keys=OFF;
DROP TABLE IF EXISTS delivery_events;
DROP TABLE IF EXISTS delivery_record_items;
DROP TABLE IF EXISTS delivery_records;
DROP TABLE IF EXISTS app_users;
ALTER TABLE auth_sessions DROP COLUMN role;
ALTER TABLE auth_sessions DROP COLUMN app_user_id;
ALTER TABLE sales DROP COLUMN driver_username;
ALTER TABLE sales DROP COLUMN delivery_status;
PRAGMA foreign_keys=ON;
SQL
```
> **Cảnh báo:** làm mất lịch sử giao hàng của tài xế. Luôn backup trước.

---

## 10. Kết quả kiểm thử

| Hạng mục | Kết quả |
|---|---|
| `tests/driver-portal.test.js` | **61/61 PASS** |
| Smoke test tích hợp (HTTP thật, server.js thật) | **40/40 PASS** |
| Full suite (`npx jest`) | **171 PASS** — 10 suite fail **có sẵn từ trước** (thư mục `backups/` và script tự gọi `process.exit`), xác nhận bằng stash trước/sau: 110 → 171 pass, số suite fail **không đổi** |

### Bằng chứng bảo mật đã kiểm thử
- Driver không đọc được `cost_price` / `profit` / `revenue` ở bất kỳ endpoint nào.
- Driver bị **403 `DRIVER_FORBIDDEN`** ở 8 API admin: `/api/analytics`,
  `/api/expenses`, `/api/products`, `/api/sales`, `/api/customers`,
  `/api/backup/list`, `/api/settings`, `/api/state/full`.
- Driver bị **403** ở 6 trang HTML quản trị — kể cả khi request **không có header
  `Accept`** (guard dựa trên phần mở rộng file, không dựa vào `Accept`).
- Driver 2 không xem/sửa/huỷ được đơn của Driver 1 (`DRIVER_SCOPE`).
- Driver không đăng nhập được qua `/auth` (domain admin) → 401.
- Cookie `driver_session_token` là **host-only** (không có `domain=`) → không rò
  sang `admin.biatuoitayninh.store`.
- Admin vẫn xem đầy đủ `cost_price`, `profit`, báo cáo tài chính.
- Tạo 2 đơn liên tiếp → `COUNT(sales)` tăng đúng 1 (không nhân đôi).
- Tạo lại delivery record → `created: false`, không nhân đôi lịch sử.
- `cost_price` của `sale_items` không bị đổi khi tài xế tạo đơn.
- Mọi thay đổi giao hàng đều ghi vào `delivery_events` kèm `actor_username`.

### 10.1. Xác minh trên production (2026-11-07)

Đã deploy lên `giaohang.biatuoitayninh.store` và kiểm chứng thực tế:

| Kiểm tra | Kết quả |
|---|---|
| `GET /auth/driver` | 200 — trang đăng nhập tài xế |
| `POST /auth/driver` | 200 — đăng nhập thành công, trả token + role `DRIVER` |
| `GET /api/driver/me` | 200 — trả hồ sơ tài xế |
| `GET /api/driver/products` | 200 — **không có** `cost_price` / `profit` |
| `GET /api/driver/dashboard` | 200 — chỉ số vận hành, không doanh thu/lợi nhuận |
| `GET /api/analytics`, `/api/expenses`, `/api/backup/list`, `/api/products`, `/api/sales`, `/api/state/full`, `/api/admin/drivers` (với token DRIVER) | **403 `DRIVER_FORBIDDEN`** — tất cả |
| `GET /dashboard`, `/report`, `/expenses`, `/backup`, `/products`, `/stock` (cookie driver, **không** header `Accept`) | **403** — tất cả |
| `GET /api/products`, `/api/customers`, `/api/sales`, `/api/expenses` (token ADMIN) | 200 — admin không bị ảnh hưởng |
| Tạo tài khoản qua `POST /api/admin/drivers` | 201, mật khẩu hash scrypt |
| Driver tự tạo tài khoản (`POST /api/admin/drivers` với token DRIVER) | 403 — không tạo được |
| Driver tự nâng role lên ADMIN (`PUT /api/admin/drivers/:id`) | 403 — role không đổi |
| Admin khoá tài xế | `active = 0`, session bị huỷ, không đăng nhập lại được |

---

## 11. Troubleshooting

### 11.1. `/driver` redirect về `/` (không vào được Driver Portal)
**Nguyên nhân:** nginx set `X-App-Mode: admin` cho cả `giaohang.*`.
**Cách sửa (đã áp dụng):** `src/utils/appMode.js` ưu tiên **Host header** trước
`X-App-Mode` — Host luôn đúng theo domain người dùng gõ.
Nếu vẫn lỗi, kiểm tra nginx:
```bash
sudo nginx -T | grep -A5 giaohang   # phải có server_name giaohang.biatuoitayninh.store
```

### 11.2. `/auth/driver` trả 500 (Server error)
**Nguyên nhân phổ biến nhất:** body JSON **không đúng format** (thiếu dấu nháy) →
`body-parser` ném `SyntaxError` → error handler trả 500.
**Cách kiểm tra log server:**
```bash
# Endpoint chẩn đoán (chỉ ADMIN):
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://admin.biatuoitayninh.store/api/admin/logs/error?lines=40
# Hoặc trên server:
tail -50 /var/www/beer-pos/src/logs/error.log
```

### 11.3. Trang HTML quản trị trả 200 thay vì 403 khi dùng cookie tài xế
**Nguyên nhân:** guard HTML chỉ chạy khi request có header `Accept: text/html` →
attacker bỏ header là lách được.
**Cách sửa (đã áp dụng):** `server.js` phân biệt static asset (có phần mở rộng file)
với đường dẫn trang, bỏ qua `/api` (đã có `apiGuard` riêng).

### 11.4. API phân trang trả 500 `datatype mismatch`
**Nguyên nhân:** `req.query.page` / `req.query.limit` là **string**; giá trị rỗng
hoặc `undefined` khi bind vào `LIMIT ?` làm SQLite ném lỗi.
**Cách sửa (đã áp dụng):** ép về số nguyên ở mọi route phân trang:
```js
const page  = Math.max(1, parseInt(req.query.page) || 1);
const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
```

### 11.5. `/backup` trả 500 `ENOENT views/backup.html`
`views/backup.html` đã bị gỡ bỏ (dead code) nhưng route còn sót → đã xoá route.
Quản lý backup hiện dùng API `/api/backup/*`.
