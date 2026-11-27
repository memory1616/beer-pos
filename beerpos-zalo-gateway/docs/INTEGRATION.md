# INTEGRATION - BeerPOS Zalo Gateway

> Giai đoạn 2. Hướng dẫn tích hợp BeerPOS <-> Gateway.

## 1. Nguyên tắc

Chỉ thay đổi nơi gửi thông báo. Không thay đổi nơi phát sinh thông báo.

| Không đổi | Vai trò |
|---|---|
| `DebtPaymentService` | Ghi nhận thanh toán |
| `DebtSepayService` | Ghi nhận giao dịch SePay |
| `DebtCommandService` | Parser lệnh `+` / `-` |
| `DebtLedgerService` | Sổ công nợ |
| `DebtManualService` | Ghi nợ / điều chỉnh / đảo giao dịch |
| `DebtNotifyService` | Dựng nội dung thông báo |
| `OmiCallService` | Provider OmniCall hiện tại |

## 2. Chế độ gửi

| Chế độ | `debt_notify_provider` | Mô tả |
|---|---|---|
| Mặc định | `omicall` | Hành vi hiện tại. Không đổi. |
| Gateway | `gateway` | Gửi qua Gateway HTTP. |
| Tắt | `disabled` | Không gửi. |

Chuyển đổi bằng 1 giá trị trong bảng `settings`. Không sửa code. Rollback = đổi ngược lại.

Chỉ một nguồn gửi hoạt động cho cùng một sự kiện. Không bao giờ bật cả hai.

## 3. Luồng tích hợp

```
DebtPaymentService.recordPayment()
  -> DebtLedgerService.recordTransaction({ buildNotification })
       -> db.transaction() ghi bút toán + debt_notification_jobs
  -> (worker) NotificationWorker.leaseJobs()
       -> GatewayAdapter.sendMessage()
            -> GatewayClient POST /api/messages/send
                 Idempotency-Key: payment-notification:<txId>
       -> ProviderResult -> markSent / markFailed
```

BeerPOS không truyền `groupId`. Gateway tự tra mapping.

## 4. File mới trong BeerPOS

| File | Trách nhiệm |
|---|---|
| `src/services/notify/GatewayClient.js` | HTTP client: timeout, retry, error mapping. |
| `src/services/notify/provider/GatewayAdapter.js` | Provider adapter -> `ProviderResult`. |

## 5. File sửa nhỏ trong BeerPOS

| File | Thay đổi | Rủi ro |
|---|---|---|
| `src/services/notify/provider/index.js` | thêm nhánh `case 'gateway'` | Rất thấp |
| `routes/api/debtLedger.js` | (tùy chọn) endpoint tra cứu job | Rất thấp |

## 6. Mapping kênh trạng thái

BeerPOS `ProviderResult` <- Gateway HTTP status:

| Gateway HTTP | ProviderResult | `retryable` |
|---|---|---|
| 202 / 200 | `success: true` | - |
| 400 | `success: false`, `VALIDATION_ERROR` | `false` |
| 404 | `success: false`, `CUSTOMER_GROUP_NOT_LINKED` | `false` |
| 409 | `success: false`, `DUPLICATE_*` | `false` |
| 401 / 403 | `success: false`, `UNAUTHORIZED` | `false` |
| lỗi mạng / timeout | `success: false`, `GATEWAY_UNREACHABLE` | `true` |
| 429 | `success: false`, `RATE_LIMITED` | `true` |
| 5xx | `success: false`, `GATEWAY_ERROR` | `true` |

## 7. Chế độ Gateway offline

| Tình huống | Hành vi |
|---|---|
| Gateway process dừng | Worker không gọi được -> `ProviderResult.retryable = true` -> job `debt_notification_jobs` retry theo backoff hiện tại (1/5/15/60/180 phút). Giao dịch thanh toán đã commit không bị ảnh hưởng. |
| Gateway dừng giữa chừng | Job nằm trong `retry` -> recovery khởi động lại worker -> giữ nguyên backoff. |
| Gateway trở lại | Job retry -> gửi -> `sent`. Không có tin trùng vì `idempotency_key` giữ nguyên. |

Không bao giờ dùng `PaymentService` để đổi `debt_notify_provider`. Các giá trị khác của `settings` không bị sửa đổi.

## 8. Idempotency key

| Hệ thống | Format |
|---|---|
| BeerPOS | `payment-notification:<transactionId>` |
| Gateway | Nhận nguyên `Idempotency-Key` header |

Cùng format để chuyển đổi không gây tin trùng.

BeerPOS hiện tại dùng `eventType:tx:<txId>:grp:<groupId>`. Khi tích hợp Gateway, dùng format `payment-notification:<txId>` cho cả hai hệ thống để khớp. Thay đổi này chỉ nằm trong `GatewayAdapter` và không ảnh hưởng queue nội bộ.

## 9. Các bước chuyển đổi an toàn

| Bước | Hành động | Kiểm tra |
|---|---|---|
| 1 | Deploy Gateway local, chạy `npm run migrate` + `npm run seed` | `GET /health` trả `ok` |
| 2 | Nhập mapping CSV từ `debt_customer_groups` sang Gateway | `GET /api/groups` khớp |
| 3 | Bật MockProvider, kiểm tra job chạy | `GET /api/messages/history` có `sent` |
| 4 | Chuyển provider sang `gateway` trên **1 khách hàng thử nghiệm** | Job trong Gateway đúng khách |
| 5 | Bải triển, kiểm tra job thất bại | `debt_notification_jobs` không còn job `failed` |
| 6 | Chuyển `gateway` toàn bộ | Dashboard Gateway: không job `failed` |
| 7 | Giữ `omicall` để đổi ngược lại | `debt_notify_provider = 'omicall'` |

Bước 7: không xoá code OmniCall. Chỉ đổi giá trị setting.

## 10. Kiểm thử tích hợp

| Kịch bản | Mong đợi |
|---|---|
| Thanh toán thành công, Gateway online | Job `sent` trong Gateway + `debt_notification_jobs` không còn job lỗi |
| Gateway offline | Giao dịch vẫn commit. Job BeerPOS ở `retry`. Không rollback. |
| Gateway trả lỗi | Job BeerPOS `failed` không retry. Không vòng lặp vô hạn. |
| Retry cùng idempotency key | Chỉ 1 job trong Gateway. Không tin trùng. |
| Payment được xử lý lại | Không tạo notification trùng. |
| Khách chưa có group | Gateway trả 404. Job BeerPOS `failed`. Không crash. |
| Worker restart giữa job | Job treo -> `recoverStaleJobs()` -> `queued` -> xử lý lại. |
| Hai worker chạy song song | Lease đảm bảo không lấy trùng job. |
| Provider timeout | Job `unknown`. Không tự retry. Không tin trùng. |

## 11. Rollback

| Mức độ | Hành động |
|---|---|
| 1 giá trị | `UPDATE settings SET value='omicall' WHERE key='debt_notify_provider'` |
| Tắt Gateway | `= 'disabled'` |
| Xoá code | Không cần. Không xoá `OmiCallService`, `DebtNotifyService`. |

Không có migration nào xoá dữ liệu trong BeerPOS. `gateway.sqlite` tách biệt -> xoá file là đủ.
