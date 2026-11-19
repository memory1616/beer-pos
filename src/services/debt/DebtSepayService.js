/**
 * DebtSepayService — Gạch nợ công nợ tự động từ giao dịch Sepay
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu:
 *  1. Nhận giao dịch từ Sepay (webhook real-time + polling đối soát API).
 *  2. LƯU MỌI giao dịch vào `sepay_transactions` (kể cả chưa gạch nợ) →
 *     không bỏ sót, làm căn cứ đối soát.
 *  3. Tự khớp khách hàng theo `debt_code` nhúng trong nội dung chuyển khoản.
 *  4. Gạch nợ:
 *     - Trả đúng   → ghi PAYMENT (giảm công nợ), phân bổ FIFO vào các đơn.
 *     - Trả thiếu  → ghi PAYMENT số tiền thực nhận (FIFO), phần còn nợ giữ nguyên.
 *     - Trả DƯ     → ghi PAYMENT đúng số nợ + ghi CREDIT (tiền khách nợ lại,
 *                     số dư âm). Khách dùng tiền dư để trừ nợ sau.
 *     - Không khớp được khách → giữ `manual`, nhân viên xử lý tay trên UI.
 *
 * Nguyên tắc bất di bất dịch (giống phần còn lại của module Sổ công nợ):
 *  - Ledger là APPEND-ONLY → mọi thao tác đều tạo bút toán MỚI, không sửa bút toán cũ.
 *  - Idempotent: `sepay_transactions.sepay_id` UNIQUE → webhook retry không gạch 2 lần.
 *  - Mọi thao tác ghi bút toán đều qua `DebtLedgerService.recordTransaction()`
 *    (có transaction + audit log + đồng bộ mirror `customers.debt`).
 *  - KHÔNG tự động ghi bút toán khi chưa xác định được khách hàng.
 */

const crypto = require('crypto');
const db = require('../../../database');
const logger = require('../../utils/logger');
const DebtLedgerService = require('./DebtLedgerService');
const DebtAuditService = require('./DebtAuditService');
const { TRANSACTION_TYPES, SOURCES, REFERENCE_TYPES } = require('./constants');

// ── Trạng thái giao dịch Sepay ───────────────────────────────────────────────
const TX_STATUS = {
  PENDING: 'pending', // Mới nhận, chưa xử lý
  MATCHED: 'matched', // Đã khớp khách + đã gạch nợ
  MANUAL: 'manual', // Chưa khớp được khách → cần xử lý tay
  IGNORED: 'ignored', // Đã bỏ qua (tiền ra, giao dịch hệ thống)
};

const SEPAY_API_BASE = 'https://userapi.sepay.vn/v2';

// ── Helpers ──────────────────────────────────────────────────────────────────

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function getSettings() {
  try {
    const row = db.prepare('SELECT * FROM sepay_settings WHERE id = 1').get();
    if (!row) {
      db.prepare('INSERT OR IGNORE INTO sepay_settings (id, auto_settle) VALUES (1, 1)').run();
      return {
        apiToken: null,
        webhookSecret: null,
        bankAccounts: [],
        paymentCodePrefix: 'DH',
        autoSettle: true,
      };
    }
    let accounts = [];
    try {
      accounts = row.bank_accounts ? JSON.parse(row.bank_accounts) : [];
    } catch (_) {
      accounts = [];
    }
    return {
      apiToken: row.api_token || null,
      webhookSecret: row.webhook_secret || null,
      bankAccounts: Array.isArray(accounts) ? accounts : [],
      paymentCodePrefix: row.payment_code_prefix || 'DH',
      autoSettle: row.auto_settle !== 0,
    };
  } catch (e) {
    logger.error('[SEPAY] getSettings error', { error: e.message });
    return {
      apiToken: null,
      webhookSecret: null,
      bankAccounts: [],
      paymentCodePrefix: 'DH',
      autoSettle: false,
    };
  }
}

function saveSettings(patch = {}) {
  try {
    db.prepare('INSERT OR IGNORE INTO sepay_settings (id, auto_settle) VALUES (1, 1)').run();
    const current = db.prepare('SELECT * FROM sepay_settings WHERE id = 1').get() || {};
    const next = {
      api_token:
        patch.apiToken !== undefined ? patch.apiToken : current.api_token || null,
      webhook_secret:
        patch.webhookSecret !== undefined
          ? patch.webhookSecret
          : current.webhook_secret || null,
      bank_accounts:
        patch.bankAccounts !== undefined
          ? JSON.stringify(patch.bankAccounts || [])
          : current.bank_accounts || null,
      payment_code_prefix:
        patch.paymentCodePrefix !== undefined
          ? patch.paymentCodePrefix
          : current.payment_code_prefix || 'DH',
      auto_settle:
        patch.autoSettle !== undefined
          ? (patch.autoSettle ? 1 : 0)
          : current.auto_settle ?? 1,
    };
    db.prepare(
      `UPDATE sepay_settings
          SET api_token = ?, webhook_secret = ?, bank_accounts = ?,
              payment_code_prefix = ?, auto_settle = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`
    ).run(
      next.api_token,
      next.webhook_secret,
      next.bank_accounts,
      next.payment_code_prefix,
      next.auto_settle
    );
    return { success: true };
  } catch (e) {
    logger.error('[SEPAY] saveSettings error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Bỏ khoảng trắng + bỏ dấu tiếng Việt + uppercase để so khớp mã ổn định.
 * VD: "kh 0001" → "KH0001"
 */
function normalizeCode(raw) {
  if (!raw) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Trích mã khách (`debt_code`) ra từ nội dung / mã / mô tả giao dịch.
 *
 * Mã khách dạng `KH` + 4 chữ số (VD: KH0007) → regex `/\bKH\d{3,8}\b/`.
 * Ngoài ra hỗ trợ tiền tố mã thanh toán do Sepay cấu hình (`code` field),
 * ví dụ prefix "DH" → "DH0007".
 */
function extractDebtCode(payload) {
  const candidates = [
    payload.debt_code,
    payload.code,
    payload.content,
    payload.description,
    payload.transaction_content,
  ];

  // 1) Mã `debt_code` dạng KHxxxx (ưu tiên cao nhất)
  for (const c of candidates) {
    if (!c) continue;
    const norm = normalizeCode(c);
    const m = norm.match(/KH\d{3,8}/);
    if (m) return m[0];
  }

  // 2) Mã dạng prefix + số (theo cấu hình Sepay), VD prefix "DH" → DH0007
  const settings = getSettings();
  const prefix = (settings.paymentCodePrefix || 'DH').toUpperCase();
  if (prefix && prefix !== 'KH') {
    for (const c of candidates) {
      if (!c) continue;
      const norm = normalizeCode(c);
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = norm.match(new RegExp(escaped + '\\d{3,8}'));
      if (m) return m[0];
    }
  }

  return '';
}

/** Tìm khách hàng theo mã `debt_code` (không phân biệt hoa/thường). */
function findCustomerByDebtCode(code) {
  const norm = normalizeCode(code);
  if (!norm) return null;
  try {
    return (
      db
        .prepare(
          'SELECT id, name, phone, debt, debt_code FROM customers WHERE debt_code = ?'
        )
        .get(norm) ||
      db
        .prepare(
          'SELECT id, name, phone, debt, debt_code FROM customers WHERE UPPER(debt_code) = ?'
        )
        .get(norm) ||
      null
    );
  } catch (e) {
    logger.error('[SEPAY] findCustomerByDebtCode error', { error: e.message });
    return null;
  }
}

/** Sinh mã khách mới (KHxxxx) — không trùng mã đã có. */
function generateDebtCode() {
  try {
    const row = db
      .prepare(
        `SELECT debt_code FROM customers
          WHERE debt_code IS NOT NULL AND debt_code LIKE 'KH%'
          ORDER BY debt_code DESC LIMIT 1`
      )
      .get();
    let seq = 0;
    if (row && row.debt_code) {
      const n = parseInt(String(row.debt_code).replace(/\D/g, ''), 10);
      if (!Number.isNaN(n)) seq = n;
    }
    seq += 1;
    let candidate = 'KH' + String(seq).padStart(4, '0');
    let guard = 0;
    while (
      db.prepare('SELECT 1 FROM customers WHERE debt_code = ?').get(candidate) &&
      guard < 100
    ) {
      seq += 1;
      candidate = 'KH' + String(seq).padStart(4, '0');
      guard += 1;
    }
    return candidate;
  } catch (e) {
    logger.error('[SEPAY] generateDebtCode error', { error: e.message });
    return null;
  }
}

/**
 * Gán mã `debt_code` cho 1 khách (nếu chưa có).
 * @returns {string|null} mã sau khi gán
 */
function ensureCustomerDebtCode(customerId) {
  const custId = parseInt(customerId, 10);
  if (!custId || Number.isNaN(custId)) return null;
  try {
    const cust = db
      .prepare('SELECT id, debt_code FROM customers WHERE id = ?')
      .get(custId);
    if (!cust) return null;
    if (cust.debt_code) return cust.debt_code;

    const code = generateDebtCode();
    if (!code) return null;
    db.prepare(
      'UPDATE customers SET debt_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(code, custId);
    return code;
  } catch (e) {
    logger.error('[SEPAY] ensureCustomerDebtCode error', { error: e.message });
    return null;
  }
}

/** Đặt lại mã `debt_code` cho khách (nhân viên sửa tay). */
function setCustomerDebtCode(customerId, code) {
  const custId = parseInt(customerId, 10);
  if (!custId || Number.isNaN(custId)) {
    return { success: false, error: 'customerId không hợp lệ' };
  }
  const norm = normalizeCode(code);
  if (!norm) return { success: false, error: 'Mã khách không được để trống' };
  if (!/^[A-Z0-9]{3,12}$/.test(norm)) {
    return { success: false, error: 'Mã khách chỉ gồm chữ in hoa và số (3–12 ký tự)' };
  }
  try {
    const dup = db
      .prepare('SELECT id FROM customers WHERE debt_code = ? AND id != ?')
      .get(norm, custId);
    if (dup) {
      return { success: false, error: `Mã "${norm}" đã được khách #${dup.id} sử dụng` };
    }
    db.prepare(
      'UPDATE customers SET debt_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(norm, custId);
    return { success: true, debtCode: norm };
  } catch (e) {
    logger.error('[SEPAY] setCustomerDebtCode error', { error: e.message });
    return { success: false, error: e.message };
  }
}

// ── Xác thực webhook ─────────────────────────────────────────────────────────

/**
 * Xác thực chữ ký HMAC-SHA256 của SePay.
 *
 * Theo tài liệu SePay (https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc):
 *   - Header `X-SePay-Signature` có dạng `sha256={hex_hash}`
 *   - Header `X-SePay-Timestamp` = Unix timestamp (giây) lúc ký
 *   - Chuỗi được ký: `{timestamp}.{raw_body}`  (DẤU CHẤM nối, KHÔNG phải body)
 *   - Hash: HMAC-SHA256 với Secret Key → hex
 *
 * ⚠️ Phải dùng RAW BODY (bytes gốc). Nếu middleware đã parse JSON rồi
 *    stringify lại thì chữ ký lệch (thứ tự khóa, escape Unicode, whitespace).
 *
 * @param {Buffer|string} rawBody - raw body
 * @param {string} signature - giá trị header `X-SePay-Signature`
 * @param {string} secret - Secret Key
 * @param {number} [timestamp] - giá trị header `X-SePay-Timestamp` (Unix giây)
 * @param {object} [opts] { maxAgeSec } - cửa sổ chống replay (mặc định 300s)
 */
function verifyWebhookSignature(rawBody, signature, secret, timestamp, opts = {}) {
  if (!secret) return { valid: false, reason: 'NO_SECRET' };
  if (!signature) return { valid: false, reason: 'NO_SIGNATURE' };

  const maxAgeSec = opts.maxAgeSec === undefined ? 300 : opts.maxAgeSec;

  // ── Chống replay: timestamp lệch quá cửa sổ cho phép → từ chối ──────────
  // Bỏ qua nếu SePay không gửi timestamp (mode tương thích cũ).
  const ts = Number(timestamp);
  if (Number.isFinite(ts) && ts > 0 && maxAgeSec > 0) {
    const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (skew > maxAgeSec) {
      return { valid: false, reason: 'TIMESTAMP_EXPIRED', skew };
    }
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');

  // SePay gửi `sha256={hex}` — hỗ trợ thêm bản hex trần để tương thích.
  const raw = String(signature).trim();
  const hex = raw.startsWith('sha256=') ? raw.slice('sha256='.length) : raw;

  // ── Chuỗi ký ───────────────────────────────────────────────────────────
  //  • Có timestamp (cách chuẩn của SePay): `{timestamp}.{raw_body}`
  //  • Không có timestamp (tương thích): chỉ `{raw_body}`
  const hasTimestamp = Number.isFinite(ts) && ts > 0;
  const expected = hasTimestamp
    ? crypto
        .createHmac('sha256', secret)
        .update(`${ts}.`)
        .update(body)
        .digest('hex')
    : crypto.createHmac('sha256', secret).update(body).digest('hex');

  const a = Buffer.from(hex);
  const b = Buffer.from(expected);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    return { valid: true, method: hasTimestamp ? 'hmac-sha256' : 'hmac-legacy' };
  }

  return { valid: false, reason: 'INVALID_SIGNATURE' };
}

// ── Ghi nhận giao dịch ───────────────────────────────────────────────────────

/**
 * Lưu 1 giao dịch Sepay vào DB (idempotent theo `sepay_id`).
 * @returns {{success:boolean, transactionId?:number, duplicate?:boolean}}
 */
function storeTransaction(payload) {
  const sepayId = String(payload.id || payload.sepay_id || '').trim();
  if (!sepayId) return { success: false, error: 'Thiếu id giao dịch Sepay' };

  const amount = roundMoney(payload.transfer_amount || payload.transferAmount || 0);
  const transferType = String(
    payload.transfer_type || payload.transferType || 'in'
  ).toLowerCase();

  try {
    const existing = db
      .prepare('SELECT * FROM sepay_transactions WHERE sepay_id = ?')
      .get(sepayId);
    if (existing) {
      return { success: true, transactionId: existing.id, duplicate: true };
    }

    const debtCode = extractDebtCode(payload);

    const info = db
      .prepare(
        `INSERT INTO sepay_transactions
           (sepay_id, gateway, account_number, sub_account, code, content, description,
            transfer_type, transfer_amount, accumulated, reference_code, transaction_date,
            debt_code, status, raw_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sepayId,
        payload.gateway || null,
        payload.account_number || payload.accountNumber || null,
        payload.sub_account || payload.subAccount || null,
        payload.code || null,
        payload.content || payload.transaction_content || null,
        payload.description || null,
        transferType,
        amount,
        roundMoney(payload.accumulated || 0),
        payload.reference_code || payload.referenceCode || null,
        payload.transaction_date || payload.transactionDate || null,
        debtCode || null,
        TX_STATUS.PENDING,
        JSON.stringify(payload)
      );

    return { success: true, transactionId: info.lastInsertRowid };
  } catch (e) {
    logger.error('[SEPAY] storeTransaction error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Xử lý 1 giao dịch đã lưu: khớp khách + gạch nợ.
 *
 * @param {number} txId - id trong `sepay_transactions`
 * @param {object} [opts] { user, force }
 */
function processTransaction(txId, opts = {}) {
  const { user = null, force = false } = opts;

  const tx = db.prepare('SELECT * FROM sepay_transactions WHERE id = ?').get(txId);
  if (!tx) return { success: false, error: 'Không tìm thấy giao dịch' };

  // Đã xử lý rồi → không làm gì (idempotent)
  if (tx.status === TX_STATUS.MATCHED && !force) {
    return {
      success: true,
      skipped: true,
      reason: 'ALREADY_PROCESSED',
      transactionId: tx.id,
    };
  }

  // Tiền RA → không gạch nợ
  if (tx.transfer_type !== 'in') {
    db.prepare(
      `UPDATE sepay_transactions
          SET status = ?, processed_at = CURRENT_TIMESTAMP, note = ?
        WHERE id = ?`
    ).run(TX_STATUS.IGNORED, 'Giao dịch tiền ra — không gạch nợ', tx.id);
    return { success: true, skipped: true, reason: 'OUT_TRANSFER', transactionId: tx.id };
  }

  const amount = roundMoney(tx.transfer_amount);
  if (!(amount > 0)) {
    db.prepare(
      `UPDATE sepay_transactions
          SET status = ?, processed_at = CURRENT_TIMESTAMP, note = ?
        WHERE id = ?`
    ).run(TX_STATUS.IGNORED, 'Số tiền = 0', tx.id);
    return { success: true, skipped: true, reason: 'ZERO_AMOUNT', transactionId: tx.id };
  }

  // ── 1. Khớp khách hàng ────────────────────────────────────────────────
  let customer = null;
  if (tx.customer_id) {
    customer = db
      .prepare('SELECT id, name, phone, debt, debt_code FROM customers WHERE id = ?')
      .get(tx.customer_id);
  }
  if (!customer && tx.debt_code) {
    customer = findCustomerByDebtCode(tx.debt_code);
  }

  if (!customer) {
    db.prepare(
      `UPDATE sepay_transactions
          SET status = ?, processed_at = CURRENT_TIMESTAMP, note = ?
        WHERE id = ?`
    ).run(
      TX_STATUS.MANUAL,
      tx.debt_code
        ? `Không tìm thấy khách với mã "${tx.debt_code}" — cần nhân viên xử lý`
        : 'Không tìm thấy mã khách trong nội dung chuyển khoản — cần nhân viên xử lý',
      tx.id
    );
    return {
      success: false,
      code: 'NO_CUSTOMER_MATCH',
      error: 'Chưa khớp được khách hàng',
      transactionId: tx.id,
    };
  }

  // ── 2. Gạch nợ ────────────────────────────────────────────────────────
  const balanceBefore = DebtLedgerService.computeBalance(customer.id);
  const settings = getSettings();

  if (!settings.autoSettle && !force) {
    db.prepare(
      `UPDATE sepay_transactions
          SET status = ?, customer_id = ?, processed_at = CURRENT_TIMESTAMP,
              note = ?
        WHERE id = ?`
    ).run(
      TX_STATUS.MANUAL,
      customer.id,
      'Chế độ tự động gạch nợ đang TẮT',
      tx.id
    );
    return {
      success: true,
      skipped: true,
      reason: 'AUTO_SETTLE_DISABLED',
      transactionId: tx.id,
      customerId: customer.id,
    };
  }

  // Số nợ hiện tại (có thể âm = khách đang nợ lại hệ thống)
  const owed = balanceBefore > 0 ? balanceBefore : 0;

  // Phần được gạch = min(số tiền nhận, số nợ)
  const applied = roundMoney(Math.min(amount, owed));
  // Phần dư = số tiền nhận - phần gạch (tiền khách nợ lại)
  const credit = roundMoney(Math.max(0, amount - applied));

  // ⚠️ THÔNG TIN HIỂN THỊ (KHÔNG tạo bút toán riêng):
  // Sổ công nợ dùng SỐ DƯ RÒNG → balance = tổng nợ - tổng đã trả.
  // Nếu khách đang nợ lại (số dư âm) thì toàn bộ số tiền nhận đều quy về
  // CREDIT (số dư âm thêm). `deficitOffset` = phần tiền nhận dùng để bù
  // khoản nợ lại (chỉ để hiển thị cho nhân viên, KHÔNG ghi bút toán vì
  // ledger đã trừ đúng số tiền nhận rồi).
  const deficitOffset = balanceBefore < 0 ? roundMoney(Math.min(amount, -balanceBefore)) : 0;

  let paymentResult = null;
  let creditResult = null;

  if (applied > 0) {
    paymentResult = DebtLedgerService.recordTransaction({
      customerId: customer.id,
      transactionType: TRANSACTION_TYPES.PAYMENT,
      amount: applied,
      direction: DebtLedgerService.DIRECTION.DECREASE,
      referenceType: REFERENCE_TYPES.MANUAL,
      referenceId: tx.sepay_id,
      description: `Thanh toán qua Sepay (${tx.transaction_date || ''})`.trim(),
      createdBy: (user && user.username) || 'sepay',
      source: SOURCES.SYSTEM,
      idempotencyKey: `sepay:${tx.sepay_id}:payment`,
      allowNegativeBalance: true,
      businessDate: sepayBusinessDate(tx.transaction_date),
    });

    if (!paymentResult.success) {
      logger.error('[SEPAY] record payment failed', {
        txId: tx.id,
        error: paymentResult.error,
      });
      db.prepare(
        `UPDATE sepay_transactions
            SET status = ?, customer_id = ?, processed_at = CURRENT_TIMESTAMP, note = ?
          WHERE id = ?`
      ).run(TX_STATUS.MANUAL, customer.id, `Lỗi ghi bút toán: ${paymentResult.error}`, tx.id);
      return {
        success: false,
        error: paymentResult.error,
        transactionId: tx.id,
      };
    }

    // Phân bổ FIFO vào bảng chiếu `order_debts`
    allocateToOrders(customer.id, applied);
  }

  if (credit > 0) {
    // Tiền khách nợ lại → bút toán CREDIT giảm công nợ (số dư âm).
    // `keepNegativeBalance: true` → giữ số dư âm thật trong ledger + mirror.
    creditResult = DebtLedgerService.recordTransaction({
      customerId: customer.id,
      transactionType: TRANSACTION_TYPES.CREDIT,
      amount: credit,
      direction: DebtLedgerService.DIRECTION.DECREASE,
      referenceType: REFERENCE_TYPES.MANUAL,
      referenceId: tx.sepay_id,
      description: `Tiền khách chuyển DƯ qua Sepay (${credit.toLocaleString('vi-VN')}đ)`,
      createdBy: (user && user.username) || 'sepay',
      source: SOURCES.SYSTEM,
      idempotencyKey: `sepay:${tx.sepay_id}:credit`,
      allowNegativeBalance: true,
      keepNegativeBalance: true,
      businessDate: sepayBusinessDate(tx.transaction_date),
    });

    if (!creditResult.success) {
      logger.error('[SEPAY] record credit failed', {
        txId: tx.id,
        error: creditResult.error,
      });
    }
  }

  const balanceAfter = DebtLedgerService.computeBalance(customer.id);

  // ── 3. Cập nhật giao dịch Sepay ───────────────────────────────────────
  const noteParts = [];
  if (applied > 0) noteParts.push(`Gạch nợ ${applied.toLocaleString('vi-VN')}đ`);
  if (credit > 0) noteParts.push(`Khách nợ lại ${credit.toLocaleString('vi-VN')}đ`);
  if (deficitOffset > 0 && applied === 0) {
    noteParts.push(`Bù nợ lại ${deficitOffset.toLocaleString('vi-VN')}đ`);
  }
  if (applied === 0 && credit === 0) noteParts.push('Không có công nợ để gạch');

  db.prepare(
    `UPDATE sepay_transactions
        SET status = ?, customer_id = ?, applied_amount = ?, credit_amount = ?,
            debt_transaction_id = ?, processed_at = CURRENT_TIMESTAMP, note = ?
      WHERE id = ?`
  ).run(
    TX_STATUS.MATCHED,
    customer.id,
    applied,
    credit,
    paymentResult ? paymentResult.transactionId : null,
    noteParts.join(' · '),
    tx.id
  );

  DebtAuditService.record({
    transactionId: paymentResult ? paymentResult.transactionId : null,
    action: DebtAuditService.AUDIT_ACTIONS.CREATE,
    actorId: (user && user.username) || 'sepay',
    beforeData: { balance: balanceBefore, sepayId: tx.sepay_id },
    afterData: {
      balance: balanceAfter,
      applied,
      credit,
      deficitOffset,
      customerId: customer.id,
      sepayId: tx.sepay_id,
    },
  });

  logger.info('[SEPAY] Settlement done', {
    txId: tx.id,
    customerId: customer.id,
    amount,
    applied,
    credit,
    deficitOffset,
    balanceAfter,
  });

  return {
    success: true,
    transactionId: tx.id,
    customerId: customer.id,
    customerName: customer.name,
    amount,
    applied,
    credit,
    deficitOffset,
    balanceBefore,
    balanceAfter,
    debtTransactionId: paymentResult ? paymentResult.transactionId : null,
  };
}

/**
 * Ngày nghiệp vụ của giao dịch Sepay (YYYY-MM-DD).
 * Sepay gửi `transactionDate` = "YYYY-MM-DD HH:mm:ss" (giờ VN).
 */
function sepayBusinessDate(transactionDate) {
  if (!transactionDate) return null;
  const m = String(transactionDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * Phân bổ tiền trả vào các đơn chưa thanh toán (FIFO — đơn cũ trước).
 * Đồng bộ với `order_debts` + `sales.payment_status`.
 */
function allocateToOrders(customerId, amount) {
  let remaining = roundMoney(amount);
  try {
    const unpaidOrders = db
      .prepare(
        `SELECT * FROM order_debts
          WHERE customer_id = ? AND status != 'paid' AND status != 'cancelled'
          ORDER BY created_at ASC, id ASC`
      )
      .all(customerId);

    for (const od of unpaidOrders) {
      if (remaining <= 0) break;
      const toApply = Math.min(remaining, od.remaining_amount || 0);
      if (toApply <= 0) continue;
      const newPaid = (od.paid_amount || 0) + toApply;
      const newRemaining = Math.max(0, od.original_amount - newPaid);
      const status = newRemaining <= 0 ? 'paid' : 'partial';
      db.prepare(
        `UPDATE order_debts
            SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(newPaid, newRemaining, status, od.id);
      if (od.sale_id) {
        db.prepare('UPDATE sales SET payment_status = ? WHERE id = ?').run(status, od.sale_id);
      }
      remaining = roundMoney(remaining - toApply);
    }
  } catch (e) {
    logger.error('[SEPAY] allocateToOrders error', { error: e.message });
  }
}

// ── Webhook ──────────────────────────────────────────────────────────────────

/**
 * Xử lý payload webhook từ Sepay.
 *
 * @param {object} payload - body đã parse JSON
 * @param {object} [opts] { user }
 */
function handleWebhook(payload, opts = {}) {
  if (!payload || !payload.id) {
    return { success: false, error: 'Payload không hợp lệ' };
  }

  const stored = storeTransaction(payload);
  if (!stored.success) {
    return { success: false, error: stored.error };
  }

  if (stored.duplicate) {
    logger.info('[SEPAY] Webhook trùng (bỏ qua)', { sepayId: payload.id });
    return { success: true, duplicate: true, transactionId: stored.transactionId };
  }

  const processed = processTransaction(stored.transactionId, { user: opts.user });
  return { success: true, transactionId: stored.transactionId, settlement: processed };
}

// ── Đối soát qua API ─────────────────────────────────────────────────────────

/**
 * Gọi API SePay v2 lấy danh sách giao dịch (dùng cho đối soát bù webhook).
 *
 * API v2: GET https://userapi.sepay.vn/v2/transactions
 *   - Auth: `Authorization: Bearer <API_TOKEN>`
 *   - Response: `{ status, data: [...], meta: { pagination: {...} } }`
 *   - Field trong `data` dùng SNAKE_CASE (`transaction_content`, `amount_in`, ...),
 *     khác với payload webhook (camelCase) → cần chuẩn hoá.
 *   - Rate limit: 3 request/giây → trả 429 nếu vượt.
 *
 * @param {object} [opts] { from, to, page, perPage, sinceId }
 * @returns {Promise<{success:boolean, transactions?:Array, error?:string}>}
 */
async function fetchTransactions(opts = {}) {
  const settings = getSettings();
  if (!settings.apiToken) {
    return { success: false, error: 'Chưa cấu hình Sepay API token' };
  }

  const url = new URL(`${SEPAY_API_BASE}/transactions`);
  if (opts.from) url.searchParams.set('transaction_date_from', opts.from);
  if (opts.to) url.searchParams.set('transaction_date_to', opts.to);
  if (opts.sinceId) url.searchParams.set('since_id', opts.sinceId);
  url.searchParams.set('per_page', String(Math.min(100, opts.perPage || 100)));
  url.searchParams.set('page', String(opts.page || 1));
  // Sắp xếp tăng dần để `since_id` bắt đúng những giao dịch mới
  url.searchParams.set('transaction_date_sort', 'asc');

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiToken}`,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('[SEPAY] fetchTransactions HTTP error', {
        status: res.status,
        body: text.slice(0, 300),
      });
      if (res.status === 401) {
        return { success: false, error: 'API token không hợp lệ hoặc đã bị vô hiệu' };
      }
      if (res.status === 429) {
        return {
          success: false,
          error: 'Sepay giới hạn tốc độ (tối đa 3 request/giây) — thử lại sau',
        };
      }
      return { success: false, error: `Lỗi API Sepay (HTTP ${res.status})` };
    }

    const json = await res.json();

    // API v2 luôn dùng key `data`; key `transactions` là của v1 (giữ để tương thích).
    const list = Array.isArray(json.data)
      ? json.data
      : Array.isArray(json.transactions)
        ? json.transactions
        : [];

    const normalized = list.map(normalizeApiTransaction);
    const pagination = (json.meta && json.meta.pagination) || {};

    return {
      success: true,
      transactions: normalized,
      pagination: {
        total: pagination.total || 0,
        currentPage: pagination.current_page || 1,
        lastPage: pagination.last_page || 1,
        hasMore: !!pagination.has_more,
      },
      raw: json,
    };
  } catch (e) {
    logger.error('[SEPAY] fetchTransactions error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Chuẩn hoá giao dịch từ API v2 (snake_case) về format nội bộ (camelCase),
 * để `storeTransaction` xử lý giống hệt payload webhook.
 */
function normalizeApiTransaction(t = {}) {
  const transferType = String(t.transfer_type || 'in').toLowerCase();
  // API v2 tách amount_in / amount_out; webhook dùng transferAmount + transferType.
  const amount = t.transfer_amount !== undefined && t.transfer_amount !== null
    ? t.transfer_amount
    : transferType === 'out'
      ? (t.amount_out || 0)
      : (t.amount_in || 0);

  return {
    id: t.id,
    gateway: t.bank_brand_name || t.gateway || null,
    accountNumber: t.account_number || null,
    subAccount: t.va || t.sub_account || null,
    code: t.code || null,
    content: t.transaction_content || t.content || null,
    description: t.description || null,
    transferType,
    transferAmount: amount,
    accumulated: t.accumulated || 0,
    referenceCode: t.reference_number || t.reference_code || null,
    transactionDate: t.transaction_date || t.transactionDate || null,
    // `webhook_success`: 1 = đã gửi webhook thành công, 0 = thất bại/chưa gửi.
    webhookSuccess: t.webhook_success === undefined ? null : t.webhook_success,
  };
}

/**
 * Đối soát: lấy giao dịch từ API Sepay trong khoảng thời gian, lưu những
 * giao dịch chưa có trong DB, rồi gạch nợ những giao dịch mới.
 *
 * @param {object} [opts] { from, to, user }
 */
async function reconcile(opts = {}) {
  const now = new Date();
  const to = opts.to || formatSepayDate(now);
  const from =
    opts.from || formatSepayDate(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));

  const fetched = await fetchTransactions({ from, to, perPage: 100 });
  if (!fetched.success) return fetched;

  let added = 0;
  let duplicates = 0;
  let settled = 0;
  let failed = 0;
  let total = 0;
  const results = [];
  const all = [];

  // Đọc HẾT các trang (per_page tối đa 100). Rate limit SePay = 3 req/giây
  // → nghỉ 350ms giữa các lần gọi để không bị 429.
  let page = 1;
  let hasMore = true;
  const MAX_PAGES = 20; // chặn runaway
  while (hasMore && page <= MAX_PAGES) {
    const fetched = await fetchTransactions({ from, to, perPage: 100, page });
    if (!fetched.success) {
      if (all.length === 0) return fetched;
      break; // đã lấy được phần nào → vẫn xử lý phần đó
    }
    const list = fetched.transactions || [];
    total += list.length;
    all.push(...list);
    hasMore = !!(fetched.pagination && fetched.pagination.hasMore) && list.length > 0;
    page += 1;
    if (hasMore) await sleep(350);
  }

  for (const t of all) {
    const stored = storeTransaction(t);
    if (!stored.success) {
      failed += 1;
      continue;
    }
    if (stored.duplicate) {
      duplicates += 1;
      continue;
    }
    added += 1;
    const res = processTransaction(stored.transactionId, { user: opts.user });
    if (res.success && !res.skipped) settled += 1;
    else if (!res.success) failed += 1;
    results.push(res);
  }

  logger.info('[SEPAY] Reconcile done', { from, to, added, duplicates, settled, failed });

  return {
    success: true,
    from,
    to,
    total,
    added,
    duplicates,
    settled,
    failed,
    results,
  };
}

/** Chờ (ms) — dùng để giữ nhịp rate limit của SePay (3 req/giây). */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSepayDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// ── Truy vấn ─────────────────────────────────────────────────────────────────

/** Danh sách giao dịch Sepay (mới nhất trước). */
function listTransactions(filters = {}) {
  const limit = Math.min(500, Math.max(1, parseInt(filters.limit) || 100));
  const offset = Math.max(0, parseInt(filters.offset) || 0);
  const params = [];
  let where = '1=1';

  if (filters.status) {
    where += ' AND t.status = ?';
    params.push(filters.status);
  }
  if (filters.customerId) {
    where += ' AND t.customer_id = ?';
    params.push(parseInt(filters.customerId, 10));
  }
  if (filters.from) {
    where += ' AND t.transaction_date >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    where += ' AND t.transaction_date <= ?';
    params.push(filters.to);
  }

  const rows = db
    .prepare(
      `SELECT t.*, c.name AS customer_name, c.phone AS customer_phone
         FROM sepay_transactions t
         LEFT JOIN customers c ON c.id = t.customer_id
        WHERE ${where}
        ORDER BY t.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM sepay_transactions t WHERE ${where}`)
    .get(...params);

  return {
    total: total ? total.c : 0,
    items: rows.map((r) => ({
      id: r.id,
      sepayId: r.sepay_id,
      gateway: r.gateway,
      accountNumber: r.account_number,
      code: r.code,
      content: r.content,
      description: r.description,
      transferType: r.transfer_type,
      amount: roundMoney(r.transfer_amount),
      accumulated: roundMoney(r.accumulated || 0),
      referenceCode: r.reference_code,
      transactionDate: r.transaction_date,
      customerId: r.customer_id,
      customerName: r.customer_name,
      debtCode: r.debt_code,
      status: r.status,
      appliedAmount: roundMoney(r.applied_amount || 0),
      creditAmount: roundMoney(r.credit_amount || 0),
      note: r.note,
      createdAt: r.created_at,
      processedAt: r.processed_at,
    })),
  };
}

/** Thống kê nhanh cho UI. */
function getSummary() {
  try {
    const row = db
      .prepare(
        `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'manual'  THEN 1 ELSE 0 END), 0) AS manual,
            COALESCE(SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END), 0) AS matched,
            COALESCE(SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END), 0) AS ignored,
            COALESCE(SUM(CASE WHEN status = 'matched' THEN applied_amount ELSE 0 END), 0) AS applied,
            COALESCE(SUM(CASE WHEN status = 'matched' THEN credit_amount ELSE 0 END), 0) AS credit
          FROM sepay_transactions`
      )
      .get();

    const settings = getSettings();
    return {
      total: row.total,
      pending: row.pending,
      manual: row.manual,
      matched: row.matched,
      ignored: row.ignored,
      applied: roundMoney(row.applied),
      credit: roundMoney(row.credit),
      configured: !!settings.apiToken,
      autoSettle: settings.autoSettle,
    };
  } catch (e) {
    logger.error('[SEPAY] getSummary error', { error: e.message });
    return {
      total: 0,
      pending: 0,
      manual: 0,
      matched: 0,
      ignored: 0,
      applied: 0,
      credit: 0,
    };
  }
}

/** Nhân viên gán khách cho 1 giao dịch chờ xử lý → gạch nợ ngay. */
function assignCustomerAndSettle(txId, customerId, opts = {}) {
  const id = parseInt(txId, 10);
  const custId = parseInt(customerId, 10);
  if (!id || Number.isNaN(id)) {
    return { success: false, error: 'transactionId không hợp lệ' };
  }
  if (!custId || Number.isNaN(custId)) {
    return { success: false, error: 'customerId không hợp lệ' };
  }
  try {
    const tx = db.prepare('SELECT * FROM sepay_transactions WHERE id = ?').get(id);
    if (!tx) return { success: false, error: 'Không tìm thấy giao dịch' };
    if (tx.status === TX_STATUS.MATCHED) {
      return { success: false, error: 'Giao dịch đã được gạch nợ rồi' };
    }
    db.prepare('UPDATE sepay_transactions SET customer_id = ? WHERE id = ?').run(custId, id);
  } catch (e) {
    logger.error('[SEPAY] assignCustomer error', { error: e.message });
    return { success: false, error: e.message };
  }
  return processTransaction(id, { user: opts.user, force: true });
}

/** Bỏ qua 1 giao dịch (VD: tiền của hệ thống, giao dịch nhầm). */
function ignoreTransaction(txId, note) {
  const id = parseInt(txId, 10);
  if (!id || Number.isNaN(id)) {
    return { success: false, error: 'transactionId không hợp lệ' };
  }
  try {
    db.prepare(
      `UPDATE sepay_transactions
          SET status = ?, processed_at = CURRENT_TIMESTAMP, note = ?
        WHERE id = ?`
    ).run(TX_STATUS.IGNORED, note || 'Bỏ qua bởi nhân viên', id);
    return { success: true };
  } catch (e) {
    logger.error('[SEPAY] ignoreTransaction error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Nội dung chuyển khoản có nhúng mã khách để Sepay/ngân hàng đọc được.
 * @param {number} customerId
 * @param {string} [extra] nội dung gốc
 */
function buildTransferContent(customerId, extra) {
  const code = ensureCustomerDebtCode(customerId);
  const base = extra ? String(extra) : '';
  if (!code) return base;
  return base ? `${base} ${code}` : code;
}

module.exports = {
  TX_STATUS,
  SEPAY_API_BASE,
  getSettings,
  saveSettings,
  normalizeCode,
  extractDebtCode,
  findCustomerByDebtCode,
  generateDebtCode,
  ensureCustomerDebtCode,
  setCustomerDebtCode,
  verifyWebhookSignature,
  storeTransaction,
  processTransaction,
  handleWebhook,
  fetchTransactions,
  normalizeApiTransaction,
  reconcile,
  listTransactions,
  getSummary,
  assignCustomerAndSettle,
  ignoreTransaction,
  buildTransferContent,
  sepayBusinessDate,
};
