/**
 * Beer POS - Keg Ledger Module
 * Nguồn tri thức DUY NHẤT để cập nhật tồn kho vỏ bình.
 *
 * Mỗi giao dịch vỏ bình được ghi vào bảng `keg_ledger` với:
 *   - source_type: loại nguồn phát sinh
 *   - pool_from → pool_to: luồng di chuyển vỏ
 *   - balance_after_*: snapshot tồn kho SAU giao dịch
 *
 * Các pool:
 *   inventory  — kho đầy bia (products.stock WHERE type='keg')
 *   empty      — kho vỏ rỗng đã thu (keg_stats.empty_collected)
 *   customer   — khách đang giữ (customers.keg_balance)
 *   factory    — bên ngoài hệ thống (nhà máy, bán đi…)
 */

const db = require('../../database');
const { KEG_POOL, KEG_SOURCE } = require('../constants');

/**
 * Đọc trạng thái hiện tại của 3 pool từ bảng nguồn.
 * Đây là cách đọc DUY NHẤT — không bao giờ đọc từ keg_stats
 * vì keg_stats chỉ là cache được sync từ ledger.
 */
function getCurrentState() {
  const inventory = db.prepare(
    "SELECT COALESCE(SUM(stock), 0) as n FROM products WHERE type = 'keg'"
  ).get().n || 0;

  const emptyStats = db.prepare(
    "SELECT COALESCE(empty_collected, 0) as n FROM keg_stats WHERE id = 1"
  ).get();

  // Đọc customer holding từ bảng customers (source of truth), không từ keg_stats
  const customer = db.prepare(
    "SELECT COALESCE(SUM(keg_balance), 0) as n FROM customers WHERE archived = 0"
  ).get().n || 0;

  return {
    inventory: Math.max(0, inventory),
    empty:     Math.max(0, emptyStats?.n || 0),
    customer:  Math.max(0, customer)
  };
}

/**
 * Ghi một ledger entry vào keg_ledger.
 * ĐỒNG THỜI sync keg_stats để UI / API cũ vẫn hoạt động.
 *
 * @param {Object} opts
 * @param {string}  opts.sourceType  — 'sale'|'delivery'|'collect'|'import'|'adjust'|'sell_empty'|'return_sale'
 * @param {number|null} opts.sourceId    — sales.id / purchases.id / null
 * @param {number|null} opts.customerId
 * @param {number}  opts.quantity     — luôn dương
 * @param {string}  opts.poolFrom    — 'inventory'|'empty'|'customer'|'factory'
 * @param {string}  opts.poolTo      — 'inventory'|'empty'|'customer'|'factory'
 * @param {string}  [opts.note]
 * @returns {Object} newState — trạng thái sau giao dịch
 */
function kegLedgerEntry({ sourceType, sourceId = null, customerId = null,
  quantity, poolFrom, poolTo, note = null }) {

  quantity = Math.abs(parseInt(quantity) || 0);
  if (quantity <= 0) return getCurrentState();

  // Tính state mới
  const state = getCurrentState();

  const newState = { ...state };

  // pool_from: bớt khỏi pool nguồn
  switch (poolFrom) {
    case 'inventory': newState.inventory = Math.max(0, state.inventory - quantity); break;
    case 'empty':     newState.empty     = Math.max(0, state.empty     - quantity); break;
    case 'customer':  newState.customer   = Math.max(0, state.customer  - quantity); break;
    // 'factory' không bớt (vỏ đi ra ngoài)
  }

  // pool_to: cộng vào pool đích
  switch (poolTo) {
    case 'inventory': newState.inventory += quantity; break;
    case 'empty':     newState.empty     += quantity; break;
    case 'customer':  newState.customer   += quantity; break;
    // 'factory' không cộng (vỏ đi ra ngoài)
  }

  // Ghi ledger entry
  db.prepare(`
    INSERT INTO keg_ledger
      (source_type, source_id, customer_id, quantity,
       pool_from, pool_to,
       balance_after_inventory, balance_after_empty, balance_after_customer,
       note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceType, sourceId, customerId, quantity,
    poolFrom, poolTo,
    newState.inventory, newState.empty, newState.customer,
    note
  );

  // Sync keg_stats (đảm bảo UI / API cũ vẫn hoạt động)
  syncKegStats(newState);

  return newState;
}

/**
 * Đồng bộ keg_stats từ state sau ledger entry.
 * Gọi SAU mỗi kegLedgerEntry().
 */
function syncKegStats(state) {
  db.prepare(`
    UPDATE keg_stats
    SET inventory = ?,
        empty_collected = ?,
        customer_holding = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(state.inventory, state.empty, state.customer);
}

/**
 * Kiểm tra xem ledger entry đã tồn tại cho source_type + source_id chưa.
 * Dùng cho migration / sync.
 */
function ledgerEntryExists(sourceType, sourceId) {
  if (!sourceId) return false;
  const row = db.prepare(
    'SELECT id FROM keg_ledger WHERE source_type = ? AND source_id = ? LIMIT 1'
  ).get(sourceType, sourceId);
  return !!row;
}

/**
 * Lấy danh sách ledger entries với phân trang.
 * Dùng cho API /kegs/ledger.
 */
function getLedgerEntries({ customerId = null, from = null, to = null,
  sourceType = null, page = 1, limit = 50 }) {

  const conditions = [];
  const params = [];

  if (customerId) {
    conditions.push('customer_id = ?');
    params.push(customerId);
  }
  if (from) {
    conditions.push("created_at >= ?");
    params.push(from);
  }
  if (to) {
    conditions.push("created_at <= ?");
    params.push(to);
  }
  if (sourceType) {
    conditions.push('source_type = ?');
    params.push(sourceType);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

  const rows = db.prepare(`
    SELECT l.*, c.name as customer_name
    FROM keg_ledger l
    LEFT JOIN customers c ON c.id = l.customer_id
    ${where}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  const countRow = db.prepare(`
    SELECT COUNT(*) as total FROM keg_ledger l ${where}
  `).get(...params);

  return {
    data: rows,
    total: countRow.total,
    page: parseInt(page),
    limit: parseInt(limit),
    pages: Math.ceil(countRow.total / parseInt(limit))
  };
}

/**
 * Migration: Đồng bộ tất cả sales CŨ vào keg_ledger.
 * Chạy một lần duy nhất khi server khởi động (kiểm tra qua settings).
 * Tạo ledger entries cho:
 *   - deliver_kegs > 0  → pool_from=inventory, pool_to=customer
 *   - return_kegs > 0   → pool_from=customer,  pool_to=empty
 */
function migrateSalesToLedger() {
  try {
    // Kiểm tra đã migrate chưa
    const row = db.prepare("SELECT value FROM settings WHERE key = 'keg_ledger_migrated'").get();
    if (row && row.value === '1') {
      return { migrated: false, reason: 'already_done' };
    }

    // Lấy tất cả sales có kegs, sắp xếp theo date để đảm bảo đúng thứ tự
    const sales = db.prepare(`
      SELECT id, customer_id, date, deliver_kegs, return_kegs
      FROM sales
      WHERE (deliver_kegs > 0 OR return_kegs > 0)
      ORDER BY date ASC
    `).all();

    // Khởi tạo running balance — trước mọi sale cũ
    const running = { inventory: 0, empty: 0, customer: 0 };
    let count = 0;

    for (const s of sales) {
      // deliver_kegs: inventory → customer
      if (s.deliver_kegs > 0) {
        const exists = db.prepare(
          "SELECT id FROM keg_ledger WHERE source_type = ? AND source_id = ? AND pool_from = ? AND pool_to = ? LIMIT 1"
        ).get(KEG_SOURCE.SALE, s.id, KEG_POOL.INVENTORY, KEG_POOL.CUSTOMER);
        if (!exists) {
          running.inventory = Math.max(0, running.inventory - s.deliver_kegs);
          running.customer += s.deliver_kegs;

          db.prepare(`
            INSERT INTO keg_ledger
              (source_type, source_id, customer_id, quantity, pool_from, pool_to,
               balance_after_inventory, balance_after_empty, balance_after_customer, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(KEG_SOURCE.SALE, s.id, s.customer_id, s.deliver_kegs, KEG_POOL.INVENTORY, KEG_POOL.CUSTOMER,
                  running.inventory, running.empty, running.customer,
                  `Migration: giao bia don #${s.id}`, s.date);
          count++;
        }
      }

      // return_kegs: customer → empty
      if (s.return_kegs > 0) {
        const exists = db.prepare(
          "SELECT id FROM keg_ledger WHERE source_type = ? AND source_id = ? AND pool_from = ? AND pool_to = ? LIMIT 1"
        ).get(KEG_SOURCE.SALE, s.id, KEG_POOL.CUSTOMER, KEG_POOL.EMPTY);
        if (!exists) {
          running.customer = Math.max(0, running.customer - s.return_kegs);
          running.empty   += s.return_kegs;

          db.prepare(`
            INSERT INTO keg_ledger
              (source_type, source_id, customer_id, quantity, pool_from, pool_to,
               balance_after_inventory, balance_after_empty, balance_after_customer, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(KEG_SOURCE.SALE, s.id, s.customer_id, s.return_kegs, KEG_POOL.CUSTOMER, KEG_POOL.EMPTY,
                  running.inventory, running.empty, running.customer,
                  `Migration: thu vo don #${s.id}`, s.date);
          count++;
        }
      }
    }

    // Đánh dấu đã migrate
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('keg_ledger_migrated', '1')").run();

    console.log(`[keg_ledger] Migration: đã ghi ${count} ledger entries từ ${sales.length} sales cũ.`);
    return { migrated: true, count, sales: sales.length };
  } catch (err) {
    console.error('[keg_ledger] Migration error:', err.message);
    return { migrated: false, reason: 'error', error: err.message };
  }
}

module.exports = {
  kegLedgerEntry,
  getCurrentState,
  syncKegStats,
  ledgerEntryExists,
  getLedgerEntries,
  migrateSalesToLedger
};
