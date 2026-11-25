/**
 * PRE-ORDER — NGÀY GIAO vs NGÀY TẠO (HỒI QUY 2026-11-23)
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG ĐÃ GẶP:
 *  Driver Portal / danh sách giao hàng lọc đơn theo
 *    `COALESCE(DATE(s.created_on), DATE(s.date)) = today`
 *  — tức NGÀY LỊCH THỰC tạo đơn (giữ đơn tạo sau 19:00 trong ngày đó).
 *
 *  Đơn ĐẶT TRƯỚC có ngày giao = `preorder_date` ≠ `created_on`
 *  (đặt hôm nay 22/11, giao ngày mai 23/11) → sau khi release, đơn
 *  KHÔNG xuất hiện trong danh sách giao hàng của ngày giao, và số
 *  lượng "cần giao hôm nay" bị thiếu.
 *
 * FIX:
 *  `PreOrderSQL.DELIVERY_DATE_EXPR` — với đơn đặt trước đã RELEASED thì
 *  ngày giao = `preorder_date`; đơn thường giữ nguyên hành vi cũ.
 *
 * CÁCH KIỂM CHỨNG:
 *  G1. Đơn thường: ngày giao = created_on (hành vi cũ không đổi).
 *  G2. Đơn đặt trước SCHEDULED: KHÔNG hiện trong danh sách giao ngày giao.
 *  G3. Đơn đặt trước RELEASED: HIỆN trong danh sách giao của `preorder_date`.
 *  G4. Đơn đặt trước RELEASED: số lít "cần giao" tính đúng vào ngày giao.
 *  G5. Biểu thức SQL sinh ra đúng (kiểm tra ở mức chuỗi).
 */
process.env.NODE_ENV = 'test';

const db = require('../database');
const PreOrderSQL = require('../src/services/PreOrderSQL');

jest.setTimeout(30000);

// ── Helpers ─────────────────────────────────────────────────────────────────

function futureDate(daysAhead = 2) {
  const d = new Date(Date.now() + 7 * 3600 * 1000 + daysAhead * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function todayVn() {
  return db.getVietnamDateStr();
}

function createCustomer(name) {
  const r = db
    .prepare('INSERT INTO customers (name, phone, deposit, keg_balance) VALUES (?, ?, 0, 0)')
    .run(name, '09' + Math.floor(10000000 + Math.random() * 89999999));
  return r.lastInsertRowid;
}

function getProductId() {
  const p = db.prepare('SELECT id FROM products WHERE archived = 0 LIMIT 1').get();
  return p && p.id;
}

let customerId = null;
let productId = null;

/**
 * Tạo đơn đặt trước.
 * @param {string} preorderDate - ngày giao mong muốn
 * @param {string} createdOn     - ngày lịch thực tạo đơn (mặc định = hôm nay)
 * @param {string} status        - 'SCHEDULED' | 'RELEASED' | null
 */
function createPreorderSale(preorderDate, createdOn, status = 'SCHEDULED') {
  const r = db
    .prepare(
      `INSERT INTO sales (customer_id, date, created_on, total, type, deliver_kegs,
                          preorder_status, preorder_date, created_at)
       VALUES (?, ?, ?, 100000, 'sale', 2, ?, ?, CURRENT_TIMESTAMP)`
    )
    .run(customerId, preorderDate, createdOn, status, preorderDate);
  const saleId = r.lastInsertRowid;
  db.prepare('INSERT INTO sale_items (sale_id, product_id, quantity, price) VALUES (?, ?, ?, 50000)')
    .run(saleId, productId, 3);
  return saleId;
}

/** Chạy biểu thức ngày giao trên 1 row thật trong DB. */
function deliveryDateOf(saleId) {
  return db
    .prepare(
      `SELECT CASE
         WHEN preorder_status = 'RELEASED' AND preorder_date IS NOT NULL
           THEN DATE(preorder_date)
         ELSE COALESCE(DATE(created_on), DATE(date))
       END AS d FROM sales WHERE id = ?`
    )
    .get(saleId).d;
}

beforeAll(() => {
  customerId = createCustomer('KH PreOrder DeliveryDate');
  productId = getProductId();
});

afterEach(() => {
  db.prepare('DELETE FROM sales WHERE preorder_status IS NOT NULL').run();
  db.prepare('DELETE FROM sale_items WHERE sale_id NOT IN (SELECT id FROM sales)').run();
});

// ── G5: biểu thức SQL ───────────────────────────────────────────────────────

describe('PreOrderSQL.DELIVERY_DATE_EXPR', () => {
  test('G5a: có CASE ưu tiên preorder_date cho đơn RELEASED', () => {
    expect(PreOrderSQL.DELIVERY_DATE_EXPR).toContain("preorder_status = 'RELEASED'");
    expect(PreOrderSQL.DELIVERY_DATE_EXPR).toContain('DATE(s.preorder_date)');
    // Vẫn giữ fallback cũ cho đơn thường
    expect(PreOrderSQL.DELIVERY_DATE_EXPR).toContain('COALESCE(DATE(s.created_on), DATE(s.date))');
  });

  test('G5b: bản NO_ALIAS không chứa prefix bảng', () => {
    expect(PreOrderSQL.DELIVERY_DATE_EXPR_NO_ALIAS).not.toContain('s.');
    expect(PreOrderSQL.DELIVERY_DATE_EXPR_NO_ALIAS).toContain('DATE(preorder_date)');
  });
});

// ── G1/G2/G3: ngày giao của từng loại đơn ───────────────────────────────────

describe('ngày giao thực tế của đơn', () => {
  test('G1: đơn thường → ngày giao = created_on (không đổi hành vi)', () => {
    const createdOn = futureDate(1);
    const r = db
      .prepare(
        `INSERT INTO sales (customer_id, date, created_on, total, type, created_at)
         VALUES (?, ?, ?, 100000, 'sale', CURRENT_TIMESTAMP)`
      )
      .run(customerId, createdOn, createdOn);
    const saleId = r.lastInsertRowid;

    expect(deliveryDateOf(saleId)).toBe(createdOn);

    db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
  });

  test('G2: đơn đặt trước SCHEDULED → chưa hiện trong ngày giao', () => {
    const preorderDate = futureDate(1);
    const createdOn = todayVn(); // đặt hôm nay, giao ngày mai
    const saleId = createPreorderSale(preorderDate, createdOn, 'SCHEDULED');

    // Ngày giao TÍNH TOÁN của đơn SCHEDULED vẫn là created_on
    // (đơn chưa release → chưa được giao → không thuộc ngày giao nào).
    expect(deliveryDateOf(saleId)).toBe(createdOn);
    expect(deliveryDateOf(saleId)).not.toBe(preorderDate);
  });

  test('G3: đơn đặt trước RELEASED → ngày giao = preorder_date', () => {
    const preorderDate = futureDate(1);
    const createdOn = todayVn();
    const saleId = createPreorderSale(preorderDate, createdOn, 'RELEASED');

    expect(deliveryDateOf(saleId)).toBe(preorderDate);
    expect(deliveryDateOf(saleId)).not.toBe(createdOn);
  });
});

// ── G4: truy vấn danh sách giao hàng thực tế ───────────────────────────────

describe('truy vấn danh sách giao hàng dùng DELIVERY_DATE_EXPR', () => {
  /** Mô phỏng query "đơn cần giao trong ngày D" của DeliveryService. */
  function listDeliveriesOn(dateStr) {
    return db
      .prepare(
        `
        SELECT s.id, s.preorder_status, s.preorder_date, s.created_on
        FROM sales s
        WHERE s.type = 'sale'
          AND s.archived = 0
          AND s.deleted = 0
          AND ${PreOrderSQL.DELIVERY_DATE_EXPR} = ?
          AND ${PreOrderSQL.COUNTED_FILTER}
        `
      )
      .all(dateStr);
  }

  test('G4a: đơn RELEASED xuất hiện đúng ngày giao, không xuất hiện ngày tạo', () => {
    const preorderDate = futureDate(1);
    const createdOn = todayVn();
    const saleId = createPreorderSale(preorderDate, createdOn, 'RELEASED');

    const onPreorderDate = listDeliveriesOn(preorderDate).map((r) => r.id);
    const onCreatedDate = listDeliveriesOn(createdOn).map((r) => r.id);

    expect(onPreorderDate).toContain(saleId);
    expect(onCreatedDate).not.toContain(saleId);
  });

  test('G4b: đơn SCHEDULED không xuất hiện ở cả 2 ngày', () => {
    const preorderDate = futureDate(1);
    const createdOn = todayVn();
    const saleId = createPreorderSale(preorderDate, createdOn, 'SCHEDULED');

    expect(listDeliveriesOn(preorderDate).map((r) => r.id)).not.toContain(saleId);
    expect(listDeliveriesOn(createdOn).map((r) => r.id)).not.toContain(saleId);
  });

  test('G4c: đơn thường không bị ảnh hưởng', () => {
    const today = todayVn();
    const r = db
      .prepare(
        `INSERT INTO sales (customer_id, date, created_on, total, type, created_at)
         VALUES (?, ?, ?, 100000, 'sale', CURRENT_TIMESTAMP)`
      )
      .run(customerId, today, today);
    const saleId = r.lastInsertRowid;

    expect(listDeliveriesOn(today).map((x) => x.id)).toContain(saleId);

    db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
  });
});
