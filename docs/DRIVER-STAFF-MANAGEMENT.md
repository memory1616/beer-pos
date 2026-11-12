# QUẢN LÝ TÀI XẾ & LƯƠNG TÀI XẾ

> Bia Tươi Tây Ninh — Tích hợp trong trang `/sales-staff` của admin portal
> `https://admin.biatuoitayninh.store/sales-staff`

---

## 1. Tổng quan

Module này bổ sung **2 tab** vào trang `/sales-staff` hiện có:

| Tab | Mục đích |
|-----|----------|
| 🚚 **Tài xế** | Tạo / sửa / khoá / mở khoá hồ sơ tài xế + tài khoản đăng nhập Driver Portal |
| 💵 **Lương tài xế** | Bảng lương **cứng theo tháng** (tuỳ chỉnh), đánh dấu đã trả, lịch sử |

### Mô hình dữ liệu

Tài xế là **thực thể riêng**, KHÔNG dùng chung bảng `sales_staff` (module Sales):

```
app_users (tài khoản đăng nhập)          driver_staff (hồ sơ tài xế)
┌────────────────────────────┐            ┌────────────────────────────┐
│ id        PK               │◄───1:1────│ id            PK           │
│ username  UNIQUE           │            │ app_user_id  FK            │
│ password_hash (scrypt)     │            │ username                   │
│ role      (ADMIN/DRIVER)   │            │ full_name, phone           │
│ active, must_change_password│           │ monthly_salary  ← lương cố định
│ last_login_at              │            │ bank_account, note         │
└────────────────────────────┘            │ active                     │
                                          └────────────────────────────┘
                                                     │ 1:N
                                          ┌────────────────────────────┐
                                          │ driver_monthly_salary      │
                                          │ driver_id, year, month     │
                                          │ base_salary, bonus         │
                                          │ deduction, total           │
                                          │ status (pending/paid)      │
                                          └────────────────────────────┘
```

**Công thức lương:** `total = base_salary + bonus - deduction`

### Quy tắc nghiệp vụ

1. **Lương cố định** (`driver_staff.monthly_salary`) là mức lương tháng mặc định.
   Khi chưa thiết lập riêng cho một tháng → hệ thống dùng mức này (đánh dấu *(mức cố định)*).
2. **Thiết lập lương cho tháng** tạo/ghi đè bản ghi trong `driver_monthly_salary`.
   Cập nhật một phần chỉ ghi đè trường được gửi — **không mất** các trường khác.
3. **Khoá tài xế** → `driver_staff.active = 0` + `app_users.active = 0` +
   xoá toàn bộ `auth_sessions` (huỷ phiên đang đăng nhập).
4. **Mở khoá** → kích hoạt lại hồ sơ + tài khoản.
5. Tài xế đã có tài khoản `app_users` → khi tạo hồ sơ mới sẽ **tái sử dụng** tài khoản đó
   (không tạo trùng).

---

## 2. API

Tất cả endpoint dưới đây **chỉ ADMIN** truy cập được.
Tài xế (role `DRIVER`) nhận `403 DRIVER_FORBIDDEN` từ `apiGuard` ở tầng backend.

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| `GET` | `/api/admin/driver-staff` | Danh sách tài xế (`?includeInactive=1` để gồm đã khoá) |
| `GET` | `/api/admin/driver-staff/:id` | Chi tiết hồ sơ tài xế |
| `POST` | `/api/admin/driver-staff` | Tạo tài xế (+ tạo tài khoản đăng nhập nếu chưa có) |
| `PUT` | `/api/admin/driver-staff/:id` | Sửa hồ sơ / lương cố định / đổi mật khẩu / khoá-mở |
| `DELETE` | `/api/admin/driver-staff/:id` | Khoá tài xế (soft delete) |
| `GET` | `/api/admin/driver-staff/salary/summary?year=&month=` | Bảng lương tháng |
| `PUT` | `/api/admin/driver-staff/:id/salary` | Thiết lập lương 1 tài xế cho 1 tháng |
| `POST` | `/api/admin/driver-staff/:id/salary/paid` | Đánh dấu đã trả / bỏ đánh dấu |
| `GET` | `/api/admin/driver-staff/:id/salary-history` | Lịch sử lương |

### Ví dụ

**Tạo tài xế:**

```bash
curl -X POST https://admin.biatuoitayninh.store/api/admin/driver-staff \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{
    "username": "tai_xe_01",
    "password": "MatKhau@2026",
    "fullName": "Nguyễn Văn A",
    "phone": "0901234567",
    "monthlySalary": 5000000
  }'
```

**Thiết lập lương tháng:**

```bash
curl -X PUT https://admin.biatuoitayninh.store/api/admin/driver-staff/1/salary \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"year":2026,"month":11,"baseSalary":5000000,"bonus":1000000,"deduction":200000}'
```

**Đánh dấu đã trả:**

```bash
curl -X POST https://admin.biatuoitayninh.store/api/admin/driver-staff/1/salary/paid \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"year":2026,"month":11,"paid":true}'
```

---

## 3. Migration

Migration `044_driver_staff_salary` — **ADDITIVE**, không sửa/xoá dữ liệu kinh doanh.

- File: `database/migrations/044_driver_staff_salary.js`
- Chạy tự động khi khởi động server (`runDriverStaffMigration` trong `database/migration.js`)
- Idempotent: `CREATE TABLE IF NOT EXISTS` → chạy lại nhiều lần vẫn an toàn
- Rollback chỉ xoá 2 bảng `driver_*`, **không** đụng `app_users` hay bảng kinh doanh

Deploy tự động (`deploy/deploy.sh`) sẽ:

1. Backup file hiện tại
2. `node -c` kiểm tra syntax (bao gồm `routes/api/driverStaff.js`,
   `src/services/DriverStaffService.js`, `database/migrations/044_driver_staff_salary.js`)
3. `pm2 restart beer-pos` → migration 044 tự chạy khi app khởi động
4. Health check `/health`

---

## 4. Bảo mật

| Lớp | Cơ chế |
|-----|--------|
| HTTP route | `requireAdmin` trong `routes/api/driverStaff.js` → 401/403 |
| API guard | `/api/admin` nằm trong `DRIVER_DENIED_PATH_PREFIXES` → 403 `DRIVER_FORBIDDEN` |
| Page guard | `/sales-staff` nằm trong `ADMIN_ONLY_PAGES` → 403 cho DRIVER |
| Dữ liệu | Response **không bao giờ** chứa `password_hash` |
| Mật khẩu | Hash bằng `crypto.scryptSync` (`scrypt$N$r$p$salt$hash`) |
| Self-service | Tài xế KHÔNG thể tự tạo tài khoản / tự nâng quyền (test D2 + A) |

---

## 5. Test

```bash
# Unit + integration (Jest)
npx jest tests/driver-staff.test.js --forceExit

# Smoke test service (không cần HTTP)
node scripts/test-driver-staff.js

# Kiểm tra endpoint HTTP thật (cần server local chạy ở port 3301)
node scripts/verify-driver-staff-endpoints.js
```

**Nội dung test** (`tests/driver-staff.test.js` — 19 case):

- **A. RBAC** — driver bị chặn 403 ở mọi endpoint; không đăng nhập → 401
- **B. Quản lý hồ sơ** — tạo tài xế + tài khoản, đăng nhập được, không lộ
  `password_hash`, sửa hồ sơ đồng bộ `app_users`, chặn trùng username
- **C. Lương tháng** — công thức `total`, cập nhật một phần không mất trường,
  bảng tổng hợp, đánh dấu đã trả, từ chối kỳ lương sai, lịch sử
- **D. Khoá tài xế** — khoá tài khoản + huỷ session + không đăng nhập được

---

## 6. CLI (tuỳ chọn)

Tạo tài khoản tài xế nhanh từ server (không qua UI):

```bash
node scripts/create-driver.js create <username> <password> [fullName] [phone]
```

Xem danh sách: `node scripts/create-driver.js list`
Khoá: `node scripts/create-driver.js disable <username>`

---

## 7. Checklist xác minh production

- [ ] Mở `https://admin.biatuoitayninh.store/sales-staff` → thấy 5 tab
- [ ] Tab **🚚 Tài xế** → bấm "+ Thêm tài xế" → tạo thử 1 tài xế
- [ ] Đăng nhập `https://giaohang.biatuoitayninh.store` bằng tài xế vừa tạo → vào được
- [ ] Tab **💵 Lương tài xế** → chọn tháng → thấy tài xế với mức lương cố định
- [ ] Bấm ✏️ → đặt lương cơ bản + thưởng + phạt → kiểm tra Tổng
- [ ] Bấm ✓ → trạng thái chuyển sang "Đã trả"
- [ ] Đăng nhập Driver Portal bằng tài xế → thử gọi
      `/api/admin/driver-staff` → phải nhận `403 DRIVER_FORBIDDEN`
- [ ] `GET /health` → `ok: true`
