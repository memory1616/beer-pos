/**
 * CHỐT KHÁCH NGỪNG BÁN — CustomerClosureService + API
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi test:
 *  - Migration 064: bảng `customer_closures` + `customer_closure_items`
 *  - CustomerClosureService.preview(): số liệu tổng quan
 *  - CustomerClosureService.close():
 *      • Thu hồi vỏ rỗng / vỏ đầy / vỏ mất → đúng kho & keg_stats
 *      • Hoàn cọc → giảm `customers.deposit`
 *      • Cấn trừ công nợ (offset) → giảm nợ; dư → CREDIT (âm)
 *      • Xóa nợ (writeoff) → nợ về 0
 *      • Giữ nợ (keep) → nợ không đổi
 *      • Huỷ đơn giao chưa hoàn tất → FAILED
 *      • Lưu trữ khách (tuỳ chọn)
 *      • Từ chối khi tổng vỏ vượt số vỏ khách giữ
 */
process.env.NODE_ENV = 'test';

const db = require('../database');
const CustomerClosureService = require('../src/services/CustomerClosureService');
const DebtLedgerService = require('../src/services/debt/DebtLedgerService');
const { TRANSACTION_TYPES } = require('../src/services/debt/constants');

jest.setTimeout(20000);

// ── Fixtures ────────────────────────────────────────────────────────────────
const createdCustomers = [];
const createdProducts = [];
const createdSales = [];
const createdDeliveries = [];

function makeCustomer(opts = {}) {
  const name = `__CLOSURE_TEST_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, deposit, keg_balance, debt, archived, created_at, updated_at)
       VALUES (?, '', ?, ?, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name, opts.deposit || 0, opts.kegBalance || 0);
  createdCustomers.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function makeProduct(opts = {}) {
  const name = `__CLOSURE_PROD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const info = db
    .prepare(
      `INSERT INTO products (name, slug, stock, sell_price, type, archived, created_at)
       VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`
    )
    .run(name, `closure-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, opts.stock || 0, opts.sellPrice || 0, opts.type || 'pet');
  createdProducts.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function makeKegProduct() {
  const name = `__CLOSURE_KEG_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const info = db
    .prepare(
      `INSERT INTO products (name, slug, stock, sell_price, type, archived, created_at)
       VALUES (?, ?, ?, 0, 'keg', 0, CURRENT_TIMESTAMP)`
    )
    .run(name, `closure-keg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 0);
  createdProducts.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

/** Tạo sản phẩm KHÔNG phải keg (chai/lon/hộp). */
function makeOtherProduct(type = 'pet', sellPrice = 15000) {
  const name = `__CLOSURE_OTHER_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const info = db
    .prepare(
      `INSERT INTO products (name, slug, stock, sell_price, type, archived, created_at)
       VALUES (?, ?, 0, ?, ?, 0, CURRENT_TIMESTAMP)`
    )
    .run(name, `closure-other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, sellPrice, type);
  createdProducts.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function makeDelivery(customerId, status = 'PENDING') {
  const info = db
    .prepare(
      `INSERT INTO delivery_records (customer_id, driver_username, status, scheduled_date, created_at, updated_at)
       VALUES (?, '__test_driver__', ?, date('now'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(customerId, status);
  createdDeliveries.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

const createdDevices = [];

function makeDevice(customerId, type = 'vertical') {
  const name = `__CLOSURE_DEV_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const info = db
    .prepare(
      `INSERT INTO devices (name, type, serial_number, status, customer_id, assigned_date, created_at, updated_at, deleted)
       VALUES (?, ?, ?, 'in_use', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)`
    )
    .run(name, type, `SN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, customerId);
  createdDevices.push(info.lastInsertRowid);
  db.prepare('UPDATE customers SET vertical_fridge = vertical_fridge + 1 WHERE id = ?').run(customerId);
  return info.lastInsertRowid;
}

function makeDebt(customerId, amount) {
  return DebtLedgerService.recordTransaction({
    customerId,
    transactionType: TRANSACTION_TYPES.MANUAL_DEBT,
    amount,
    direction: DebtLedgerService.DIRECTION.INCREASE,
    createdBy: '__test__',
  });
}

function cleanup() {
  for (const id of createdDeliveries) {
    try { db.prepare('DELETE FROM delivery_events WHERE delivery_id = ?').run(id); } catch (_) {}
    try { db.prepare('DELETE FROM delivery_records WHERE id = ?').run(id); } catch (_) {}
  }
  for (const id of createdSales) {
    try { db.prepare('DELETE FROM sales WHERE id = ?').run(id); } catch (_) {}
  }
  for (const id of createdCustomers) {
    try {
      db.prepare('DELETE FROM customer_closure_devices WHERE closure_id IN (SELECT id FROM customer_closures WHERE customer_id = ?)').run(id);
      db.prepare('DELETE FROM customer_closure_items WHERE closure_id IN (SELECT id FROM customer_closures WHERE customer_id = ?)').run(id);
      db.prepare('DELETE FROM customer_closures WHERE customer_id = ?').run(id);
    } catch (_) {}
    try {
      db.prepare('DELETE FROM debt_audit_logs WHERE transaction_id IN (SELECT id FROM debt_transactions WHERE customer_id = ?)').run(id);
      db.prepare('DELETE FROM debt_transactions WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM debt_accounts WHERE customer_id = ?').run(id);
    } catch (_) {}
    try { db.prepare('DELETE FROM prices WHERE customer_id = ?').run(id); } catch (_) {}
    try { db.prepare('DELETE FROM customers WHERE id = ?').run(id); } catch (_) {}
  }
  for (const id of createdProducts) {
    try { db.prepare('DELETE FROM product_audit_log WHERE product_id = ?').run(id); } catch (_) {}
    try { db.prepare('DELETE FROM products WHERE id = ?').run(id); } catch (_) {}
  }
  for (const id of createdDevices) {
    try { db.prepare('DELETE FROM devices WHERE id = ?').run(id); } catch (_) {}
  }
  createdDeliveries.length = 0;
  createdSales.length = 0;
  createdCustomers.length = 0;
  createdProducts.length = 0;
  createdDevices.length = 0;
}

afterEach(() => cleanup());
afterAll(() => cleanup());

// ═══════════════════════════════════════════════════════════════════════════
describe('Migration 064 — bảng customer_closures', () => {
  test('đủ 2 bảng mới', () => {
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (
           'customer_closures','customer_closure_items')`
      )
      .all()
      .map((r) => r.name);
    expect(names).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('CustomerClosureService.preview', () => {
  test('trả về số liệu của khách', () => {
    const cid = makeCustomer({ deposit: 500000, kegBalance: 10 });
    const res = CustomerClosureService.preview(cid);
    expect(res.success).toBe(true);
    expect(res.preview.customer.id).toBe(cid);
    expect(res.preview.customer.deposit).toBe(500000);
    expect(res.preview.customer.kegBalance).toBe(10);
    expect(res.preview.debt.balance).toBe(0);
    expect(Array.isArray(res.preview.products)).toBe(true);
    expect(res.preview.defaults.depositRefund).toBe(500000);
    expect(res.preview.defaults.kegsEmpty).toBe(10);
  });

  test('khách không tồn tại → error', () => {
    const res = CustomerClosureService.preview(999999999);
    expect(res.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('CustomerClosureService.close — thu hồi vỏ', () => {
  test('vỏ rỗng → keg_stats.empty_collected tăng, keg_balance giảm', () => {
    const cid = makeCustomer({ kegBalance: 8 });
    const before = db.prepare('SELECT empty_collected FROM keg_stats WHERE id=1').get();

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 8,
      kegsFull: 0,
      kegsLost: 0,
      items: [],
      depositRefund: 0,
      debtMode: 'offset',
      archive: false,
    });
    expect(res.success).toBe(true);

    const after = db.prepare('SELECT empty_collected, customer_holding FROM keg_stats WHERE id=1').get();
    expect(after.empty_collected).toBe(before.empty_collected + 8);

    const cust = db.prepare('SELECT keg_balance FROM customers WHERE id=?').get(cid);
    expect(cust.keg_balance).toBe(0);
    expect(res.result.kegsEmpty).toBe(8);
  });

  test('vỏ còn đầy → products.stock của loại keg tăng', () => {
    const kegId = makeKegProduct();
    const cid = makeCustomer({ kegBalance: 5 });
    const stockBefore = db.prepare('SELECT stock FROM products WHERE id=?').get(kegId).stock;

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 5, kegsLost: 0, items: [], depositRefund: 0,
      kegProductId: kegId,
      debtMode: 'offset', archive: false,
    });
    expect(res.success).toBe(true);

    const stockAfter = db.prepare('SELECT stock FROM products WHERE id=?').get(kegId).stock;
    expect(stockAfter).toBe(stockBefore + 5);
  });

  test('vỏ mất → keg_stats.lost tăng', () => {
    const cid = makeCustomer({ kegBalance: 3 });
    const before = db.prepare('SELECT lost FROM keg_stats WHERE id=1').get();

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 3, items: [], depositRefund: 0,
      debtMode: 'offset', archive: false,
    });
    expect(res.success).toBe(true);

    const after = db.prepare('SELECT lost FROM keg_stats WHERE id=1').get();
    expect(after.lost).toBe(before.lost + 3);
  });

  test('tổng vỏ vượt số vỏ khách giữ → từ chối', () => {
    const cid = makeCustomer({ kegBalance: 2 });
    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 3, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0,
      debtMode: 'offset', archive: false,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/vượt quá/);
  });

  test('ghi log keg audit', () => {
    const cid = makeCustomer({ kegBalance: 2 });
    CustomerClosureService.close(cid, {
      kegsEmpty: 2, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0,
      debtMode: 'offset', archive: false,
    });
    const logs = db
      .prepare('SELECT * FROM keg_transactions_log WHERE customer_id = ?')
      .all(cid);
    expect(logs.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('CustomerClosureService.close — hàng tồn & hoàn tiền', () => {
  test('hàng tồn ở quán → về kho + hoàn tiền theo giá khách', () => {
    const pid = makeProduct({ sellPrice: 100000, stock: 0 });
    const cid = makeCustomer({ kegBalance: 0 });
    db.prepare('INSERT INTO prices (customer_id, product_id, price) VALUES (?, ?, ?)')
      .run(cid, pid, 120000);

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0,
      items: [{ productId: pid, quantity: 10 }],
      depositRefund: 0,
      debtMode: 'keep',
      archive: false,
    });
    expect(res.success).toBe(true);
    expect(res.result.totalGoodsAmount).toBe(1200000);

    const prod = db.prepare('SELECT stock FROM products WHERE id=?').get(pid);
    expect(prod.stock).toBe(10);

    const closure = db.prepare('SELECT * FROM customer_closures WHERE id=?').get(res.result.closureId);
    expect(closure.total_goods_amount).toBe(1200000);
    const items = db.prepare('SELECT * FROM customer_closure_items WHERE closure_id=?').all(res.result.closureId);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(10);
    expect(items[0].unit_price).toBe(120000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('CustomerClosureService.close — cọc & công nợ', () => {
  test('hoàn cọc → customers.deposit giảm', () => {
    const cid = makeCustomer({ deposit: 1000000 });
    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 400000,
      debtMode: 'keep', archive: false,
    });
    expect(res.success).toBe(true);
    const cust = db.prepare('SELECT deposit FROM customers WHERE id=?').get(cid);
    expect(cust.deposit).toBe(600000);
  });

  test('hoàn cọc vượt số cọc → bị chặn ở mức cọc', () => {
    const cid = makeCustomer({ deposit: 100000 });
    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 999999,
      debtMode: 'keep', archive: false,
    });
    expect(res.success).toBe(true);
    const cust = db.prepare('SELECT deposit FROM customers WHERE id=?').get(cid);
    expect(cust.deposit).toBe(0);
  });

  test('offset: tiền hoàn cấn trừ nợ', () => {
    const cid = makeCustomer({ deposit: 300000 });
    makeDebt(cid, 500000);

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 300000,
      debtMode: 'offset', archive: false,
    });
    expect(res.success).toBe(true);
    expect(res.result.debtBefore).toBe(500000);
    expect(res.result.debtAfter).toBe(200000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(200000);
  });

  test('offset: tiền hoàn vượt nợ → trả MẶT phần dư, số dư về 0', () => {
    const cid = makeCustomer({ deposit: 800000 });
    makeDebt(cid, 500000);

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 800000,
      debtMode: 'offset', archive: false,
    });
    expect(res.success).toBe(true);
    // 800.000 hoàn − 500.000 nợ = 300.000 trả mặt cho khách
    expect(res.result.cashRefund).toBe(300000);
    // Số dư công nợ về 0 (KHÔNG ghi CREDIT → không âm)
    expect(res.result.debtAfter).toBe(0);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
    // Không có bút toán CREDIT
    expect(res.result.debtTransactions.some((t) => t.type === 'credit')).toBe(false);
  });

  test('writeoff: xóa sạch nợ', () => {
    const cid = makeCustomer({ deposit: 0 });
    makeDebt(cid, 750000);

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0,
      debtMode: 'writeoff', archive: false,
    });
    expect(res.success).toBe(true);
    expect(res.result.debtAfter).toBe(0);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
  });

  test('keep: giữ nguyên nợ', () => {
    const cid = makeCustomer({ deposit: 100000 });
    makeDebt(cid, 750000);

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 100000,
      debtMode: 'keep', archive: false,
    });
    expect(res.success).toBe(true);
    expect(res.result.debtAfter).toBe(750000);
    expect(res.result.cashRefund).toBe(100000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(750000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('CustomerClosureService.close — đơn giao & lưu trữ', () => {
  test('đơn giao chưa hoàn tất → FAILED', () => {
    const cid = makeCustomer({ kegBalance: 0 });
    const did = makeDelivery(cid, 'PENDING');
    makeDelivery(cid, 'IN_PROGRESS');

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0,
      debtMode: 'keep', archive: false,
    });
    expect(res.success).toBe(true);
    expect(res.result.cancelledDeliveries).toBe(2);

    const rec = db.prepare('SELECT status, failure_reason FROM delivery_records WHERE id=?').get(did);
    expect(rec.status).toBe('FAILED');
    expect(rec.failure_reason).toMatch(/ngừng bán/i);
  });

  test('lưu trữ khách → archived=1 + debt_accounts.closed', () => {
    const cid = makeCustomer({ kegBalance: 0 });
    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0,
      debtMode: 'keep', archive: true,
    });
    expect(res.success).toBe(true);
    const cust = db.prepare('SELECT archived FROM customers WHERE id=?').get(cid);
    expect(cust.archived).toBe(1);
    const acc = db.prepare('SELECT status FROM debt_accounts WHERE customer_id=?').get(cid);
    expect(acc.status).toBe('closed');
  });

  test('không lưu trữ → archived=0', () => {
    const cid = makeCustomer({ kegBalance: 0 });
    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0,
      debtMode: 'keep', archive: false,
    });
    expect(res.success).toBe(true);
    const cust = db.prepare('SELECT archived FROM customers WHERE id=?').get(cid);
    expect(cust.archived).toBe(0);
  });

  test('chốt lần 2 với khách đã lưu trữ → từ chối', () => {
    const cid = makeCustomer({ kegBalance: 0 });
    CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0,
      debtMode: 'keep', archive: true,
    });
    const res2 = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0,
      debtMode: 'keep', archive: false,
    });
    expect(res2.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('CustomerClosureService — lịch sử & mã phiếu', () => {
  test('mã phiếu tăng dần theo ngày', () => {
    const cid = makeCustomer({ kegBalance: 0 });
    const r1 = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0,
      debtMode: 'keep', archive: false,
    });
    const r2 = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0,
      debtMode: 'keep', archive: false,
    });
    expect(r1.result.closureNo).toMatch(/^CL-\d{8}-\d{4}$/);
    expect(r2.result.closureNo).not.toBe(r1.result.closureNo);
  });

  test('listClosures trả về lịch sử kèm items', () => {
    const pid = makeProduct({ sellPrice: 50000 });
    const cid = makeCustomer({ kegBalance: 0 });
    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0,
      items: [{ productId: pid, quantity: 2 }], depositRefund: 0,
      debtMode: 'keep', archive: false,
    });
    const list = CustomerClosureService.listClosures(cid);
    expect(list.success).toBe(true);
    expect(list.closures).toHaveLength(1);
    expect(list.closures[0].closure_no).toBe(res.result.closureNo);
    expect(list.closures[0].items).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VỎ CÒN ĐẦY NHIỀU LOẠI (vàng/đen/...) — case thực tế khách 44
// ═══════════════════════════════════════════════════════════════════════════
describe('CustomerClosureService.close — vỏ còn đầy nhiều loại', () => {
  test('29 vỏ vàng + 9 vỏ đen → tồn kho tăng đúng từng loại, hoàn tiền theo giá khách', () => {
    const goldId = makeKegProduct();
    const blackId = makeKegProduct();
    const cid = makeCustomer({ kegBalance: 110 });

    // Giá riêng của khách
    db.prepare('INSERT INTO prices (customer_id, product_id, price) VALUES (?, ?, ?)')
      .run(cid, goldId, 21000);
    db.prepare('INSERT INTO prices (customer_id, product_id, price) VALUES (?, ?, ?)')
      .run(cid, blackId, 27000);

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 72,          // 110 - 38 vỏ đầy
      kegsFull: 0,
      kegsLost: 0,
      fullKegs: [
        { productId: goldId, quantity: 29 },
        { productId: blackId, quantity: 9 },
      ],
      items: [],
      depositRefund: 0,
      debtMode: 'keep',
      archive: false,
    });

    expect(res.success).toBe(true);
    expect(res.result.kegsFull).toBe(38);

    const gold = db.prepare('SELECT stock FROM products WHERE id=?').get(goldId).stock;
    const black = db.prepare('SELECT stock FROM products WHERE id=?').get(blackId).stock;
    expect(gold).toBe(29);
    expect(black).toBe(9);

    // Hoàn tiền = 29*21000 + 9*27000 = 609000 + 243000 = 852000
    expect(res.result.totalGoodsAmount).toBe(852000);
    expect(res.result.fullKegs).toHaveLength(2);

    // Ghi vào closure_items
    const items = db
      .prepare('SELECT * FROM customer_closure_items WHERE closure_id=?')
      .all(res.result.closureId);
    expect(items).toHaveLength(2);

    // keg_balance giảm đúng 38 (72 rỗng + 38 đầy = 110 → còn 0)
    const cust = db.prepare('SELECT keg_balance FROM customers WHERE id=?').get(cid);
    expect(cust.keg_balance).toBe(0);
  });

  test('vỏ đầy vượt số vỏ khách giữ → từ chối', () => {
    const goldId = makeKegProduct();
    const cid = makeCustomer({ kegBalance: 10 });
    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0,
      fullKegs: [{ productId: goldId, quantity: 20 }],
      items: [], depositRefund: 0, debtMode: 'keep', archive: false,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/vượt quá/);
  });

  test('trùng loại vỏ đầy → gộp dồn', () => {
    const goldId = makeKegProduct();
    const cid = makeCustomer({ kegBalance: 20 });
    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0,
      fullKegs: [
        { productId: goldId, quantity: 5 },
        { productId: goldId, quantity: 7 },
      ],
      items: [], depositRefund: 0, debtMode: 'keep', archive: false,
    });
    expect(res.success).toBe(true);
    expect(res.result.kegsFull).toBe(12);
    expect(res.result.fullKegs).toHaveLength(1);
    expect(db.prepare('SELECT stock FROM products WHERE id=?').get(goldId).stock).toBe(12);
  });

  test('fullKegs rỗng → vẫn hỗ trợ cách cũ (kegsFull + kegProductId)', () => {
    const goldId = makeKegProduct();
    const cid = makeCustomer({ kegBalance: 10 });
    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 4, kegsLost: 0,
      kegProductId: goldId,
      items: [], depositRefund: 0, debtMode: 'keep', archive: false,
    });
    expect(res.success).toBe(true);
    expect(db.prepare('SELECT stock FROM products WHERE id=?').get(goldId).stock).toBe(4);  });

  test('hàng KHÔNG phải keg (chai/lon) trong fullKegs → về kho + hoàn tiền, KHÔNG tính vào số vỏ', () => {
    const goldId = makeKegProduct();
    const petId = makeOtherProduct('pet', 15000);
    const cid = makeCustomer({ kegBalance: 10 });

    db.prepare('INSERT INTO prices (customer_id, product_id, price) VALUES (?, ?, ?)')
      .run(cid, goldId, 21000);
    db.prepare('INSERT INTO prices (customer_id, product_id, price) VALUES (?, ?, ?)')
      .run(cid, petId, 12000);

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 6, kegsFull: 0, kegsLost: 0,
      fullKegs: [
        { productId: goldId, quantity: 4 },   // vỏ keg → tính vào số vỏ
        { productId: petId, quantity: 20 },   // chai → KHÔNG tính vào số vỏ
      ],
      items: [], depositRefund: 0, debtMode: 'keep', archive: false,
    });

    expect(res.success).toBe(true);
    // Chỉ 4 vỏ keg tính vào số vỏ
    expect(res.result.kegsFull).toBe(4);
    // keg_balance = 10 - (6 rỗng + 4 đầy) = 0
    expect(db.prepare('SELECT keg_balance FROM customers WHERE id=?').get(cid).keg_balance).toBe(0);
    // Tồn kho: keg +4, pet +20
    expect(db.prepare('SELECT stock FROM products WHERE id=?').get(goldId).stock).toBe(4);
    expect(db.prepare('SELECT stock FROM products WHERE id=?').get(petId).stock).toBe(20);
    // Hoàn tiền = 4*21000 + 20*12000 = 84000 + 240000 = 324000
    expect(res.result.totalGoodsAmount).toBe(324000);
  });

  test('hàng KHÔNG phải keg gửi qua `items` → về kho + hoàn tiền', () => {
    const petId = makeOtherProduct('pet', 15000);
    const cid = makeCustomer({ kegBalance: 0 });

    db.prepare('INSERT INTO prices (customer_id, product_id, price) VALUES (?, ?, ?)')
      .run(cid, petId, 12000);

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0,
      fullKegs: [],
      items: [{ productId: petId, quantity: 12 }],
      depositRefund: 0, debtMode: 'keep', archive: false,
    });

    expect(res.success).toBe(true);
    expect(db.prepare('SELECT stock FROM products WHERE id=?').get(petId).stock).toBe(12);
    expect(res.result.totalGoodsAmount).toBe(144000);
    // Không có vỏ nào bị trừ
    expect(db.prepare('SELECT keg_balance FROM customers WHERE id=?').get(cid).keg_balance).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THU HỒI THIẾT BỊ (tủ lạnh)
// ═══════════════════════════════════════════════════════════════════════════
describe('CustomerClosureService.close — thu hồi thiết bị', () => {
  test('thiết bị được trả về kho + ghi phiếu + số tủ khách về 0', () => {
    const cid = makeCustomer({ kegBalance: 0 });
    const devId = makeDevice(cid, 'vertical');

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0,
      items: [], deviceIds: [devId],
      depositRefund: 0, debtMode: 'keep', archive: false,
    });

    expect(res.success).toBe(true);
    expect(res.result.devicesReturned).toBe(1);

    const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(devId);
    expect(dev.status).toBe('available');
    expect(dev.customer_id).toBeNull();
    expect(dev.assigned_date).toBeNull();

    const cust = db.prepare('SELECT vertical_fridge, horizontal_fridge FROM customers WHERE id=?').get(cid);
    expect(cust.vertical_fridge).toBe(0);

    const closure = db.prepare('SELECT * FROM customer_closures WHERE id=?').get(res.result.closureId);
    expect(closure.devices_returned).toBe(1);

    const devs = db
      .prepare('SELECT * FROM customer_closure_devices WHERE closure_id=?')
      .all(res.result.closureId);
    expect(devs).toHaveLength(1);
    expect(devs[0].device_id).toBe(devId);
  });

  test('thiết bị không thuộc khách → từ chối', () => {
    const cid = makeCustomer({ kegBalance: 0 });
    const otherCid = makeCustomer({ kegBalance: 0 });
    const devId = makeDevice(otherCid, 'horizontal');

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0,
      items: [], deviceIds: [devId],
      depositRefund: 0, debtMode: 'keep', archive: false,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/không thuộc khách/i);
  });

  test('preview trả về danh sách thiết bị của khách', () => {
    const cid = makeCustomer({ kegBalance: 0 });
    const devId = makeDevice(cid, 'vertical');
    const res = CustomerClosureService.preview(cid);
    expect(res.success).toBe(true);
    expect(res.preview.devices).toHaveLength(1);
    expect(res.preview.devices[0].id).toBe(devId);
    expect(res.preview.defaults.deviceIds).toEqual([devId]);
  });

  test('không chọn thiết bị → giữ nguyên gán cho khách', () => {
    const cid = makeCustomer({ kegBalance: 0 });
    const devId = makeDevice(cid, 'vertical');

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0,
      items: [], deviceIds: [],
      depositRefund: 0, debtMode: 'keep', archive: false,
    });
    expect(res.success).toBe(true);
    expect(res.result.devicesReturned).toBe(0);
    const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(devId);
    expect(dev.customer_id).toBe(cid);
    expect(dev.status).toBe('in_use');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TỦ CÒN THIẾU BẢN GHI (dữ liệu cũ chỉ lưu số đếm ở customers.*_fridge)
// ═══════════════════════════════════════════════════════════════════════════
describe('CustomerClosureService — tủ còn thiếu bản ghi', () => {
  test('preview báo số tủ thiếu bản ghi', () => {
    const cid = makeCustomer({ kegBalance: 0 });
    // Không có dòng devices nào, nhưng customers khai 1 tủ nằm + 1 tủ đứng
    db.prepare('UPDATE customers SET horizontal_fridge = 1, vertical_fridge = 1 WHERE id = ?').run(cid);

    const res = CustomerClosureService.preview(cid);
    expect(res.success).toBe(true);
    expect(res.preview.devices).toHaveLength(0);
    expect(res.preview.missingDevices.count).toBeGreaterThan(0);
    expect(res.preview.defaults.includeMissingDevices).toBe(true);
  });

  test('tick thu hồi tủ thiếu → tự tạo bản ghi rồi trả về kho', () => {
    const cid = makeCustomer({ kegBalance: 0 });
    db.prepare('UPDATE customers SET horizontal_fridge = 1 WHERE id = ?').run(cid);

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0,
      items: [], deviceIds: [], includeMissingDevices: true,
      depositRefund: 0, debtMode: 'keep', archive: false,
    });

    expect(res.success).toBe(true);
    expect(res.result.devicesCreated).toBe(1);
    expect(res.result.devicesReturned).toBe(1);

    // Tủ mới phải tồn tại trong bảng devices và đã về kho
    const dev = db.prepare("SELECT * FROM devices WHERE customer_id IS NULL AND type = 'horizontal' AND deleted = 0 ORDER BY id DESC LIMIT 1").get();
    expect(dev).toBeTruthy();
    expect(dev.status).toBe('available');
    expect(dev.customer_id).toBeNull();

    // Số tủ của khách về 0
    const cust = db.prepare('SELECT horizontal_fridge, vertical_fridge FROM customers WHERE id=?').get(cid);
    expect(cust.horizontal_fridge).toBe(0);

    // Ghi phiếu
    const devs = db
      .prepare('SELECT * FROM customer_closure_devices WHERE closure_id=?')
      .all(res.result.closureId);
    expect(devs).toHaveLength(1);
  });

  test('KHÔNG tick → không tạo bản ghi, số tủ giữ nguyên', () => {
    const cid = makeCustomer({ kegBalance: 0 });
    db.prepare('UPDATE customers SET horizontal_fridge = 1 WHERE id = ?').run(cid);

    const before = db.prepare("SELECT COUNT(*) AS c FROM devices WHERE type = 'horizontal'").get().c;

    const res = CustomerClosureService.close(cid, {
      kegsEmpty: 0, kegsFull: 0, kegsLost: 0,
      items: [], deviceIds: [], includeMissingDevices: false,
      depositRefund: 0, debtMode: 'keep', archive: false,
    });

    expect(res.success).toBe(true);
    expect(res.result.devicesCreated).toBe(0);
    const after = db.prepare("SELECT COUNT(*) AS c FROM devices WHERE type = 'horizontal'").get().c;
    expect(after).toBe(before);
  });
});
