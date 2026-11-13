# Hướng dẫn cấu hình Báo cáo tự động qua Zalo OA

> Áp dụng cho hệ thống Beer POS — tính năng gửi báo cáo bán hàng mỗi tối tới
> Zalo Official Account (OA) của doanh nghiệp.

---

## 0. Tóm tắt nhanh

| Bước | Nội dung | Ở đâu |
|---|---|---|
| 1 | Tạo Zalo OA (nếu chưa có) | `oa.zalo.me` |
| 2 | Tạo Zalo App + liên kết với OA | `developers.zalo.me` |
| 3 | Cấp quyền & lấy Access Token | `developers.zalo.me` → OA quản lý |
| 4 | Người nhận nhắn tin / quan tâm OA | Zalo app |
| 5 | Lấy `user_id` người nhận | Nút **📋 Lấy danh sách** trong hệ thống |
| 6 | Nhập cấu hình + bật tự động | `/report-notify` |
| 7 | Kiểm tra | Nút **👁 Xem thử** → **📤 Gửi ngay** |

---

## 1. Tạo Zalo Official Account (OA)

> Nếu doanh nghiệp **đã có OA** (tên hiển thị ví dụ `Biáu Tươi Tây Ninh`) thì bỏ qua bước này.

### 1.1 Xác thực domain (nếu Zalo yêu cầu)

Khi đăng ký OA, Zalo có thể yêu cầu **xác thực website** của doanh nghiệp. Zalo
sẽ cấp cho bạn 1 file HTML, ví dụ `zalo_verifierOCI75BdpBZX6vAbklFOoPcxPv5c2hpy0CZKs.html`,
và đòi host file này ở **root domain**:

```
https://<domain-cua-ban>/zalo_verifierOCI75BdpBZX6vAbklFOoPcxPv5c2hpy0CZKs.html
```

**Cách làm trên Beer POS:**

1. Đặt file vào `public/` (đã có sẵn trong repo cho OA hiện tại):
   ```
   public/zalo_verifierOCI75BdpBZX6vAbklFOoPcxPv5c2hpy0CZKs.html
   ```
2. Chạy script để nginx serve file trực tiếp trên HTTP (bypass redirect):
   ```bash
   cd /var/www/beer-pos
   python3 scripts/setup-zalo-domain-verification.py zalo_verifierOCI75BdpBZX6vAbklFOoPcxPv5c2hpy0CZKs.html
   ```
   Script tự backup config, chạy `nginx -t` và rollback nếu có lỗi.

3. Kiểm tra:
   ```bash
   curl -s https://<domain-cua-ban>/zalo_verifierOCI75BdpBZX6vAbklFOoPcxPv5c2hpy0CZKs.html
   ```
   Phải trả về nội dung chứa meta tag `zalo-platform-site-verification`.

> **Vì sao cần bước này?** Domain gốc chạy nginx redirect HTTP → HTTPS. Zalo bot
> đôi khi không follow redirect nên verification sẽ fail. Script thêm
> `location = /<file>` vào block `listen 80` để serve thẳng từ disk.

### 1.2 Đăng ký OA

1. Truy cập <https://oa.zalo.me>
2. Chọn **Đăng ký OA** → đăng ký bằng tài khoản Zalo của chủ doanh nghiệp.
3. Điền thông tin doanh nghiệp:
   - Tên doanh nghiệp
   - Mã số thuế
   - Người đại diện (tài khoản Zalo của chủ xe)
4. Chờ Zalo duyệt (thường 1–2 ngày làm việc).

**Sau khi có OA**, bạn sẽ có:
- **OA ID** (dạng số)
- **Tên OA hiển thị** trên Zalo (người nhận sẽ search theo tên này)

---

## 2. Tạo Zalo App và liên kết với OA

1. Truy cập <https://developers.zalo.me>
2. Đăng nhập bằng **chính tài khoản Zalo quản trị OA** (tài khoản này phải là
   Admin/Owner của OA, nếu không sẽ không thấy OA trong danh sách).
3. Vào **Quản lý ứng dụng** → **Tạo ứng dụng**:
   - Loại ứng dụng: **Zalo Official Account**
   - Điền tên: ví dụ `Beer POS - Báo cáo tự động`
   - Điền **Callback URL** (xem bước 3 nếu dùng OAuth v4), ví dụ:
     `https://admin.biatuoitayninh.store/api/report-notify/zalo/callback`
4. Tạo xong, hệ thống hiển thị:
   - **App ID**
   - **Secret Key** → bấm vào để xem/copy

> ⚠️ **Lưu ý:** khi tạo App, Zalo yêu cầu chọn OA cần liên kết và **chọn các quyền
> (scope)**. Bắt buộc bật:
> - `Gửi tin nhắn tư vấn` (tin tư vấn / CS) — để gửi báo cáo
> - `Quản lý thông tin người dùng` — để tra cứu `user_id` người nhận
>
> Nếu không bật quyền "Quản lý thông tin người dùng", nút **📋 Lấy danh sách**
> sẽ báo lỗi quyền — khi đó chỉ cần dán `user_id` thủ công.

---

## 3. Lấy Access Token

> ⭐ **Cách nhanh nhất (khuyến nghị):** xem [Mục 3.1](#31-cách-nhanh-1-click--nút-kết-nối-zalo-oa).
> Chỉ cần nhấn 1 nút trong hệ thống, Zalo mở trang cấp quyền, bạn bấm **Cho phý**,
> xong hệ thống tự lưu token. Không cần copy code verifier, không cần gọi curl.

### 3.1 Cách nhanh (1 click — nút "Kết nối Zalo OA")

**Điều kiện:** App đã tạo ở Bước 2, và **Callback URL** đã được đăng ký trong App:
```
https://admin.biatuoitayninh.store/api/report-notify/zalo/callback
```

**Cách làm:**

1. Vào `/report-notify` → kênh **Zalo OA**
2. Mở mục **🔑 Nâng cao — OAuth v4** → nhập **App ID** + **Secret Key** →
   bấm **💾 Lưu cấu hình**
3. Bấm nút **🔗 Kết nối Zalo OA**
4. Zalo mở tab cấp quyền → chọn **đúng OA** của bạn → bấm **Cho phép**
5. Zalo redirect về trang báo **"✅ Đã cấu hình Zalo OA thành công!"**
6. Quay lại `/report-notify` → access token + refresh token đã được lưu tự động
7. Tiếp tục sang [Bước 4](#4-chuẩn-bị-người-nhận) và [Bước 5](#5-cấu-hình-trong-beer-pos)

> Hệ thống tự sinh `code_verifier` (PKCE S256), lưu tạm vào DB, dùng khi đổi code
> → token, rồi xoá. Bạn không cần làm gì thủ công.

### 3.2 Cách A — Token tĩnh (đơn giản, dùng thử nhanh)

1. Vào <https://developers.zalo.me> → **OA quản lý** → chọn OA của bạn.
2. Mục **Access Token** → **Tạo access token** → copy chuỗi token.

> ⚠️ Access token chỉ sống **25 giờ**. Dùng cách A thì hệ thống sẽ ngừng gửi
> sau ~1 ngày. Nếu chỉ dùng để test thì OK.

### 3.3 Cách B — OAuth v4 thủ công (khuyến nghị, dùng lâu dài)

1. Trong App đã tạo, vào **Cấu hình OAuth**:
   - **Callback URL**: `https://admin.biatuoitayninh.store/api/report-notify/zalo/callback`
   - Bật **PKCE** (code challenge) — hệ thống tự sinh `code_verifier`.
2. Lấy **Authorization Code**:
   - Mở URL (thay `APP_ID`):
     ```
     https://oauth.zaloapp.com/v4/oa/permission?app_id=APP_ID&redirect_uri=https%3A%2F%2Fadmin.biatuoitayninh.store%2Fapi%2Freport-notify%2Fzalo%2Fcallback&code_challenge=CODE_CHALLENGE&code_challenge_method=S256&state=STATE
     ```
   - Admin OA chọn đúng OA → **Cho phép** → Zalo redirect về callback URL kèm:
     `?code=<AUTHORIZATION_CODE>&oa_id=<OA_ID>&state=<STATE>`
3. Đổi code lấy token:
   ```bash
   curl -X POST 'https://oauth.zaloapp.com/v4/oa/access_token' \
     -H 'Content-Type: application/x-www-form-urlencoded' \
     -H 'secret_key: <SECRET_KEY>' \
     --data-urlencode 'code=<AUTHORIZATION_CODE>' \
     --data-urlencode 'app_id=<APP_ID>' \
     --data-urlencode 'grant_type=authorization_code' \
     --data-urlencode 'code_verifier=<CODE_VERIFIER>'
   ```
   Response:
   ```json
   {
     "access_token": "...",
     "refresh_token": "...",
     "expires_in": "90000"
   }
   ```
4. Lưu cả 3 giá trị vào hệ thống:
   - `access_token` → ô **Zalo OA Access Token**
   - `refresh_token` → ô **Refresh Token**
   - `app_id` → ô **App ID**
   - `secret_key` → ô **Secret Key**

   Khi đó hệ thống **tự làm mới token mỗi ngày lúc 03:00** và cũng tự refresh
   ngay khi gặp lỗi `-216` (token hết hạn).

> ℹ️ **Refresh token sống 3 tháng và chỉ dùng được 1 lần** — sau khi refresh,
> hệ thống tự lưu refresh token mới. Sau 3 tháng cần lấy authorization code mới.

---

## 4. Chuẩn bị người nhận

Zalo chỉ cho phép gửi tin nhắn tới người dùng **đã có tương tác** với OA.

Việc cần làm của người nhận (chủ xe):
1. Mở Zalo → tìm **OA của doanh nghiệp** (theo tên OA đã đăng ký) → **Quan tâm**.
2. **Nhắn 1 tin bất kỳ** cho OA (ví dụ: `báo cáo`).

Sau đó người này sẽ xuất hiện trong danh sách người dùng của OA.

---

## 5. Cấu hình trong Beer POS

Vào **Dashboard → Cài đặt hệ thống → 📨 Báo cáo tự động**
(hoặc mở trực tiếp `/report-notify`).

1. **Kênh**: chọn **Zalo OA**
2. **Zalo OA Access Token**: dán access token
3. Bấm **📋 Lấy danh sách** → hệ thống gọi `GET /v3.0/oa/user/getlist` →
   hiện danh sách user đã tương tác → bấm **Chọn** ở đúng người nhận →
   `user_id` được điền tự động.
   - Nếu API lỗi (thiếu quyền "Quản lý thông tin người dùng"), copy `user_id`
     thủ công từ Zalo OA admin hoặc từ log webhook.
4. *(Nâng cao)* Mở mục **🔑 Nâng cao — OAuth v4** → nhập App ID / Secret Key /
   Refresh Token nếu dùng Cách B.
5. **Giờ gửi**: ví dụ `21:30` (giờ Việt Nam)
6. Bật công tắc **Bật gửi tự động**
7. Bấm **💾 Lưu cấu hình**

---

## 6. Kiểm tra

| Nút | Chức năng | Kết quả mong đợi |
|---|---|---|
| **👁 Xem thử** | Dựng nội dung báo cáo, **không gửi** | Xem trước text báo cáo (doanh thu, lợi nhuận, keg, công nợ…) |
| **📤 Gửi ngay** | Gửi thật qua Zalo OA | Tin nhắn về Zalo của người nhận trong vài giây |
| Lịch sử (bảng dưới) | Log các lần gửi | `status = sent`, `response_code = 0` |

Sau khi **📤 Gửi ngay** thành công, đợi tới giờ đã cấu hình (ví dụ 21:30) để hệ thống
tự gửi. Có thể chạy thử ngay bằng:

```bash
# Trên server production
cd /var/www/beer-pos
node -e "
const db=require('./database');
const S=require('./src/services/ReportNotifyService');
S.dispatchDailyReport({date:require('./src/services/DailyReportService').todayVN(),channel:'zalo',force:true})
 .then(r=>{console.log(JSON.stringify(r.ok?'OK':'FAIL: '+r.error));process.exit(0);});
"
```

---

## 7. Xử lý sự cố

| Lỗi hiển thị | Nguyên nhân | Cách khắc phục |
|---|---|---|
| `Chưa cấu hình Zalo OA Access Token` | Chưa nhập token | Nhập token rồi **Lưu cấu hình** |
| `Chưa cấu hình user_id người nhận Zalo` | Chưa chọn user_id | Bấm **📋 Lấy danh sách** hoặc dán thủ công |
| `-216 Access token is invalid` | Token sai hoặc hết hạn (>25h) | Nhập token mới, hoặc dùng OAuth v4 để auto-refresh |
| `-201 User is not following OA` / không tìm thấy user | Người nhận chưa tương tác với OA | Bảo người nhận **Quan tâm + nhắn 1 tin** cho OA |
| `-240 api v2 shutdown` | Đang dùng endpoint v2.0 | Đã sửa sang `v3.0` trong code (bản mới) |
| `Forbidden - permission` khi lấy danh sách | App chưa bật quyền "Quản lý thông tin người dùng" | Bật quyền trong `developers.zalo.me` → App → cấp quyền, hoặc dán `user_id` thủ công |
| Tin nhắn tới nhưng rỗng/không đủ | Báo cáo > 2000 ký tự | Code đã tự cắt còn 2000 ký tự (giới hạn Zalo) |
| Không tự gửi đúng giờ | Cron chưa chạy / sai múi giờ | Cron dùng `timezone: Asia/Ho_Chi_Minh`, chạy mỗi phút. Kiểm tra `pm2 logs` |
| `{"error":404,...empty api}` khi bấm Kết nối | Endpoint authorize sai | Đã sửa: dùng `/v4/oa/permission` (KHÔNG phải `/v4/oa/auth`) |
| `Phiên cấp quyền không hợp lệ (state mismatch)` | `state` không khớp (có thể do mở nhiều tab, hoặc code đã dùng) | Bấm lại **🔗 Kết nối Zalo OA** để tạo phiên mới, chỉ mở 1 tab |
| `Invalid code / code expired` | Authorization code đã dùng hoặc quá 10 phút | Bấm lại nút Kết nối để lấy code mới |
| `redirect_uri does not match` | Callback URL trong Zalo App lệch với URL hệ thống dùng | Sửa Callback URL trong Zalo App thành `https://admin.biatuoitayninh.store/api/report-notify/zalo/callback` (khớp chính xác, kể cả dấu `/` cuối) |
| `-242 Invalid appsecret_proof` | App bật chế độ bắt buộc proof nhưng thiếu header | Hệ thống đã tự gửi `X-Appsecret-Proof`; kiểm tra `zalo_oa_secret_key` đã lưu đúng |

### Kiểm tra cron có chạy không

```bash
pm2 logs beer-pos --lines 50 | grep -i "REPORT_NOTIFY\|ZALO"
```

Log kỳ vọng:
```
[REPORT_NOTIFY] Scheduled daily report { date: '2026-11-13', channel: 'zalo' }
[REPORT_NOTIFY] Sent daily report { channel: 'zalo', revenue: 12345678 }
```

---

## 8. Ghi chú kỹ thuật

### Endpoint Zalo OA đang dùng

| Mục đích | Endpoint |
|---|---|
| Gửi tin CS (báo cáo) | `POST https://openapi.zalo.me/v3.0/oa/message/cs` |
| Lấy danh sách user | `GET  https://openapi.zalo.me/v3.0/oa/user/getlist?data={...}` |
| Chi tiết user | `GET  https://openapi.zalo.me/v3.0/oa/user/detail?data={...}` |
| Cấp quyền (authorize) | `GET  https://oauth.zaloapp.com/v4/oa/permission?app_id=&redirect_uri=&code_challenge=&state=` |
| Lấy / refresh token | `POST https://oauth.zaloapp.com/v4/oa/access_token` |

Body gửi tin (v3.0 — **khác v2.0**):
```json
{
  "recipient": { "user_id": "4572947693969771653" },
  "message": { "text": "nội dung báo cáo" }
}
```

> ⚠️ API `v2.0` đã bị Zalo **shutdown** (lỗi `-240`). Phiên bản hiện tại là `v3.0`.

### Cron

| Job | Lịch | Múi giờ | Mục đích |
|---|---|---|---|
| Gửi báo cáo | `* * * * *` (mỗi phút, so khớp giờ) | Asia/Ho_Chi_Minh | Đọc `report_notify_time` rồi gửi |
| Refresh token Zalo | `15 3 * * *` | Asia/Ho_Chi_Minh | Làm mới OA access token (hết hạn 25h) |

### Chống gửi trùng

`ReportNotifyService.hasSent()` tra bảng `report_notifications` — nếu đã có bản ghi
`status = 'sent'` cho ngày + kênh đó thì lần gửi tự động tiếp theo bị bỏ qua.
Gửi thủ công (**📤 Gửi ngay**) luôn bỏ qua cơ chế này.

### Setting trong DB (bảng `settings`)

| Key | Ý nghĩa |
|---|---|
| `report_notify_enabled` | `1` = bật tự động |
| `report_notify_channel` | `zalo` / `telegram` / `webhook` |
| `report_notify_time` | Giờ gửi `HH:mm` (giờ VN) |
| `zalo_oa_access_token` | Access token hiện tại |
| `zalo_oa_refresh_token` | Refresh token (OAuth v4) |
| `zalo_oa_app_id` | App ID |
| `zalo_oa_secret_key` | Secret key |
| `zalo_oa_code_verifier` | PKCE verifier tạm (tự sinh, tự xoá sau khi đổi code) |
| `zalo_report_user_id` | `user_id` người nhận báo cáo |

Tất cả secret được lưu trong SQLite, **không** nằm trong code/git.
API `/api/report-notify/config` **không trả về** token/secret ra ngoài — chỉ trả
trạng thái đã cấu hình hay chưa.
