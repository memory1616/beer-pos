/**
 * DebtCommandService — Parser & xử lý lệnh `+` / `-` trong nhóm Zalo
 * ─────────────────────────────────────────────────────────────────────────────
 * Cú pháp (duy nhất được chấp nhận):
 *   `+1000`  → ghi nhận thanh toán 1.000.000đ (GIẢM công nợ)
 *   `-1000`  → ghi nhận nợ phát sinh thêm 1.000.000đ (TĂNG công nợ)
 *
 * Quy ước:
 *  - Đơn vị nhập = NGHÌN ĐỒNG. `1000` = 1.000.000đ.
 *  - Chỉ NHÂN VIÊN ĐƯỢC PHÂN QUYỀN mới ghi được.
 *  - Tự động xác định `customerId` từ nhóm Zalo đã liên kết.
 *  - Lưu senderId, thời gian, messageId, số tiền, nội dung.
 *  - Không cho phép giao dịch trùng messageId.
 *  - Không cho phép xoá giao dịch đã ghi nhận (chỉ đảo bằng bút toán mới).
 *
 * Tin nhắn KHÔNG hợp lệ (bị từ chối, KHÔNG ghi gì):
 *   `++1000`, `+0`, `+-1000`, `+abc`, `+ 1 000`, giá trị vượt hạn mức,
 *   tin nhắn không đúng cú pháp.
 */

const db = require('../../../database');
const logger = require('../../utils/logger');
const DebtLedgerService = require('./DebtLedgerService');
const DebtPermissionService = require('./DebtPermissionService');
const DebtAuditService = require('./DebtAuditService');
const {
  TRANSACTION_TYPES,
  SOURCES,
  REFERENCE_TYPES,
  EVENT_TYPES,
  PLATFORMS,
  BRIDGE_STATUS,
  DEFAULT_MAX_COMMAND_AMOUNT,
  DEFAULT_COMMAND_UNIT,
} = require('./constants');

// Cú pháp: dấu + hoặc - ở đầu, theo sau là 1..N chữ số (không có khoảng trắng
// bên trong, không có dấu phẩy, không có dấu thập phân).
const COMMAND_REGEX = /^([+-])(\d{1,15})$/;

const ERROR_CODES = {
  NOT_A_COMMAND: 'NOT_A_COMMAND',
  INVALID_FORMAT: 'INVALID_FORMAT',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  AMOUNT_TOO_LARGE: 'AMOUNT_TOO_LARGE',
  GROUP_NOT_LINKED: 'GROUP_NOT_LINKED',
  NO_PERMISSION: 'NO_PERMISSION',
  DUPLICATE_MESSAGE: 'DUPLICATE_MESSAGE',
  UNKNOWN_SENDER: 'UNKNOWN_SENDER',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  LEDGER_ERROR: 'LEDGER_ERROR',
};

/**
 * Lấy setting (có fallback).
 */
function getSetting(key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row || row.value === null || row.value === undefined || row.value === '') {
      return fallback;
    }
    return String(row.value);
  } catch (_) {
    return fallback;
  }
}

/** Đơn vị quy đổi: 1 đơn vị lệnh = `unit` nghìn đồng. */
function getCommandUnit() {
  const unit = parseInt(getSetting('debt_command_unit', DEFAULT_COMMAND_UNIT), 10);
  return Number.isFinite(unit) && unit > 0 ? unit : DEFAULT_COMMAND_UNIT;
}

/** Hạn mức tối đa cho 1 lệnh (tính theo ĐƠN VỊ LỆNH, không phải VND). */
function getMaxCommandAmount() {
  const max = parseInt(
    getSetting('debt_command_max_amount', DEFAULT_MAX_COMMAND_AMOUNT),
    10
  );
  return Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_COMMAND_AMOUNT;
}

/**
 * Parse nội dung tin nhắn thành lệnh.
 *
 * @param {string} content
 * @param {object} [opts] { unit }
 * @returns {{valid:boolean, code?:string, sign?:'+'|'-', units?:number, amount?:number, error?:string}}
 */
function parseCommand(content, opts = {}) {
  if (typeof content !== 'string') {
    return { valid: false, code: ERROR_CODES.INVALID_FORMAT, error: 'Nội dung tin nhắn không hợp lệ' };
  }

  // Cho phép khoảng trắng trước/sau lệnh
  const trimmed = content.trim();

  if (!trimmed) {
    return { valid: false, code: ERROR_CODES.NOT_A_COMMAND, error: 'Tin nhắn rỗng' };
  }

  const m = COMMAND_REGEX.exec(trimmed);
  if (!m) {
    // Phân biệt "không phải lệnh" vs "sai định dạng lệnh" để hướng dẫn đúng
    const looksLikeCommand = /^[+-]/.test(trimmed);
    return {
      valid: false,
      code: looksLikeCommand ? ERROR_CODES.INVALID_FORMAT : ERROR_CODES.NOT_A_COMMAND,
      error: looksLikeCommand
        ? 'Cú pháp sai. Ví dụ hợp lệ: +1000 hoặc -1000'
        : 'Tin nhắn không phải lệnh thanh toán',
    };
  }

  const sign = m[1];
  const units = parseInt(m[2], 10);

  if (!Number.isFinite(units) || units <= 0) {
    return { valid: false, code: ERROR_CODES.INVALID_AMOUNT, error: 'Số tiền phải lớn hơn 0' };
  }

  const max = opts.max !== undefined ? opts.max : getMaxCommandAmount();
  if (units > max) {
    return {
      valid: false,
      code: ERROR_CODES.AMOUNT_TOO_LARGE,
      error: `Số tiền vượt hạn mức cho phép (tối đa ${max.toLocaleString('vi-VN')} nghìn đồng/lệnh)`,
      units,
    };
  }

  const unit = opts.unit !== undefined ? opts.unit : getCommandUnit();
  const amount = units * unit;

  return { valid: true, sign, units, amount };
}

/**
 * Tìm khách hàng theo groupId của Zalo.
 */
function findCustomerByGroup(groupId, platform = PLATFORMS.ZALO_PERSONAL) {
  if (!groupId) return null;
  try {
    const row = db
      .prepare(
        `SELECT customer_id, group_name, status FROM debt_customer_groups
          WHERE platform = ? AND group_id = ?`
      )
      .get(platform, String(groupId));
    if (!row) return null;
    return row;
  } catch (e) {
    logger.error('[DEBT_CMD] findCustomerByGroup error', { error: e.message });
    return null;
  }
}

/**
 * Kiểm tra messageId đã được xử lý chưa (chống giao dịch trùng).
 */
function isMessageProcessed(platform, messageId) {
  if (!messageId) return false;
  try {
    const row = db
      .prepare(
        'SELECT id FROM debt_bridge_events WHERE platform = ? AND message_id = ?'
      )
      .get(platform, String(messageId));
    return !!row;
  } catch (_) {
    return false;
  }
}

/**
 * Ghi nhận 1 tin nhắn vào `debt_bridge_events` (nhật ký adapter).
 */
function logBridgeEvent(entry) {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO debt_bridge_events
         (platform, group_id, sender_id, message_id, content, received_at, status, result)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)`
    ).run(
      entry.platform || PLATFORMS.ZALO_PERSONAL,
      entry.groupId || null,
      entry.senderId || null,
      entry.messageId || null,
      entry.content || null,
      entry.status || BRIDGE_STATUS.RECEIVED,
      entry.result || null
    );
  } catch (e) {
    logger.error('[DEBT_CMD] logBridgeEvent error', { error: e.message });
  }
}

/**
 * Cập nhật trạng thái xử lý của 1 event trong `debt_bridge_events`.
 */
function updateBridgeStatus(platform, messageId, status, result = null) {
  try {
    db.prepare(
      'UPDATE debt_bridge_events SET status = ?, result = ? WHERE platform = ? AND message_id = ?'
    ).run(status, result, platform || PLATFORMS.ZALO_PERSONAL, String(messageId));
  } catch (e) {
    logger.error('[DEBT_CMD] updateBridgeStatus error', { error: e.message });
  }
}

/**
 * Xử lý 1 tin nhắn lệnh `+` / `-` từ nhóm Zalo.
 *
 * @param {object} message
 * @param {string} message.messageId  - bắt buộc
 * @param {string} message.groupId    - bắt buộc
 * @param {string} message.senderId   - bắt buộc
 * @param {string} message.content    - nội dung tin nhắn
 * @param {number|string} [message.timestamp]
 * @param {string} [message.platform]
 * @param {string} [message.customerId] - ghi đè customerId (dùng cho UI/test)
 * @returns {{success:boolean, code?:string, error?:string, reply?:string, data?:object}}
 */
function handleMessage(message = {}) {
  const platform = message.platform || PLATFORMS.ZALO_PERSONAL;
  const { messageId, groupId, senderId, content } = message;

  // 1. Validate message
  if (!messageId || !groupId || !senderId) {
    return {
      success: false,
      code: ERROR_CODES.INVALID_MESSAGE,
      error: 'Thiếu messageId, groupId hoặc senderId',
    };
  }

  // 2. Chống xử lý trùng messageId
  if (isMessageProcessed(platform, messageId)) {
    return {
      success: false,
      code: ERROR_CODES.DUPLICATE_MESSAGE,
      error: 'Tin nhắn này đã được xử lý trước đó',
    };
  }

  // 3. Parse lệnh
  const parsed = parseCommand(content);
  if (!parsed.valid) {
    logBridgeEvent({
      platform,
      groupId,
      senderId,
      messageId,
      content,
      status: BRIDGE_STATUS.REJECTED,
      result: parsed.code,
    });
    return {
      success: false,
      code: parsed.code,
      error: parsed.error,
      reply: buildHelpReply(parsed.error),
    };
  }

  // 4. Xác định khách hàng từ group mapping
  let customerId = message.customerId ? parseInt(message.customerId, 10) : null;
  if (!customerId) {
    const mapping = findCustomerByGroup(groupId, platform);
    if (!mapping) {
      logBridgeEvent({
        platform,
        groupId,
        senderId,
        messageId,
        content,
        status: BRIDGE_STATUS.REJECTED,
        result: ERROR_CODES.GROUP_NOT_LINKED,
      });
      return {
        success: false,
        code: ERROR_CODES.GROUP_NOT_LINKED,
        error: 'Nhóm Zalo này chưa được liên kết với khách hàng nào',
        reply: buildHelpReply('Nhóm Zalo chưa được liên kết với khách hàng nào.'),
      };
    }
    customerId = mapping.customer_id;
  }

  // 5. Kiểm tra quyền nhân viên
  const sender = { username: senderId, role: message.senderRole || null };
  const isPayment = parsed.sign === '+';
  const allowed = isPayment
    ? DebtPermissionService.canRecordPayment(sender, customerId)
    : DebtPermissionService.canRecordManualDebt(sender, customerId);

  if (!allowed) {
    logBridgeEvent({
      platform,
      groupId,
      senderId,
      messageId,
      content,
      status: BRIDGE_STATUS.REJECTED,
      result: ERROR_CODES.NO_PERMISSION,
    });
    return {
      success: false,
      code: ERROR_CODES.NO_PERMISSION,
      error: 'Bạn không có quyền ghi nhận giao dịch công nợ cho khách hàng này',
      reply: buildHelpReply('Bạn không có quyền ghi nhận giao dịch công nợ cho khách hàng này.'),
    };
  }

  // 6. Ghi bút toán
  const balanceBefore = DebtLedgerService.computeBalance(customerId);
  const result = DebtLedgerService.recordTransaction({
    customerId,
    transactionType: isPayment ? TRANSACTION_TYPES.PAYMENT : TRANSACTION_TYPES.MANUAL_DEBT,
    amount: parsed.amount,
    direction: isPayment
      ? DebtLedgerService.DIRECTION.DECREASE
      : DebtLedgerService.DIRECTION.INCREASE,
    referenceType: REFERENCE_TYPES.NONE,
    referenceId: null,
    description: isPayment
      ? `Thanh toán qua lệnh +${parsed.units} (${messageId})`
      : `Ghi nợ tay qua lệnh -${parsed.units} (${messageId})`,
    createdBy: senderId,
    source: message.source || SOURCES.ZALO,
    idempotencyKey: `zalo:${platform}:${messageId}`,
    allowNegativeBalance: !isPayment,
  });

  if (!result.success) {
    logBridgeEvent({
      platform,
      groupId,
      senderId,
      messageId,
      content,
      status: BRIDGE_STATUS.FAILED,
      result: result.error,
    });
    return {
      success: false,
      code: ERROR_CODES.LEDGER_ERROR,
      error: result.error,
      reply: buildHelpReply(`Không ghi được giao dịch: ${result.error}`),
    };
  }

  // 7. Đánh dấu event đã xử lý (chống webhook lặp / restart)
  try {
    DebtLedgerService.markEventProcessed(
      isPayment ? EVENT_TYPES.COMMAND_PAYMENT : EVENT_TYPES.COMMAND_MANUAL_DEBT,
      String(messageId)
    );
  } catch (_) {
    /* ignore */
  }

  // 8. Audit log — action riêng (COMMAND) để phân biệt với CREATE của ledger
  //    (ledger đã ghi 1 bản ghi CREATE; bản này bổ sung ngữ cảnh lệnh + messageId)
  DebtAuditService.record({
    transactionId: result.transactionId,
    action: DebtAuditService.AUDIT_ACTIONS.COMMAND,
    actorId: senderId,
    beforeData: { balance: balanceBefore, source: platform, messageId, groupId },
    afterData: {
      balance: result.balanceAfter,
      amount: parsed.amount,
      sign: parsed.sign,
      units: parsed.units,
      messageId,
    },
  });

  // 9. Ghi nhật ký bridge
  logBridgeEvent({
    platform,
    groupId,
    senderId,
    messageId,
    content,
    status: BRIDGE_STATUS.PROCESSED,
    result: `${parsed.sign}${parsed.units} → ${result.transactionId}`,
  });

  // 10. Trả lời (chỉ gửi sau khi transaction đã COMMIT)
  const customer = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
  const reply = buildResultReply({
    sign: parsed.sign,
    units: parsed.units,
    amount: parsed.amount,
    customerName: customer?.name || '',
    senderId,
    balanceBefore,
    balanceAfter: result.balanceAfter,
  });

  return {
    success: true,
    reply,
    data: {
      transactionId: result.transactionId,
      customerId,
      sign: parsed.sign,
      units: parsed.units,
      amount: parsed.amount,
      balanceBefore,
      balanceAfter: result.balanceAfter,
      senderId,
      messageId,
    },
  };
}

/**
 * Dựng nội dung phản hồi khi ghi nhận thành công.
 */
function buildResultReply({
  sign,
  units,
  amount,
  customerName,
  senderId,
  balanceBefore,
  balanceAfter,
}) {
  const money = (n) => `${Number(n || 0).toLocaleString('vi-VN')}đ`;
  const lines = ['SỔ CÔNG NỢ GIA HUY', ''];

  if (sign === '+') {
    lines.push('ĐÃ GHI NHẬN THANH TOÁN');
  } else {
    lines.push('ĐÃ GHI NHẬN PHÁT SINH CÔNG NỢ');
  }

  lines.push('');
  lines.push(`Khách hàng: ${customerName || '—'}`);
  lines.push(
    sign === '+'
      ? `Số tiền đã thu: ${money(amount)}`
      : `Số tiền ghi nợ: ${money(amount)}`
  );
  lines.push(`Người xác nhận: ${senderId || '—'}`);
  lines.push(`Công nợ trước: ${money(balanceBefore)}`);
  lines.push(`Công nợ hiện tại: ${money(balanceAfter)}`);

  return lines.join('\n');
}

/**
 * Dựng hướng dẫn khi tin nhắn không hợp lệ / bị từ chối.
 */
function buildHelpReply(reason) {
  return [
    'SỔ CÔNG NỢ GIA HUY',
    '',
    'Chưa ghi nhận giao dịch.',
    `Lý do: ${reason}`,
    '',
    'Cú pháp hợp lệ:',
    '  +1000  → ghi nhận khách thanh toán 1.000.000đ',
    '  -1000  → ghi nhận phát sinh thêm 1.000.000đ',
    '(Đơn vị nhập là nghìn đồng)',
  ].join('\n');
}

module.exports = {
  ERROR_CODES,
  COMMAND_REGEX,
  parseCommand,
  handleMessage,
  findCustomerByGroup,
  isMessageProcessed,
  logBridgeEvent,
  updateBridgeStatus,
  buildResultReply,
  buildHelpReply,
  getCommandUnit,
  getMaxCommandAmount,
};
