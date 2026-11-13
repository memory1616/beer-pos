# SỔ CÔNG NỢ GIA HUY — TÀI LIỆU BÀN GIAO

> Module quản lý công nợ khách hàng tích hợp vào Beer POS.
> **Beer POS là Single Source of Truth.**

---

## 1. BÁO CÁO AUDIT TRƯỚC TRIỂN KHAI

### 1.1. Cấu trúc dự án đã đọc

| Hạng mục | Kết quả audit |
|---|---|
| Runtime | Node.js 20, CommonJS, Express 4 |
| Database | SQLite qua `better-sqlite3@9.4`, WAL mode, `foreign_keys=ON` |
| Entry point | `server.js` (Express app + Socket.IO) |
| Database layer | `database.js` (schema + migrations), `database/migration.js`, `database/migrations/NNN_*.js` |
| Auth | `middleware/auth.js` (`requireAuth`, `dbGetSession` từ bảng `auth_sessions`), session lưu cookie `httpOnly` + token Bearer |
| RBAC | `middleware/permissions.js` (`apiGuard`, `adminPageGuard`), role trong `app_users.role` (`ADMIN` / `STAFF` / `DRIVER`) |
| Migration runner | `database/migration.js` — registry migrations theo id tăng dần |

### 1.2. Schema liên quan đã kiểm tra

| Bảng | Vai trò | Xử lý trong module |
|---|---|---|
| `customers(id, name, phone, debt, archived)` | Mirror số dư công nợ | `debt` giữ nguyên làm **mirror**, được ledger đồng bộ tự động |
| `sales(id, customer_id, total, payment_status, delivery_status, archived, deleted, type)` | Đơn hàng | Đọc để tính "Amount Customer Owes"; thêm cột `is_credit` (migration 054) |
| `order_debts(sale_id, customer_id, original_amount, paid_amount, remaining_amount, status)` | Bảng chiếu công nợ theo đơn | Giữ lại làm **projection** cho UI cũ, KHÔNG còn là nguồn sự thật |
| `payments(customer_id, amount, date, note)` | Lịch sử thu tiền legacy | Vẫn được ghi khi nhập thanh toán để không phá báo cáo cũ |
| `debt_transactions` (legacy schema `type`/`sale_id`/`note`) | Bảng cũ rỗng (0 dòng) | **Đổi tên** → `debt_transactions_legacy`, tạo bảng mới (migration 053) |
| `app_users(username, role, active)` | Tài khoản nhân viên | Nguồn cho `debt_staff_permissions.staff_id` |
| `settings(key, value)` | Cấu hình | Lưu `debt_command_unit`, `debt_command_max_amount`, … |

### 1.3. Vòng đời đơn hàng đã kiểm tra

- `DeliveryService.updateStatus()` và `DeliveryService.confirmDelivery()` — nơi trạng thái chuyển sang `DELIVERED`.
- `routes/api/sales.js` — tạo/sửa/xoá đơn.
- Trạng thái giao "sạch" duy nhất: `DELIVERED` (`DeliveryService.DELIVERY_STATUS`).

### 1.4. Service có thể tái sử dụng (KHÔNG viết lại)

`DebtService` (legacy facade) · `DeliveryService` · `AuditLogService` · `cache` · `logger` · `middleware/permissions` · `middleware/auth`.

### 1.5. Rủi ro phát hiện & cách xử lý

| Rủi ro | Xử lý |
|---|---|
| Bảng `debt_transactions` legacy đã tồn tại với schema cũ | Migration 053 phát hiện schema → rename → tạo bảng mới. **Không mất dữ liệu.** |
| `DebtService` cũ ghi thẳng vào `debt_transactions` | Viết lại thành **facade mỏng** trên `DebtLedgerService` ⇒ một nguồn sự thật duy nhất |
| UI cũ đọc `customers.debt` / `order_debts` | Ledger đồng bộ mirror + giữ projection ⇒ **không phá UI cũ** |
| Ghi trùng khi webhook lặp / server restart | `idempotency_key` UNIQUE + `debt_processed_events` + `debt_bridge_events` |

---

## 2. SƠ ĐỒ KIẾN TRÚC

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          BEER POS (Single Source of Truth)               │
└──────────────────────────────────────────────────────────────────────────┘

   POS ──► DeliveryService.updateStatus / confirmDelivery
              │  (toStatus === 'DELIVERED')
              ▼
        DebtOrderIntegration  ──────────────────────────────┐
          • computeAmountOwed()  (Amount Customer Owes)     │
          • idempotency: order_debt:sale:<saleId>           │
          • markEventProcessed(ORDER_DELIVERED)             │
                                                           ▼
        ┌──────────────────────────────────────────────────────────┐
        │              DebtLedgerService  (SỔ CÁI APPEND-ONLY)    │
        │  recordTransaction / reverseTransaction / adjust        │
        │  computeBalance / getBalanceBreakdown                   │
        │  syncMirror → customers.debt                            │
        └───────────────┬──────────────────────────────────────────┘
                        │
      ┌─────────────────┼─────────────────┬──────────────────┐
      ▼                 ▼                 ▼                  ▼
 DebtPaymentService  DebtManualService DebtAccountService  DebtAuditService
  (PAYMENT)          (MANUAL_DEBT,        (OPENING_BALANCE,   (debt_audit_logs)
   ⬆ lệnh `+`         ADJUSTMENT,          migrate legacy)       ▲
   ⬇ UI nhập tay     REVERSAL)                                  │ audit bắt buộc
      │                   ⬆ lệnh `-`                             │
      │                   │                                      │
      └───────┬───────────┘                                      │
              ▼                                                  │
      DebtCommandService  ◄──── DebtPermissionService (RBAC)      │
      (parse `+1000` / `-1000`)                                  │
              │                                                  │
              │  DebtZaloBridge (ADAPTER PATTERN) ───────────────┘
              │    ├─ NotAvailableZaloAdapter  (mặc định: NOT_AVAILABLE)
              │    ├─ ManualEntryAdapter      (UI Quick Entry)
              │    └─ ZaloPersonalAdapter     (chờ đánh giá khả thi)
              ▼
        DebtReconciliationService  (đối soát + audit log RECONCILE_FIX)
              │
              ▼
        routes/api/debtLedger.js  ──►  views/debts.html  (UI Sổ công nợ)
```

### Luồng lệnh `+1000` / `-1000`

```
Tin nhắn (Zalo | UI Quick Entry)
  └─► DebtCommandService.handleMessage()
        1. Validate (messageId, groupId, senderId)
        2. isMessageProcessed()      → trùng messageId ⇒ từ chối
        3. parseCommand()            → đúng cú pháp `^[+-]\d+$`?
        4. findCustomerByGroup()     → group chưa liên kết ⇒ từ chối
        5. DebtPermissionService     → nhân viên chưa phân công ⇒ từ chối
        6. DebtLedgerService.recordTransaction()  (trong DB transaction)
        7. markEventProcessed()
        8. DebtAuditService.record()
        9. buildResultReply()        → trả lời (SAU khi COMMIT)
```

---

## 3. DANH SÁCH FILE ĐÃ TẠO VÀ SỬA

### 3.1. File MỚI

| File | Nội dung |
|---|---|
| `src/services/debt/constants.js` | Hằng số nghiệp vụ: `TRANSACTION_TYPES`, `SOURCES`, `REFERENCE_TYPES`, `EVENT_TYPES`, `PLATFORMS`, `GROUP_STATUS`, `AUDIT_ACTIONS`, hạn mức mặc định |
| `src/services/debt/DebtLedgerService.js` | **Sổ cái append-only** — ghi/đảo/điều chỉnh, tính balance & breakdown, idempotency, sync mirror |
| `src/services/debt/DebtAccountService.js` | Tài khoản công nợ (1/khách), công nợ đầu kỳ, migrate số dư cũ (idempotent) |
| `src/services/debt/DebtOrderIntegration.js` | Hook vòng đời đơn hàng, `computeAmountOwed`, đảo nợ khi huỷ đơn, tìm đơn thiếu bút toán |
| `src/services/debt/DebtPermissionService.js` | RBAC: `ADMIN` / `STAFF` / `DRIVER` / `CUSTOMER`, ma trận hành động, phân công khách |
| `src/services/debt/DebtCommandService.js` | Parser `+`/`-`, xử lý message, chống trùng, sinh phản hồi Zalo |
| `src/services/debt/DebtPaymentService.js` | Ghi nhận thanh toán (chặn vượt số dư), audit log |
| `src/services/debt/DebtManualService.js` | Ghi nợ tay (`-`), điều chỉnh, đảo giao dịch — **không tạo đơn hàng** |
| `src/services/debt/DebtAuditService.js` | Ghi/đọc `debt_audit_logs`, lọc dữ liệu nhạy cảm |
| `src/services/debt/DebtZaloBridge.js` | Adapter pattern: `NotAvailableZaloAdapter`, `ManualEntryAdapter`, `ZaloPersonalAdapter` |
| `src/services/debt/DebtReconciliationService.js` | Đối soát: đơn thiếu bút toán, giao dịch trùng, lệch mirror/projection, orphan + xử lý có audit log |
| `routes/api/debtLedger.js` | Toàn bộ API module (18 endpoint) |
| `views/debts.html` | UI "SỔ CÔNG NỢ" — 6 tab + modal |
| `database/migrations/053_debt_management.js` | 7 bảng `debt_*` + setting |
| `database/migrations/054_debt_sale_credit_flag.js` | Thêm `sales.is_credit` |
| `scripts/migrate-debt-opening-balance.js` | Migrate số dư cũ → `OPENING_BALANCE` (đã chạy: 6 khách / 12.577.000đ) |
| `scripts/check-debt-data.js` | Báo cáo kiểm tra dữ liệu sổ công nợ (read-only) |
| `scripts/rollback-debt-test-tx.js` | Đảo giao dịch thử nghiệm (append-only, không xoá) |
| `tests/debt/ledger.test.js` | 20 test — GĐ1 ledger |
| `tests/debt/order-integration.test.js` | 24 test — GĐ2 tích hợp đơn hàng |
| `tests/debt/api.test.js` | 29 test — GĐ3 API + RBAC + GĐ4 đối soát + race condition |

### 3.2. File ĐÃ SỬA

| File | Thay đổi |
|---|---|
| `server.js` | Mount `app.use('/api/debt-ledger', ...)`, route trang `GET /debts` + redirect `/so-cong-no` |
| `views/dashboard.html` | Thêm hub card "Sổ công nợ" (`data-permission="debts"`) |
| `src/services/DebtService.js` | Viết lại thành **facade** trên `DebtLedgerService` (hợp đồng API giữ nguyên 100%) |
| `src/services/DeliveryService.js` | Hook `DebtOrderIntegration.onDeliveryStatusChanged` khi chuyển `DELIVERED` |
| `src/services/DailyReportService.js` | Truy vấn báo cáo ngày khớp schema `debt_transactions` mới |
| `routes/api/sales.js` | Set `sales.is_credit = 1` lúc tạo đơn; sửa/xoá đơn dùng ledger ADJUSTMENT/REVERSAL |
| `database/migration.js`, `database.js` | Đăng ký migration 053 & 054 |
| `src/services/debt/DebtCommandService.js` | Hỗ trợ `message.source` (ghi đè nguồn `ZALO` → `MANUAL_UI` cho UI) |

---

## 4. DANH SÁCH MIGRATION

| ID | Tên | Nội dung | Rollback |
|---|---|---|---|
| **053** | `debt_management` | Tạo 7 bảng: `debt_accounts`, `debt_transactions` (schema mới), `debt_customer_groups`, `debt_staff_permissions`, `debt_audit_logs`, `debt_processed_events`, `debt_bridge_events`. Tự phát hiện & **rename** bảng legacy → `debt_transactions_legacy` (giữ nguyên dữ liệu). Seed 6 setting `debt_*`. | `DROP TABLE` 7 bảng mới + xoá 6 setting. `customers`/`sales`/`order_debts`/`payments` **giữ nguyên**. |
| **054** | `debt_sale_credit_flag` | `ALTER TABLE sales ADD COLUMN is_credit INTEGER NOT NULL DEFAULT 0` (idempotent). | Không rollback được (SQLite không DROP COLUMN cũ) — nhưng cột có default 0 nên **vô hại**. |

### Bảng mới — giải thích ngắn

```
debt_accounts            1 tài khoản / khách (UNIQUE customer_id)
debt_transactions        SỔ CÁI append-only · UNIQUE(idempotency_key) · CHECK(amount>0) · CHECK(direction)
debt_customer_groups     UNIQUE(platform, group_id) — 1 group ↔ 1 khách
debt_staff_permissions   UNIQUE(staff_id, customer_id)
debt_audit_logs          before_data / after_data (JSON, đã lọc dữ liệu nhạy cảm)
debt_processed_events    UNIQUE(event_type, event_id) — chống xử lý lại
debt_bridge_events      Nhật ký adapter (platform, message_id UNIQUE)
```

---

## 5. QUY TẮC TÍNH CÔNG NỢ

### 5.1. Công thức số dư

```
Balance = Opening Balance
        + ORDER_DEBT          (nợ tự động từ đơn hàng DELIVERED)
        + MANUAL_DEBT         (nợ tay từ lệnh `-`)
        - PAYMENT             (tiền khách trả: lệnh `+` hoặc nhập tay)
        + ADJUSTMENT          (điều chỉnh có audit log)
        + REVERSAL            (đảo giao dịch — bù lại bút toán bị đảo)
```

`direction` quyết định dấu: `INCREASE` (+), `DECREASE` (−). `amount` luôn > 0.

### 5.2. Amount Customer Owes (tiền khách còn phải trả cho 1 đơn)

```
total_gross    = sales.total                        (đã trừ KM/mua xuất trong logic bán hàng)
total_paid     = Σ PAYMENT (ledger, reference=ORDER) ∪ order_debts.paid_amount
total_refunded = Σ REVERSAL/ADJUSTMENT giảm gắn với đơn
amount_owed    = MAX(0, total_gross − total_paid − total_refunded)
```

> ❌ **KHÔNG** mặc định lấy tổng đơn khi khách đã trả trước / trả một phần / trả đủ.

### 5.3. Điều kiện ghi công nợ

| Tình huống | Ghi ORDER_DEBT? |
|---|---|
| Tạo đơn (PENDING) | ❌ |
| Đang giao (IN_PROGRESS) | ❌ |
| Hủy đơn / giao thất bại | ❌ |
| Giao có sai lệch (DISCREPANCY) | ❌ (chế độ strict) |
| **Chuyển sang `DELIVERED`** | ✅ (1 lần duy nhất) |
| Giao lại / webhook lặp | ❌ (idempotent) |
| Server restart giữa chừng | ❌ (đã đánh dấu event) |

### 5.4. Lệnh `+` / `-`

| Lệnh | Ý nghĩa | Loại bút toán | Hướng |
|---|---|---|---|
| `+1000` | Khách trả 1.000.000đ | `PAYMENT` | DECREASE |
| `-1000` | Khách phát sinh thêm nợ 1.000.000đ | `MANUAL_DEBT` | INCREASE |

- Đơn vị nhập = **nghìn đồng** (1000 = 1.000.000đ), cấu hình qua `settings.debt_command_unit`.
- Cho phép khoảng trắng trước/sau: `" +1000 "` ✔
- **Từ chối**: `++1000`, `+0`, `+-1000`, `+abc`, `+ 1 000`, vượt hạn mức (`settings.debt_command_max_amount`), tin nhắn không phải lệnh.
- Lệnh `-` **tuyệt đối không** tạo đơn hàng Beer POS, **không** thay đổi doanh thu bán hàng.
- Phản hồi chỉ gửi **sau khi transaction DB commit thành công**.

### 5.5. Ràng buộc bất biến

1. Mỗi đơn chỉ có **một** bút toán `ORDER_DEBT` hiệu lực (`idempotency_key = order_debt:sale:<id>` UNIQUE).
2. `idempotency_key` UNIQUE → chống ghi trùng khi double-click / retry / webhook lặp.
3. Giao dịch **không bao giờ bị xoá vật lý** — sai thì `REVERSAL` (bút toán mới).
4. Mọi thay đổi đều có `debt_audit_logs`.
5. Ghi trong **DB transaction** (`db.transaction(...)`).
6. Thanh toán **bị chặn** khi vượt số dư công nợ (`OVERPAYMENT_BLOCKED`).

---

## 6. KẾT QUẢ KIỂM THỬ

```
Test Suites: 24 passed, 24 total
Tests:       541 passed, 541 total
```

### 14 test case bắt buộc

| # | Test case | Nơi kiểm thử | Kết quả |
|---|---|---|---|
| 1 | Ghi nhận đơn hàng Delivered | `order-integration.test.js` › Test 1 | ✔ |
| 2 | Không ghi nhận đơn chưa Delivered | `order-integration.test.js` › Test 2 | ✔ |
| 3 | Không ghi nhận trùng đơn | `order-integration.test.js` › Test 3 | ✔ |
| 4 | Ghi nhận thanh toán `+1000` | `api.test.js` › Quick Entry | ✔ |
| 5 | Nhân viên không có quyền nhập lệnh | `api.test.js` › Phân quyền | ✔ |
| 6 | Tin nhắn trùng messageId | `api.test.js` › Quick Entry | ✔ |
| 7 | Đơn hàng thanh toán một phần | `order-integration.test.js` › Test 4 | ✔ |
| 8 | Đơn hàng đã thanh toán đủ | `order-integration.test.js` › Test 5 | ✔ |
| 9 | Hủy đơn sau khi giao | `order-integration.test.js` › Test 6 | ✔ |
| 10 | Đảo giao dịch | `api.test.js` › Manual Debt/Adjust/Reverse | ✔ |
| 11 | Điều chỉnh công nợ | `api.test.js` › Manual Debt/Adjust/Reverse | ✔ |
| 12 | Hai giao dịch đồng thời | `api.test.js` › "Giao dịch đồng thời" (3 test) | ✔ |
| 13 | Server restart / xử lý lại event | `order-integration.test.js` › Test 8 (idempotent) | ✔ |
| 14 | Đối soát sổ công nợ với đơn hàng | `api.test.js` › "Đối soát" (4 test) | ✔ |

### Bổ sung

- **RBAC**: 401 không đăng nhập · 403 CUSTOMER ghi giao dịch · 403 STAFF chưa phân công · STAFF chỉ thấy khách được phân công · 403 STAFF điều chỉnh/đảo.
- **Toàn vẹn dữ liệu**: sau **mỗi** test đều assert `customers.debt == ledger balance == Σ signed(transactions)`.
- **Cú pháp lệnh sai**: 5 biến thể đều bị từ chối, số dư không đổi.

---

## 7. KẾT QUẢ KIỂM TRA DỮ LIỆU CŨ

```
Tổng bút toán      : 6
Khách có ledger    : 6
Tổng số dư công nợ: 12.577.000đ
Tài khoản công nợ  : 6
── Theo loại bút toán ──
  OPENING_BALANCE  INCREASE      6 bản ghi  12.577.000đ
── Lệch mirror customers.debt vs ledger ──
  ✅ Không có sai lệch
── Đối soát ──
  {"total":0,"critical":0,"warning":0,"missingOrderDebt":0,
   "duplicateOrderDebt":0,"mismatchMirror":0,"mismatchProjection":0,"orphan":0}
```

- Migration `scripts/migrate-debt-opening-balance.js` đã chuyển **12.577.000đ / 6 khách** từ `customers.debt` cũ sang ledger dạng `OPENING_BALANCE` (idempotent — chạy lại không tạo bản ghi trùng).
- **Không xoá** bản ghi cũ; `customers.debt` giữ nguyên giá trị và tiếp tục được đồng bộ tự động.
- Đối soát: **0 sai lệch** — không có đơn DELIVERED thiếu bút toán, không có giao dịch trùng, không có bút toán mồ côi.

---

## 8. TRẠNG THÁI TÍCH HỢP ZALO THỰC TẾ

### Kết luận: **NOT_AVAILABLE**

| Tiêu chí đánh giá | Kết quả |
|---|---|
| Kết nối Zalo Desktop bằng giải pháp **được phép** | ❌ Zalo không công bố API bot cho Zalo cá nhân |
| Nhận tin nhắn mới trong nhóm | ❌ Không có listener chính thức |
| Xác định `senderId` | ❌ Không có API |
| Xác định `groupId` | ❌ Không có API |
| Gửi phản hồi vào nhóm | ❌ Không có API |
| Ổn định phiên đăng nhập | ❌ DB mã hoá, không ổn định |
| Tuân thủ điều khoản | ❌ Tự động hoá bằng reverse-engineer vi phạm điều khoản |

### Những gì **KHÔNG** làm

- ❌ Không dùng Zalo OA (API chính thức yêu cầu OA — nằm ngoài phạm vi yêu cầu).
- ❌ Không tạo nhóm Zalo mới — giữ nguyên 100% nhóm cá nhân hiện tại.
- ❌ Không hardcode cookie/token, không lưu mật khẩu Zalo.
- ❌ Không vượt CAPTCHA hay cơ chế bảo vệ tài khoản.
- ❌ Không tự động gửi lệnh khi không xác định được người gửi.

### Đã triển khai thay thế

- **Adapter pattern** (`DebtZaloBridge`) — cùng interface, cùng pipeline kiểm tra; thay adapter **không cần sửa Debt Service**.
- **Quick Entry trên Beer POS** (`/debts`) — đầy đủ chức năng `+`/`-`, cùng parser, cùng phân quyền, cùng idempotency, cùng audit log.
- Thông báo phản hồi đúng format yêu cầu (mục 10) qua UI.

### Cách bật adapter khác (khi có phương án hợp lệ)

```bash
# .env
DEBT_ZALO_ADAPTER=zalo_personal   # hoặc: manual
```

Adapter mới chỉ cần implement: `isAvailable()`, `start()`, `stop()`, `onMessage(message)`, `sendToGroup(groupId, text)`, `getStatus()`.

---

## 9. HƯỚNG DẪN CẤU HÌNH NHÓM KHÁCH HÀNG

1. Vào **Sổ công nợ** → Tab **💬 Nhóm Zalo** → **➕ Liên kết nhóm Zalo**.
2. Chọn **Khách hàng**.
3. Nhập **Group ID** — mã nhóm do Zalo cấp (lấy từ Zalo Desktop / Zalo Web).
4. Nhập **Tên nhóm** (tùy chọn, giúp tra cứu).
5. Nền tảng: chỉ có **Zalo cá nhân** (`zalo_personal`). Hệ thống **từ chối** `zalo_oa`.
6. Lưu. Khách đó tự động xuất hiện trong cột "Nhóm Zalo" của Danh sách khách.

### Phân quyền nhân viên

1. Tab **🔐 Phân quyền** → **➕ Phân quyền nhân viên**.
2. Chọn nhân viên (`app_users` role STAFF/DRIVER) + khách hàng.
3. Nhân viên được phân công mới ghi được lệnh `+`/`-` cho khách đó.

> ⚠️ Hiện `app_users` chưa có tài khoản STAFF nào — cần tạo tài khoản trước khi phân quyền.

### Mapping group ↔ khách

| Nhóm | Khách |
|---|---|
| `zalo_personal` + `group_id` | `customer_id` (UNIQUE — 1 group chỉ thuộc 1 khách) |

Gỡ liên kết = chuyển `status = 'inactive'` (**không xoá vật lý**).

---

## 10. HƯỚNG DẪN SỬ DỤNG CHO NHÂN VIÊN

### Cách 1 — Quick Entry trên POS (khuyến nghị hiện tại)

1. Mở **Sổ công nợ** (`/debts`) → Tab **Tổng quan**.
2. Chọn **Khách hàng**.
3. Nhập lệnh vào ô: `+1000` (khách trả 1.000.000đ) hoặc `-1000` (khách phát sinh thêm nợ).
4. Bấm **Ghi nhận** (hoặc nút **+ Thu tiền** / **− Ghi nợ**).

### Cách 2 — Nhập thanh toán thủ công (có chọn nhân viên xác nhận)

Tab **Khách hàng** → chọn khách → **💵 Nhập thanh toán** → nhập số tiền + ghi chú → xác nhận.

### Cách 3 — Ghi nợ tay

Chi tiết khách → **📝 Ghi nợ tay** → số tiền + lý do.

> ⚠️ Lệnh `-` chỉ là **bút toán công nợ bổ sung**, KHÔNG tạo đơn hàng và KHÔNG ảnh hưởng doanh thu bán hàng.

### Quy tắc vàng

| Nhân viên | Được | Không được |
|---|---|---|
| **STAFF** | Ghi thanh toán / ghi nợ cho **khách được phân công**; xem sổ công nợ của các khách đó | Xoá giao dịch · Tự điều chỉnh công nợ · Đổi mapping khách · Xem khách khác |
| **ADMIN** | Tất cả: xem/ghi/điều chỉnh/đảo/quản lý nhóm/phân quyền/lịch sử | — |
| **CUSTOMER** | — | **Tuyệt đối không** ghi giao dịch qua lệnh bot |

### Khi ghi sai

Không xoá được. Nhờ **Admin** đảo giao dịch (Chi tiết khách → tab lịch sử → Đảo) — hệ thống tạo bút toán `REVERSAL` mới và ghi audit log.

---

## 11. QUY TRÌNH ROLLBACK

### Phạm vi

Module Sổ Công nợ là **additive** — thêm bảng & cột mới, không sửa/xoá dữ liệu kinh doanh cũ.

### Cấp 1 — Rollback UI/API (không đụng dữ liệu)

```bash
# 1. Gỡ route API
#    server.js: xoá dòng  app.use('/api/debt-ledger', require('./routes/api/debtLedger'));
# 2. Gỡ route trang
#    server.js: xoá dòng  app.get('/debts', ...)
# 3. Gỡ card dashboard (tuỳ chọn)
#    views/dashboard.html: xoá khối <a href="/debts" class="dsh-hub-card dsh-hub-card-debts" ...>
# 4. Khởi động lại
npm start
```

✅ `customers.debt`, `sales`, `order_debts`, `payments` **không bị ảnh hưởng**.

### Cấp 2 — Rollback migration (chỉ khi cần gỡ hẳn bảng)

```js
// Trong database/migration.js — chạy 1 lần:
// db.exec('DROP TABLE IF EXISTS debt_bridge_events');
// db.exec('DROP TABLE IF EXISTS debt_processed_events');
// db.exec('DROP TABLE IF EXISTS debt_audit_logs');
// db.exec('DROP TABLE IF EXISTS debt_staff_permissions');
// db.exec('DROP TABLE IF EXISTS debt_customer_groups');
// db.exec('DROP TABLE IF EXISTS debt_transactions');
// db.exec('DROP TABLE IF EXISTS debt_accounts');
// + xoá 6 setting có tiền tố 'debt_'
```

> ⚠️ Cấp 2 **xoá toàn bộ lịch sử sổ công nợ**. Chỉ dùng khi cần dựng lại từ đầu.

### Cấp 3 — Rollback logic tích hợp

```bash
# 1. DeliveryService.js  → gỡ block DebtOrderIntegration.onDeliveryStatusChanged (2 chỗ)
# 2. routes/api/sales.js  → gỡ hook is_credit / adjustOrderDebtAfterChange / reverseOrderDebt
# 3. src/services/DebtService.js → khôi phục bản gốc từ git
git checkout -- src/services/DebtService.js src/services/DailyReportService.js \
                   src/services/DeliveryService.js routes/api/sales.js
# 4. Khởi động lại
```

### Cấp 4 — Rollback dữ liệu công nợ

```bash
# 1. Backup trước (bắt buộc)
node scripts/backup-database.js          # hoặc dùng chức năng Backup trong UI

# 2. Kiểm tra trạng thái
node scripts/check-debt-data.js

# 3. Đảo giao dịch sai (append-only, không xoá)
node scripts/rollback-debt-test-tx.js <customerId>
```

### Backup bắt buộc trước mọi thao tác rollback

```bash
# Backup DB
Copy-Item database.sqlite "backups/database_before_rollback_$(Get-Date -Format yyyyMMdd_HHmmss).sqlite"
# Hoặc dùng: node scripts/backup-database.js
```

### Kiểm tra sau rollback

```bash
node scripts/check-debt-data.js   # mirror vs ledger, đối soát
npx jest --silent                 # toàn bộ test phải pass
```

---

## 12. DANH SÁCH API

| Method | Endpoint | Quyền | Mô tả |
|---|---|---|---|
| GET | `/api/debt-ledger/overview` | Auth | Tổng quan: tổng nợ, nợ hôm nay, thu hôm nay, top nợ |
| GET | `/api/debt-ledger/customers` | Auth | Danh sách khách + số dư (scope theo phân công) |
| GET | `/api/debt-ledger/customers/:id` | Auth + phân công | Chi tiết công nợ 1 khách |
| GET | `/api/debt-ledger/customers/:id/transactions` | Auth + phân công | Lịch sử giao dịch |
| POST | `/api/debt-ledger/payment` | Staff/Admin | Nhập thanh toán thủ công |
| POST | `/api/debt-ledger/manual-debt` | Staff/Admin | Ghi nợ tay (lệnh `-`) |
| POST | `/api/debt-ledger/adjust` | **Admin** | Điều chỉnh công nợ |
| POST | `/api/debt-ledger/reverse` | **Admin** | Đảo giao dịch |
| GET | `/api/debt-ledger/groups` | Auth | Danh sách nhóm Zalo |
| POST | `/api/debt-ledger/groups` | **Admin** | Liên kết nhóm ↔ khách (cấm Zalo OA) |
| DELETE | `/api/debt-ledger/groups/:id` | **Admin** | Gỡ liên kết (→ inactive) |
| GET | `/api/debt-ledger/permissions` | Auth | Danh sách phân quyền + danh sách NV |
| POST | `/api/debt-ledger/permissions` | **Admin** | Phân quyền |
| DELETE | `/api/debt-ledger/permissions` | **Admin** | Thu hồi quyền |
| GET | `/api/debt-ledger/bridge` | Auth | Trạng thái Zalo Bridge + đơn vị lệnh |
| POST | `/api/debt-ledger/quick-entry` | Staff/Admin | Quick Entry `+`/`-` |
| GET | `/api/debt-ledger/reconciliation` | **Admin** | Chạy đối soát (read-only) |
| POST | `/api/debt-ledger/reconciliation` | **Admin** | Xử lý sai lệch (có audit log) |
| GET | `/api/debt-ledger/reconciliation/customer/:id` | **Admin** | Đối soát 1 khách |
| GET | `/api/debt-ledger/audit` | **Admin** | Nhật ký sổ công nợ |

---

## 13. CẤU HÌNH (`settings`)

| Key | Mặc định | Ý nghĩa |
|---|---|---|
| `debt_command_unit` | `1000` | 1 đơn vị lệnh = 1.000đ |
| `debt_command_max_amount` | `100000` | Hạn mức/lệnh (tính theo đơn vị lệnh) |
| `debt_partial_delivery_policy` | `NONE` | Chính sách giao một phần (`NONE` \| `PROPORTIONAL`) |
| `debt_allow_overpayment` | `0` | Cho phép trả vượt (quyết định đã chốt: **block**) |
| `debt_zalo_bridge_status` | `NOT_AVAILABLE` | Trạng thái bridge |
| `debt_auto_record_on_delivered` | `0` | Tự ghi nợ cho mọi đơn giao chưa thanh toán (mặc định TẮT) |
