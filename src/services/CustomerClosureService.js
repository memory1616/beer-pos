/**
 * CustomerClosureService — CHỐT KHÁCH NGỪNG BÁN (thu hồi vỏ + hàng + cọc + công nợ)
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH NGHIỆP VỤ
 *
 *   Khách (quán bar/nhà hàng) ngừng bán. Chủ cửa hàng cần "chốt" lại khách:
 *
 *   1. THU HỒI VỎ: khách đang giữ `keg_balance` vỏ. Gồm:
 *        • vỏ RỖNG  → về kho chờ nạp lại  → `keg_stats.empty_collected += n`
 *        • vỏ ĐẦY (còn bia) → về kho    → `products.stock += n` (loại keg)
 *        • vỏ MẤT            → `keg_stats.lost += n`
 *      → `customers.keg_balance` giảm tương ứng, `keg_stats.customer_holding` đồng bộ.
 *
 *   2. THU HỒI HÀNG TỒN Ở QUÁN: bia/chai/hộp còn nằm ở quán (chưa bán hết).
 *      → về kho (`products.stock += qty`) + HOÀN TIỀN theo giá của khách.
 *
 *   3. HOÀN CỌC: `customers.deposit` → trả lại một phần hoặc toàn bộ.
 *
 *   4. CHỐT CÔNG NỢ: số dư sổ công nợ của khách được xử lý theo 1 trong 3 chế độ:
 *        • `offset`   : dùng tiền hoàn (hàng + cọc) để CẤN TRỪ nợ khách.
 *                       Nếu tiền hoàn > nợ → phần dư ghi thành CREDIT (khách nợ lại hệ thống).
 *        • `writeoff` : XÓA SẠCH nợ (chấp nhận không thu được nữa) → ADJUSTMENT giảm về 0.
 *        • `keep`     : GIỮ NGUYÊN nợ (khách còn nợ hệ thống), chỉ ghi nhận hoàn tiền mặt.
 *
 *   5. LƯU TRỮ KHÁCH (tuỳ chọn — người dùng chọn trong modal):
 *        `customers.archived = 1` + `debt_accounts.status = 'closed'`.
 *
 * NGUYÊN TẮC
 *   • Mọi thao tác chạy trong MỘT `db.transaction()` → atomic.
 *   • Sổ công nợ là append-only → dùng `DebtLedgerService.recordTransaction()`.
 *   • Ghi phiếu `customer_closures` + `customer_closure_items` để có dấu vết kiểm toán.
 *   • Đơn giao hàng chưa hoàn tất của khách → chuyển `FAILED` (không giao nữa).
 */

const db = require('../../database');
const logger = require('../utils/logger');
const AuditService = require('./AuditService');
const KegBalanceService = require('./KegBalanceService');
const DebtLedgerService = require('./debt/DebtLedgerService');
const DebtAccountService = require('./debt/DebtAccountService');
const { TRANSACTION_TYPES, SOURCES, REFERENCE_TYPES, ACCOUNT_STATUS } = require('./debt/constants');

/** Chế độ chốt công nợ. */
const DEBT_MODES = {
  OFFSET: 'offset',       // Cấn trừ tiền hoàn vào nợ
  WRITEOFF: 'writeoff',   // Xóa sạch nợ
  KEEP: 'keep',           // Giữ nguyên nợ
};

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function toInt(n, fallback = 0) {
  const v = parseInt(n, 10);
  return Number.isFinite(v) ? v : fallback;
}

function toNum(n, fallback = 0) {
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : fallback;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Lấy thông tin khách (không dùng bảng `customers` archived). */
function getCustomer(customerId) {
  const id = parseInt(customerId, 10);
  if (!id || Number.isNaN(id)) return null;
  return db
    .prepare(
      `SELECT id, name, phone, address, deposit, keg_balance, debt, archived, note
         FROM customers WHERE id = ?`
    )
    .get(id);
}

/**
 * Lấy giá bán của khách cho 1 sản phẩm.
 * Ưu tiên bảng `prices` (giá riêng của khách) → fallback `products.sell_price`.
 */
function getCustomerPrice(customerId, productId) {
  const row = db
    .prepare('SELECT price FROM prices WHERE customer_id = ? AND product_id = ?')
    .get(customerId, productId);
  if (row && Number.isFinite(row.price)) return roundMoney(row.price);

  const p = db.prepare('SELECT sell_price FROM products WHERE id = ?').get(productId);
  return roundMoney(p?.sell_price || 0);
}

/**
 * Bảng giá của khách cho tất cả sản phẩm đang hoạt động.
 * @returns {Array<{id,name,type,stock,sell_price,price}>}
 */
function getCustomerProductPrices(customerId) {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.type, p.stock, p.sell_price, p.archived
         FROM products p
        WHERE p.archived = 0
        ORDER BY p.name ASC`
    )
    .all();

  const custom = db
    .prepare('SELECT product_id, price FROM prices WHERE customer_id = ?')
    .all(customerId);
  const customMap = new Map(custom.map((r) => [r.product_id, roundMoney(r.price)]));

  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    stock: p.stock || 0,
    sell_price: roundMoney(p.sell_price || 0),
    price: customMap.has(p.id) ? customMap.get(p.id) : roundMoney(p.sell_price || 0),
  }));
}

/** Sinh mã phiếu chốt: CL-YYYYMMDD-XXXX */
function nextClosureNo(dateStr) {
  const ymd = String(dateStr || '').replace(/-/g, '') || '00000000';
  const prefix = `CL-${ymd}-`;
  const row = db
    .prepare(
      `SELECT closure_no FROM customer_closures
        WHERE closure_no LIKE ? ORDER BY id DESC LIMIT 1`
    )
    .get(prefix + '%');
  let next = 1;
  if (row && row.closure_no) {
    const tail = parseInt(String(row.closure_no).slice(prefix.length), 10);
    if (!isNaN(tail)) next = tail + 1;
  }
  return prefix + String(next).padStart(4, '0');
}

/** Tổng hợp số vỏ đang nằm trong kho (keg_stats). */
function getKegStats() {
  const s = db
    .prepare('SELECT inventory, empty_collected, customer_holding, lost FROM keg_stats WHERE id = 1')
    .get();
  return {
    inventory: s?.inventory || 0,
    emptyCollected: s?.empty_collected || 0,
    customerHolding: s?.customer_holding || 0,
    lost: s?.lost || 0,
  };
}

/** Đồng bộ `keg_stats.customer_holding` = SUM(customers.keg_balance). */
function syncCustomerHolding() {
  const total = db
    .prepare('SELECT COALESCE(SUM(keg_balance), 0) AS t FROM customers')
    .get();
  db.prepare(
    'UPDATE keg_stats SET customer_holding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
  ).run(total?.t || 0);
  return total?.t || 0;
}

/** Đồng bộ `keg_stats.inventory` = SUM(products.stock) cho type='keg'. */
function syncKegInventory() {
  const row = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
  const total = row?.total || 0;
  db.prepare(
    'UPDATE keg_stats SET inventory = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
  ).run(total);
  return total;
}

// ── PREVIEW ──────────────────────────────────────────────────────────────────

/**
 * Lấy số liệu tổng quan để hiển thị màn "Chốt khách" (chưa thay đổi gì).
 *
 * @param {number} customerId
 * @returns {{success:boolean, error?:string, preview?:object}}
 */
function preview(customerId) {
  const customer = getCustomer(customerId);
  if (!customer) return { success: false, error: 'Không tìm thấy khách hàng' };

  const id = customer.id;
  const debtBalance = DebtLedgerService.computeBalance(id);
  const kegs = getKegStats();

  // Đơn giao chưa hoàn tất
  const pendingDeliveries = db
    .prepare(
      `SELECT COUNT(*) AS c FROM delivery_records
        WHERE customer_id = ? AND status IN ('PENDING', 'IN_PROGRESS')`
    )
    .get(id);

  // Đơn bán chưa giao (chưa có delivery_record)
  const pendingSales = db
    .prepare(
      `SELECT COUNT(*) AS c FROM sales
        WHERE customer_id = ? AND type = 'sale' AND archived = 0
          AND date >= date('now', '-30 day')`
    )
    .get(id);

  const lastSale = db
    .prepare(
      `SELECT id, date, total FROM sales
        WHERE customer_id = ? AND type = 'sale' AND archived = 0
        ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get(id);

  const deposit = roundMoney(customer.deposit || 0);
  const goodsMax = roundMoney(debtBalance > 0 ? debtBalance : 0);
  const allProducts = getCustomerProductPrices(id);
  const kegProducts = allProducts.filter((p) => p.type === 'keg');
  const goodsProducts = allProducts.filter((p) => p.type !== 'keg');

  return {
    success: true,
    preview: {
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        deposit,
        kegBalance: toInt(customer.keg_balance),
        archived: !!customer.archived,
      },
      debt: {
        balance: debtBalance,
        mirror: roundMoney(customer.debt || 0),
        note:
          debtBalance < 0
            ? 'Khách đang NỢ LẠI hệ thống (đã trả dư)'
            : debtBalance > 0
              ? 'Khách đang nợ hệ thống'
              : 'Không có công nợ',
      },
      kegs,
      products: allProducts,
      kegProducts,
      goodsProducts,
      pendingDeliveries: pendingDeliveries?.c || 0,
      pendingSales: pendingSales?.c || 0,
      lastSale: lastSale || null,
      // Gợi ý mặc định
      defaults: {
        kegsEmpty: toInt(customer.keg_balance),
        kegsFull: 0,
        kegsLost: 0,
        depositRefund: deposit,
        debtMode: DEBT_MODES.OFFSET,
        archive: true,
        maxGoodsRefund: goodsMax,
      },
    },
  };
}

// ── CLOSE ────────────────────────────────────────────────────────────────────

/**
 * Chốt khách ngừng bán (atomic).
 *
 * @param {number} customerId
 * @param {object} payload
 *   - kegsEmpty        {number}  số vỏ rỗng thu hồi về kho chờ nạp
 *   - kegsFull         {number}  số vỏ còn đầy bia → về kho đầy (hoàn tiền)
 *   - kegsLost         {number}  số vỏ mất
 *   - items            {Array}   [{productId, quantity, unitPrice?}] hàng tồn ở quán
 *   - depositRefund    {number}  tiền cọc hoàn lại (0..deposit)
 *   - debtMode         {string}  'offset' | 'writeoff' | 'keep'
 *   - archive          {boolean} lưu trữ khách hay không
 *   - note             {string}  ghi chú
 * @param {object} req  express request (để ghi actor)
 * @returns {{success:boolean, error?:string, result?:object}}
 */
function close(customerId, payload = {}, req = null) {
  const customer = getCustomer(customerId);
  if (!customer) return { success: false, error: 'Không tìm thấy khách hàng' };
  if (customer.archived) {
    return { success: false, error: 'Khách hàng đã được lưu trữ trước đó' };
  }

  const id = customer.id;
  const actor = (req && req.user && req.user.username) || null;

  // ── Chuẩn hoá input ───────────────────────────────────────────────────────
  const kegBalance = toInt(customer.keg_balance);
  const kegsEmpty = Math.max(0, toInt(payload.kegsEmpty));
  const kegsFull = Math.max(0, toInt(payload.kegsFull));
  const kegsLost = Math.max(0, toInt(payload.kegsLost));

  const kegsTotal = kegsEmpty + kegsFull + kegsLost;
  if (kegsTotal > kegBalance) {
    return {
      success: false,
      error: `Tổng vỏ xử lý (${kegsTotal}) vượt quá số vỏ khách đang giữ (${kegBalance})`,
    };
  }

  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items = [];
  for (const it of rawItems) {
    const productId = toInt(it && it.productId);
    const quantity = toNum(it && it.quantity);
    if (!productId || !(quantity > 0)) continue;
    const product = db
      .prepare('SELECT id, name, type, slug FROM products WHERE id = ?')
      .get(productId);
    if (!product) continue;
    const unitPrice =
      it.unitPrice !== undefined && it.unitPrice !== null && it.unitPrice !== ''
        ? roundMoney(toNum(it.unitPrice))
        : getCustomerPrice(id, productId);
    items.push({
      productId,
      productName: product.name,
      productType: product.type,
      slug: product.slug,
      quantity,
      unitPrice,
      amount: roundMoney(quantity * unitPrice),
    });
  }

  const deposit = roundMoney(customer.deposit || 0);
  let depositRefund = Math.max(0, roundMoney(toNum(payload.depositRefund)));
  if (depositRefund > deposit) depositRefund = deposit;

  const debtMode = Object.values(DEBT_MODES).includes(payload.debtMode)
    ? payload.debtMode
    : DEBT_MODES.OFFSET;
  const shouldArchive = payload.archive === true || payload.archive === 'true' || payload.archive === 1;
  const note = payload.note ? String(payload.note).trim().slice(0, 500) : null;

  let totalGoodsAmount = roundMoney(items.reduce((s, i) => s + i.amount, 0));
  let totalRefund = roundMoney(totalGoodsAmount + depositRefund);
  const fullKegGoods = [];

  // ── Thực thi ──────────────────────────────────────────────────────────────
  const run = db.transaction(() => {
    const dateStr = db.getVietnamDateStr();
    const closureNo = nextClosureNo(dateStr);

    const statsBefore = getKegStats();
    const debtBefore = DebtLedgerService.computeBalance(id);

    // 1. Thu hồi hàng tồn ở quán → về kho + audit stock
    for (const item of items) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(
        item.quantity,
        item.productId
      );
      AuditService.logStock({
        productId: item.productId,
        type: 'restore',
        quantity: item.quantity,
        reason: 'customer_closure',
        refType: 'customer_closure',
        customerName: customer.name,
        note: `Thu hồi hàng khi chốt khách ${closureNo}`,
        req,
      });
    }
    if (items.length > 0) syncKegInventory();

    // 2. Thu hồi vỏ
    //    • vỏ rỗng → kho rỗng chờ nạp
    //    • vỏ đầy → kho đầy (products.stock của loại keg)
    //    • vỏ mất  → keg_stats.lost
    const newEmpty = KegBalanceService.peekEmptyCollected(kegsEmpty);
    if (kegsEmpty > 0) {
      db.prepare(
        'UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
      ).run(newEmpty);
    }
    if (kegsLost > 0) {
      db.prepare(
        'UPDATE keg_stats SET lost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
      ).run(statsBefore.lost + kegsLost);
    }
    if (kegsFull > 0) {
      // Vỏ còn đầy → trả về kho dưới dạng vỏ ĐẦY (products.stock của loại keg).
      // Cho phép chỉ định loại vỏ; mặc định lấy sản phẩm keg đầu tiên.
      const kegProduct = (() => {
        if (payload.kegProductId) {
          const p = db
            .prepare("SELECT id, name, sell_price FROM products WHERE id = ? AND type = 'keg'")
            .get(toInt(payload.kegProductId));
          if (p) return p;
        }
        return db
          .prepare("SELECT id, name, sell_price FROM products WHERE type = 'keg' AND archived = 0 ORDER BY id ASC LIMIT 1")
          .get();
      })();
      if (kegProduct) {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(
          kegsFull,
          kegProduct.id
        );
        AuditService.logStock({
          productId: kegProduct.id,
          type: 'restore',
          quantity: kegsFull,
          reason: 'customer_closure',
          refType: 'customer_closure',
          customerName: customer.name,
          note: `Thu hồi ${kegsFull} vỏ còn đầy khi chốt khách ${closureNo}`,
          req,
        });
        syncKegInventory();

        // Vỏ còn đầy = bia CHƯA BÁN → hoàn tiền theo giá của khách cho loại vỏ này
        const kegPrice = getCustomerPrice(id, kegProduct.id);
        if (kegPrice > 0) {
          const kegAmount = roundMoney(kegPrice * kegsFull);
          fullKegGoods.push({
            productId: kegProduct.id,
            productName: kegProduct.name,
            productType: 'keg',
            quantity: kegsFull,
            unitPrice: kegPrice,
            amount: kegAmount,
          });
        }
      }
    }

    // 2b. Vỏ còn đầy = bia chưa bán → gộp vào hàng hoàn tiền
    //     (danh sách items sẽ được ghi vào `customer_closure_items` ở bước 6)
    if (fullKegGoods.length > 0) {
      for (const g of fullKegGoods) items.push(g);
      totalGoodsAmount = roundMoney(items.reduce((s, i) => s + i.amount, 0));
      totalRefund = roundMoney(totalGoodsAmount + depositRefund);
    }

    // 3. Giảm keg_balance của khách + đồng bộ customer_holding
    if (kegsTotal > 0) {
      db.prepare(
        'UPDATE customers SET keg_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(Math.max(0, kegBalance - kegsTotal), id);
      syncCustomerHolding();
    }

    // 4. Hoàn cọc
    if (depositRefund > 0) {
      db.prepare(
        'UPDATE customers SET deposit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(roundMoney(deposit - depositRefund), id);
    }

    // 5. Chốt công nợ
    //    • offset   : tiền hoàn (hàng + cọc) cấn trừ nợ; dư → CREDIT
    //    • writeoff : xóa sạch nợ
    //    • keep     : giữ nguyên nợ
    let debtAfter = debtBefore;
    let cashRefund = 0;
    const debtTx = [];

    if (debtMode === DEBT_MODES.OFFSET && totalRefund > 0) {
      const applied = roundMoney(Math.min(totalRefund, Math.max(debtBefore, 0)));
      if (applied > 0) {
        const res = DebtLedgerService.recordTransaction({
          customerId: id,
          transactionType: TRANSACTION_TYPES.ADJUSTMENT,
          amount: applied,
          direction: DebtLedgerService.DIRECTION.DECREASE,
          referenceType: REFERENCE_TYPES.MANUAL,
          referenceId: closureNo,
          description: `Cấn trừ khi chốt khách (${applied.toLocaleString('vi-VN')}đ)`,
          createdBy: actor,
          source: SOURCES.MANUAL_UI,
          idempotencyKey: `closure:${closureNo}:offset`,
          allowNegativeBalance: true,
          keepNegativeBalance: true,
        });
        if (!res.success) throw new Error(res.error || 'Không ghi được bút toán cấn trừ');
        debtAfter = res.balanceAfter;
        debtTx.push({ type: 'offset', amount: applied, balanceAfter: res.balanceAfter });
      }
      // Phần tiền hoàn vượt quá nợ → khách NỢ LẠI hệ thống → ghi CREDIT
      const excess = roundMoney(totalRefund - applied);
      if (excess > 0) {
        const res = DebtLedgerService.recordTransaction({
          customerId: id,
          transactionType: TRANSACTION_TYPES.CREDIT,
          amount: excess,
          direction: DebtLedgerService.DIRECTION.DECREASE,
          referenceType: REFERENCE_TYPES.MANUAL,
          referenceId: closureNo,
          description: `Chốt khách — khách nợ lại hệ thống (${excess.toLocaleString('vi-VN')}đ)`,
          createdBy: actor,
          source: SOURCES.MANUAL_UI,
          idempotencyKey: `closure:${closureNo}:credit`,
          allowNegativeBalance: true,
          keepNegativeBalance: true,
        });
        if (!res.success) throw new Error(res.error || 'Không ghi được bút toán credit');
        debtAfter = res.balanceAfter;
        cashRefund = excess;
        debtTx.push({ type: 'credit', amount: excess, balanceAfter: res.balanceAfter });
      }
    } else if (debtMode === DEBT_MODES.WRITEOFF && debtBefore > 0) {
      const res = DebtLedgerService.recordTransaction({
        customerId: id,
        transactionType: TRANSACTION_TYPES.ADJUSTMENT,
        amount: roundMoney(debtBefore),
        direction: DebtLedgerService.DIRECTION.DECREASE,
        referenceType: REFERENCE_TYPES.MANUAL,
        referenceId: closureNo,
        description: `Xóa nợ khi chốt khách (${roundMoney(debtBefore).toLocaleString('vi-VN')}đ)`,
        createdBy: actor,
        source: SOURCES.MANUAL_UI,
        idempotencyKey: `closure:${closureNo}:writeoff`,
        allowNegativeBalance: true,
        keepNegativeBalance: true,
      });
      if (!res.success) throw new Error(res.error || 'Không ghi được bút toán xóa nợ');
      debtAfter = res.balanceAfter;
      debtTx.push({ type: 'writeoff', amount: roundMoney(debtBefore), balanceAfter: res.balanceAfter });
      // Tiền hoàn trả mặt cho khách (không cấn trừ vào nợ vì nợ đã xóa)
      cashRefund = totalRefund;
    } else if (debtMode === DEBT_MODES.KEEP) {
      debtAfter = debtBefore;
      cashRefund = totalRefund;
    }

    // 6. Ghi phiếu chốt
    const info = db
      .prepare(
        `INSERT INTO customer_closures
           (closure_no, customer_id, customer_name, closure_date,
            kegs_empty, kegs_full, kegs_lost,
            total_goods_amount, deposit_refund, total_refund,
            debt_before, debt_mode, debt_after, cash_refund,
            archived, note, actor_username)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        closureNo,
        id,
        customer.name || '',
        dateStr,
        kegsEmpty,
        kegsFull,
        kegsLost,
        totalGoodsAmount,
        depositRefund,
        totalRefund,
        debtBefore,
        debtMode,
        debtAfter,
        cashRefund,
        shouldArchive ? 1 : 0,
        note,
        actor
      );
    const closureId = info.lastInsertRowid;

    if (items.length > 0) {
      const insertItem = db.prepare(
        `INSERT INTO customer_closure_items
           (closure_id, product_id, product_name, product_type, quantity, unit_price, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of items) {
        insertItem.run(
          closureId,
          item.productId,
          item.productName,
          item.productType,
          item.quantity,
          item.unitPrice,
          item.amount
        );
      }
    }

    // 7. Đơn giao chưa hoàn tất → FAILED (khách đã ngừng bán)
    const pendingRows = db
      .prepare(
        `SELECT id, status FROM delivery_records
          WHERE customer_id = ? AND status IN ('PENDING', 'IN_PROGRESS')`
      )
      .all(id);
    for (const row of pendingRows) {
      db.prepare(
        `UPDATE delivery_records
            SET status = 'FAILED',
                completed_at = datetime('now'),
                failure_reason = COALESCE(failure_reason, 'Khách ngừng bán — đã chốt'),
                updated_at = datetime('now')
          WHERE id = ?`
      ).run(row.id);
      try {
        db.prepare(
          `INSERT INTO delivery_events
             (delivery_id, event_type, from_status, to_status, actor_username, payload, note)
           VALUES (?, 'CLOSED_CUSTOMER', ?, 'FAILED', ?, ?, ?)`
        ).run(
          row.id,
          row.status,
          actor,
          JSON.stringify({ closureNo, reason: 'customer_closure' }),
          'Chốt khách ngừng bán — huỷ đơn giao'
        );
      } catch (_) {
        /* log event best-effort */
      }
    }

    // 8. Lưu trữ khách (nếu được chọn)
    if (shouldArchive) {
      db.prepare(
        'UPDATE customers SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(id);
      try {
        DebtAccountService.setStatus(id, ACCOUNT_STATUS.CLOSED, actor);
      } catch (_) {
        /* best-effort */
      }
    }

    // 9. Audit log vỏ
    const statsAfter = getKegStats();
    if (kegsEmpty > 0) {
      AuditService.logKeg({
        type: 'collect',
        quantity: kegsEmpty,
        customerId: id,
        customerName: customer.name || '',
        inventoryAfter: statsAfter.inventory,
        emptyAfter: statsAfter.emptyCollected,
        holdingAfter: statsAfter.customerHolding,
        lostAfter: statsAfter.lost,
        note: `Thu hồi vỏ rỗng khi chốt khách ${closureNo}`,
        req,
      });
    }
    if (kegsFull > 0) {
      AuditService.logKeg({
        type: 'collect',
        quantity: kegsFull,
        customerId: id,
        customerName: customer.name || '',
        inventoryAfter: statsAfter.inventory,
        emptyAfter: statsAfter.emptyCollected,
        holdingAfter: statsAfter.customerHolding,
        lostAfter: statsAfter.lost,
        note: `Thu hồi ${kegsFull} vỏ còn đầy khi chốt khách ${closureNo}`,
        req,
      });
    }
    if (kegsLost > 0) {
      AuditService.logKeg({
        type: 'lost',
        quantity: kegsLost,
        customerId: id,
        customerName: customer.name || '',
        inventoryAfter: statsAfter.inventory,
        emptyAfter: statsAfter.emptyCollected,
        holdingAfter: statsAfter.customerHolding,
        lostAfter: statsAfter.lost,
        note: `Vỏ mất khi chốt khách ${closureNo}`,
        req,
      });
    }

    return {
      closureId,
      closureNo,
      kegsEmpty,
      kegsFull,
      kegsLost,
      totalGoodsAmount,
      depositRefund,
      totalRefund,
      debtBefore,
      debtMode,
      debtAfter,
      cashRefund,
      archived: shouldArchive,
      cancelledDeliveries: pendingRows.length,
      debtTransactions: debtTx,
    };
  });

  let result;
  try {
    result = run();
  } catch (err) {
    logger.error('[CUSTOMER_CLOSURE] close error', {
      customerId: id,
      error: err.message,
      stack: err.stack,
    });
    return { success: false, error: 'Lỗi khi chốt khách: ' + err.message };
  }

  logger.info('[CUSTOMER_CLOSURE] Closed customer', {
    customerId: id,
    closureNo: result.closureNo,
    kegsEmpty: result.kegsEmpty,
    kegsFull: result.kegsFull,
    kegsLost: result.kegsLost,
    totalRefund: result.totalRefund,
    debtBefore: result.debtBefore,
    debtAfter: result.debtAfter,
    archived: result.archived,
  });

  return { success: true, result };
}

/** Lịch sử phiếu chốt của 1 khách. */
function listClosures(customerId, limit = 20) {
  const id = parseInt(customerId, 10);
  if (!id) return { success: false, error: 'ID khách hàng không hợp lệ' };

  const closures = db
    .prepare(
      `SELECT * FROM customer_closures
        WHERE customer_id = ?
        ORDER BY id DESC LIMIT ?`
    )
    .all(id, Math.min(100, Math.max(1, toInt(limit, 20))));

  const itemStmt = db.prepare(
    'SELECT * FROM customer_closure_items WHERE closure_id = ? ORDER BY id ASC'
  );
  const withItems = closures.map((c) => ({
    ...c,
    items: itemStmt.all(c.id),
  }));

  return { success: true, closures: withItems };
}

module.exports = {
  DEBT_MODES,
  preview,
  close,
  listClosures,
  // helper nội bộ (test)
  _getCustomerPrice: getCustomerPrice,
  _getCustomerProductPrices: getCustomerProductPrices,
  _nextClosureNo: nextClosureNo,
};
