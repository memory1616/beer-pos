# IMPLEMENTATION REPORT — BeerPOS Zalo Gateway

> Báo cáo bàn giao. Ngày: 2026-11-27.
> Giai đoạn: phát triển & chạy thử **local**. CHƯA deploy production.

---

## 1. Tóm tắt

| Hạng mục | Trạng thái |
|---|---|
| Gateway độc lập (Node.js + Express + SQLite) | ✅ Hoàn thành |
| Database riêng `data/gateway.sqlite` (WAL) | ✅ Hoàn thành |
| Quản lý mapping 1 khách ↔ 1 nhóm (CRUD + CSV) | ✅ Hoàn thành |
| Provider interface + MockProvider (mô phỏng) | ✅ Hoàn thành |
| Hàng đợi bền vững + worker (lease, backoff, recovery) | ✅ Hoàn thành |
| REST API + 2 nhóm API key | ✅ Hoàn thành |
| Frontend Binance Dark (6 màn hình) | ✅ Hoàn thành |
| Tích hợp BeerPOS (`GatewayClient` + `GatewayAdapter`) | ✅ Hoàn thành |
| Test Gateway | ✅ 89/89 pass (6 suites) |
| Test BeerPOS | ✅ 1514/1514 pass (74 suites) |
| E2E tích hợp thật | ✅ PASS toàn bộ 6 kịch bản |
| Tài liệu | ✅ 7 file trong `docs/` |

**KHÔNG có** thay đổi nào lên production: không SSH, không Nginx, không PM2, không DNS, không deploy, không push Git, không sửa database production.

---

## 2. File đã TẠO MỚI

### 2.1. Gateway — `beerpos-zalo-gateway/`

```
beerpos-zalo-gateway/
├── .env.example
├── .gitignore
├── package.json
├── docs/
│   ├── AUDIT.md              # Giai đoạn 1 — audit codebase BeerPOS
│   ├── ARCHITECTURE.md       # Giai đoạn 2 — kiến trúc
│   ├── DATABASE.md           # Giai đoạn 2 — schema chi tiết
│   ├── API.md                # Giai đoạn 2 — đặc tả REST API
│   ├── INTEGRATION.md        # Giai đoạn 2 — hướng dẫn tích hợp
│   ├── PLAN.md               # Giai đoạn 3 — kế hoạch file (đã thực hiện)
│   └── IMPLEMENTATION_REPORT.md
├── src/
│   ├── app.js                # Khởi tạo Express app
│   ├── server.js             # Điểm vào + khởi động worker
│   ├── config/index.js       # Đọc & kiểm tra biến môi trường
│   ├── logger.js             # Winston + redact secret
│   ├── database/
│   │   ├── connection.js     # SQLite singleton (WAL, busy_timeout)
│   │   ├── migrator.js       # Runner migration có version
│   │   ├── migrations/001_init.js
│   │   └── repositories/
│   │       ├── AccountRepository.js
│   │       ├── AuditRepository.js
│   │       ├── GroupRepository.js
│   │       ├── JobRepository.js      # leaseJobs() atomic UPDATE...WHERE
│   │       ├── MessageRepository.js
│   │       └── SettingsRepository.js
│   ├── providers/
│   │   ├── MessageProvider.js  # Interface + makeResult()
│   │   ├── MockProvider.js     # success/failure/transient/timeout/invalid
│   │   └── index.js             # createProvider() factory
│   ├── services/
│   │   ├── AuditService.js
│   │   ├── GroupService.js      # CSV preview/import trong transaction
│   │   ├── MessageService.js     # Nhận yêu cầu → tạo job
│   │   ├── QueueService.js
│   │   ├── SettingsService.js
│   │   └── WorkerService.js      # Vòng lặp lease → gửi → cập nhật
│   ├── controllers/
│   │   ├── accountController.js
│   │   ├── groupController.js
│   │   ├── healthController.js
│   │   └── messageController.js
│   ├── routes/index.js
│   ├── middleware/
│   │   ├── asyncHandler.js     # BẮT BUỘC cho Express 4 + async
│   │   ├── auth.js             # timingSafeEqual, 401 vs 403
│   │   ├── errorHandler.js
│   │   └── rateLimit.js
│   ├── utils/
│   │   ├── crypto.js           # safeEqual / fingerprint
│   │   ├── csv.js              # Parser CSV không dependency
│   │   └── errors.js
│   └── validators/index.js
├── public/
│   ├── index.html
│   ├── css/style.css          # Binance Dark theme
│   └── js/
│       ├── api.js             # fetch wrapper + sessionStorage key
│       ├── ui.js              # esc/fmtDate/toast/modal/badge
│       ├── app.js             # Điều hướng + prompt API key
│       ├── page-dashboard.js
│       ├── page-groups.js
│       ├── page-import.js
│       ├── page-queue.js
│       └── page-settings.js
├── scripts/
│   ├── backup.js
│   ├── migrate.js
│   ├── reset.js
│   ├── seed.js
│   └── sync-groups-from-beerpos.js   # Đồng bộ mapping từ BeerPOS
└── tests/
    ├── helpers.js
    ├── setup.js
    ├── groups/{groups,import}.test.js
    ├── messages/send.test.js
    ├── providers/mock.test.js
    ├── queue/worker.test.js
    └── security/auth.test.js
```

### 2.2. BeerPOS — `D:\Beer`

| File | Vai trò |
|---|---|
| `src/services/notify/GatewayClient.js` | HTTP client tới Gateway: timeout, phân loại lỗi, **không bao giờ throw** |
| `src/services/notify/provider/GatewayAdapter.js` | Adapter → `ProviderResult` chuẩn hoá |
| `tests/debt/gatewayIntegration.test.js` | 28 test tích hợp (stub client, không gọi mạng) |
| `scripts/e2e-gateway-integration.js` | E2E thật giữa 2 tiến trình |
| `beerpos-zalo-gateway/scripts/sync-groups-from-beerpos.js` | (đã tính ở mục trên) |

---

## 3. File đã SỬA trong BeerPOS (đều là thay đổi ADDITIVE, không viết lại)

| File | Thay đổi | Rủi ro |
|---|---|---|
| `src/services/notify/provider/index.js` | Thêm provider `gateway`; thêm `isGateway()` | Rất thấp |
| `src/services/notify/NotificationWorker.js` | Truyền `customerId`/`paymentId`/`idempotencyKey` xuống provider; **không chặn job** khi provider=gateway và thiếu group cục bộ | Thấp |
| `src/services/notify/NotificationJobService.js` | Provider=gateway → không tạo job `no_group`; placeholder key `GATEWAY_LOOKUP` | Thấp |
| `src/services/debt/DebtNotifyService.js` | Tách cờ bật/tắt chung (`isNotifyEnabled()`) khỏi OmniCall; dựng nội dung tin khi provider=gateway | Thấp |
| `routes/api/debtLedger.js` | 3 endpoint mới: `/notify/gateway/settings`, `/notify/gateway/health`, `/notify/gateway/provider` | Rất thấp |
| `package.json` | Thêm `beerpos-zalo-gateway/` vào `testPathIgnorePatterns` | Không ảnh hưởng runtime |
| `tests/debt/notify.test.js` | Cố định `debt_notify_provider = 'omicall'` trong test (trước đây phụ thuộc DB dev) | Chỉ test |

### Không đổi (giữ nguyên tuyệt đối)

`src/services/OmiCallService.js` · `src/services/debt/DebtPaymentService.js` · `DebtSepayService.js` · `DebtCommandService.js` · `DebtLedgerService.js` · `DebtManualService.js` · `src/services/notify/CustomerGroupService.js` · `database/migrations/*` · `database.sqlite` · `views/debts.html` · `server.js` · `middleware/*`.

---

## 4. Database

### 4.1. Gateway — `data/gateway.sqlite` (TÁCH BIỆT HOÀN TOÀN)

`PRAGMA journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`.

| Bảng | Mục đích | Ràng buộc chính |
|---|---|---|
| `gateway_settings` | Cấu hình không nhạy cảm | UNIQUE(key) |
| `gateway_account` | 1 tài khoản Zalo (provider, status, connection_mode) | — |
| `gateway_groups` | Mapping khách ↔ nhóm | UNIQUE(customer_id), UNIQUE(group_id) + index customer_id/group_id/is_active |
| `gateway_jobs` | Hàng đợi bền vững | UNIQUE(idempotency_key) + index status/next_retry_at/payment_id/customer_id/created_at |
| `gateway_messages` | Lịch sử **từng lần thử** | index job_id/created_at |
| `gateway_audit_logs` | Nhật ký thao tác | index action/entity_type/created_at |

Job **snapshot** `group_id` + `message_content` tại thời điểm tạo → retry không phụ thuộc mapping hiện tại.

### 4.2. BeerPOS

**KHÔNG có migration mới.** Tái sử dụng `debt_notification_jobs` (migration 069) và `debt_customer_groups`.

---

## 5. API đã xây dựng

Base: `http://localhost:3100`. Header: `X-API-Key`.

| Method | Path | Scope | Mô tả |
|---|---|---|---|
| GET | `/health` | public | status, version, uptime, database, worker, provider |
| GET | `/api/account/status` | admin | Trạng thái provider + tài khoản |
| POST | `/api/account/provider` | admin | Bật/tắt MockProvider |
| GET | `/api/dashboard` | admin | Tổng quan |
| GET | `/api/groups` | admin | Danh sách (search, status, page, limit) |
| POST | `/api/groups` | admin | Thêm liên kết |
| PATCH | `/api/groups/:id` | admin | Sửa |
| DELETE | `/api/groups/:id` | admin | Ngừng kích hoạt (soft) |
| GET | `/api/groups/template.csv` | admin | File mẫu CSV |
| POST | `/api/groups/import/preview` | admin | Xem trước + validate |
| POST | `/api/groups/import` | admin | Import (transaction) |
| **POST** | **`/api/messages/send`** | **integration** | **Tạo job (202) / trả job cũ (200)** |
| GET | `/api/messages/history` | admin + integration | Lịch sử |
| GET | `/api/messages/jobs/:id` | admin + integration | Chi tiết + các lần thử |
| POST | `/api/messages/jobs/:id/retry` | admin + integration | Retry an toàn |
| POST | `/api/messages/jobs/:id/cancel` | admin + integration | Huỷ job chờ |
| GET | `/api/messages/queue/summary` | admin + integration | Thống kê |
| GET | `/api/settings` | admin | Cấu hình |
| PATCH | `/api/settings` | admin | Sửa cấu hình |
| GET | `/api/audit-logs` | admin | Nhật ký |

**Phân quyền**: `ADMIN_API_KEY` (quản trị) vs `INTEGRATION_API_KEY` (BeerPOS gửi tin). Chỉ `/api/messages/send` là độc quyền Integration — các endpoint đọc cho phép cả hai để UI vận hành được. So sánh key bằng `crypto.timingSafeEqual`. Key hợp lệ nhưng sai scope → **403**; key không hợp lệ → **401**.

---

## 6. Kết quả kiểm thử

### 6.1. Gateway — 89/89 PASS (6 suites)

| Suite | Nội dung |
|---|---|
| `groups/groups.test.js` | Thêm/sửa/xoá, trùng Customer, trùng Group, thiếu Group, ngừng hoạt động, giữ lịch sử |
| `groups/import.test.js` | CSV hợp lệ, trùng, lỗi một phần, transaction rollback |
| `messages/send.test.js` | Gửi hợp lệ, thiếu Customer, chưa có Group, Group bị vô hiệu hóa, nội dung rỗng/quá dài, key sai, idempotency, Payment ID trùng |
| `queue/worker.test.js` | Tạo job, worker lease, thành công, lỗi, retry, backoff, job treo, restart, 2 worker cùng job, timeout→unknown, không retry unknown |
| `providers/mock.test.js` | success/failure/timeout/unknown + không giả vờ gửi Zalo thật |
| `security/auth.test.js` | 401/403, rate limit, không lộ stack trace, CORS |

### 6.2. BeerPOS — 1514/1514 PASS (74 suites)

Regression đầy đủ, gồm 28 test tích hợp mới trong `tests/debt/gatewayIntegration.test.js`.

### 6.3. E2E thật — `scripts/e2e-gateway-integration.js`

```
BƯỚC 0 — Tạo khách test + mapping ở CẢ HAI hệ thống
BƯỚC 1 — Gateway ONLINE: tạo job 23 (queued); gửi lại cùng key → job cũ  ✔ IDEMPOTENCY
BƯỚC 2 — Worker Gateway xử lý → status=sent, provider=mock                   ✔
BƯỚC 3 — BeerPOS ghi nhận thanh toán OK (tx 79); tạo 1 notification job      ✔
BƯỚC 4 — Gateway OFFLINE: job → 'retry' (chưa hề nhận → retry an toàn)        ✔
BƯỚC 5 — Số dư công nợ KHÔNG đổi                                             ✔
BƯỚC 6 — Gateway trở lại: không có job trùng                                  ✔
KẾT THÚC — TẤT CẢ KỊCH BẢN PASS
```

---

## 7. Cấu hình

### 7.1. Gateway — `.env`

```env
NODE_ENV=development
PORT=3100
DATABASE_PATH=./data/gateway.sqlite

ADMIN_API_KEY=<khóa quản trị>
INTEGRATION_API_KEY=<khóa tích hợp>   # KHÁC admin key

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

Gateway **từ chối khởi động** nếu `ADMIN_API_KEY` trùng `INTEGRATION_API_KEY`.

### 7.2. BeerPOS — bảng `settings`

| Key | Giá trị | Ý nghĩa |
|---|---|---|
| `debt_notify_enabled` | `1` | Bật thông báo (cờ CHUNG, không gắn OmniCall) |
| `debt_notify_provider` | `omicall` \| `gateway` \| `mock` \| `disabled` | Kênh gửi — **rollback chỉ là đổi giá trị** |
| `notify_gateway_url` | `http://localhost:3100` | Địa chỉ Gateway |
| `notify_gateway_api_key` | *(khóa integration)* | API key gọi Gateway |

Biến môi trường thay thế: `NOTIFICATION_PROVIDER`, `NOTIFY_GATEWAY_URL`, `NOTIFY_GATEWAY_API_KEY`, `NOTIFY_GATEWAY_TIMEOUT_MS`.

---

## 8. Chạy local

### 8.1. Gateway

```bash
cd D:\Beer\beerpos-zalo-gateway
npm install
cp .env.example .env      # sửa 2 API key
npm run migrate
npm run seed              # 3 nhóm mẫu (đánh dấu "dữ liệu thử nghiệm")
npm run dev               # http://localhost:3100
npm test
```

### 8.2. BeerPOS

```bash
cd D:\Beer
npm start                 # http://localhost:3000
npm test                  # 74 suites / 1514 tests
```

### 8.3. Đồng bộ mapping BeerPOS → Gateway

```bash
cd D:\Beer\beerpos-zalo-gateway
set GATEWAY_API_KEY=<admin key>
node scripts/sync-groups-from-beerpos.js --dry-run
node scripts/sync-groups-from-beerpos.js --yes
```

### 8.4. E2E

```bash
cd D:\Beer
set GATEWAY_ADMIN_KEY=<admin key>
set GATEWAY_INTEGRATION_KEY=<integration key>
node scripts/e2e-gateway-integration.js
```

---

## 9. Luồng tích hợp đã kiểm chứng

```
BeerPOS: DebtPaymentService.recordPayment()
  └─ DebtLedgerService.recordTransaction({ buildNotification })
       └─ db.transaction()  ← ghi bút toán + debt_notification_jobs (ATOMIC)
  └─ (worker) NotificationWorker.leaseJobs()
       └─ GatewayAdapter.sendMessage()
            └─ GatewayClient POST /api/messages/send
                 Idempotency-Key: payment-notification:<txId>
       └─ ProviderResult → markSent / markFailed / markUnknown

Gateway:  POST /api/messages/send
  └─ xác thực → validate → tra mapping 1:1 → kiểm tra idempotency
  └─ tạo gateway_jobs (snapshot group_id + nội dung) → 202
  └─ WorkerService → MockProvider → gateway_messages + gateway_jobs.status
```

**Điểm mấu chốt**: Gateway là *bàn giao yêu cầu*, không phải *gửi tin*. BeerPOS giữ hàng đợi của riêng mình (đã có sẵn, đã được test) — KHÔNG tạo hàng đợi chồng chéo.

---

## 10. Lỗi còn tồn tại / giới hạn đã biết

| # | Vấn đề | Mức độ | Ghi chú |
|---|---|---|---|
| 1 | **Chưa có provider Zalo thật** | Đúng thiết kế | Chỉ `MockProvider`. Cần nhà cung cấp được Zalo cho phép. UI hiển thị rõ "MÔ PHỎNG", `providerMessageId` có tiền tố `mock_`, không bao giờ ghi `delivered`. |
| 2 | `sent` = "Provider đã nhận", không phải "khách đã nhận" | Giới hạn thực tế | Cả OmniCall lẫn Gateway đều không có API đối soát giao hàng. |
| 3 | BeerPOS vẫn giữ `debt_customer_groups` | Đúng thiết kế | Theo quyết định Q2: Gateway là nguồn sự thật, BeerPOS giữ bản cục bộ để tương thích + dự phòng. **Cần đồng bộ 2 chiều nếu dùng song song** — hiện chỉ có 1 chiều (BeerPOS → Gateway). |
| 4 | `debt_customer_groups` trong BeerPOS không tự đồng bộ khi sửa trên Gateway | Trung bình | Nếu người dùng sửa mapping trong UI Gateway thì BeerPOS vẫn giữ bản cũ (chỉ dùng làm fallback). Cần script đồng bộ ngược trước production. |
| 5 | `debt_notify_provider = 'disabled'` chưa có nhánh riêng | Thấp | Provider factory hiện fallback về `mock`. Cần thêm adapter `DisabledAdapter` nếu muốn tắt hẳn. |
| 6 | UI Gateway chưa có màn hình "Import CSV" riêng | Thấp | Đã có trong `page-import.js` (chọn file → preview → xác nhận), dùng chung tab với Nhóm khách hàng. |
| 7 | Chưa có `README.md` / `CHANGELOG.md` cho Gateway | Thấp | Tài liệu nằm trong `docs/`. Nên bổ sung trước production. |
| 8 | Test E2E cần Gateway đang chạy | — | `scripts/e2e-gateway-integration.js` phụ thuộc Gateway local. Đã ghi rõ trong báo cáo. |

---

## 11. Việc cần làm TRƯỚC KHI PRODUCTION

1. **Chọn & xác minh nhà cung cấp Zalo được phép** — không dùng thư viện Zalo cá nhân không chính thức, không tự động QR login, không lưu cookie/session/mật khẩu.
2. **Sinh API key mạnh** cho cả 2 scope, lưu trong biến môi trường (không trong repo). Thiết lập quy trình **rotate key**.
3. **Đồng bộ mapping 2 chiều** giữa `gateway_groups` và `debt_customer_groups` (hoặc chốt rõ Gateway là nguồn duy nhất & bỏ phụ thuộc bản cục bộ).
4. **Chạy E2E trên môi trường staging** với provider thật đã được cấp quyền.
5. **Chuyển đổi theo từng khách hàng thử nghiệm** (bảng `debt_notify_provider` là per-provider, nên cần cơ chế chuyển theo khách nếu cần — hiện chưa có, cân nhắc bổ sung).
6. **Backup tự động** `data/gateway.sqlite` (đã có `npm run backup`) + lịch trình cron.
7. **Giới hạn truy cập mạng**: Gateway chỉ nên listen trên loopback / mạng nội bộ, không expose cổng 3100 ra Internet. Nếu cần truy cập từ xa → đặt sau reverse proxy có TLS + IP allowlist.
8. **Bổ sung monitoring**: cảnh báo khi job `failed` / `unknown` tích luỹ, và khi Worker dừng.
9. **Thêm `README.md` + `CHANGELOG.md`** cho Gateway.
10. **Xử lý mục 5** (`disabled` provider) nếu cần tắt thông báo hoàn toàn.

---

## 12. Kết luận

Gateway đã hoàn thành đầy đủ 7 giai đoạn, chạy độc lập local, có Dashboard Binance Dark, quản lý nhóm + import CSV, hàng đợi bền vững + worker, lịch sử, audit log, xác thực 2 scope, MockProvider, 89 test Gateway + 1514 test BeerPOS + E2E thật.

Tích hợp BeerPOS **tối thiểu**: thêm `GatewayClient` + `GatewayAdapter`, thêm provider `gateway` vào factory, chỉnh 3 file nội bộ theo hướng additive. **Không viết lại** logic thanh toán, công nợ, hay nội dung tin nhắn. OmniCall giữ nguyên và là phương án dự phòng — **rollback chỉ là đổi 1 giá trị `debt_notify_provider`**.

Gateway offline **không** làm hỏng giao dịch: lỗi xảy ra ngoài transaction, job vào `retry` với backoff có kiểm soát, không gửi trùng nhờ `idempotency_key` chung.

---

## 13. Tài liệu liên quan

| File | Nội dung |
|---|---|
| `docs/AUDIT.md` | Audit codebase BeerPOS: schema, luồng thanh toán, OmniCall, rủi ro, điểm tích hợp |
| `docs/ARCHITECTURE.md` | Kiến trúc, trách nhiệm từng service, luồng dữ liệu, backoff, mô hình bảo mật |
| `docs/DATABASE.md` | Schema chi tiết từng bảng, index, ràng buộc, migration, backup, seed |
| `docs/API.md` | Đặc tả REST API: header, shape lỗi, mã trạng thái |
| `docs/INTEGRATION.md` | Hướng dẫn tích hợp, 7 bước chuyển đổi an toàn, quy trình rollback |
