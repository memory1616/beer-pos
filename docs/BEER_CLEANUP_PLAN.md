# BEER CLEANUP PLAN — Kế hoạch xóa dead code & chuẩn hoá

> **Ngày:** 2026-11-12
> **Trạng thái:** ✅ **ĐÃ THỰC HIỆN XONG** — branch `cleanup/audit-2026-11-12` (PR1–PR8).
> Xem bảng trạng thái ở [§12. KẾT QUẢ THỰC THI](#12-kết-quả-thực-thi).
> **Điều kiện tiên quyết:** Đọc `docs/BEER_PROJECT_AUDIT.md` trước.
> **Quy tắc bất di bất dịch:** Không xóa dữ liệu, không đổi schema nếu chưa có migration + rollback, không sửa Production trực tiếp.

---

## 0. CHECKLIST TRƯỚC KHI BẮT ĐẦU

```bash
# 1. Backup DB (dùng .backup của SQLite — an toàn hơn copy file khi đang có WAL)
node -e "const D=require('better-sqlite3');const db=new D('database.sqlite');db.exec(\"VACUUM INTO 'backup/pre_cleanup_$(date +%Y%m%d_%H%M%S).sqlite'\");db.close()"

# 2. Baseline test
npm test 2>&1 | tee logs/test_baseline.txt

# 3. Branch riêng
git checkout -b chore/deadcode-cleanup
git tag pre-cleanup-$(date +%Y%m%d)
```

---

## 1. FILE CẦN XÓA — SAFE TO DELETE

> Đã chứng minh **0 reference** qua: `require()`, `<script src>`, `loadScript()`, `@import`,
> `sendFile`/`res.render`, `package.json` scripts, cron config, deploy config, nginx config.
> **Không xóa file nào trong nhóm này nếu chưa chạy `npm test` sau khi xóa.**

### 1.1 Frontend JavaScript (5 file)

| # | File | Bằng chứng | Module bị ảnh hưởng | Test sau khi xóa |
|---|---|---|---|---|
| F1 | `public/js/api.js` | `git grep "/js/api.js"` → 0 hit; không view nào `<script src>`; `window.Api` chỉ được set trong chính file | Admin POS (không) — các trang dùng `fetch` trực tiếp | Mở `/dashboard`, `/customers`, `/sale` — kiểm tra console không lỗi 404 |
| F2 | `public/js/empty-state.js` | 0 reference | Không có (chỉ class CSS `.empty-state` cũng dead) | `npm test`; load `/customers` |
| F3 | `public/js/numeric-keypad.js` | `git grep numeric-keypad` → 0 hit | Không có | Mở `/sale` (bàn phím số chạy inline) |
| F4 | `public/js/segmentation.js` | `git grep segmentation` → 0 hit | `/api/segments` (API riêng) | Mở trang phân khúc |
| F5 | `public/js/debts-promotions.js` | Chỉ khớp 1 dòng trong `REFACTOR_STEP1.md` (doc) | Dashboard | Mở `/dashboard` → tab Công nợ/KM |
| F6 | `public/js/delivery.js` | `views/delivery.html` chỉ load `layout.js` + `map-tiles.js` | Trang Giao hàng (Admin) | Mở `/delivery` — bản đồ + danh sách phải hoạt động |
| F7 | `public/js/driver/delivery.js` | `views/driver/delivery.html` load `map-tiles.js`, `driver/core.js`, `driver/shell.js`, `driver/sync.js` — **không có** file này | Driver Portal | Mở `/driver/giao-hang` — trạng thái đơn phải cập nhật |
| F8 | `public/js/driver/sale.js` | `views/driver/sale.html` KHÔNG load (dùng `driver/api-shim.js` + `public/js/sales.js`) | Driver Portal bán hàng | Mở `/driver/ban-hang` — tạo đơn thử |
| F9 | `public/js/report.js` | Tự ghi `DEPRECATED` ở dòng 2; 0 reference | Báo cáo | Mở `/report` |

### 1.2 Component / CSS (9 file)

| # | File | Bằng chứng | Ảnh hưởng | Test |
|---|---|---|---|---|
| F10 | `public/components/common/customer-card.html` | `git grep "components/common"` → 0 hit | Không có | Visual check admin |
| F11 | `public/components/common/index.html` | idem | Không có | — |
| F12 | `public/components/common/product-card.html` | idem | Không có | — |
| F13 | `public/components/common/section.html` | idem | Không có | — |
| F14 | `public/components/common/total-bar.html` | idem | Không có | — |
| F15 | `public/components/shell/app-shell.html` | `git grep app-shell` → chỉ khớp version string `layout.js?v=20260412b-app-shell` (false positive) | Không có | — |
| F16 | `public/components/ui/index.css` | Chỉ tự tham chiếu trong comment của chính nó | Không có | — |
| F17 | `public/components/ui/button.css` | idem | Không có | — |
| F18 | `public/components/ui/card.css` | idem | Không có | — |
| F19 | `public/components/ui/input.css` | idem | Không có | — |
| F20 | `public/css/ui-components.css` | `git grep ui-components` → 0 hit (chỉ chứa `.empty-state`, `.btn`... đã lỗi thời) | Không có | Visual check mọi trang |

> **Lưu ý:** `public/core/theme.css` **KHÔNG** nằm trong danh sách xóa — nó được `@import` bởi `public/css/unified.css:11`.

### 1.3 Assets (3 file)

| # | File | Kích thước | Bằng chứng | Ảnh hưởng |
|---|---|---|---|---|
| F21 | `public/landing-assets/beer.mp4` | **61 MB** | `landing.html` chỉ ref `beer-mobile.mp4` | Landing page — vẫn phát video mobile |
| F22 | `public/landing-assets/product-yellow-pet.png` | 160 KB | 0 reference trong `landing.html` / `landing.css` | Landing page — kiểm tra section sản phẩm hiển thị đúng |
| F23 | `public/landing-assets/beer-web.mp4` | 14 MB | Chỉ xuất hiện trong **comment hướng dẫn** (`landing.html:260`) | ⚠️ **Cần xác nhận**: có dùng làm fallback desktop không? Nếu không → xóa; nếu có → giữ |

### 1.4 Migration legacy (2 file)

| # | File | Bằng chứng | Ảnh hưởng | Test |
|---|---|---|---|---|
| F24 | `database/migrations/042_sale_time.js` | Nội dung: `// This file is deprecated - sale_time is now added in database/migration.js`; `migration.js` không require | Không có | `npm test`; kiểm tra `sales.sale_time` vẫn tồn tại |
| F25 | `database/migrations/041_sales_staff.js` | `migration.js` **không** require file này → chưa từng chạy. Schema đã được tạo trong `database.js` L1481+ (`CREATE TABLE IF NOT EXISTS sales_staff` …). Các bảng đều tồn tại trong DB | Nhân viên sales / hoa hồng | `npm test`; mở `/sales-staff`; chạy `scripts/test-driver-staff.js` |

> ⚠️ **KHÔNG xóa `database/migrations/004_business_features.js`** — nó chứa định nghĩa 3 bảng đang thiếu (`debt_transactions`, `customer_segments`, `delivery_schedules`). Xem §4.

---

## 2. FUNCTION CẦN XÓA

> Tất cả đều đã verify: định nghĩa nhưng **không có call site nào** trong toàn repo.

| # | Hàm | File:Line | Bằng chứng | Lý do xóa | Test |
|---|---|---|---|---|---|
| FN1 | `formatVND` | `routes/dashboard.js` | 1 self-ref (chỉ dòng định nghĩa) | Trùng lặp, không dùng | `npm test` |
| FN2 | `formatVND` | `routes/purchases.js` | idem | idem | `npm test` |
| FN3 | `formatVND` | `routes/report.js` | idem | idem | `npm test` |
| FN4 | `formatVND` | `routes/sales.js` | idem | idem | `npm test` |
| FN5 | `formatVND` | `routes/stock.js` | idem | idem | `npm test` |
| FN6 | `formatCurrency` | `src/services/index.js:26` | 1 self-ref | Trùng lặp | `npm test` |
| FN7 | `formatCurrency` | `src/services/SaleService.js:7` | 1 self-ref | Trùng lặp | `npm test` |
| FN8 | `validateSaleInput` | `routes/api/sales.js:60` | 1 self-ref | Đã inline trong `POST /` | `npm test`; POST `/api/sales` invalid payload → vẫn 400 |
| FN9 | `validateProductInput` | `routes/api/products.js` | 1 self-ref | Không dùng | `npm test` |
| FN10 | `validatePaymentInput` | `routes/api/payments.js` | 1 self-ref | Không dùng | `npm test` |
| FN11 | `validateStockInput` | `routes/api/stock.js` | 1 self-ref | Không dùng | `npm test` |
| FN12 | `getActualInventory` | `routes/api/kegs.js` | 1 self-ref | Không dùng | `npm test` |
| FN13 | `litersFromProductName` | `routes/reportData.js` | 1 self-ref | Không dùng | `npm test` |
| FN14 | `sanitizeQRAccount` | `routes/api/settings.js` | 1 self-ref | Không dùng | `npm test`; PUT `/api/settings/qr-accounts` |
| FN15 | `validateQRAccount` | `routes/api/settings.js` | 1 self-ref | Không dùng | idem |
| FN16 | `createCartStore` | `src/store/index.js` | 1 self-ref | Không dùng | `npm test` |
| FN17 | `formatRewardLabel` | `src/services/promotionCalc.js` | Chỉ export | Frontend tự format | `npm test`; báo cáo thưởng hiển thị đúng |

> ⚠️ **NEEDS INVESTIGATION — KHÔNG xóa:**
> - `getOsrmRoute`, `getGoogleRoute`, `haversineDistance` (`src/services/routingService.js`) — cần verify `routes/api/routing.js` không gọi qua alias/object.
> - `src/store/index.js` — file chứa `createCartStore` nhưng còn nhiều thứ khác; xem §3.

---

## 3. FILE CẦN GIỮ (MUST KEEP)

| File | Lý do |
|---|---|
| `server.js` | Entry point HTTP |
| `database.js` | Kết nối DB + migration + helper query |
| `database/migration.js` | Orchestrator migration |
| `database/migrations/004_business_features.js` | **Định nghĩa 3 bảng đang thiếu** (`debt_transactions`, `customer_segments`, `delivery_schedules`) — xem §4 |
| `database/migrations/043..047_*.js` | Đang chạy (version-gated riêng) |
| `src/services/index.js` | `PromotionService` + `SaleService` façade — dùng bởi 6 route |
| `src/services/promotionCalc.js` | **SSOT khuyến mãi** — dùng bởi backend + đọc từ server cho frontend |
| `src/services/saleDelete.js` | Xóa đơn + hoàn kho — dùng bởi `/api/sales` và `/api/sync/push` |
| `src/services/DebtService.js` | Công nợ — **đang broken**, xem §4 |
| `src/services/session.js` | Dùng bởi `routes/api/session.js` |
| `src/socket/socketServer.js` | Realtime server |
| `src/cache/index.js` | Dùng bởi `routes/api/segments.js` + `batch.js` |
| `middleware/*.js` (4 file) | Auth / RBAC / cache / validation / error handler |
| `public/sw.v2.js` | Service Worker hiện hành |
| `public/sw.js` | **OBSOLETE BUT REFERENCED** — `public/js/login.js:193` register `/sw.js`; `server.js:562` redirect. Xem §5 |
| `public/db.js` | Lớp Dexie offline — load bởi 7 view |
| `public/sync.js` | Đồng bộ client |
| `public/js/realtime.js` | Realtime client (giữ, bỏ `realtime-client.js`) |
| `public/js/vendor/dexie.min.js`, `chart.umd.min.js` | Đang load bởi views |
| `public/icons/*` | Manifest PWA |
| `ecosystem.config.js` | PM2 — `Dockerfile:45`, `.github/workflows/deploy.yml:38`, `deploy/deploy.sh` |
| `check_devices.js`, `sync_devices.js`, `fix_device_customer.js` | Script vận hành — **cần chủ repo xác nhận**, xem §6 |
| `tests/**` | 10 file test Jest |
| `deploy/**`, `scripts/**` | Vận hành — trừ script debug |

---

## 4. FILE CẦN ĐIỀU TRA THÊM (NEEDS INVESTIGATION)

### 4.1 `src/store/index.js` (305 dòng)

- **Hiện trạng:** Backend file này **không ai `require`**. Nhưng frontend có `window.BeerStore` dùng ở `public/js/customers.js:1306`, `public/js/expenses.js:8`, `public/js/sync.js:729`.
- **Cần xác minh:** `window.BeerStore` được định nghĩa ở đâu? (grep `BeerStore =` trong `public/` → **không tìm thấy** → có thể `public/db.js` expose nó dưới tên khác, hoặc là dead code ở frontend).
- **Hành động:** Grep `BeerStore` trong `public/db.js`. Nếu frontend cũng không định nghĩa → cả `src/store/index.js` lẫn các call site `window.BeerStore` đều là **dead code có guard an toàn** (`if (window.BeerStore && ...)`) → xóa được cả hai.

### 4.2 `public/sw.js` (26 KB)

- **Hiện trạng:** Bản cũ. `server.js:562` redirect `/sw.js` → `/sw.v2.js`. Nhưng `public/js/login.js:193` vẫn `register('/sw.js')`.
- **Cần làm:** Đổi `login.js:193` → `register('/sw.v2.js')`. Sau đó `public/sw.js` mới xóa được. Đồng thời rà `public/js/driver/sync.js` và `public/js/realtime.js` xem có register `/sw.js` không.

### 4.3 `public/css/styles.css` (24 byte)

- **Hiện trạng:** Chỉ là input cho `npm run build:css` (Tailwind CLI). Output `public/css/tailwind.css` bị `.gitignore`.
- **Cần xác minh:** Tailwind còn được dùng không? Nếu `tailwind.css` không được load ở bất kỳ view nào → gỡ cả `build:css`/`watch:css` + 4 devDependency Tailwind/PostCSS/Autoprefixer.

### 4.4 `public/landing-assets/beer-web.mp4` (14 MB)

- Xác nhận có fallback desktop không (xem F23).

### 4.5 `check_devices.js`, `sync_devices.js`, `fix_device_customer.js`

- Script vận hành ad-hoc ở root, không có trong `package.json` scripts.
- Đề xuất: gom vào `scripts/ops/` hoặc xóa — cần chủ repo xác nhận.

### 4.6 Test script cũ ở root

`test_edge_cases.js`, `test_full_flow.js`, `test_integration.js`, `test_promotion.js`, `test_first_month_reward.js`
- Không chạy trong Jest (không có `describe/test` hoặc không nằm trong `tests/`).
- Cần xác nhận còn dùng tay không → chuyển vào `tests/` (chuyển sang Jest) hoặc xóa.

### 4.7 `ejs` dependency

- `server.js` khai báo `app.engine('html', require('ejs').renderFile)` nhưng **không view nào dùng EJS syntax** (tất cả là HTML tĩnh qua `sendFile`).
- Xác minh: `git grep -E "<%" views/` → nếu 0 hit → `ejs` là dead dependency → gỡ khỏi `package.json` + `server.js`.

---

## 5. DEPENDENCY CẦN GỠ

| # | Package | Lý do | Bằng chứng | Rủi ro | Test |
|---|---|---|---|---|---|
| DP1 | `socket.io-client` | Frontend dùng `/socket.io/socket.io.js` do server serve (`socketServer.js:93 serveClient:true`), không import npm | 0 `require('socket.io-client')`; `public/js/realtime.js:653` set `script.src = ...'/socket.io/socket.io.js'` | 🟢 Thấp — nhưng **giữ `socket.io` (server)** | Mở `/dashboard` → WebSocket kết nối, sự kiện realtime hoạt động |
| DP2 | `chart.js` | Frontend dùng bản vendor `public/js/vendor/chart.umd.min.js` | 0 import npm | 🟢 Thấp | Mở `/dashboard` → biểu đồ vẽ |
| DP3 | `dexie` | Frontend dùng `public/js/vendor/dexie.min.js` (v4) — nhưng `views/driver/sale.html:33` dùng **CDN dexie@3** → 2 phiên bản | 0 import npm | 🟡 Trung bình — **nên hợp nhất về 1 phiên bản** | Mở `/driver/ban-hang` → offline queue hoạt động |
| DP4 | `body-parser` | Express 4.18 đã có `express.json()` / `express.urlencoded()` | `server.js` dùng `bodyParser.json({limit:'10mb'})` | 🟡 Trung bình — cần giữ `limit:'10mb'` khi chuyển | Test upload payload > 1MB |
| DP5 | `ejs` | Có thể dead (xem §4.7) | `server.js` chỉ khai báo engine | 🟢 Thấp | Mở mọi trang → 200 OK |

**Không gỡ:** `better-sqlite3`, `compression`, `cookie-parser`, `express`, `express-rate-limit`, `helmet`, `node-cron`, `socket.io`, `winston`.

---

## 6. MODULE CÓ THỂ BỊ ẢNH HƯỞNG

| Module | File liên quan | Rủi ro khi xóa |
|---|---|---|
| Admin POS | `public/js/sales.js`, `views/sales.html` | Trung bình — nếu `api.js` thực sự được dùng gián tiếp |
| Dashboard | `views/dashboard.html`, `public/js/dashboard.js` | Thấp |
| Driver Portal | `views/driver/*`, `public/js/driver/*` | Cao — nhiều file trùng chức năng, dễ nhầm |
| Landing page | `public/landing.html`, `public/landing-assets/*` | Trung bình — xóa video ảnh hưởng UX |
| Sync / PWA | `public/sw.v2.js`, `public/sync.js`, `public/db.js` | Cao — không xóa `sw.js` trước khi sửa `login.js` |
| Realtime | `public/js/realtime.js`, `public/js/realtime-client.js` | Trung bình — xóa sai file sẽ mất realtime |
| Báo cáo | `routes/reportData.js`, `routes/report.js` | Thấp |
| Nhân viên sales | `routes/api/sales-staff.js`, `src/services/salesStaff.js` | Trung bình — liên quan migration 041 |

---

## 7. TEST CẦN CHẠY SAU MỦI THAY ĐỔI

### 7.1 Tự động

```bash
npm test                              # Jest + coverage
npm run lint                          # ESLint
npm run format:check                  # Prettier
node -e "require('./server.js')"      # smoke: server boot không lỗi require
```

### 7.2 Smoke test thủ công theo trang

| Trang | URL | Kiểm tra |
|---|---|---|
| Landing | `/` | Video phát, icon load, không 404 |
| Login admin | `/login` | Đăng nhập OK, SW register (Network tab: `sw.v2.js`) |
| Dashboard | `/dashboard` | KPI đúng, chart vẽ, WebSocket 1 kết nối duy nhất, realtime hoạt động |
| Bán hàng | `/sale` | Tạo đơn, giá theo bảng giá khách, KM quán mới, thưởng sản lượng |
| Khách hàng | `/customers` | Danh sách, tạo/sửa, đồng bộ offline |
| Chi tiết KH | `/customer/:id` | Công nợ, lịch sử, thống kê |
| Tồn kho | `/stock` | Nhập/xuất, không lỗi Dexie |
| Vỏ | `/kegs` | Thu/giao vỏ, số khớp |
| Nhập hàng | `/purchases` | Tạo phiếu nhập |
| Công nợ | `/report` → tab công nợ | Đối soát `customers.debt` vs tổng đơn chưa trả |
| Báo cáo | `/report` | Doanh thu không tính đơn đã hủy |
| Nhân viên sales | `/sales-staff` | Lương, hoa hồng |
| QR | `/qr-settings` | Thêm/sửa tài khoản QR |
| Driver login | `/driver` | Đăng nhập tài xế |
| Driver bán hàng | `/driver/ban-hang` | Tạo đơn, giá khách, KM |
| Driver giao hàng | `/driver/giao-hang` | Xác nhận giao, sai lệch, thu vỏ |
| Driver khách | `/driver/khach-hang` | Danh sách, thu tiền công nợ |
| Phiếu thu vỏ | `/driver/phieu-thu-vo` | Tạo, xem, xóa |
| API docs | `/api/docs`, `/api/openapi.yaml` | Load OK |
| Health | `/health` | 200 |

### 7.3 Test hồi quy nghiệp vụ (bắt buộc trước khi đụng nghiệp vụ)

```bash
# Bán chịu (hiện BROKEN — sau khi sửa §8 mới chạy được)
curl -X POST /api/sales -H 'Content-Type: application/json' \
  -d '{"customerId":1,"items":[{"productId":1,"quantity":10}],"debt":true}'

# Kiểm tra công nợ khớp
node -e "
const D=require('better-sqlite3');const db=new D('database.sqlite',{readonly:true});
console.log(db.prepare('SELECT customer_id, debt FROM customers WHERE debt>0').all());
console.log(db.prepare('SELECT customer_id, SUM(remaining_amount) r FROM order_debts GROUP BY 1').all());
"
# → 2 kết quả phải khớp

# Hủy đơn hoàn kho đúng 1 lần
curl -X DELETE /api/sales/<id>
curl -X DELETE /api/sales/<id>   # lần 2 phải trả "already deleted", không hoàn kho lần 2

# Không tính doanh thu đơn đã hủy
node -e "
const D=require('better-sqlite3');const db=new D('database.sqlite',{readonly:true});
console.log(db.prepare('SELECT COUNT(*) c FROM sales WHERE archived=1').get());
console.log(db.prepare('SELECT SUM(total) t FROM sales WHERE archived=0').get());
"
```

### 7.4 Test đồng bộ

1. Tắt mạng → tạo 1 đơn trên Driver Portal → đợi SW queue.
2. Bật mạng → quan sát SW sync → kiểm tra đơn có trong DB server **đúng 1 lần**.
3. Tạo đơn → reload server (PM2 restart) trong lúc queue chưa sync → sync lại → **không được nhân bản**.
4. Sửa đơn trên server rồi sync từ client cũ → phải báo conflict, không ghi đè.
5. Kiểm tra `GET /api/sync/status` trả 200 (hiện **500** — xem §8).

---

## 8. BẢNG SỬA LỖI (BUG FIX) — ĐỀ XUẤT RIÊNG

> Đây **KHÔNG phải** dead code, nhưng là P0 — cần sửa trước để hệ thống hoạt động đúng.
> Chi tiết phân tích: `docs/BEER_PROJECT_AUDIT.md` §6, §7, §8.

| # | File:Line | Lỗi | Sửa | Rủi ro | Test |
|---|---|---|---|---|---|
| B1 | `routes/api/promotions.js:922` | `require('./src/services/promotionCalc')` → path sai | → `require('../../src/services/promotionCalc')` | 🟢 | `npm test`; tạo thưởng hàng loạt |
| B2 | `routes/api/segments.js` | Thiếu `const db = require('../../database');` | Thêm 1 dòng | 🟢 | `npm test`; `GET /api/segments` → 200 |
| B3 | `routes/api/batch.js` | Thiếu `const db = require('../../database');` | Thêm 1 dộng | 🟢 | `npm test`; `POST /api/batch` → 200 |
| B4 | `routes/api/products.js:165` | `!price === undefined` luôn false | → `price === undefined` | 🟢 | POST giá thiếu → 400 |
| B5 | `routes/api/sales.js:815` | `GET /:id` shadow `GET /export` | Di chuyển `/export` lên **trên** `/:id` | 🟡 | `GET /api/sales/export` → 200 |
| B6 | `routes/api/customers.js:99` | `GET /:id` shadow `GET /alerts` | Di chuyển `/alerts` lên trên | 🟡 | `GET /api/customers/alerts` → 200 |
| B7 | `routes/api/promotions.js:176` | `GET /:id` shadow `GET /near-tier` | Di chuyển `/near-tier` lên trên | 🟡 | `GET /api/promotions/near-tier` → 200 |
| B8 | `routes/api/session.js:32` | `GET /:date` shadow `GET /check-migration` | Di chuyển `/check-migration` lên trên | 🟡 | `GET /api/session/check-migration` → 200 |
| B9 | `routes/api/sync.js:316,319,273,341` | Query `WHERE synced = 0/1` — column không tồn tại | Dùng `status` / `synced_at` theo schema thật | 🔴 | `GET /api/sync/status` → 200; `POST /api/sync/pull` → 200 |
| B10 | `database/migrations/048_missing_business_tables.js` (MỚI) | 3 bảng thiếu: `debt_transactions`, `customer_segments`, `delivery_schedules` | Migration idempotent `CREATE TABLE IF NOT EXISTS` | 🔴 | `npm test`; bán chịu; thu tiền; `GET /api/segments` |
| B11 | `database/migration.js:577` | Version gate skip migration (`2026090202.0 >= 2026041602`) | Nâng `BUSINESS_FEATURES_VERSION` hoặc bỏ gate (migration idempotent) | 🔴 | Kiểm tra 3 bảng tồn tại sau restart |
| B12 | `routes/api/customers.js` + `database.js` | `customers.segment_id` không tồn tại | Thêm cột (idempotent, trong migration 048) | 🔴 | `GET /api/segments/:id` → 200 |
| B13 | `public/sw.v2.js:401` + `public/sync.js:699` | Xóa toàn bộ queue sau POST, kể cả item failed | Chỉ xóa item có `results[].success === true` | 🔴 | Test offline → online (mục 7.4) |
| B14 | `routes/api/sync.js:9` | Idempotency chỉ in-RAM 60s | Thêm bảng `sync_dedup(sync_id PK, created_at)` | 🟡 | Restart server giữa lúc sync → không nhân bản |
| B15 | `views/dashboard.html:56`, `views/sales.html:369` | Load `realtime-client.js` + `layout.js`(→`realtime.js`) → **2 socket** | Bỏ `<script src="/js/realtime-client.js">` | 🟢 | DevTools → Network → 1 WS connection |
| B16 | `public/js/login.js:193` | Register `/sw.js` (bản cũ) | → `/sw.v2.js` | 🟢 | DevTools → Application → SW đúng version |
| B17 | `middleware/auth.js:55`, `routes/api/sync.js:12` | `setInterval` không `unref()` | Thêm `.unref()` (như `middleware/cache.js:25`) | 🟢 | Không đổi hành vi |
| B18 | `routes/api/products.js:165` | (đã ở B4) | — | — | — |
| B19 | Git history | Secret đã commit (`*.pem`, `pass.txt`, `*_deploy_key*`) | `git rm --cached` + **rotate key** + cân nhắc `git filter-repo` | 🟡 | `git ls-files \| grep -E 'pem\|pass.txt'` → rỗng |
| B20 | `src/services/saleDelete.js:160,178,205,277` | `console.log` thay `logger` | Đổi sang `logger.info` | 🟢 | `npm test` |

---

## 9. THỨ TỰ THỰC HIỆN ĐỀ XUẤT

```
B0  Baseline: backup DB + git tag + npm test
 │
 ├─ PR 1  Bug fix không đụng schema      → B1,B2,B3,B4,B15,B16,B17,B20
 ├─ PR 2  Route shadow fix               → B5,B6,B7,B8
 ├─ PR 3  Xóa dead file (frontend)      → F1..F20,F23(?)
 ├─ PR 4  Xóa function chết             → FN1..FN17
 ├─ PR 5  Gỡ dependency                  → DP1,DP2,DP4,DP5
 ├─ PR 6  Secret hygiene                 → B19
 ├─ PR 7  Migration bảng thiếu + sync    → B9,B10,B11,B12,B13,B14  ⚠️ CẦN BACKUP + ROLLBACK
 ├─ PR 8  Đồng bộ & realtime             → B13,B14,B15
 └─ PR 9  Tái cấu trúc (giai đoạn sau)   → D1,D2,D7,D9 — tách riêng, test snapshot
```

**Ưu tiên tuyệt đối:** PR 1–6 an toàn, revert được bằng 1 lệnh. PR 7 cần backup DB + rollback script + deploy giờ traffic thấp.

---

## 10. ROLLBACK

| Loại thay đổi | Cách rollback |
|---|---|
| Xóa file | `git revert <commit>` hoặc `git checkout <tag> -- <file>` |
| Sửa code | `git revert <commit>` |
| Thêm bảng DB | `DROP TABLE <ten_bang_moi>;` — chỉ an toàn khi bảng rỗng; script rollback trong file migration |
| Thêm cột | `ALTER TABLE ... DROP COLUMN` (SQLite ≥ 3.35) hoặc restore từ backup |
| Đổi query sync | `git revert` + `VACUUM INTO` backup trước khi deploy |
| Rotate secret | Giữ key cũ song song 24h trước khi thu hồi |

**Backup DB bắt buộc trước PR 7+:**
```bash
node -e "const D=require('better-sqlite3');const db=new D('database.sqlite');db.exec(\"VACUUM INTO 'backup/pre_pr7.sqlite'\");db.close()"
```

---

## 11. CHECKLIST NGHIỆM THU

- [ ] `git grep "/js/api.js"` → 0 hit
- [ ] `git grep numeric-keypad` → 0 hit
- [ ] `git grep segmentation` → 0 hit
- [ ] `git grep "components/common"` → 0 hit
- [ ] `npm test` → pass (không có test mới fail)
- [ ] `npm run lint` → 0 error
- [ ] `GET /api/sync/status` → 200
- [ ] `POST /api/sync/pull` → 200
- [ ] Bán chịu (`debt=true`) → tạo đơn thành công, `customers.debt` tăng, `order_debts` có row
- [ ] Thu tiền công nợ → `customers.debt` giảm đúng, `payments` có row
- [ ] `GET /api/segments` → 200
- [ ] `GET /api/sales/export` → 200
- [ ] `GET /api/customers/alerts` → 200
- [ ] `GET /api/promotions/near-tier` → 200
- [ ] `GET /api/session/check-migration` → 200
- [ ] DevTools → Network → **1** WebSocket connection trên `/dashboard`
- [ ] `public/` giảm từ 102.3 MB → < 40 MB
- [ ] `git ls-files | grep -E 'pem$|pass\.txt|_deploy_key'` → rỗng
- [ ] `PRAGMA integrity_check` → ok
- [ ] `PRAGMA foreign_key_check` → none
- [ ] Số đơn trước/sau cleanup: không đổi
- [ ] Tổng doanh thu trước/sau cleanup: không đổi

---

**Tóm tắt:** 25 file + 17 function + 5 dependency có thể xóa/gỡ với bằng chứng cụ thể. 6 file cần điều tra thêm trước khi quyết định. 20 lỗi bug (B1–B20) cần sửa — trong đó 4 lỗi P0 đang làm hỏng chức năng cốt lõi.

---

## 12. KẾT QUẢ THỰC THI

> Branch: `cleanup/audit-2026-11-12` · Ngày: 2026-11-12 · Tất cả PR1–PR8 đã merge vào branch.

### 12.1 Danh sách commit

| Commit | Nội dung |
|---|---|
| `98dd984` | PR1 — fix P0 bug (B1,B2,B3,B4,B15,B16,B17,B20) + PR2 route shadow (B5,B6,B7,B8) |
| `192fcbd` | PR3 — xóa dead frontend assets + orphan migration (F1–F22) |
| `9057e2f` | PR4–PR7 — dead functions, deps, secret hygiene, migration 048 + sync fixes |
| `53bd4d2` | B14 — idempotency key persist qua `sync_dedup` |
| `28d3eed` | Chuyển `b7`/`b18` từ script sang Jest suite |
| `7e8766e` | Tách DB test khỏi DB vận hành (`tests/setup.js` + `globalTeardown.js`) |
| `e155645` | `DISABLE_BACKGROUND_JOBS` + `scripts/cleanup-test-data.js` |
| `HEAD` | PR8 — dead assets/deps còn lại + 5 script test gốc → Jest |

### 12.2 Bug đã sửa (B1–B20)

| # | Trạng thái | Ghi chú |
|---|---|---|
| B1 | ✅ | `routes/api/promotions.js` — require path đúng |
| B2, B3 | ✅ | Thêm `const db = require('../../database')` vào `segments.js`, `batch.js` |
| B4, B18 | ✅ | `price === undefined \|\| price === null` |
| B5–B8 | ✅ | `/export`, `/alerts`, `/near-tier`, `/check-migration` chuyển lên trên `/:id` |
| B9 | ✅ | `synced` → `status` / `synced_at` |
| B10–B12 | ✅ | Migration 048 + `businessTablesPresent()` bypass version gate |
| B13 | ✅ | `sw.v2.js` + `sync.js` chỉ xóa item trong `applied[]` |
| B14 | ✅ | Bảng `sync_dedup` — idempotency sống sót qua restart server |
| B15 | ✅ | Bỏ `<script src="/js/realtime-client.js">` khỏi dashboard + sales |
| B16 | ✅ | `login.js` register `/sw.v2.js` |
| B17 | ✅ | `.unref()` cho interval cleanup (auth + sync) |
| B19 | ✅ | `git rm --cached` 9 file secret; `SESSION_SECRET` từ env |
| B20 | ✅ | `console.log` → `logger.info/warn` |

### 12.3 File đã xóa

| Nhóm | Số file | Ghi chú |
|---|---|---|
| Frontend JS dead | 10 | `api.js`, `empty-state.js`, `numeric-keypad.js`, `segmentation.js`, `debts-promotions.js`, `delivery.js`, `report.js`, `driver/delivery.js`, `driver/sale.js`, `realtime-client.js` |
| Component/CSS dead | 11 | `components/common/*` (5), `components/shell/app-shell.html`, `components/ui/*.css` (4), `css/ui-components.css` |
| Asset nặng | 3 | `beer.mp4` (61MB), `beer-web.mp4` (14MB), `product-yellow-pet.png` |
| Migration orphan | 2 | `041_sales_staff.js`, `042_sale_time.js` |
| SW cũ + store | 2 | `public/sw.js` (26KB), `src/store/index.js` (314 dòng) |
| Script test gốc | 5 | `test_promotion.js`, `test_integration.js`, `test_edge_cases.js`, `test_full_flow.js`, `test_first_month_reward.js` → chuyển thành 5 Jest suite |

**`public/` giảm 102.3 MB → 26.34 MB** (mục tiêu < 40 MB ✅)

### 12.4 Dependency đã gỡ

| Package | Lý do |
|---|---|
| `socket.io-client` | Frontend dùng `/socket.io/socket.io.js` do server serve |
| `chart.js` | Dùng vendor bundle `public/js/vendor/chart.umd.min.js` |
| `dexie` | Dùng vendor bundle `public/js/vendor/dexie.min.js` (v4) |
| `body-parser` | Express 4.18 đã có `express.json()` — giữ nguyên `limit: '10mb'` |
| `ejs` | 0 `res.render`, 0 cú pháp `<%` trong views |
| `tailwindcss`, `@tailwindcss/cli`, `postcss`, `autoprefixer` | `tailwind.css` không view nào load; utility class đã định nghĩa trong `unified.css` |

Còn lại (production): `better-sqlite3`, `compression`, `cookie-parser`, `dotenv`, `express`, `express-rate-limit`, `helmet`, `node-cron`, `socket.io`, `winston`.

### 12.5 Việc ngoài kế hoạch (phát sinh khi thực thi)

| # | Vấn đề | Cách xử lý |
|---|---|---|
| N1 | Jest ghi thẳng vào `database.sqlite` (7 đơn + 138 user test lọt vào DB thật) | `tests/setup.js` clone DB vào thư mục tạm; `tests/globalTeardown.js` dọn |
| N2 | `node-cron` giữ event loop → script CLI không thoát | `DISABLE_BACKGROUND_JOBS=1` trong `database.js` |
| N3 | `tests/b7`, `tests/b18` gọi `process.exit()` → Jest bị hủy | Viết lại thành suite chuẩn |
| N4 | Migration 004 tạo bảng trong `database/database.sqlite` (file riêng) thay vì DB đích | `runMigration(targetDb)` nhận DB instance |
| N5 | `formatRewardLabel` bị xóa ở PR4 nhưng `test_promotion.js` vẫn dùng | Khôi phục hàm (có test bao phủ) |
| N6 | `test_promotion.js` có 3 kỳ vọng cũ không khớp logic SSOT hiện tại | Cập nhật kỳ vọng theo `promotionCalc.js` (MIXED giữ 20L của loại đạt mốc) |

### 12.6 Kết quả kiểm chứng

| Kiểm tra | Kết quả |
|---|---|
| `npx jest` | ✅ **15 suite / 313 test pass** (trước: 10 suite / 235 test) |
| `npx eslint` | 1586 → 1595 problems (chênh lệch do file mới; các file mới sạch) |
| Smoke test server | ✅ 14/14 route trả đúng status (200) + login admin OK |
| `PRAGMA integrity_check` | ✅ ok |
| `PRAGMA foreign_key_check` | ✅ none |
| Số đơn trước/sau cleanup | ✅ Không đổi: **474 đơn / 774.719.014 đ** |
| DB vận hành sau khi chạy test | ✅ Không bị test đụng vào (0 sales test, 0 app_user test) |
| `git ls-files \| grep -E 'pem$\|pass\.txt\|_deploy_key'` | ✅ rỗng |
| `public/` size | ✅ 26.34 MB |

### 12.7 Việc còn lại — ĐÃ XỬ LÝ (vòng deploy/rotate 2026-11-12)

| # | Việc | Trạng thái | Chi tiết |
|---|---|---|---|
| R1 | **Rotate secret đã lỗi thời** | ✅ Hoàn tất | `ADMIN_PASSWORD` (đã đổi lại theo yêu cầu user 2026-11-13 — xem §12.10 R6), `SESSION_SECRET`, `JWT_SECRET`, `GITHUB_WEBHOOK_SECRET` (server + GitHub webhook config). SSH key `cursor_deploy_key` (đã commit) **đã thu hồi** khỏi `authorized_keys`, thay bằng `beer_prod_ed25519` (fingerprint `SHA256:38Djal0+…`). `deploy.sh` sửa để không cài lại key bị lộ. |
| R2 | Deploy lên production | ✅ Hoàn tất | Merge `cleanup/audit-2026-11-12` → `main` (merge commit `8cc9849`), push → GitHub webhook auto-deploy. Server HEAD = `aa90d70`. |
| R3 | Smoke test theo trang (§7.2) | ✅ Tự động | `scripts/smoke-test.js` (local) + `scripts/ops/smoke-prod.sh` (production): **48 route/asset PASS, 0 FAIL**. |
| R4 | `git filter-repo` lịch sử | ✅ Hoàn tất | Xoá 9 file secret khỏi toàn bộ lịch sử + thay giá trị secret trong file text. Force-push cả 3 branch + 5 tag. `scripts/ops/scan-history-secrets.py` → **SẠCH** (0 path, 0 giá trị, 0 private key). |
| R5 | Rác vận hành ở root | ✅ Hoàn tất | `.gitignore` bổ sung ~150 pattern scratch; xoá `server-backup.sh` trùng lặp ở root; còn 0 file untracked ở root. |

### 12.8 Phát hiện thêm trong vòng deploy (đã xử lý)

| Vấn đề | Mức độ | Xử lý |
|---|---|---|
| `cursor_deploy_key` (đã commit vào repo **public**) vẫn là key root hợp lệ trên production | 🔴 P0 | Sinh `beer_prod_ed25519`, thêm vào `authorized_keys`, xác minh, **xoá key cũ**. Sửa `deploy.sh` (bước 0.5/0.6) để từ chối + thu hồi key bị lộ. Đổi `~/.ssh/config` trỏ sang key mới. |
| `GITHUB_WEBHOOK_SECRET` nằm trong `deploy/GITHUB_WEBHOOK_SETUP.md` (tracked) | 🔴 Cao | Thay bằng placeholder + hướng dẫn đọc từ server. Rotate trên server **và** GitHub webhook config (qua API). |
| `ADMIN_PASSWORD` (giá trị cũ) nằm trong `pass.txt` (lịch sử) + `deploy/.env.production` + 3 script root | 🔴 Cao | Xoá khỏi tất cả file tracked, bỏ hardcode trong script (dùng SSH alias), rotate trên production. |
| `SESSION_SECRET` thiếu hoàn toàn trong `.env` production | 🟡 Trung bình | Thêm bằng giá trị random 32 bytes (ecosystem.config.js yêu cầu khi `NODE_ENV=production`). |
| `JWT_SECRET` = placeholder `CHANGE_THIS_TO_A_RANDOM_SECRET_32_CHARS` | 🟡 Trung bình | Rotate random 32 bytes. |
| 2 tài khoản debug (`tmp_verify_01`, `prod_verify_452586`) + 1 session orphan trên production | 🟡 Trung bình | Xoá `app_users`, `auth_sessions`, `driver_staff`, `driver_monthly_salary` liên quan. `foreign_key_check` → 0. |
| Script `.sh` commit trên Windows chạy lỗi CRLF trên VPS | 🟡 Trung bình | `.gitattributes` (`*.sh text eol=lf`) + `fix_eol.py` + commit normalize 100 file. |
| `deploy-state.json` luôn `status: running` sau deploy | 🟢 Thấp | Hành vi có sẵn từ trước (không phải hồi quy) — chưa xử lý. |

### 12.9 Trạng thái production sau vòng xử lý

```
git HEAD              : 1786eba (main, đồng bộ GitHub)
PM2                   : beer-pos online (restart #22)
health                : 200
sales_active          : 782        (không đổi)
sales_total           : 909        (không đổi)
customers             : 38         (không đổi)
revenue               : 1.310.086.014 đ   (không đổi)
products              : 5          (không đổi)
app_users             : 1          (giaohang01 — tài xế thật)
PRAGMA integrity_check: ok
PRAGMA foreign_key_check: 0 rows
smoke test            : 100% PASS / 0 FAIL
Jest                  : 15 suite / 313 test pass
history secret scan   : SẠCH
```

### 12.9b Smoke test thủ công bằng trình duyệt (2026-11-12, R3b)

| Hạng mục | Kết quả |
|---|---|
| Đăng nhập admin (`admin` / mật khẩu mới) tại `admin.biatuoitayninh.store/login` | ✅ Chuyển hướng `/` → dashboard, dữ liệu render (`todayRevenue` 13.360.000đ, `kegTotal` 4004, `recentSales`, chart) |
| WebSocket / Socket.IO | ✅ `connected: true`, socket id cấp, BroadcastChannel hỗ trợ, 0 event pending |
| Dexie / IndexedDB | ✅ `BeerPOS` version **450** |
| Service Worker | ✅ Đăng ký tại `/sw.js`, nội dung khớp `sw.v2.js`, cache stale đã được dọn |
| Cache | ✅ Chỉ còn `beer-pos-v45` (cache `v44` cũ đã bị xoá) |
| 12 route chính (`/`, `/sale`, `/customers`, `/stock`, `/report`, `/devices`, `/delivery`, `/expenses`, `/promo-settings`, `/qr-settings`, `/sales-staff`, `/customers/23`) | ✅ 200 OK |
| Public portal `biatuoitayninh.store` | ✅ Landing page render đầy đủ; `/login` → redirect về landing (đúng thiết kế) |
| Driver portal `giaohang.biatuoitayninh.store/driver` | ✅ 200; `/api/driver/me` → 401 (đúng — chưa login) |
| Asset đã xoá (`/css/tailwind.css`, `/css/styles.css`, `/landing-assets/beer-web.mp4`) | ✅ 404 đúng như thiết kế |

### 12.8b Lỗi phát hiện & sửa trong vòng verify thủ công

| Vấn đề | Mức độ | Xử lý |
|---|---|---|
| `/sw.js` trả **302 redirect** → Chrome chặn SW script sau redirect (`The script resource is behind a redirect, which is disallowed`) → SW đã đăng ký ở `/sw.js` **không bao giờ update được**, cache cũ `beer-pos-v44` tồn tại song song với `v45` | 🔴 Cao | `server.js`: `/sw.js` giờ trả **200 + nội dung `sw.v2.js`** (`Cache-Control: no-store`) thay vì redirect → SW cũ tự update, cache stale tự dọn ở `activate`. Thêm case kiểm tra vào `scripts/ops/smoke-prod.sh` (so sánh md5 `/sw.js` vs `/sw.v2.js`) + `scripts/smoke-test.js`. Commit `2397e53`, `1786eba`. |

### 12.10 Việc còn lại (cần người dùng)

| # | Việc | Ghi chú |
|---|---|---|
| R3b | ~~**Smoke test thủ công bằng trình duyệt**~~ | ✅ **Xong** (2026-11-12) — xem §12.9b. Phát hiện & sửa lỗi SW redirect (§12.8b). |
| R6 | **Lưu mật khẩu admin mới** | ✅ Đã đặt lại mật khẩu mạnh (24 ký tự, `secrets`-random, chỉ gồm `A-Za-z0-9-_.` để an toàn cho `.env`/shell) — **2026-11-13**. Giá trị chỉ nằm trong `.env` local + production, **không ghi vào git/docs** để tránh tái lộ. Mật khẩu cũ (từng lộ công khai) đã bị vô hiệu hóa và plaintext của nó đã được gỡ khỏi lịch sử git ở vòng filter-repo lần 2 (§12.11). |
| R7 | **Clone lại repo** | Lịch sử đã rewrite → máy khác cần `git clone` mới (không `git pull`). Cảnh báo người dùng khác đang clone. |
| R8 | **Kiểm tra quota Git LFS / repo size** | Force-push + rewrite không thu hồi được blob cũ trên GitHub ngay lập tức; blob cũ có thể còn trong cache/CDN của GitHub một thời gian. Nên liên hệ GitHub Support nếu cần xoá ngay. |

### 12.11 Vòng dọn lịch sử lần 2 (2026-11-13)

**Vấn đề phát hiện:** vòng filter-repo đầu tiên (2026-11-12) chạy **trước** khi các script tooling được thêm vào repo. Các file đó tự chứa plaintext secret làm "pattern đối chiếu", khiến 4 blob vẫn **reachable** từ refs:

| Blob | Path |
|---|---|
| `6011f77e…` | `scripts/ops/rewrite-history.sh` |
| `6d68c13e…` | `scripts/ops/secret-replacements.txt` |
| `9977fb9f…` | `scripts/ops/scan-history-secrets.py` |
| `5164154a…` / `cb615c3e…` | `deploy/deploy_bootstrap_key.pub` (đã untrack nhưng blob còn) |

**Nguyên tắc áp dụng:** mã hoá base64/hex **không phải** bảo mật — ai có file cũng giải mã được, và file đó vẫn nằm trong git history. Vì vậy danh sách secret được đưa **ra khỏi git hoàn toàn**.

| Thay đổi | Chi tiết |
|---|---|
| `scripts/ops/scan-history-secrets.py` | Viết lại: đọc danh sách từ file LOCAL `secret-fingerprints.local.json`; **chỉ quét blob reachable** (blob dangling không tính là leak vì đã prune khỏi lịch sử push); thêm mục "chuỗi hình dạng secret" để cảnh báo; tự dòng khi thiếu file local |
| `scripts/ops/secret-fingerprints.example.json` | Mẫu commit (không chứa giá trị thật) — hướng dẫn tạo file local |
| `scripts/ops/secret-fingerprints.local.json` | File LOCAL, `.gitignore` — chứa giá trị thật để quét |
| `scripts/ops/secret-replacements.local.txt` | File LOCAL thay cho `secret-replacements.txt` đã commit |
| `scripts/ops/secret-replacements.txt` | **Untrack** + xoá khỏi lịch sử (`--path … --invert-paths`) |
| `scripts/ops/rewrite-history.sh` | Bỏ hardcode secret trong vòng verify; đọc file local; dừng với lỗi rõ ràng nếu thiếu file local |
| `docs/BEER_CLEANUP_PLAN.md` | Gỡ mọi giá trị secret cụ thể khỏi tài liệu (chỉ giữ nhãn/mô tả) |
| `.gitignore` | Thêm `secret-fingerprints.local.json`, `secret-replacements.local.txt` |

**Kết quả vòng filter-repo lần 2**

| Kiểm tra | Kết quả |
|---|---|
| `git filter-repo` | ✅ 947 commit parse, lịch sử viết lại (SHA mới cho `main`) |
| `scan-history-secrets.py` (local repo) | ✅ **SẠCH** — 0 path đáng ngờ, 0 private key, 0 giá trị secret, 0 dangling blob |
| `git log --all -S "<secret>"` | ✅ 0 commit chứa bất kỳ giá trị secret nào |
| Clone sạch từ GitHub (`D:\Beer-verify-clone`) | ✅ HEAD = `fd13003`; scanner chạy trên clone → **SẠCH** |
| 3 branch remote (`main`, `cleanup/audit-2026-11-12`, `feature/driver-portal`) | ✅ Không branch nào chứa giá trị secret |
| 5 tag remote | ✅ Không tag nào chứa giá trị secret |
| Private key marker trong tag | ✅ **False positive** — `gen_key.js` chỉ chứa header PEM dạng string literal (script sinh key), không phải key thật. File này đã bị xoá khỏi `main`. |
| Tag `18/03/2026` | ⚠️ Trong lúc push, tag bị dời nhầm về HEAD → đã khôi phục đúng là annotated tag trỏ tới commit `7f2ec58` (khớp `fast-export.original`) |

---

## 13. TÍNH NĂNG MỚI — BÁO CÁO TỰ ĐỘNG QUA ZALO OA (2026-11-13)

### 13.1 Vấn đề giải quyết

Chủ xe phải mở máy tính, vào `/report`, chọn ngày, xem 4-5 tab — mỗi ngày mất nhiều phút và thường bị bỏ qua. Hệ thống **không có kênh báo cáo tự động nào**.

### 13.2 Thay đổi

| Hạng mục | Chi tiết |
|---|---|
| `database/migrations/049_daily_report_notify.js` | Bảng `report_notifications` (lịch sử gửi) + index; seed setting cho kênh báo cáo |
| `src/services/DailyReportService.js` | Tổng hợp số liệu ngày + render text (plain text, không HTML — Zalo/Telegram không parse HTML) |
| `src/services/NotificationService.js` | Adapter kênh: Zalo OA / Telegram Bot / Webhook (dùng `fetch` native Node 20, không thêm dependency) |
| `src/services/ReportNotifyService.js` | Điều phối: đọc config, chống gửi trùng, ghi lịch sử, `shouldRunNow()` cho cron |
| `routes/api/reportNotify.js` | API admin: `/config`, `/preview`, `/send`, `/history` (requireAdmin) |
| `views/report-notify.html` | Trang cấu hình (bật/tắt, giờ, kênh, xem thử, gửi ngay, lịch sử) |
| `server.js` | Cron `* * * * *` (giờ VN) — so sánh với `report_notify_time`; mount route API + trang |
| `views/dashboard.html` | Card "📨 Báo cáo tự động" trong hub Cài đặt hệ thống |

### 13.3 Quyết định thiết kế đáng chú ý

| Quyết định | Lý do |
|---|---|
| Token lưu trong bảng `settings` (DB), **không** trong `.env` | `.env` có thể lọt vào git; UI admin cho phép đổi token không cần restart server |
| API `GET /config` **không** trả về token | Chỉ trả `hasToken: true/false` — tránh lộ secret qua network tab |
| Sản lượng tính bằng `SUM(si.quantity)` với `products.type = 'keg'` | Khớp SSOT của `PromotionService` (mốc thưởng 300L = 300 bình) |
| Tồn vỏ rỗng đọc từ `keg_stats.empty_collected` | `keg_stats` là SSOT của module keg; `keg_ledger` chỉ là log giao dịch |
| Cron chạy **mỗi phút** + so sánh giờ | Cho phép đổi giờ gửi trong UI mà không cần restart PM2 |
| `hasSent()` chống gửi trùng theo `(report_date, channel)` | Cron có thể chạy lại (restart, deploy) → không gửi 2 lần cùng ngày |
| Mọi SQL JOIN đều có tiền tố bảng | `sales` và `products` đều có cột `type`/`archived` → "ambiguous column name" nếu không alias |

### 13.4 Nội dung báo cáo

Doanh thu (+ so sánh hôm qua / tuần trước) · Lợi nhuận gộp & chi phí · Lợi nhuận ròng · Số đơn & sản lượng · Giao/thu keg & tồn kho · Thu tiền & công nợ · Top sản phẩm · Top khách hàng.

### 13.5 Cách dùng

1. Vào **Dashboard → Cài đặt hệ thống → 📨 Báo cáo tự động**
2. Chọn kênh **Zalo OA** → dán **Access Token** (openapi.zalo.me → OA quản lý) và **user ID** người nhận (người đó phải đã nhắn tin cho OA ít nhất 1 lần)
3. Bật "Bật gửi tự động" + đặt giờ → **Lưu cấu hình**
4. Bấm **👁 Xem thử** để xem nội dung, **📤 Gửi ngay** để kiểm tra kênh đã cấu hình đúng chưa

### 13.6 Kiểm chứng

| Hạng mục | Kết quả |
|---|---|
| Jest | ✅ 16 suite / 340 test (thêm 27 test mới trong `tests/daily-report-notify.test.js`) |
| ESLint (file mới) | ✅ 0 lỗi |
| Smoke API (admin) | ✅ `/config` 200 · `/preview` 200 · `/send` 502 đúng khi thiếu token · `/history` ghi đúng lịch sử |
| Phân quyền driver | ✅ Driver nhận **403** ở cả 4 endpoint |
| Trình duyệt | ✅ `/report-notify` render đầy đủ, preview hiển thị đúng, card xuất hiện ở Dashboard |
| Cron | ✅ `shouldRunNow()` test đúng ở 21:30 / 21:29 / 21:31 / 00:00 / giờ sai định dạng |

**Lưu ý phát hiện khi verify:** các API admin cần `Authorization: Bearer` header (cookie `session_token` là `httpOnly` nên JS không đọc được). Trang mới dùng `authFetch()` sẵn có trong `public/js/auth.js` — tương thích với pattern của các trang khác.

---

## 14. TÍNH NĂNG MỚI — A4: SOCKET.IO AUTH & QUẢN LÝ PHIÊN (2026-11-13)

### 14.1 Vấn đề phát hiện khi rà soát

Rà soát toàn bộ luồng WebSocket phát hiện **3 lỗ hổng bảo mật nghiêm trọng** — không phải tính năng thiếu, mà là lỗi **đang tồn tại**:

| # | Vấn đề | Mức độ |
|---|---|---|
| 1 | **Socket.IO không xác thực** — `io.use()` chỉ log `has_token` rồi `next()` cho mọi client. Bất kỳ ai cũng kết nối được và nhận event nghiệp vụ. | 🔴 Cao |
| 2 | **Driver nhận dữ liệu tài chính** — `mode=driver` bị map thành room `admin`; thêm nữa mọi client đều join room `all` và `emitToAll` gửi payload **đầy đủ** (chứa `profit`, `total`) → tài xế nhận được lợi nhuận từng đơn. | 🔴 Nghiêm trọng |
| 3 | **`POST /auth/logout` trả 404** — `public/js/auth.js` gọi POST nhưng server chỉ có GET → session **không bị xoá** phía server, token vẫn hiệu lực 30 ngày, socket vẫn kết nối được. Đăng xuất không an toàn. | 🟠 Trung bình |

Ngoài ra client có 2 lỗi khiến tính năng "bật auth" sẽ hỏng ngay:
- `public/js/realtime.js` đọc key `auth_token` trong `localStorage`, nhưng ứng dụng thật dùng `beer_session_token` (admin) / `driver_session_token` (driver) → **token luôn null**.
- `window.APP_MODE` không bao giờ có giá trị `'driver'` → không phân biệt được Driver Portal.

### 14.2 Thay đổi

| Hạng mục | Chi tiết |
|---|---|
| `src/socket/socketAuth.js` | *(mới)* Module auth tách riêng: `extractToken`, `resolveSession`, `roomForRole`, `sanitizeForDriver`, `driverSalePayload`, `buildDriverOrderPayload` — test được không cần mở socket thật. Dùng **chung** `FORBIDDEN_FIELDS` với REST API |
| `src/socket/socketServer.js` | Handshake **bắt buộc** có session hợp lệ; room do **server** quyết định theo role trong DB; thêm room `driver`; **không còn ai join room `all`**; `emitToRoles()` sanitize payload cho tài xế; `ADMIN_ONLY_EVENTS` (expense/report) không gửi cho driver; client `PUBLIC` không nhận dữ liệu nghiệp vụ; `disconnectToken()` / `disconnectUser()` |
| `routes/api/sessions.js` | *(mới)* API admin: `GET /api/sessions` · `POST /api/sessions/:token/revoke` · `POST /api/sessions/revoke-all` |
| `views/sessions.html` | *(mới)* Trang quản lý phiên: xem thiết bị đang mở app, huỷ phiên từ xa, huỷ hàng loạt |
| `routes/login.js` | Thêm `POST /logout` (trước đây 404); cả GET và POST đều ngắt socket |
| `routes/driverAuth.js` | Logout tài xế cũng ngắt socket |
| `src/services/UserService.js` | `changePassword` / `setActive` → huỷ session + ngắt WebSocket |
| `public/js/realtime.js` | Đọc đúng key token (`driver_session_token` → `beer_session_token` → cookie); `APP_MODE` hỗ trợ `'driver'`; dừng reconnect khi bị `UNAUTHORIZED`; nghe `session:revoked` |
| `public/js/layout.js` | Nghe `realtime:session-revoked` / `realtime:unauthorized` → đưa người dùng về trang đăng nhập |
| `public/js/driver/core.js` | Nạp `realtime.js` cho **mọi** trang Driver Portal (trước chỉ trang Bán hàng); nghe `session:revoked` → về `/auth/driver` |
| `middleware/permissions.js` | Chặn driver ở `/api/sessions` và trang `/sessions`, `/report-notify` |
| `server.js` | Mount `/api/sessions` + route trang `/sessions` |
| `views/dashboard.html` | Card "🔐 Phiên đăng nhập" |
| `package.json` | Thêm `socket.io-client` (devDependency) để test tích hợp |

### 14.3 Quyết định thiết kế đáng chú ý

| Quyết định | Lý do |
|---|---|
| **Room do server quyết định**, không tin `mode` của client | Client có thể tự khai `mode=admin` để leo thang. Server đọc role từ DB → không thể spoof. |
| **Room `all` chỉ dùng cho tín hiệu điều khiển** | Trước đây `all` = admin + driver và nhận payload đầy đủ. Nay **không còn client nào join room `all`** — mọi event đi qua `emitToRoles()` / `broadcast()` để sanitize. |
| **Client `PUBLIC` không nhận dữ liệu nghiệp vụ** | Landing page không đăng nhập vẫn kết nối được socket (không vỡ trang), nhưng không nhận payload nghiệp vụ. |
| **Sanitize ở SERVER, không ở client** | Client không có quyền quyết định dữ liệu nào được nhìn thấy. |
| **Bảng `sales` rút gọn cho driver** (`DRIVER_SAFE_SALE_FIELDS`) | Driver cần id/số vỏ/đơn để làm việc, nhưng không cần `total`/`profit`/`note` nội bộ. |
| **`disconnectToken()` dùng `handshake.auth.token`** | Token không nằm trong DB query → so sánh O(1), không cần index phụ. |
| **Token trả về trong `GET /api/sessions`** | Admin cần token để huỷ phiên. Đây là hành vi chủ ý — admin đã có toàn quyền hệ thống. |
| **Không huỷ được chính phiên của mình** | Tránh admin tự khoá mình ra khỏi hệ thống bằng một click nhầm. |
| `mode=public` vẫn cho phép kết nối | Landing page / menu công khai không có dữ liệu nhạy cảm; chặn sẽ làm hỏng trang. |

### 14.4 Hành vi mới

| Tình huống | Trước | Sau |
|---|---|---|
| Client không token kết nối socket | ✅ được | ❌ `UNAUTHORIZED` |
| Tài xế nhận `order:created` | ✅ có `profit`, `total`, `note` | ❌ chỉ id/số vỏ/khách |
| Tài xế nhận `expense:created` / `report:updated` | ✅ có | ❌ không |
| Tài xế tự khai `mode=admin` | ✅ vào room admin | ❌ vẫn room driver |
| Admin huỷ phiên tài xế | ⛔ token vẫn sống | ✅ socket ngắt + token vô hiệu |
| Đổi mật khẩu tài xế | ⛔ phiên cũ vẫn dùng được | ✅ huỷ hết phiên + ngắt socket |
| Khoá tài khoản tài xế | ⛔ socket vẫn mở | ✅ ngắt ngay |
| Đăng xuất (POST /auth/logout) | ⛔ 404, token còn sống | ✅ xoá session + ngắt socket |

### 14.5 Kiểm chứng

| Hạng mục | Kết quả |
|---|---|
| Jest | ✅ **19 suite / 391 test** (thêm 51 test: 25 unit `socket-auth.test.js` + 16 tích hợp `socket-auth-integration.test.js` + 10 API `sessions-api.test.js`) |
| ESLint (file mới/sửa) | ✅ 0 lỗi (1 warning pre-existing ở `UserService.js`) |
| Smoke end-to-end (socket thật) | ✅ **26/26** — xác thực handshake, phân quyền room, sanitize payload, thu hồi phiên, `POST /auth/logout` |
| Trình duyệt thật (Chrome) | ✅ Socket admin tự kết nối; huỷ phiên → socket nhận `session:revoked` rồi bị ngắt; trang tự về `/login`; driver bị **403** ở `/sessions`; driver socket tự khai `mode=admin` vẫn vào room `driver` |
| Phân quyền driver | ✅ Driver **403** ở `/api/sessions`; socket driver không vào room admin |
| Tích hợp DB | ✅ session bị huỷ → `GET /api/driver/me` trả 401 |

### 14.6 Lỗ hổng bổ sung phát hiện khi verify (đã vá)

Trong lúc verify trên trình duyệt thật, phát hiện 3 vấn đề còn sót so với thiết kế:

| # | Vấn đề | Cách vá |
|---|---|---|
| 1 | **Room `all` vẫn còn tồn tại** — driver vẫn join room `all`. Dù `emitToRoles()` đã sanitize, nhưng bất kỳ code nào gọi `io.to(ROOMS.ALL).emit(...)` với payload thô là rò rỉ ngay. | **Không còn client nào join room `all`.** `emitToAll()` / `broadcast()` nay duyệt theo **socket** và tự sanitize cho tài xế. Test `không client nào join room legacy 'all'` chốt hành vi này. |
| 2 | **`broadcast()` gửi payload đầy đủ cho client `PUBLIC`** (chưa đăng nhập) — landing page công khai có thể nhận `profit`. | Bỏ qua socket `PUBLIC` trong `broadcast()` và `emitToAll()`. |
| 3 | **Hai bộ key nhạy cảm lệch nhau** — `socketAuth.js` có bộ riêng, thiếu `cost`, `totalCost`, `returned_profit`, `grossProfit`… so với `FORBIDDEN_FIELDS` của REST API. Rủi ro: thêm field mới vào REST mà quên WebSocket. | `socketAuth.js` nay **dùng chung** `FORBIDDEN_FIELDS` từ `middleware/permissions.js` + regex bổ sung. Một nguồn sự thật duy nhất. |

**Bài học rút ra:** kiểm tra bằng trình duyệt thật bắt được thứ mà unit test không bắt được — test chỉ kiểm chứng các đường đi đã viết, còn verify UI phát hiện được đường đi còn sót (`emitToAll` gọi từ code khác).

**Lưu ý vận hành:** `socket.io-client` được thêm vào `devDependencies` (chỉ dùng cho test). Client trình duyệt vẫn dùng `/socket.io/socket.io.js` do server serve (`serveClient: true`) — không thêm bundle nào vào production.
