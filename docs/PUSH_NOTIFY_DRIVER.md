# 🔔 Thông báo đẩy đơn giao cho tài xế (Web Push)

> **Câu trả lời ngắn:** Có. Khi Admin tạo đơn và chọn tài xế, hệ thống gửi thông báo
> "Đơn giao mới" tới đúng tài xế đó — kể cả khi họ đang khoá màn hình hoặc đóng app.

---

## 1. Luồng hoạt động

```
Admin bán hàng
   └─ Chọn "🚚 Giao cho tài xế: <tên tài xế>" trong modal thanh toán
        └─ POST /api/sales  { ..., driverUsername: "ten_tai_xe" }
             ├─ INSERT sales (driver_username = 'ten_tai_xe')   ← atomic
             ├─ Tạo delivery_records  → đơn hiện ngay ở màn "Giao hàng" của tài xế
             ├─ Socket.IO  emit 'order:assigned' → room driver:ten_tai_xe
             │     └─ tài xế đang mở app: banner + âm báo 3 nốt + rung máy
             └─ Web Push  (nếu tài xế đã bật + admin đã bật push_enabled)
                   └─ Thông báo hệ thống trên điện thoại (màn hình khoá)
```

---

## 2. Yêu cầu cài đặt (chỉ làm 1 lần)

### 2.1 Bật tính năng phía Admin

1. Vào **Dashboard → Cài đặt hệ thống → 🔔 Thông báo tài xế**
2. Bật công tắc **"Gửi thông báo đẩy"**
3. (Tùy chọn) Sửa **Tiêu đề thông báo** (mặc định `🔔 Đơn giao mới`)
4. Bấm **💾 Lưu cấu hình**

> Trang quản lý: `/push-notify` — có thêm bảng "Tài xế đã bật thông báo"
> và nút **📤 Gửi thông báo thử** để kiểm tra từng thiết bị.

### 2.2 Tài xế bật thông báo trên điện thoại

1. Tài xế mở **Driver Portal** (app trên điện thoại) → đăng nhập
2. Vào **menu Tài khoản** (góc trên bên phải)
3. Tìm mục **"Thông báo đơn giao mới"** → bấm **Bật**
4. Trình duyệt hỏi "Cho phép thông báo?" → bấm **Cho phép**
5. Xác nhận mục này chuyển sang **"Đang bật"**

> ⚠️ **Bắt buộc HTTPS** (hoặc `localhost`). Web Push không hoạt động trên HTTP.
> Nếu bị "Đã chặn" → vào cài đặt trình duyệt → gỡ chặn thông báo cho domain.

### 2.3 Kiểm tra nhanh

| Kiểm tra | Cách |
|---|---|
| Tài xế đã đăng ký | Trang Admin → bảng "Tài xế đã bật thông báo" |
| Push hoạt động | Nút **Gửi thông báo thử** trên trang Admin |
| Gán đơn hoạt động | Tạo đơn có chọn tài xế → tài xế nhận thông báo |
| Lịch sử gửi | Bảng "Lịch sử gửi" (50 lần gần nhất) |

---

## 3. Vị trí trong mã nguồn

| File | Vai trò |
|---|---|
| `database/migrations/051_driver_push_notifications.js` | Tạo bảng `push_subscriptions`, `push_notifications` + seed settings VAPID |
| `src/services/PushService.js` | Quản lý VAPID, subscribe/unsubscribe, gửi push, ghi log |
| `routes/api/push.js` | API: `/vapid-key`, `/subscribe`, `/unsubscribe`, `/status` + admin endpoints |
| `src/socket/socketServer.js` | `emitOrderAssigned()` — gửi tới room `driver:<username>` |
| `src/socket/socketAuth.js` | `driverRoom(username)` — room riêng cho từng tài xế |
| `routes/api/sales.js` | Validate `driverUsername`, tạo `delivery_records`, gọi `notifyAssignedDriver()` |
| `public/js/driver/push-sw.js` | Service Worker nhận `push` + `notificationclick` |
| `public/js/driver/push.js` | `window.DrvPush` — đăng ký/huỷ subscription |
| `public/js/driver/notify.js` | `window.DrvNotify` — banner + âm báo WebAudio + rung máy |
| `public/js/driver/core.js` | Công tắc bật/tắt trong menu Tài khoản |
| `public/js/realtime.js` | Nghe `order:assigned` → refetch + phát event |
| `public/js/sales.js` | Ô chọn "Giao cho tài xế" trong modal thanh toán Admin |
| `views/push-notify.html` | Trang quản lý Admin |

---

## 4. API

### Tài xế (`requireDriver`)

| Method | Path | Body | Mô tả |
|---|---|---|---|
| GET | `/api/push/vapid-key` | — | Lấy VAPID public key |
| POST | `/api/push/subscribe` | `{ subscription: { endpoint, keys } }` | Đăng ký thiết bị |
| POST | `/api/push/unsubscribe` | `{ endpoint }` | Huỷ thiết bị |
| GET | `/api/push/status` | — | Số thiết bị đang bật |

### Admin (`requireAdmin`)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/push/admin/config` | Đọc cấu hình + thống kê theo tài xế |
| POST | `/api/push/admin/config` | `{ enabled, titleTemplate }` |
| GET | `/api/push/admin/history?limit=50` | Lịch sử gửi |
| POST | `/api/push/admin/test/:username` | Gửi thử cho 1 tài xế |

---

## 5. Bảo mật

- ✅ **Tài xế chỉ nhận thông báo của chính mình** — dùng room riêng `driver:<username>`,
  không broadcast toàn bộ tài xế.
- ✅ **Tài xế không thấy dữ liệu tài chính** — payload chỉ gồm `saleId`, tên/địa chỉ/điện
  thoại khách, số keg, số lít. Không có `total`, `profit`, `cost_price`, `margin`.
- ✅ **Chỉ Admin gán được tài xế** — tài xế cố gán cho tài xế khác → `403`.
- ✅ **Tài xế tự quản lý thiết bị của mình** — endpoint tài xế kiểm tra `requireDriver`.
- ✅ **Fail-open** — lỗi push/socket/delivery KHÔNG làm hỏng luồng tạo đơn.
- ✅ **Subscription chết được dọn tự động** — push service trả 404/410 → tắt `push_enabled`.

---

## 6. Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách sửa |
|---|---|---|
| Không có thông báo nào | `push_enabled = 0` | Bật trong `/push-notify` |
| Báo "Cần kết nối HTTPS" | Đang truy cập qua HTTP | Dùng HTTPS (hoặc `localhost`) |
| Báo "Đã chặn" | Trình duyệt chặn thông báo | Cài đặt trình duyệt → gỡ chặn |
| Tài xế không thấy trong danh sách | Tài xế chưa bật thông báo | Nhắc tài xế vào menu Tài khoản → Bật |
| Nhận thông báo nhưng đơn không hiện ở "Giao hàng" | `delivery_records` chưa tạo | Kiểm tra log `src/logs/` |
| Đơn giao không có tài xế | Admin không chọn tài xế | Chọn "🚚 Giao cho tài xế" khi tạo đơn |

### Log liên quan

```
[PUSH] Generated new VAPID keypair
[PUSH] Saved subscription
[PUSH] order:assigned emitted
[api/sales] ensureRecord failed
```

Xem tại `src/logs/combined.log` hoặc `src/logs/error.log`.

---

## 7. Test

```bash
npx jest tests/driver-push.test.js --coverage=false
```

39 test: migration, VAPID, subscribe/unsubscribe, gửi push, phân quyền API,
socket room riêng, payload không chứa dữ liệu tài chính, UI chọn tài xế.
