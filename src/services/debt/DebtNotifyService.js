/**
 * DebtNotifyService — Gửi tin nhắn thông báo công nợ tới nhóm Zalo của khách
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu:
 *  Khi sổ công nợ GHI NHẬN TIỀN khách trả (qua Sepay hoặc ghi tay), hệ thống
 *  tự gửi tin nhắn vào nhóm Zalo cá nhân của khách (qua OmiCall multi-channel)
 *  để thông báo: đã nhận bao nhiêu, còn nợ bao nhiêu.
 *
 * Nguyên tắc (bất di bất dịch):
 *  1. **KHÔNG BAO GIỜ** chặn/lỗi nghiệp vụ ghi sổ công nợ. Mọi lỗi HTTP được
 *     nuốt và ghi log `debt_notifications` với status = 'failed'.
 *  2. **BẤT ĐỒNG BỘ** — gọi qua `.catch()` / `setImmediate`, không `await`
 *     trong luồng ghi bút toán (tránh chậm/nghẽn khi OmiCall timeout).
 *  3. Idempotent theo `transaction_id` + `event_type` → không gửi trùng khi
 *     webhook retry (Sepay giữ nguyên id qua các lần retry).
 *
 *  Nhóm Zalo của khách lấy từ bảng `debt_customer_groups`
 *  (platform = 'zalo_personal', status = 'active').
 */

const db = require('../../../database');
const logger = require('../../utils/logger');
const OmiCallService = require('../OmiCallService');
const { PLATFORMS } = require('./constants');

// ── Hằng số ──────────────────────────────────────────────────────────────────

const CHANNEL = 'omicall_zalo_personal';

const EVENT_TYPES = {
  PAYMENT: 'payment', // Nhận tiền (Sepay / ghi tay / lệnh `+`)
  MANUAL_DEBT: 'manual_debt', // Ghi nợ tay (lệnh `-`)
};

const STATUS = {
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function fmtMoney(n) {
  const v = roundMoney(n);
  return new Intl.NumberFormat('vi-VN').format(v) + 'đ';
}

/** Lấy customer name từ DB (fallback 'Khách hàng'). */
function getCustomerName(customerId, fallback) {
  if (fallback) return fallback;
  try {
    const row = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
    return row && row.name ? row.name : 'Khách hàng';
  } catch (_) {
    return 'Khách hàng';
  }
}

/**
 * Tìm convId (conversation ID OmiCall) của nhóm Zalo đang active của khách.
 * @returns {string|null}
 */
function findConvId(customerId) {
  try {
    const row = db
      .prepare(
        `SELECT group_id FROM debt_customer_groups
          WHERE customer_id = ? AND platform = ? AND status = 'active'
          ORDER BY id DESC LIMIT 1`
      )
      .get(customerId, PLATFORMS.ZALO_PERSONAL);
    return row && row.group_id ? String(row.group_id) : null;
  } catch (e) {
    logger.error('[DEBT_NOTIFY] findConvId error', { error: e.message });
    return null;
  }
}

/** Ghi 1 dòng nhật ký thông báo. */
function writeLog(entry = {}) {
  try {
    const info = db
      .prepare(
        `INSERT INTO debt_notifications
           (customer_id, customer_name, channel, group_id, event_type,
            amount, applied_amount, credit_amount, balance_before, balance_after,
            content, status, error, source, transaction_id, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.customerId ?? null,
        entry.customerName ?? null,
        entry.channel || CHANNEL,
        entry.groupId ?? null,
        entry.eventType || EVENT_TYPES.PAYMENT,
        entry.amount ?? 0,
        entry.appliedAmount ?? 0,
        entry.creditAmount ?? 0,
        entry.balanceBefore ?? 0,
        entry.balanceAfter ?? 0,
        entry.content ?? null,
        entry.status || STATUS.SKIPPED,
        entry.error ?? null,
        entry.source ?? null,
        entry.transactionId ?? null,
        entry.status === STATUS.SENT ? new Date().toISOString() : null
      );
    return info.lastInsertRowid;
  } catch (e) {
    logger.error('[DEBT_NOTIFY] writeLog error', { error: e.message });
    return null;
  }
}

/** Đã gửi cho bút toán này chưa? (chống gửi trùng khi webhook retry). */
function alreadyNotified(transactionId, eventType) {
  if (!transactionId) return false;
  try {
    const row = db
      .prepare(
        `SELECT id FROM debt_notifications
          WHERE transaction_id = ? AND event_type = ? AND status = ?
          LIMIT 1`
      )
      .get(transactionId, eventType, STATUS.SENT);
    return !!row;
  } catch (_) {
    return false;
  }
}

// ── Dựng nội dung tin nhắn ──────────────────────────────────────────────────

/**
 * Dựng nội dung tin nhắn thông báo công nợ.
 *
 * @param {object} opts
 * @param {string} opts.customerName
 * @param {number} opts.amount      - số tiền khách vừa trả
 * @param {number} opts.balanceBefore - số dư nợ trước khi trả
 * @param {number} opts.balanceAfter  - số dư nợ sau khi trả
 * @param {number} [opts.credit]    - phần tiền khách đã trả dư
 * @param {string} [opts.source]    - nguồn (SEPAY / MANUAL_UI / COMMAND)
 * @param {string} [opts.title]
 * @returns {string}
 */
function buildPaymentMessage(opts = {}) {
  const title = opts.title || 'BIA TƯƠI — Cập nhật công nợ';
  const name = opts.customerName || 'Khách hàng';
  const amount = roundMoney(opts.amount);
  const before = roundMoney(opts.balanceBefore);
  const after = roundMoney(opts.balanceAfter);
  const credit = roundMoney(opts.credit);

  const lines = [];
  lines.push(`🔔 ${title}`);
  lines.push(`Xin chào ${name},`);
  lines.push(`✅ Đã nhận: ${fmtMoney(amount)}`);

  if (credit > 0) {
    lines.push(`💰 Số dư công nợ trước: ${fmtMoney(before)}`);
    lines.push(`🎁 Tiền khách còn dư: ${fmtMoney(credit)}`);
    lines.push(`📌 Số dư hiện tại: ${fmtMoney(after)} (khách đang có dư)`);
  } else if (after > 0) {
    lines.push(`💰 Số dư công nợ trước: ${fmtMoney(before)}`);
    lines.push(`📌 Còn nợ: ${fmtMoney(after)}`);
  } else if (after < 0) {
    lines.push(`💰 Số dư công nợ trước: ${fmtMoney(before)}`);
    lines.push(`📌 Còn nợ: ${fmtMoney(after)} (khách đang có dư)`);
  } else {
    lines.push(`💰 Số dư công nợ trước: ${fmtMoney(before)}`);
    lines.push(`🎉 Đã trả hết công nợ. Số dư: 0đ`);
  }

  const now = new Date();
  const ts = `${now.toLocaleDateString('vi-VN')} ${now.toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
  lines.push(`🕐 ${ts} · Trân trọng cảm ơn quý khách!`);

  return lines.join('\n');
}

/**
 * Dựng nội dung cho bút toán NỢ (ghi nợ tay) — chỉ dùng khi bật tuỳ chọn.
 */
function buildDebtMessage(opts = {}) {
  const title = opts.title || 'BIA TƯƠI — Cập nhật công nợ';
  const name = opts.customerName || 'Khách hàng';
  const amount = roundMoney(opts.amount);
  const after = roundMoney(opts.balanceAfter);
  const lines = [];
  lines.push(`📝 ${title}`);
  lines.push(`Xin chào ${name},`);
  lines.push(`🧾 Đã ghi nhận công nợ thêm: ${fmtMoney(amount)}`);
  lines.push(`📌 Tổng công nợ hiện tại: ${fmtMoney(after)}`);
  const now = new Date();
  lines.push(
    `🕐 ${now.toLocaleDateString('vi-VN')} ${now.toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
    })}`
  );
  return lines.join('\n');
}

// ── Hàm chính ────────────────────────────────────────────────────────────────

/**
 * Gửi thông báo "đã nhận tiền" tới nhóm Zalo của khách.
 *
 * LUÔN trả về Promise đã resolve (không reject) — lỗi chỉ nằm trong log DB.
 *
 * @param {object} opts
 * @param {number} opts.customerId
 * @param {string} [opts.customerName]
 * @param {number} opts.amount
 * @param {number} opts.balanceBefore
 * @param {number} opts.balanceAfter
 * @param {number} [opts.credit]      - phần tiền dư
 * @param {number} [opts.applied]    - phần đã gạch nợ
 * @param {string} [opts.source]     - 'SEPAY' | 'MANUAL_UI' | 'COMMAND'
 * @param {number} [opts.transactionId]
 * @returns {Promise<{status:string, error?:string}>}
 */
async function notifyPayment(opts = {}) {
  const cfg = OmiCallService.getConfig();

  const customerId = parseInt(opts.customerId, 10);
  const customerName = getCustomerName(customerId, opts.customerName);
  const amount = roundMoney(opts.amount);
  const balanceBefore = roundMoney(opts.balanceBefore);
  const balanceAfter = roundMoney(opts.balanceAfter);
  const credit = roundMoney(opts.credit);
  const applied = roundMoney(opts.applied !== undefined ? opts.applied : amount - credit);
  const source = opts.source || null;
  const transactionId = opts.transactionId ?? null;

  // 1. Tắt → bỏ qua (không ghi log để tránh rác bảng)
  if (!cfg.enabled) {
    return { status: STATUS.SKIPPED, error: 'DISABLED' };
  }
  if (cfg.channel !== CHANNEL) {
    return { status: STATUS.SKIPPED, error: 'CHANNEL_MISMATCH' };
  }

  // 2. Chống gửi trùng (webhook retry)
  if (alreadyNotified(transactionId, EVENT_TYPES.PAYMENT)) {
    return { status: STATUS.SKIPPED, error: 'ALREADY_NOTIFIED' };
  }

  // 3. Tìm nhóm Zalo của khách
  const convId = findConvId(customerId);
  if (!convId) {
    writeLog({
      customerId,
      customerName,
      eventType: EVENT_TYPES.PAYMENT,
      amount,
      appliedAmount: applied,
      creditAmount: credit,
      balanceBefore,
      balanceAfter,
      status: STATUS.SKIPPED,
      error: 'Chưa liên kết nhóm Zalo cho khách này',
      source,
      transactionId,
    });
    return { status: STATUS.SKIPPED, error: 'NO_GROUP' };
  }

  const content = buildPaymentMessage({
    customerName,
    amount,
    balanceBefore,
    balanceAfter,
    credit,
    source,
    title: cfg.title,
  });

  // 4. Gửi
  const result = await OmiCallService.sendZaloPersonalMessage({ convId, text: content });

  if (result.success) {
    writeLog({
      customerId,
      customerName,
      groupId: convId,
      eventType: EVENT_TYPES.PAYMENT,
      amount,
      appliedAmount: applied,
      creditAmount: credit,
      balanceBefore,
      balanceAfter,
      content,
      status: STATUS.SENT,
      source,
      transactionId,
    });
    logger.info('[DEBT_NOTIFY] Sent payment notification', {
      customerId,
      amount,
      balanceAfter,
    });
    return { status: STATUS.SENT };
  }

  writeLog({
    customerId,
    customerName,
    groupId: convId,
    eventType: EVENT_TYPES.PAYMENT,
    amount,
    appliedAmount: applied,
    creditAmount: credit,
    balanceBefore,
    balanceAfter,
    content,
    status: STATUS.FAILED,
    error: result.error || 'Gửi thất bại',
    source,
    transactionId,
  });
  logger.error('[DEBT_NOTIFY] Send failed', { customerId, error: result.error });
  return { status: STATUS.FAILED, error: result.error };
}

/**
 * Gửi thông báo "ghi nợ tay" (tuỳ chọn, mặc định TẮT).
 * @param {object} opts (giống notifyPayment)
 */
async function notifyManualDebt(opts = {}) {
  const cfg = OmiCallService.getConfig();

  const customerId = parseInt(opts.customerId, 10);
  const customerName = getCustomerName(customerId, opts.customerName);
  const amount = roundMoney(opts.amount);
  const balanceAfter = roundMoney(opts.balanceAfter);
  const source = opts.source || null;
  const transactionId = opts.transactionId ?? null;

  if (!cfg.enabled || !cfg.notifyManualDebt) {
    return { status: STATUS.SKIPPED, error: 'DISABLED' };
  }
  if (alreadyNotified(transactionId, EVENT_TYPES.MANUAL_DEBT)) {
    return { status: STATUS.SKIPPED, error: 'ALREADY_NOTIFIED' };
  }

  const convId = findConvId(customerId);
  if (!convId) {
    return { status: STATUS.SKIPPED, error: 'NO_GROUP' };
  }

  const content = buildDebtMessage({
    customerName,
    amount,
    balanceAfter,
    title: cfg.title,
  });

  const result = await OmiCallService.sendZaloPersonalMessage({ convId, text: content });

  writeLog({
    customerId,
    customerName,
    groupId: convId,
    eventType: EVENT_TYPES.MANUAL_DEBT,
    amount,
    balanceBefore: roundMoney(opts.balanceBefore),
    balanceAfter,
    content,
    status: result.success ? STATUS.SENT : STATUS.FAILED,
    error: result.success ? null : result.error || 'Gửi thất bại',
    source,
    transactionId,
  });

  return result.success
    ? { status: STATUS.SENT }
    : { status: STATUS.FAILED, error: result.error };
}

/**
 * Gửi thông báo bất đồng bộ (fire-and-forget) — dùng trong luồng ghi bút toán.
 * KHÔNG bao giờ throw ra ngoài.
 *
 * @param {string} kind - 'payment' | 'manual_debt'
 * @param {object} payload
 */
function dispatch(kind, payload) {
  try {
    const task = kind === 'manual_debt' ? notifyManualDebt(payload) : notifyPayment(payload);
    Promise.resolve(task)
      .then((r) => {
        if (r && r.status === STATUS.FAILED) {
          logger.error('[DEBT_NOTIFY] Dispatch failed', { kind, error: r.error });
        }
      })
      .catch((err) => {
        logger.error('[DEBT_NOTIFY] Dispatch error', { kind, error: err.message });
      });
  } catch (e) {
    logger.error('[DEBT_NOTIFY] Dispatch sync error', { kind, error: e.message });
  }
}

/** Gửi thông báo "đã nhận tiền" (bất đồng bộ, không chặn nghiệp vụ). */
function notifyPaymentAsync(payload) {
  dispatch('payment', payload);
}

/** Gửi thông báo "ghi nợ tay" (bất đồng bộ, không chặn nghiệp vụ). */
function notifyManualDebtAsync(payload) {
  dispatch('manual_debt', payload);
}

// ── Lịch sử & thống kê ──────────────────────────────────────────────────────

/**
 * Lấy lịch sử thông báo (mới nhất trước).
 * @param {object} opts { limit, offset, status, customerId }
 */
function listHistory(opts = {}) {
  try {
    const limit = Math.min(parseInt(opts.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
    const where = [];
    const params = [];
    if (opts.status) {
      where.push('n.status = ?');
      params.push(String(opts.status));
    }
    if (opts.customerId) {
      where.push('n.customer_id = ?');
      params.push(parseInt(opts.customerId, 10));
    }
    const sql =
      `SELECT n.*, c.name AS customer_ref_name
         FROM debt_notifications n
         LEFT JOIN customers c ON c.id = n.customer_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY n.id DESC LIMIT ? OFFSET ?`;
    const items = db.prepare(sql).all(...params, limit, offset);
    const total = db
      .prepare(
        `SELECT COUNT(*) AS c FROM debt_notifications n ${
          where.length ? 'WHERE ' + where.join(' AND ') : ''
        }`
      )
      .get(...params);
    return { items, total: total ? total.c : 0, limit, offset };
  } catch (e) {
    logger.error('[DEBT_NOTIFY] listHistory error', { error: e.message });
    return { items: [], total: 0, limit: 0, offset: 0 };
  }
}

/**
 * Tính số dư công nợ hiện tại của khách (từ ledger).
 *
 * ⚠️ Cục bộ thay vì require `DebtLedgerService` để tránh phụ thuộc vòng
 *    (`DebtLedgerService` ← `DebtSepayService` ← `DebtNotifyService`).
 *    Logic giống hệt `DebtLedgerService.computeBalance()`.
 *
 * @param {number} customerId
 * @returns {number} số dư (>0 = còn nợ, <0 = khách đang có dư)
 */
function computeBalance(customerId) {
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(
                  SUM(CASE WHEN direction = 'INCREASE' THEN amount ELSE -amount END),
                  0
                ) AS balance
           FROM debt_transactions
          WHERE customer_id = ?`
      )
      .get(customerId);
    return roundMoney(row ? row.balance : 0);
  } catch (e) {
    logger.error('[DEBT_NOTIFY] computeBalance error', { error: e.message });
    return 0;
  }
}

/**
 * QUÉT các giao dịch đã gạch nợ nhưng CHƯA có log thông báo.
 *
 * ⚠️ NGUYÊN TẮC: KHÔNG BAO GIỜ tự động gửi tin vào nhóm Zalo của khách.
 *    Hàm này CHỈ ĐỌC & LIỆT KÊ danh sách giao dịch bị thiếu thông báo.
 *    Việc gửi thật phải do nhân viên bấm nút & xác nhận rõ ràng.
 *
 * ⚠️ VÌ SAO CẦN?
 *  Thông báo Zalo được gửi bất đồng bộ (`notifyPaymentAsync`) → fire-and-forget.
 *  Nếu tiến trình bị kết thúc trước khi promise hoàn tất (VD: chạy script
 *  CLI gạch nợ rồi `process.exit()`, hoặc server restart giữa chừng) → thông
 *  báo bị MẤT im lặng, khách không nhận được tin.
 *
 * @param {object} [opts] { limit, lookbackDays }
 * @returns {{scanned:number, items:Array}} danh sách giao dịch thiếu thông báo
 */
function listMissingNotifications(opts = {}) {
  const limit = Math.min(parseInt(opts.limit, 10) || 50, 200);
  const lookbackDays = Math.min(parseInt(opts.lookbackDays, 10) || 7, 60);

  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT t.id AS tx_id, t.customer_id, t.transfer_amount, t.applied_amount,
                t.credit_amount, t.transaction_date, t.sepay_id,
                t.debt_transaction_id,
                c.name AS customer_name,
                (SELECT g.group_name FROM debt_customer_groups g
                  WHERE g.customer_id = c.id AND g.platform = 'zalo_personal'
                    AND g.status = 'active' ORDER BY g.id DESC LIMIT 1) AS group_name
           FROM sepay_transactions t
           JOIN customers c ON c.id = t.customer_id
          WHERE t.status = 'matched'
            AND t.transfer_type = 'in'
            AND t.applied_amount > 0
            AND t.debt_transaction_id IS NOT NULL
            AND t.transaction_date >= datetime('now', ?)
            AND NOT EXISTS (
              SELECT 1 FROM debt_notifications n
               WHERE n.transaction_id = t.debt_transaction_id
                 AND n.event_type = ?
            )
          ORDER BY t.id DESC
          LIMIT ?`
      )
      .all(`-${lookbackDays} days`, EVENT_TYPES.PAYMENT, limit);
  } catch (e) {
    logger.error('[DEBT_NOTIFY] listMissingNotifications scan error', {
      error: e.message,
    });
    return { scanned: 0, items: [], error: e.message };
  }

  const items = rows.map((row) => {
    const balanceAfter = computeBalance(row.customer_id);
    const balanceBefore = roundMoney(balanceAfter + roundMoney(row.applied_amount));
    return {
      txId: row.tx_id,
      debtTransactionId: row.debt_transaction_id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      groupName: row.group_name || null,
      amount: roundMoney(row.transfer_amount),
      applied: roundMoney(row.applied_amount),
      credit: roundMoney(row.credit_amount),
      balanceBefore,
      balanceAfter,
      transactionDate: row.transaction_date,
    };
  });

  return { scanned: items.length, items };
}

/**
 * Gửi thông báo cho MỘT giao dịch cụ thể (được nhân viên xác nhận).
 *
 * ⚠️ KHÔNG tự động — chỉ gọi khi admin bấm nút "Gửi lại" cho từng mục.
 *
 * @param {number} txId - id của `sepay_transactions`
 */
async function resendNotificationForTx(txId) {
  const id = parseInt(txId, 10);
  if (!id || Number.isNaN(id)) {
    return { success: false, error: 'txId không hợp lệ' };
  }

  let row = null;
  try {
    row = db
      .prepare(
        `SELECT t.id AS tx_id, t.customer_id, t.transfer_amount, t.applied_amount,
                t.credit_amount, t.debt_transaction_id, t.transaction_date,
                c.name AS customer_name
           FROM sepay_transactions t
           JOIN customers c ON c.id = t.customer_id
          WHERE t.id = ?`
      )
      .get(id);
  } catch (e) {
    return { success: false, error: e.message };
  }

  if (!row) return { success: false, error: 'Không tìm thấy giao dịch' };

  const balanceAfter = computeBalance(row.customer_id);
  const balanceBefore = roundMoney(balanceAfter + roundMoney(row.applied_amount));

  const out = await notifyPayment({
    customerId: row.customer_id,
    customerName: row.customer_name,
    amount: roundMoney(row.transfer_amount),
    applied: roundMoney(row.applied_amount),
    credit: roundMoney(row.credit_amount),
    balanceBefore,
    balanceAfter,
    source: 'SEPAY',
    transactionId: row.debt_transaction_id,
  });

  return {
    success: out.status === STATUS.SENT,
    status: out.status,
    error: out.error || null,
    customerId: row.customer_id,
    customerName: row.customer_name,
  };
}

/** Thống kê nhanh (để hiển thị KPI trên UI). */
function getSummary() {
  try {
    const row = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
         FROM debt_notifications`
      )
      .get();
    return {
      total: row?.total || 0,
      sent: row?.sent || 0,
      failed: row?.failed || 0,
      skipped: row?.skipped || 0,
    };
  } catch (e) {
    logger.error('[DEBT_NOTIFY] getSummary error', { error: e.message });
    return { total: 0, sent: 0, failed: 0, skipped: 0 };
  }
}

module.exports = {
  CHANNEL,
  EVENT_TYPES,
  STATUS,
  buildPaymentMessage,
  buildDebtMessage,
  notifyPayment,
  notifyManualDebt,
  notifyPaymentAsync,
  notifyManualDebtAsync,
  listMissingNotifications,
  resendNotificationForTx,
  findConvId,
  listHistory,
  getSummary,
};
