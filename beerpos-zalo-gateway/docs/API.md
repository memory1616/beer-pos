# API - BeerPOS Zalo Gateway

Base URL local: `http://localhost:3100`

> Giai đoạn 2. Toàn bộ API nội bộ đều yêu cầu xác thực.

## 1. Xác thực

Hai nhóm quyền, tách biệt:

| Header | Nhóm | Dùng cho |
|---|---|---|
| `X-API-Key: <ADMIN_API_KEY>` | Admin | Quản lý nhóm, lịch sử, cấu hình, audit |
| `X-API-Key: <INTEGRATION_API_KEY>` | Integration | `POST /api/messages/send`, tra cứu job |

So sánh timing-safe. Key sai → `401 UNAUTHORIZED`. Key của nhóm sai → `403 FORBIDDEN`.

## 2. Error shape

```json
{ "success": false, "error": "Thông báo lỗi", "code": "MACHINE_CODE" }
```

Không bao giờ trả stack trace ra ngoài.

## 3. Health check

### GET /health

Không yêu cầu API key.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 1234,
  "database": { "ok": true, "path": "data/gateway.sqlite" },
  "worker": { "enabled": true, "running": true, "processed": 12 },
  "provider": { "provider": "mock", "available": true, "simulated": true }
}
```

## 4. Account status

### GET /api/account/status — Admin

```json
{
  "success": true,
  "account": {
    "provider": "mock",
    "displayName": "Tài khoản Zalo chính",
    "status": "not_configured",
    "connectionMode": "mock",
    "lastCheckedAt": null,
    "lastError": null
  },
  "provider": {
    "provider": "mock",
    "available": true,
    "simulated": true,
    "reason": "Chưa cấu hình nhà cung cấp Zalo được cấp quyền",
    "capabilities": { "sendMessage": true, "deliveryConfirmation": false }
  }
}
```

## 5. Groups

### GET /api/groups — Admin

Query: `search`, `status` (`active|inactive|all`), `page` (default 1), `limit` (default 50, max 200).

```json
{
  "success": true,
  "total": 3,
  "page": 1,
  "limit": 50,
  "items": [
    {
      "id": 1,
      "customerId": "KH001",
      "customerName": "Quán A",
      "groupId": "GROUP001",
      "groupName": "Nhóm Quán A",
      "note": "",
      "isActive": true,
      "createdAt": "2026-11-27 10:00:00",
      "updatedAt": "2026-11-27 10:00:00"
    }
  ]
}
```

### POST /api/groups — Admin

```json
{
  "customerId": "KH001",
  "customerName": "Quán A",
  "groupId": "GROUP001",
  "groupName": "Nhóm Quán A",
  "note": "ghi chú tuỳ chọn"
}
```

`customerName` và `groupName` không bắt buộc. `groupName` không có thì để null.

Lỗi:

| HTTP | code | Điều kiện |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Thiếu customerId / groupId, groupId rỗng, độ dài vượt quá |
| 409 | `DUPLICATE_CUSTOMER` | customerId đã có mapping active |
| 409 | `DUPLICATE_GROUP` | groupId đã thuộc khách khác |
| 409 | `INACTIVE_EXISTS` | customerId có mapping inactive → dùng PATCH để kích hoạt lại |

Thành công: `201` + object như trên.

### PATCH /api/groups/:id — Admin

Sửa được `groupId`, `groupName`, `customerName`, `note`, `isActive`.

```json
{ "groupId": "GROUP009", "groupName": "Tên mới", "isActive": false }
```

Lỗi `409 DUPLICATE_GROUP` nếu groupId đã thuộc khách khác.

### DELETE /api/groups/:id — Admin

Soft delete: `is_active = 0`. Giữ nguyên lịch sử gửi. Trả `200` + `{ success: true, deactivated: true }`.

### POST /api/groups/import — Admin

Nhận CSV dạng `text/csv` raw body, hoặc JSON `{ "csv": "..." }`.

Header CSV: `customerId,customerName,groupId,groupName,note`

Phản hồi (preview + import):

```json
{
  "success": true,
  "dryRun": true,
  "total": 3,
  "valid": 2,
  "invalid": 1,
  "errors": [
    { "line": 3, "customerId": "KH003", "groupId": "GROUP002", "error": "Group ID đã thuộc khách hàng khác" }
  ],
  "items": [ { "line": 2, "customerId": "KH001", "action": "insert" } ]
}
```

Với `dryRun: false` → chạy trong 1 transaction; dòng lỗi bị bỏ qua, dòng hợp lệ được insert. Lỗi hệ thống → rollback toàn bộ.
## 6. Messages (Integration API)

### POST /api/messages/send

Headers:

```
X-API-Key: <INTEGRATION_API_KEY>
Idempotency-Key: payment-notification-PAY001
```

Body:

```json
{
  "paymentId": "PAY001",
  "customerId": "KH001",
  "message": "Quán đã thanh toán 2.000.000đ"
}
```

Không có `groupId` trong payload. Gateway tự tra mapping.

Thành công — HTTP 202:

```json
{
  "success": true,
  "accepted": true,
  "jobId": "JOB001",
  "status": "queued",
  "provider": "mock"
}
```

Idempotent — gửi lại cùng `Idempotency-Key` trả về job cũ, HTTP 200, không tạo job mới:

```json
{
  "success": true,
  "accepted": true,
  "jobId": "JOB001",
  "status": "sent",
  "provider": "mock",
  "duplicate": true
}
```

Lỗi:

| HTTP | code | Điều kiện |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Thiếu customerId, message rỗng, message quá dài |
| 401 | `UNAUTHORIZED` | Thiếu/sai API key |
| 404 | `CUSTOMER_GROUP_NOT_LINKED` | Khách chưa có mapping active |

```json
{
  "success": false,
  "accepted": false,
  "code": "CUSTOMER_GROUP_NOT_LINKED",
  "message": "Khách hàng chưa được liên kết nhóm"
}
```

Khách có mapping nhưng `is_active = 0` cũng trả `CUSTOMER_GROUP_NOT_LINKED`.

### GET /api/messages/history

Query: `status`, `customerId`, `paymentId`, `from`, `to`, `page`, `limit`.

```json
{
  "success": true,
  "total": 12,
  "page": 1,
  "limit": 50,
  "items": [
    {
      "jobId": 12,
      "paymentId": "PAY001",
      "customerId": "KH001",
      "customerName": "Quán A",
      "groupId": "GROUP001",
      "message": "...",
      "status": "sent",
      "provider": "mock",
      "attempts": 1,
      "createdAt": "2026-11-27 10:00:00",
      "processedAt": "2026-11-27 10:00:05",
      "lastError": null,
      "deliveryStatus": "accepted"
    }
  ]
}
```

### GET /api/messages/jobs/:id

Trả chi tiết job + danh sách lần thử trong `gateway_messages`.

```json
{
  "success": true,
  "job": {
    "id": 12,
    "idempotencyKey": "payment-notification-PAY001",
    "paymentId": "PAY001",
    "customerId": "KH001",
    "groupId": "GROUP001",
    "messageContent": "...",
    "status": "sent",
    "attempts": 1,
    "maxAttempts": 4,
    "provider": "mock",
    "lastError": null,
    "providerResponse": { "providerMessageId": "mock_1", "deliveryStatus": "accepted" }
  },
  "attempts": [
    {
      "id": 12,
      "provider": "mock",
      "status": "sent",
      "errorMessage": null,
      "startedAt": "2026-11-27 10:00:05",
      "completedAt": "2026-11-27 10:00:05"
    }
  ]
}
```

### POST /api/messages/jobs/:id/retry

Chỉ retry được khi trạng thái cho phép: `failed`, `no_group`, `cancelled`.

Job `unknown` bị từ chối — HTTP 409 `UNSAFE_RETRY`, vì có nguy cơ tạo tin trùng.

Job `sent` bị từ chối — HTTP 409 `INVALID_STATE`.

```json
{ "success": true, "jobId": 12, "status": "queued" }
```

### POST /api/messages/jobs/:id/cancel

Chỉ hủy được job `queued` hoặc `retry`. Job đang `processing` hoặc đã `sent` → HTTP 409 `INVALID_STATE`.

```json
{ "success": true, "jobId": 12, "status": "cancelled" }
```

