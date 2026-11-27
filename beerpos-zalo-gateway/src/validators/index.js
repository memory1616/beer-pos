const { badRequest } = require('../utils/errors');
const { config } = require('../config');

/**
 * Validators dung chung.
 * KHONG dung thu vien ngoai.
 */

function isNonEmptyString(v, maxLen) {
  return (
    typeof v === 'string' &&
    v.trim().length > 0 &&
    v.trim().length <= (maxLen || config.limits.maxNameLength)
  );
}

function isOptionalString(v, maxLen) {
  if (v === undefined || v === null || v === '') return true;
  return typeof v === 'string' && v.length <= (maxLen || config.limits.maxNameLength);
}

/**
 * Validate body cho tao/cap nhat nhom.
 * @param {object} body
 * @param {object} opts { partial }
 */
function validateGroupBody(body, opts = {}) {
  const errors = [];
  const b = body || {};

  if (!opts.partial || b.customerId !== undefined) {
    if (!isNonEmptyString(b.customerId, config.limits.maxCustomerIdLength)) {
      errors.push({
        field: 'customerId',
        message: 'Customer ID la bat buoc va phai khong qua dai',
      });
    }
  }

  if (!opts.partial || b.groupId !== undefined) {
    if (!isNonEmptyString(b.groupId, config.limits.maxGroupIdLength)) {
      errors.push({
        field: 'groupId',
        message: 'Group ID la bat buoc va phai khong qua dai',
      });
    }
  }

  if (!isOptionalString(b.customerName, config.limits.maxNameLength)) {
    errors.push({ field: 'customerName', message: 'Ten khach hang qua dai' });
  }
  if (!isOptionalString(b.groupName, config.limits.maxNameLength)) {
    errors.push({ field: 'groupName', message: 'Ten nhom qua dai' });
  }
  if (!isOptionalString(b.note, config.limits.maxNoteLength)) {
    errors.push({ field: 'note', message: 'Ghi chu qua dai' });
  }
  if (b.isActive !== undefined && typeof b.isActive !== 'boolean') {
    errors.push({ field: 'isActive', message: 'isActive phai la boolean' });
  }

  if (errors.length) {
    throw badRequest(errors.map((e) => e.message).join('; '), 'VALIDATION_ERROR', { errors });
  }
  return true;
}

/**
 * Validate body cho gui tin.
 */
function validateMessageBody(body) {
  const errors = [];
  const b = body || {};

  if (!isNonEmptyString(b.customerId, config.limits.maxCustomerIdLength)) {
    errors.push({ field: 'customerId', message: 'customerId la bat buoc' });
  }

  const msg = typeof b.message === 'string' ? b.message.trim() : '';
  if (!msg) {
    errors.push({ field: 'message', message: 'message khong duoc de trong' });
  } else if (msg.length > config.limits.maxMessageLength) {
    errors.push({
      field: 'message',
      message: `message qua dai (toi da ${config.limits.maxMessageLength} ky tu)`,
    });
  }

  if (b.paymentId !== undefined && b.paymentId !== null && typeof b.paymentId !== 'string') {
    errors.push({ field: 'paymentId', message: 'paymentId phai la chuoi' });
  }

  if (errors.length) {
    throw badRequest(errors.map((e) => e.message).join('; '), 'VALIDATION_ERROR', { errors });
  }
  return true;
}

/** Parse page/limit tu query. */
function parsePaging(query = {}) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  return { page, limit };
}

module.exports = {
  validateGroupBody,
  validateMessageBody,
  parsePaging,
  isNonEmptyString,
  isOptionalString,
};
