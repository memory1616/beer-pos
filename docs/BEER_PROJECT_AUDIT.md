# BEER PROJECT AUDIT REPORT

> **Ngày audit:** 2026-11-12
> **Phạm vi:** Toàn bộ repository `D:/Beer` (296 file được Git track + file chưa track)
> **Nguyên tắc:** CHỈ AUDIT — không xóa file, không sửa schema, không đụng môi trường Production.
> **Phương pháp:** Phân tích tĩnh dependency graph (require/import/loadScript/@import/sendFile/script tag), đối chiếu runtime DB schema, kiểm chứng từng phát hiện bằng `git grep` và truy vấn SQL read-only.
>
> ⚠️ **Cập nhật 2026-11-12 (sau audit):** Toàn bộ phát hiện trong báo cáo này **đã được xử lý** trong
> branch `cleanup/audit-2026-11-12` (PR1–PR8). Xem `docs/BEER_CLEANUP_PLAN.md` §12 để xem trạng thái
> thực thi chi tiết từng mục. Các mô tả bên dưới giữ nguyên như **bản ghi audit gốc** (snapshot tại thời điểm audit).

---

## 1. TỔNG QUAN KIẾN TRÚC

### 1.1. Công nghệ

| Tầng | Công nghệ |
|---|---|
| Runtime | Node.js (CommonJS) |
| Server | Express 4 (`server.js` — entry point, 1072 dòng) |
| Database | SQLite qua `better-sqlite3` (synchronous, WAL mode) |
| Template | EJS `renderFile` + HTML tĩnh (view gần như thuần HTML/JS inline) |
| Realtime | Socket.IO 4 (`src/socket/socketServer.js`) |
| Auth | Session token lưu trong bảng `auth_sessions` (SQLite), cookie HttpOnly + RBAC middleware |
| PWA | Service Worker tự viết (`public/sw.v2.js`), Dexie.js 4 (IndexedDB) |
| Cron | `node-cron` (backup DB 2h, dọn session, promotion backfill) |
| Test | Jest 29 + supertest |
| Deploy | PM2 (`ecosystem.config.js`), Docker, nginx, Git post-receive hook |

### 1.2. Entry points

| Entry | Vai trò |
|---|---|
| `server.js` | HTTP server, mount toàn bộ route, cron, khởi tạo Socket.IO |
| `database.js` | Mở SQLite, chạy migration, export helper query (`db.SQL_KEG_WAREHOUSE_RAW_STOCK`, `db.getVietnamDateStr()`) |
| `database/migration.js` | Orchestrator migration (version-gated) |
| `public/sw.v2.js` | Service Worker (PWA offline) — `public/sw.js` là bản redirect cũ |
| `public/db.js` | Lớp Dexie phía client (offline-first) |
| `public/sync.js` | Đồng bộ Local ↔ Cloud |
| `public/js/realtime.js` | Socket.IO client (auto-load qua `layout.js`) |

### 1.3. Module chức năng

| Nhóm | File chính |
|---|---|
| Auth / RBAC | `middleware/auth.js`, `middleware/permissions.js`, `routes/login.js`, `routes/driverAuth.js` |
| Bán hàng | `routes/api/sales.js` (1700 dòng), `routes/api/driverSale.js`, `src/services/SaleService.js` |
| Khách hàng | `routes/api/customers.js`, `routes/api/segments.js` (**BROKEN**), `routes/customers.js` |
| Sản phẩm / Giá | `routes/api/products.js`, bảng `prices`, `routes/api/batch.js` (**BROKEN**) |
| Công nợ | `routes/api/debts.js`, `routes/api/payments.js`, `src/services/DeadService.js` |
| Kho / Vỏ | `routes/api/stock.js`, `routes/api/kegs.js`, `src/services/InventoryService.js` |
| Khuyến mãi / Thưởng | `src/services/promotionCalc.js` (**SSOT**), `routes/api/promotions.js`, `src/services/index.js` |
| Giao hàng | `routes/api/driver.js`, `src/services/DeliveryService.js`, `routes/api/routing.js` |
| Tài xế | `src/services/DriverStaffService.js`, `src/services/DriverSalaryCalculator.js`, `routes/api/driverStaff.js` |
| Nhân viên sales | `src/services/salesStaff.js`, `routes/api/sales-staff.js` |
| Đồng bộ | `routes/api/sync.js`, `public/sync.js`, `public/sw.v2.js` |
| Báo cáo | `routes/reportData.js`, `routes/analytics.js`, `routes/dashboard.js`, `routes/api/analytics.js` |

### 1.4. Luồng dữ liệu chuẩn

```
UI (views/*.html + public/js/*)
  → fetch('/api/*')
  → middleware/auth.js (requireAuth) → middleware/permissions.js (apiGuard + attachSanitizer)
  → routes/api/*  (controller: validate + gọi service + trả JSON)
  → src/services/*  (business logic)
  → database.js (better-sqlite3) → database.sqlite (WAL)
```

**Vi phạm:** nhiều route `routes/api/*` chứa SQL trực tiếp thay vì gọi Service → business logic phân tán (chi tiết ở §7).

### 1.5. Luồng đồng bộ offline

```
SW (public/sw.v2.js) intercept → ghi vào IndexedDB (STORE_SYNC, index 'synced')
  → syncNow() gom batch → POST {cloudUrl}/api/sync/push  {changes:[{entity,entity_id,action,data,client_updated_at}]}
  → routes/api/sync.js: conflict check (server.updated_at > client_updated_at) → apply*Change()
  → SW xóa queue KHI resp.ok
```

---

## 2. DANH SÁCH MODULE (chi tiết)

| Module | LOC | Trạng thái |
|---|---|---|
| `server.js` | 1072 | ACTIVE — entry point |
| `database.js` | 1578 | ACTIVE |
| `database/migration.js` | ~700 | ACTIVE (nhưng có lỗi version gate — §8.1) |
| `database/migrations/004_business_features.js` | 290 | ACTIVE nhưng **không chạy** (version gate sai) |
| `database/migrations/041_sales_staff.js` | 130 | **OBSOLETE** — schema đã nhân bản vào `database.js` |
| `database/migrations/042_sale_time.js` | 5 | **OBSOLETE** — file comment tự thừa nhận deprecated |
| `database/migrations/043..047` | ~1000 | ACTIVE |
| `src/services/index.js` | 1858 | ACTIVE — 2100 dòng, gộp 5 service |
| `src/services/promotionCalc.js` | 230 | ACTIVE — **SSOT** khuyến mãi |
| `src/services/saleDelete.js` | 300 | ACTIVE — xóa đơn + hoàn kho |
| `src/services/DebtService.js` | 320 | ACTIVE nhưng **BROKEN** (§8.2) |
| `src/services/SaleService.js` | 180 | ACTIVE (chỉ dùng bởi test) — trùng lặp `routes/api/sales.js` |
| `src/services/InventoryService.js` | 70 | ACTIVE (chỉ dùng bởi test) |
| `src/services/store/index.js` | 305 | **DEAD** — không ai require |
| `src/socket/socketServer.js` | 340 | ACTIVE |
| `src/cache/index.js` | 284 | ACTIVE (chỉ `routes/api/segments.js` + `batch.js` dùng) |
| `middleware/auth.js` | 290 | ACTIVE |
| `middleware/permissions.js` | 330 | ACTIVE |
| `middleware/cache.js` | 170 | ACTIVE |
| `middleware/validation.js` | 160 | ACTIVE |
| `middleware/errorHandler.js` | 100 | ACTIVE |
| `routes/api/sales.js` | 1700 | ACTIVE — file API lớn nhất |
| `routes/api/promotions.js` | 842 | ACTIVE — **1 require sai path** (§8.3) |
| `routes/api/segments.js` | 420 | **BROKEN** — thiếu import `db` (§8.4) |
| `routes/api/batch.js` | 430 | **BROKEN** — thiếu import `db` (§8.4) |
| `routes/api/sync.js` | 440 | ACTIVE — **3 query hỏng** (§8.5) |
| `routes/api/session.js` | 130 | ACTIVE — 1 route bị shadow |
| `public/js/realtime.js` | 800 | ACTIVE |
| `public/js/realtime-client.js` | 250 | ACTIVE — **trùng chức năng** (§6.2) |

---

## 3. DANH SÁCH DEAD CODE

### 3.1. Dead Files — SAFE TO DELETE (đã chứng minh 0 reference)

> Tiêu chí: không có `require`, không có `<script src>`, không có `loadScript()`, không có `@import`,
> không có `sendFile`/`render`, không có entry trong `package.json` scripts, không có cron/deploy config tham chiếu.

| # | File | Bằng chứng |
|---|---|---|
| 1 | `public/js/api.js` | `git grep "/js/api.js"` → 0 hit. Không view nào load. `window.Api` chỉ được set tại chính file này. |
| 2 | `public/js/empty-state.js` | 0 reference. Chỉ có class CSS `.empty-state` trong `ui-components.css` (cũng dead). |
| 3 | `public/js/numeric-keypad.js` | `git grep numeric-keypad` → 0 hit. |
| 4 | `public/js/segmentation.js` | `git grep segmentation` → 0 hit (chỉ khớp tên `customer_segments` ở API). |
| 5 | `public/js/debts-promotions.js` | Chỉ khớp 1 dòng trong `REFACTOR_STEP1.md` (doc). |
| 6 | `public/js/delivery.js` | `views/delivery.html` chỉ load `layout.js` + `map-tiles.js`. |
| 7 | `public/js/driver/delivery.js` | `views/driver/delivery.html` chỉ load `map-tiles.js`, `driver/core.js`, `driver/shell.js`, `driver/sync.js`. |
| 8 | `public/js/driver/sale.js` | `views/driver/sale.html` KHÔNG load file này (dùng `driver/api-shim.js` + `public/js/sales.js`). |
| 9 | `public/js/report.js` | File tự ghi `DEPRECATED` ở dòng 2. 0 reference. |
| 10 | `public/components/common/*.html` (5 file) | `git grep "components/common"` → 0 hit. |
| 11 | `public/components/shell/app-shell.html` | `git grep app-shell` → chỉ khớp chuỗi version `layout.js?v=...-app-shell` (false positive). |
| 12 | `public/components/ui/*.css` (4 file) | `git grep "components/ui"` → chỉ khớp comment trong `index.css` tự tham chiếu. |
| 13 | `public/css/ui-components.css` | 0 hit. (Chứa `.empty-state`, `.btn`… cũng không ai dùng.) |
| 14 | `public/css/styles.css` | Chỉ là input của `npm run build:css` (Tailwind) — file 24 byte chứa `@import "tailwindcss"`. `tailwind.css` output bị `.gitignore`. **Cần quyết định: giữ nếu còn dùng Tailwind build.** |
| 15 | `public/landing-assets/beer.mp4` (61 MB) | `landing.html` chỉ dùng `beer-mobile.mp4`. Video gốc 63MB không được tham chiếu. |
| 16 | `public/landing-assets/product-yellow-pet.png` | Không có reference trong `landing.html`/`landing.css`. |
| 17 | `database/migrations/041_sales_staff.js` | Schema `sales_staff`, `customer_sales_assignments`, `sales_product_commission`, `sales_commission_config`, `sales_commissions`, `sales_monthly_salary` đã được tạo trong `database.js` (L1481+). File này **không được `migration.js` require** → chưa từng chạy. |
| 18 | `database/migrations/042_sale_time.js` | Nội dung: `// This file is deprecated - sale_time is now added in database/migration.js`. |

### 3.2. Dead Files — NEEDS INVESTIGATION (KHÔNG được xóa vội)

| File | Lý do giữ |
|---|---|
| `public/sw.js` | `public/js/login.js:193` vẫn `register('/sw.js')`. `server.js:562` redirect `/sw.js` → `/sw.v2.js`. **OBSOLETE BUT REFERENCED** — cần đổi login.js sang `sw.v2.js` rồi mới xóa. |
| `public/icons/icon-1024.png` (829 KB) | Không có reference HTML, nhưng là icon PWA chuẩn — có thể thêm vào manifest sau. Kiểm tra `manifest.json` chỉ khai 512/192/180/32/16. |
| `src/store/index.js` | Backend store không ai require. NHƯNG frontend `window.BeerStore` được dùng ở `public/js/customers.js:1306`, `expenses.js:8`, `sync.js:729` → có thể là bản "server-side mirror" của cùng thiết kế. Cần xác nhận ý đồ trước khi xóa. |
| `public/js/vendor/dexie.min.js` | Load bởi `dashboard.html`, `customers.html`, `kegs.html`, `customer-detail.html`, `promo-settings.html`. **ACTIVE** (dùng CDN ở `views/driver/sale.html:33` — khuyến nghị hợp nhất). |
| `public/js/vendor/chart.umd.min.js` | Load bởi `dashboard.html`, `analytics.html`. **ACTIVE**. |
| `check_devices.js`, `sync_devices.js`, `fix_device_customer.js` | Script vận hành ad-hoc, không nằm trong `package.json` scripts. Nên gom vào `scripts/` hoặc xóa — cần chủ repo xác nhận. |
| `_del_*.js`, `_repro.js`, `_diag_pending.js`, `_test_fallback.js`, `_ui_check.js` | Script debug tạm trong root. **Chưa track trong Git** → chỉ xóa local, không commit. |
| `test_*.js` ở root (`test_edge_cases.js`, `test_full_flow.js`, `test_integration.js`, `test_promotion.js`, `test_first_month_reward.js`) | Test script cũ không nằm trong Jest. Cần xác nhận còn dùng tay không. |

### 3.3. Dead Functions

| Hàm | File | Bằng chứng |
|---|---|---|
| `formatVND` | `routes/dashboard.js`, `routes/purchases.js`, `routes/report.js`, `routes/sales.js`, `routes/stock.js` | Định nghĩa nhưng **không có call site** (1 self-reference = chỉ dòng định nghĩa). 5 bản sao giống hệt nhau. |
| `formatCurrency` | `src/services/index.js`, `src/services/SaleService.js` | Định nghĩa, không gọi. Trùng lặp. |
| `validateSaleInput` | `routes/api/sales.js:60` | Định nghĩa, không gọi (logic validate đã inline trong POST `/`). |
| `validateProductInput` | `routes/api/products.js` | Định nghĩa, không gọi. |
| `validatePaymentInput` | `routes/api/payments.js` | Định nghĩa, không gọi. |
| `validateStockInput` | `routes/api/stock.js` | Định nghĩa, không gọi. |
| `getActualInventory` | `routes/api/kegs.js` | Định nghĩa, không gọi. |
| `litersFromProductName` | `routes/reportData.js` | Định nghĩa, không gọi. |
| `getOsrmRoute`, `getGoogleRoute`, `haversineDistance` | `src/services/routingService.js` | Định nghĩa, không gọi từ file này (cần verify thêm trong `routes/api/routing.js`). |
| `createCartStore` | `src/store/index.js` | Định nghĩa, không gọi. |
| `formatRewardLabel` | `src/services/promotionCalc.js` | Export nhưng không nơi nào dùng (frontend tự format). |
| `sanitizeQRAccount` | `routes/api/settings.js` | Định nghĩa, không gọi. |
| `validateQRAccount` | `routes/api/settings.js` | Định nghĩa, không gọi. |

### 3.4. Dead Components / Views

| File | Bằng chứng |
|---|---|
| `views/analytics.html` | CHƯA dead — `routes/analytics.js:7` sendFile. Giữ. |
| `views/kegs.html`, `views/promo-settings.html`, `views/qr-settings.html` | CHƯA dead — `server.js:856-859`. Giữ. |

> **Không có view nào chết.** Tất cả 24 file trong `views/` đều có route mount. Đây là kết quả tốt.

### 3.5. Dead Dependencies

| Package | Trạng thái | Bằng chứng |
|---|---|---|
| `socket.io-client` | **Có thể gỡ** | 0 `require` ở backend. Frontend dùng `/socket.io/socket.io.js` do Socket.IO server serve (`src/socket/socketServer.js:93 serveClient:true`). Không có import ES module nào. |
| `chart.js` | **Trùng lặp** | Frontend dùng bản vendor `public/js/vendor/chart.umd.min.js`. Package npm không được import ở đâu. Npm package có thể là nguồn để sinh vendor file — nên giữ hoặc chuyển thành devDependency. |
| `dexie` | **Trùng lặp** | Frontend dùng `public/js/vendor/dexie.min.js` (Dexie 4) và CDN `unpkg.com/dexie@3` ở `views/driver/sale.html:33` — **hai phiên bản khác nhau cùng tồn tại**. Npm `dexie` không được import. |
| `body-parser` | **Có thể thay** | `server.js` dùng `bodyParser.json({limit:'10mb'})` + `urlencoded`. Express 4.18 đã có sẵn `express.json()`. Không phải dead nhưng là phụ thuộc thừa. |
| `ejs` | Cần xác minh | `server.js` chỉ dùng `app.engine('html', require('ejs').renderFile)` nhưng **không view nào dùng EJS syntax** — tất cả đều là HTML tĩnh gửi qua `sendFile`. Có thể dead. |
| `express-rate-limit` | ACTIVE | `server.js` dùng `limiter`, `driverLimiter`, `authLimiter`. |
| `node-cron`, `winston`, `helmet`, `compression`, `cookie-parser`, `better-sqlite3`, `socket.io` | ACTIVE | — |

### 3.6. Dead Assets

| Asset | Kích thước | Bằng chứng |
|---|---|---|
| `public/landing-assets/beer.mp4` | **61 MB** | `landing.html` chỉ ref `beer-mobile.mp4`. Đây là file lớn nhất repo. |
| `public/landing-assets/beer-web.mp4` | 14 MB | Chỉ xuất hiện trong comment hướng dẫn (`landing.html:260`). Có thể dùng làm fallback desktop — cần xác nhận. |
| `public/landing-assets/product-yellow-pet.png` | 160 KB | 0 reference. |
| `public/icon-192.png`, `public/icon-512.png` (root) | 1.7 MB | Trùng nội dung với `public/icons/icon-192.png` / `icon-512.png` nhưng **không trùng hash byte-for-byte** (kích thước khác). Cả 2 đều được ref (`views/*.html` dùng `/icon-192.png`, `views/dashboard.html` dùng `/icons/icon-192.png`). Nên chuẩn hoá về 1 đường dẫn. |

---

## 4. DANH SÁCH FILE CÓ THỂ XÓA

Xem `docs/BEER_CLEANUP_PLAN.md` §1 (chi tiết bằng chứng + module bị ảnh hưởng + test cần chạy).

---

## 5. CODE TRÙNG LẮP

| # | Trùng lặp | Vị trí | Mức độ |
|---|---|---|---|
| D1 | **Tính giá hiệu dụng** — 3 bản implementation khác nhau | `routes/api/sales.js:42` `getEffectivePrice(product, priceMap)`; `src/services/SaleService.js:_getEffectivePrice`; `public/js/sales.js:126` `getEffectivePrice(product)` | Cao |
| D2 | **Tạo bán hàng** — 2 implementation | `routes/api/sales.js:101 POST /` (1700 dòng file) vs `src/services/SaleService.js create()` | Cao |
| D3 | **Tính khuyến mãi** — đã tốt | `promotionCalc.js` là SSOT, frontend đọc từ server | ✅ Tốt |
| D4 | **`formatVND`** — 5 bản sao | `routes/{dashboard,purchases,report,sales,stock}.js` | Thấp |
| D5 | **`formatCurrency`** — 2 bản sao | `src/services/index.js:26`, `src/services/SaleService.js:7` | Thấp |
| D6 | **Realtime client** — 2 implementation | `public/js/realtime.js` (800 dòng, auto-load qua layout.js) vs `public/js/realtime-client.js` (250 dòng, auto-init) | Cao → gây **2 socket connection** |
| D7 | **Quan lý vỏ (keg)** — 2 hệ thống bảng | `keg_transactions_log` (599 dòng, cột `lost_after`) **và** `keg_transactions_log_old` (54 829 dòng) + `keg_ledger` (48) + `keg_inventory` (1) + `keg_stats` (1) + `_keg_tx_log_old` (13) | Cao |
| D8 | **Tạo session** — 2 cách | `src/services/session.js` (bảng `sessions`) vs `routes/api/dashboard.js` (query trực tiếp) | Trung bình |
| D9 | **Tính công nợ** — 2 cách | `src/services/DebtService.js` (`order_debts` + `debt_transactions`) vs `routes/api/payments.js:187` (`UPDATE customers SET debt = debt - amount` trực tiếp) | Cao |
| D10 | **Giá khách theo sản phẩm** — 4 bản query | `routes/api/sales.js:28`, `routes/api/products.js:128/140/149`, `routes/api/driver.js:920`, `routes/api/driverSale.js:155`, `routes/api/batch.js:289` | Trung bình |
| D11 | **Doanh thu theo ngày/tháng** — lặp lại ~8 nơi | `routes/dashboard.js`, `routes/analytics.js`, `routes/api/analytics.js`, `routes/reportData.js` (đều `strftime('%Y-%m', date(datetime(date,'+7 hours')))`) | Trung bình |

---

## 6. LỖI TIỀM ẨN (PHÁT HIỆN QUA AUDIT)

### 6.1. ⛔ `routes/api/promotions.js:922` — require sai path → runtime crash

```js
const calc = require('./src/services/promotionCalc').calculatePromotion(liters.yellow, liters.black);
```

File nằm ở `routes/api/`, nên `./src/services/promotionCalc` resolve thành `routes/api/src/services/promotionCalc` — **không tồn tại**.

```
$ node -e "require.resolve('./src/services/promotionCalc',{paths:['D:/Beer/routes/api']})"
RESOLVE FAIL: MODULE_NOT_FOUND
```

Đúng phải là `require('../../src/services/promotionCalc')`. Endpoint này (`POST /api/promotions/.../generate`) sẽ throw khi tạo thưởng hàng loạt.

### 6.2. ⛔ Hai Socket.IO connection trên cùng trang

- `views/dashboard.html:44` load `/js/layout.js` → layout.js tự inject `/js/realtime.js` (auto-connect).
- `views/dashboard.html:56` load `/js/realtime-client.js` → tự `initRealtime()` ở `DOMContentLoaded` → `io()` lần 2.

Tương tự `views/sales.html:36` + `:369`. Guard `__BEERPOS_REALTIME__` chỉ chặn `realtime.js` load 2 lần, **không** chặn `realtime-client.js` tạo socket riêng.

→ Mỗi page mở 2 WebSocket, 2 lần heartbeat, 2 lần nhận event → tải server gấp đôi.

### 6.3. ⚠️ Route bị shadow (không bao giờ tới được)

Phát hiện bằng script phân tích thứ tự đăng ký Express. 4 route **dead code ẩn**:

| Route | File:Line | Bị shadow bởi |
|---|---|---|
| `GET /api/customers/alerts` | `routes/api/customers.js:657` | `GET /api/customers/:id` (L99) |
| `GET /api/promotions/near-tier` | `routes/api/promotions.js:544` | `GET /api/promotions/:id` (L176) |
| `GET /api/sales/export` | `routes/api/sales.js:1180` | `GET /api/sales/:id` (L815) |
| `GET /api/session/check-migration` | `routes/api/session.js:88` | `GET /api/session/:date` (L32) |

`git grep` xác nhận không có client nào gọi `customers/alerts`, `sales/export`, `check-migration`. `near-tier` được document trong `docs/openapi.yaml`? — không, chỉ trong comment của chính file.

### 6.4. ⚠️ `middleware/auth.js:55` — interval không được dọn

```js
cleanupHandle = setInterval(() => { ... }, 30 * 60 * 1000);
```
Không có `clearInterval`. `cleanupHandle` được gán nhưng không dùng. Không gây leak nghiêm trọng (process sống lâu) nhưng nên `unref()` cho nhất quán với `middleware/cache.js` (đã `unref()`).

### 6.5. ⚠️ `routes/api/sync.js:12` — interval không `unref`

```js
setInterval(() => { ... }, 30000);
```
Giống 6.4 — nên `unref()`.

### 6.6. ⚠️ `public/js/dark-mode.js:91` — `setInterval` không clear

Top-level `setInterval` trong IIFE → không bao giờ dừng. Ít tác động (chỉ 1 interval), nhưng là mẫu không tốt.

### 6.7. ⚠️ `routes/api/products.js:165` — bug logic validation

```js
if (!customerId || !price === undefined) {
```
`!price === undefined` luôn `false` (vì `!price` là boolean, `boolean === undefined` → false). → **thiếu giá KHÔNG bị chặn**. Biểu thức đúng phải là `price === undefined`.

### 6.8. ⚠️ Secret đã commit vào Git

`.gitignore` liệt kê `*.pem`, `pass.txt`, `*_deploy_key*` — nhưng chúng **đã được track trước khi thêm ignore**:

```
_k_1782360718674.pem   _new_deploy_key   _new_deploy_key.pub
_server_rsa.pem        _server_rsa2.pem  cursor_deploy_key
cursor_deploy_key.pub  pass.txt          _gen_key.bat
```

Lịch sử Git vẫn chứa chúng (commit `534beae`, `b7a281b`, `1e82022`). `git ls-files` vẫn liệt kê → file vẫn được commit. **Cần `git rm --cached` + rotate key trên server.**

### 6.9. ⚠️ `public/js/realtime-client.js` reconnect không giới hạn đúng

`maxReconnectAttempts = 5` nhưng Socket.IO `reconnectionAttempts: 5` + `reconnection: true` — khi hết số lần, `reconnectionAttempts` của Socket.IO cũng tự reconnect sau delay. Hai lớp retry cộng dồn.

---

## 7. VẤN ĐỀ DATABASE

### 7.1. ✅ Tính toàn vẹn — ĐẠT

```
PRAGMA integrity_check      → ok
PRAGMA foreign_key_check    → none
```

### 7.2. ⛔ `debt_transactions` — bảng KHÔNG TỒN TẠI nhưng code vẫn ghi

`src/services/DebtService.js` INSERT vào `debt_transactions` ở **4 chỗ** (L42, L97, L~180, L~210). Bảng này chỉ được tạo trong `database/migrations/004_business_features.js:204`, và migration đó **chưa bao giờ chạy** trên DB này.

```
$ node __audit_debttx.js
INSERT FAILS -> no such table: debt_transactions
SELECT FAILS -> no such table: debt_transactions
```

**Hậu quả:** `POST /api/sales` với `debt=true` → `DebtService.createDebt()` throw → transaction rollback → **không tạo được đơn bán chịu**. `POST /api/payments` và `POST /api/debts` (`payDebt`) cũng chết.

### 7.3. ⛔ Root cause: version gate migration sai

| | DB hiện tại | Code |
|---|---|---|
| `schema_version` | `2026090201.0` | `MIGRATION_VERSION = 2026062701` |
| `business_features_version` | `2026090202.0` | `BUSINESS_FEATURES_VERSION = 2026041602` |

`database/migration.js:576-580`:
```js
const bizVersion = getBusinessFeaturesVersion(db);
if (bizVersion >= BUSINESS_FEATURES_VERSION) {
  log('Business features already migrated');
  return { success: true, skipped: true };   // ← SKIP
}
```

DB đã ghi `2026090202.0` (lớn hơn `2026041602`) → migration **bị skip** → 3 bảng không được tạo:

| Bảng | Trạng thái | Ai dùng |
|---|---|---|
| `debt_transactions` | **MISSING** | `DebtService` (4 INSERT + 1 SELECT + 1 JOIN) |
| `customer_segments` | **MISSING** | `routes/api/segments.js` (toàn bộ file) + `customers.segment_id` |
| `delivery_schedules` | **MISSING** | `delivery_schedule_items` (thiếu FK) — hiện chưa có route dùng |

Ngoài ra `customers.segment_id` cũng **không tồn tại** (chỉ có `reward_tier`) → `routes/api/segments.js` sẽ lỗi SQL kể cả khi có bảng.

### 7.4. ⛔ `sync_queue` — column `synced` không tồn tại

Schema thật: `id, uuid, entity, entity_id, entity_uuid, action, payload, priority, retry_count, max_retries, status, error_message, created_at, last_attempt, next_retry, synced_at, device_id, version`.

Cột dùng để lọc là `status` / `synced_at`. Nhưng `routes/api/sync.js` query theo `synced`:

| Endpoint | Query | Kết quả |
|---|---|---|
| `GET /api/sync/status` (L316) | `SELECT COUNT(*) FROM sync_queue WHERE synced = 0` | ❌ `no such column: synced` |
| `GET /api/sync/status` (L319) | `... WHERE synced = 1` | ❌ |
| `POST /api/sync/pull` (L273) | `SELECT * FROM sync_queue WHERE synced = 0 ORDER BY created_at ASC LIMIT 100` | ❌ → **toàn bộ `/api/sync/pull` trả 500** |
| `POST /api/sync/mark` (L341) | `UPDATE sync_queue SET synced = 1 WHERE id IN (...)` | ❌ |

→ **`/api/sync/pull` (endpoint chính của cơ chế offline→cloud) đang trả 500.** Đây là hỏng hóc chức năng cốt lõi của hệ thống offline-first.

### 7.5. ⚠️ Bảng trùng lặp / legacy

| Bảng | Rows | Ghi chú |
|---|---|---|
| `keg_transactions_log_old` | **54 829** | Bản cũ, cột khác (`inventory_after*` NOT NULL, không có `lost_after`) |
| `keg_transactions_log` | 599 | Bản đang dùng |
| `_keg_tx_log_old` | 13 | Bản cũ #2 |
| `keg_transactions_log_new` | 0 | Bản thử nghiệm, rỗng |
| `keg_ledger` | 48 | Hệ thống ledger mới, song song với log |
| `keg_inventory` / `keg_stats` | 1 / 1 | Singleton state |

5 bảng cho cùng một nghiệp vụ "vỏ bia" → khó truy vết, dễ lệch số.

### 7.6. ⚠️ Bảng rỗng / chưa dùng

`promotions` (0), `order_debts` (0), `driver_monthly_salary` (0), `driver_salary_advances` (0), `audit_log` (0), `stock_history` (0), `damaged_products` (0), `sessions` (0), `sync_queue` (0), `inventory_movements` (2), `delivery_events` (2).

`order_debts` rỗng trong khi `DebtService.createDebt` được gọi từ `routes/api/sales.js:449` → nếu lỗi 7.2 được sửa, bảng này mới bắt đầu có dữ liệu.

### 7.7. ⚠️ Index

- `idx_sales_date_type` tồn tại nhưng `routes/api/sales.js:690` dùng `${whereClause}` động → index thường không dùng.
- Thiếu index cho `keg_transactions_log(type, date)` — truy vấn log vỏ rất nhiều.
- `products.slug`, `customers.name/phone` đã có index tốt.
- 145 index non-sqlite → nhìn chung ổn.

### 7.8. ✅ Quy tắc nghiệp vụ đã kiểm chứng

| Quy tắc | Trạng thái | Bằng chứng |
|---|---|---|
| Không tính doanh thu từ đơn đã hủy | ✅ | Tất cả query doanh thu đều có `archived = 0` (`reportData.js:248,266,405,448,489`; `analytics.js:46,59,73,117,203`; `dashboard.js:120,138,164,199,248`) |
| Hủy đơn hoàn kho đúng 1 lần | ✅ | `src/services/saleDelete.js` chạy trong `db.transaction()`, guard `sale.archived === 1` → `already_deleted` |
| Phân biệt đơn trả thưởng vs đơn tính tiền | ✅ | `sale_items.paid_quantity` / `reward_quantity` / `reward_source`; `saleDelete.js` B1 chỉ revert `price > 0`; B2 dùng `promo_type='MONTHLY_BONUS'` |
| Không cộng trùng giao dịch vỏ | ✅ | `keg_ledger` + `keg_stats` singleton; `saleDelete.js` chỉ hoàn `return_kegs` |
| Không xóa lịch sử giao dịch | ✅ | Xóa đơn dùng **soft-delete** (`archived = 1`), không `DELETE FROM sales` |
| Công nợ đối soát được | ⚠️ | `DebtService.recalcDebt()` so `customers.debt` vs tổng `order_debts.remaining_amount` — nhưng `order_debts` rỗng và `debt_transactions` thiếu → **không đối soát được** |

---

## 8. VẤN ĐỀ ĐỒNG BỘ

### 8.1. ⛔ `/api/sync/pull` trả 500 — đồng bộ offline→cloud hỏng hoàn toàn

Xem §7.4. `public/sync.js:719` và `:745` gọi `/api/sync/pull`; `public/sw.v2.js` không dùng pull nhưng dùng `/api/sync/push`.

### 8.2. ⚠️ Idempotency của `/api/sync/push` chỉ dựa vào RAM 60 giây

```js
// routes/api/sync.js:9-19
const _processedIds = new Map();
const CACHE_TTL = 60000;
setInterval(() => { /* xóa entry cũ */ }, 30000);
```

- Server restart / PM2 reload → cache mất → **giao dịch đã sync có thể chạy lại**.
- TTL 60s: nếu client offline > 60s rồi retry → syncId cũ không còn trong cache → chạy lại.
- **Không có bảng idempotency persistent** (`sync_queue` rỗng và không được dùng làm dedup store).

### 8.3. ⚠️ Conflict resolution: so sánh `updated_at` không đồng nhất

- `routes/api/sync.js:90` so `serverRow.updated_at > client_updated_at` → trả `conflict: 'server_newer'`.
- `routes/api/sync.js:218` (legacy `/push`) so tương tự nhưng **push `conflicts` array rồi `return`** — không báo cho client biết mục nào conflict trong body (client `public/sync.js` không đọc `conflicts`).
- **Không có last-write-wins fallback**: client nhận `conflict: true` → `public/sw.v2.js` coi cả batch là failed → tăng `retry_count` → retry lại vô hạn tới `MAX_RETRIES` → **xóa im lặng** (mất giao dịch).

### 8.4. ⚠️ SW xóa queue trước khi xác nhận từng item

```js
// public/sw.v2.js:401-404
const dtx  = db.transaction(STORE_SYNC, 'readwrite');
const didx = dtx.objectStore(STORE_SYNC).index('synced');
const cur  = didx.openCursor(IDBKeyRange.only(0));
cur.onsuccess = e => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
```

Xóa **toàn bộ** queue ngay sau khi POST, kể cả khi server trả `failed` cho một phần. Logic `resp.ok` / `data.failed` ở dưới chỉ tăng `retry_count` cho item **đã bị xóa** → `incrementRetryCount` không tìm thấy row → retry không hoạt động. → **Mất giao dịch offline.**

Tương tự `public/sync.js:699-705`.

### 8.5. ⚠️ `/api/sync/push` không validate `entity` đầy đủ

`routes/api/sync.js:88` — `ENTITY_TO_TABLE` có 10 entity, nhưng whitelist check ở L68 chỉ cho 6 entity (`customer, product, sale, expense, payment, keg_transaction`). `purchase`, `purchase_item`, `device`, `price` có trong map nhưng **không được phép** qua `/batch`. → `/api/sync/push` (legacy) **không** validate entity → có thể ghi vào bảng tùy ý qua `ENTITY_TO_TABLE[entity] || entity + 's'`.

### 8.6. ⚠️ `applySaleChange` ghi đè `sale_items` không kiểm tra transaction

```js
// routes/api/sync.js:384-392
db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(entity_id);
```
Không bọc transaction → nếu `INSERT` lỗi giữa chừng → mất toàn bộ line item của đơn.

### 8.7. ⚠️ Không có cơ chế "server xác nhận lưu thành công" theo từng item

Server trả `results[]` per-item (`{syncId, success, conflict, error}`) nhưng SW **không dùng** `results` — nó chỉ kiểm `resp.ok` rồi xóa hết. → mất khả năng retry đúng cách.

### 8.8. ✅ Điểm tốt

- `sale_items.price_at_time` lưu snapshot giá → báo cáo cũ không đổi khi giá sản phẩm đổi.
- Mọi bảng nghiệp vụ có `uuid`, `version`, `deleted`, `updated_at` → nền tảng last-write-wins.
- `deleted`/`archived` là soft-delete → không mất lịch sử.
- `customer_monthly_stats` không có bản ghi trùng (`GROUP BY customer_id,year,month HAVING count>1` → 0 kết quả).
- `prices` không có bản ghi trùng (đã có `idx_prices_unique`).

---

## 9. VẤN ĐỀ HIỆU NĂNG

### 9.1. Frontend

| Vấn đề | Số liệu |
|---|---|
| `public/` tổng cộng | **102.3 MB** |
| `public/landing-assets/beer.mp4` | 61 MB — **không dùng** |
| `beer-mobile.mp4` + `beer-web.mp4` | 31 MB — dùng cho landing page |
| `public/css/unified.css` | 187 KB (5 998 dòng) — load ở hầu hết mọi trang |
| `public/js/sales.js` | 90 KB — load ở cả Admin lẫn Driver |
| `public/js/vendor/chart.umd.min.js` | 204 KB |
| `public/js/driver/system.css` + `driver.css` | 119 KB cho Driver Portal |
| Icon PNG | 12 file, tổng ~7.9 MB (kích thước cực lớn cho icon — nên dùng PNG 32/192/512 + SVG) |

**Không có build step cho JS** → không bundle, không minify, không tree-shake. `<script defer>` chỉ giúp parse song song.

### 9.2. Backend

| Vấn đề | Vị trí |
|---|---|
| `db.prepare()` trong vòng lặp (N+1) | `routes/api/sales.js:1285` (DELETE trong loop `drId`), `src/services/saleDelete.js:271`, `routes/api/sync.js:216/251/258/296/393` (prepare mới mỗi item), `routes/api/analytics.js:216/232`, `routes/api/state.js:215`, `routes/api/sales-staff.js:269`, `src/services/salesStaff.js:68` |
| `db.prepare()` không cache | `routes/api/sales.js:26` (`buildPriceMapForCustomer`) — chuẩn bị lại mỗi request |
| `SELECT *` | `routes/api/sales.js:153` (`SELECT * FROM products`), `SaleService._loadProducts` (`SELECT * FROM products`) |
| Response không giới hạn | `routes/api/sync.js:258` `LIMIT 1000` × 10 bảng; `routes/api/sync.js:296` `LIMIT 2000` × 3 bảng — payload lớn |
| `console.log` trong vòng lặp | `src/services/saleDelete.js:160,178,205,277` dùng `console.log` thay vì `logger` |
| Log file rất lớn | `src/logs/combined.log` 884 KB, `src/logs/error.log` 455 KB — không rotation |
| `routes/api/sales.js` 1700 dòng | 1 file chứa 18 route + validate + SQL + nghiệp vụ |

### 9.3. Database

- WAL file 4.2 MB cạnh DB 11.5 MB → cần checkpoint định kỳ.
- `keg_transactions_log_old` 54 829 dòng — không có index phù hợp cho `type, date`.
- Query `WHERE updated_at > ? OR created_at > ?` (`routes/api/sync.js:260`) — **không dùng được index** (OR trên 2 cột) → full scan mỗi lần pull.

### 9.4. Realtime

- 2 socket/page (§6.2) → gấp đôi băng thông WebSocket, gấp đôi event handler.

---

## 10. ĐỀ XUẤT TÁI CẤU TRÚC

> Theo yêu cầu: **chỉ đề xuất, chưa thực hiện**.

### 10.1. Kiến trúc mục tiêu

```
views/*.html (UI thuần)
   ↓ fetch
routes/api/* (validate + authorize + trả JSON, KHÔNG chứa SQL)
   ↓
src/services/* (business logic thuần, không phụ thuộc Express)
   ↓
src/repositories/* (SQL thuần, giữ nguyên better-sqlite3)
   ↓
database.sqlite
```

### 10.2. Thứ tự ưu tiên

| # | Hạng mục | Nội dung | Rủi ro |
|---|---|---|---|
| P0 | **Sửa crash runtime** | 6.1 (require path), 7.2/7.3 (thiếu bảng), 7.4 (column `synced`), 6.7 (validate price) | Thấp |
| P0 | **Tách `db` khỏi `routes/api/segments.js` + `batch.js`** | 6.4/§7 | Thấp |
| P0 | **Rotate secret đã commit** | 6.8 | Trung bình (cần thao tác Git history) |
| P1 | **Sửa đồng bộ mất dữ liệu** | 8.4 (SW xóa queue sớm), 8.3 (conflict retry vô hạn) | Trung bình |
| P1 | **Bỏ 2 socket/page** | 6.2 | Thấp |
| P1 | **Sửa 4 route bị shadow** | 6.3 | Thấp |
| P2 | **Idempotency persistent** | 8.2 — bảng `sync_dedup(sync_id PRIMARY KEY, created_at)` | Trung bình (cần migration) |
| P2 | **Tách `SaleService` ra khỏi `routes/api/sales.js`** | D1, D2 | Cao (nghiệp vụ tiền/thưởng) |
| P2 | **Gộp bảng vỏ legacy** | D7 | Cao (dữ liệu lịch sử) |
| P2 | **Repository layer** | D10, D11 | Trung bình |
| P3 | **Build step cho frontend** | Bundle + minify JS/CSS | Thấp |
| P3 | **Chuẩn hoá icon / video** | 9.1 | Thấp |

### 10.3. Đề xuất cụ thể cho các điểm nóng

**a) Giá bán (D1)** — tạo `src/services/pricing.js`:
```js
// SINGLE SOURCE OF TRUTH
function getEffectivePrice(product, priceMap) { /* byId → bySlug → sell_price */ }
```
Backend dùng; frontend nhận `priceMap` từ server (đã có ở `GET /api/driver/sale/data`) — không copy logic sang client.

**b) Công nợ (D9)** — mọi thay đổi `customers.debt` phải qua `DebtService`; `routes/api/payments.js:187` phải delegate.

**c) Realtime (D6)** — chọn 1 implementation. Khuyến nghị giữ `realtime.js` (đầy đủ hơn, có coalescing) và bỏ `realtime-client.js`, cập nhật `dashboard.html:56` + `sales.html:369`.

**d) Đồng bộ (8.4)** — SW chỉ xóa item **có `syncId` trong `results[]` với `success: true`**. Item conflict/error → tăng `retry_count`, giữ trong queue.

---

## 11. KẾ HOẠCH TRIỂN KHAI

> Chi tiết trong `docs/BEER_CLEANUP_PLAN.md`.

### Giai đoạn 0 — Chuẩn bị (không đụng code)
1. `git branch audit/baseline` + tag `pre-audit` (đã có 296 file track).
2. Backup DB: `sqlite3 database.sqlite ".backup backup_pre_audit.sqlite"`.
3. Chạy `npm test` để lấy baseline (bao gồh test đang fail).

### Giai đoạn 1 — P0: Crash runtime (không đụng schema)
- Sửa `routes/api/promotions.js:922`.
- Thêm `const db = require('../../database');` vào `routes/api/segments.js`, `routes/api/batch.js`.
- Sửa `routes/api/products.js:165`.
- Sửa 4 route shadow (di chuyển route tĩnh lên trên route có param).
- Bỏ `realtime-client.js` khỏi `dashboard.html` + `sales.html`.

### Giai đoạn 2 — P0: Secret
- `git rm --cached` các file secret.
- **Rotate toàn bộ SSH key + `ADMIN_PASSWORD` trên server.**
- Thêm `*.pem`, `*_deploy_key*`, `pass.txt` vào `.gitignore` (đã có — cần `git rm --cached`).
- Cân nhắc `git filter-repo` để purge lịch sử (cần backup repo trước).

### Giai đoạn 3 — P1: Migration bảng thiếu (CẦN BACKUP + ROLLBACK)
- Viết `database/migrations/048_missing_business_tables.js` — idempotent, chỉ `CREATE TABLE IF NOT EXISTS`.
- Sửa version gate: đặt `BUSINESS_FEATURES_VERSION` lên `2026090203` HOẶC bỏ gate và luôn chạy migration idempotent.
- Rollback: script drop 3 bảng mới (chỉ khi rỗng).

### Giai đoạn 4 — P1: Đồng bộ
- Sửa `routes/api/sync.js` dùng `status`/`synced_at` thay `synced`.
- Sửa SW xóa queue theo `results[]`.
- Thêm `sync_dedup` table (idempotency persistent).

### Giai đoạn 5 — P2: Dọn dead code
- Xóa nhóm SAFE TO DELETE (18 nhóm).
- Giữ nhóm NEEDS INVESTIGATION.
- Chạy `npm test` + smoke test.

### Giai đoạn 6 — P3: Hiệu năng
- Dọn asset (61 MB video + icon thừa).
- Thêm build step frontend.

---

## 12. ĐÁNH GIÁ RỦI RO

| Thay đổi | Rủi ro | Mức | Biện pháp giảm thiểu |
|---|---|---|---|
| Xóa file dead code | Rất thấp | 🟢 | Đã chứng minh 0 reference; `git revert` được |
| Sửa require path | Thấp | 🟢 | Sửa 1 dòng; test lại endpoint |
| Thêm `import db` | Thấp | 🟢 | 2 dòng |
| Di chuyển route (fix shadow) | **Trung bình** | 🟡 | Route `/:id` có thể bắt `alerts`/`export`/`near-tier` — di chuyển static lên trên; test cả 2 |
| Bỏ `realtime-client.js` | Thấp | 🟢 | `realtime.js` đã có guard + đầy đủ hơn |
| **Tạo bảng DB mới** | **Cao** | 🔴 | Backup `.backup` trước; migration idempotent; rollback script; test trên copy DB |
| **Sửa `sync_queue` query** | **Trung bình-High** | 🔴 | Ảnh hưởng offline→cloud; test trên copy DB; deploy giờ thấp traffic |
| Sửa SW xóa queue | **Cao** | 🔴 | Logic retry cốt lõi; test trên browser thật + IndexedDB |
| Thêm `sync_dedup` | Trung bình | 🟡 | Bảng mới chỉ append; không ảnh hưởng dữ liệu cũ |
| Tách `SaleService` | **Rất cao** | 🔴 | Chạm nghiệp vụ tiền/thưởng; cần snapshot test; chia nhỏ từng PR |
| Gộp bảng vỏ | **Rất cao** | 🔴 | 54 829 dòng lịch sử; phải có bước đối soát số trước/sau |
| Xóa/rotate secret | Trung bình | 🟡 | Key cũ đã lộ → phải rotate, không chỉ xóa file |
| Build step frontend | Thấp | 🟢 | Song song giữ bản cũ; so sánh output |
| Dọn video/icon | Rất thấp | 🟢 | Chỉ xóa file không reference |

---

## 13. PHỤ LỤC

### 13.1. Scripts audit đã dùng (tạm, xóa sau audit)

| Script | Mục đích |
|---|---|
| `__audit_graph4.js` | Build dependency graph (require / script tag / loadScript / @import / sendFile) |
| `__audit_broken.js` | Tìm require không resolve được |
| `__audit_routes.js` | Phát hiện route bị shadow |
| `__audit_db.js` / `__audit_tbl.js` | Dump schema + integrity |
| `__audit_sync.js` / `__audit_biz.js` | Kiểm tra `sync_queue` + version gate |
| `__audit_funcs.js` | Tìm function không có call site |
| `__audit_perf.js` | setInterval không clear + N+1 patterns |
| `__audit_assets2.js` | Asset size + unused images |

### 13.2. Số liệu tổng quan

| Chỉ số | Giá trị |
|---|---|
| File Git track | 296 |
| File JS trong `src/` | 21 |
| File route | 25 (`routes/api`) + 14 (`routes/`) |
| View | 24 (`views/`) |
| Bảng DB | 58 (3 bảng thiếu so với code) |
| Index (non-sqlite) | 145 |
| Dòng code lớn nhất | `public/css/unified.css` (5 998) |
| File JS lớn nhất | `routes/api/sales.js` (1 700) |
| Tổng `public/` | 102.3 MB |
| `integrity_check` | ok |
| `foreign_key_check` | none |
| Test files | 10 |

---

**Kết luận:** Kiến trúc tổng thể hợp lý, có phân tầng rõ, và **đã có một Single Source of Truth tốt cho khuyến mãi** (`promotionCalc.js`). Tuy nhiên có **4 lỗi crash runtime chắc chắn** (require sai path, 2 file thiếu import `db`, 3 bảng DB thiếu, column `synced` không tồn tại) đang làm hỏng chức năng cốt lõi (bán chịu, thanh toán công nợ, phân khúc khách hàng, đồng bộ offline→cloud). Đề xuất ưu tiên xử lý nhóm P0 trước, hoàn toàn trong Giai đoạn 3+ vì có migration và cần rollback.
