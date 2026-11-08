/**
 * Driver Keg Receipt Service — Phiếu thu vỏ rỗng
 * ─────────────────────────────────────────────────────────────────────────────
 * Nghiệp vụ: Tài xế lập PHIẾU THU VỎ khi thu vỏ rỗng ngoài chuyến giao
 * (không giao hàng). Phiếu dùng làm căn cứ BÁO CÁO với khách hàng.
 *
 * Quy tắc cập nhật số liệu (KHỚP với luồng phiếu giao hiện có):
 *   • Thu N vỏ từ khách → `customers.keg_balance`        TRỪ N
 *   •                        `keg_stats.empty_collected` CỘNG N  (vỏ rỗng về kho chờ nạp)
 *   • `products.stock` (vỏ đầy trong kho)                KHÔNG đổi
 *
 * Ngoài ra ghi log vào `keg_transactions_log` (type='collect') để màn
 * "Quản lý vỏ" của Admin thấy đầy đủ giao dịch.
 */

const db = require('../../database');
const logger = require('../../src/utils/logger');
const socketServer = require('../../src/socket/socketServer');
const { updateCustomerKegBalance } = require('../../routes/api/payments');

const KegReceiptService = {
  /**
   * Sinh số phiếu dạng PT-YYYYMMDD-XXXX (XXXX = 4 số tuần tự trong ngày).
   */
  nextReceiptNo(dateStr) {
    const ymd = String(dateStr || '').replace(/-/g, '') || '00000000';
    const prefix = `PT-${ymd}-`;
    const row = db
      .prepare(
        `SELECT receipt_no FROM driver_keg_receipts
         WHERE receipt_no LIKE ? ORDER BY id DESC LIMIT 1`
      )
      .get(prefix + '%');
    let next = 1;
    if (row && row.receipt_no) {
      const tail = parseInt(String(row.receipt_no).slice(prefix.length), 10);
      if (!isNaN(tail)) next = tail + 1;
    }
    return prefix + String(next).padStart(4, '0');
  },

  /**
   * Tạo phiếu thu vỏ.
   *
   * @param {object} opts
   * @param {number} opts.customerId   id khách (BẮT BUỘC)
   * @param {number} opts.kegs         số vỏ thu (>= 1)
   * @param {string} opts.note         ghi chú (tuỳ chọn)
   * @param {string} opts.driverUsername tài xế đang đăng nhập
   * @returns {{success: boolean, error?: string, receipt?: object}}
   */
  createReceipt(opts) {
    const customerId = parseInt(opts.customerId);
    const kegs = parseInt(opts.kegs);
    const driverUsername = opts.driverUsername;
    const note = opts.note ? String(opts.note).trim() : '';

    if (!customerId || isNaN(customerId)) {
      return { success: false, error: 'Thiếu khách hàng' };
    }
    if (isNaN(kegs) || kegs < 1) {
      return { success: false, error: 'Số vỏ phải lớn hơn 0' };
    }
    if (!driverUsername) {
      return { success: false, error: 'Thiếu thông tin tài xế' };
    }

    const customer = db
      .prepare('SELECT id, name, keg_balance FROM customers WHERE id = ? AND archived = 0 AND deleted = 0')
      .get(customerId);
    if (!customer) {
      return { success: false, error: 'Không tìm thấy khách hàng' };
    }

    const balanceBefore = customer.keg_balance || 0;
    if (balanceBefore < kegs) {
      return {
        success: false,
        error: `Khách chỉ đang giữ ${balanceBefore} vỏ, không thể thu ${kegs} vỏ`,
      };
    }

    const dateStr = db.getVietnamDateStr();
    const receiptNo = KegReceiptService.nextReceiptNo(dateStr);
    const balanceAfter = balanceBefore - kegs;

    const run = db.transaction(() => {
      // 1. Trừ vỏ khách đang giữ + sync keg_stats.customer_holding
      updateCustomerKegBalance(customerId, 0, kegs);

      // 2. Cộng vỏ rỗng về kho chờ nạp lại
      const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
      const currentEmpty = stats?.empty_collected || 0;
      const newEmpty = currentEmpty + kegs;
      db.prepare(
        "UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1"
      ).run(newEmpty);

      // 3. Lưu phiếu
      const info = db
        .prepare(
          `INSERT INTO driver_keg_receipts
             (receipt_no, customer_id, customer_name, driver_username, kegs,
              balance_before, balance_after, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 hours'), datetime('now', '+7 hours'))`
        )
        .run(
          receiptNo,
          customerId,
          customer.name || '',
          driverUsername,
          kegs,
          balanceBefore,
          balanceAfter,
          note || null
        );
      const receiptId = info.lastInsertRowid;

      // 4. Ghi log giao dịch vỏ (màn Quản lý vỏ của Admin)
      const after = db
        .prepare('SELECT inventory, empty_collected, customer_holding FROM keg_stats WHERE id = 1')
        .get();
      db.prepare(
        `INSERT INTO keg_transactions_log
           (type, quantity, customer_id, customer_name, inventory_after, empty_after, holding_after, note)
         VALUES ('collect', ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        kegs,
        customerId,
        customer.name || '',
        after?.inventory || 0,
        after?.empty_collected || 0,
        after?.customer_holding || 0,
        `Phiếu thu vỏ ${receiptNo} — tài xế ${driverUsername}`
      );

      return receiptId;
    });

    let receiptId;
    try {
      receiptId = run();
    } catch (err) {
      logger.error('[KegReceipt] create error', { error: err.message });
      return { success: false, error: 'Lỗi khi tạo phiếu: ' + err.message };
    }

    const receipt = KegReceiptService.getReceipt(receiptId, driverUsername);
    if (!receipt) {
      return { success: false, error: 'Không đọc được phiếu vừa tạo' };
    }

    // Đẩy số liệu vỏ mới cho Admin đang mở màn Quản lý vỏ
    try {
      const state = {
        inventory: db.prepare(db.SQL_KEG_WAREHOUSE_POSITIVE_STOCK).get().total,
        emptyCollected: db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get().empty_collected,
        customerHolding: db.prepare('SELECT COALESCE(SUM(keg_balance), 0) AS t FROM customers').get().t,
      };
      socketServer.emitKegUpdated(state);
      socketServer.emitCustomerUpdated({ id: customerId });
    } catch (e) {
      logger.error('[KegReceipt] socket error', { error: e.message });
    }

    return { success: true, receipt };
  },

  /**
   * Lấy 1 phiếu theo id (giới hạn theo tài xế nếu có driverUsername).
   */
  getReceipt(id, driverUsername) {
    let sql = `SELECT * FROM driver_keg_receipts WHERE id = ?`;
    const params = [id];
    if (driverUsername) {
      sql += ` AND driver_username = ?`;
      params.push(driverUsername);
    }
    const row = db.prepare(sql).get(...params);
    if (!row) return null;
    return KegReceiptService.decorate(row);
  },

  /**
   * Danh sách phiếu thu vỏ của tài xế (mới nhất trước).
   */
  listReceipts(driverUsername, limit = 30) {
    const rows = db
      .prepare(
        `SELECT * FROM driver_keg_receipts
         WHERE driver_username = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(driverUsername, Math.min(100, Math.max(1, limit)));
    return rows.map(KegReceiptService.decorate);
  },

  /**
   * Gắn tên khách + định dạng số liệu cho phiếu.
   */
  decorate(row) {
    const customer = row.customer_id
      ? db.prepare('SELECT name, phone, address FROM customers WHERE id = ?').get(row.customer_id)
      : null;
    return {
      id: row.id,
      receipt_no: row.receipt_no,
      customer_id: row.customer_id,
      customer_name: row.customer_name || customer?.name || '',
      customer_phone: customer?.phone || '',
      customer_address: customer?.address || '',
      driver_username: row.driver_username,
      kegs: row.kegs,
      balance_before: row.balance_before,
      balance_after: row.balance_after,
      note: row.note || '',
      created_at: row.created_at,
    };
  },
};

module.exports = KegReceiptService;
