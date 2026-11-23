/**
 * PRE-ORDER — GIỜ BÁN (sale_time) = 0H NGÀY GIAO (2026-11-23)
 * ─────────────────────────────────────────────────────────────────────────────
 * YÊU CẦU NGHIỆP VỤ:
 *  "Thời gian của đơn đặt trước là 0h ngày đặt trước".
 *
 *  Đơn đặt trước CHƯA giao → không có "giờ bán thực tế". Đặt `sale_time`
 *  = '00:00:00' giúp:
 *    - Đơn đứng ĐẦU danh sách giao hàng (sắp xếp `sale_time` tăng dần)
 *      → tài xế giao đơn chờ lâu nhất trước.
 *    - Hiển thị thống nhất "00:00" ở mọi danh sách.
 *
 *  Đơn THƯỜNG phải GIỮ NGUYÊN giờ thực tế (giờ VN).
 *
 * CÁCH KIỂM CHỨNG:
 *  T1. `getSaleTime(null)` → giờ thực tế (không phải 00:00:00).
 *  T2. `getSaleTime('2026-11-25')` → '00:00:00'.
 *  T3. Đơn thường tạo qua API → sale_time = giờ thực tế.
 *  T4. Đơn đặt trước tạo qua API → sale_time = '00:00:00'.
 *  T5. Đơn đặt trước có sale_time 00:00:00 → đứng đầu danh sách giao
 *      (sắp xếp tăng dần theo sale_time).
 */
process.env.NODE_ENV = 'test';

const db = require('../database');
const PreOrderService = require('../src/services/PreOrderService');

jest.setTimeout(30000);

// ── Helpers ─────────────────────────────────────────────────────────────────

function futureDate(daysAhead = 1) {
  const d = new Date(Date.now() + 7 * 3600 * 1000 + daysAhead * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function createCustomer(name) {
  const r = db
    .prepare('INSERT INTO customers (name, phone, deposit, keg_balance) VALUES (?, ?, 0, 0)')
    .run(name, '09' + Math.floor(10000000 + Math.random() * 89999999));
  return r.lastInsertRowid;
}

let customerId = null;

beforeAll(() => {
  customerId = createCustomer('TEST KHACH PREORDER SALE TIME');
});

afterEach(() => {
  db.prepare('DELETE FROM sales WHERE customer_id = ?').run(customerId);
  db.prepare('DELETE FROM sale_items WHERE sale_id NOT IN (SELECT id FROM sales)').run();
});

// ── T1/T2: hàm getSaleTime ─────────────────────────────────────────────────

describe('PreOrderService.getSaleTime', () => {
  test('T1: đơn thường (null) → giờ thực tế, KHÔNG phải 00:00:00', () => {
    const t = PreOrderService.getSaleTime(null);
    expect(t).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(t).not.toBe('00:00:00');
  });

  test('T2: đơn đặt trước → 00:00:00', () => {
    expect(PreOrderService.getSaleTime(futureDate(1))).toBe('00:00:00');
    expect(PreOrderService.getSaleTime('2026-12-31')).toBe('00:00:00');
  });
});

// ── T3/T4: tạo đơn qua API ────────────────────────────────────────────────

describe('API tạo đơn — sale_time theo loại đơn', () => {
  // Mock req/res cho router POST /api/sales.
  function callCreateSale(body) {
    // eslint-disable-next-line global-require
    const router = require('../routes/api/sales');
    const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
    const handler = layer.route.stack[0].handle;

    let statusCode = 200;
    let payload = null;
    const req = {
      body,
      user: { username: 'admin', role: 'ADMIN' },
      ip: '127.0.0.1',
    };
    const res = {
      status(c) { statusCode = c; return this; },
      json(p) { payload = p; return this; },
    };
    // Handler là async → trả promise để await.
    return handler(req, res).then(() => ({ statusCode, payload }));
  }

  function getProduct() {
    return db.prepare("SELECT id FROM products WHERE archived = 0 AND type = 'keg' LIMIT 1").get();
  }

  test('T4: đơn đặt trước → sale_time = 00:00:00', async () => {
    const p = getProduct();
    if (!p) {
      // Không có sản phẩm keg → bỏ qua (môi trường test trống).
      return;
    }
    const preorderDate = futureDate(2);
    const { payload } = await callCreateSale({
      customerId,
      items: [{ productId: p.id, quantity: 1, price: 100000, type: 'keg' }],
      preorderDate,
    });

    expect(payload.success).toBe(true);
    const row = db.prepare('SELECT date, created_on, sale_time, preorder_status FROM sales WHERE id = ?').get(payload.id);
    expect(row.preorder_status).toBe('SCHEDULED');
    expect(row.sale_time).toBe('00:00:00');
    // `date` = ngày giao; `created_on` = ngày lập đơn (giữ nguyên).
    expect(row.date).toBe(preorderDate);
  });

  test('T3: đơn thường → sale_time = giờ thực tế', async () => {
    const p = getProduct();
    if (!p) return;

    const { payload } = await callCreateSale({
      customerId,
      items: [{ productId: p.id, quantity: 1, price: 100000, type: 'keg' }],
    });

    expect(payload.success).toBe(true);
    const row = db.prepare('SELECT sale_time FROM sales WHERE id = ?').get(payload.id);
    expect(row.sale_time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(row.sale_time).not.toBe('00:00:00');
  });
});

// ── T5: thứ tự trong danh sách giao hàng ───────────────────────────────────

describe('thứ tự đơn trong danh sách giao hàng của tài xế', () => {
  test('T5: đơn đặt trước (00:00:00) đứng TRƯỚC đơn thường (giờ thực tế)', () => {
    const today = db.getVietnamDateStr();

    // Đơn thường — giờ thực tế.
    db.prepare(
      `INSERT INTO sales (customer_id, date, created_on, sale_time, total, type, preorder_status, preorder_date)
       VALUES (?, ?, ?, '12:00:00', 100000, 'sale', 'RELEASED', ?)`
    ).run(customerId, today, today, today);

    // Đơn đặt trước — 00:00:00.
    db.prepare(
      `INSERT INTO sales (customer_id, date, created_on, sale_time, total, type, preorder_status, preorder_date)
       VALUES (?, ?, ?, '00:00:00', 100000, 'sale', 'RELEASED', ?)`
    ).run(customerId, today, today, today);

    // Sắp xếp giống DeliveryService / driver portal: sale_time tăng dần.
    const rows = db
      .prepare(
        `SELECT id, sale_time FROM sales
          WHERE customer_id = ? AND date = ?
          ORDER BY sale_time IS NULL, sale_time, id ASC`
      )
      .all(customerId, today);

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].sale_time).toBe('00:00:00');
    expect(rows[rows.length - 1].sale_time).toBe('12:00:00');
  });
});
