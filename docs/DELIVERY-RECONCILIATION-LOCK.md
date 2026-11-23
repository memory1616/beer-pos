# ĐỐI SOÁT PHIẾU GIAO HÀNG 1 LẦN & KHOÁ SỐ LIỆU ĐÃ XÁC NHẬN

> Nghiệp vụ chốt ngày **2026-11-23**:
> 1. *"Mỗi hóa đơn giao hàng chỉ được đối soát một lần."*
> 2. *"Không cho sửa số liệu đã xác nhận nếu không có quyền quản lý."*

---

## 1. Tóm tắt

| Yêu cầu | Cơ chế | Mã lỗi | HTTP |
|---|---|---|---|
| Đối soát 1 lần / phiếu giao | Cột `delivery_records.reconciled_at` | `ALREADY_RECONCILED` | 409 |
| Không sửa số liệu đã xác nhận (nếu không có quyền quản lý) | Cột `delivery_records.confirmed_by` | `MANAGEMENT_REQUIRED` | 403 |

---

## 2. Schema (migration 068)

`database/migrations/068_delivery_reconciliation_lock.js` — thêm 3 cột (idempotent, additive):

| Cột | Ý nghĩa |
|---|---|
| `reconciled_at` | Thời điểm phiếu được đối soát. **Non-NULL ⇒ đã đối soát ⇒ không ghi lần 2.** |
| `reconciled_by` | Username người đối soát (audit). |
| `confirmed_by` | Username đã nhập/xác nhận số liệu giao (audit). |

Migration chạy tự động khi khởi động server (`database.js` → `runDeliveryReconciliationLockMigration`).

---

## 3. Nguyên tắc phân quyền

### 3.1. Đối soát 1 lần (áp dụng MỌI vai trò)

Sau khi phiếu giao được xác nhận số liệu lần đầu → `reconciled_at` được ghi → các lần ghi sau bị chặn.

- Chặn ở: `confirmDelivery`, `recordDiscrepancy`.
- Quản lý (`ADMIN`/`MANAGER`) có thể ghi đè qua `force: true` (chỉ từ API admin, có audit log).

### 3.2. Khoá số liệu đã xác nhận

**Điều kiện khoá** (`DeliveryService.hasConfirmedFigures`):

```
confirmed_by IS NOT NULL  OR  reconciled_at IS NOT NULL
```

⚠️ **KHÔNG dựa vào `status`** — vì tài xế có thể bấm nhanh "Xong" (`updateStatus` → `DELIVERED`) mà chưa nhập số liệu giao. Phiếu đó vẫn phải cho phép ghi sai lệch / số vỏ thu.

**Khi đã khoá**: chỉ vai trò có quyền quản lý mới sửa được.

- Vai trò quản lý: `ADMIN`, `MANAGER` (tra cứu `app_users.role` nếu session không có role).
- Chặn ở: `confirmDelivery`, `recordDiscrepancy`, `updateCollectedKegs`, `updateStatus`.

---

## 4. API

### 4.1. Driver Portal (`/api/driver/*` — role DRIVER)

| Endpoint | Hành vi mới |
|---|---|
| `POST /deliveries/:id/confirm` | 409 nếu đã đối soát · 403 nếu số liệu đã xác nhận |
| `POST /deliveries/:id/discrepancy` | 409 nếu đã đối soát · 403 nếu số liệu đã xác nhận |
| `POST /deliveries/:id/kegs` | 403 nếu số liệu đã xác nhận |
| `PATCH /deliveries/:id/status` | 403 nếu số liệu đã xác nhận (trừ khi giữ nguyên trạng thái) |

### 4.2. Admin (`/api/admin/*` — role ADMIN)

| Endpoint | Mô tả |
|---|---|
| `GET /api/admin/deliveries/reconciliation` | Danh sách phiếu giao đã đối soát (`?limit=&offset=&reconciled=0` để xem tất cả) |
| `PUT /api/admin/deliveries/:id/confirm` | Quản lý sửa lại số liệu đã xác nhận (`force`) |
| `POST /api/admin/deliveries/:id/reconcile` | Đánh dấu phiếu đã đối soát (khoá 1 lần) |

---

## 5. UI

`views/driver/delivery.html`:
- Panel giao hàng hiện banner 🔒 *"Số liệu đã xác nhận — không thể sửa. Liên hệ quản lý nếu cần điều chỉnh."*
- Nút **"Xác nhận giao"** và **"Có sai lệch"** bị vô hiệu hoá khi phiếu đã đối soát.
- Toast thân thiện theo mã lỗi (`ALREADY_RECONCILED` / `MANAGEMENT_REQUIRED`).

---

## 6. Audit trail

Mọi thao tác đều ghi vào `delivery_events`:

| `event_type` | Khi nào |
|---|---|
| `CONFIRMED` | Xác nhận số liệu giao (kèm `confirmed_by`) |
| `RECONCILED` | Đánh dấu đã đối soát (kèm `reconciled_at`) |
| `DISCREPANCY` | Ghi nhận sai lệch |
| `KEGS_UPDATED` | Cập nhật số vỏ thu |
| `STATUS_CHANGED` | Đổi trạng thái phiếu |

---

## 7. Test

`tests/delivery-reconciliation-lock.test.js` — 18 test:
- Migration 068 idempotent + có đủ cột.
- Đối soát 1 lần (confirm lần 2 → `ALREADY_RECONCILED`, số liệu không đổi).
- Khoá số liệu đã xác nhận (driver bị 403, admin được phép).
- API mapping status 409 / 403.

Chạy: `npx jest tests/delivery-reconciliation-lock.test.js`
