# 🍺 BeerPOS Pro - Architecture Refactor (Step 1)

## 📋 Tổng Quan

Step 1 đã hoàn thành với các cải tiến kiến trúc và tính năng nghiệp vụ.

---

## ✅ Đã Triển Khai

### 1. Service Layer (`src/services/`)

Business logic tách biệt, dễ tái sử dụng và test:

```javascript
// Ví dụ sử dụng
const { SaleService, DebtService, PromotionService } = require('./src/services');

// Tạo đơn hàng
SaleService.create({ customerId: 1, items: [...] });

// Thêm thanh toán công nợ
DebtService.addPayment({ customerId: 1, amount: 500000, note: 'Thanh toán tháng 4' });

// Tính giảm giá
PromotionService.calculateDiscount({ customerId: 1, subtotal: 2000000, items: [...] });
```

### 2. State Management (`src/store/`)

Thay thế `window.store` rải rác bằng reactive state:

```javascript
const { store, cart } = require('./src/store');

// Reactive state
store.set('cart', []);
store.subscribe('cart', (newVal) => render());

// Cart actions
cart.addItem({ productId: 1, quantity: 5 });
cart.clearCart();
```

### 3. Cache Layer (`src/cache/`)

Tránh refetch dữ liệu không cần thiết:

```javascript
const { cache, cacheKeys, httpCache } = require('./src/cache');

// Server-side cache
cache.set('products', products, 300); // 5 phút
const products = cache.get('products');

// Client-side cache
httpCache.set('dashboard', data, 60);
const cached = httpCache.get('dashboard');

// Invalidate khi có thay đổi
cache.invalidatePattern('products_*');
```

### 4. Batch API Endpoints (`routes/api/batch.js`)

**TRƯỚC (20+ requests):**
```javascript
// Dashboard load = 20+ API calls
fetch('/api/products')
fetch('/api/customers')
fetch('/api/keg-stats')
fetch('/api/low-stock')
// ... 16 more
```

**SAU (1 request):**
```javascript
// Batch load - chỉ 1 request
POST /api/batch
{
  "requests": [
    { "type": "products" },
    { "type": "customers" },
    { "type": "dashboard" },
    { "type": "promotions" }
  ]
}
```

### 5. Debt Tracking System

**Database Tables:**
- `payments` - Thanh toán công nợ
- `debt_transactions` - Audit trail công nợ
- `order_debts` - Chi tiết công nợ theo đơn

**API Endpoints:**
- `GET /api/debts` - Danh sách công nợ
- `GET /api/debts/:customerId` - Chi tiết công nợ
- `POST /api/debts/payment` - Thêm thanh toán
- `GET /api/debts/summary` - Dashboard tổng quan

### 6. Promotion System

**Database Tables:**
- `promotions` - Khuyến mãi (% / fixed / buy_x_get_y)
- `customer_segments` - Phân khúc khách hàng

**API Endpoints:**
- `GET /api/promotions` - Danh sách khuyến mãi
- `POST /api/promotions` - Tạo khuyến mãi
- `POST /api/promotions/calculate` - Tính giảm giá cho đơn
- `GET /api/segments` - Danh sách phân khúc

---

## 📁 Cấu Trúc Files Mới

```
Beer/
├── src/
│   ├── services/
│   │   └── index.js        # SaleService, InventoryService, DebtService, PromotionService, AnalyticsService
│   ├── store/
│   │   └── index.js        # Reactive state management
│   └── cache/
│       └── index.js        # TTL cache, HTTP cache, Batch cache
│
├── routes/api/
│   ├── batch.js            # Batch API endpoints
│   ├── debts.js             # Debt tracking API
│   └── promotions.js       # Promotion API
│
├── database/
│   └── migrations/
│       └── 004_business_features.js  # DB tables for debts & promotions
│
└── public/js/
    └── debts-promotions.js  # Frontend UI components
```

---

## 🚀 Cách Sử Dụng

### 1. Khởi động server
```bash
npm start
```

Migrations tự động chạy khi server khởi động.

### 2. Sử dụng Batch API (Frontend)

```javascript
// Lấy tất cả data cần thiết cho dashboard trong 1 request
const response = await fetch('/api/batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    requests: [
      { type: 'products' },
      { type: 'customers' },
      { type: 'dashboard', params: { period: 'today' } },
      { type: 'promotions' }
    ]
  })
});

const { results } = await response.json();
// results.products, results.customers, results.dashboard, results.promotions
```

### 3. Sử dụng Debt Tracking

```javascript
// Load công nợ
const { data } = await DebtsUI.loadDebts({ hasDebt: true });
DebtsUI.renderDebtsList(data, 'debtsContainer');

// Thu nợ
await DebtsUI.showPaymentModal(1, 'Quán Joe', 500000);
```

### 4. Sử dụng Promotions

```javascript
// Tính giảm giá cho cart
const result = await PromotionsUI.calculateDiscount({
  customerId: 1,
  items: [{ productId: 1, quantity: 5 }],
  subtotal: 15000000
});

console.log(result.discount);        // Số tiền giảm
console.log(result.finalTotal);      // Tổng sau giảm
console.log(result.promotionsApplied); // Danh sách KM áp dụng
```

---

## 📊 Trước vs Sau

| Khía cạnh | Trước | Sau |
|-----------|-------|-----|
| **Business Logic** | Rải rác trong routes | Service layer tập trung |
| **State** | `window.store` rời rạc | Reactive state với subscriptions |
| **API Calls** | 20+ requests/dashboard | 1 batch request |
| **Caching** | Không có | TTL cache + HTTP cache |
| **Debt Tracking** | Không có | Đầy đủ (payments, audit trail) |
| **Promotions** | Không có | %, fixed, buy_x_get_y |
| **Customer Segments** | Chỉ tier (VIP/Normal) | Full segments với rules |

---

## 🔜 Bước Tiếp Theo (Step 2)

- [ ] Optimized dashboard loading (code splitting)
- [ ] Lazy loading components
- [ ] Service Worker caching
- [ ] Debounced API calls

---

## 🔧 Troubleshooting

### Migration không chạy?
```bash
# Xóa cache version
node -e "const db = require('./database'); db.prepare(\"DELETE FROM sync_meta WHERE key='schema_version'\").run();"
```

### Cache không update?
```bash
# Force refresh cache
POST /api/batch/cache/invalidate
{ "pattern": "*" }
```

---

## 📝 Lưu Ý

1. **Không break existing features** - Tất cả APIs cũ vẫn hoạt động
2. **Migrations idempotent** - Có thể chạy lại nhiều lần không lỗi
3. **Cache auto-expire** - Default 5 phút, có thể config riêng
4. **Backend state singleton** - Cache được share giữa requests
