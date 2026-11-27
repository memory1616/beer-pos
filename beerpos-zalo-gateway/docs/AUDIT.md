# AUDIT — BeerPOS & Trạng thái hiện tại

> Giai đoạn 1 của dự án **BeerPOS Zalo Gateway**.
> Audit chỉ ĐỌC — không sửa file nghiệp vụ, không chạy lệnh production.
> Ngày audit: 2026-11-27 · Repo: `D:\Beer` (`memory1616/beer-pos`) · Branch: `main` @ `807db4a`

---

## 1. Trạng thái Git

| Hạng mục | Hiện trạng |
|---|---|
| Branch hiện tại | `main` (còn: `backup/pos-modal-cd5be05`, `cleanup/audit-2026-11-12`, `feature/driver-portal`, 3 worktree-agent) |
| HEAD | `807db4a` — *fix(omicall): nút "Tải nhóm" luôn lấy nhóm MỚI, tự vá link nhóm đã chết* |
| Working tree | **CÓ thay đổi chưa commit** (12 modified + 5 untracked) — xem mục 2 |
| Stash | Không có |
| Remote | `origin/main` — **không push** trong phạm vi dự án này |

### 1.1 Thay đổi chưa commit (từ phiên phát triển trước)

Đây là hệ thống thông báo nội bộ đã hoàn thành, **chưa commit**:

```
 M .env.example                      M src/services/debt/DebtPaymentService.js
 M database.js                       M src/services/debt/DebtSepayService.js
 M database/migration.js             M src/services/debt/DebtNotifyService.js
 M routes/api/debtLedger.js          M src/services/debt/DebtLedgerService.js
 M server.js                         M src/services/debt/DebtCommandService.js
 M tests/debts-view.test.js          M views/debts.html
?? database/migrations/069_debt_notification_jobs.js
?? src/services/notify/              (7 file)
?? tests/debt/notifyJob.test.js      (47 test)
?? scripts/{audit-notify-schema,e2e-notify-api,e2e-notify-flow}.js
```

**Trạng thái kiểm thử đã xác nhận:** `npx jest` → **73 suites / 1485 tests PASS, 0 FAIL**.
DB local sạch (0 job / 0 group / 0 notification test residue).

> ⚠️ Đây chính là **queue + provider abstraction** mà Gateway sẽ phải phối hợp. Không được ghi đè.

---

## 2. Cấu trúc hiện tại (thực tế)

```
D:\Beer\
├── server.js                    # Express app (~1800 dòng), khởi động sau app.listen
├── database.js                  # better-sqlite3 + auto-run migrations
├── database/
│   ├── migration.js             # run*Migration() cho từng migration
│   └── migrations/001..069      # 069 = debt_notification_jobs (chưa commit)
├── middleware/                  # auth.js, permissions.js, validation.js, errorHandler.js, auditLog.js
├── routes/api/                  # 37 router file, gồm debtLedger.js (60KB)
├── src/
│   ├── services/
│   │   ├── OmiCallService.js    # 65KB — HTTP client tới OmniCall
│   │   ├── NotificationService.js # Kênh báo cáo ngày (Zalo OA / Telegram / Webhook) — KHÁC mục đích
│   │   ├── ReportNotifyService.js
│   │   ├── ZaloOAuthService.js  # OAuth cho Zalo OA (báo cáo)
│   │   ├── debt/                # 14 file nghiệp vụ sổ công nợ
│   │   └── notify/              # 7 file (chưa commit) — provider abstraction + queue
│   └── utils/logger.js          # winston
├── views/debts.html             # UI sổ công nợ (Binance Dark Theme)
├── public/                      # PWA assets
├── tests/                       # 73 suite
└── scripts/                     # 50+ script vận hành
```

**Công nghệ:** Node.js v20.20.1, Express 4.18, better-sqlite3 9.4, winston 3.19,
express-rate-limit 8.3, helmet, compression, node-cron, jest 29 + supertest.

> **Không có** `multer`, `csv-parse`, `cors` chính thức trong `package.json` (chỉ `cors` xuất hiện ở
> `node_modules` do dependency phụ). Gateway cần cài thêm dependency riêng.

---

## 3. Luồng thanh toán & phát sinh thông báo (đọc code thực tế)

### 3.1 Các luồng ghi bút toán công nợ

| Luồng | Service | Hướng | Có tạo job thông báo? |
|---|---|---|---|
| Thanh toán thủ công (UI) | `DebtPaymentService.recordPayment()` | DECREASE | ✅ **Có** (transactional outbox) |
| SePay tự động gạch nợ | `DebtSepayService.processTransaction()` | DECREASE | ✅ **Có** |
| Lệnh `+` (nhận tiền) | `DebtCommandService.processCommand()` | DECREASE | ✅ **Có** |
| Ghi nợ tay (UI) | `DebtManualService.recordManualDebt()` | INCREASE | ⚠️ **KHÔNG** — chỉ `notifyManualDebtAsync` (mặc định tắt, `debt_notify_manual_debt=0`) |
| Điều chỉnh công nợ | `DebtManualService.adjustDebt()` | +/- | ❌ Không |
| Đảo giao dịch (REVERSAL) | `DebtManualService.reverseTransaction()` | — | ❌ Không |
| Ghi nợ tay qua lệnh `-` | `DebtCommandService` | INCREASE | ⚠️ Tùy setting |

### 3.2 Đường đi của thông báo (đã hoạt động)

```
DebtPaymentService / DebtSepayService / DebtCommandService
  └─ DebtLedgerService.recordTransaction({ buildNotification: fn })
        └─ [TRONG CÙNG db.transaction()]  ← TRANSACTIONAL OUTBOX
              NotificationJobService.insertJobInTransaction(payload)
                  └─ INSERT OR IGNORE debt_notification_jobs (idempotency_key UNIQUE)
  └─ (fallback) DebtNotifyService.notifyPaymentAsync() → dispatch() → enqueuePaymentNotification()

NotificationWorker (nền, mỗi 15s)
  └─ NotificationJobService.leaseJobs()  ← locked_until / locked_by
  └─ ProviderFactory.getProvider()  →  'omicall' (mặc định) | 'mock'
        ├─ OmniCallAdapter → OmiCallService.sendZaloPersonalMessage({convId, text})
        └─ MockZaloAdapter → mô phỏng, KHÔNG gọi mạng
  └─ markSent() / markFailed() / retryJob()  (backoff 1/5/15/60/180 phút, max 5)
  └─ ghi vào debt_notifications (lịch sử, tương thích ngược)
```

### 3.3 Cơ chế transaction & outbox

`DebtLedgerService.recordTransaction()` bọc toàn bộ ghi bút toán trong `db.transaction()`.
Hook `buildNotification(ctx)` được gọi **sau khi ghi bút toán, trong cùng transaction** →
job và bút toán atomic. Lỗi hook được `try/catch` riêng → **không bao giờ làm hỏng thanh toán**.

> ✅ Đây chính là cơ chế mà yêu cầu §10 ("nên dùng transactional outbox nếu phù hợp") muốn.
> **Không cần tạo queue thứ hai trong BeerPOS.**

---

## 4. Schema thực tế (đã đọc từ `database.sqlite`)

### 4.1 `debt_customer_groups` (migration 053 + index từ 069)

```sql
CREATE TABLE debt_customer_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  platform    TEXT NOT NULL,
  group_id    TEXT NOT NULL,
  group_name  TEXT,
  status      TEXT NOT NULL DEFAULT 'active',   -- active | inactive
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_debt_groups_platform_gid     ON (platform, group_id);
CREATE INDEX        idx_debt_groups_customer          ON (customer_id);
CREATE UNIQUE INDEX idx_debt_groups_platform_customer ON (platform, customer_id);  -- ← migration 069
```

**Dữ liệu hiện tại: 0 dòng.** 38 khách hàng, **chưa khách nào liên kết nhóm**.

### 4.2 `debt_notification_jobs` (migration 069, chưa commit) — 30 cột

Snapshot `group_id` + `content_snapshot` tại thời điểm tạo job.
`idempotency_key TEXT UNIQUE` theo `eventType:tx:<transactionId>:grp:<groupId>`.
Index: `status`, `next_retry_at`, `customer_id`, `transaction_id`, `created_at`, `locked_until`.

### 4.3 `debt_notifications` (migration 062) — lịch sử, giữ nguyên

`status`: `pending` | `sent` | `failed` | `skipped`. Có `transaction_id`, `content`, `error`.
**Dữ liệu hiện tại: 0 dòng.**

### 4.4 Settings liên quan (đọc từ DB, đã mask secret)

| Key | Value | Ghi chú |
|---|---|---|
| `debt_notify_enabled` | `0` | **TẮT** — thông báo chưa bật |
| `debt_notify_provider` | `omicall` | Provider đang dùng |
| `debt_notify_channel` | `omicall_zalo_personal` | |
| `debt_notify_manual_debt` | `0` | Ghi nợ tay không gửi tin |
| `debt_notify_worker_enabled` | `1` | Worker nền đang chạy |
| `debt_notify_worker_interval_ms` | `15000` | |
| `debt_notify_job_batch_size` | `10` | |
| `debt_notify_job_lease_ms` | `120000` | |
| `debt_notify_retry_max_attempts` | `5` | |
| `debt_notify_retry_base_delay_ms` | `60000` | Backoff 1/5/15/60/180 phút |
| `debt_notify_title` | `BIA TƯƠI — Cập nhật công nợ` | |
| `omicall_api_key` | *(rỗng)* | **Chưa có API key** |
| `omicall_base_url` | `https://public-v1.omicall.com` | |
| `debt_zalo_bridge_status` | `NOT_AVAILABLE` | Zalo cá nhân không khả dụng |

---

## 5. OmniCall — hiện trạng và giới hạn

### 5.1 Giao diện đã dùng

`OmiCallService.sendZaloPersonalMessage({ convId, text, groupName })`
→ `POST {base}/omni_conv/message/send_text?lng=vi` body `{ convId, text }`
→ `status_code: 9999` = **đã tiếp nhận** (KHÔNG phải đã gửi tới).

**Không có API đối soát giao hàng** → `deliveryStatus` chỉ có thể là `accepted`.

### 5.2 Các khả năng đã có (có thể tái dùng cho mapping)

| Hàm | Công dụng | Có dùng cho auto-heal? |
|---|---|---|
| `listConversations()` | Liệt kê hội thoại từ OmniCall | ❌ Không tự động (yêu cầu: không đồng bộ hội thoại) |
| `resolveLiveConvId()` | Tìm conv đang "sống" theo tên | ⚠️ Chỉ dùng khi admin bấm nút |
| `findLiveConversationByName()` | Tìm theo tên | ⚠️ Như trên |
| `classifyConversationState()` | Phân loại conv (live/dead) | ❌ |
| `assignAgentToGroup()` | Thêm agent vào nhóm | ❌ Không tự động |
| `ensureAgentInGroup()` | Bảo đảm agent trong nhóm | ❌ |
| `diagnoseAccount()` | Chẩn đoán tài khoản | ❌ |
| `probeSendEndpoints()` | Dò endpoint gửi | ❌ |

### 5.3 Auto-heal (đã có, cần biết)

`DebtNotifyService.saveHealedConvId()` — khi phát hiện conv đã chết, hệ thống **tự cập nhật**
`group_id` sang conv mới (nếu conv mới chưa thuộc khách khác — kiểm tra UNIQUE).
Commit `888c9d3` mở rộng: nút "Tải nhóm" luôn lấy nhóm MỚI.

> ⚠️ Gateway (DB riêng) **không** có quyền tự auto-heal → phải có API admin để admin xác nhận.

---

## 6. Đối chiếu: chức năng cũ ↔ kiến trúc Gateway

| # | Chức năng Gateway yêu cầu | Hiện có ở BeerPOS? | Nguồn | Kế hoạch |
|---|---|---|---|---|
| 1 | DB riêng `data/gateway.sqlite` | ❌ | — | 🆕 Tạo mới trong Gateway |
| 2 | `gateway_settings` | ⚠️ Có `settings` (chung BeerPOS) | `database.sqlite` | 🆕 Bảng riêng trong Gateway |
| 3 | `gateway_account` | ❌ | — | 🆕 Tạo mới |
| 4 | `gateway_groups` (mapping) | ✅ Có `debt_customer_groups` | migration 053/069 | 🔄 **Nguồn dữ liệu**: Gateway là hệ thống chủ sở hữu mapping; BeerPOS giữ bản cũ để tương thích |
| 5 | `gateway_jobs` (queue) | ✅ Có `debt_notification_jobs` | migration 069 | 🔄 **Tái sử dụng logic**, nhưng queue nằm ở Gateway (DB riêng) |
| 6 | `gateway_messages` (lịch sử từng lần thử) | ⚠️ `debt_notifications` chỉ 1 dòng/job | migration 062 | 🔄 Bổ sung bảng lần-thử ở Gateway |
| 7 | `gateway_audit_logs` | ✅ Có `debt_audit_logs` + `audit_logs` | migration 053/056 | 🔄 Gateway có bảng riêng |
| 8 | `MessageProvider` interface | ✅ Có `NotificationProvider` + 2 adapter | `src/services/notify/provider/` | ♻️ **Tái sử dụng nguyên văn** sang Gateway |
| 9 | `MockProvider` | ✅ Có `MockZaloAdapter` | `src/services/notify/provider/` | ♻️ Tái sử dụng |
| 10 | Worker (lease, retry, backoff, recovery) | ✅ Có `NotificationWorker` | `src/services/notify/` | ♻️ Tái sử dụng nguyên văn |
| 11 | API nhận tin (`POST /api/messages/send`) | ❌ | — | 🆕 Tạo ở Gateway |
| 12 | Idempotency (`Idempotency-Key`) | ✅ Có `idempotency_key` | migration 069 | ♻️ Tái sử dụng pattern |
| 13 | Import CSV | ❌ | — | 🆕 Tạo ở Gateway |
| 14 | Dashboard (UI Binance Dark) | ⚠️ Có trong `views/debts.html` | — | 🆕 UI riêng cho Gateway |
| 15 | RBAC (admin vs integration) | ✅ Session-based (`requireAuth`/`requireAdmin`/`requireStaff`) | `middleware/auth.js` | 🔄 Gateway dùng **API key** (2 nhóm) theo yêu cầu |
| 16 | Rate limit / CORS / helmet | ✅ Có sẵn | `server.js` | ♻️ Tái sử dụng pattern |
| 17 | Structured logging | ✅ Có `src/utils/logger.js` | — | ♻️ Tái sử dụng |
| 18 | Test framework | ✅ jest + supertest | `package.json` | ♻️ Dùng jest |

### 6.1 Nhận xét quan trọng

- **Không có gì cần viết lại từ đầu.** Provider abstraction, worker, queue engine, idempotency,
  backoff, recovery, audit pattern — đã có và đã test (47 test).
- **Tránh 2 queue chồng nhau.** Yêu cầu §10 cảnh báo đúng điểm này.
  → **Chiến lược:** Gateway là nơi duy nhất gửi tin qua HTTP; BeerPOS **dispatch** thông báo
  qua Gateway thay vì gọi OmniCall trực tiếp. Queue *nội bộ* của BeerPOS vẫn giữ (để không
  mất giao dịch khi Gateway offline) nhưng **không gửi trực tiếp** — nó chỉ chờ.
- **Mapping nằm ở 2 nơi.** Đề xuất: **Gateway là nguồn chân lý** (`gateway_groups`), BeerPOS
  đọc/ghi qua API Gateway khi cần; bảng `debt_customer_groups` cũ giữ nguyên để không phá
  nghiệp vụ đang chạy (fallback khi Gateway offline).

---

## 7. File cần thay đổi / tuyệt đối không đổi

### 7.1 Tuyệt đối KHÔNG đổi (theo quy tắc kế thừa)

| File | Lý do |
|---|---|
| `src/services/OmiCallService.js` | Provider đang chạy. Gateway bọc adapter, không sửa service này. |
| `src/services/debt/DebtNotifyService.js` | Điều phối thông báo + format nội dung đang dùng. |
| `src/services/debt/DebtPaymentService.js` | Nghiệp vụ thanh toán. |
| `src/services/debt/DebtSepayService.js` | Nghiệp vụ SePay. |
| `src/services/debt/DebtZaloBridge.js` | Adapter pattern sẵn có. |
| `src/services/debt/DebtLedgerService.js` | Sổ công nợ. |
| `src/services/debt/DebtManualService.js` | Ghi nợ/điều chỉnh/đảo giao dịch. |
| `src/services/debt/DebtCommandService.js` | Parser lệnh `+`/`-`. |
| `database/migrations/*` (đã có) | Không sửa migration cũ. |
| `views/debts.html` (phần nghiệp vụ) | UI sổ công nợ đang chạy. |
| `database.sqlite` | Dữ liệu vận hành. |

### 7.2 Cần THÊM (mới, không sửa file cũ)

| File | Vai trò |
|---|---|
| `src/services/notify/GatewayClient.js` (BeerPOS) | HTTP client gọi Gateway. **File mới.** |
| `src/services/notify/provider/GatewayAdapter.js` (BeerPOS) | Provider adapter gọi Gateway. **File mới.** |
| `src/services/notify/provider/index.js` (BeerPOS) | Thêm nhánh `'gateway'`. **Sửa nhỏ, additive.** |
| `routes/api/debtLedger.js` (BeerPOS) | Thêm endpoint tra cứu trạng thái job từ Gateway (nếu cần). **Sửa nhỏ, additive.** |

### 7.3 Gateway — toàn bộ file MỚI trong `beerpos-zalo-gateway/`

Không đụng vào BeerPOS.

---

## 8. Rủi ro

| # | Rủi ro | Mức | Giảm thiểu |
|---|---|---|---|
| R1 | **Gateway offline làm mất thông báo** | 🔴 Cao | BeerPOS giữ queue nội bộ (`debt_notification_jobs`) → retry/reconciliation sang Gateway. Không rollback thanh toán. |
| R2 | **Gửi trùng khi chuyển đổi** | 🔴 Cao | Cấu hình `OMICALL | GATEWAY | DISABLED` — **chỉ 1 nguồn gửi hoạt động**. Idempotency key dùng chung giữa 2 hệ thống. |
| R3 | **Mapping ở 2 DB lệch nhau** | 🟠 TB | Gateway là nguồn chân lý; BeerPOS đồng bộ 1 chiều + fallback khi Gateway offline. |
| R4 | **DB local có `.sqlite-wal`/`-shm`** | 🟠 TB | Test dùng `DB_PATH` riêng (pattern `tests/setup.js`); dọn WAL khi copy. |
| R5 | **File lock `src/logs/combined.log`** | 🟠 TB | Đã gặp: `EPERM` làm fail 6 test suite. Gateway dùng log dir riêng. |
| R6 | **Đổi `customer_id` giữa 2 hệ thống** | 🟠 TB | Gateway nhận `customerId` dạng **string** (không ép int) → linh hoạt. |
| R7 | **Zalo cá nhân không có API chính thức** | 🔴 Cao (đã biết) | Chỉ dùng `MockProvider` + adapter `OMICALL`. Không connector không chính thức. |
| R8 | **Content snapshot không khớp với Gateway** | 🟡 Thấp | Gateway nhận `message` (nội dung đã dựng) — không tự dựng lại. |
| R9 | **Process BeerPOS đang chạy giữ file** | 🟡 Thấp | Dừng `server.js` local khi chạy test song song. |
| R10 | **Working tree chưa commit** | 🟠 TB | Đề xuất commit hệ thống thông báo nội bộ **trước** khi tích hợp Gateway (giữ nguyên mốc khôi phục). |

---

## 9. Phương án tích hợp tối thiểu (đề xuất)

### 9.1 Nguyên tắc

> **Chỉ thay đổi nơi gửi thông báo — KHÔNG thay đổi nơi phát sinh thông báo.**

### 9.2 Luồng sau tích hợp

```
BeerPOS: DebtPaymentService / DebtSepayService / DebtCommandService
   └─ DebtLedgerService.recordTransaction({ buildNotification })   [KHÔNG ĐỔI]
        └─ debt_notification_jobs (queue nội bộ BeerPOS)           [KHÔNG ĐỔI]
             └─ NotificationWorker                                  [KHÔNG ĐỔI]
                  └─ ProviderFactory.getProvider()
                       ├─ 'omicall'  → OmniCallAdapter  (mặc định, giữ nguyên)
                       └─ 'gateway' → GatewayAdapter    [MỚI]
                            └─ HTTP → Gateway :3100
                                 POST /api/messages/send
                                 Idempotency-Key: payment-notification-<txId>
                                 ├─ tìm gateway_groups theo customerId
                                 ├─ tạo gateway_jobs
                                 └─ Gateway Worker → MockProvider/Adapter
```

### 9.3 Cấu hình chuyển đổi (rollback được bằng 1 biến)

```
settings.debt_notify_provider = 'omicall'   (mặc định — hành vi hiện tại)
                      ↓
settings.debt_notify_provider = 'gateway'   (chuyển sang Gateway)
                      ↓
settings.debt_notify_provider = 'disabled'  (tắt hoàn toàn)
```

> Đổi 1 giá trị trong DB → **không sửa code**, rollback tức thì.

### 9.4 Phạm vi code BeerPOS (nhỏ, additive)

| File | Thay đổi | Rủi ro |
|---|---|---|
| `src/services/notify/provider/GatewayAdapter.js` | **MỚI** | Không |
| `src/services/notify/provider/index.js` | Thêm `case 'gateway'` (~10 dòng) | Rất thấp |
| `src/services/notify/GatewayClient.js` | **MỚI** — HTTP client, timeout, retry | Không |
| `routes/api/debtLedger.js` | (tùy chọn) endpoint tra cứu | Rất thấp |

**Không sửa:** `DebtPaymentService`, `DebtSepayService`, `DebtCommandService`, `DebtLedgerService`,
`DebtNotifyService`, `OmiCallService`, `DebtZaloBridge`, `views/debts.html`, `database.sqlite`.

---

## 10. Kết luận Audit

| Kết luận | Nội dung |
|---|---|
| ✅ Có thể tái sử dụng lượng lớn | Provider interface, MockProvider, Worker, Queue engine, Idempotency, Backoff, Recovery, Audit pattern, Log, Test framework — **đã có & đã test**. |
| ✅ Không cần viết lại logic công nợ | Outbox đã nằm trong `recordTransaction()`. |
| ⚠️ Cần quyết định (Giai đoạn 3) | Nguồn chân lý của mapping (`gateway_groups` vs `debt_customer_groups`). |
| ⚠️ Cần quyết định (Giai đoạn 3) | Có commit hệ thống thông báo nội bộ trước khi tích hợp không. |
| 🚫 Rủi ro chặn | Zalo cá nhân **không có API chính thức** → `MockProvider` là hợp lệ duy nhất ở giai đoạn này. OmniCall giữ nguyên làm provider dự phòng. |

**Không có hành động nào được thực hiện lên production.** Audit thuần read-only + 1 lần đọc DB local.
