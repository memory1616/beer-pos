# Báo cáo rà soát logic MONTHLY_BONUS

**Dự án:** `D:\Beer` (BeerPOS Pro v2)
**Ngày rà soát:** 01/08/2026
**Phạm vi:** Toàn bộ logic trả thưởng sản lượng (`MONTHLY_BONUS`), tạo/xóa đơn, backfill `pending_rewards`, timezone, edge case.

---

## 1. Tổng quan – Luồng trả thưởng

### 1.1. Đường đi của một khách đạt tier

```
[Khách mua hàng trong tháng T-1]
          │
          ▼
┌─────────────────────────────────────────────────────────┐
│ PromotionService.calculateMonthlyPurchasedLiters()     │
│   - sales.type='sale', archived=0, si.price>0, p.type=keg│
│   - KHÔNG loại MONTHLY_BONUS (chỉ loại si.price=0)     │
└─────────────────────────────────────────────────────────┘
          │ đạt tier?
          ▼
┌─────────────────────────────────────────────────────────┐
│ PromotionService.getRewardForPrevMonth(customerId)      │
│   1. determinePromotionProgram(T-1) → NEW_CUSTOMER?     │
│        ├── YES  → return {eligible:false}               │
│        └── NO   → tiếp                                  │
│   2. Đọc pending_rewards (ưu tiên)                       │
│   3. Tính lại liters T-1 bằng SQL real-time               │
│   4. savePendingReward() nếu chưa claim & chưa có pending│
│   5. Check reward_history để chống double-claim          │
└─────────────────────────────────────────────────────────┘
          │ eligible
          ▼
[Khách tạo đơn đầu tiên trong tháng T]
          │
          ▼
routes/api/sales.js: router.post('/')
   - determinePromotionProgram(T-1) → MONTHLY_VOLUME?
   - check reward_history (note LIKE '%tháng X/Y%')
   - Gọi PromotionService.attachRewardToSale()
          │
          ▼
┌─────────────────────────────────────────────────────────┐
│ _doAttachReward() / addPendingRewardToSale()           │
│ 1. Thêm sale_items (price=0) + trừ kho                  │
│ 2. UPDATE sales: promo_type='MONTHLY_BONUS',            │
│                  reward_liters_used,                    │
│                  note += 'Trả thưởng ... tháng X/Y'     │
│ 3. UPDATE customers.keg_balance += reward_liters        │
│ 4. INSERT reward_history                                │
│ 5. UPDATE/INSERT customer_monthly_stats                 │
│    (reward_claimed=1, reward_claimed_liters,            │
│     reward_claimed_sale_id)                             │
│ 6. DELETE pending_rewards WHERE customer_id             │
└─────────────────────────────────────────────────────────┘
```

### 1.2. Hai bản `PromotionService` đang tồn tại

| File | Kích thước | Trạng thái thực tế |
|---|---|---|
| `src/services/index.js` | 1905 dòng | **CANONICAL** – mọi route (`routes/api/sales.js`, `routes/api/promotions.js`, `routes/api/batch.js`) đều `require('../../src/services')` |
| `index.js` (root) | 1885 dòng | **MIRROR / DEAD CODE** – không file nào require file này; vẫn khai báo `PromotionService` riêng; thậm chí đường dẫn `require('../../database')` không resolve đúng khi chạy từ root |

**Khuyến nghị:** Xoá file `D:\Beer\index.js` (root) để tránh nhầm lẫn khi bảo trì, hoặc refactor nó thành `app.js` không chứa service.

---

## 2. Bảng tất cả chỗ filter MONTHLY_BONUS

### 2.1. ✅ ĐÚNG – filter theo `promo_type='MONTHLY_BONUS'` để detect NEW_CUSTOMER

| File | Dòng | SQL / Mục đích | Ghi chú |
|---|---|---|---|
| `src/services/index.js` | 360-363 | `WHERE promo_type='MONTHLY_BONUS'` (đếm trong `getMonthPromotionStatus`) | Đếm đơn MONTHLY_BONUS đã phát hành → NEW_CUSTOMER. Đúng. |
| `src/services/index.js` | 1488-1491 | `auditPromotionConflicts` đếm MONTHLY_BONUS theo khách/tháng | Đúng. |
| `routes/reportData.js` | 240-246 | Lấy `claimedSales` (đơn đã trả thưởng) theo `promo_type='MONTHLY_BONUS'` + `note LIKE '%tháng X/%Y%'` | Đúng cho báo cáo thưởng. |
| `routes/reportData.js` | 417-423 | Tổng `paidReward` (đã trả) dùng `promo_type='MONTHLY_BONUS'` | Đúng. |
| `routes/reportData.js` | 434 | `promo_type != 'MONTHLY_BONUS'` cho `buy10Given` | Đúng (NEW_SHOP và mua 10 tặng 1 không phải MONTHLY_BONUS). |

### 2.2. ✅ ĐÚNG – không filter MONTHLY_BONUS khi tính liters (đúng rule 3)

| File | Dòng | SQL | Ghi chú |
|---|---|---|---|
| `src/services/index.js` | 313-326 | `determinePromotionProgram` đọc liters KHÔNG lọc `promo_type` | Đúng. |
| `src/services/index.js` | 393-410 | `_getMonthlyLiters` – KHÔNG lọc MONTHLY_BONUS, chỉ lọc `si.price>0` | Đúng. |
| `src/services/index.js` | 581-594 | `calculateMonthlyPurchasedLiters` – KHÔNG lọc MONTHLY_BONUS | Đúng. |
| `src/services/index.js` | 902-916 | `autoClaimMonthlyReward` – KHÔNG lọc MONTHLY_BONUS khi đếm liters T-1 | Đúng. |
| `src/services/index.js` | 1206-1218 | `getRewardForPrevMonth` (ưu tiên 2) – KHÔNG lọc MONTHLY_BONUS | Đúng. |
| `routes/api/sales.js` | 1555-1618 | `sync-volume` – KHÔNG lọc MONTHLY_BONUS khi rebuild `customer_monthly_stats` | Đúng (comment yêu cầu "KHÔNG loại cả đơn MONTHLY_BONUS"). |
| `routes/api/promotions.js` | 850-866 | `auto-generate` – KHÔNG lọc MONTHLY_BONUS khi tính liters | Đúng. |
| `routes/dashboard.js` | 75-91 | Dashboard today/month stats – KHÔNG lọc MONTHLY_BONUS | Đúng (revenue có cả phần tiền). |

### 2.3. ✅ ĐÚNG – filter `promo_type !== 'MONTHLY_BONUS'` để trừ `purchased_liters` khi xoá đơn

| File | Dòng | Mục đích | Ghi chú |
|---|---|---|---|
| `src/services/saleDelete.js` | 80 | `if (sale.promo_type !== 'MONTHLY_BONUS')` → revert `purchased_liters` trong `customer_monthly_stats` | Đúng vì đơn MONTHLY_BONUS không được tính riêng vào liters. |

### 2.4. ❌ SAI / NGHI VẤN – filter MONTHLY_BONUS sai chỗ

| File | Dòng | Vấn đề | Mức độ |
|---|---|---|---|
| `src/services/index.js` | **292-307 (`determinePromotionProgram`)** | Logic hiện tại (canonical): `isCreationMonth = (createdYear==year && createdMonth==month)` → trả `NEW_CUSTOMER` luôn **bất kể ngày tạo**. Nhưng `getPromotionEligibility` (line 422-476) lại theo quy tắc "ngày 01-08 vẫn được thưởng tháng tạo, ngày 09+ mới NEW_CUSTOMER". Hai hàm cùng hệ thống nhưng trả lời khác nhau cho cùng input → auto-claim ở `routes/api/sales.js:466` dùng `determinePromotionProgram` có thể loại sai khách tạo ngày 01-08. | **Cao** |
| `index.js` (root) | **293-296 (`determinePromotionProgram`)** | Bản mirror lại có quy tắc "ngày tạo 01-08 thì tham gia thưởng doanh số từ tháng tạo, ngày 09+ thì NEW_CUSTOMER" – **khác với canonical**. Hai phiên bản cùng tồn tại với quy tắc NEW_CUSTOMER đối nghịch. | Trung bình (vì file root không được require) |
| `routes/api/promotions.js` | **889** (`auto-generate`) | `if (createdDay >= 9)` – theo quy tắc cũ "ngày 09+ mới NEW_CUSTOMER". Nhưng `determinePromotionProgram` (canonical) lại trả `NEW_CUSTOMER` cho mọi ngày. Hai entry point cùng đánh giá `NEW_CUSTOMER` nhưng kết luận khác nhau. | **Cao** |
| `routes/api/promotions.js` | **895-903** (`auto-generate`) | Bỏ qua khách có đơn `NEW_SHOP` trong tháng → NEW_CUSTOMER. Logic này đúng nhưng lại **không** kiểm tra `MONTHLY_BONUS` trong tháng → có thể tạo `pending_rewards` trùng với đơn đã trả thưởng. | Trung bình |
| `routes/reportData.js` | **258-267** | Loại trừ khách `NEW_SHOP` để tính `needToPay`, nhưng **không** loại khách đã nhận MONTHLY_BONUS (đếm `claimedSales` riêng). Logic vẫn đúng vì `needToPay` chỉ tính theo `purchased_liters`, nhưng nếu khách đã nhận một phần (multi-tier), giá trị `needToPay` có thể bị double-count. | Trung bình |
| `routes/reportData.js` | **434** | `promo_type != 'MONTHLY_BONUS'` để tính `buy10Given` – tên báo cáo là "Khuyến mãi 10 tặng 1" nhưng filter lại loại MONTHLY_BONUS (một loại KM khác). Cần xác nhận: `promo_free_liters` của MONTHLY_BONUS có chủ đích không tính vào "10 tặng 1"? Nếu đúng → comment cần làm rõ. | Thấp |

### 2.5. ❓ NGHI VẤN – dùng cho báo cáo / dashboard

| File | Dòng | Vấn đề | Mức độ |
|---|---|---|---|
| `routes/dashboard.js` | 318-356 (`promoStats`) | Đếm "active new shops" bằng `created_day >= 9` – quy tắc cũ. `promoCost` ước lượng bằng `freeLiters * avgPrice`. Không liên quan trực tiếp MONTHLY_BONUS nhưng cho thấy hệ thống có nhiều nơi dùng quy tắc "ngày 09+" cũ. | Thấp |
| `routes/dashboard.js` | 75-91 | Hôm nay/tháng này tính revenue + units, KHÔNG tách riêng MONTHLY_BONUS. Nếu muốn báo cáo "doanh thu thực vs thưởng", cần thêm breakdown. | Thấp (chưa rõ yêu cầu) |

---

## 3. Bảng so sánh logic `index.js` (root) vs `src/services/index.js`

> **Lưu ý quan trọng:** Bản `src/services/index.js` là **canonical** (mọi route đều require bản này). Bản `index.js` (root) **không** được require từ bất kỳ đâu → có thể coi là **dead code mirror**, nhưng nội dung khác biệt có thể gây nhầm lẫn khi maintainer đọc nhầm.

| Hàm | `index.js` (root) | `src/services/index.js` (canonical) | Lệch? | Ghi chú |
|---|---|---|---|---|
| `determinePromotionProgram` | line 281-321: Trả `NEW_CUSTOMER` chỉ khi `isCreationMonth && createdDay >= 9`. Không check `hasNewShopSale`. | line 281-333: Trả `NEW_CUSTOMER` khi `isCreationMonth` (mọi ngày) HOẶC `hasNewShopSale.cnt > 0`. | **CÓ – lệch** | Hai quy tắc đối nghịch: bản root dùng logic ngày 09+; bản canonical dùng "tháng tạo = NEW_CUSTOMER". |
| `getMonthPromotionStatus` | line 330-366: `if (isCreationMonth \|\| hasNewShopSale)` → `NEW_CUSTOMER`. `hasMonthlyBonusSale` luôn `false`. | line 342-387: `if (isCreationMonth \|\| hasNewShopSale \|\| hasMonthlyBonusSale)` → `NEW_CUSTOMER`. | **CÓ – lệch** | Bản canonical coi đơn MONTHLY_BONUS đã phát là dấu hiệu NEW_CUSTOMER (dùng cho audit), bản root thì không. |
| `getPromotionEligibility` | line 401-455 | line 422-476 | Không | Giống nhau. |
| `getPromotionStartDate` | line 533-550 | line 512-530 | Không | Giống nhau. |
| `calculateMonthlyPurchasedLiters` | line 539-577 | line 560-597 | Không | Giống nhau (cùng comment "MONTHLY_BONUS chỉ loại si.price=0"). |
| `calculateMonthlyReward` | line 600-691 | line 621-712 | Không | Giống nhau. |
| `claimMonthlyReward` | line 773-851 | line 773-851 (cùng offset) | Không | Giống nhau. |
| `autoClaimMonthlyReward` | line 872-958 | line 872-958 (cùng offset) | Không | Giống nhau. |
| `getRewardForPrevMonth` | line 1130-1241 | line 1151-1262 | Không | Giống nhau (cùng cơ chế ưu tiên pending → tính real-time → savePending). |
| `attachRewardToSale` | line 1254-1297 | line 1275-1297 | Không | Giống nhau. |
| `addPendingRewardToSale` | line 991-1093 | line 1012-1114 | Không | Giống nhau. |
| `savePendingReward` / `getPendingReward` / `clearPendingReward` | (cùng vùng) | (cùng vùng) | Không | Giống nhau. |
| `auditPromotionConflicts` | line 1437-1553 | line 1458-1530+ | Lệch nhẹ | Cả hai đều `shouldBeNewCustomer = (createdDay >= 9)` – quy tắc cũ. |

**Kết luận:** Hai phiên bản chỉ lệch nhau ở 2 hàm phát hiện NEW_CUSTOMER (`determinePromotionProgram`, `getMonthPromotionStatus`) và audit. Bản canonical có logic "an toàn hơn" (coi tháng tạo & MONTHLY_BONUS đều là NEW_CUSTOMER), bản root theo quy tắc cũ (chỉ ngày 09+). **Tuy nhiên `routes/api/promotions.js:889` (`auto-generate`) lại dùng quy tắc cũ (ngày 09+)**, gây mâu thuẫn nội bộ với canonical.

---

## 4. Danh sách bug nghi vấn (chưa chắc chắn, cần verify)

| # | File | Dòng | Mô tả | Mức độ |
|---|---|---|---|---|
| **B1** | `src/services/index.js` (canonical) | 292-307 | `determinePromotionProgram` trả `NEW_CUSTOMER` cho **mọi ngày trong tháng tạo**, mâu thuẫn với `getPromotionEligibility` (line 444-462) cho phép khách tạo ngày 01-08 được thưởng tháng tạo. Vì `routes/api/sales.js:466` dùng `determinePromotionProgram` để quyết định auto-claim, một khách tạo ngày 05/07 và đạt 300L trong tháng 7 sẽ bị **bỏ qua auto-claim** cho tháng 7 dù theo rule 4 (quy tắc cũ) họ đủ điều kiện. | **Cao** |
| **B2** | `routes/api/promotions.js` | 889-892 | `auto-generate` dùng quy tắc `createdDay >= 9` để loại NEW_CUSTOMER – đây là quy tắc **cũ** (trước khi canonical quyết định "mọi ngày"). Nếu khách tạo ngày 01-08 và đạt tier, `auto-generate` sẽ tạo `pending_rewards` (đúng), nhưng khi đơn được tạo, `determinePromotionProgram` (canonical) sẽ trả `NEW_CUSTOMER` → **bỏ qua claim** → `pending_rewards` tồn tại mãi. | **Cao** |
| **B3** | `index.js` (root) | Toàn file | Tồn tại song song với `src/services/index.js`, định nghĩa `PromotionService` riêng nhưng **không file nào require**. Khi `index.js` chạy thử độc lập (e.g., script kiểm thử), `require('../../database')` từ root `D:\Beer\index.js` sẽ trỏ ra ngoài workspace → lỗi. Nguy cơ dev mới nhầm lẫn khi sửa. | Trung bình |
| **B4** | `routes/api/promotions.js` (`auto-generate`) | 895-903 | Khi khách đã có đơn `MONTHLY_BONUS` trong tháng, `auto-generate` vẫn **không** loại → có thể INSERT `pending_rewards` cho khách đã nhận (sẽ bị skip bởi `reward_history` check ở line 906-910). Không nguy hiểm nhưng "lãng phí" log. | Thấp |
| **B5** | `routes/api/promotions.js` | 880-882 | `updateCustomerClaim.run(cust.id)` set `customers.reward_claimed = 1` ngay khi **tạo `pending_rewards`** (chưa phát thưởng thật). Nếu sau đó khách không có đơn đầu tháng (không claim được) mà khách tạo đơn nhưng hệ thống fail giữa chừng → `reward_claimed = 1` nhưng `reward_history` không có → DB không nhất quán. **Đặc biệt nguy hiểm khi có B1/B2**: khách bị bỏ qua auto-claim nhưng đã bị set `reward_claimed=1` → cuối tháng nhìn dashboard thấy "đã nhận" trong khi thực tế chưa. | **Cao** |
| **B6** | `src/services/index.js` (`autoClaimMonthlyReward`) | 881-893 | Xác định `rewardMonth` bằng `new Date(now.getFullYear(), now.getMonth() - 1, 1)` – dùng local time của server. Server đã set `process.env.TZ = 'Asia/Ho_Chi_Minh'` (server.js:3), nên OK. Nhưng `calculateMonthlyPurchasedLiters` dùng `now.getFullYear()` (line 561) – cùng nguyên tắc local time, không nhất quán với các query SQL dùng `strftime('%Y', s.date)` (giả định ISO UTC). **Nếu server không chạy ở TZ=Asia/Ho_Chi_Minh** (e.g., local dev mà quên set), có thể lệch 1 ngày → lệch tháng. | Trung bình |
| **B7** | `src/services/index.js` | 524-548 (`getPromotionStartDate`) | Dùng `nextMonth.toISOString().split('T')[0]` cho nhánh `day > 8`. Khi `created = 2026-08-31T17:00:00Z` (UTC+7 = 00:00 ngày 1/9 theo VN), `new Date(...)` trả Date ở UTC, sau đó `setUTCMonth(month+1)` → có thể ra `2026-10-01` thay vì `2026-09-01` (Date tự cuộn khi vượt tháng). Cần verify bằng unit test cho boundary ngày 31. | Trung bình |
| **B8** | `src/services/saleDelete.js` | 80 | Chỉ revert `purchased_liters` cho đơn `type='sale'`. Nhưng `addPendingRewardToSale` (line 1065) chỉ tăng `customers.keg_balance` chứ KHÔNG cộng `purchased_liters` (vì đã là reward free). Logic này OK, nhưng khi xóa đơn có MONTHLY_BONUS, line 80 bỏ qua revert liters → đúng. Tuy nhiên: **nếu sau đó đơn được `restore` (line 1214 chỉ set `archived=0`)**, `customer_monthly_stats.purchased_liters` không được rebuild → lệch. Cần gọi lại `sync-volume` sau restore. | Trung bình |
| **B9** | `routes/api/sales.js` | 438-501 (auto-claim flow) | Đoạn "TỰ ĐỘNG GẮN THƯỞNG" tính `rewardMonth = tháng trước` bằng `new Date(now.getFullYear(), now.getMonth() - 1, 1)` (line 445) – dùng **local time của server**, không phải UTC+7. Nếu server ở TZ khác (UTC, cloud server), có thể lệch tháng. | Trung bình |
| **B10** | `routes/api/sales.js` | 1539-1641 (`sync-volume`) | Rebuild `customer_monthly_stats` bằng `DELETE ... WHERE year=? AND month=?` (line 1550-1552, 1594-1597) – **Xoá sạch stats tháng đó** rồi INSERT lại. **HUỲ DIỆT `reward_claimed`, `reward_claimed_liters`, `reward_claimed_sale_id` của tháng đó** (vì các cột này không được INSERT lại). Gọi `sync-volume` cho tháng đã trả thưởng → mất trạng thái "đã nhận" → đơn sau có thể claim lại. | **Cao** |
| **B11** | `routes/api/sales.js` | 438-501 | Auto-claim gọi `determinePromotionProgram` cho **tháng trả thưởng** (tháng trước), nhưng nếu khách đang ở tháng tạo ngày 01-08, `determinePromotionProgram` (canonical) trả `NEW_CUSTOMER` → skip. Không có cơ chế fallback "tháng này là tháng tạo + đạt tier của tháng này" → khách tạo ngày 01-08 đạt 300L tháng tạo sẽ **không bao giờ nhận thưởng tháng tạo** vì tháng trước không tồn tại. | **Cao** (liên quan B1) |
| **B12** | `src/services/index.js` (`_doAttachReward`) | line 1320-1390 (ước tính) | Hàm này dùng `db.transaction` để ghi `reward_history` + `customer_monthly_stats`. Nhưng `getRewardForPrevMonth` cũng có nhánh tự ghi `savePendingReward`. **Nếu cả hai chạy đồng thời** (e.g., backfill + auto-claim), có thể INSERT `pending_rewards` rồi ngay lập tức xoá → race condition. Cần thêm unique constraint hoặc atomic check. | Trung bình |
| **B13** | `backfill_pending_rewards.js` | 50-63 | SQL chọn khách: `JOIN customer_monthly_stats cms ON cms.year=? AND cms.month=?` – nếu một khách **không có row** trong `customer_monthly_stats` cho tháng target (do chưa từng mua), khách đó sẽ bị bỏ qua dù đủ tier. Backfill cần fallback tính trực tiếp từ `sales`. | Trung bình |
| **B14** | `backfill_pending_rewards.js` | 105-109 | `if (created.getFullYear() === TARGET_YEAR && (created.getMonth() + 1) === TARGET_MONTH)`: chỉ loại NEW_CUSTOMER khi **chính xác tháng tạo trùng tháng target** (giả định quy tắc cũ "ngày 09+ mới NEW_CUSTOMER"). Nếu canonical rule mới là "mọi ngày trong tháng tạo = NEW_CUSTOMER" thì đoạn này đúng. Nếu thay đổi quy tắc → phải sửa backfill. | Thấp |
| **B15** | `src/services/saleDelete.js` | 113-115 | `isMonthlyBonus = promo_type==='MONTHLY_BONUS' \|\| reward_liters_used>0 \|\| note.match(/Trả thưởng sản lượng tháng\s+\d+\/\d+/)`. Comment nói "sau khi archive, promo_type có thể bị reset về ''" – nhưng code thực tế ở line 238 chỉ set `archived=1`, không reset `promo_type`. Vậy comment có chính xác? Cần check git log xem trước đây có phiên bản reset `promo_type`. | Thấp |
| **B16** | `src/services/index.js` | 760-770 | `claimMonthlyReward` dùng `db.getVietnamDateStr()` cho `saleDate` (đúng UTC+7). `addPendingRewardToSale`/`_doAttachReward` KHÔNG dùng `db.getVietnamDateStr()` mà dùng `COALESCE(note, '')` (đã có sẵn từ đơn gốc). Nhưng thời gian audit log có thể lệch nếu server chạy UTC. | Thấp |
| **B17** | `src/services/index.js` | 1403-1427 (`resetMonthlyRewards`) | Chỉ INSERT missing rows cho tháng mới, **không reset** `reward_claimed` (vì các tháng cũ giữ nguyên). Logic này OK vì mỗi tháng có row riêng. Nhưng cron job để gọi hàm này **không xuất hiện trong `server.js`** (chỉ có backup + WAL checkpoint). Hàm chỉ được gọi thủ công → **nguy cơ tháng mới không có stats row** nếu quên chạy. | Trung bình |
| **B18** | `routes/reportData.js` | 240-246 | Pattern LIKE `%tháng X/%Y%` có thể **false positive**: nếu `note` chứa `"tháng 12/2025"` và ta query `%tháng 1/2026%` → có khớp (`% tháng 1/2026%` chỉ nằm trong chuỗi dài hơn). Cần escape hoặc dùng `note LIKE '%tháng ${month}/' || ${year}%'` với anchor chính xác hơn. | Trung bình |

---

## 5. Câu hỏi cần user làm rõ

| # | Câu hỏi | Ảnh hưởng |
|---|---|---|
| Q1 | **Quy tắc NEW_CUSTOMER cho khách tạo ngày 01-08 trong tháng tạo**: họ có được hưởng thưởng sản lượng tháng tạo không, hay tháng tạo luôn = NEW_CUSTOMER? Quy tắc hiện đang **mâu thuẫn** giữa `getPromotionEligibility` (cho phép ngày 01-08) và `determinePromotionProgram` (loại mọi ngày). | B1, B11 |
| Q2 | **Khách vừa có đơn NEW_SHOP vừa đạt tier tháng đó**: nếu auto-claim chạy, `determinePromotionProgram` trả `NEW_CUSTOMER` (vì `hasNewShopSale.cnt > 0`) → bỏ qua. Nhưng `auto-generate` (line 894-903) cũng bỏ qua. Hành vi này **có chủ đích** hay khách đáng lẽ được thưởng? | Logic auto-claim |
| Q3 | **Tier không đạt trong tháng T**: `getRewardForPrevMonth` không tạo `pending_rewards` (line 1232). `auto-generate` cũng không. Vậy nếu khách đạt tier muộn ngày 30 nhưng chưa kịp lưu `pending_rewards` (do `getRewardForPrevMonth` chưa được gọi cho khách đó), ai "chốt" số liệu cuối tháng? Có cron job nào không? | B17 |
| Q4 | **Khi xóa đơn MONTHLY_BONUS**, line 80 chỉ revert nếu `promo_type !== 'MONTHLY_BONUS'`. Vậy `customer_monthly_stats.purchased_liters` không bị ảnh hưởng. Nhưng nếu đơn MONTHLY_BONUS **có cả phần mua thật + phần thưởng** (line 1305-1318 thêm sale_items mới), lít mua thật có được tính vào `purchased_liters` của tháng đó hay không? | Tính nhất quán liters |
| Q5 | **Restore archived sale** (`POST /api/sales/:id/restore`) chỉ set `archived=0`, không chạy lại logic build stats. Có cần gọi lại `sync-volume` cho tháng của đơn đó không? | B8 |
| Q6 | **`sync-volume` endpoint** (routes/api/sales.js:1539) **xóa sạch stats rồi INSERT lại** không bao gồm `reward_claimed`. Endpoint này có được gọi tự động (cron) không, và có được phép chạy cho tháng đã phát thưởng không? | B10 |
| Q7 | **File `D:\Beer\index.js` (root)** có còn được dùng cho mục đích nào không (test, script)? Nếu chỉ là dead code, nên xóa. | B3 |
| Q8 | **`database.js`** – tôi không tìm thấy file này ở root `D:\Beer\database.js` và cũng không có `D:\Beer\database\index.js`. Các file `require('../database')` hoặc `require('../../database')` đang resolve đến đâu? Có phải `D:\Beer\database.js` được tạo bởi PM2 hook hoặc symlink? | Cấu trúc dự án |
| Q9 | **Pattern LIKE `%tháng ${X}/${Y}%`** để xác định "đã nhận thưởng tháng X/Y" có đang hoạt động chính xác khi `note` được build theo nhiều cách không? (`claimMonthlyReward` ghi `"Thưởng doanh số tháng ${rewardLiters}L miễn phí"` – KHÔNG có pattern `X/Y`; `addPendingRewardToSale` ghi `"Trả thưởng sản lượng tháng X/Y"` – CÓ pattern). Vậy đơn tạo bởi `claimMonthlyReward` (qua API `/api/promotions/reward/claim`) sẽ **không bao giờ** được detect "đã nhận" bởi SQL ở routes/reportData.js và `getRewardForPrevMonth`. | B18 |

---

## 6. Phụ lục – Tham chiếu nhanh

### 6.1. Bảng trạng thái `sales.promo_type`

| Giá trị | Ý nghĩa | Tạo bởi |
|---|---|---|
| `null` (không set) | Đơn bán thường | `routes/api/sales.js: router.post('/')` |
| `NEW_SHOP` | Đơn có phần quán mới (freeGold/freeBlack) | `routes/api/sales.js` (NEW_SHOP info) |
| `MONTHLY_BONUS` | Đơn có gắn thưởng sản lượng tháng | `PromotionService.addPendingRewardToSale` (line 1049), `PromotionService._doAttachReward` (line 1334), `PromotionService.claimMonthlyReward` (line 789) |

### 6.2. Ba bảng "trạng thái thưởng"

| Bảng | Vai trò | Các field quan trọng |
|---|---|---|
| `customer_monthly_stats` | Tổng kết tháng | `purchased_liters`, `reward_claimed`, `reward_claimed_liters`, `reward_claimed_sale_id` |
| `reward_history` | Lịch sử nhận | `customer_id`, `reward_tier`, `reward_liters`, `note` (chứa `"tháng X/Y"`) |
| `pending_rewards` | Chờ attach vào đơn đầu tháng | `customer_id`, `reward_month`, `reward_year`, `reward_liters`, `reward_tier`, `product_id` |

### 6.3. Các endpoint liên quan MONTHLY_BONUS

| Method | Path | File | Mục đích |
|---|---|---|---|
| POST | `/api/sales` | `routes/api/sales.js:101` | Tạo đơn + auto-claim thưởng tháng trước |
| PUT | `/api/sales/:id` | `routes/api/sales.js:1225` | Sửa đơn (KHÔNG revert reward_history/stats) |
| DELETE | `/api/sales/:id` | `routes/sales.js` (đã đọc) | Xóa đơn + revert reward |
| POST | `/api/sales/:id/restore` | `routes/api/sales.js:1204` | Khôi phục archived (KHÔNG rebuild stats) |
| POST | `/api/sales/sync-volume` | `routes/api/sales.js:1539` | Rebuild `customer_monthly_stats` (XÓA stats cũ) |
| POST | `/api/promotions/reward/claim` | `routes/api/promotions.js:463` | Claim thủ công qua `claimMonthlyReward` |
| POST | `/api/promotions/reward/auto-generate` | `routes/api/promotions.js:822` | Cron-friendly: tạo `pending_rewards` cho tháng X |
| GET | `/api/promotions/reward/status/:id` | `routes/api/promotions.js:441` | Trạng thái thưởng |
| GET | `/api/report/data` | `routes/reportData.js:18` | Dashboard + báo cáo |
| GET | `/api/dashboard/data` | `routes/dashboard.js:61` | Dashboard stats |
| GET | `/api/report/bonus-report` | `routes/reportData.js:352` | Tổng kết thưởng |

---

## 7. Tóm tắt & khuyến nghị ưu tiên

### 7.1. Mức độ nghiêm trọng

| Mức | Số bug | Bug ID |
|---|---|---|
| **Cao** (logic sai, ảnh hưởng dữ liệu) | 5 | B1, B2, B5, B10, B11 |
| Trung bình | 7 | B3, B6, B7, B8, B9, B12, B13, B18 |
| Thấp | 3 | B14, B15, B16 + B17 (thiếu cron) |

### 7.2. Hành động đề xuất (KHÔNG nằm trong phạm vi sửa code của audit này)

1. **Thống nhất quy tắc NEW_CUSTOMER** giữa `determinePromotionProgram` và `getPromotionEligibility` – cần user xác nhận ngày 01-08 có được thưởng tháng tạo không (Q1).
2. **Xóa hoặc refactor** file `D:\Beer\index.js` (root) để tránh nhầm lẫn.
3. **Sửa `sync-volume`** để không phá `reward_claimed_*` khi rebuild.
4. **Thêm cron job** gọi `resetMonthlyRewards()` mỗi tháng (hiện không có trong `server.js`).
5. **Thêm unique constraint** `(customer_id, reward_month, reward_year)` trên `pending_rewards` để chống race condition.
6. **Đồng bộ pattern note** giữa `claimMonthlyReward` (không có `X/Y`) và `addPendingRewardToSale` (có `X/Y`) để các query `note LIKE '%tháng X/Y%'` hoạt động đồng nhất.
7. **Document** rõ hành vi khi khách tạo ngày 01-08 và đạt tier ngay tháng tạo (hiện canonical skip do B1).