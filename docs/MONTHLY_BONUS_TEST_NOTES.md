# MONTHLY_BONUS Audit Notes (P3 deferred)

## Phat hien quan trong (05/08/2026)

Trong qua trinh viet test cho `PromotionService` (BUG B1/B11/B7), phat hien:

### `database.js` da bi XOA tu commit `1ea23aa` (04/07/2026)

- File goc: `D:\Beer\database.js` (1519 dong)
- Commit xoa: `1ea23aa` - "Fix: Loai tru khach NEW_SHOP khoi thuong san luong"
- Hien trang: file KHONG ton tai tren disk va KHONG trong git index

### Tac dong

- `src/services/index.js:14` co `require('../../database')` se FAIL vi khong co module
- `tests/services/PromotionService.test.js` (P3.1 draft) cung fail vi ly do tuong tu
- **Production server chi chay duoc neu CHUA restart tu commit 1ea23aa**

### Ly do co the

- Co the PM2 process dang chay code cu (pre-1ea23aa) trong memory
- Hoac co file `database.js` duoc tao on-the-fly boi deploy script (can check `deploy/`)
- Hoac co symlink bi an

### Hanh dong can thuc hien (uu tien cao)

1. **Xac minh server production dang chay ban code nao** (PM2 list + log)
2. **Khoi phuc `database.js`** neu can:
   ```bash
   git show 1ea23aa~1:database.js > database.js
   git add database.js
   git commit -m "fix: khoi phuc database.js bi xoa tu 1ea23aa"
   ```
3. **Restart server** va verify `npm start` chay thanh cong
4. **Sau khi restore**, quay lai viet test P3.1 (BUG B1/B2/B5/B7/B11/B18)

### Test cases can viet (P3.1 backlog)

- `determinePromotionProgram`:
  - Khach tao ngay 01-08: MONTHLY_VOLUME (khong phai NEW_CUSTOMER)
  - Khach tao ngay 09+: NEW_CUSTOMER
  - Boundary 08 vs 09
  - Co don NEW_SHOP trong thang -> NEW_CUSTOMER
- `getPromotionStartDate`:
  - Ngay tao 01-08 -> start = ngay tao
  - Ngay tao 09+ -> start = 01 thang ke tiep
  - Boundary thang 12 -> thang 1 nam sau
- `getPromotionEligibility`:
  - Khach tao trong thang 01-08: rewardEligible=true
  - Khach tao trong thang 09+: newShopEligible=true
  - Khach `reward_enabled=0`: rewardEligible=false
- `claimMonthlyReward`:
  - Cap nhat dung `reward_claimed` chi khi attach vao don (B5)
- `resetMonthlyRewards` (B17):
  - Tao row moi cho thang moi, khong reset thang cu
