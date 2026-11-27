# Audit Tích hợp OmniCall / Zalo — BeerPOS

> Tài liệu READ-ONLY. Không sửa code, không sửa database, không gọi API gửi tin thật.

Ngày audit: 2026-11-27
Phạm vi: `D:\Beer` (BeerPOS) + `D:\Beer\beerpos-zalo-gateway` (Gateway độc lập)

## 0. Nguyên tắc bảo mật đã áp dụng

- Không in giá trị API key / token / cookie / session. Chỉ in tên biến, tên trường, nguồn lưu trữ.
- Không gọi endpoint gửi tin thật của OmniCall. Không thử đăng nhập Zalo.
- Đọc database bằng chế độ `readonly: true` để thống kê.
- Không sửa file, không sửa schema, không deploy, không push Git.

---

## 1. Sơ đồ kết nối hiện tại

```
                    ┌──────────────────────────────────────────┐
                    │            ZALO CÁ NHÂN                   │
                    │  (phiên đăng nhập do NGƯỜI DÙNG quản lý) │
                    └───────────────▲──────────────────────────┘
                                    │ phiên Zalo (QR login do OmiCall quản lý,
                                    │ KHÔNG nằm trong BeerPOS)
                                    │
┌───────────────────────┐            │            ┌────────────────────────┐
│  OMI CALL SaaS        │            │            │   ZALO (ZNS)           │
│  public-v1.omicall.com│────────────┘            │   domain future:       │
│  (tenant của chủ quán)│                         │   gateway.biatuoitayninh.store
└───────────┬───────────┘                         └────────────────────────┘
            │
            │ ① HTTP REST (HTTPS) — BeerPOS → OmiCall
            │    x-api-key + Authorization: Bearer <access_token>
            ▼
┌───────────────────────────────────────────────────────────────────┐
│                        BEERPOS  (D:\Beer)                        │
│                                                                   │
│  routes/api/debtLedger.js      ← UI Sổ công nợ (views/debts.html) │
│        │                                                          │
│        ▼                                                          │
│  src/services/debt/DebtNotifyService.js                           │
│    notifyPaymentAsync()  ──►  NotificationJobService.enqueueJob() │
│        │                        (ghi vào debt_notification_jobs)  │
│        │                                                          │
│        ▼                                                          │
│  src/services/notify/NotificationWorker.js                        │
│    (lease → gọi provider → cập nhật job)                          │
│        │                                                          │
│        ▼                                                          │
│  src/services/notify/provider/index.js  (ProviderFactory)        │
│        ├── MockZaloAdapter      (mô phỏng)                       │
│        ├── OmniCallAdapter      → OmiCallService.js  ★đang chạy   │
│        └── GatewayAdapter       → GatewayClient.js  (Gateway mới)  │
└───────────────────────────────────────────────────────────────────┘
```

**Điểm quan trọng:** BeerPOS **KHÔNG** gọi API OmniCall trực tiếp từ route. Mọi lệnh gửi tin đi qua chuỗi:

`DebtPaymentService` / `DebtSepayService` / `DebtCommandService`
→ `DebtNotifyService.notifyPaymentAsync()` (bất đồng bộ, nuốt lỗi)
→ `NotificationJobService.enqueueJob()` (outbox bền vững trong `debt_notification_jobs`)
→ `NotificationWorker` (nền, lease + retry)
→ `ProviderFactory.getProvider()` → `OmniCallAdapter`
→ `OmiCallService.sendZaloPersonalMessage()` → **HTTPS → OmiCall SaaS**

Riêng các route chẩn đoán/admin (`/notify/test`, `/notify/test-send`, `/notify/probe`, `/notify/conversations`, `/notify/diagnose`) gọi `OmiCallService` **trực tiếp** vì chúng là thao tác quản trị chủ động.

---

## 2. Endpoint BeerPOS đang gọi

Tất cả nằm trong `src/services/OmiCallService.js`.

### 2.1 Host

| Mục đích | Host | Ghi chú |
|---|---|---|
| Base URL cấu hình | `https://public-v1.omicall.com` | `settings.omicall_base_url`, mặc định trong `DEFAULT_BASE_URL` |
| Gửi tin (multi-channel) | `https://social-network-v1.omicrm.com` | Host **khác**, suy ra từ base URL qua `resolveMessageHosts()` |

`resolveMessageHosts()` sinh danh sách host ứng viên theo quy tắc:
- `public-v1.omicall.com` → giữ nguyên + `social-network-v1.omicrm.com`
- `public-v1-stg.omicall.com` → `social-network-v1-stg.omicrm.com`
- Giữ nguyên hậu tố `-stg` khi chuyển đổi giữa production/staging.

### 2.2 Endpoint thực tế

| # | Method | Path | Mục đích | Body |
|---|---|---|---|---|
| E1 | POST | `/api/auth?apiKey=<key>` | Lấy access token | `{ apiKey, tenantId: "", lng: "vi" }` |
| E2 | POST | `/api/auth` | Lấy access token (fallback) | `{ apiKey, tenantId: "", lng: "vi" }` |
| E3 | GET | `/api/auth?apiKey=<key>` | Lấy access token (fallback staging) | — |
| E4 | POST | `/omnichannel/channel/get_all` | Lấy `channel_id` (uid kênh Zalo cá nhân) | `{}` |
| E5 | POST | `/omni_conv/message/send_text?lng=vi` | **Gửi tin** | `{ conv_id, channel_id, text }` |
| E6 | POST | `/omni_conv/message/send_text` | Gửi tin (fallback không `lng`) | `{ conv_id, channel_id, text }` |
| E7 | POST | `/omi_v2/omnichannel/search_v4?page=N&size=M` | Liệt kê hội thoại | `{ types, keyword, sort, is_session, is_blocked, channel_ids }` |
| E8 | POST | `/conversation/add_member_from_list?lng=vi` | Gán agent vào nhóm | `{ id, assign_agent_option: { ids, agent_groups, priority_agent_of_contact, allocate_type } }` |
| E9 | POST | `/omi_v2/conversation/join?lng=vi` | Join phiên chat nhóm | `{ type:'omni_conv', id, kind:'zalo_personal', channel_id, isEnableSession }` |
| E10 | POST | `/api/tenant/detail` | Xác nhận tenant (chẩn đoán) | `{}` |

Lưu ý về E7: đường dẫn có chữ **n** trong "omnichannel". Bản `omichannel` (thiếu n) trả 404.

### 2.3 Biến thể body gửi tin

`buildMessageBodies()` sinh 4 biến thể, thử theo thứ tự:

1. `{ conv_id, channel_id, text }` — **đúng**, dùng thực tế
2. `{ conv_id, text }`
3. `{ convId, text }`
4. `{ convId, message: text }`

Biến thể chứa `channel_id` rỗng bị loại khỏi danh sách (OmiCall trả `error_occurred` ký hiệu chung, không chẩn đoán được).

---

## 3. Cơ chế xác thực với OmniCall

### 3.1 Luồng xác thực

```
BeerPOS  ──POST /api/auth──►  OmiCall
        body { apiKey, tenantId:"", lng:"vi" }
                              │
                              ▼
        { status_code: 9999, payload: { access_token: "..." } }
                              │
        access_token hạn 24h, cache RAM 23h30 (TTL - margin 30 phút)
                              │
                              ▼
        Header gửi tin:  x-api-key: <key>
                          Authorization: Bearer <access_token>
```

Token được cache trong RAM (`Map` trong module, không ghi DB), key cache = `${apiKey}|${baseUrl}`. Đổi API key hoặc base URL → `tokenCache.clear()`.

### 3.2 Nguồn lưu trữ credential

| Tên cấu hình | Nơi lưu | Ghi chú |
|---|---|---|
| `settings.omicall_api_key` | BeerPOS DB `database.sqlite`, bảng `settings` | API key OmiCall. Đọc qua `OmiCallService.getConfig()` |
| `settings.omicall_base_url` | BeerPOS DB, bảng `settings` | Mặc định `https://public-v1.omicall.com` |
| `settings.debt_notify_provider` | BeerPOS DB, bảng `settings` | Chọn provider: `omicall` \| `gateway` \| `mock` \| `disabled` |
| `settings.debt_notify_enabled` | BeerPOS DB, bảng `settings` | `'1'` = bật |
| `settings.debt_notify_channel` | BeerPOS DB, bảng `settings` | `omicall_zalo_personal` |
| `settings.debt_notify_manual_debt` | BeerPOS DB, bảng `settings` | `'1'` = gửi thông báo ghi nợ tay |
| `settings.debt_notify_title` | BeerPOS DB, bảng `settings` | Tiêu đề tin nhắn |
| `process.env.NOTIFICATION_PROVIDER` | Biến môi trường | **Ghi đè** `debt_notify_provider` (ưu tiên cao nhất) |
| `settings.notify_gateway_url` | BeerPOS DB, bảng `settings` | URL Gateway (dùng khi provider = `gateway`) |
| `settings.notify_gateway_api_key` | BeerPOS DB, bảng `settings` | API key Gateway |
| `settings.notify_gateway_timeout_ms` | BeerPOS DB, bảng `settings` | Timeout gọi Gateway |

**Không có biến môi trường nào chứa API key OmniCall.** Toàn bộ nằm trong bảng `settings` của BeerPOS DB. `.env.example` chỉ ghi chú "KHÔNG đặt token ở đây".

### 3.3 Trạng thái thực tế tại thời điểm audit

Đọc `settings` (readonly, đã mask):

| Key | Giá trị |
|---|---|
| `debt_notify_provider` | `gateway` |
| `debt_notify_enabled` | `1` |
| `debt_notify_channel` | `omicall_zalo_personal` |
| `debt_notify_title` | `BIA TƯƠI — Cập nhật công nợ` |
| `debt_notify_worker_enabled` | `1` |
| `debt_notify_retry_max_attempts` | `5` |
| `debt_notify_retry_base_delay_ms` | `60000` |
| `debt_notify_job_lease_ms` | `120000` |
| `debt_notify_job_batch_size` | `10` |
| `omicall_base_url` | `https://public-v1.omicall.com` |
| `omicall_api_key` | **RỖNG** (không có giá trị) |

> `omicall_api_key` rỗng trên DB local này → nếu rollback về `omicall` thì phải nhập key qua UI Sổ công nợ trước.

### 3.4 Phân biệt 4 lớp bảo mật (theo yêu cầu)

| Lớp | Ai giữ | Nơi lưu ở BeerPOS | Có trong DB BeerPOS? |
|---|---|---|---|
| **① Credential BeerPOS → OmniCall** (API key) | Chủ quán, lấy từ omicall.com → Cài đặt → API | `settings.omicall_api_key` | Có (bảng `settings`) |
| **② QR auth OmniCall → Zalo** (phiên đăng nhập Zalo) | **OmiCall SaaS**, quản lý 100% phía họ | **Không** — BeerPOS không đọc/ghi cookie, session, token Zalo | **Không** |
| **③ Group ID** (định danh hội thoại) | Chủ quán lấy từ OmiCall UI | `debt_customer_groups.group_id` | Có |
| **④ Message sending API** | Endpoint OmniCall | `src/services/OmiCallService.js` (hằng số path) | Không (code) |

Điểm quan trọng về lớp ②: BeerPOS **hoàn toàn không can thiệp** vào phiên Zalo. Nó chỉ gọi OmiCall bằng API key; OmiCall tự quản lý phiên Zalo cá nhân (đăng nhập QR, refresh token Zalo). `OmiCallService` có đọc `contact_id` từ JWT của access token OmiCall (để gán agent vào nhóm) — đây là JWT **của OmiCall**, không phải của Zalo.

`src/services/debt/DebtZaloBridge.js` (adapter Zalo trực tiếp) có trạng thái `NOT_AVAILABLE` — ghi rõ trong header: không có API bot chính thức cho Zalo cá nhân, không triển khai thư viện không chính thức, không hardcode cookie/token.

---

## 4. Cấu trúc dữ liệu Group ID

### 4.1 Bảng `debt_customer_groups`

Nguồn: `database/migrations/053_debt_management.js` (tạo) + `069_debt_notification_jobs.js` (siết 1:1).

```sql
CREATE TABLE debt_customer_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  platform    TEXT NOT NULL,
  group_id    TEXT NOT NULL,
  group_name  TEXT,
  status      TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'inactive'
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
```

Ràng buộc (index):

| Index | Cột | Ý nghĩa |
|---|---|---|
| `idx_debt_groups_platform_gid` UNIQUE | `(platform, group_id)` | 1 Group ID chỉ thuộc 1 khách |
| `idx_debt_groups_platform_customer` UNIQUE | `(platform, customer_id)` | 1 khách chỉ có 1 nhóm (thêm ở migration 069) |
| `idx_debt_groups_customer` | `(customer_id)` | Tra cứu nhanh |

Chỉ `platform = 'zalo_personal'` được chấp nhận (`CustomerGroupService.normalizePlatform()` chuẩn hoá các bí danh `zalo`, `zalo_group`, `zalo-group` → `zalo_personal`).

### 4.2 Ngữ nghĩa của `group_id`

`group_id` là **Mongo `_id` (24 ký tự hex) của conversation** trong hệ thống OmiCall — KHÔNG phải `conv.conv_id` dạng số.

Đây là điểm dễ sai nhất. Logic trong `OmiCallService`:

- `resolveMongoConvId()`: nếu `group_id` không khớp `/^[a-f0-9]{24}$/i` → tra cứu `search_v4` để tìm conversation có `conv.conv_id` tương ứng, lấy `it.id` (Mongo `_id`).
- Nếu truyền số → OmiCall trả `user_not_permision`.

### 4.3 Có xuất được toàn bộ ~100 mapping không?

**Có.** Mapping nằm trong một bảng duy nhất, đọc bằng một query:

```sql
SELECT g.customer_id, g.group_id, g.group_name, c.name AS customer_name
  FROM debt_customer_groups g
  JOIN customers c ON c.id = g.customer_id
 WHERE g.platform = 'zalo_personal'
   AND g.status = 'active'
   AND g.group_id IS NOT NULL
   AND TRIM(g.group_id) <> ''
```

Tool đã có sẵn: `beerpos-zalo-gateway/scripts/sync-groups-from-beerpos.js` (đọc đúng query trên, hỗ trợ `--dry-run`, `--yes`, `--csv <file>`).

### 4.4 Thống kê thực tế tại thời điểm audit

Đọc `database.sqlite` (readonly):

| Chỉ số | Giá trị |
|---|---|
| Tổng mapping | `1` |
| Distinct khách hàng | `1` |
| `platform = 'zalo_personal'` + `status='active'` | `1` |
| Khách có >1 nhóm active | `0` (không vi phạm 1:1) |
| `debt_notification_jobs` | `0` dòng |
| `debt_notifications` | `failed: 4` |

> DB local này gần như trống. Môi trường production có ~100 mapping — cần chạy lại script sync trên đúng instance production khi chuyển đổi.

### 4.5 Vòng đời Group ID — điểm mỏng của OmniCall

OmiCall có hành vi: khi agent **rời nhóm rồi vào lại**, OmiCall **tạo conversation MỚI** (id khác) cho cùng một nhóm Zalo và giữ lại conversation cũ (đã chết) trong danh sách. Hai conversation **trùng tên**.

Hệ quả trong BeerPOS:

| Cơ chế | Vị trí |
|---|---|
| Phân loại conv "đã chết" | `OmiCallService.classifyConversationState()` — dựa trên `conv.status === 'inactive'`, `last_message.type === 'activity'`, `chat_session.joined_agents` rỗng |
| Lọc conv sống + gộp trùng tên | `OmiCallService.pickLiveConversations()` |
| Tìm conv sống theo tên | `OmiCallService.findLiveConversationByName()` / `resolveLiveConvId()` |
| Auto-heal khi gửi | `sendZaloPersonalMessage()` → `error_occurred` → `ensureAgentInGroup()` → `resolveLiveConvId()` → gửi lại, trả `healedFrom`/`healedTo` |
| Ghi lại conv mới vào DB | `DebtNotifyService.saveHealedConvId()` → `UPDATE debt_customer_groups SET group_id = ?` (có check trùng `UNIQUE(platform, group_id)`) |
| Đồng bộ hàng loạt từ UI | `routes/api/debtLedger.js` → `GET /notify/conversations` (tự sửa mapping chết) |

**Đây là phần logic phức tạp nhất và là rủi ro lớn nhất khi chuyển sang Gateway** (xem mục 8).

### 4.6 Bảng lịch sử liên quan

| Bảng | Vai trò | Tạo ở migration |
|---|---|---|
| `debt_customer_groups` | Mapping khách ↔ nhóm Zalo | 053 (+069) |
| `debt_notifications` | Lịch sử gửi tin (mỗi lần gửi 1 dòng) | 062 (+069 thêm `job_id`, `provider`, `delivery_status`) |
| `debt_notification_jobs` | Outbox bền vững (idempotency_key UNIQUE) | 069 |
| `debt_audit_logs` | Audit thao tác sổ công nợ | 053 |

---

## 5. Ví dụ request/response đã loại bỏ thông tin bí mật

### 5.1 Lấy access token

```http
POST /api/auth?apiKey=<REDACTED> HTTP/1.1
Host: public-v1.omicall.com
Accept: application/json
Content-Type: application/json

{
  "apiKey": "<REDACTED>",
  "tenantId": "",
  "lng": "vi"
}
```

```json
{
  "status_code": 9999,
  "payload": { "access_token": "<REDACTED>" }
}
```

Lỗi (ví dụ):

```json
{ "status_code": -9999, "message": "api_key_invalid" }
```

### 5.2 Lấy channel_id

```http
POST /omnichannel/channel/get_all HTTP/1.1
Host: social-network-v1.omicrm.com
x-api-key: <REDACTED>
Authorization: Bearer <REDACTED>
Content-Type: application/json

{}
```

```json
{
  "status_code": 9999,
  "payload": {
    "zalo_personal": [
      { "uid": "<REDACTED_CHANNEL_UID>", "name": "<REDACTED>" }
    ]
  }
}
```

### 5.3 Gửi tin

```http
POST /omni_conv/message/send_text?lng=vi HTTP/1.1
Host: social-network-v1.omicrm.com
x-api-key: <REDACTED>
Authorization: Bearer <REDACTED>
Content-Type: application/json

{
  "conv_id": "<REDACTED_MONGO_CONV_ID_24HEX>",
  "channel_id": "<REDACTED_CHANNEL_UID>",
  "text": "🔔 BIA TƯƠI — Cập nhật công nợ\nXin chào Quán A,\n✅ Đã nhận: 2.000.000đ\n💰 Số dư công nợ trước: 3.000.000đ\n📌 Còn nợ: 1.000.000đ\n🕐 27/11/2026 09:15 · Trân trọng cảm ơn quý khách!"
}
```

```json
{
  "status_code": 9999,
  "payload": { "message_id": "<REDACTED>" }
}
```

Lỗi đặc trưng:

| `message` | Nguyên nhân | Xử lý trong BeerPOS |
|---|---|---|
| `user_not_permision` | Agent chưa được gán vào nhóm | `ensureAgentInGroup()` → gửi lại |
| `error_occurred` | Agent chưa có quyền **hoặc** phiên Zalo gián đoạn | Gán agent → retry → auto-heal conv → clear token cache → retry |
| `invalid_param` | `conv_id` sai định dạng / không thuộc tenant | `probeSendEndpoints()` để chẩn đoán |
| `api_key_invalid` / `auth_invalid` | Sai API key | Dừng, không retry |

### 5.4 Chuẩn hoá request/response nội bộ BeerPOS

`OmiCallService` trả về shape thống nhất:

```js
{ success: true,  messageId: string|null, raw: object }
{ success: false, error: string, raw?: object, hint?: string }
```

`OmniCallAdapter` chuyển sang `ProviderResult` (`src/services/notify/provider/NotificationProvider.js`):

| Khái niệm | Hằng số |
|---|---|
| Trạng thái giao hàng | `DELIVERY_STATUS.ACCEPTED` (không bao giờ `DELIVERED`) |
| Mã lỗi | `ERROR_CODES.{PERMISSION_DENIED, INVALID_CONTENT, TIMEOUT, TEMPORARY_ERROR, UNKNOWN_ERROR, INVALID_GROUP, CONFIG_ERROR}` |
| Kết quả chuẩn | `makeResult({...})` / `makeUnknownResult({...})` |

**Giới hạn đã biết của OmniCall:** không có API đối soát trạng thái giao hàng → `deliveryStatus` **chỉ có thể là `accepted`**. `OmniCallAdapter` ghi rõ điều này trong `getProviderStatus().features.deliveryConfirmation = false`.

### 5.5 Nội dung tin nhắn

Sinh tại `DebtNotifyService.buildPaymentMessage()` — **giữ nguyên khi chuyển đổi**:

```
🔔 {title}
Xin chào {customerName},
✅ Đã nhận: {amount}
💰 Số dư công nợ trước: {balanceBefore}
📌 Còn nợ: {balanceAfter}          (hoặc "🎉 Đã trả hết công nợ. Số dư: 0đ")
🕐 {dd/MM/yyyy HH:mm} · Trân trọng cảm ơn quý khách!
```

Biến thể: có "💰 Tiền khách còn dư" khi khách trả dư. Nội dung được **snapshot** vào `debt_notification_jobs.content_snapshot` tại thời điểm tạo job → retry không dựng lại từ số dư mới.

---

## 6. Thành phần có thể tái sử dụng trong Gateway

| # | Thành phần | Vị trí hiện tại | Tái sử dụng thế nào |
|---|---|---|---|
| R1 | `OmiCallService` (toàn bộ logic host/path/body-variant/token-cache/auto-heal) | `src/services/OmiCallService.js` | **Chuyển nguyên văn** làm `OmniCallProvider` trong Gateway (`src/providers/`), không viết lại |
| R2 | `OmniCallAdapter` (chuẩn hoá `ProviderResult`) | `src/services/notify/provider/OmniCallAdapter.js` | Chuyển thành `GatewayOmniCallProvider` trong Gateway, giữ nguyên `classifyOmicallError()` |
| R3 | `classifyOmicallError()` — bảng phân loại lỗi | `OmniCallAdapter.js` | Tái sử dụng nguyên vẹn |
| R4 | `buildPaymentMessage()` / `buildDebtMessage()` — định dạng nội dung | `DebtNotifyService.js` | Giữ nguyên ở BeerPOS; Gateway chỉ nhận `message` đã dựng sẵn |
| R5 | Bảng `debt_customer_groups` + unique index 1:1 | migration 053/069 | **Nguồn dữ liệu** để đồng bộ sang `gateway_groups` (script `sync-groups-from-beerpos.js`) |
| R6 | `CustomerGroupService` (upsert/unlink/setStatus/checkConflicts) | `src/services/notify/CustomerGroupService.js` | Logic nghiệp vụ 1:1 — Gateway `GroupService` đã hiện thực cùng quy tắc |
| R7 | `debt_notification_jobs` (outbox) + `NotificationWorker` (lease/retry) | `src/services/notify/` | **Không nhân bản.** BeerPOS giữ vai trò outbox; Gateway giữ vai trò delivery engine |
| R8 | `buildGatewayIdempotencyKey()` — `payment-notification:<txId>` | `NotificationWorker.js` | Giữ nguyên; Gateway dùng `UNIQUE(idempotency_key)` |
| R9 | `NotificationProvider` interface (`BaseNotificationProvider`) | `src/services/notify/provider/NotificationProvider.js` | Gateway đã có `MessageProvider` tương đương (`getStatus`/`validateDestination`/`sendMessage`/`getCapabilities`) |
| R10 | `GatewayClient` + `GatewayAdapter` | `src/services/notify/` | Đã hoàn tất — là cầu nối BeerPOS ↔ Gateway |
| R11 | Script `sync-groups-from-beerpos.js` | `beerpos-zalo-gateway/scripts/` | Đã có, hỗ trợ `--dry-run`/`--yes`/`--csv` |

**Quan sát quan trọng:** `R1` + `R2` là phần **khó nhất** của toàn bộ tích hợp OmniCall (auto-heal conv chết, gán agent, tra cứu Mongo `_id`, token cache 24h, multi-host fallback). Việc Gateway đã dựng xong provider interface + queue + audit mà **chưa** cần động tới R1 là đúng hướng — nhưng để thay thế OmniCall thật sự thì R1 **bắt buộc** phải vào Gateway.

---

## 7. Thành phần còn thiếu để thay thế OmniCall

| # | Còn thiếu | Mức độ | Ghi chú |
|---|---|---|---|
| M1 | `OmniCallProvider` trong Gateway (`src/providers/`) | **Bắt buộc** | Chuyển `OmiCallService` + `OmniCallAdapter` vào Gateway, bọc theo `MessageProvider` |
| M2 | Cấu hình credential OmniCall trong Gateway | **Bắt buộc** | Gateway có `gateway_settings` — cần key `omicall_api_key`, `omicall_base_url` (không hardcode) |
| M3 | Xác thực **2 tầng** cho request gửi tin từ BeerPOS | **Bắt buộc** | Hiện tại BeerPOS → OmniCall gọi trực tiếp. Khi qua Gateway, Gateway phải auth BeerPOS rồi mới dùng OmniCall key → **2 bước**, phải thiết kế rõ |
| M4 | Xử lý `conv_id` (Mongo `_id`) vs `conv.conv_id` (số) trong Gateway | **Bắt buộc** | `resolveMongoConvId()` chưa có trong Gateway |
| M5 | Auto-heal conv chết | **Bắt buộc** | `resolveLiveConvId()` + `findLiveConversationByName()` + `classifyConversationState()` + `pickLiveConversations()` |
| M6 | Gán agent vào nhóm khi `user_not_permision` | **Bắt buộc** | `ensureAgentInGroup()` (E8 + E9) |
| M7 | `channel_id` lookup + cache | **Bắt buộc** | `fetchChannelId()` + `channelIdCache` 30 phút |
| M8 | Multi-host fallback + detect HTML-vs-JSON | **Bắt buộc** | `resolveMessageHosts()` + regex `/^\s*<(!doctype|html)/i` |
| M9 | Token cache 24h với margin 30 phút | **Bắt buộc** | `tokenCache` trong RAM của tiến trình Gateway |
| M10 | Ghi lại conv mới vào mapping khi auto-heal | **Bắt buộc** | Hiện là `DebtNotifyService.saveHealedConvId()` cập nhật `debt_customer_groups`. Khi qua Gateway, Gateway phải có cơ chế cập nhật ngược `gateway_groups` (và đồng bộ về BeerPOS nếu còn dùng) |
| M11 | Đồng bộ mapping 2 chiều BeerPOS ↔ Gateway | Khuyến nghị | Script 1 chiều hiện có (`sync-groups-from-beerpos.js`). Cần chiều Gateway → BeerPOS khi auto-heal đổi `group_id` |
| M12 | Route chẩn đoán tương đương trong Gateway | Khuyến nghị | `/notify/probe`, `/notify/conversations`, `/notify/diagnose` — hiện chỉ có ở BeerPOS |
| M13 | Tách `settings` của OmniCall khỏi `settings` chung BeerPOS | Tùy chọn | Hiện `omicall_api_key` nằm trong bảng `settings` chung — dễ lẫn với cấu hình khác |
| M14 | Reconciliation job cho trạng thái `unknown` | Khuyến nghị | Gateway đã có trạng thái `unknown` + `no_group`; cần UI đối soát định kỳ |
| M15 | Test contract cho OmniCallProvider | Khuyến nghị | Tái dùng pattern mock của `tests/debt/omi*.test.js` |

---

## 8. Đánh giá rủi ro khi chuyển đổi

### 8.1 Rủi ro cao

| ID | Rủi ro | Mô tả | Giảm thiểu |
|---|---|---|---|
| RK1 | **Mất đồng bộ mapping khi auto-heal** | Auto-heal đổi `group_id` trong `debt_customer_groups`. Nếu Gateway giữ mapping riêng (`gateway_groups`) và không trả ngược, BeerPOS và Gateway sẽ lệch → gửi sai nhóm | Bắt buộc có chiều đồng bộ ngược, hoặc giữ `debt_customer_groups` làm nguồn duy nhất và Gateway chỉ mirror |
| RK2 | **Conv chết không tự phục hồi** | Nếu Gateway không có M5, mọi tin gửi vào nhóm mà agent đã rời → `error_occurred` vĩnh viễn | Bắt buộc triển khai M5/M6 trước khi chuyển |
| RK3 | **Mất quyền agent trong nhóm** | Agent (nhân viên trên OmiCall) bị gỡ khỏi nhóm → nhóm "treo", mọi tin fail | Cần M6 + giám sát `has_member` |
| RK4 | **Bảo mật 2 tầng** | BeerPOS key → Gateway → OmniCall key. Nếu Gateway lộ endpoint không auth, người lạ có thể dùng key OmniCall của chủ quán | Gateway đã có `requireApiKey('integration')` cho `/api/messages/send` — giữ nguyên, tuyệt đối không cho request tự chỉ định Group ID |
| RK5 | **Khoảng trống tin nhắn khi chuyển đổi** | Chuyển provider giữa lúc có job đang `queued` trong `debt_notification_jobs` | Drain hết job cũ trước khi đổi provider; job cũ giữ `provider='omicall'` nên vẫn gửi đúng |

### 8.2 Rủi ro trung bình

| ID | Rủi ro | Giảm thiểu |
|---|---|---|
| RM1 | Rate limit / quota OmiCall khi tất cả tin đi qua Gateway tập trung | Giữ `WORKER_CONCURRENCY=1`, poll interval hợp lý; ~100 khách, vài nghìn tin/tháng → không áp lực |
| RM2 | Hai tầng retry → nhân bản số lần retry | BeerPOS retry (outbox) + Gateway retry (queue) + OmiCall internal retry. Phải định nghĩa rõ trách nhiệm: **BeerPOS chịu trách nhiệm "đã nhận yêu cầu"**, Gateway chịu trách nhiệm "đã gửi tới OmiCall" |
| RM3 | Idempotency key lệch giữa 2 hệ thống | Đã giải quyết: `payment-notification:<txId>` dùng chung. Nhưng phải đảm bảo BeerPOS **luôn** gửi kèm; Gateway có fallback `gateway-notification:<paymentId|customerId>` |
| RM4 | `conv_id` người dùng dán nhầm dạng số | Đã có `resolveMongoConvId()`. Cần giữ nguyên khi chuyển |
| RM5 | Độ trễ thêm 1 bước (BeerPOS → Gateway → OmiCall) | Gateway trả `queued` ngay sau khi ghi job → không chặn luồng thanh toán. Người dùng thấy tin sau vài giây thay vì tức thì |

### 8.3 Rủi ro thấp

| ID | Rủi ro | Giảm thiểu |
|---|---|---|
| RL1 | Định dạng nội dung tin lệch | Không đổi `buildPaymentMessage()` |
| RL2 | Nhân viên không biết dùng hệ mới | Cùng UI Sổ công nợ; chỉ đổi nhãn provider + thêm mục trạng thái Gateway |
| RL3 | Bảng `settings` lẫn cấu hình OmniCall/Gateway | Tách rõ tên key; Gateway dùng `gateway_settings` riêng |

### 8.4 Kết luận rủi ro

**Chuyển đổi là khả thi**, nhưng **KHÔNG được coi là chỉ "đổi endpoint"**. Rủi ro nằm ở chỗ:

1. BeerPOS hiện giữ **toàn bộ** logic OmniCall ở phía mình (R1–R3, M4–M9). Gateway hiện chỉ có provider interface + `MockProvider` — **chưa có** provider OmniCall thật.
2. Vòng đời `group_id` của OmniCall có **auto-heal** (M5/M11) — đây là phần dễ vỡ nhất khi tách mapping sang 2 database.

**Đề xuất lộ trình (an toàn, rollback được):**

```
Bước 1  Giữ provider = 'omicall' (hiện tại). Port OmiCallProvider sang Gateway
         với provider='mock' để test — CHƯA bật.
Bước 2  Đồng bộ toàn bộ mapping sang gateway_groups (script --dry-run rồi --yes).
Bước 3  Bật provider='gateway' cho 1 nhóm thử nghiệm, theo dõi 1 tuần.
Bước 4  Mở rộng toàn bộ nhóm. GIỮ `debt_customer_groups` làm nguồn sự thật
         và đồng bộ 2 chiều (hoặc Gateway đọc BeerPOS qua API nội bộ).
Bước 5  Rollback bất kỳ lúc nào:
         UPDATE settings SET value='omicall' WHERE key='debt_notify_provider';
```

> Lưu ý: vì `settings.omicall_api_key` hiện **RỖNG** trên DB local, bước rollback cần nhập lại key qua UI Sổ công nợ (`POST /api/debt-ledger/notify/settings`) — không nên hardcode key vào code hay file cấu hình.

---

## 9. Phụ lục — Bảng tra cứu nhanh

| Cần biết | Trả lời |
|---|---|
| BeerPOS gọi OmniCall trực tiếp hay qua service trung gian? | **Qua service trung gian**: `DebtNotifyService` → `NotificationJobService` (outbox) → `NotificationWorker` → `OmniCallAdapter` → `OmiCallService`. Chỉ các route admin chẩn đoán gọi thẳng `OmiCallService`. |
| API Base URL | `settings.omicall_base_url` (mặc định `https://public-v1.omicall.com`); host gửi tin `social-network-v1.omicrm.com` |
| API endpoint gửi tin | `POST /omni_conv/message/send_text?lng=vi` |
| Xác thực | `x-api-key: <key>` + `Authorization: Bearer <access_token>`; token lấy qua `POST /api/auth`, hạn 24h, cache RAM |
| Nguồn API key | Bảng `settings` của BeerPOS DB — key `omicall_api_key`. Không có trong biến môi trường |
| Group ID lưu ở bảng nào | `debt_customer_groups.group_id` (platform `zalo_personal`) — Mongo `_id` 24 hex của conversation OmiCall |
| Xuất được toàn bộ mapping không | **Có** — 1 bảng, 1 query; đã có `beerpos-zalo-gateway/scripts/sync-groups-from-beerpos.js` |
| Payload chuẩn hoá ra sao | `OmiCallService` → `{success, messageId|error}`; `OmniCallAdapter` → `ProviderResult` (`DELIVERY_STATUS.ACCEPTED`, `ERROR_CODES.*`) |
| Có QR login trong BeerPOS không | **Không**. QR/session do OmiCall quản lý; BeerPOS không lưu cookie/token/mật khẩu Zalo |
| Có trạng thái "đã gửi thành công" giả không | **Không**. OmniCall không có API đối soát → `deliveryStatus` chỉ là `accepted`, không bao giờ `delivered` |

---

## 10. Tài liệu liên quan

| File | Nội dung |
|---|---|
| `beerpos-zalo-gateway/docs/AUDIT.md` | Audit tổng thể khi khởi tạo Gateway |
| `beerpos-zalo-gateway/docs/ARCHITECTURE.md` | Kiến trúc Gateway |
| `beerpos-zalo-gateway/docs/DATABASE.md` | Schema `gateway_*` |
| `beerpos-zalo-gateway/docs/API.md` | REST API Gateway |
| `beerpos-zalo-gateway/docs/INTEGRATION.md` | Hợp đồng tích hợp BeerPOS ↔ Gateway |
| `beerpos-zalo-gateway/docs/IMPLEMENTATION_REPORT.md` | Báo cáo bàn giao 7 giai đoạn |
| `src/services/OmiCallService.js` | Toàn bộ logic OmniCall |
| `src/services/notify/provider/OmniCallAdapter.js` | Chuẩn hoá `ProviderResult` |
| `src/services/notify/CustomerGroupService.js` | Quy tắc 1 khách = 1 nhóm |
