# Audit Phương Án Thay Thế OmniCall — BeerPOS + BeerPOS Zalo Gateway

> Giai đoạn READ-ONLY AUDIT. Không sửa code, không tạo provider thật, không thay đổi database, không deploy, không push Git.

Ngày audit: 2026-11-27
Phạm vi: `D:\Beer` (BeerPOS) + `D:\Beer\beerpos-zalo-gateway` (Gateway)

## 0. Tài liệu đầu vào — trạng thái

| Tài liệu | Đường dẫn | Trạng thái |
|---|---|---|
| Audit kết nối OmniCall | `docs/OMICALL_CONNECTION_AUDIT.md` | FOUND (413 dòng) |
| Báo cáo bàn giao | `beerpos-zalo-gateway/docs/IMPLEMENTATION_REPORT.md` | FOUND (309 dòng) |
| Audit Gateway | `beerpos-zalo-gateway/docs/AUDIT.md` | FOUND (279 dòng) |
| Kiến trúc | `beerpos-zalo-gateway/docs/ARCHITECTURE.md` | FOUND (236 dòng) |
| Database | `beerpos-zalo-gateway/docs/DATABASE.md` | FOUND (270 dòng) |
| API | `beerpos-zalo-gateway/docs/API.md` | FOUND (241 dòng) |
| Tích hợp | `beerpos-zalo-gateway/docs/INTEGRATION.md` | FOUND (99 dòng) |

Không có tài liệu nào `NOT_FOUND`.

## 1. Executive Summary

**Kết luận: CONDITIONAL GO.**

Bốn phát hiện then chốt:

1. **Gateway đã sẵn sàng về kiến trúc hạ tầng, nhưng chưa có provider gửi tin thật nào.** `src/providers/index.js:60-73` chỉ có `MockProvider`; mọi tên khác rơi vào `UnauthorizedProvider` (`src/providers/index.js:14-51`). Gateway là **đường đi đúng**, không phải là phương án thay thế.

2. **Group ID hiện tại là ID nội bộ của OmniCall (Mongo `_id` 24 hex), KHÔNG phải ID nhóm Zalo gốc.** Nhà cung cấp khác **không thể dùng trực tiếp** giá trị này. Đây là rào cản lớn nhất, không phải vấn đề kỹ thuật API.

3. **Không tồn tại API chính thức nào của Zalo cho phép gửi bằng tài khoản cá nhân vào nhóm cá nhân hiện có.** Zalo Open API chỉ hỗ trợ OA (danh tính người gửi = OA, không phải tài khoản cá nhân của chủ quán) và GMF (nhóm do OA tạo và quản lý — vi phạm ràng buộc mục tiêu I.6 và I.7).

4. **Các nhà cung cấp bên thứ ba có API kỹ thuật thật** (Func.vn, Cogover, ZaloAI, ZaloX) và giá niêm yết công khai, nhưng **quyền sử dụng đối với Zalo đều `NOT VERIFIED`** — tài liệu chính thức của chính họ cũng cảnh báo rủi ro khóa tài khoản. Không phương án nào đạt đủ 8 tiêu chí `GO` của mục XI.

**Khuyến nghị:** `Gateway + OmniCall` (giữ nguyên provider hiện tại, chuyển hạ tầng sang Gateway) là bước trung gian có giá trị, nhưng **không tiết kiệm chi phí**. Để **loại bỏ 350.000đ/tháng** mà vẫn giữ tài khoản cá nhân + 100 nhóm + đúng danh tính người gửi, phương án duy nhất khả thi về mặt kỹ thuật là **provider bên thứ ba dạng QR-login** — với điều kiện `NOT VERIFIED` về quyền sử dụng phải được chủ hệ thống chấp nhận rủi ro rõ ràng.

---

## 2. Mục tiêu và ràng buộc

### 2.1. Mục tiêu kinh doanh (từ mục I)

| # | Yêu cầu | Bắt buộc |
|---|---|---|
| G1 | Tiếp tục dùng tài khoản Zalo cá nhân hiện tại | ✅ |
| G2 | Giữ nguyên ~100 nhóm Zalo đang hoạt động | ✅ |
| G3 | Mỗi nhóm giữ chủ quán/khách hàng, chủ tài khoản Zalo, tài xế | ✅ |
| G4 | Tin công nợ hiển thị đúng danh tính tài khoản Zalo cá nhân | ✅ |
| G5 | BeerPOS tự động gửi thông báo vào đúng nhóm khách hàng | ✅ |
| G6 | Không yêu cầu khách hàng tham gia nhóm mới | ✅ |
| G7 | Không chuyển sang Zalo OA / GMF trong phương án chính | ✅ |
| G8 | Loại bỏ ~350.000đ/tháng chi phí OmniCall | 🎯 mục tiêu |
| G9 | Giữ nguyên nghiệp vụ công nợ, nội dung tin, retry, lịch sử, hàng đợi | ✅ |
| G10 | Rollback an toàn | ✅ |

### 2.2. Ràng buộc kỹ thuật đã xác minh

| Ràng buộc | Nguồn |
|---|---|
| Zalo **không có** API chính thức cho tài khoản cá nhân | `docs.zaloplatforms.com` (chỉ OA / ZBS / Mini App); `zachat.vn/blog/zalo-ca-nhan-co-api-khong` (2026-11-18) |
| OmniCall `conv_id` = Mongo `_id` 24 hex của conversation OmniCall | `src/services/OmiCallService.js:388-392`, `:487-490` |
| Group ID là duy nhất của OmniCall, không phải ID Zalo gốc | `src/services/OmiCallService.js:479-483` |
| Không có API đối soát giao hàng từ OmniCall | `src/services/notify/provider/OmniCallAdapter.js:174-176` |
| Gateway chỉ có MockProvider | `beerpos-zalo-gateway/src/providers/index.js:60-73` |

---

## 3. Kiến trúc hiện tại — đối chiếu trực tiếp source code

### 3.1. Chuỗi gọi đầy đủ

```
DebtPaymentService.js:184  ┐
DebtSepayService.js:1276   ├─► DebtNotifyService.notifyPaymentAsync()
DebtCommandService.js:417  ┘        │
                                       ▼
              NotificationJobService.enqueueJob()   → debt_notification_jobs
                                       │
                                       ▼
              NotificationWorker (nền, lease + retry)
                                       │
                                       ▼
              ProviderFactory.getProvider()  (src/services/notify/provider/index.js:78-93)
                                       │
                 ┌─────────────────────┼─────────────────────┐
                 ▼                     ▼                     ▼
        MockZaloAdapter        OmniCallAdapter          GatewayAdapter
                 │                     │                     │
                 │              OmiCallService           GatewayClient
                 │              (src/services/           (src/services/notify/
                 │               OmiCallService.js)       GatewayClient.js)
                 │                     │                     │
                 └────────► HTTPS ──────┴────► HTTP :3100 ────┘
                                        │
                                   OmniCall SaaS
                              (public-v1.omicall.com →
                               social-network-v1.omicrm.com)
                                        │
                                   Zalo cá nhân
                                        │
                              100 nhóm khách hàng
```

### 3.2. Trả lời 14 câu hỏi mục III (kèm dòng code)

**① Điểm tạo notification job**

- `src/services/debt/DebtPaymentService.js:184` → `DebtNotifyService.notifyPaymentAsync({...})`
- `src/services/debt/DebtSepayService.js:1276` → tương tự (SePay webhook)
- `src/services/debt/DebtCommandService.js:417` → tương tự (lệnh `+` ghi nợ)
- Bên trong: `src/services/debt/DebtNotifyService.js` → `NotificationJobService.enqueueJob()` ghi vào bảng `debt_notification_jobs` (migration `069_debt_notification_jobs.js`).

**② Cơ chế idempotency**

- BeerPOS: cột `idempotency_key TEXT UNIQUE` (`database/migrations/069_debt_notification_jobs.js:82`), key = `transaction_id + event_type + group_id`.
- Gateway: cột `idempotency_key TEXT NOT NULL UNIQUE` (`beerpos-zalo-gateway/src/database/migrations/001_init.js:83`), check trước khi insert tại `beerpos-zalo-gateway/src/services/QueueService.js:33-37` và `:52-56` (bắt race UNIQUE).
- Key xuyên suốt: `buildGatewayIdempotencyKey()` trong `src/services/notify/NotificationWorker.js` → `payment-notification:<txId>`.
- Lớp phòng thủ thứ ba: `DebtNotifyService.alreadyNotified()` (`DebtNotifyService.js:210-225`) — kiểm tra `debt_notifications` đã có dòng `status='sent'` cho cùng transaction.

**③ Cơ chế lease và retry**

- Lease: `beerpos-zalo-gateway/src/database/repositories/JobRepository.js:58-91` — `UPDATE ... WHERE id = ? AND status IN ('queued','retry')`, đặt `locked_until = datetime('now', '+N seconds')`, `locked_by = workerId`, `attempts = attempts + 1`. Chỉ worker thắng `res.changes === 1` mới nhận job → không 2 worker cùng xử lý 1 job.
- Recovery: `JobRepository.recoverStaleJobs()` (`:94-110`) — job `processing` quá `locked_until` → trả về `queued`.
- Backoff: `WorkerService.processJob()` (`beerpos-zalo-gateway/src/services/WorkerService.js:209-220`) dùng `settings.getRetryDelays()` = `[10000, 30000, 120000, 300000]` ms (`SettingsService.js:60-68`).
- BeerPOS side: `src/services/notify/NotificationJobService.js:518` + `backoffDelayMs()` (`:571-580`).

**④ Cơ chế xử lý timeout**

- Gateway: `WorkerService._callProvider()` (`beerpos-zalo-gateway/src/services/WorkerService.js:241-273`) — `Promise.race` với timer; khi timeout, đánh dấu `e.uncertain = true` → trả `deliveryStatus: 'unknown', retryable: false`.
- `WorkerService.processJob()` (`:196-205`): nếu `deliveryStatus === 'unknown'` → `markUnknown()`, **không** retry tự động.
- `QueueService.retry()` (`beerpos-zalo-gateway/src/services/QueueService.js:114-121`): ném `conflict('UNSAFE_RETRY')` nếu job đang `unknown`.
- BeerPOS: `GatewayClient.request()` phân biệt timeout (AbortError) vs connection refused; `GatewayAdapter.classifyGatewayError()` map timeout → `ERROR_CODES.TIMEOUT` + `unknown: true`, connection refused → `TEMPORARY_ERROR` + `retryable: true`.

**⑤ Cách xác định khách hàng và nhóm nhận**

- `DebtNotifyService.findConvId()` (`DebtNotifyService.js:106-117`) → `NotificationJobService.findCustomerGroup()` (`src/services/notify/NotificationJobService.js:111-165`).
- Query: `SELECT id, group_id, group_name FROM debt_customer_groups WHERE customer_id = ? AND platform = 'zalo_personal' AND status = 'active'`.
- Nếu >1 dòng active → **không gửi**, trả `ambiguous: true` (báo lỗi dữ liệu thay vì gửi nhầm nhóm).
- Phía Gateway: `MessageService.accept()` (`beerpos-zalo-gateway/src/services/MessageService.js:59-64`) → `GroupService.findActive(customerId)` → lỗi `CUSTOMER_GROUP_NOT_LINKED` nếu không có mapping active.

**⑥ Cách lưu Group ID**

- Bảng `debt_customer_groups` (`database/migrations/053_debt_management.js:169-190`): `customer_id`, `platform`, `group_id`, `group_name`, `status`.
- Unique: `idx_debt_groups_platform_gid` UNIQUE `(platform, group_id)`; thêm `idx_debt_groups_platform_customer` UNIQUE `(platform, customer_id)` tại migration 069 (`069_debt_notification_jobs.js:157-159`).
- Quản lý qua `src/services/notify/CustomerGroupService.js` (`upsert` `:158-260`, `unlink` `:263-290`, `setStatus` `:293-311`, `checkConflicts` `:318-338`).
- Bản sao phía Gateway: `gateway_groups` (`beerpos-zalo-gateway/src/database/migrations/001_init.js:62-68`) — **hiện là hai nguồn mapping độc lập** (xem mục 10.4).

**⑦ Cách lấy `channel_id`**

- `OmiCallService.fetchChannelId()` (`src/services/OmiCallService.js:420-471`).
- Endpoint: `POST {host}/omnichannel/channel/get_all`, body `{}`.
- Đọc `payload.zalo_personal[0].uid` (fallback `channel_id`, `_id`).
- Cache RAM 30 phút (`channelIdCache`, TTL `CHANNEL_ID_TTL_MS` — `OmiCallService.js:53-55`).
- Fix 2026-11-22: trước đây nuốt im lặng lỗi → `channel_id` rỗng → OmiCall trả `error_occurred` không chẩn đoán được. Nay ghi log và **không gửi tin khi thiếu `channel_id`** (`OmiCallService.js:756-768`).

**⑧ Cách xác thực API OmniCall**

- `OmiCallService.requestAuthToken()` (`OmiCallService.js:189-276`): 3 chiến lược lần lượt — `POST /api/auth?apiKey=` + body, `POST /api/auth` + body, `GET /api/auth?apiKey=`.
- Body luôn kèm `{ apiKey, tenantId: '', lng: 'vi' }` (thiếu `tenantId` → upstream HTTP 500).
- Token hạn 24h, cache RAM với margin 30 phút (`TOKEN_TTL_MS`, `TOKEN_REFRESH_MARGIN_MS` — `:41-42`).
- Header gửi tin: `x-api-key: <key>` + `Authorization: Bearer <token>` (`:729-735`).
- So sánh an toàn: không có; việc so sánh ở phía OmiCall.

**⑨ Cách gửi tin**

- `OmiCallService.sendZaloPersonalMessage()` (`OmiCallService.js:700-965`).
- Endpoint: `POST {host}/omni_conv/message/send_text?lng=vi`, body `{ conv_id, channel_id, text }`.
- Vòng lặp thử: host (2-3) × path (2) × body variant (4) = tối đa 24 lần gọi.
- `conv_id` phải là Mongo `_id` 24 hex; nếu là số → `resolveMongoConvId()` (`:478-529`) tra cứu `search_v4` để ánh xạ.
- Phân biệt host web app (trả HTML) với host API: regex `/^\s*<(!doctype|html)/i` (`:794`).

**⑩ Cách phát hiện conversation đã chết**

- `OmiCallService.classifyConversationState()` (`OmiCallService.js:1315-1357`).
- Ba tín hiệu: `conv.status === 'inactive'`; `conv.last_message.type === 'activity'` mà không có `message_id`; `conv.chat_session.joined_agents` là mảng rỗng.
- Lọc + gộp trùng tên: `pickLiveConversations()` (`OmiCallService.js:1574-1615`).

**⑪ Cách auto-heal khi agent rời nhóm và tham gia lại**

Kích hoạt bởi lỗi `error_occurred` hoặc `user_not_permision` (`OmiCallService.js:833-935`), theo thứ tự:

1. `ensureAgentInGroup()` (`:559-630`) → `POST /conversation/add_member_from_list` (`:573-597`) rồi fallback `POST /omi_v2/conversation/join` (`:605-627`).
2. Nếu vẫn lỗi → `resolveLiveConvId()` (`:1630-1690`) → `listConversationsBoth()` → tìm conv sống cùng tên → gửi lại với `convId` mới.
3. Nếu vẫn lỗi → `clearTokenCache()` + `channelIdCache.clear()` → gọi lại với token và `channel_id` mới.
4. Trả về `{ healedFrom, healedTo }` (`:907`).

Lưu ý: `POST /conversation/add_member` (thêm `member`) **không** được dùng — trả 200 + `payload: true` nhưng không đổi trạng thái nhóm (ghi chú `OmiCallService.js:536-545`). Tương tự, tuyệt đối không dùng `redistribute_from_list` với `remove` (`:547-552`).

**⑫ Cách cập nhật Group ID sau auto-heal**

- `DebtNotifyService.saveHealedConvId()` (`DebtNotifyService.js:129-166`): `UPDATE debt_customer_groups SET group_id = ? WHERE id = ?`, có check trùng `UNIQUE(platform, group_id)` trước khi ghi đè (`:137-152`).
- Đồng bộ hàng loạt: `routes/api/debtLedger.js:1113-1224` (`GET /notify/conversations`) tự sửa mapping conv chết theo tên nhóm.
- **Gateway hiện KHÔNG có cơ chế này** — `gateway_groups` không tự cập nhật. Đây là gap bắt buộc (mục 10.3).

**⑬ Các route admin gọi trực tiếp `OmiCallService`**

| Route | Method `OmiCallService` | Dòng |
|---|---|---|
| `POST /notify/settings` | `saveConfig()` | `routes/api/debtLedger.js:880` |
| `POST /notify/test-send` | `sendZaloPersonalMessage()` | `routes/api/debtLedger.js:1083` |
| `GET /notify/probe` | `probeSendEndpoints()` | `routes/api/debtLedger.js:1101` |
| `GET /notify/conversations` | `listConversations()` / `listConversationsBoth()` | `routes/api/debtLedger.js:1125-1126` |
| `GET /notify/diagnose` | `diagnoseAccount()` | `routes/api/debtLedger.js:1227` |
| `POST /notify/customer-groups` | `assignAgentToGroup()` | `routes/api/debtLedger.js:602` |
| `GET /notify/settings` | `getPublicConfig()` | `routes/api/debtLedger.js:865` |

Đây là các thao tác quản trị chủ động (chẩn đoán, gán agent, đồng bộ conv) — không phải đường gửi tin sản xuất.

**⑭ Mức độ phụ thuộc OmniCall**

| Thành phần | Mức phụ thuộc | Ghi chú |
|---|---|---|
| `src/services/OmiCallService.js` | **TOÀN BỘ** | 1700+ dòng, toàn bộ logic OmniCall |
| `src/services/notify/provider/OmniCallAdapter.js` | **TOÀN BỘ** | Bọc + `classifyOmicallError()` |
| `src/services/debt/DebtNotifyService.js` | **TRUNG BÌNH** | 5 chỗ đọc `OmiCallService.getConfig()` (`:327,452,529,601,654`) + `saveHealedConvId()` |
| `src/services/notify/provider/index.js` | **THẤP** | Enum provider, dễ thêm case |
| `src/services/notify/NotificationWorker.js` | **THẤP** | Chỉ qua `ProviderFactory` |
| `src/services/notify/NotificationJobService.js` | **THẤP** | Không biết OmniCall tồn tại |
| `src/services/notify/CustomerGroupService.js` | **THẤP** | Chỉ biết `group_id` là chuỗi |
| `database/migrations/062`, `069` | **THẤP** | Schema trung lập |
| `routes/api/debtLedger.js` | **TRUNG BÌNH** | 7 route gọi trực tiếp (xem ⑬) |
| `views/debts.html` | **THẤP** | Hiển thị cấu hình provider |

---

## 4. Các điểm phụ thuộc OmniCall (tổng hợp)

### 4.1. Bản chất phụ thuộc: KHÔNG có mã hóa dữ liệu OmniCall

Phụ thuộc nằm ở **tầng giao thức**, không phải tầng dữ liệu:

| Tầng | Có phụ thuộc không | Chi tiết |
|---|---|---|
| Schema DB (`debt_customer_groups`, `debt_notification_jobs`, `debt_notifications`) | ❌ Không | `group_id` là `TEXT` chung |
| Nghiệp vụ công nợ (`DebtPaymentService`, `DebtSepayService`) | ❌ Không | Chỉ gọi `notifyPaymentAsync()` |
| Nội dung tin nhắn (`buildPaymentMessage`) | ❌ Không | Chuỗi thuần |
| Outbox / worker / retry | ❌ Không | Provider-agnostic |
| **Giao thức gửi tin** | ✅ **Có** | `conv_id` + `channel_id` + `text`, host riêng, token 24h |
| **Định danh nhóm** | ✅ **Có** | Mongo `_id` của OmniCall |
| **Vòng đời nhóm** | ✅ **Có** | Conv chết → tạo conv mới → auto-heal |

**Hệ quả thuận lợi:** vì phụ thuộc nằm ở tầng giao thức, `Gateway` có thể thay OmniCall mà **không cần sửa nghiệp vụ công nợ**. Đây là cơ sở của thiết kế mục 10.

### 4.2. Điểm phụ thuộc không thể tránh: `group_id` là ID của OmniCall

Chuỗi bằng chứng:

1. `OmiCallService.js:479-483` — comment: "`conv_id` là **Mongo `_id`** (24 ký tự hex) của hội thoại".
2. `OmiCallService.js:487-490` — `resolveMongoConvId()` nếu không khớp `/^[a-f0-9]{24}$/i` thì tra cứu để ánh xạ.
3. `OmiCallService.js:388-392` — "Nếu truyền `conv_id` dạng số (`conv.conv_id`) → OmiCall trả `user_not_permision`".
4. `OmiCallService.js:1245-1250` — mapping response: `convId: it.id || conv._id` (Mongo `_id`), `convNumber: conv.conv_id` (số) — **hai giá trị khác nhau**.

→ `debt_customer_groups.group_id` đang chứa **Mongo ObjectId của database nội bộ OmniCall**. Giá trị này vô nghĩa với mọi provider khác.

### 4.3. Điểm phụ thuộc nguy hiểm: hành vi auto-heal ghi đè mapping

`DebtNotifyService.saveHealedConvId()` (`DebtNotifyService.js:129-166`) **tự động thay đổi** `group_id` trong DB khi OmniCall phát hiện conv cũ đã chết. Nghĩa là mapping là **mutable, không tĩnh**.

Nếu Gateway giữ `gateway_groups` riêng mà không có cơ chế tương đương, hai bảng sẽ lệch dần theo thời gian → gửi tin sai nhóm. Đây là rủi ro vận hành số 1 (mục 13).

### 4.4. Bảng tổng hợp mức phụ thuộc

| Nhóm | Hạ tầng chung | Giao thức | Định danh nhóm | Vòng đời nhóm |
|---|---|---|---|---|
| BeerPOS nghiệp vụ | ✅ Sẵn sàng | ⚠️ Cần thay | ⚠️ Cần thay | ⚠️ Cần thay |
| Gateway | ✅ Sẵn sàng | ❌ Chưa có provider thật | ⚠️ Cần chiến lược | ❌ Chưa có |

---

## 5. Đánh giá Gateway hiện tại

### 5.1. Bảng đánh giá 14 năng lực

| # | Năng lực | Trạng thái | Bằng chứng |
|---|---|---|---|
| 1 | Provider interface | ✅ **Đủ** | `src/providers/MessageProvider.js:51-115` — `getStatus()`, `validateDestination()`, `sendMessage()`, `getCapabilities()` |
| 2 | Queue bền vững | ✅ **Đủ** | `src/database/migrations/001_init.js:83-126` — `gateway_jobs` + 7 index |
| 3 | Worker + lease | ✅ **Đủ** | `src/services/WorkerService.js:100-135`, `src/database/repositories/JobRepository.js:58-110` |
| 4 | Group mapping 1:1 | ✅ **Đủ** | `src/services/GroupService.js:118-170` + UNIQUE index `001_init.js:62-68` |
| 5 | API authentication | ✅ **Đủ** | `src/middleware/auth.js` — `requireApiKey('admin'\|'integration')`, `requireAnyScope()`, `safeEqual()` timing-safe (`src/utils/crypto.js:10-20`) |
| 6 | Idempotency | ✅ **Đủ** | `src/services/QueueService.js:28-57` + UNIQUE `idempotency_key` |
| 7 | Retry + backoff | ✅ **Đủ** | `src/services/WorkerService.js:209-220`, `src/services/SettingsService.js:60-68` |
| 8 | Audit log | ✅ **Đủ** | `src/services/AuditService.js` — 12 action + `sanitizeDetails()` chặn key |
| 9 | Health check | ✅ **Đủ** | `src/controllers/healthController.js:10-61` — không lộ secret |
| 10 | Monitoring | ⚠️ **Cơ bản** | Chỉ có `/health` + `/api/dashboard` + `/api/messages/queue/summary`. Không có metrics/prometheus, không có alert |
| 11 | Cơ chế cập nhật Group ID | ❌ **Thiếu** | `GroupService.update()` chỉ cập nhật khi admin gọi. **Không có** cơ chế provider báo về conv mới |
| 12 | Provider độc lập không phụ thuộc OmniCall | ⚠️ **Khung có, provider thật chưa** | `src/providers/index.js:60-73` — chỉ `mock`; còn lại → `UnauthorizedProvider` |
| 13 | Rate limit | ✅ **Đủ** | `src/middleware/rateLimit.js` — `sendLimiter`, `adminLimiter` |
| 14 | Tắt provider an toàn | ✅ **Đủ** | `SettingsService.setProvider()` (`:88-119`) — `disabled` mode, audit `PROVIDER_CHANGE` |

### 5.2. Điểm mạnh

1. **Provider interface đúng chuẩn.** `MessageProvider` có `validateDestination()` — Gateway sẽ tự chặn group không hợp lệ trước khi gọi provider.
2. **Chống gửi trùng mạnh.** `unknown` state bị chặn retry cả tự động (`WorkerService.js:196-205`) lẫn thủ công (`QueueService.js:114-121`). Đúng nguyên tắc "Không retry mù khi kết quả không xác định".
3. **Provider-agnostic thật sự.** `createProvider()` chỉ cần thêm `case` — không đụng nghiệp vụ.
4. **Audit sanitize sẵn.** `AuditService.sanitizeDetails()` chặn `apikey`, `api_key`, `x-api-key`, `authorization`, `password`, `secret` — nên credential provider mới không lọt vào log.
5. **Không giả trạng thái giao hàng.** `MockProvider` trả `deliveryStatus: 'accepted'` + `simulated: true`, không bao giờ `delivered`.
6. **Tách bạch DB.** `data/gateway.sqlite` hoàn toàn riêng `database.sqlite` của BeerPOS.

### 5.3. Điểm yếu / khoảng trống

| # | Khoảng trống | Mức độ | Ảnh hưởng |
|---|---|---|---|
| G1 | Chưa có provider gửi tin thật | **Chí mạng** | Gateway hiện chỉ mô phỏng. Không thay thế OmniCall được |
| G2 | Không có cơ chế provider cập nhật ngược `group_id` | Cao | Lệch mapping giữa BeerPOS và Gateway |
| G3 | Credential provider chưa có nơi lưu an toàn | Cao | `SettingsService` ghi chú "KHÔNG bao giờ lưu API key ở đây (key nằm trong env)" — nhưng key của provider bên thứ ba có thể cần lưu |
| G4 | Không có provider health/credential check định kỳ | Trung bình | Không phát hiện sớm API key hết hạn / tài khoản bị đăng xuất |
| G5 | Không có cơ chế đối soát (reconciliation) cho job `unknown` | Trung bình | Job `unknown` phải xử lý tay |
| G6 | Không có metrics/alerting | Trung bình | Sự cố không chủ động lộ ra |
| G7 | `SettingsService.setProvider()` chỉ cho phép `mock`/`disabled`/`authorized` | Thấp | Chặn provider mới — dễ sửa |
| G8 | Chưa có `provider_config` / `provider_account` tách riêng | Thấp | Cấu hình provider lẫn với cấu hình chung |

### 5.4. Đánh giá mục IV.A — Gateway tự triển khai

> **Không được nhầm lẫn:** chuyển `OmiCallService.js` sang Gateway ≠ loại bỏ OmniCall SaaS.

| Câu hỏi | Trả lời |
|---|---|
| Gateway có thể làm gì? | Đủ toàn bộ hạ tầng: queue, worker, idempotency, retry, audit, auth, health, dashboard, CSV import, UI Binance Dark |
| Còn thiếu gì? | G1–G6 ở mục 5.3, trên hết là **provider thật** |
| Provider độc lập không phụ thuộc OmniCall? | Về mặt kiến trúc: **CÓ** — interface đủ mở. Về mặt hiện thực: **CHƯA** — chưa có provider nào |

**Kết luận mục IV.A:** Gateway là **hạ tầng đúng**, không phải phương án thay thế. Đánh giá `GO` về kiến trúc, `NOT IMPLEMENTED` về chức năng.

---

## 6. Khảo sát API Zalo chính thức

**Nguồn**: `docs.zaloplatforms.com` (kiểm tra 2026-11-27), `oa.zalo.me/home/documents`, `zalo.solutions`.

### 6.1. Bảng đánh giá từng điều kiện

| Tiêu chí | Kết quả | Bằng chứng |
|---|---|---|
| **Gửi bằng tài khoản cá nhân?** | ❌ **KHÔNG** | Không tồn tại endpoint nào của Zalo OpenAPI nhận tài khoản cá nhân làm người gửi. Tất cả endpoint đều là "ứng dụng đại diện OA" |
| **Giữ nguyên danh tính người gửi?** | ❌ **KHÔNG** (với OA) | Tin gửi từ OA hiển thị là OA, không phải tài khoản cá nhân của chủ quán → vi phạm G4 |
| **Gửi vào 100 nhóm cá nhân hiện tại?** | ❌ **KHÔNG** | OA chỉ gửi được vào nhóm do OA quản lý (GMF). Nhóm cá nhân tạo từ Zalo cá nhân không thuộc phạm vi OA |
| **Dùng lại Group ID OmniCall?** | ❌ **KHÔNG** | `group_id` của OA OpenAPI là ID nhóm GMF do Zalo sinh ra — không liên quan Mongo `_id` của OmniCall |
| **Cần chuyển đổi nhóm?** | ✅ **CÓ** | Phải tạo lại nhóm qua `POST /v3.0/oa/group/creategroupwithoa`, mời lại từng thành viên → vi phạm G6, G3 |
| **Giới hạn số lượng tin?** | ✅ Có | Tin Tư vấn: chỉ gửi trong 7 ngày kể từ tương tác cuối. Tin Truyền thông: hạn mức theo gói OA |
| **Chi phí?** | 💰 **CÓ** | Bảng giá OA áp dụng 01/06/2026 — xem 6.3 |
| **Được Zalo cho phép?** | ✅ **CÓ, chính thức** | `docs.zaloplatforms.com` là tài liệu chính thức của Zalo Platforms |

### 6.2. Các endpoint chính thức khả dụng

| Endpoint | Mục đích | Sender | Ghi chú |
|---|---|---|---|
| `POST https://openapi.zalo.me/v2.0/oa/message` | Tin nhắn văn bản 1-1 tới người dùng | OA | `recipient.user_id` (UID theo OA) |
| `POST https://openapi.zalo.me/v3.0/oa/message/promotion` | Tin truyền thông cá nhân | OA | **Ngừng cung cấp từ 01/03/2026** |
| `POST https://openapi.zalo.me/v3.0/oa/group/message` | Tin nhắn nhóm dạng Text | OA | `recipient.group_id` — nhóm GMF |
| `POST https://openapi.zalo.me/v3.0/oa/group/creategroupwithoa` | Tạo nhóm GMF mới | OA | Cần `asset_id` từ `/v3.0/oa/quota/group` |
| `POST https://openapi.zalo.me/v3.0/oa/quota/group` | Lấy hạn mức + `asset_id` | OA | `product_type`: `gmf10`/`gmf50`/`gmf100` |

### 6.3. Chi phí API chính thức (bảng giá Zalo, áp dụng 01/06/2026)

Nguồn: `content.zalo.cloud/uploads/ZAP_Bang_gia_Dich_vu_ZOA_01062026_esigned_f340eb1ceb.pdf` và `zalo.solutions/oa/pricing`.

| Hạng mục | Đơn giá (chưa VAT) |
|---|---|
| Gói OA Tiêu chuẩn 1 năm | 1.000.000đ/gói |
| Gói OA Tăng trưởng 1 năm | 2.500.000đ/gói |
| Gói OA Toàn diện 1 năm | 6.000.000đ/gói |
| GMF-10 | 25.000đ/tháng |
| GMF-50 | 55.000đ/tháng |
| GMF-100 | 75.000đ/tháng |
| GMF-1000 | 300.000đ/tháng |
| Tin OA → nhóm GMF | **Miễn phí đến 31/12/2026** |
| Tin thành viên gửi trong nhóm | Miễn phí |
| Tin Tư vấn cá nhân | 55đ/tin |
| ZBS Template Message (gửi qua SĐT) | 200–400đ/tin |
| ZBS Template Message (gửi qua UID) | Thấp hơn luồng SĐT |

**Phát hiện quan trọng:** gói **OA Toàn diện 1 năm = 6.000.000đ/năm ≈ 500.000đ/tháng** — **CAO HƠN** 350.000đ/tháng của OmniCall. Và vẫn vi phạm G1, G3, G4, G6, G7.

### 6.4. Đánh giá

**Kết luận mục IV.B: `NO-GO`.**

Lý do tuyệt đối (không thể đàm phán):
- G1 (tài khoản cá nhân) — vi phạm tuyệt đối.
- G4 (danh tính người gửi) — tin hiển thị là OA.
- G6 (không yêu cầu khách vào nhóm mới) — bắt buộc tạo lại 100 nhóm GMF + mời lại tài xế.
- G7 — bị loại trừ theo yêu cầu mục I.7.
- Chi phí **cao hơn** hiện tại.

Việc dùng ZNS (gửi theo SĐT) cũng không khả thi vì: mẫu tin phải được Zalo duyệt trước, nội dung bị khuôn mẫu cố định (không giữ được định dạng công nợ hiện tại), và gửi tới **người dùng cá nhân**, không phải **nhóm**.

---

## 7. Khảo sát nhà cung cấp bên thứ ba

**Nguyên tắc áp dụng:** phân biệt 3 khái niệm — (a) *có API kỹ thuật*, (b) *có thể gửi tin thực tế*, (c) *được Zalo chính thức cho phép*. Không suy ra (c) từ (a) hoặc (b).

### 7.1. Func.vn (Bizflow)

| Tiêu chí | Nội dung | Nguồn |
|---|---|---|
| Tên dịch vụ | Func.vn — Account Hub / Bizflow | `func.vn` |
| Website | https://func.vn · Tài liệu: https://docs.func.vn | — |
| API documentation | ✅ Có, chi tiết: https://docs.func.vn/quan-ly-account/functions/function-api | — |
| Tài khoản gửi | **Zalo cá nhân** (`Zalo User` plan) | `func.vn/pricing` |
| Đăng nhập | QR | `docs.func.vn` |
| Gửi tin nhóm | ✅ **CÓ** — action `GROUP_SEND_MESSAGE`, body `{ group_id, message, mentions? }` | `docs.func.vn/quan-ly-account/functions/function-api/zalo-user-api` |
| Giữ nhóm hiện tại | ⚠️ **CÓ THỂ** — `group_id` là ID nhóm Zalo thật (khác Mongo ID của OmniCall) → cần ánh xạ lại | suy luận từ cấu trúc API |
| Group ID tương thích? | ❌ **KHÔNG** — `group_id` của Func.vn là ID nhóm Zalo, không phải Mongo `_id` | — |
| API gửi tin | `POST https://public-api.bizflow.vn/functions/xxxxxx`, header `Authorization: Bearer <token>`, action `GROUP_SEND_MESSAGE` | `docs.func.vn/quan-ly-account/functions/function-api` |
| Webhook | ✅ Có — Function Webhook, event `RECIEVED_MESSAGE`, hỗ trợ Bearer/Basic | `docs.func.vn/quan-ly-account/functions/function-webhook` |
| Chi phí | Basic 50.000đ/tháng (API Standard) · Standard 80.000đ/tháng (+API Advanced, Task Manager, Webhook) · Advanced 100.000đ/tháng | `func.vn/pricing` |
| Hạn mức | **NOT VERIFIED** — không tìm thấy rate limit công khai trong tài liệu | — |
| Độ ổn định | **NOT VERIFIED** — không có case study/sla công khai | — |
| Điều khoản Zalo | ⚠️ **NOT VERIFIED** — dùng QR/cookie (cơ chế không chính thức). Chưa tìm được tuyên bố cấp quyền từ Zalo | — |
| Khả năng tích hợp | ⭐ **Tốt** — REST POST + Bearer token, payload đơn giản, webhook có sẵn | — |

**Đánh giá Func.vn:** Đáp ứng về mặt kỹ thuật (a) và (b). Chưa chứng minh (c). Chi phí 80.000–100.000đ/tháng < 350.000đ. **Ứng viên số 1 về khả năng tích hợp.**

### 7.2. Cogover Omnichannel

| Tiêu chí | Nội dung | Nguồn |
|---|---|---|
| Tên dịch vụ | Cogover Omnichannel + Cogover Platform | `cogover.com` |
| Website | https://cogover.com/vi/products/omni-channel | — |
| API documentation | ⚠️ **NOT VERIFIED** — tài liệu kỹ thuật chi tiết cho luồng gửi tin Zalo cá nhân không công khai | — |
| Tài khoản gửi | **Zalo cá nhân** (chat 1-1 và nhóm) | `cogover.com/vi/pricing/omnichannel` |
| Đăng nhập | QR — "Quét mã QR để kết nối tài khoản Zalo cá nhân" | `cogover.com/vi/pricing/omnichannel` |
| Gửi tin nhóm | ⚠️ **Chưa xác minh** — tính năng "Zalo cá nhân (chat 1-1 và nhóm)" được liệt kê trong bảng kênh hỗ trợ, nhưng không có tài liệu API gửi tin cụ thể | — |
| Giữ nhóm hiện tại | ⚠️ **Chưa xác minh** — "Kết nối lại vẫn giữ lịch sử chat" | — |
| Group ID tương thích? | ❌ **KHÔNG** — không phải Mongo ID OmniCall | — |
| API gửi tin | **NOT VERIFIED** — Cogover Platform nói chung có "API đọc/ghi dữ liệu và webhook", nhưng endpoint gửi tin Zalo cá nhân không công khai | — |
| Webhook | ✅ Có (nền tảng) | `cogover.com/vi/pricing/platform` |
| Chi phí | Omnichannel: 100.000đ (Cơ bản, 3 kênh) / 200.000đ (Tiêu chuẩn, 10 kênh) / 300.000đ (Cao cấp) mỗi người/tháng (thanh toán năm). Thêm kênh: 40.000đ/kênh/tháng. Platform: Miễn phí (4 user) → 80.000đ (5 user) | `cogover.com/vi/pricing/omnichannel`, `/platform` |
| Hạn mức | 20.000 API request/giờ/tài khoản (gói Miễn phí); gói Nâng cao "không giới hạn" | `cogover.com/vi/pricing/platform` |
| Độ ổn định | **NOT VERIFIED** | — |
| Điều khoản Zalo | ⚠️ **NOT VERIFIED** | — |
| Khả năng tích hợp | ⚠️ **Trung bình** — nền tảng có API + webhook nhưng endpoint gửi tin Zalo cá nhân không công khai | — |

**Đánh giá Cogover:** Rủi ro vận hành lớn — tài khoản Zalo cá nhân chỉ hoạt động ở **một nơi**; tắt kênh Zalo cá nhân = **huỷ liên kết hẳn**, phải quét QR lại. Điều này xung đột với yêu cầu G1 (giữ tài khoản hiện tại). Cần xác minh trước khi đề xuất.

### 7.3. ZaloAI (Intratechs)

| Tiêu chí | Nội dung | Nguồn |
|---|---|---|
| Tên dịch vụ | ZaloAI | `zaloai.vn` |
| Website | https://zaloai.vn/tinh-nang | — |
| API documentation | ⚠️ Có nêu "có API & MCP" nhưng **NOT VERIFIED** chi tiết endpoint | — |
| Tài khoản gửi | **Zalo cá nhân** (gom tin nhắn, quản lý nhóm) | `zaloai.vn/tinh-nang` |
| Đăng nhập | QR (không xác minh chi tiết) | — |
| Gửi tin nhóm | ⚠️ **Chưa xác minh** — "quản lý nhóm" được nêu, chưa xác minh API gửi tin nhóm cụ thể | — |
| Giữ nhóm hiện tại | ⚠️ **Chưa xác minh** | — |
| Group ID tương thích? | ❌ **KHÔNG** | — |
| API gửi tin | **NOT VERIFIED** | — |
| Webhook | ⚠️ **NOT VERIFIED** | — |
| Chi phí | 79.000đ / 59.000đ / **49.000đ** mỗi tài khoản Zalo/tháng (3 mức theo số tài khoản) | `zaloai.vn/tinh-nang` |
| Hạn mức | **NOT VERIFIED** | — |
| Độ ổn định | **NOT VERIFIED** | — |
| Điều khoản Zalo | ⚠️ **NOT VERIFIED** | — |
| Khả năng tích hợp | ⚠️ **Trung bình-thấp** — có API & MCP nhưng tài liệu chưa xác minh được | — |

**Đánh giá ZaloAI:** Rẻ nhất (49.000đ/tài khoản/tháng) nhưng bằng chứng kỹ thuật mờ nhạt nhất. Cần liên hệ sales để xác minh.

### 7.4. ZaloX

| Tiêu chí | Nội dung | Nguồn |
|---|---|---|
| Tên dịch vụ | ZaloX — Zalo CLI & API Platform | `zalox.shrimpfarm.vn` |
| Website | https://zalox.shrimpfarm.vn/pricing | — |
| API documentation | ⚠️ **NOT VERIFIED** — mô tả tính năng "REST API server (zalox serve)" nhưng không có tài liệu endpoint công khai | — |
| Tài khoản gửi | **Zalo cá nhân** | — |
| Đăng nhập | QR + cookie | `zalox.shrimpfarm.vn/pricing` |
| Gửi tin nhóm | ⚠️ "Quản lý bạn bè & nhóm" — **chưa xác minh** endpoint gửi tin nhóm | — |
| Giữ nhóm hiện tại | ⚠️ **NOT VERIFIED** | — |
| Group ID tương thích? | ❌ **KHÔNG** | — |
| API gửi tin | **NOT VERIFIED** | — |
| Webhook | ✅ "Webhook forwarding" (gói Pro) | `zalox.shrimpfarm.vn/pricing` |
| Chi phí | Starter 499.000đ một lần · Pro 999.000đ một lần (REST API + webhook + gửi hàng loạt) · Team 2.499.000đ một lần | `zalox.shrimpfarm.vn/pricing` |
| Hạn mức | **NOT VERIFIED** | — |
| Độ ổn định | ⚠️ **NOT VERIFIED** — mô hình "trả một lần, trọn đời" không phải subscription; không có SLA | — |
| Điều khoản Zalo | ⚠️ **NOT VERIFIED** — dùng cookie/QR | — |
| Khả năng tích hợp | ⚠️ **Trung bình** — có REST API nhưng tài liệu không công khai | — |

**Đánh giá ZaloX:** Hình thức "trả một lần 999.000đ" không phù hợp với vận hành dài hạn cần SLA/bảo trì. Không có tài liệu công khai.

### 7.5. Bảng tổng hợp — phân biệt 3 khái niệm

| Nhà cung cấp | (a) Có API kỹ thuật | (b) Có thể gửi tin thực tế | (c) Được Zalo cho phép | Group ID tương thích | Chi phí/tháng |
|---|---|---|---|---|---|
| **Func.vn** | ✅ **CÓ** (tài liệu đầy đủ) | ✅ CÓ | ⚠️ **NOT VERIFIED** | ❌ KHÔNG | 80.000–100.000đ |
| Cogover | ⚠️ Tài liệu gửi tin Zalo cá nhân **NOT VERIFIED** | ✅ CÓ (chức năng) | ⚠️ **NOT VERIFIED** | ❌ KHÔNG | 100.000–300.000đ + Platform |
| ZaloAI | ⚠️ **NOT VERIFIED** | ✅ CÓ (chức năng) | ⚠️ **NOT VERIFIED** | ❌ KHÔNG | 49.000–79.000đ |
| ZaloX | ⚠️ **NOT VERIFIED** | ✅ CÓ (chức năng) | ⚠️ **NOT VERIFIED** | ❌ KHÔNG | 0đ (trả 1 lần ~1 triệu) |

**Kết luận mục IV.C: KHÔNG nhà cung cấp nào đạt chuẩn `GO`.**

Lý do chung: tất cả đều dựa trên **QR/cookie — cơ chế không chính thức của Zalo**. Bằng chứng về quyền sử dụng (`c`) là `NOT VERIFIED` ở **tất cả** các nhà cung cấp.

**Bằng chứng đối chứng đáng chú ý** — từ chính tài liệu của các nhà cung cấp:
- `zachat.vn/blog/zalo-ca-nhan-co-api-khong` (cập nhật 2026-11-18): "Các thư viện 'bot Zalo cá nhân' … đều là thư viện ngược giữa (Reverse-engineering) không chính thức — có thể ngừng hoạt động bất kỳ lúc nào khi Zalo đổi giao thức và rất dễ bị khóa nick".
- `github.com/ardennguyen/zalo-agent-cli` (README): "⚠️ Tool này sử dụng API Zalo **không chính thức**… Zalo không hỗ trợ và **tài khoản của bạn có thể bị khóa hoặc ban**."

**Đây chính là điểm mấu chốt:** ngay cả nhà cung cấp có API kỹ thuật tốt nhất (Func.vn) cũng không có bằng chứng được Zalo cho phép. Đề xuất dùng nó đòi hỏi chủ hệ thống **chấp nhận rủi ro khóa tài khoản cá nhân** — rủi ro đánh trực tiếp lên G1/G4 và lên 100 nhóm + danh tính người gửi đang hoạt động.

---

## 8. Đánh giá tự xây dựng connector

### 8.1. Phạm vi phân tích

Theo mục IV.D, báo cáo này **chỉ phân tích ở mức kiến trúc và rủi ro**. Không viết code, không chỉ dẫn thực hiện bất kỳ cơ chế nào dưới đây.

### 8.2. Các hướng kỹ thuật (mô tả ở mức khái niệm)

| Hướng | Mô tả khái niệm | Đánh giá |
|---|---|---|
| H1. Tái sử dụng phiên OmniCall | Gateway đóng vai trò "cầu nối" — vẫn xác thực bằng API key OmniCall, chỉ đổi chỗ gọi HTTP | **Không loại bỏ OmniCall**, chỉ di chuyển code. Chi phí 350.000đ/tháng **không đổi** |
| H2. Trích xuất phiên Zalo | Lấy cookie/token phiên từ một nguồn bên ngoài rồi dùng để gửi | 🚫 **Không phân tích sâu / không đề xuất** — vi phạm điều khoản Zalo, rủi ro khóa tài khoản rất cao, và vi phạm mục 3 của quy tắc kế thừa (`DebtZaloBridge.js:12`) |
| H3. Reverse engineer giao thức Zalo | Tự xây lại giao thức API của Zalo cá nhân | 🚫 **Không đề xuất** — cùng lý do trên |
| H4. Tự đăng nhập QR | Gateway tự hiển thị QR và lưu phiên | 🚫 **Không đề xuất** — vi phạm trực tiếp mục 3 của yêu cầu (`Không tự động hóa QR login thông qua cơ chế không được Zalo cấp quyền`) |

### 8.3. Vì sao H2–H4 bị loại

| Tiêu chí | H2 | H3 | H4 |
|---|---|---|---|
| Tuân thủ điều khoản Zalo | ❌ | ❌ | ❌ |
| Giữ được tài khoản cá nhân (G1) | ❌ Rủi ro cao | ❌ Rủi ro cao | ❌ Rủi ro trung bình |
| Rủi ro khóa tài khoản | 🔴 Cao | 🔴 Cao | 🟠 Trung bình–cao |
| Pháp lý | 🔴 | 🔴 | 🟠 |
| Được Zalo cấp quyền | ❌ | ❌ | ❌ |
| Phát hiện được | 🟡 | 🟡 | 🟡 |

**Quan sát từ chính hệ thống hiện tại:** `src/services/debt/DebtZaloBridge.js:16-22` đã ghi nhận kết quả khảo sát trước đây:

> "Zalo Desktop lưu DB cục bộ ở dạng MÃ HOÁ (`db-enc`), file bị khoá bởi tiến trình đang chạy, KHÔNG có listener TCP nào để nhận event. KHÔNG có API bot chính thức cho Zalo cá nhân (chỉ có Zalo OA). Dùng `zalo-oa`/API không chính thức để đọc/ghi tin nhắn cá nhân vi phạm điều khoản sử dụng và rủi ro khoá tài khoản → KHÔNG triển khai. ⇒ TRẠNG THÁI: `NOT_AVAILABLE`."

Tức là **chính BeerPOS đã kết luận `NOT_AVAILABLE`** cho hướng tự xây connector. Audit này xác nhận kết luận đó vẫn đúng.

### 8.4. Đánh giá H1 — Gateway đóng vai trò proxy

| Tiêu chí | Đánh giá |
|---|---|
| Loại bỏ OmniCall? | ❌ **KHÔNG** — vẫn dùng đúng API key OmniCall, vẫn trả 350.000đ/tháng |
| Giữ tài khoản + 100 nhóm + danh tính? | ✅ Có |
| Giá trị mang lại | ✅ Tách biệt hạ tầng, queue bền vững, audit, chuyển provider sau này dễ hơn |
| Rủi ro | 🟢 Thấp — chỉ di chuyển code, không đổi hành vi |
| Chi phí | ➡️ **Không đổi** (350.000đ/tháng) |

**Kết luận mục IV.D: `NO-GO` cho H2–H4. H1 là `GO` về kỹ thuật nhưng `NO-GO` về mục tiêu tiết kiệm chi phí.**

---

## 9. Tương thích Group ID

### 9.1. Bản chất Group ID hiện tại

| Thuộc tính | Giá trị |
|---|---|
| Nguồn | `debt_customer_groups.group_id` (`database/migrations/053_debt_management.js:170-181`) |
| Giá trị thực | Mongo `_id` (24 ký tự hex) của conversation trong DB OmniCall |
| Bằng chứng | `src/services/OmiCallService.js:479-483`, `:487-490`, `:1245-1250` |
| Vòng đời | **Mutable** — tự đổi khi OmniCall tạo conv mới (auto-heal, `DebtNotifyService.js:129-166`) |

### 9.2. Trả lời 10 câu hỏi mục V

**① Group ID có thuộc riêng OmniCall không?**
**CÓ — 100%.** Đây là Mongo ObjectId của database nội bộ OmniCall. Không có bất kỳ provider nào khác hiểu giá trị này.

**② Nhà cung cấp khác có thể sử dụng Group ID này không?**
**KHÔNG.** Xác minh qua cấu trúc API của Func.vn (`docs.func.vn/.../zalo-user-api`): `group_id` là ID nhóm Zalo thật (dạng chuỗi/số do Zalo sinh), khác hoàn toàn với Mongo `_id`.

**③ Có thể ánh xạ nhóm bằng tên nhóm không?**
**CÓ — một phần.**
- OmniCall: `findLiveConversationByName()` (`OmiCallService.js:1530-1562`) lọc `convSubType === 'group'` + khớp tên, loại conv chết.
- Rủi ro: tên nhóm **không duy nhất**. Nếu 2 nhóm trùng tên ở 2 khách khác → ánh xạ sai → **gửi tin công nợ cho sai khách**. Đây là rủi ro nghiêm trọng về mặt nghiệp vụ.
- Cần đối chiếu tên + thành viên + chủ quán để tăng độ tin cậy.

**④ Có thể nhận diện nhóm bằng định danh khác không?**
**CÓ, và đây là hướng đúng:**
- Tên nhóm (như trên).
- Danh sách thành viên / UID chủ quán / tài xế.
- API liệt kê nhóm của provider mới (`GET_GROUP_INFO`, `GET_GROUP_INFO_BY_LINK` — `docs.func.vn`).
- Với OmniCall: `conv.conv_id` (số), `conv.channel_id`, `conv.chat_session.joined_agents` (`OmiCallService.js:1245-1252`).

**⑤ Có cần người dùng đăng nhập lại và đồng bộ lại 100 nhóm không?**
- Với provider mới (Func.vn/Cogover): **CÓ** — phải QR đăng nhập lại tài khoản Zalo cá nhân (do giới hạn "mỗi tài khoản Zalo chỉ hoạt động ở một nơi" — `cogover.com/vi/pricing/omnichannel`; và `zalo-agent-cli` README ghi rõ chỉ giữ 1 phiên web).
- Với provider mới: **CÓ** — phải liệt kê nhóm và ánh xạ lại 100 nhóm.
- Với H1 (giữ OmniCall): **KHÔNG**.

**⑥ Có thể duy trì mapping cũ trong giai đoạn chuyển đổi không?**
**CÓ, và đây là chiến lược khuyến nghị.** Xem 9.3.

**⑦ Cách xử lý khi nhóm đổi tên?**
- Cần trường `group_name` được snapshot khi tạo job (đã có: `gateway_jobs.group_name`, `debt_notification_jobs.group_name_snapshot`).
- Nên lưu **cả** tên cũ lẫn tên mới trong bảng mapping để đối soát.
- Ánh xạ theo tên **không được** là nguồn duy nhất — luôn re-verify theo định danh bền vững của provider mới.

**⑧ Cách xử lý khi thành viên rời nhóm?**
- Provider mới: `GET_GROUP_INFO` → đếm `total_member` / danh sách thành viên. Nếu chủ quán vắng → đánh dấu mapping `needs_review`, **không gửi** (an toàn hơn gửi nhầm).
- OmniCall hiện tại: `conv.chat_session.joined_agents` rỗng → `classifyConversationState()` đánh dấu stale (`:1327-1330`).

**⑨ Cách xử lý khi chủ tài khoản rời nhóm rồi tham gia lại?**
Đây là kịch bản đã xảy ra thực tế với OmniCall và là **rủi ro vận hành số 1**:
- OmniCall tạo conversation MỚI (id khác) cho cùng nhóm; conversation cũ chết.
- Xử lý hiện tại: `ensureAgentInGroup()` → `resolveLiveConvId()` → `saveHealedConvId()` cập nhật `group_id` trong `debt_customer_groups`.
- Với provider mới: hành vi tương tự có thể xảy ra → cần cơ chế **tương đương** trong Gateway (mục 10.3, G2).

**⑩ Cách phát hiện mapping sai để tránh gửi nhầm khách hàng?**
Kiểm soát 4 lớp:

| Lớp | Cơ chế |
|---|---|
| L1 — Định danh | Provider trả `providerMessageId`; lưu cùng `group_id` snapshot trong job để đối soát sau |
| L2 — Kiểm tra trước khi gửi | `validateDestination()` (`MessageProvider.js:83-87`) — provider trả về thông tin nhóm, so khớp với mapping |
| L3 — Hậu kiểm | Xác nhận từ provider (nếu có webhook tin nhắn) rằng tin đã vào đúng nhóm |
| L4 — Đối soát định kỳ | Job `sent` nhưng không có `providerMessageId` hoặc webhook xác nhận → cảnh báo |

Cơ chế chống gửi nhầm mạnh nhất hiện có: **KHÔNG cho request chỉ định Group ID tùy ý** — Gateway luôn tra mapping từ `customerId` (`MessageService.js:59-64`), và `group_id` được snapshot vào job lúc tạo (`MessageService.js:74-78`).

### 9.3. Chiến lược migration mapping an toàn (khuyến nghị)

**Nguyên tắc: KHÔNG chuyển đổi `group_id` trực tiếp. Luôn giữ 2 định danh tách biệt.**

```
debt_customer_groups (BeerPOS — SSOT)
├── group_id              ← Mongo _id OmniCall (giữ nguyên, dùng cho provider cũ)
├── group_name            ← tên nhóm Zalo (dùng để đối soát)
└── (mới) external_refs   ← JSON: { "funcvn": "<id_nhom_zalo_that>", "omicall": "<mongo_id>" }
```

**Quy trình 5 bước:**

| Bước | Hành động | Kiểm soát |
|---|---|---|
| 1 | Chụp snapshot mapping hiện tại (CSV) | `scripts/sync-groups-from-beerpos.js --csv` |
| 2 | Đăng nhập provider mới (QR) — **bởi con người** | Không tự động hóa QR |
| 3 | Liệt kê nhóm từ provider mới → tạo bảng ánh xạ tạm (tên + thành viên) | Đối chiếu 2 chiều, **báo cáo mọi dòng không khớp** |
| 4 | **Duyệt thủ công** từng dòng khớp (100 dòng) — chủ quán xác nhận | Bắt buộc có người xác nhận |
| 5 | Ghi `external_refs`, giữ nguyên `group_id` cũ | Không xóa dữ liệu cũ → rollback được |

**Quy tắc an toàn bắt buộc:**
- Không dòng nào khớp chắc chắn → **KHÔNG tự động gán**; đánh dấu `needs_review`.
- 2 nhóm trùng tên → **KHÔNG tự động gán**.
- Luôn giữ `group_id` OmniCall trong DB → fallback được nếu cần rollback.
- Không xóa bản ghi lịch sử gửi tin.

### 9.4. Kết luận mục V

| Nhận định | Đánh giá |
|---|---|
| Group ID hiện tại dùng được với provider khác? | ❌ **KHÔNG** |
| Cần đồng bộ lại 100 nhóm? | ✅ **CÓ** (bắt buộc, có duyệt thủ công) |
| Có thể giữ mapping cũ để rollback? | ✅ **CÓ** |
| Rủi ro gửi nhầm khách hàng? | 🟠 **CAO** nếu ánh xạ tự động theo tên — phải có bước duyệt thủ công |

---

## 10. Kiến trúc mục tiêu

### 10.1. Kiến trúc tổng thể

```
┌─────────────────────────────────────────────────────────────┐
│ BeerPOS                                                     │
│  DebtPaymentService / DebtSepayService / DebtCommandService │
│         ↓ notifyPaymentAsync()                              │
│  DebtNotifyService  → buildPaymentMessage()                 │
│         ↓ enqueueJob()  (idempotency_key UNIQUE)            │
│  debt_notification_jobs   ← OUTBOX (SSOT nghiệp vụ)         │
│         ↓ NotificationWorker (lease + backoff)               │
│  ProviderFactory ──→ OmniCallAdapter ──→ OmiCallService     │
│                  └─→ GatewayAdapter  ──→ GatewayClient      │
└─────────────────────────────────────────────────────────────┘
                          │ HTTP POST + Idempotency-Key
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ BeerPOS Zalo Gateway  (KHÔNG phụ thuộc provider cụ thể)     │
│  middleware/auth (2 scope: admin | integration)              │
│  routes/index.js  →  POST /api/messages/send                │
│         ↓                                                    │
│  MessageService.accept()                                     │
│    ├─ idempotency check (gateway_jobs.idempotency_key)      │
│    ├─ GroupService.findActive(customerId)  ← SSOT mapping    │
│    └─ QueueService.enqueue()  (snapshot group_id)           │
│         ↓                                                    │
│  gateway_jobs  →  WorkerService (lease, backoff, timeout)   │
│         ↓  ProviderFactory.createProvider(name)             │
│  ┌──────────────┬──────────────┬──────────────┐            │
│  │ MockProvider │ OmniCallProv │  ProviderX   │  ← mới      │
│  └──────────────┴──────────────┴──────────────┘            │
│         ↓                                                    │
│  gateway_messages (lịch sử từng lần thử)                     │
│  gateway_audit_logs                                          │
└─────────────────────────────────────────────────────────────┘
```

### 10.2. 15 yêu cầu thiết kế — trạng thái trong Gateway hiện tại

| # | Yêu cầu | Trạng thái | Bằng chứng / việc cần làm |
|---|---|---|---|
| 1 | Provider interface thống nhất | ✅ | `src/providers/MessageProvider.js:51-115` |
| 2 | Mỗi provider có cấu hình riêng | ⚠️ | Hiện là `MESSAGE_PROVIDER` chung (env). Cần `provider_config` theo provider |
| 3 | Credential được bảo vệ | ⚠️ | Key nằm trong env (`src/config/index.js:66-73`). Provider mới có thể cần token → cần bảng `provider_credentials` mã hóa hoặc env riêng |
| 4 | Không ghi API key/token vào log | ✅ | `src/utils/crypto.js:23-27` — chỉ `fingerprint()` (8 hex); `AuditService.sanitizeDetails()` chặn key nhạy cảm |
| 5 | Không cho request tùy ý chỉ định Group ID | ✅ | `MessageService.accept()` (`:59-64`) luôn tra mapping từ `customerId`; `group_id` chỉ từ DB |
| 6 | Idempotency xuyên suốt | ✅ | BeerPOS `069_...:82` → Gateway `001_init.js:83` → `QueueService.enqueue()` (`:28-57`) |
| 7 | Không gửi trùng khi retry | ✅ | `unknown` không retry (`:196-205`); `QueueService.retry()` chặn `UNSAFE_RETRY` (`:114-121`) |
| 8 | Timeout + backoff | ✅ | `WorkerService._callProvider()` (`:241-273`); `RETRY_DELAYS_MS` mặc định `[10s,30s,120s,300s]` |
| 9 | Trạng thái `queued/accepted/failed/unknown` | ✅ | `JobRepository.JOB_STATUS` (`:3-11`); `DELIVERY_STATUS` (`MessageProvider.js:22-27`) |
| 10 | Không đánh dấu `delivered` nếu chưa xác nhận | ✅ | `OmniCallAdapter` chỉ trả `ACCEPTED`; `MessageProvider.getCapabilities().deliveryConfirmation = false` |
| 11 | Audit log | ✅ | `AuditService.AUDIT_ACTIONS` 12 mục (`:4-16`) |
| 12 | Cơ chế đối soát | ❌ | Cần bảng đối soát + job định kỳ quét job `sent`/`unknown` |
| 13 | Health check | ✅ | `healthController.js:10-61` |
| 14 | Tắt provider an toàn | ✅ | `SettingsService.setProvider()` (`:88-119`) — `disabled` mode |
| 15 | Khả năng rollback | ⚠️ | Cần: giữ `group_id` cũ (mục 9.3) + `provider` field trên job + cơ chế chuyển provider mà không mất job |

### 10.3. Gap bắt buộc phải bổ sung (điểm khác biệt so với Gateway hiện tại)

| Gap | Mô tả | Ưu tiên |
|---|---|---|
| **GAP-1** | **Cơ chế provider cập nhật ngược `group_id`** — tương đương `saveHealedConvId()`. Provider mới phải có hook: `resolveDestination(groupRef) → {externalId, changed}`; Gateway cập nhật `external_refs` và ghi audit `PROVIDER_GROUP_REMAP` | 🔴 **P0** |
| **GAP-2** | **Bảng `provider_credentials` / `provider_config`** — cấu hình riêng từng provider, credential mã hóa, không ghi log | 🔴 P0 |
| **GAP-3** | **Health/credential check định kỳ** — phát hiện sớm key hết hạn, tài khoản bị đăng xuất, provider ngừng hoạt động | 🔴 P0 |
| **GAP-4** | **Đối soát (reconciliation)** — job `sent`/`unknown` không có `providerMessageId` hoặc webhook xác nhận → cảnh báo; quét định kỳ | 🟠 P1 |
| **GAP-5** | **Mapping nhiều provider (`external_refs`)** — mỗi khách hàng giữ định danh cho OmniCall **và** provider mới | 🔴 P0 |
| **GAP-6** | **Metrics/alerting** — Prometheus/metrics endpoint, cảnh báo queue backlog > N, provider error rate | 🟠 P1 |
| **GAP-7** | **Job reconciliation + cờ `needs_review`** — mapping không xác minh được → không gửi, chờ người duyệt | 🔴 P0 |
| **GAP-8** | **Tương đương auto-heal trong Gateway** — khi provider báo group không còn hợp lệ, Gateway tự tra cứu lại và cập nhật mapping | 🔴 P0 |
| **GAP-9** | **Chống gửi trùng khi hai hệ thống cùng retry** — cờ `provider` trên job để phân biệt, và cơ chế "chỉ một hệ thống sở hữu job" | 🟠 P1 |
| **GAP-10** | **Cờ `simulated` + watermark** trên mọi job để không lẫn tin mô phỏng với tin thật | 🟢 P2 |

### 10.4. Đánh giá `debt_customer_groups` làm Single Source of Truth

**Khuyến nghị: `debt_customer_groups` (BeerPOS) là SSOT. KHÔNG tạo hai nguồn mapping độc lập.**

Hiện trạng có vấn đề: `debt_customer_groups` (BeerPOS) và `gateway_groups` (Gateway) là **hai bảng độc lập cùng chứa `customerId → groupId`**. Đây là nguồn lệch dữ liệu tiềm ẩn.

**Mô hình đề xuất — "SSOT + bản sao cache có kiểm soát":**

| Bảng | Chủ sở hữu | Vai trò | Đồng bộ |
|---|---|---|---|
| `debt_customer_groups` | **BeerPOS** | **SSOT** — nguồn sự thật về khách ↔ nhóm | Nguồn gốc |
| `debt_customer_groups.external_refs` | BeerPOS | Định danh theo provider (`omicall`, `funcvn`, …) | Cùng bản ghi |
| `gateway_groups` | Gateway | **Cache/projection** — phục vụ nhanh + tra cứu nhanh | Đồng bộ **một chiều** từ SSOT qua API Gateway |

**Quy tắc bắt buộc:**
1. Gateway **KHÔNG** được là nguồn sự thật. `gateway_groups` là bản sao.
2. Đồng bộ **một chiều**: BeerPOS → Gateway. Gateway không ghi ngược trừ khi qua cơ chế được duyệt (GAP-1/GAP-8 → ghi `external_refs` qua API có audit).
3. Mỗi bản ghi cache có `synced_at` + `source_version` để phát hiện lệch.
4. Job điểm soát định kỳ: so `debt_customer_groups` ↔ `gateway_groups`, lệch → cảnh báo, không tự sửa âm thầm.
5. Có cơ chế **re-sync toàn bộ** theo lệnh admin (đã có sẵn `scripts/sync-groups-from-beerpos.js`).

### 10.5. Ràng buộc bất biến cho mọi provider mới

Một provider mới **chỉ được chấp nhận** nếu thỏa cả 5 điều kiện:

| # | Điều kiện | Kiểm tra |
|---|---|---|
| P1 | Gửi được **vào nhóm** (không chỉ 1-1) | Endpoint + payload thực tế |
| P2 | Dùng được **định danh nhóm bền vững** (không phải tên) | Tài liệu API |
| P3 | Có **cơ chế phát hiện nhóm không còn hợp lệ** | Tài liệu API / webhook |
| P4 | Có **xác thực API** (Bearer/OAuth/API key) | Tài liệu API |
| P5 | Tương đương **auto-heal** khi nhóm thay đổi | Khả năng truy vấn lại danh sách nhóm |

---

## 11. So sánh các phương án

| Tiêu chí | **P1. Tiếp tục OmniCall** | **P2. Gateway + OmniCall** | **P3. Gateway + provider QR** | **P4. Zalo OA/GMF chính thức** |
|---|---|---|---|---|
| G1 Giữ tài khoản cá nhân | ✅ | ✅ | ✅ | ❌ |
| G2 Giữ 100 nhóm | ✅ | ✅ | ⚠️ Cần đồng bộ lại | ❌ Phải tạo lại |
| G4 Đúng danh tính người gửi | ✅ | ✅ | ✅ | ❌ Là OA |
| G5 Gửi đúng nhóm | ✅ | ✅ | ⚠️ Rủi ro ánh xạ sai | ✅ |
| G6 Không cần nhóm mới | ✅ | ✅ | ✅ | ❌ |
| G7 Không OA/GMF | ✅ | ✅ | ✅ | ❌ |
| G8 Bỏ 350k/tháng | ❌ | ❌ | ✅ | ❌ (tăng) |
| G9 Giữ nghiệp vụ/retry/lịch sử | ✅ | ✅ | ✅ | ⚠️ |
| G10 Rollback | ✅ | ✅ | ⚠️ | ⚠️ |
| API ổn định | ✅ | ✅ | ⚠️ | ✅ |
| Căn cứ quyền sử dụng | ✅ (thương mại) | ✅ | ❌ **NOT VERIFIED** | ✅ |
| Chi phí đã xác minh | ✅ | ✅ | ✅ | ✅ |
| **Đánh giá mục XI** | **GO** | **GO** (không tiết kiệm) | **CONDITIONAL GO** | **NO-GO** |

### 11.1. Nhận định quan trọng về P2

`Gateway + OmniCall` **đạt chuẩn GO** về mặt kỹ thuật và rủi ro, nhưng **KHÔNG đạt mục tiêu G8**. Đây là bước trung gian có giá trị: nó biến việc "chuyển provider" thành thao tác cấu hình thay vì viết lại hệ thống. Chi phí giữ nguyên 350.000đ/tháng.

### 11.2. Phân tích điểm gãy của P3

P3 là phương án duy nhất đạt G8 mà vẫn giữ G1/G4/G6/G7. Ba rủi ro phải cân nhắc:

| Rủi ro | Mức | Xử lý |
|---|---|---|
| Quyền sử dụng `NOT VERIFIED` | 🔴 Cao | Cần chủ hệ thống **tự quyết** chấp nhận rủi ro khóa nick |
| Ánh xạ 100 nhóm sai → gửi nhầm khách | 🔴 Cao | Bắt buộc có bước duyệt thủ công (mục 9.3) |
| Tài khoản Zalo bị đăng xuất khi đăng nhập nơi khác | 🟠 Trung bình | Chỉ dùng 1 nơi; quy trình QR vận hành rõ ràng |

---

## 12. Bảng chi phí

### 12.1. Các giả định

| Tham số | Giá trị | Nguồn |
|---|---|---|
| Số khách hàng | 100 | Yêu cầu mục I.2 |
| Số thông báo/tháng — kịch bản nhỏ | 1.000 | Yêu cầu mục VII |
| Số thông báo/tháng — kịch bản vừa | 5.000 | Yên cầu mục VII |
| Chi phí OmniCall hiện tại | 350.000đ/tháng | `omicall.com/bang-gia/` — gói "Omni Channel Contact Center AI" 350.000đ/user/tháng, trả block 6 tháng |
| VPS hiện tại | **NEED QUOTATION** | Chưa có báo giá cụ thể trong repo |
| Công sức bảo trì | **NEED QUOTATION** | Không có dữ liệu nội bộ |

### 12.2. So sánh 5 phương án

| Hạng mục | P1 OmniCall | P2 Gateway+OmniCall | P3 Gateway+Func.vn | P4 Zalo OA/GMF |
|---|---|---|---|---|
| **Phí cố định/tháng** | 350.000 | 350.000 | 80.000–100.000 | ~500.000 (gói Toàn diện/năm ÷ 12) + GMF |
| **Phí theo tin (1.000 tin)** | 0 (đã trong gói) | 0 | 0 | 0 (Tin OA→GMF miễn phí tới 31/12/2026) |
| **Phí theo tin (5.000 tin)** | 0 | 0 | 0 | 0 (đến 31/12/2026) |
| **Phí API** | 0 | 0 | 0 | 55đ/tin nếu dùng Tin Tư vấn |
| **Chi phí VPS** | *đã có* | *đã có* (Gateway) | *đã có* | *đã có* |
| **Chi phí bảo trì/tháng** | *NEED QUOTATION* | + thấp hơn (chuyển hạ tầng) | + thấp hơn | *NEED QUOTATION* |
| **Chi phí migration một lần** | 0 | *NEED QUOTATION* | *NEED QUOTATION* (đồng bộ 100 nhóm + duyệt tay) | *NEED QUOTATION* (tạo lại 100 nhóm + mời lại thành viên) |
| **Chi phí phát sinh** | 0 | 0 | Phí API theo lượng nếu vượt quota | Phí GMF theo số nhóm: 100 × 75.000 = 7.500.000đ/tháng nếu mua thêm |
| **Tổng 1.000 tin/tháng** | **350.000** | **350.000** | **80.000–100.000** | **~500.000+** |
| **Tổng 5.000 tin/tháng** | **350.000** | **350.000** | **80.000–100.000** | **~500.000+** |
| **Tiết kiệm so với hiện tại** | 0 | **0** | **250.000–270.000đ/tháng** | **−150.000đ/tháng (tăng)** |

### 12.3. Ghi chú quan trọng

1. **Chi phí không phụ thuộc số lượng tin** ở cả 3 phương án khả thi — vì OmniCall và Func.vn đều tính theo user/tài khoản, không theo tin. Quy mô 1.000 vs 5.000 tin **không ảnh hưởng chi phí** (trừ khi vượt rate limit → `NEED QUOTATION`).
2. **P4 (Zalo OA/GMF) tốn kém hơn hiện tại** — vừa phải mua gói OA (500.000đ/tháng tương đương) vừa có thể phải mua thêm 100 gói GMF-100 (75.000đ × 100 = 7.500.000đ/tháng).
3. **Chi phí thực tế của P3 còn có phần ẩn**: công sức vận hành QR định kỳ, công sức duyệt 100 nhóm, và rủi ro phải quét lại khi tài khoản bị đăng xuất.
4. **Phương án "không có phí định kỳ"** — ZaloX gói Pro trả một lần 999.000đ. Về lý thuyết là 0đ/tháng, nhưng: (a) không có SLA/bảo trì, (b) tài liệu API không công khai, (c) rủi ro giao thức đổi không được hỗ trợ. **Không khuyến nghị** như phương án định kỳ.
5. Tất cả giá bên thứ ba lấy từ trang giá niêm yết, kiểm tra 2026-11-27. Phần `NEED QUOTATION` là các hạng mục chưa có số liệu công khai.

---

## 13. Bảng rủi ro vận hành

| # | Tình huống | Nguyên nhân | Ảnh hưởng | Cách phát hiện | Cách xử lý | Tự phục hồi | Cần can thiệp tay |
|---|---|---|---|---|---|---|---|
| R1 | **Gateway mất kết nối** | Mất mạng / process chết | Job tích tụ trong `gateway_jobs` | `GET /health` → `database.ok=false`; `queue/summary` tăng | Restart service; job vẫn `queued` | ✅ | ⚠️ Nếu DB hỏng |
| R2 | **Provider ngừng hoạt động** | Hạ tầng provider sập | Job fail liên tục | `last_error` lặp lại trong `gateway_messages` | Tạm `setProvider('disabled')` → job vào `retry` với backoff | ✅ | ❌ |
| R3 | **API key hết hạn** | Key đổi/hết hạn | 401 từ provider | HTTP 401/403 trong `provider_response` | Xoay key qua `ADMIN_API_KEYS` (Gateway) / đổi key trong `settings` (BeerPOS) | ✅ | ✅ Phải cập nhật key |
| R4 | **Tài khoản Zalo bị đăng xuất** | Đăng nhập nơi khác / hết phiên | Không gửi được | Provider báo lỗi session; `provider.available=false` | Quét QR lại (thủ công) | ❌ | ✅ **Bắt buộc** |
| R5 | **Tài khoản bị giới hạn** | Zalo chặn do gửi nhanh/vi phạm | Mất toàn bộ kênh | Lỗi provider; kiểm tra tài khoản Zalo | Dừng gửi, liên hệ Zalo | ❌ | ✅ **Bắt buộc** |
| R6 | **Group ID không còn hợp lệ** | Nhóm bị xoá / agent rời, tạo conv mới | Gửi sai hoặc không gửi | Provider trả lỗi; auto-heal của OmniCall (`resolveLiveConvId`) | **Cần GAP-1/GAP-8**: cơ chế cập nhật ngược mapping | ⚠️ | ⚠️ Nếu không tự tra cứu được |
| R7 | **Khách hàng rời nhóm** | Khách tự rời | Thông báo không tới | `GET_GROUP_INFO` → `total_member` giảm | Đánh dấu `needs_review`, không gửi | ✅ | ✅ Nếu cần tạo lại nhóm |
| R8 | **Tin nhắn timeout nhưng provider đã nhận** | Mạng chập chờn | Có thể gửi trùng nếu retry | `deliveryStatus='unknown'` | **KHÔNG retry tự động** (`WorkerService.js:196-205`); retry tay bị chặn bởi `UNSAFE_RETRY` | ❌ | ✅ **Bắt buộc** — kiểm tra thủ công |
| R9 | **Gửi trùng thông báo** | Retry tay khi thực tế đã gửi | Khách nhận 2 lần | Đối soát `providerMessageId` + hội thoại | Idempotency key chặn ở tầng hàng đợi | ✅ | ⚠️ |
| R10 | **Hai hệ thống retry đồng thời** | BeerPOS worker + Gateway worker cùng xử lý | Gửi trùng | `gateway_jobs.provider` + `synced_at` | Chỉ một hệ thống sở hữu job (GAP-9); trong giai đoạn chuyển: **tắt worker của BeerPOS** khi bật worker Gateway | ✅ | ⚠️ Cần cấu hình đúng |
| R11 | **BeerPOS restart** | Crash/deploy | Job trong `debt_notification_jobs` giữ nguyên | Restart → worker lease hết hạn → job `queued` lại | `recoverStaleJobs()` (JobRepository `:94-110`) | ✅ | ❌ |
| R12 | **Gateway restart** | Crash/deploy | Job `processing` bị treo | `locked_until < now` | `recoverStaleJobs()` → `queued` | ✅ | ❌ |
| R13 | **Mất kết nối Internet** | Sự cố mạng | Không gửi được | Timeout → `deliveryStatus='unknown'` | **Không retry** (đúng để tránh trùng) | ⚠️ Phụ thuộc | ⚠️ |
| R14 | **DB lỗi / mất dữ liệu** | Hỏng file SQLite / xoá nhầm | Mất mapping + lịch sử | `health` → `database.ok=false`; `sqlite3` báo lỗi | **Khôi phục từ backup** (`scripts/backup.js` có sẵn) | ⚠️ | ✅ **Bắt buộc** |
| R15 | **Provider trả về "thành công" nhưng tin không tới** | Provider không có xác nhận giao hàng | Khách không nhận tin | Không có `deliveryConfirmation` → không phát hiện tự động | Dựa vào webhook (nếu có) để đối soát (GAP-4) | ❌ | ⚠️ |
| R16 | **Gửi tin nhầm nhóm** | Ánh xng sai 100 nhóm | Vi phạm nghiệp vụ, mất niềm tin | Kiểm tra mapping theo tên + thành viên | Bước duyệt thủ công bắt buộc (mục 9.3) | ❌ | ✅ **Bắt buộc** |

### 13.1. Rủi ro lớn nhất

**R16 (gửi tin nhầm khách hàng)** và **R4/R5 (tài khoản Zalo cá nhân bị đăng xuất hoặc bị giới hạn)** là hai rủi ro lớn nhất:

- R16 đánh trực tiếp lên niềm tin khách hàng và nghiệp vụ công nợ — một lần gửi nhầm có thể phá hỏng quan hệ với 100 khách.
- R4/R5 đánh trực tiếp lên G1 và G4 — nếu tài khoản bị khoá, mất ngay khả năng gửi với đúng danh tính chủ quán, và phải chờ Zalo gỡ khoá (thời gian không xác định).

Rủi ro R5 là rủi ro **không đo được trước** và **không thể tự phục hồi** — đây là lý do lớn nhất khiến mọi phương án dựa trên QR-login không thể đạt `GO`.

---

## 14. Kế hoạch migration

### 14.1. Nguyên tắc

1. **Không big-bang.** Chuyển từng đợi nhỏ, có rollback từng đợi.
2. **Song song trong giai đoạn chuyển đổi.** BeerPOS (OmniCall) và Gateway (provider mới) cùng chạy, phân tách theo khách hàng.
3. **Không bao giờ xóa mapping cũ.** `group_id` OmniCall luôn còn trong DB.
4. **Bước duyệt thủ công là bắt buộc**, không tự động.

### 14.2. 6 giai đoạn

| GĐ | Nội dung | Điều kiện thoát | Có thể rollback? |
|---|---|---|---|
| **GĐ0** | **Nền tảng** — bổ sung GAP-1..GAP-10 vào Gateway (chưa đổi provider) | Gateway vẫn chạy OmniCall qua provider adapter; regression pass | ✅ Tức thì |
| **GĐ1** | **Song song an toàn** — Gateway dùng provider OmniCall, BeerPOS chuyển sang đẩy job qua Gateway | So sánh số job gửi của 2 kênh khớp nhau | ✅ Bật lại đường cũ |
| **GĐ2** | **Đánh giá provider** — thử Func.vn (và/hoặc Cogover) trên 1 tài khoản thử nghiệm; xác minh API gửi tin nhóm, webhook, rate limit | Bằng chứng API thực tế + báo giá chính thức + câu trả lời về quyền sử dụng | ✅ Không ảnh hưởng production |
| **GĐ3** | **Đồng bộ mapping** — đăng nhập QR (thủ công), liệt kê nhóm, sinh bảng ánh xạ tạm, **duyệt thủ công 100 dòng** | 100/100 dòng xác minh hoặc ghi rõ lý do bỏ qua | ✅ Bỏ `external_refs` |
| **GĐ4** | **Chạy thử (canary)** — chuyển 5–10 khách hàng sang provider mới; song song 2 kênh, so kết quả | 2 tuần không có sai lệch; xác nhận tin tới đúng nhóm | ✅ Chuyển lại các khách này |
| **GĐ5** | **Chuyển đại trà** — theo lô 20–30 khách; mỗi lô có 3 ngày quan sát | 100 khách chuyển xong, 0 gửi nhầm | ✅ Từng lô độc lập |
| **GĐ6** | **Cắt OmniCall** — chỉ sau khi 100 khách ổn định ≥ 30 ngày; hủy gói OmniCall | Không còn job nào dùng provider OmniCall | ⚠️ Không rollback sau khi hủy gói |

### 14.3. Tiêu chí thành công / thất bại của GĐ

| Tiêu chí | Đạt | Không đạt → hành động |
|---|---|---|
| Tỉ lệ gửi thành công ≥ 99% | ✅ | Dừng, quay lại GĐ2 |
| 0 tin gửi nhầm nhóm | ✅ | Dừng ngay, quay lại GĐ3 |
| Thời gian gửi P95 ≤ 30s | ✅ | Tinh chỉnh queue/worker |
| Không có job `unknown` tích tụ > 5 | ✅ | Kiểm tra GAP-4, GAP-8 |
| Chi phí/tháng ≤ 150.000đ | ✅ | Chưa đạt G8 → cân nhắc giữ OmniCall |

### 14.4. Điều kiện tiên quyết cho toàn bộ kế hoạch

| # | Điều kiện | Trạng thái |
|---|---|---|
| P1 | Chủ hệ thống **chấp nhận rủi ro** dùng cơ chế QR (không chính thức) | ❌ **CHƯA CÓ** |
| P2 | Có **bằng chứng từ nhà cung cấp** về quyền sử dụng phù hợp | ❌ **NOT VERIFIED** |
| P3 | Có **báo giá chính thức** (thay vì giá niêm yết web) | ❌ **NEED QUOTATION** |
| P4 | Xác minh **rate limit** và **giới hạn tần suất** của provider | ❌ **NOT VERIFIED** |
| P5 | Duyệt kế hoạch **migration** và **rollback** | ❌ **CHƯA CÓ** |

**Không điều kiện nào ở trên là đạt.** Đây là lý do kết luận là `CONDITIONAL GO` chứ không phải `GO`.

---

## 15. Kế hoạch rollback

### 15.1. Nguyên tắc

Rollback phải là **thao tác cấu hình**, không phải thao tác sửa dữ liệu.

### 15.2. Bảng rollback theo giai đoạn

| GĐ | Cách rollback | Thời gian | Mất dữ liệu? |
|---|---|---|---|
| GĐ0 | Tắt worker Gateway; BeerPOS quay lại đường cũ | < 5 phút | ❌ Không |
| GĐ1 | `MESSAGE_PROVIDER` → chuyển về OmniCall trong Gateway; hoặc tắt worker Gateway và bật lại BeerPOS worker | < 15 phút | ❌ Không |
| GĐ2 | Không ảnh hưởng production | 0 | ❌ |
| GĐ3 | Xoá `external_refs` (soft); `group_id` OmniCall **không đổi** | < 30 phút | ❌ Không |
| GĐ4 | Chuyển lại 5–10 khách về `omicall` trong `external_refs` | < 1 giờ | ❌ Không |
| GĐ5 | Từng lô: chuyển lại `external_refs` của lô đó | < 1 giờ/lô | ❌ Không |
| GĐ6 | ⚠️ **Không rollback sau khi hủy gói OmniCall** — phải gia hạn/hủy lại gói | — | ⚠️ Có thể |

### 15.3. Điểm kiểm soát then chốt để rollback được

| # | Điểm kiểm soát | Cơ chế | Hiện trạng |
|---|---|---|---|
| K1 | `group_id` OmniCall **luôn** còn trong `debt_customer_groups` | Không ghi đè, chỉ bổ sung `external_refs` | ✅ Có thể giữ |
| K2 | `gateway_jobs.provider` lưu provider đã dùng | Cột `provider` | ✅ Đã có (`001_init.js:91`) |
| K3 | `gateway_jobs` không bị xóa khi đổi provider | Chỉ đổi cấu hình | ✅ |
| K4 | Provider tắt an toàn → job không mất, chỉ retry | `setProvider('disabled')` | ✅ (`SettingsService.js:88-119`) |
| K5 | Không có 2 worker cùng sở hữu job | Lease `UPDATE...WHERE` | ✅ (`JobRepository.js:58-91`) |
| K6 | `external_refs` là **bổ sung**, không phải thay thế | Cột JSON | ❌ **Cần làm (GAP-5)** |
| K7 | Backup DB Gateway + BeerPOS trước mỗi GĐ | `scripts/backup.js` | ✅ Có sẵn |
| K8 | Cơ chế "chỉ một hệ thống sở hữu job" | Cờ nguồn sở hữu | ❌ **Cần làm (GAP-9)** |

### 15.4. Kịch bản rollback khẩn cấp

| Tình huống | Hành động trong 15 phút | Kết quả |
|---|---|---|
| Provider mới gửi sai nhóm | `setProvider('disabled')` → chuyển `external_refs` về `omicall` → bật lại | Quay về OmniCall |
| OmniCall hỏng giữa chừng | Bật lại BeerPOS worker trực tiếp (bỏ qua Gateway) | Tiếp tục gửi qua OmniCall |
| Cả hai hỏng | Job tích tụ trong outbox; khôi phục DB từ backup; gửi tay bù | Có độ trễ |
| Nghi ngờ tài khoản Zalo bị khoá | Dừng toàn bộ gửi; kiểm tra tài khoản; quyết định chuyển sang OA (sau khi được duyệt) | Gia đoạn "chờ" |

---

## 16. Danh sách việc cần làm

### 16.1. GĐ0 — Hoàn thiện Gateway (không phụ thuộc provider) — P0

| # | Việc | File dự kiến | Ưu tiên |
|---|---|---|---|
| 1 | Bổ sung `external_refs` (mapping nhiều provider) vào `debt_customer_groups` | `database/migrations/0XX_*.js` | 🔴 P0 |
| 2 | Bổ sung `provider_credentials` / `provider_config` (cấu hình riêng từng provider) | `beerpos-zalo-gateway/src/database/migrations/001_init.js` | 🔴 P0 |
| 3 | `ProviderResolver` — resolve `customerId → externalId` theo provider đang chạy | `beerpos-zalo-gateway/src/services/` | 🔴 P0 |
| 4 | Hook provider báo về thay đổi định danh nhóm (`resolveDestination`) | `beerpos-zalo-gateway/src/providers/MessageProvider.js` | 🔴 P0 |
| 5 | Action audit `PROVIDER_GROUP_REMAP`, `PROVIDER_CREDENTIAL_CHECK` | `beerpos-zalo-gateway/src/services/AuditService.js` | 🔴 P0 |
| 6 | Health check định kỳ của provider + credential | `beerpos-zalo-gateway/src/controllers/healthController.js` | 🔴 P0 |
| 7 | Cờ `needs_review` + chặn gửi khi mapping không xác minh | `beerpos-zalo-gateway/src/services/GroupService.js` | 🔴 P0 |
| 8 | Adapter OmniCall cho Gateway (đưa `OmiCallService` logic vào dạng provider) | `beerpos-zalo-gateway/src/providers/OmniCallProvider.js` | 🔴 P0 |
| 9 | Chống 2 hệ thống cùng retry (cờ chủ sở hữu job) | Gateway + `src/services/notify/NotificationWorker.js` | 🟠 P1 |
| 10 | Đối soát job `sent`/`unknown` định kỳ | `beerpos-zalo-gateway/src/services/` | 🟠 P1 |
| 11 | Metrics endpoint + cảnh báo backlog | `beerpos-zalo-gateway/src/` | 🟠 P1 |
| 12 | Mở rộng `setProvider()` cho phép provider mới | `beerpos-zalo-gateway/src/services/SettingsService.js:88-119` | 🟢 P2 |
| 13 | Watermark `simulated` trên job | `beerpos-zalo-gateway/src/database/repositories/JobRepository.js` | 🟢 P2 |

### 16.2. GĐ2 — Đánh giá provider (công việc bên ngoài code) — P0

| # | Việc | Loại | Phụ trách |
|---|---|---|---|
| 14 | Liên hệ Func.vn: xin **bằng chứng quyền sử dụng** với Zalo, rate limit, SLA | Khảo sát | Chủ hệ thống |
| 15 | Liên hệ Cogover: xác minh **có API gửi tin nhóm Zalo cá nhân không** + endpoint + payload | Khảo sát | Chủ hệ thống |
| 16 | Liên hệ ZaloAI: xin tài liệu API chi tiết | Khảo sát | Chủ hệ thống |
| 17 | Xin **báo giá chính thức** (thay giá niêm yết web) | Khảo sát | Chủ hệ thống |
| 18 | Hỏi rõ: hành vi khi **agent rời nhóm rồi vào lại** — ID nhóm có đổi không | Khảo sát | Kỹ thuật |
| 19 | Hỏi rõ: có **webhook xác nhận giao hàng** (delivery confirmation) không | Khảo sát | Kỹ thuật |
| 20 | Kiểm tra **điều khoản sử dụng** của nhà cung cấp về việc dùng tài khoản cá nhân | Khảo sát | Chủ hệ thống |

### 16.3. GĐ3 — Đồng bộ mapping — P0

| # | Việc | Loại |
|---|---|---|
| 21 | Tạo `scripts/export-group-refs.js` — xuất mapping hiện tại ra CSV (id, tên, chủ quán, thành viên) | Code |
| 22 | Viết `scripts/import-group-refs.js` — nạp `external_refs` đã duyệt | Code |
| 23 | Chạy trên **môi trường thử nghiệm** trước | Vận hành |
| 24 | **Duyệt thủ công 100 dòng** bằng chủ quán/nhân viên | Vận hành |
| 25 | Đánh dấu dòng không khớp → `needs_review` | Vận hành |

### 16.4. GĐ4–GĐ5 — Canary và chuyển đại trà — P0

| # | Việc | Loại |
|---|---|---|
| 26 | Canary 5–10 khách; cơ chế chọn nhóm canary | Vận hành |
| 27 | Dashboard so sánh 2 kênh (số gửi, số lỗi, độ trễ) | Code |
| 28 | Quy trình theo lô 20–30 khách + 3 ngày quan sát/lô | Vận hành |
| 29 | Tài liệu quy trình QR định kỳ (dự phòng tài khoản bị đăng xuất) | Tài liệu |

### 16.5. GĐ6 — Cắt OmniCall — P0

| # | Việc | Loại |
|---|---|---|
| 30 | Xác nhận 30 ngày ổn định, 0 job dùng provider OmniCall | Vận hành |
| 31 | Chụp backup DB BeerPOS + Gateway | Vận hành |
| 32 | Hủy gói OmniCall (lưu ý: trả block 6 tháng — cân nhắc thời điểm hủy) | Tài chính |
| 33 | Giữ `group_id` OmniCall thêm 3 tháng để audit | Vận hành |

---

## 17. Kết luận: GO / CONDITIONAL GO / NO-GO

### 17.1. Đánh giá theo 8 tiêu chí bắt buộc của mục XI

| Tiêu chí | P1 OmniCall | P2 Gateway+OmniCall | P3 Gateway+QR provider | P4 Zalo OA/GMF |
|---|---|---|---|---|
| Giữ tài khoản Zalo cá nhân | ✅ | ✅ | ✅ | ❌ |
| Giữ 100 nhóm hoặc có kế hoạch chuyển đổi được duyệt | ✅ | ✅ | ⚠️ có kế hoạch, **chưa được duyệt** | ❌ phải tạo lại |
| Hiển thị đúng người gửi | ✅ | ✅ | ✅ | ❌ |
| Gửi được đúng nhóm | ✅ | ✅ | ⚠️ phụ thuộc ánh xạ | ✅ |
| API tích hợp ổn định | ✅ | ✅ | ⚠️ | ✅ |
| Căn cứ về quyền sử dụng phù hợp | ✅ | ✅ | ❌ **NOT VERIFIED** | ✅ |
| Chi phí được xác minh | ✅ | ✅ | ⚠️ giá web, **chưa có báo giá chính thức** | ✅ |
| Có thể vận hành và rollback | ✅ | ✅ | ⚠️ | ⚠️ |
| **KẾT LUẬN** | **GO** | **GO** (không đạt G8) | **CONDITIONAL GO** | **NO-GO** |

### 17.2. Trả lời trực tiếp 10 câu hỏi mục XIII

**Câu 1. Có thể bỏ OmniCall hoàn toàn không?**
> **Có — về mặt kỹ thuật, KHÔNG — về mặt điều kiện.**
> Về kỹ thuật: có thể, bằng một provider gửi tin Zalo cá nhân bên thứ ba (Func.vn là ứng viên tốt nhất). Về điều kiện: **chưa** — chưa có bằng chứng quyền sử dụng phù hợp (`NOT VERIFIED`) và chưa có báo giá chính thức (`NEED QUOTATION`) từ bất kỳ nhà cung cấp nào. Chưa đạt 8/8 tiêu chí mục XI.

**Câu 2. Có thể giữ tài khoản Zalo cá nhân hiện tại không?**
> **Có — với mọi phương án khả thi.** Cả P1, P2, P3 đều giữ được tài khoản cá nhân và danh tính người gửi. Điều kiện: chỉ dùng một nơi đăng nhập, và **chấp nhận rủi ro** bị giới hạn/khóa (R4, R5 — không tự phục hồi).
> Chỉ P4 (OA/GMF) vi phạm điều này.

**Câu 3. Có thể giữ nguyên 100 nhóm hiện tại không?**
> **Có — nhưng BẮT BUỘC phải đồng bộ lại mapping.** 100 nhóm Zalo giữ nguyên được (không cần khách vào nhóm mới — đây là điểm tốt). NHƯNG `group_id` hiện tại (Mongo `_id` của OmniCall) **không dùng được** với provider mới → phải liệt kê nhóm lại và ánh xạ thủ công (mục 9.3), có bước duyệt của người.
> Rủi ro lớn nhất của toàn bộ phương án: **gửi tin nhầm nhóm** (R16).

**Câu 4. Có thể giữ nguyên danh tính người gửi không?**
> **Có — với P1, P2, P3.** Tin nhắn sẽ hiển thị từ tài khoản Zalo cá nhân hiện tại.
> P4 (Zalo OA) hiển thị từ OA → **vi phạm**, loại.

**Câu 5. Group ID hiện tại có dùng được với provider khác không?**
> **KHÔNG.** `debt_customer_groups.group_id` chứa Mongo `_id` 24 hex **của riêng OmniCall** (`OmiCallService.js:479-483`). Provider khác dùng ID nhóm Zalo thật → **không tương thích trực tiếp**. Bắt buộc có bảng ánh xạ `external_refs` giữ ID cũ và ID mới, và **giữ ID cũ** để rollback được.

**Câu 6. Có nhà cung cấp nào đã đủ bằng chứng để tích hợp không?**
> **Chưa.** Func.vn có **API kỹ thuật tài liệu đầy đủ nhất** (action `GROUP_SEND_MESSAGE`, webhook, giá 80.000–100.000đ/tháng) — nhưng (c) *được Zalo cho phép* vẫn là `NOT VERIFIED` ở **tất cả** nhà cung cấp, kể cả những nhà cung cấp có tài liệu tốt nhất.
> **Không nhà cung cấp nào đạt mức bằng chứng để đánh dấu `GO`.** Cần liên hệ trực tiếp (việc #14–#20) trước khi quyết định.

**Câu 7. Có phương án nào không mất phí định kỳ không?**
> **Có về hình thức, nhưng không khuyến nghị.** ZaloX gói Pro trả một lần 999.000đ, sau đó 0đ/tháng. Nhưng: không có SLA, không có tài liệu API công khai, và rủi ro giao thức Zalo đổi không được hỗ trợ.
> Các phương án còn lại đều có phí định kỳ. **P3 tiết kiệm 250.000–270.000đ/tháng** so với hiện tại — đây là mức tiết kiệm thực tế tốt nhất.

**Câu 8. Gateway hiện tại cần bổ sung những gì?**
> **10 gap, trong đó 5 cái P0** (mục 10.3):
> **P0:** (1) Cơ chế provider cập nhật ngược `group_id` — GAP-1; (2) `provider_credentials`/`provider_config` — GAP-2; (3) Health/credential check định kỳ — GAP-3; (4) Mapping nhiều provider `external_refs` — GAP-5; (5) Cờ `needs_review` + chặn gửi khi chưa xác minh — GAP-7; (6) Tương đương auto-heal — GAP-8.
> **P1:** Đối soát — GAP-4; Chống 2 hệ thống retry — GAP-9; Metrics — GAP-6.
> **P2:** Watermark `simulated` — GAP-10.
> Ngoài ra cần **Adapter OmniCall cho Gateway** (đưa logic hiện có vào dạng provider), và mở rộng `setProvider()`.
> Đánh giá tổng: Gateway đạt **~9/14 năng lực** (mục 5.1) — người làm hạ tầng tốt, nhưng **chưa có provider thật nào**.

**Câu 9. Rủi ro lớn nhất khi chuyển đổi là gì?**
> **Gửi tin nhầm khách hàng (R16)** — về mặt nghiệp vụ. Nguyên nhân: `group_id` phải ánh xạ lại 100 nhóm; tên nhóm **không duy nhất**; ánh xạ tự động có thể gán sai → tin công nợ của khách A gửi vào nhóm khách B. Hậu quả: mất niềm tin khách hàng, sai lệch công nợ.
> → **Bắt buộc có bước duyệt thủ công 100 dòng mapping.**
> **Rủi ro kỹ thuật lớn thứ hai: tài khoản Zalo cá nhân bị giới hạn/khóa (R5)** — không đo trước, không tự phục hồi, đánh trực tiếp lên G1/G4 và đặt 100 nhóm vào thế khó.
> **Rủi ro kỹ thuật thứ ba: lệch mapping giữa `debt_customer_groups` và `gateway_groups`** (hai bảng độc lập) — đã có cơ chế `saveHealedConvId()` bên OmniCall nhưng Gateway **chưa có** (GAP-1).

**Câu 10. Bạn khuyến nghị triển khai phương án nào và vì sao?**
> **Khuyến nghị 3 bước, không phải 1 phương án:**

> **Bước 1 (NGAY, rủi ro thấp, không tốn phí) — P2: Gateway + OmniCall.**
> Hoàn thiện GAP-1..GAP-10 và đưa OmniCall thành một provider adapter trong Gateway. Đây là bước **không đổi hành vi nghiệp vụ**, giữ nguyên mọi ràng buộc G1–G7, G9, G10, và biến "đổi provider" từ một dự án viết lại thành một thao tác cấu hình. Chi phí: **không đổi (350.000đ/tháng)**.
> *Lý do:* Đây là bước có giá trị cao nhất trên mỗi đồng chi phí, và là **điều kiện tiên quyết** cho mọi phương án P3 sau này. Không có nó, mỗi lần đổi provider đều là viết lại.

> **Bước 2 (song song, không ảnh hưởng production) — GĐ2: Đánh giá provider.**
> Liên hệ Func.vn (ưu tiên), Cogover, ZaloAI. Yêu cầu 4 thứ bắt buộc: **(a)** tài liệu API gửi tin nhóm + định danh nhóm bền vững; **(b)** bằng chứng quyền sử dụng với Zalo; **(c)** báo giá chính thức; **(d)** hành vi khi agent rời/ vào lại nhóm.
> *Lý do:* Đây là điều kiện gỡ `NOT VERIFIED` — điều kiện đang chặn mọi phương án P3 khỏi mức `GO`.

> **Bước 3 (chỉ khi Bước 2 đạt) — P3: Gateway + provider mới, canary 5–10 khách → lô 20–30 khách.**
> *Điều kiện tiên quyết:* chủ hệ thống **tự chấp nhận rủi ro** rõ ràng về việc dùng cơ chế không chính thức, và **duyệt thủ công 100 dòng mapping**.

> **Phương án bị loại: P4 (Zalo OA/GMF) — `NO-GO`.** Vi phạm G1, G4, G6, G7 và **tốn hơn** hiện tại (~500.000đ/tháng + có thể 7.500.000đ/tháng cho 100 gói GMF-100).

### 17.3. Điều kiện còn thiếu để nâng từ `CONDITIONAL GO` lên `GO`

| # | Điều kiện | Trạng thái | Người chịu trách nhiệm |
|---|---|---|---|
| 1 | **Chủ hệ thống chấp nhận rủi ro** dùng cơ chế QR không chính thức (khóa nick) | ❌ CHƯA CÓ | Chủ hệ thống |
| 2 | **Bằng chứng quyền sử dụng phù hợp** từ nhà cung cấp | ❌ `NOT VERIFIED` | Nhà cung cấp |
| 3 | **Báo giá chính thức** (thay giá niêm yết web) | ❌ `NEED QUOTATION` | Nhà cung cấp |
| 4 | **Rate limit / quota** xác minh | ❌ `NOT VERIFIED` | Nhà cung cấp |
| 5 | **Tài liệu API gửi tin nhóm** xác minh (endpoint + payload + định danh nhóm bền vững) | ⚠️ Chỉ Func.vn có tài liệu; Cogover/ZaloAI/ZaloX chưa | Nhà cung cấp |
| 6 | **Cơ chế đối soát giao hàng** (webhook delivery confirmation) | ❌ `NOT VERIFIED` | Nhà cung cấp |
| 7 | **Xác nhận hành vi** khi agent rời nhóm rồi vào lại | ❌ | Nhà cung cấp |
| 8 | **Gateway hoàn thiện GAP-1..GAP-10** | ❌ | Kỹ thuật |
| 9 | **Bảng ánh xạ 100 nhóm được duyệt thủ công** | ❌ | Chủ hệ thống |
| 10 | **Kế hoạch migration + rollback được duyệt** | ❌ | Chủ hệ thống |

### 17.4. Tuyên bố trung thực

> **Không thể khẳng định rằng có thể thay OmniCall mà vẫn giữ tài khoản cá nhân + 100 nhóm + danh tính người gửi** — vì chưa tồn tại bằng chứng nào cho thấy bất kỳ nhà cung cấp nào được Zalo cho phép vận hành.
>
> Điều có thể khẳng định chắc chắn:
> 1. **Kiến trúc thay thế là khả thi** — Gateway đã là hạ tầng đúng, đủ sức làm provider-agnostic.
> 2. **Phương án không vi phạm ràng buộc kinh doanh** — P2 (Gateway + OmniCall) giữ **toàn bộ** 10 ràng buộc, chỉ chưa tiết kiệm tiền.
> 3. **Phương án tiết kiệm tiền** (P3) đòi hỏi 2 điều kiện chưa đạt mà **chỉ chủ hệ thống và nhà cung cấp mới quyết được**: quyền sử dụng và chấp nhận rủi ro.
>
> **Đề nghị:** triển khai Bước 1 (P2) ngay vì nó rẻ, an toàn và là tiền đề bắt buộc; song song thực hiện Bước 2 (đánh giá provider); chỉ triển khai Bước 3 khi 10 điều kiện mục 17.3 được đáp ứng.

---

## Phụ lục A — Danh mục file đã kiểm tra

### BeerPOS (`D:\Beer`)

| File | Vai trò trong audit |
|---|---|
| `src/services/OmiCallService.js` | Toàn bộ logic OmniCall — nguồn chính cho mục 3, 4, 9 |
| `src/services/notify/provider/OmniCallAdapter.js` | Chuẩn hóa kết quả OmniCall |
| `src/services/notify/provider/index.js` | ProviderFactory |
| `src/services/notify/NotificationJobService.js` | Outbox, idempotency, backoff, `findCustomerGroup()` |
| `src/services/notify/NotificationWorker.js` | Worker, lease, retry, unknown |
| `src/services/notify/NotificationAdapter.js` | *(không tồn tại ở dạng tên này — đã dùng `provider/`)* |
| `src/services/notify/CustomerGroupService.js` | Quản lý mapping khách ↔ nhóm |
| `src/services/debt/DebtNotifyService.js` | Điểm tạo job, `saveHealedConvId()` |
| `src/services/debt/DebtPaymentService.js` | Nguồn phát sinh thông báo (thanh toán) |
| `src/services/debt/DebtSepayService.js` | Nguồn phát sinh thông báo (SePay) |
| `src/services/debt/DebtCommandService.js` | Nguồn phát sinh thông báo (lệnh ghi nợ) |
| `src/services/debt/DebtsZaloBridge.js` | Khảo sát cũ về khả năng Zalo cá nhân → `NOT_AVAILABLE` |
| `routes/api/debtLedger.js` | 7 route admin gọi trực tiếp `OmiCallService` |
| `database/migrations/053_debt_management.js` | Schema `debt_customer_groups` |
| `database/migrations/069_debt_notification_jobs.js` | Schema `debt_notification_jobs`, unique index |

### BeerPOS Zalo Gateway (`D:\Beer\beerpos-zalo-gateway`)

| File | Vai trò trong audit |
|---|---|
| `src/providers/MessageProvider.js` | Interface provider + `DELIVERY_STATUS` |
| `src/providers/index.js` | `createProvider()` — chỉ có Mock |
| `src/providers/MockProvider.js` | Provider mô phỏng |
| `src/services/QueueService.js` | Idempotency, lease, `UNSAFE_RETRY` |
| `src/services/WorkerService.js` | Vòng lặp worker, timeout, backoff |
| `src/services/MessageService.js` | `accept()` — tra mapping 1:1, snapshot group_id |
| `src/services/GroupService.js` | CRUD mapping, CSV import, `findActive()` |
| `src/services/SettingsService.js` | `getProvider()`, `setProvider()` |
| `src/services/AuditService.js` | 12 audit action + `sanitizeDetails()` |
| `src/database/repositories/JobRepository.js` | Lease, recovery, trạng thái job |
| `src/database/repositories/GroupRepository.js` | Truy vấn mapping |
| `src/database/migrations/001_init.js` | Schema Gateway (unique indexes) |
| `src/middleware/auth.js` | 2 scope, timing-safe compare |
| `src/utils/crypto.js` | `safeEqual()`, `fingerprint()` |
| `src/controllers/healthController.js` | Health check không lộ secret |
| `src/routes/index.js` | 20 route, phân tách quyền |
| `src/config/index.js` | Config, `assertProductionSafety()` |
| `scripts/sync-groups-from-beerpos.js` | Xuất mapping BeerPOS → Gateway |

### Tài liệu

`docs/OMNICALL_CONNECTION_AUDIT.md` · `beerpos-zalo-gateway/docs/{IMPLEMENTATION_REPORT,AUDIT,ARCHITECTURE,DATABASE,API,INTEGRATION}.md`

---

## Phụ lục B — Nguồn web (kiểm tra 2026-11-27)

| Nguồn | URL | Dùng cho |
|---|---|---|
| Zalo Platform Document Hub — Gửi thông báo văn bản | https://docs.zaloplatforms.com/docs/OA/v2/gui-thong-bao-van-ban | Mục 6.2 |
| Zalo Platform Document Hub — Gửi tin nhóm GMF | https://docs.zaloplatforms.com/docs/OA/nhom-chat-gmf/tin-nhan/text_message | Mục 6.2 |
| Zalo Platform Document Hub — Tạo nhóm mới | https://docs.zaloplatforms.com/docs/OA/nhom-chat-gmf/quan-ly/create_group | Mục 6.2 |
| Zalo Platform Document Hub — Hạn mức nhóm | https://docs.zaloplatforms.com/docs/OA/nhom-chat-gmf/quan-ly/quota | Mục 6.2 |
| Zalo Business Solutions — Hướng dẫn vận hành | https://oa.zalo.me/home/documents/vie/guides/tong-quan-cac-loai-tin-nhan-va-thong-bao-tren-zalo-official-account-_3651713298729094511 | Mục 6.1 |
| Zalo Business Solutions — Quản lý nhóm GMF | https://oa.zalo.me/home/documents/guides/quan-ly-nhom-gmf_1954166378348758227 | Mục 6.1, 6.3 |
| Zalo Business Solutions — Bảng giá OA | https://zalo.solutions/oa/pricing | Mục 6.3, 12.2 |
| Bảng giá dịch vụ Zalo OA (PDF, 01/06/2026) | https://content.zalo.cloud/uploads/ZAP_Bang_gia_Dich_vu_ZOA_01062026_esigned_f340eb1ceb.pdf | Mục 6.3 |
| Zalo Business Solutions — Điều khoản sử dụng | https://zalo.solutions/terms | Mục 6.3, 12.2 |
| Zalo Business Solutions — Cơ chế tính giá | https://zalo.solutions/business-message/guidelines/co-che-tinh-gia-cua-mau-tin-nhan-zbs | Mục 12.3 |
| OMICall — Bảng giá | https://omicall.com/bang-gia/ | Mục 12.1, 12.2 |
| ZaChat — Zalo Cá Nhân Có API Không? | https://zachat.vn/blog/zalo-ca-nhan-co-api-khong | Mục 2.2, 7.5 |
| Func.vn — Bảng giá | https://func.vn/pricing | Mục 7.1 |
| Func.vn — Function API | https://docs.func.vn/quan-ly-account/functions/function-api | Mục 7.1 |
| Func.vn — Zalo User API | https://docs.func.vn/quan-ly-account/functions/function-api/zalo-user-api | Mục 7.1 |
| Func.vn — Gửi tin nhóm Zalo với Mention | https://docs.func.vn/quan-ly-account/functions/function-api/zalo-user-api/gui-tin-nhan-nhom-zalo-voi-mention | Mục 7.1 |
| Func.vn — Function Webhook | https://docs.func.vn/quan-ly-account/functions/function-webhook | Mục 7.1 |
| Cogover — Bảng giá Omnichannel | https://cogover.com/vi/pricing/omnichannel | Mục 7.2 |
| Cogover — Bảng giá Platform | https://cogover.com/vi/pricing/platform | Mục 7.2 |
| ZaloAI — Tính năng | https://zaloai.vn/tinh-nang | Mục 7.3 |
| ZaloX — Bảng giá | https://zalox.shrimpfarm.vn/pricing | Mục 7.4 |
| zalo-agent-cli (GitHub) | https://github.com/ardennguyen/zalo-agent-cli | Mục 7.5 (cảnh báo chính thức của nhà cung cấp) |

---

## Phụ lục C — Tuyên bố tuân thủ

| Mục XII | Trạng thái |
|---|---|
| Không sửa source code | ✅ Chỉ tạo 1 file Markdown mới |
| Không tạo provider thật | ✅ |
| Không thay đổi database | ✅ Không chạy lệnh DB/migration |
| Không chạy migration | ✅ |
| Không đồng bộ mapping production | ✅ |
| Không gửi tin nhắn thật / không gọi API gửi tin | ✅ Chỉ **tìm kiếm web** tài liệu công khai |
| Không đăng nhập Zalo | ✅ |
| Không thay đổi API Key | ✅ |
| Không sửa `.env` | ✅ |
| Không sửa PM2 / Nginx | ✅ |
| Không deploy | ✅ |
| Không push Git | ✅ |
| Không xóa file | ✅ |
| Không thay đổi cấu hình production | ✅ |
| Không in giá trị credential | ✅ Chỉ nêu **tên biến** (`ADMIN_API_KEY`, `INTEGRATION_API_KEY`, `MESSAGE_PROVIDER`, `omicall_api_key`, `tenantId`) và nơi lưu |

**File được tạo duy nhất:** `docs/OMNICALL_REPLACEMENT_FEASIBILITY_AUDIT.md`
