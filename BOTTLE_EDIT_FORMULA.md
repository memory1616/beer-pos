# Công Thức Giao/Thu Vỏ (Bottle Edit)

## Nguyên Tắc

Khi chỉnh sửa hóa đơn (sửa số vỏ giao/thu):
- **Tồn trước** = số vỏ khách có **TRƯỚC KHI** đơn này được tạo
- **Tồn sau** = số vỏ khách có **SAU KHI** đơn này được tạo

## Công Thức Tính Tồn Trước

```javascript
// Từ hóa đơn (sale):
// - deliver_kegs: số vỏ giao trong đơn
// - return_kegs: số vỏ thu về trong đơn
// - keg_balance_after: tồn kho khách SAU khi đơn tạo
// - customer_keg_balance: tồn kho khách HIỆN TẠI

// Cách 1: Ưu tiên dùng keg_balance_after (từ hóa đơn)
bottleBefore = keg_balance_after - deliver_kegs + return_kegs;

// Cách 2: Fallback dùng customer_keg_balance (nếu keg_balance_after = null)
bottleBefore = customer_keg_balance - deliver_kegs + return_kegs;
```

## Công Thức Tính Tồn Sau

```javascript
// Khi user edit số vỏ giao/thu:
bottleAfter = bottleBefore + newDeliver - newReturn;
```

## Ví Dụ

### Hóa đơn A 3 Giới (Sale 194):
```
customer_keg_balance: 208   // tồn kho hiện tại của khách
deliver_kegs: 50            // giao 50 vỏ
return_kegs: 0              // thu 0 vỏ

Tồn trước = 208 - 50 + 0 = 158
Tồn sau   = 158 + 50 - 0 = 208 ✓ (đúng với hóa đơn)
```

### Khi Edit (giao thêm 10 vỏ):
```
newDeliver: 60
newReturn: 0

Tồn trước = 158 (không đổi)
Tồn sau   = 158 + 60 - 0 = 218
```

## Lưu Ý Quan Trọng

1. **Tồn trước** luôn tính từ dữ liệu hóa đơn, KHÔNG phải tồn kho hiện tại của khách
2. **Tồn sau** chỉ mang tính tham khảo - khi submit, server sẽ tính lại chính xác
3. Khi gọi modal sửa vỏ, luôn truyền full sale object chứa `keg_balance_after` và `customer_keg_balance`

## Hàm Liên Quan

```javascript
// Mở modal sửa vỏ cho một đơn
openKegModalForSale(saleId, customerId, invoiceData);

// Trong invoiceData cần có:
// - deliver_kegs
// - return_kegs
// - keg_balance_after (ưu tiên)
// - customer_keg_balance (fallback)
```
