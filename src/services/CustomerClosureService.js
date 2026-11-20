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
 *      → VỎ ĐẦY có thể thu hồi NHIỀU LOẠI (vàng/đen/...) → `fullKegs: [{productId, quantity}]`.
 *
 *   2. THU HỒI THIẾT BỊ (tủ lạnh) đang đặt ở quán:
 *      → ghi vào phiếu `customer_closure_devices`
 *      → trả về kho: `devices.status = 'available'`, `customer_id = NULL`
 *      → `customers.horizontal_fridge` / `vertical_fridge` về 0.
 *
 *   2. THU HỒI HÀNG TỒN Ở QUÁN: bia/chai/hộp còn nằm ở quán (chưa bán hết).
 *      → về kho (`products.stock += qty`) + HOÀN TIỀN theo giá của khách.
 *
 *   3. HOÀN CỌC: `customers.deposit` → trả lại một phần hoặc toàn bộ.
 *
 *   4. CHỐT CÔNG NỢ: số dư sổ công nợ của khách được xử lý theo 1 trong 3 chế độ:
 *        • `offset`   : dùng tiền hoàn (hàng + cọc) để CẤN TRỪ nợ khách.
 *                       Nếu tiền hoàn > nợ → phần DƯ được TRẢ MẶT cho khách
 *                       (số dư công nợ về 0, KHÔNG ghi khách nợ lại hệ thống).
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
      `SELECT id, name, phone, address, deposit, keg_balance, debt, archived, note,
              horizontal_fridge, vertical_fridge
         FROM customers WHERE id = ?`
    )
    .get(id);
}

/**
 * Thiết bị (tủ lạnh) của khách + các tủ CÒN THIẾU bản ghi.
 *
 * Dữ liệu cũ chỉ lưu SỐ ĐẾM ở `customers.horizontal_fridge` /
 * `vertical_fridge` mà không tạo dòng tương ứng trong bảng `devices`.
 * → Số tủ trong UI có thể NHIỀU hơn số dòng thật trong `devices`.
 *
 * Hàm này trả về:
 *   - `devices`      : các dòng thật đang gán cho khách (thu hồi được).
 *   - `missingCount` : số tủ còn thiếu bản ghi (tự tạo khi chốt).
 *   - `missingType`  : loại tủ còn thiếu ('horizontal' | 'vertical').
 */
function getCustomerDevices(customerId) {
  const id = parseInt(customerId, 10);
  if (!id) return { devices: [], missingCount: 0, missingType: null };

  const devices = db
    .prepare(
      `SELECT id, name, type, serial_number, status, assigned_date
         FROM devices
        WHERE customer_id = ? AND deleted = 0
        ORDER BY id ASC`
    )
    .all(id);

  const customer = getCustomer(id);
  if (!customer) return { devices, missingCount: 0, missingType: null };

  const actualH = devices.filter((d) => d.type === 'horizontal').length;
  const actualV = devices.filter((d) => d.type === 'vertical').length;

  const declaredH = toInt(customer.horizontal_fridge);
  const declaredV = toInt(customer.vertical_fridge);

  const missingH = Math.max(0, declaredH - actualH);
  const missingV = Math.max(0, declaredV - actualV);

  // Ưu tiên tủ nằm trước (nếu cả hai đều thiếu → báo cáo chung).
  let missingCount = 0;
  let missingType = null;
  if (missingH > 0) {
    missingCount = missingH;
    missingType = 'horizontal';
  } else if (missingV > 0) {
    missingCount = missingV;
    missingType = 'vertical';
  }

  return { devices, missingCount, missingType };
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

  // Thiết bị (tủ lạnh) đang đặt ở quán → sẽ thu hồi về kho
  const devInfo = getCustomerDevices(id);
  const devices = devInfo.devices;

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
        horizontalFridge: toInt(customer.horizontal_fridge),
        verticalFridge: toInt(customer.vertical_fridge),
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
      devices,
      missingDevices: {
        count: devInfo.missingCount,
        type: devInfo.missingType,
        typeLabel:
          devInfo.missingType === 'horizontal'
            ? 'Tủ nằm'
            : devInfo.missingType === 'vertical'
              ? 'Tủ đứng'
              : '',
      },
      pendingDeliveries: pendingDeliveries?.c || 0,
      pendingSales: pendingSales?.c || 0,
      lastSale: lastSale || null,
      // Gợi ý mặc định
      defaults: {
        kegsEmpty: toInt(customer.keg_balance),
        kegsFull: 0,
        kegsLost: 0,
        fullKegs: [],
        deviceIds: devices.map((d) => d.id),
        includeMissingDevices: devInfo.missingCount > 0,
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
 *   - fullKegs         {Array}   [{productId, quantity}] vỏ ĐẦY theo từng loại
 *                                   (vàng/đen/...) — dùng khi khách giữ nhiều loại
 *   - items            {Array}   [{productId, quantity, unitPrice?}] hàng tồn ở quán
 *   - deviceIds        {Array}   [id] thiết bị (tủ lạnh) cần thu hồi về kho
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
  const kegsLost = Math.max(0, toInt(payload.kegsLost));

  // HÀNG CÒN ĐẦY: hỗ trợ NHIỀU LOẠI (vàng/đen/chai/lon/...) qua `fullKegs`.
  // Nếu không có `fullKegs` → dùng `kegsFull` + `kegProductId` (cách cũ, 1 loại).
  const rawFullKegs = Array.isArray(payload.fullKegs) ? payload.fullKegs : [];
  const fullKegs = [];
  for (const fk of rawFullKegs) {
    const productId = toInt(fk && fk.productId);
    const quantity = Math.max(0, toInt(fk && fk.quantity));
    if (!productId || !(quantity > 0)) continue;
    // Nhận MỌI loại sản phẩm đang kinh doanh (keg, pet, lon, hộp…) —
    // khách còn bia trong vỏ VÀ hàng khác (chai/lon) đều khai ở đây.
    const product = db
      .prepare('SELECT id, name, type FROM products WHERE id = ? AND archived = 0')
      .get(productId);
    if (!product) continue;
    fullKegs.push({
      productId: product.id,
      productName: product.name,
      productType: product.type,
      quantity,
    });
  }

  // Gộp trùng loại (nếu UI gửi trùng) — cộng dồn số lượng.
  const mergedFullKegs = [];
  const byProduct = new Map();
  for (const fk of fullKegs) {
    const prev = byProduct.get(fk.productId);
    if (prev) {
      prev.quantity += fk.quantity;
    } else {
      const copy = { ...fk };
      byProduct.set(fk.productId, copy);
      mergedFullKegs.push(copy);
    }
  }

  // Tách 2 nhóm:
  //   • `kegTypeList` : sản phẩm loại KEG (bia bình) → tính vào số vỏ khách giữ,
  //                     trả về kho dưới dạng vỏ ĐẦY.
  //   • `otherTypeList`: hàng khác (chai/lon/hộp) → chỉ là hàng tồn ở quán,
  //                     KHÔNG tính vào số vỏ.
  const kegTypeList = mergedFullKegs.filter((fk) => fk.productType === 'keg');
  const otherTypeList = mergedFullKegs.filter((fk) => fk.productType !== 'keg');

  let kegsFull = 0;
  if (kegTypeList.length > 0) {
    kegsFull = kegTypeList.reduce((s, fk) => s + fk.quantity, 0);
  } else if (otherTypeList.length === 0) {
    kegsFull = Math.max(0, toInt(payload.kegsFull));
  }

  const kegsTotal = kegsEmpty + kegsFull + kegsLost;
  if (kegsTotal > kegBalance) {
    return {
      success: false,
      error: `Tổng vỏ xử lý (${kegsTotal}) vượt quá số vỏ khách đang giữ (${kegBalance})`,
    };
  }

  // Thiết bị (tủ lạnh) cần thu hồi — chỉ nhận thiết bị ĐANG gán cho khách này.
  const deviceIds = Array.isArray(payload.deviceIds)
    ? [...new Set(payload.deviceIds.map((v) => toInt(v)).filter((v) => v > 0))]
    : [];
  const devices = deviceIds.length
    ? db
        .prepare(
          `SELECT id, name, type, serial_number FROM devices
            WHERE customer_id = ? AND deleted = 0 AND id IN (${deviceIds.map(() => '?').join(',')})`
        )
        .all(id, ...deviceIds)
    : [];
  if (devices.length !== deviceIds.length) {
    return {
      success: false,
      error: 'Có thiết bị không thuộc khách hàng này hoặc đã bị xoá — vui lòng tải lại trang.',
    };
  }

  // Tủ CÒN THIẾU bản ghi (dữ liệu cũ chỉ lưu số đếm ở customers.*_fridge).
  // Nếu người dùng tick "thu hồi cả tủ chưa có bản ghi" → tự tạo bản ghi thiết bị
  // (gán cho khách) rồi thu hồi như bình thường → kho luôn nhất quán.
  const devInfo = getCustomerDevices(id);
  const includeMissing =
    payload.includeMissingDevices === true ||
    payload.includeMissingDevices === 'true' ||
    payload.includeMissingDevices === 1;
  const missingDevicesToCreate =
    includeMissing && devInfo.missingCount > 0
      ? Array.from({ length: devInfo.missingCount }, () => ({
          type: devInfo.missingType,
        }))
      : [];

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
    if (kegsFull > 0 || otherTypeList.length > 0) {
      // Vỏ còn đầy → trả về kho dưới dạng vỏ ĐẦY (products.stock của loại keg).
      // Hỗ trợ NHIỀU LOẠI: `kegTypeList` (vàng/đen/...). Nếu rỗng → fallback 1 loại.
      const kegList =
        kegTypeList.length > 0
          ? kegTypeList
          : (() => {
              const p = payload.kegProductId
                ? db
                    .prepare(
                      "SELECT id, name, sell_price FROM products WHERE id = ? AND type = 'keg'"
                    )
                    .get(toInt(payload.kegProductId))
                : db
                    .prepare(
                      "SELECT id, name, sell_price FROM products WHERE type = 'keg' AND archived = 0 ORDER BY id ASC LIMIT 1"
                    )
                    .get();
              return p
                ? [{ productId: p.id, productName: p.name, productType: 'keg', quantity: kegsFull }]
                : [];
            })();

      for (const keg of kegList) {
        const qty = Math.max(0, toInt(keg.quantity));
        if (!qty) continue;

        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, keg.productId);
        AuditService.logStock({
          productId: keg.productId,
          type: 'restore',
          quantity: qty,
          reason: 'customer_closure',
          refType: 'customer_closure',
          customerName: customer.name,
          note: `Thu hồi ${qty} vỏ còn đầy (${keg.productName || ''}) khi chốt khách ${closureNo}`.trim(),
          req,
        });

        // Vỏ còn đầy = bia CHƯA BÁN → hoàn tiền theo giá của khách cho loại vỏ này
        const kegPrice = getCustomerPrice(id, keg.productId);
        if (kegPrice > 0) {
          fullKegGoods.push({
            productId: keg.productId,
            productName: keg.productName,
            productType: 'keg',
            quantity: qty,
            unitPrice: kegPrice,
            amount: roundMoney(kegPrice * qty),
          });
        }
      }
      if (kegList.length > 0) syncKegInventory();

      // HÀNG KHÁC (chai/lon/hộp) còn ở quán → về kho + hoàn tiền theo giá khách.
      for (const it of otherTypeList) {
        const qty = Math.max(0, toInt(it.quantity));
        if (!qty) continue;
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, it.productId);
        AuditService.logStock({
          productId: it.productId,
          type: 'restore',
          quantity: qty,
          reason: 'customer_closure',
          refType: 'customer_closure',
          customerName: customer.name,
          note: `Thu hồi ${qty} ${it.productName || ''} khi chốt khách ${closureNo}`.trim(),
          req,
        });
        const price = getCustomerPrice(id, it.productId);
        if (price > 0) {
          fullKegGoods.push({
            productId: it.productId,
            productName: it.productName,
            productType: it.productType || 'pet',
            quantity: qty,
            unitPrice: price,
            amount: roundMoney(price * qty),
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
      // Phần tiền hoàn VƯỢT nợ → TRẢ MẶT cho khách, số dư công nợ về 0.
      //   • Không ghi CREDIT (khách không nợ lại hệ thống).
      //   • Tiền mặt thực trả = totalRefund - nợ đã cấn trừ.
      const excess = roundMoney(totalRefund - applied);
      if (excess > 0) {
        cashRefund = excess;
        debtTx.push({ type: 'cash', amount: excess, balanceAfter: debtAfter });
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

    // 6. Tạo bản ghi cho TỦ CÒN THIẾU (dữ liệu cũ chỉ lưu số đếm ở customers.*_fridge).
    //    Thiết bị mới được gán cho khách → sẽ thu hồi ở bước 6b.
    const devicesToReturn = [...devices];

    if (missingDevicesToCreate.length > 0) {
      const typeLabel = missingDevicesToCreate[0].type === 'horizontal' ? 'Tủ nằm' : 'Tủ đứng';
      const maxIdx = db
        .prepare(
          `SELECT COALESCE(MAX(CAST(REPLACE(name, 'Tủ nằm ', '') AS INTEGER)), 0) AS m
             FROM devices WHERE type = 'horizontal'`
        )
        .get()?.m || 0;
      const maxIdxV = db
        .prepare(
          `SELECT COALESCE(MAX(CAST(REPLACE(name, 'Tủ đứng ', '') AS INTEGER)), 0) AS m
             FROM devices WHERE type = 'vertical'`
        )
        .get()?.m || 0;

      for (let i = 0; i < missingDevicesToCreate.length; i++) {
        const type = missingDevicesToCreate[i].type;
        const seqNo = (type === 'horizontal' ? maxIdx : maxIdxV) + i + 1;
        const devName = `${typeLabel} ${seqNo}`;
        const infoDev = db
          .prepare(
            `INSERT INTO devices (name, type, status, customer_id, assigned_date, created_at, updated_at, deleted)
             VALUES (?, ?, 'in_use', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)`
          )
          .run(devName, type, id);
        devicesToReturn.push({
          id: infoDev.lastInsertRowid,
          name: devName,
          type,
          serial_number: null,
          isNew: true,
        });
      }
    }

    // 6b. Ghi phiếu chốt
    const info = db
      .prepare(
        `INSERT INTO customer_closures
           (closure_no, customer_id, customer_name, closure_date,
            kegs_empty, kegs_full, kegs_lost,
            total_goods_amount, deposit_refund, total_refund,
            debt_before, debt_mode, debt_after, cash_refund,
            devices_returned, archived, note, actor_username)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        devicesToReturn.length,
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

    // 6c. Thu hồi THIẾT BỊ (tủ lạnh) → trả về kho + ghi phiếu
    if (devicesToReturn.length > 0) {
      const insertDevice = db.prepare(
        `INSERT INTO customer_closure_devices
           (closure_id, device_id, device_name, device_type, serial_number, note)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const dev of devicesToReturn) {
        db.prepare(
          `UPDATE devices
              SET status = 'available',
                  customer_id = NULL,
                  assigned_date = NULL,
                  note = COALESCE(note, '') || ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`
        ).run(` | Thu hồi khi chốt khách ${closureNo}`, dev.id);

        insertDevice.run(
          closureId,
          dev.id,
          dev.name,
          dev.type,
          dev.serial_number,
          `Thu hồi khi chốt khách ${closureNo}`
        );
      }
      // Đồng bộ số tủ của khách về 0 (tính lại từ devices còn gán).
      const remainingH = db
        .prepare(
          "SELECT COUNT(*) AS c FROM devices WHERE customer_id = ? AND type = 'horizontal' AND status = 'in_use' AND deleted = 0"
        )
        .get(id).c;
      const remainingV = db
        .prepare(
          "SELECT COUNT(*) AS c FROM devices WHERE customer_id = ? AND type = 'vertical' AND status = 'in_use' AND deleted = 0"
        )
        .get(id).c;
      db.prepare(
        'UPDATE customers SET horizontal_fridge = ?, vertical_fridge = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(remainingH, remainingV, id);
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
      const detail =
        kegTypeList.length > 0
          ? kegTypeList.map((k) => `${k.quantity} ${k.productName}`).join(', ')
          : `${kegsFull} vỏ`;
      AuditService.logKeg({
        type: 'collect',
        quantity: kegsFull,
        customerId: id,
        customerName: customer.name || '',
        inventoryAfter: statsAfter.inventory,
        emptyAfter: statsAfter.emptyCollected,
        holdingAfter: statsAfter.customerHolding,
        lostAfter: statsAfter.lost,
        note: `Thu hồi vỏ còn đầy khi chốt khách ${closureNo} (${detail})`,
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
      fullKegs: mergedFullKegs,
      devicesReturned: devicesToReturn.length,
      devicesCreated: missingDevicesToCreate.length,
      devices: devicesToReturn.map((d) => ({ id: d.id, name: d.name, type: d.type })),
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
    fullKegs: result.fullKegs,
    devicesReturned: result.devicesReturned,
    devicesCreated: result.devicesCreated,
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
  const deviceStmt = db.prepare(
    'SELECT * FROM customer_closure_devices WHERE closure_id = ? ORDER BY id ASC'
  );
  const withItems = closures.map((c) => ({
    ...c,
    items: itemStmt.all(c.id),
    devices: deviceStmt.all(c.id),
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
  _getCustomerDevices: getCustomerDevices,
  _nextClosureNo: nextClosureNo,
};
