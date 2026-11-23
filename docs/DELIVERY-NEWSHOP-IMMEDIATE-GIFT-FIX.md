# Fix KM Quán Mới — Không tặng ngay trong đơn (2026-11-23)

## Vấn đề

Hai triệu chứng do **cùng một nguyên nhân gốc**: hệ thống có **hai luồng tặng quán mới chạy song song**.

### 1. Badge POS hiển thị quy tắc cũ

`div#newShopBadge` hiện: `🔥 Quán mới — tháng mở quán | Mua 10L vàng tặng 1L | Mua 20L đen tặng 1L`

- Text **hardcode** trong `public/js/sales.js`.
- Quy tắc cũ đã bỏ từ 2026-11-22: quán mới **chỉ tặng bia vàng**, tỉ lệ áp dụng cho **TỔNG** sản lượng (vàng + đen cộng lại).
- Tỉ lệ phải đọc **động** từ `promotion_settings`.

### 2. Đơn 1145 trả thưởng ngay

Nguyên tắc đúng: thưởng "N tặng M" của tháng mở quán **giống hệt thưởng doanh số** → tính theo tổng sản lượng tháng mở quán, rồi trả vào **đơn hàng đầu tiên của tháng kế tiếp**.

Nhưng thực tế có 2 luồng:

| Luồng | Vị trí | Hành vi |
|---|---|---|
| **Cũ (sai)** | `routes/api/sales.js` POST + PUT → `calculateNewShopPromotion()` | Tặng lít **NGAY** trong đơn: thêm `sale_items` price=0, cộng `deliver_kegs`, trừ kho, `promo_type='NEW_SHOP'` |
| **Đúng** | `routes/api/sales.js` POST → block "TỰ ĐỘNG GẮN THƯỞNG", nhánh `program === 'NEW_CUSTOMER'` | Tính tổng tháng → `attachRewardToSale(..., 'NEW_SHOP_BONUS')` vào đơn đầu tiên tháng sau |

Kết quả: khách mở quán tháng 6/2026 nhận lít tặng **2 lần** cho cùng 1 tháng — và bị tặng **ngay** thay vì chờ đầu tháng sau.

## Nguyên tắc chuẩn (áp dụng từ 2026-11-22)

| Mục | Quy tắc |
|---|---|
| "Quán mới" là ai? | Khách có `created_at` **trong tháng hiện tại** (tháng mở quán) |
| Tặng loại gì? | **CHỈ bia vàng** — không tặng bia đen |
| Tỉ lệ tính trên? | **TỔNG** sản lượng tháng (vàng + đen cộng lại) |
| Tỉ lệ lấy ở đâu? | `promotion_settings.new_shop_gold_buy` / `new_shop_gold_free` (động) |
| Khi nào trả? | **Đơn hàng đầu tiên của tháng kế tiếp** (`promo_type = 'NEW_SHOP_BONUS'`) |
| Đơn trong tháng mở quán | Chỉ mang **nhãn** `promo_type = 'NEW_SHOP'`, **không** kèm lít tặng, `promo_free_liters = 0` |

## Thay đổi code

### `routes/api/sales.js`
- **POST `/`**: bỏ gọi `calculateNewShopPromotion()`. `promoInfo` chỉ còn `{ freeGold: 0, freeBlack: 0, totalFree: 0, promoType: 'NEW_SHOP' }` (nhãn).
- **Xoá block "XỬ LÝ KHUYẾN MÃI QUÁN MỚI: Tặng bia cùng loại"** — block này từng trừ kho + insert `sale_items` price=0 ngay trong đơn (chính là nguồn gây tặng trùng). Thay bằng comment giải thích luồng đúng.
- **PUT `/:id`**: giữ nguyên việc chỉ đặt nhãn `NEW_SHOP`, không tặng lít / không trừ kho.

### `src/services/index.js`
- `calculateNewShopPromotion()`: đánh dấu **LEGACY — chỉ dùng để xem trước**, ghi rõ không được dùng để cộng lít tặng vào đơn.
- `calculateNewShopMonthlyReward()`: giữ nguyên logic mới (chỉ tặng vàng, tỉ lệ theo tổng vàng+đen).

### `public/js/sales.js`
- `showNewShopBadge()`: đọc `saleState.promoSettings.newShopGoldBuy` / `newShopGoldFree` (fallback 10/1), hiển thị "Mua XL (vàng + đen) tặng YL bia vàng" + "⏳ Thưởng trả vào đơn đầu tiên của tháng sau".
- `showNewShopActiveNotice()`, `renderPromoPreview()`, `buildPromoDetailHtml()`: nói rõ thưởng tích lũy trong tháng mở quán và trả ở đơn đầu tiên tháng sau.

### `views/customer-detail.html`
- Bỏ chuỗi `"Mua XL vàng + YL | Mua XL đen + YL"` → `"Mua XL (vàng + đen) tặng YL bia vàng — thưởng trả vào đơn đầu tiên của tháng sau"`.

### `routes/api/driver.js`
- `newShopSettings`: `blackBuy`/`blackFree` trả về theo quy tắc mới (`blackFree = 0`) thay vì `settings.newShopBlackBuy`/`newShopBlackFree` cũ.

## Sửa dữ liệu

Script: `scripts/ops/backfill-newshop-immediate-gift.js`

```bash
node scripts/ops/backfill-newshop-immediate-gift.js --dry-run   # xem trước
node scripts/ops/backfill-newshop-immediate-gift.js             # ghi DB
```

Với mỗi đơn `promo_type='NEW_SHOP'` có lít tặng:
1. Hoàn kho (`products.stock += giftLiters`)
2. Xoá `sale_items` lít tặng (`price = 0`)
3. Trừ `sales.deliver_kegs`
4. Trừ `customers.keg_balance`
5. `promo_free_liters = 0`, `reward_liters_used = 0`
6. Tính lại `sales.profit`
7. Đồng bộ `keg_stats`

**KHÔNG** đụng phần mua thật (`price > 0`) → sản lượng tháng và `customer_monthly_stats` không đổi.

Kết quả trên DB dev: **12 đơn / 88 lít tặng** đã gỡ (đơn 360, 388, 396, 399, 440, 442, 452, 466, 480, 488, 501, 504). Đơn 393 không có lít tặng → bỏ qua.

Verify: `node scripts/ops/verify-newshop-fix.js`

## Test

- `tests/newshop_no_immediate_gift.test.js` (mới, 16 test) — bảo vệ luồng: đơn tháng mở quán không tặng ngay, auto-reward gắn `NEW_SHOP_BONUS`, badge đọc tỉ lệ động, driver API không trả quy tắc đen cũ.
- `tests/newshop_monthly_reward.test.js`, `tests/newshop_bonus_source.test.js` — không đổi.
- Full suite: **60 suite / 1269 test PASS**.

## Deploy

```bash
# 1. Backup DB
cp database.sqlite backup/backup-pre-newshop-fix-$(date +%Y-%m-%dT%H-%M-%S).db

# 2. Sửa dữ liệu (nếu DB production còn đơn bị ảnh hưởng)
node scripts/ops/backfill-newshop-immediate-gift.js --dry-run
node scripts/ops/backfill-newshop-immediate-gift.js

# 3. Verify
node scripts/ops/verify-newshop-fix.js
```
