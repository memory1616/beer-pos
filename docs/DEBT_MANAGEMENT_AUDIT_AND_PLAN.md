# BÁO CÁO AUDIT & KẾ HOẠCH TRIỂN KHAI — SỔ CÔNG NỢ GIA HUY (Debt Management)

> **Ngày audit:** 2026-11-13
> **Phạm vi:** repository `D:/Beer` (branch `main`, HEAD `66d1927`)
> **Nguyên tắc:** CHỈ ĐỌC + BACKUP. **CHƯA sửa source code, CHƯA sửa schema, CHƯA chạy migration.**
> **Backup đã tạo:** `backups/pre_debt_20261113_163213/` (database.sqlite + wal + shm + git_commit.txt + git_status.txt)

---

## 0. TÓM TẮT ĐIỀU HÀNH (Executive Summary)

| Hạng mục | Kết luận |
|---|---|
| Hệ thống công nợ hiện có | **CÓ**, nhưng là mô hình "số dư trên khách" (1 trường `customers.debt`), **không có sổ cái (ledger)** |
| Bảng `order_debts` / `debt_transactions` | Đã tồn tại trong schema nhưng **đang rỗng (0 dòng)** → chưa từng được dùng thật |
| Nguồn sự thật hiện tại | `customers.debt` — **nhập tay**, không gắn với đơn hàng |
| Tổng công nợ đang ghi nhận | **12.577.000đ** trên 25 khách (chỉ 6 khách có nợ > 0) |
| Trigger ghi nợ hiện tại | `DebtService.createDebt()` gọi lúc **TẠO ĐƠN** (`routes/api/sales.js:520`), không phải lúc giao hàng |
| UI bán hàng | **Không gửi cờ `debt`** khi tạo đơn (`public/js/sales.js:1803-1812`) → hiện tại hầu như **không ghi nợ tự động** |
| Trạng thái giao hàng | `delivery_records` = 0 dòng, `sales.delivery_status` = NULL toàn bộ 575 đơn → **chưa có dữ liệu DELIVERED** trên DB local |
| Xác thực / RBAC | `middleware/auth.js` (session trong SQLite) + `middleware/permissions.js` (chặn DRIVER theo whitelist path). **Chưa có role STAFF/CUSTOMER** |
| Nhân viên | `app_users` = **0 dòng** trên DB local (chỉ có ADMIN từ `.env`); `sales_staff` = 7 dòng (đều `active=0` trừ 1) |
| Zalo cá nhân (không OA) | **KHÔNG CÓ API bot chính thức.** Zalo Desktop chạy, nhưng: không có cổng listener, DB tin nhắn **mã hoá + khoá file**, không có cơ chế lấy `groupId`/`senderId` một cách hợp lệ → **đánh dấu NOT_AVAILABLE** |
| Zalo OA | Đã có OAuth v4 + gửi tin CS (migration 052). Nhưng yêu cầu **"không dùng OA"** → không dùng cho module này |
| Đồng bộ client | `public/db.js` (Dexie) + `public/sync.js` **không** đồng bộ bảng công nợ → không cần đụng vào |
| Ưu tiên triển khai | Sửa **thêm** (additive) song song, **không phá** luồng POS hiện tại |

> ⚠️ **Kết luận quan trọng:** Yêu cầu "Beer POS là Single Source of Truth" **không thực sự đúng ở thời điểm hiện tại** — số dư công nợ đang là dữ liệu nhập tay, không truy vết được. Bước triển khai đúng là **dựng sổ cái (ledger) làm nguồn sự thật mới**, rồi **migrate số dư hiện có vào `openingBalance`** để không mất tiền.

---

## 1. AUDIT HỆ THỐNG HIỆN TẠI

### 1.1 Công nghệ & kiến trúc

| Tầng | Công nghệ |
|---|---|
| Runtime | Node.js 20 (CommonJS) |
| Server | Express 4 — `server.js` (~1220 dòng) |
| DB | SQLite qua `better-sqlite3` 9.4 — **WAL**, `foreign_keys=ON`, SQLite 3.45.3 |
| Migration | `database/migration.js` — orchestrator version-gated + các file `database/migrations/0XX_*.js` chạy **độc lập** (043→052) |
| Realtime | Socket.IO 4 (`src/socket/socketServer.js`) |
| Auth | Session token lưu bảng `auth_sessions`, cookie HttpOnly `session_token` (admin) / `driver_session_token` (driver) |
| RBAC | `middleware/permissions.js` — whitelist path cho DRIVER + sanitize field tài chính |
| Test | Jest 29 + supertest; `tests/setup.js` copy DB ra `%TEMP%\beer-tests\` cho mỗi file |
| Deploy | PM2, nginx, Git post-receive hook |

### 1.2 Cấu trúc thư mục liên quan

```
database.js                      # mở DB + chạy migration + helper getVietnamDateStr/TimeStr
database/migration.js            # orchestrator (runMigrations + runXXXMigration 043..052)
database/migrations/0XX_*.js     # 043 driver_portal … 052 zalo_oa_oauth_v4
src/services/
  DebtService.js                 # ⚠️ core hiện tại của công nợ
  DeliveryService.js             # lifecycle giao hàng (PENDING→IN_PROGRESS→DELIVERED→DISCREPANCY)
  NotificationService.js         # adapter kênh: zalo OA / telegram / webhook
  ZaloOAuthService.js            # OAuth v4 (PKCE) — dùng cho OA, KHÔNG dùng cho Zalo cá nhân
  AuditLogService.js             # nhật ký thao tác chung (audit_logs)
  DriverStaffService.js, DriverSalaryCalculator.js
routes/api/
  debts.js                       # API công nợ (admin) — 8 endpoint
  payments.js                    # API thu tiền (legacy, ghi thẳng customers.debt)
  sales.js                       # tạo/sửa/xoá đơn (có gọi DebtService)
  driver.js                      # Driver Portal (giao hàng, thu tiền tại điểm giao)
  driverSale.js                  # forward sang routes/api/sales.js
  customers.js                   # CRUD khách (debt là field nhập tay)
middleware/auth.js, permissions.js, auditLog.js, validation.js, cache.js, errorHandler.js
views/                           # HTML tĩnh (dashboard, customers, customer-detail, audit-log…)
public/js/                       # JS client (sales.js, customers.js, layout.js…)
tests/                           # 20 file test
```

### 1.3 Schema công nợ hiện tại (đọc từ SQLite runtime)

```sql
-- customers (nguồn sự thật HIỆN TẠI của số dư nợ)
debt REAL DEFAULT 0,          -- ⭐ số dư nợ, nhập tay từ màn Khách hàng / Sửa đơn
deposit REAL DEFAULT 0, keg_balance INTEGER DEFAULT 0, archived INTEGER DEFAULT 0

-- order_debts (⚠️ ĐANG RỖNG — 0 dòng)
id, sale_id FK→sales, customer_id FK→customers,
original_amount, paid_amount, remaining_amount, status('pending'|'partial'|'paid'), due_date

-- debt_transactions (⚠️ ĐANG RỖNG — 0 dòng)
id, customer_id FK, type('increase'|'decrease'|'adjust'|'cancel'),
amount, balance_before, balance_after, sale_id FK, payment_id FK, note, created_at

-- payments (5 dòng — toàn bộ là test cũ của 1 khách)
id, customer_id FK, amount, date, note, uuid, created_at, version, deleted

-- sales
total, type('sale'|'replacement'|'gift'), status('completed'|'returned'),
payment_status('unpaid'|'partial'|'paid'),  -- ⚠️ 575/575 đều = 'unpaid'
delivery_status,               -- ⚠️ 575/575 đều = NULL
archived, deleted, promo_type, promo_free_liters, driver_username, uuid, version
```

**Vận hành hiện tại của `DebtService`:**

| Method | Ngữ nghĩa | Vấn đề |
|---|---|---|
| `createDebt(customerId, amount, saleId, note)` | +nợ, ghi `debt_transactions(type='increase')` + `order_debts`, update `customers.debt` | Gọi lúc **tạo đơn**, không kiểm tra `amount` = tiền khách còn phải trả; chặn bởi `max_debt_per_customer` |
| `payDebt(customerId, amount, note, saleId)` | −nợ, ghi `payments` + `debt_transactions(type='decrease')`, phân bổ vào `order_debts` | `appliedAmount = min(amount, balance)` → **âm ẩn** phần tiền khách trả nhiều hơn nợ (mất dấu vết) |
| `adjustDebt(customerId, amount, reason)` | ± điều chỉnh | Không có `source`/người thực hiện/idempotency |
| `reverseDebtForSale(saleId)` | Hoàn nợ khi xoá đơn | **`DELETE FROM order_debts`** → mất dấu vết bút toán gốc (vi phạm yêu cầu "không xoá vật lý") |
| `recalcDebt(customerId)` | Đối soát `SUM(order_debts.remaining)` vs `customers.debt` | Chỉ so 2 nguồn, không so với đơn hàng |
| `getAllDebts / getCustomerDebt / getSalePayments` | Truy vấn báo cáo | Dựa trên `customers.debt` |

### 1.4 Lifecycle đơn hàng & giao hàng (đọc `DeliveryService.js`)

```
routes/api/sales.js POST /api/sales
   └─ tạo sales (type='sale') trong transaction
   └─ DebtService.createDebt(...)  ← ⚠️ GHI NỢ TẠI ĐÂY (nếu body.debt=true)
   └─ DeliveryService.ensureRecord(saleId, driverUsername)  → delivery_records status=PENDING
   └─ socket emitOrderAssigned + WebPush

routes/api/driver.js PATCH /api/driver/deliveries/:id/status
   └─ DeliveryService.updateStatus(id, 'DELIVERED', username)
   └─ UPDATE delivery_records.status + UPDATE sales.delivery_status

routes/api/driver.js POST /api/driver/deliveries/:id/confirm
   └─ DeliveryService.confirmDelivery(id, username, {items, collectedKegs})
   └─ tx: cập nhật items (delivered/missing/excess/damaged)
   └─ nextStatus = DISCREPANCY nếu có sai lệch, ngược lại DELIVERED
   └─ UPDATE delivery_records + UPDATE sales.delivery_status
   └─ syncCollectedKegs(...)
```

**Ma trận chuyển trạng thái hợp lệ:**
```
PENDING      → IN_PROGRESS | DELIVERED | FAILED
IN_PROGRESS  → DELIVERED | FAILED | PENDING
DELIVERED    → DISCREPANCY            (⚠️ không quay lại DELIVERED trực tiếp)
FAILED       → PENDING | IN_PROGRESS | DISCREPANCY
DISCREPANCY  → IN_PROGRESS | DELIVERED
```

→ **Điểm móc duy nhất để ghi `ORDER_DEBT`** là khi `nextStatus === 'DELIVERED'` (nằm trong `confirmDelivery` và `updateStatus`). Đây là 2 chỗ cần hook, và phải **idempotent** vì webhook gửi lại / driver bấm 2 lần là hiện có.

### 1.5 Xác thực & phân quyền

- `middleware/auth.js`: `login()` → ADMIN từ `.env` (`ADMIN_USER`/`ADMIN_PASSWORD`) **hoặc** `app_users` (role `ADMIN`/`DRIVER`). Session lưu `auth_sessions(token, username, role, app_user_id, expires_at)`.
- `middleware/permissions.js`:
  - `DRIVER_ALLOWED_API_PREFIXES = ['/api/driver', '/api/auth/me', '/api/ping', '/api/discover', '/api/push']`
  - `DRIVER_DENIED_PATH_PREFIXES` gồm **`/api/debts`**, `/api/payments`, `/api/sales`, `/api/customers`…
  - `attachSanitizer` gỡ field tài chính (`profit`, `cost_price`, `total`…) khỏi response của DRIVER.
- **Không có role `STAFF` hay `CUSTOMER`.** → cần mở rộng: role `STAFF` (nhân viên phụ trách) hoặc dùng `app_users.role='DRIVER'` + bảng phân quyền riêng.
- `middleware/auditLog.js` ghi `audit_logs` tự động cho mọi route MUTATION (`POST/PUT/PATCH/DELETE`), suy ra `entity` từ prefix (`/api/debts` chưa có trong `ENTITY_MAP` → sẽ map `payment`/`sale`; **cần thêm**).

### 1.6 Đồng bộ server/client

- Client: `public/db.js` (Dexie) có bảng `orders_queue`, `products`, `customers`… — **không có bảng công nợ**.
- `public/sync.js` / `routes/api/sync.js`: `ENTITY_TO_TABLE` chỉ có `customer|product|sale|expense|payment|keg_transaction`.
- → **Công nợ không đi qua đường đồng bộ PWA** ⇒ thay đổi schema `debt_*` **không ảnh hưởng** luồng offline của POS.

### 1.7 Kiểm tra dữ liệu hiện có (read-only)

| Kiểm tra | Kết quả |
|---|---|
| `SUM(customers.debt)` (archived=0) | **12.577.000đ** / 25 khách còn hoạt động |
| Khách có `debt > 0` | 6 (A Công Gò Chai 3.385.000; Tuấn Khanh 2.172.000; Chị Dung 1.080.000; Anh Nhơn 2.850.000; Chị Nhàn 1.290.000; Xiên Que 1.800.000) |
| Khách `debt IS NULL` | 0 |
| `order_debts` | 0 dòng |
| `debt_transactions` | 0 dòng |
| `payments` | 5 dòng — **toàn bộ là 5 lần thu 13.500.000đ của khách id=14 (A 3 Giới)** mà `debt` của khách này = 0 → dữ liệu test lịch sử, không phải dữ liệu thật |
| `sales.payment_status` | 575/575 = `unpaid` |
| `sales.delivery_status` | 575/575 = `NULL` |
| `delivery_records` | 0 dòng |
| `app_users` | 0 dòng |
| `sales_staff` | 7 dòng (chỉ "Thiện" active) |
| `audit_logs` | 8 dòng |
| `max_debt_per_customer` | 5.000.000 |
| `customers.deposit` tổng | 42.000.000 |

### 1.8 Đánh giá tích hợp Zalo cá nhân (KHÔNG dùng OA) — kết luận **NOT_AVAILABLE**

Đã kiểm tra thực tế trên máy:

| Hạng mục | Kết quả kiểm tra | Đánh giá |
|---|---|---|
| Zalo Desktop có cài? | ✅ `C:\Users\ADMIN\AppData\Local\Programs\Zalo\Zalo-26.11.11` (đang chạy, 9 tiến trình) | — |
| Có API bot chính thức cho tài khoản cá nhân? | ❌ Không. Zalo chỉ mở OpenAPI cho **OA** | **Không thể** |
| Cổng listener nội bộ để nhận tin nhắn? | ❌ Không mở cổng TCP nào (chỉ thấy cổng của Riot/League) | **Không thể** |
| Đọc DB tin nhắn cục bộ? | ❌ `ZaloData/Database/_production/<uid>/MsgInfo.db` — file **đang bị khoá** bởi tiến trình Zalo, và `database-config.json` có `db-enc.userDBprogress = finished` ⇒ **DB mã hoá** | **Không thể** (đọc DB mã hoá của ứng dụng khác = hành vi không được phép) |
| Lấy `groupId` / `senderId` của nhóm cá nhân? | ❌ Không có API công khai; chỉ suy ra từ DB mã hoá | **Không thể** |
| Gửi tin nhắn hộ tài khoản cá nhân? | ❌ Không có API; chỉ có UI tự động hóa (rủi ro vi phạm điều khoản, dễ bị khoá) | **Không nên** |
| Rủi ro điều khoản | Tự động hóa tài khoản cá nhân = rủi ro khoá tài khoản, mất nhóm đang hoạt động | **Tránh** |

**→ Quyết định:** `DebtZaloBridge` được đánh dấu **`NOT_AVAILABLE`** ở tầng adapter.
Theo đúng mục 5 của yêu cầu:
- Không ảnh hưởng `DebtService`.
- Xây dựng **trang nhập nhanh trên Beer POS** (thay thế nghiệp vụ `+1000`/`-1000`).
- Thiết kế **adapter interface** để thay thế phương thức kết nối Zalo sau này mà **không sửa DebtService**.
- Không hardcode cookie/token, không lưu mật khẩu Zalo, không vượt CAPTCHA.

---

## 2. KIẾN TRÚC MỚI (ĐỀ XUẤT)

```
                    ┌──────────────────────────────────────────────┐
                    │            Beer POS (Single Source of Truth) │
                    │                                              │
  Đơn hàng ───────▶│ DeliveryService.confirmDelivery/updateStatus │
                    │        │ (status → DELIVERED)                 │
                    │        ▼                                      │
                    │  DebtOrderIntegration.onOrderDelivered()      │
                    │        │                                      │
                    │        ▼                                      │
                    │  ┌──────────────────────────────────────┐    │
                    │  │        DEBT LEDGER (nguồn sự thật)     │    │
                    │  │  DebtLedgerService                   │    │
                    │  │   • recordOrderDebt (idempotent)      │    │
                    │  │   • recordPayment                    │    │
                    │  │   • recordManualDebt                 │    │
                    │  │   • adjust / reverse                 │    │
                    │  │   • computeBalance (SUM, không lưu)  │    │
                    │  └──────────────────────────────────────┘    │
                    │        ▲                    ▲                 │
                    │        │                    │                 │
        ┌───────────┴────────┐   ┌───────────────┴──────────┐      │
        │ DebtCommandService │   │ DebtReconciliationService│      │
        │  +1000 / -1000     │   │  đối soát ledger vs sales │      │
        └───────────┬────────┘   └──────────────────────────┘      │
                    │                                             │
        ┌───────────┴──────────────┐                  ┌───────────┴──────────┐
        │ DebtZaloBridge (ADAPTER) │                  │ DebtLedger (SQLite)  │
        │  status: NOT_AVAILABLE  │                  │  debt_accounts       │
        │  interface:              │                  │  debt_transactions   │
        │   onMessage(msg)         │                  │  debt_customer_groups│
        │   sendToGroup(gid,text)  │                  │  debt_staff_perms    │
        │   isAvailable()          │                  │  debt_audit_logs     │
        │   [adapter:Manual/UI]    │                  │  debt_processed_evt  │
        │   [adapter:Webhook]      │                  │  debt_bridge_events  │
        │   [adapter:ZaloPersonal] │                  └──────────────────────┘
        └───────────┬──────────────┘
                    ▼
        ┌────────────────────────────────────────┐
        │ UI SỔ CÔNG NỢ (views/debts.html)        │
        │  A. Tổng quan  B. Danh sách KH         │
        │  C. Chi tiết    D. Nhập thanh toán     │
        │  E. Đối soát    F. Nhóm Zalo + phân quyền│
        └────────────────────────────────────────┘
```

**Nguyên tắc thiết kế:**
1. **Sổ cái (ledger) là nguồn sự thật.** `customers.debt` được **mirror** từ ledger để không phá UI cũ (`views/customer-detail.html`, driver portal, `DebtService` hiện tại).
2. Mọi bút toán **append-only** — không `DELETE`, không `UPDATE amount`. Sai thì tạo `ADJUSTMENT`/`REVERSAL`.
3. Mọi ghi đều **trong 1 `db.transaction()`** + `idempotency_key` UNIQUE.
4. `idempotency` chống ghi trùng: key = `order:<saleId>:<eventId>` hoặc `msg:<platform>:<messageId>`.
5. `debt_processed_events` chống xử lý lại webhook/sau restart.

---

## 3. PHẠM VI THAY ĐỔI (ĐỀ XUẤT — CHƯA THỰC THI)

### 3.1 File MỚI (13)

| File | Vai trò |
|---|---|
| `database/migrations/053_debt_management.js` | Migration tạo 7 bảng mới + index + seed setting (ADDITIVE, idempotent) |
| `src/services/debt/DebtLedgerService.js` | Ghi/đọc bút toán. Transaction type, idempotency, balance |
| `src/services/debt/DebtAccountService.js` | Quản lý `debt_accounts` (1 account/khách, opening balance) |
| `src/services/debt/DebtPaymentService.js` | Thanh toán (PAYMENT) + phân bổ vào đơn (order_debts) |
| `src/services/debt/DebtManualService.js` | Nợ tay (MANUAL_DEBT) + ADJUSTMENT + REVERSAL |
| `src/services/debt/DebtOrderIntegration.js` | Hook `DELIVERED`; tính **tiền khách còn phải trả**; idempotent |
| `src/services/debt/DebtPermissionService.js` | Quyền nhân viên (theo `debt_staff_permissions`) |
| `src/services/debt/DebtCommandService.js` | Parser `+1000` / `-1000` + kiểm tra quyền + trả lời |
| `src/services/debt/DebtReconciliationService.js` | Đối soát ledger vs `sales` vs `order_debts` |
| `src/services/debt/DebtAuditService.js` | Ghi `debt_audit_logs` (before/after) |
| `src/services/debt/DebtZaloBridge.js` | **Adapter interface** + `NotAvailableZaloAdapter` (NOT_AVAILABLE) |
| `routes/api/debtLedger.js` | API mới: ledger, groups, permissions, reconciliation, quick-entry |
| `views/debts.html` + `public/js/debts.js` | Giao diện SỔ CÔNG NỢ (5 trang A→E) |

### 3.2 File SỬA (tối thiểu, không refactor)

| File | Thay đổi | Rủi ro |
|---|---|---|
| `database/migration.js` | Thêm `runDebtManagementMigration` + export | Thấp |
| `database.js` | Gọi migration mới sau 052 | Thấp |
| `src/services/DeliveryService.js` | Gọi `DebtOrderIntegration.onOrderDelivered()` khi `nextStatus === 'DELIVERED'` (2 chỗ) | **Trung bình** — bọc try/catch, KHÔNG làm hỏng giao hàng |
| `src/services/index.js` | Export `DebtLedgerService`… | Thấp |
| `routes/api/debts.js` | Thêm route mới (nhập nhanh, ledger) — **giữ nguyên route cũ** | Thấp |
| `server.js` | Mount `/api/debt-ledger`, page `/debts` | Thấp |
| `middleware/permissions.js` | Thêm `/debts` vào `ADMIN_ONLY_PAGES`; cho STAFF truy cập route được phân quyền | Thấp |
| `middleware/auditLog.js` | Thêm `['/api/debt-ledger','debt_ledger']`, `['/api/debts','debt']` vào `ENTITY_MAP` | Thấp |
| `views/dashboard.html` | Thêm card "Sổ công nợ" vào hub | Thấp |
| `views/customer-detail.html` | Tab công nợ: đọc từ ledger (fallback cũ) | Trung bình |
| `src/socket/socketServer.js` | Event `debt:ledger:updated` (tuỳ chọn) | Thấp |

### 3.3 File KHÔNG ĐỤNG TỚI (theo mục 13)

`routes/api/sales.js` (logic bán hàng), `src/services/promotionCalc.js` & toàn bộ CTKM bia,
`routes/api/payments.js`, `public/db.js`, `public/sync.js`, `database/migrations/00X` cũ,
cấu trúc `customers`, `sales`, `products`.

---

## 4. THIẾT KẾ DATABASE (MIGRATION 053 — ADDITIVE)

Tất cả bảng mới có tiền tố `debt_` → **không đụng** bảng cũ.

```sql
-- 1) Tài khoản công nợ — 1/khách, UNIQUE(customer_id)
CREATE TABLE IF NOT EXISTS debt_accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     INTEGER NOT NULL UNIQUE,
  opening_balance REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',   -- active | closed
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- 2) Sổ cái — append-only, KHÔNG bao giờ xoá
CREATE TABLE IF NOT EXISTS debt_transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     INTEGER NOT NULL,
  transaction_type TEXT NOT NULL,   -- OPENING_BALANCE | ORDER_DEBT | MANUAL_DEBT | PAYMENT | ADJUSTMENT | REVERSAL
  amount          REAL NOT NULL,    -- luôn > 0; dấu quyết định theo transaction_type
  balance_before  REAL NOT NULL,
  balance_after   REAL NOT NULL,
  reference_type  TEXT,             -- ORDER | MANUAL | NONE
  reference_id    TEXT,             -- sale_id (order) hoặc mã tham chiếu
  description     TEXT,
  created_by      TEXT,             -- username nhân viên (NULL = hệ thống)
  source          TEXT NOT NULL DEFAULT 'POS',  -- POS | ZALO | MANUAL_UI | RECONCILIATION | MIGRATION
  idempotency_key TEXT UNIQUE,     -- ⭐ chống ghi trùng
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- 3) Mapping nhóm Zalo ↔ khách
CREATE TABLE IF NOT EXISTS debt_customer_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  platform    TEXT NOT NULL,        -- zalo_personal | zalo_oa | manual
  group_id    TEXT NOT NULL,
  group_name  TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_groups_platform_gid ON debt_customer_groups(platform, group_id);

-- 4) Phân quyền nhân viên ghi thanh toán
CREATE TABLE IF NOT EXISTS debt_staff_permissions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id         TEXT NOT NULL,   -- username trong app_users
  customer_id      INTEGER NOT NULL,
  can_record_payment INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_perm_staff_cust ON debt_staff_permissions(staff_id, customer_id);

-- 5) Audit log riêng của sổ công nợ
CREATE TABLE IF NOT EXISTS debt_audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER,           -- FK logic → debt_transactions.id
  action        TEXT NOT NULL,      -- CREATE | UPDATE | REVERSE | RECONCILE_FIX | PERMISSION_CHANGE | GROUP_LINK
  actor_id      TEXT,
  before_data   TEXT,               -- JSON
  after_data    TEXT,               -- JSON
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6) Chống xử lý lại event (webhook gửi lại, restart server)
CREATE TABLE IF NOT EXISTS debt_processed_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,        -- ORDER_DELIVERED | COMMAND_PAYMENT | COMMAND_MANUAL_DEBT
  event_id    TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_type, event_id)
);

-- 7) Nhật ký bridge (adapter Zalo / webhook) — tách riêng để thay adapter không đụng ledger
CREATE TABLE IF NOT EXISTS debt_bridge_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  platform     TEXT NOT NULL,
  group_id     TEXT,
  sender_id    TEXT,
  message_id   TEXT,
  content      TEXT,
  received_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status       TEXT NOT NULL DEFAULT 'received', -- received | processed | rejected | failed
  result       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_bridge_msg ON debt_bridge_events(platform, message_id);
```

### 4.1 Ràng buộc bắt buộc

| Ràng buộc | Cách thực hiện |
|---|---|
| FK hợp lệ | `FOREIGN KEY ... ON DELETE CASCADE/RESTRICT` + `PRAGMA foreign_keys=ON` (đã bật) |
| 1 đơn = 1 `ORDER_DEBT` hiệu lực | `idempotency_key = 'order_debt:<sale_id>'` UNIQUE + `debt_processed_events` |
| `idempotency_key` UNIQUE | đã khai báo |
| Không xoá vật lý transaction | Không có `DELETE` trong service; chỉ thêm `REVERSAL`/`ADJUSTMENT` |
| Audit mọi thay đổi | `DebtAuditService.audit()` gọi **trong cùng transaction** |
| Transaction DB cho ghi & tính | `db.transaction(() => {...})()` của better-sqlite3 |

### 4.2 Kế hoạch migrate dữ liệu cũ (BẮT BUỘC, phải có script riêng)

```
Với mỗi khách có customers.debt != 0 (25 khách, tổng 12.577.000đ):
  1. INSERT debt_accounts(customer_id, opening_balance = customers.debt)
  2. INSERT debt_transactions(transaction_type='OPENING_BALANCE',
        amount = customers.debt, balance_before = 0, balance_after = customers.debt,
        source='MIGRATION', created_by='system',
        idempotency_key = 'opening_balance:<customer_id>',
        description='Migrate số dư công nợ hiện có tại thời điểm 2026-11-13')
→ customers.debt giữ nguyên giá trị (mirror khớp 1:1) → không mất tiền, không phá UI.
→ Script phải idempotent (chạy lại không tạo bản ghi trùng).
```

---

## 5. QUY TẮC TÍNH CÔNG NỢ (CHUẨN — SINGLE SOURCE OF TRUTH)

### 5.1 Công thức

```
Balance = Opening Balance
        + ORDER_DEBT      (nợ tự động từ đơn hàng, khi DELIVERED)
        + MANUAL_DEBT     (nợ tay, do nhân viên nhập lệnh `-`)
        - PAYMENT         (khách thanh toán, lệnh `+` hoặc nhập tay)
        + ADJUSTMENTS     (điều chỉnh có audit log)
```

`balance_after` của mỗi bút toán = `balance_before` + delta — **luôn kiểm tra bằng `SUM(amount)` theo transaction_type** trong báo cáo đối soát.

### 5.2 Quy tắc ghi `ORDER_DEBT` (bám theo yêu cầu mục 2.1)

Trigger: **chỉ khi** `delivery_records.status` chuyển sang `DELIVERED` **hoặc** `sales.delivery_status = 'DELIVERED'` **và** đơn có `customer_id` hợp lệ **và** `type='sale'`.

**Debt Amount = Amount Customer Owes** — KHÔNG mặc định lấy `sales.total`.

Công thức tính (theo thứ tự ưu tiên):

```
1. total_gross      = sales.total
                     (đã trừ khuyến mãi/bi-a-tặng trong chính logic bán hàng hiện có —
                      promo_free_liters, reward_liters_used đã được tính lúc tạo đơn)
2. total_paid_sale  = SUM(amount) của debt_transactions
                      WHERE transaction_type='PAYMENT' AND reference_type='ORDER' AND reference_id=sale_id
                      (tương thích: order_debts.paid_amount nếu có)
3. total_refunded   = SUM(amount) của debt_transactions
                      WHERE transaction_type='REVERSAL'/'ADJUSTMENT' gắn với sale này
4. amount_owed      = MAX(0, total_gross - total_paid_sale - total_refunded)
```

Điểm kiểm soát (đáp ứng yêu cầu mục 7):
- Khách **trả trước** → `total_paid_sale ≥ total_gross` ⇒ `amount_owed = 0` ⇒ **không ghi bút toán ORDER_DEBT** (hoặc ghi amount=0? → **bỏ qua hẳn**, chỉ ghi `debt_processed_events` để không ghi lại).
- Khách **trả một phần** → `amount_owed = total - đã trả` ⇒ ghi đúng phần còn lại.
- Đơn **đã thanh toán đủ** → không ghi.
- **Giảm trừ hợp lệ** (khuyến mãi) → đã nằm trong `sales.total` ⇒ không cộng thêm.
- **Giao một phần** (`delivered_liters < expected_liters`): theo mặc định **KHÔNG ghi nợ** vì trạng thái sẽ là `DISCREPANCY` (chưa phải `DELIVERED`); nếu chính sách nghiệp vụ muốn ghi nợ theo tỉ lệ giao thực tế → bật setting `debt_partial_delivery_policy = 'PROPORTIONAL'` (mặc định `'NONE'`). **Cần user chốt.**
- **Giao nhiều lần**: `confirmDelivery` có thể chạy lại → idempotent key `order_debt:<sale_id>` ⇒ lần 2 bị bỏ qua, số dư không nhân đôi.
- **Hủy đơn sau khi đã ghi nợ** → `saleDelete`/`reverseDebtForSale` tạo bút toán `REVERSAL` (**không xoá** bút toán gốc) + `order_debts.status='cancelled'`.
- **Đơn sửa sau giao** → `PUT /api/sales/:id` hiện gọi `DebtService.adjustDebt` ⇒ sẽ chuyển sang ghi `ADJUSTMENT` (có `reference_type='ORDER'`, `reference_id=sale_id`) giữ nguyên bút toán gốc.
- **Webhook gửi lại / restart giữa chừng** → `debt_processed_events` UNIQUE `(event_type,event_id)` + `idempotency_key` UNIQUE; mọi ghi nằm trong 1 transaction ⇒ restart không để lại trạng thái nửa vời.

### 5.3 Quy tắc lệnh `+` / `-`

| Lệnh | Ý nghĩa | Bút toán | Đơn vị |
|---|---|---|---|
| `+1000` | Khách thanh toán | `PAYMENT` (amount = 1.000.000) | nghìn đồng |
| `-1000` | Khách phát sinh thêm nợ | `MANUAL_DEBT` (amount = 1.000.000) | nghìn đồng |

Parser (`DebtCommandService.parse`) — **CHỈ** nhận đúng 2 mẫu (cho phép khoảng trắng trước/sau):

```
/^\s*([+-])\s*(\d{1,9})\s*$/
```

Từ chối: `++1000`, `+0`, `+-1000`, `+abc`, `+1000đ`, `+1.000`, giá trị > `debt_command_max_amount` (setting, mặc định 100.000 = 100.000.000đ), tin nhắn không đúng cú pháp.

**Luồng xử lý (thứ tự bắt buộc):**
```
1. Nhận message { messageId, groupId, senderId, timestamp, content }
2. Kiểm tra messageId đã xử lý chưa (debt_processed_events + debt_bridge_events UNIQUE) → nếu rồi: trả "đã xử lý", KHÔNG ghi lại
3. Parse lệnh → sai cú pháp: trả hướng dẫn, KHÔNG ghi
4. Tra debt_customer_groups theo (platform, groupId) → không có: từ chối "nhóm chưa liên kết khách hàng"
5. Tra debt_staff_permissions theo (senderId, customerId) → không có quyền: từ chối
6. Kiểm tra amount hợp lệ & giới hạn
7. Ghi bút toán + cập nhật mirror customers.debt + audit log  (1 transaction)
8. Chỉ sau khi COMMIT → gửi phản hồi vào nhóm (nếu adapter khả dụng)
9. Ghi debt_processed_events
```

**Phản hồi (mẫu, khớp mục 10):**
```
SỔ CÔNG NỢ GIA HUY

ĐÃ GHI NHẬN THANH TOÁN

Khách hàng: Anh Hùng
Số tiền: 1.000.000đ
Người xác nhận: Nhân viên A
Công nợ trước: 3.500.000đ
Công nợ hiện tại: 2.500.000đ
```
```
SỔ CÔNG NỢ GIA HUY

PHÁT SINH CÔNG NỢ

Đơn hàng: DH001
Khách hàng: Anh Hùng
Giá trị còn phải thu: 1.500.000đ
Công nợ hiện tại: 4.000.000đ
```

### 5.4 Đối soát (mục 8E)

`DebtReconciliationService.reconcile()` trả về 4 nhóm lỗi:
1. **Đơn DELIVERED thiếu bút toán ORDER_DEBT** → `delivered_without_debt`.
2. **Bút toán ORDER_DEBT không còn đơn DELIVERED** → `orphan_order_debt`.
3. **Giao dịch trùng** (cùng `idempotency_key` / cùng `messageId`) → `duplicate`.
4. **Số dư không khớp**: `SUM(amount theo type)` ≠ `balance_after` bút toán cuối ≠ `customers.debt` (mirror) → `balance_mismatch`.

Mỗi lỗi có **nút "Xử lý"** → tạo bút toán điều chỉnh kèm `debt_audit_logs` (không sửa/xoá bản ghi gốc).

---

## 6. PHÂN QUYỀN (mục 9) — ánh xạ vào hệ thống hiện có

| Yêu cầu | Hiện thực |
|---|---|
| ADMIN: xem/ghi/điều chỉnh/đảo/quản lý nhóm/phân quyền/xem lịch sử | `req.user.role === 'ADMIN'` → toàn quyền trên `/api/debt-ledger/*` |
| STAFF: chỉ ghi thanh toán cho khách được phân công | Role `STAFF` (thêm vào `app_users.role`) **hoặc** `DRIVER`; cần `debt_staff_permissions(staff_id, customer_id, can_record_payment=1)` |
| STAFF: không xoá giao dịch | Không có endpoint DELETE cho `debt_transactions` (chỉ `REVERSAL`) |
| STAFF: không tự điều chỉnh công nợ | `POST /adjust` yêu cầu ADMIN |
| STAFF: không đổi mapping khách hàng | `POST /groups` yêu cầu ADMIN |
| CUSTOMER: không ghi giao dịch | Nhóm Zalo: `senderId` phải có trong `debt_staff_permissions`; UI: `STAFF`/`CUSTOMER` không được gọi endpoint ghi |

> **Lưu ý hiện trạng:** `app_users` đang **rỗng** và `sales_staff` là bảng riêng (tài khoản nhân viên sales, không phải login). Cần **user chốt**: dùng `app_users` (đã có login + RBAC) làm nguồn "nhân viên" cho `debt_staff_permissions.staff_id` — **khuyến nghị CÓ** (tận dụng sẵn auth + session + audit).

---

## 7. GIAO DIỆN (mục 8) — đề xuất bố cục `views/debts.html`

| Trang | Nội dung |
|---|---|
| **A. Tổng quan** | Tổng công nợ; nợ phát sinh hôm nay; tiền thu hôm nay; số khách còn nợ; top 10 khách nợ cao nhất; KPI card |
| **B. Danh sách KH** | Tên, mã, tổng nợ, đã thanh toán, số dư, nhóm Zalo, trạng thái; filter (còn nợ / hết nợ / có nhóm) |
| **C. Chi tiết** | Số dư đầu kỳ → bảng đơn phát sinh nợ → bảng thanh toán → điều chỉnh → số dư cuối kỳ → timeline giao dịch |
| **D. Nhập nhanh** | Chọn KH → nhập số tiền (hoặc dùng nút `+1000` / `-1000`) → chọn nhân viên xác nhận → ghi chú → xác nhận. **Đây là bản thay thế nghiệp vụ lệnh trong nhóm Zalo** |
| **E. Đối soát** | 4 nhóm lỗi + nút xử lý kèm audit |
| **F. Cấu hình** | Liên kết nhóm Zalo ↔ KH; phân quyền nhân viên; trạng thái adapter Zalo (`NOT_AVAILABLE`) |

Đăng ký: `server.js` → `app.get('/debts', sendPageNoCache(..., 'debts.html'))`; thêm vào `ADMIN_ONLY_PAGES` của `middleware/permissions.js` (chặn DRIVER) và card trên `views/dashboard.html`.

---

## 8. KẾ HOẠCH KIỂM THỬ (mục 11) — 14 ca bắt buộc

File: `tests/debt/ledger.test.js`, `tests/debt/commands.test.js`, `tests/debt/order-integration.test.js`, `tests/debt/reconciliation.test.js`
(dùng `tests/setup.js` → mỗi file 1 bản sao DB tạm, **không** chạm DB thật).

| # | Ca | Kỳ vọng |
|---|---|---|
| 1 | Ghi nhận đơn DELIVERED | Có 1 `ORDER_DEBT`, balance tăng đúng, mirror `customers.debt` khớp |
| 2 | Đơn chưa DELIVERED | **Không** ghi |
| 3 | Ghi trùng đơn (gọi 2 lần / webhook lặp) | Chỉ 1 bút toán (idempotency) |
| 4 | Lệnh `+1000` | `PAYMENT` 1.000.000đ, balance giảm |
| 5 | Nhân viên không có quyền | Từ chối, **không** ghi |
| 6 | Trùng `messageId` | Bỏ qua, không ghi lần 2 |
| 7 | Đơn trả một phần | `amount_owed = total - đã trả` |
| 8 | Đơn đã trả đủ | **Không** ghi ORDER_DEBT |
| 9 | Hủy đơn sau khi ghi | `REVERSAL` + bút toán gốc **còn nguyên** |
| 10 | Đảo giao dịch | Tạo `REVERSAL` mới, balance về trạng thái trước |
| 11 | Điều chỉnh công nợ | `ADJUSTMENT` + `debt_audit_logs` |
| 12 | 2 giao dịch đồng thời | `db.transaction` + UNIQUE ⇒ không mất tiền, không nhân đôi |
| 13 | Restart server giữa chừng | `debt_processed_events` chống ghi lại; dữ liệu nhất quán |
| 14 | Đối soát ledger vs đơn | Phát hiện đủ 4 loại lỗi |

Bổ sung: unit test parser (`+1000`, `-1000`, `++1000`, `+0`, `+-1000`, `+abc`, khoảng trắng, vượt giới hạn), test migration idempotent, test `+`/`-` **không** tạo `sales` và **không** đổi doanh thu, test rollback migration.

---

## 9. QUY TRÌNH TRIỂN KHAI & ROLLBACK

**Triển khai theo 4 giai đoạn, mỗi giai đoạn độc lập revert được:**

| Giai đoạn | Nội dung | Điểm dừng kiểm tra |
|---|---|---|
| **GĐ1 — Nền tảng** | Migration 053 + `DebtLedgerService` + `DebtAccountService` + `DebtAuditService` + script migrate opening balance | `npm test` xanh; `customers.debt` **không đổi** (12.577.000đ) |
| **GĐ2 — Đơn hàng** | `DebtOrderIntegration` + hook `DeliveryService` | Test case 1,2,3,7,8,9; đơn hàng POS không đổi hành vi |
| **GĐ3 — Lệnh & UI** | `DebtCommandService` + `DebtZaloBridge` (NOT_AVAILABLE) + `DebtPaymentService` + API + `views/debts.html` + trang nhập nhanh | Test case 4,5,6,10,11,12 |
| **GĐ4 — Đối soát & hoàn thiện** | `DebtReconciliationService` + trang đối soát + dashboard card + docs | Test case 13,14; đối soát 100% sạch |

**Rollback (đã xác nhận khả thi):**
1. **Rollback code**: `git revert` / `git checkout <commit>` → file mới bị xoá, route mới bị gỡ. **Không cần** rollback DB vì các bảng mới là ADDITIVE.
2. **Rollback DB (chỉ khi cần xoá hẳn)**: `DROP TABLE debt_bridge_events; debt_processed_events; debt_audit_logs; debt_staff_permissions; debt_customer_groups; debt_transactions; debt_accounts;` → **cần backup trước** (đã có: `backups/pre_debt_20261113_163213/`). Bảng `customers/sales/order_debts/payments/debt_transactions` cũ **không bị đụng**.
3. **Rollback dữ liệu mirror**: nếu đã mirror `customers.debt` từ ledger → copy lại `customers.debt` từ `backups/pre_debt_20261113_163213/database.sqlite` (UPDATE ... FROM backup). Có thể tránh hoàn toàn nếu GĐ1 chỉ tạo ledger mà **chưa** mirror.
4. **Đã xác nhận khả năng rollback**: `git` sạch trên `main`, backup DB đầy đủ (sqlite + wal + shm), migration là ADDITIVE ⇒ rollback an toàn.

---

## 10. KẾT QUẢ KIỂM TRA DỮ LIỆU CŨ (tóm tắt)

| Rủi ro dữ liệu | Mức độ | Xử lý |
|---|---|---|
| `customers.debt` là dữ liệu nhập tay, không có đơn nào đối chiếu được | **Cao** | Migrate thành `openingBalance` + `OPENING_BALANCE` transaction (có `source='MIGRATION'`) → không mất tiền, có dấu vết |
| `payments` có 5 dòng trùng lặp (test cũ, khách debt=0) | Trung bình | **Giữ nguyên** (không xoá lịch sử). Ghi chú trong báo cáo đối soát là "payment không gắn ledger" → có thể đánh dấu `legacy` |
| `order_debts`/`debt_transactions` rỗng | Thấp | Tận dụng làm nền: ledger mới dùng bảng riêng `debt_transactions` (tên khác) |
| `sales.payment_status` toàn bộ `unpaid` | Trung bình | Không sửa dữ liệu cũ. Logic mới **đọc** `payment_status` + `order_debts` + ledger để tính `amount_owed` |
| `app_users` rỗng → chưa có STAFF nào để phân quyền | Trung bình | Cần tạo tài khoản STAFF qua trang quản lý tài khoản hiện có (`/api/admin/drivers`) |
| 6 khách có nợ > 0 nhưng không có đơn hàng ghi nợ | Cao | `openingBalance` giữ nguyên; đối soát sẽ báo `legacy_opening_only` — **đúng bản chất dữ liệu** |

---

## 11. TRẠNG THÁI TÍCH HỢP ZALO THỰC TẾ

| Hạng mục | Trạng thái |
|---|---|
| Zalo OA (đã có, migration 052) | **Sẵn sàng kỹ thuật** nhưng **KHÔNG dùng** cho module này theo yêu cầu "không dùng OA" |
| Zalo cá nhân — đọc tin nhắn nhóm | ❌ **NOT_AVAILABLE** (DB mã hoá + khoá file, không API bot, không listener) |
| Zalo cá nhân — gửi tin nhắn nhóm | ❌ **NOT_AVAILABLE** (không API, chỉ UI tự động hóa — rủi ro khoá tài khoản) |
| Lấy `groupId` / `senderId` | ❌ Không khả thi hợp lệ |
| Rủi ro bảo mật | Không hardcode cookie/token, không lưu mật khẩu, không bypass CAPTCHA, không chạm tài khoản chính |
| **Phương án thay thế (đang đề xuất)** | **Trang nhập nhanh trên Beer POS** (`views/debts.html` trang D) — nhân viên chọn khách + bấm `+1000` / `-1000` → **cùng một `DebtCommandService`**, cùng ledger, cùng audit, cùng phản hồi. Sau này thêm adapter mà **không sửa DebtService** |
| Interface adapter | `DebtZaloBridge.onMessage(msg)` / `sendToGroup(groupId, text)` / `isAvailable()` — hiện cài `NotAvailableZaloAdapter` (no-op, trả `NOT_AVAILABLE`) |

---

## 12. CÁC QUYẾT ĐỊNH CẦN USER CHỐT TRƯỚC KHI CODE

| # | Câu hỏi | Khuyến nghị |
|---|---|---|
| Q1 | Nguồn "nhân viên" cho `debt_staff_permissions.staff_id` là `app_users.username` hay `sales_staff.id`? | **`app_users.username`** — đã có login/session/RBAC/audit |
| Q2 | Đơn giao một phần (`DISCREPANCY` / thiếu lít) có ghi nợ không? | **Không ghi** khi còn `DISCREPANCY`; chỉ ghi khi `DELIVERED` sạch. Nếu muốn ghi theo tỉ lệ → bật setting riêng |
| Q3 | `customers.debt` giữ làm **mirror** (đồng bộ 2 chiều) hay giữ nguyên như hiện tại? | **Mirror 1 chiều** (ledger → customers.debt). UI cũ không phá; luôn có thể rollback bằng script |
| Q4 | Có cho phép `PAYMENT` vượt quá số dư nợ (trả trước → công nợ âm)? | **Không** — chặn vượt, đồng thời sửa `DebtService.payDebt` hiện tại đang **âm ẩn** phần dư |
| Q5 | Có tạo role `STAFF` mới trong `app_users.role` hay dùng `DRIVER`? | Thêm role `STAFF` (role hiện có chỉ ADMIN/DRIVER) |
| Q6 | Phạm vi GĐ1 có ghi thêm bản ghi `MIGRATION` vào ledger cho 25 khách không? | **Có** — để truy vết được nguồn gốc số dư |

---

## 13. KẾT LUẬN

- **Beer POS hiện chưa phải Single Source of Truth cho công nợ** — cần dựng ledger mới, giữ `customers.debt` làm mirror để không phá UI/POS.
- **Zalo cá nhân (không OA) không khả thi ở mức ổn định & hợp lệ** → `NOT_AVAILABLE`; thay bằng trang nhập nhanh trên POS, giữ nguyên interface adapter để mở rộng sau.
- Phạm vi thay đổi **giới hạn & additive**: 13 file mới + ~11 file sửa nhỏ; **không** đụng logic bán hàng, CTKM, giá, đồng bộ PWA.
- Toàn bộ triển khai có thể **revert từng giai đoạn**; backup đã tạo tại `backups/pre_debt_20261113_163213/`.
- **Chưa thay đổi source code / database** — chờ chốt 6 câu hỏi ở mục 12 rồi mới bắt đầu GĐ1.
