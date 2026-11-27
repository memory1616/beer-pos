# ARCHITECTURE — BeerPOS Zalo Gateway

> Giai đoạn 2. Bổ sung cho [`AUDIT.md`](./AUDIT.md).

---

## 1. Nguyên tắc kiến trúc

| # | Nguyên tắc | Hệ quả |
|---|---|---|
| A1 | **Tách biệt** — Gateway là process + database riêng, không dùng chung DB với BeerPOS | BeerPOS không `require` file nào của Gateway |
| A2 | **1 chiều** — BeerPOS → Gateway. Gateway không bao giờ gọi ngược BeerPOS | Gateway không cần biết cấu trúc sổ công nợ |
| A3 | **Không gửi trong request** — HTTP chỉ *tiếp nhận*, worker *gửi* | Provider chậm không giữ request mở |
| A4 | **Không mất thông báo** — BeerPOS giữ queue nội bộ làm buffer khi Gateway offline | Payment không bao giờ rollback vì lỗi Gateway |
| A5 | **Không gửi trùng** — idempotency key xuyên suốt 2 hệ thống | Retry an toàn |
| A6 | **Snapshot bất biến** — group_id + nội dung lưu lúc tạo job | Retry không đổi nội dung giao dịch cũ |
| A7 | **Không tuyên bố vượt quá provider** — `accepted` ≠ `delivered` | UI không nói "đã gửi tới Zalo" khi chưa chắc |
| A8 | **Đơn giản > phức tạp** — 1 tài khoản, 1 kênh, không microservices | Không Redis, không WebSocket, không multi-tenant |

---

## 2. Sơ đồ tổng thể

```
┌──────────────────────────────────────────────────────────────────┐
│                        BeerPOS  (D:\Beer)                        │
│                                                                   │
│  DebtPaymentService / DebtSepayService / DebtCommandService       │
│          │                                                        │
│          ▼                                                        │
│  DebtLedgerService.recordTransaction({ buildNotification })      │
│          │  ← CÙNG db.transaction()  (transactional outbox)       │
│          ▼                                                        │
│  debt_notification_jobs   (queue nội bộ — buffer khi GW offline)  │
│          │                                                        │
│          ▼                                                        │
│  NotificationWorker ──► ProviderFactory                          │
│                            ├─ omicall → OmniCallAdapter ──┐      │
│                            └─ gateway → GatewayAdapter ──┐ │      │
│                                                        │ │      │
└────────────────────────────────────────────────────────┼─┼──────┘
                                                         │ │
              Idempotency-Key: payment-notification-<tx> │ │
                                                         ▼ ▼
┌──────────────────────────────────────────────────────────────────┐
│              BeerPOS Zalo Gateway  (:3100)                        │
│                                                                    │
│  POST /api/messages/send   [Integration API Key]                  │
│        │                                                           │
│        ├─ auth (timing-safe compare)                              │
│        ├─ validate (customerId, message, idempotency)             │
│        ├─ lookup gateway_groups  (1 khách → 1 group)              │
│        ├─ idempotency check  (UNIQUE idempotency_key)             │
│        ├─ INSERT gateway_jobs (snapshot group_id + content)       │
│        └─ 202 { jobId, status: 'queued' }                         │
│                                                                    │
│  WorkerService (poll 2s, lease 60s)                              │
│        │                                                           │
│        ├─ lease gateway_jobs (locked_until / locked_by)           │
│        ├─ MessageProvider.sendMessage()                           │
│        │      └─ MockProvider (mặc định) | AuthorizedProvider     │
│        ├─ ghi gateway_messages (mỗi lần thử 1 dòng)               │
│        └─ markSent / retry (10s/30s/2m/5m) / failed / unknown     │
│                                                                    │
│  gateway_groups · gateway_jobs · gateway_messages                 │
│  gateway_settings · gateway_account · gateway_audit_logs          │
│  data/gateway.sqlite                                             │
│                                                                    │
│  Admin UI (:3100) — Dashboard · Kết nối · Nhóm · Hàng đợi ·      │
│                      Lịch sử · Cấu hình                             │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Trách nhiệm từng thành phần

### 3.1 Gateway

| Thành phần | Trách nhiệm | KHÔNG làm |
|---|---|---|
| `config/` | Đọc env, validate, default an toàn | Không đọc file DB |
| `database/connection.js` | Mở SQLite, WAL, busy_timeout | Không chạy migration tự động lúc require |
| `database/migrations/` | Schema có version, `up`/`down` | Không đụng DB khác |
| `providers/MessageProvider` | Interface + `ProviderResult` chuẩn | Không biết DB |
| `providers/MockProvider` | Mô phỏng 5 kịch bản | Không gọi mạng |
| `services/GroupService` | CRUD mapping, conflict, CSV import | Không gửi tin |
| `services/QueueService` | Tạo/lease/retry/cancel job | Không gọi provider |
| `services/WorkerService` | Vòng lặp worker | Không chứa SQL |
| `services/MessageService` | Điều phối: nhận → validate → enqueue | Không tự lưu trực tiếp |
| `services/AuditService` | Ghi thao tác quan trọng | Không ghi secret |
| `controllers/` + `routes/` | HTTP, status code, error shape | Không chứa SQL |
| `middleware/auth` | 2 nhóm API key (admin / integration) | Không log key |
| `validators/` | Validate input | — |

### 3.2 BeerPOS (phần tích hợp)

| Thành phần | Trách nhiệm | KHÔNG làm |
|---|---|---|
| `GatewayClient` | HTTP client + timeout + retry | Không ghi DB |
| `GatewayAdapter` | Provider → `ProviderResult` | Không biết HTTP |
| `provider/index.js` | Chọn provider theo config | Không xoá provider cũ |
| `NotificationWorker` (đã có) | Lease job → gọi provider | Không đổi |

---

## 4. Luồng dữ liệu chi tiết

### 4.1 Tiếp nhận tin (BeerPOS → Gateway)

```
1. NotificationWorker.leaseJobs() lấy job từ debt_notification_jobs
2. GatewayAdapter.sendMessage({ groupId?, customerId, message, paymentId })
   ⚠️ KHÔNG truyền groupId — Gateway tự tra mapping (chống gửi nhầm nhóm)
3. GatewayClient → POST /api/messages/send
   Headers: X-API-Key: <INTEGRATION_API_KEY>
            Idempotency-Key: payment-notification-<txId>
   Body:    { paymentId, customerId, message }
4. Gateway:
   a. auth → 401 nếu sai key
   b. validate → 400 nếu thiếu customerId / message rỗng / quá dài
   c. lookup gateway_groups (customer_id, is_active=1)
        → không có → 404 { code: 'CUSTOMER_GROUP_NOT_LINKED' }
   d. INSERT OR IGNORE gateway_jobs (idempotency_key UNIQUE)
        → trùng → trả job cũ, KHÔNG tạo mới
   e. 202 { success, accepted, jobId, status, provider }
5. GatewayAdapter nhận 202 → markSent(BeerPOS) → ghi lịch sử
   Nhận 404/4xx → markFailed, retryable=false → không retry mù
   Nhận lỗi mạng/timeout → ProviderResult retryable=true → retry theo backoff
```

**Điểm mấu chốt:** `groupId` **không** do BeerPOS truyền. Gateway tự tra → không thể gửi nhầm
nhóm, đúng quy tắc "1 khách = 1 nhóm".

### 4.2 Worker Gateway

```
loop (mỗi 2s, unref'd):
  1. recoverStaleJobs()      → job processing quá hạn lease → queued
  2. leaseJobs(limit=1)      → UPDATE ... SET locked_by, locked_until
                                WHERE id IN (...) AND status IN ('queued','retry')
                                  AND (next_retry_at IS NULL OR next_retry_at <= now)
  3. Nếu không có job → return (không busy-wait)
  4. Với mỗi job:
     a. provider.sendMessage({ groupId: job.group_id, text: job.message_content })
        ⚠️ DÙNG group_id SNAPSHOT — không tra lại mapping hiện tại
     b. Ghi gateway_messages (1 dòng / lần thử)
     c. Phân loại:
        success + accepted        → status='sent'
        success + delivered       → status='sent', delivery='delivered'
        lỗi tạm thời              → status='retry', next_retry_at = backoff(attempts)
        lỗi vĩnh viễn             → status='failed'
        timeout (không rõ)        → status='unknown'  ⚠️ KHÔNG tự retry
  5. KHÔNG giữ transaction DB mở trong lúc gọi provider
```

### 4.3 Backoff

| Lần | Chờ |
|---|---|
| 1 | 10 giây |
| 2 | 30 giây |
| 3 | 2 phút |
| 4 | 5 phút |

Max 4 lần thử (mặc định). Tất cả configurable.

---

## 5. Provider abstraction

### 5.1 Interface

```js
class MessageProvider {
  getStatus()               // → { provider, available, reason, simulated, ... }
  validateDestination(dest) // → { valid, code, message }
  sendMessage(payload)      // → ProviderResult
  getCapabilities()         // → { sendMessage, deliveryConfirmation, ... }
}
```

### 5.2 `ProviderResult` (chuẩn hóa)

```js
{
  success: boolean,
  providerMessageId: string|null,
  errorCode: string|null,
  errorMessage: string|null,
  acceptedAt: ISO|null,
  deliveryStatus: 'accepted'|'delivered'|'failed'|'unknown',
  retryable: boolean,
  raw: object            // response provider (KHÔNG chứa secret)
}
```

### 5.3 MockProvider — kịch bản

| Scenario | Kết quả | `deliveryStatus` | `retryable` |
|---|---|---|---|
| `success` | ok | `accepted` | — |
| `failure` | lỗi vĩnh viễn | `failed` | `false` |
| `transient` | lỗi tạm thời | `failed` | `true` |
| `timeout` | không rõ | `unknown` | `false` (không retry mù) |
| `invalid_destination` | dest sai | `failed` | `false` |

> ⚠️ Mock **không bao giờ** trả `deliveryStatus: 'delivered'`.
> `providerMessageId` có tiền tố `mock_`. UI hiển thị nhãn **MOCK**.

---

## 6. Bảo mật

| Lớp | Cơ chế |
|---|---|
| Xác thực | 2 API key: `ADMIN_API_KEY` (quản trị) & `INTEGRATION_API_KEY` (BeerPOS). So sánh **timing-safe** (`crypto.timingSafeEqual`). |
| Rate limit | `express-rate-limit` — riêng cho `/api/messages/send` (BeerPOS) và cho admin. |
| CORS | Allowlist `CORS_ORIGINS`; mặc định chỉ localhost. |
| Helmet | `helmet()` — CSP, X-Frame-Options, HSTS (chỉ production). |
| Validate | Tất cả input qua `validators/`; giới hạn độ dài message. |
| Rate limit theo key | Không log API key. Chỉ log fingerprint (`sha256` 8 ký tự). |
| Error shape | `{ success, error, code }` — **không** stack trace ra ngoài (chỉ log nội bộ). |
| DB | Gateway không nhận SQL từ client. Frontend gọi qua API, không mở DB. |
| Secret | Chỉ trong env. `gateway_settings` KHÔNG lưu key. Log không ghi key. |
| Rotate key | Đổi env + restart; hỗ trợ nhiều key qua `KEYS` (comma) để rotate không downtime. |
| Backup | Script `scripts/backup.js` — copy file SQLite (dùng `.backup()` API). |

---

## 7. Cấu hình

```env
NODE_ENV=development
PORT=3100
DATABASE_PATH=./data/gateway.sqlite

ADMIN_API_KEY=...
INTEGRATION_API_KEY=...

MESSAGE_PROVIDER=mock

WORKER_ENABLED=true
WORKER_CONCURRENCY=1
WORKER_POLL_INTERVAL=2000
WORKER_MAX_ATTEMPTS=4
WORKER_LEASE_MS=60000

RETRY_DELAYS_MS=10000,30000,120000,300000
MAX_MESSAGE_LENGTH=2000

RATE_LIMIT_SEND=300
RATE_LIMIT_ADMIN=600
CORS_ORIGINS=http://localhost:3100
```

---

## 8. Ranh giới trách nhiệm

| Thuộc Gateway | Thuộc BeerPOS |
|---|---|
| Tra cứu `customerId → groupId` | Biết khách hàng là ai, số dư công nợ bao nhiêu |
| Queue & worker gửi tin | Phát sinh sự kiện thanh toán |
| Lịch sử gửi (Gateway view) | Lịch sử công nợ, sổ nợ |
| Audit thao tác mapping/import | Audit nghiệp vụ công nợ |
| Dashboard vận hành Gateway | UI sổ công nợ (views/debts.html) |
| **KHÔNG** biết số dư công nợ | **KHÔNG** gửi tin trực tiếp khi provider='gateway' |

---

## 9. Quyết định thiết kế đã chốt (Giai đoạn 3)

| # | Quyết định | Lý do |
|---|---|---|
| D1 | `gateway_groups` là **nguồn chân lý** của mapping; BeerPOS giữ `debt_customer_groups` để tương thích | Không phá nghiệp vụ đang chạy; Gateway độc lập |
| D2 | Gateway **không** nhận `groupId` từ BeerPOS | Chống gửi nhầm nhóm — đúng quy tắc 1:1 |
| D3 | `idempotency_key` dùng **cùng format** 2 hệ thống: `payment-notification:<txId>` | Retry an toàn khi chuyển đổi |
| D4 | Worker poll 2s, lease 60s, concurrency 1 | Quy mô ~100 khách — không cần phức tạp |
| D5 | `unknown` **không** tự retry | Tránh tin trùng |
| D6 | Dùng `express` + `better-sqlite3` + `winston` + `jest` | Cùng hệ sinh thái BeerPOS → dễ vận hành |
| D7 | CSV parse tự viết (không thêm `csv-parse`) | Tránh thêm dependency; CSV 5 cột đơn giản |
| D8 | Upload CSV qua `text/csv` raw body (không dùng multer) | Không cần multipart → giảm dependency & bề mặt tấn công |
| D9 | `sent` = provider **đã chấp nhận**, không phải đã tới | Không khẳng định vượt quá provider |
| D10 | BeerPOS giữ `debt_notification_jobs` làm buffer; Gateway có `gateway_jobs` làm hàng đợi thật | Gateway offline không mất thông báo (R1) |
