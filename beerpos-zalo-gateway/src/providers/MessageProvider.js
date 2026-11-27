/**
 * MessageProvider — Interface chuan cho moi phuong thuc gui tin.
 * ─────────────────────────────────────────────────────────────────────────────
 * KHONG implement gi cao — chi dinh nghia contract.
 *
 * Provider bat buoc tu chon:
 *  - KHONG reverse-engineer giao thuc rieng cua Zalo.
 *  - KHONG tu dong QR login.
 *  - KHONG luu mat khau / cookie / token ca nhan trong database.
 *  - KHONG tao trang thai "gui thanh cong" gia.
 */

const ERROR_CODES = {
  SUCCESS: 'OK',
  CONFIG_ERROR: 'CONFIG_ERROR',
  INVALID_DESTINATION: 'INVALID_DESTINATION',
  TEMPORARY_ERROR: 'TEMPORARY_ERROR',
  PERMANENT_ERROR: 'PERMANENT_ERROR',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
  DISABLED: 'DISABLED',
};

/** Delivery status — phan biet "da chap nhan" voi "da den". */
const DELIVERY_STATUS = {
  ACCEPTED: 'accepted',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
};

/**
 * Chu hoa ket qua provider.
 * @param {object} r
 * @returns {object} ProviderResult
 */
function makeResult(r = {}) {
  return {
    success: r.success === true,
    providerMessageId: r.providerMessageId || null,
    errorCode: r.errorCode || (r.success ? ERROR_CODES.SUCCESS : ERROR_CODES.UNKNOWN),
    errorMessage: r.errorMessage || null,
    acceptedAt: r.acceptedAt || null,
    deliveryStatus: r.deliveryStatus || DELIVERY_STATUS.UNKNOWN,
    retryable: r.retryable === true,
    simulated: r.simulated === true,
    raw: r.raw || null,
  };
}

class MessageProvider {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {boolean} [opts.available]
   * @param {boolean} [opts.simulated] - true neu provider chi mo phong
   * @param {string} [opts.reason]
   */
  constructor(opts = {}) {
    this.name = opts.name || 'base';
    this.available = opts.available !== false;
    this.simulated = opts.simulated === true;
    this.reason = opts.reason || '';
  }

  /** Trang thai provider. */
  // eslint-disable-next-line no-unused-vars
  async getStatus() {
    return {
      provider: this.name,
      available: this.available,
      simulated: this.simulated,
      reason: this.reason,
    };
  }

  /**
   * Kiem tra dinh chi cua nhom truoc khi gui.
   * @param {string} destination
   * @returns {{valid:boolean, code?:string, message?:string}}
   */
  // eslint-disable-next-line no-unused-vars
  validateDestination(destination) {
    return { valid: true };
  }

  /**
   * Gui tin nhan.
   * @param {object} payload { groupId, text, groupName, customerId, paymentId }
   * @returns {Promise<object>} ProviderResult
   */
  // eslint-disable-next-line no-unused-vars
  async sendMessage(payload) {
    return makeResult({
      success: false,
      errorCode: ERROR_CODES.CONFIG_ERROR,
      errorMessage: 'Provider chua cai dat sendMessage()',
      retryable: false,
    });
  }

  /** Nang luc cua provider. */
  getCapabilities() {
    return {
      sendMessage: true,
      deliveryConfirmation: false,
      supportsGroup: true,
      maxLength: 2000,
    };
  }
}

module.exports = { MessageProvider, makeResult, ERROR_CODES, DELIVERY_STATUS };
