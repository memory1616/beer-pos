const { config } = require('../config');
const { MessageProvider, makeResult, ERROR_CODES, DELIVERY_STATUS } = require('./MessageProvider');
const MockProvider = require('./MockProvider');

/**
 * Provider cho phep gui Zalo CHINH THUC phai duoc Zalo cap quyen
 * (vi du: Zalo OA OpenAPI, hoac nha cung cap da duoc uy quyen).
 *
 * TAI GIAI DOAN NAY KHONG CO PROVIDER NAO DUOC CAP QUYEN ->
 * chi co MockProvider. Khong tu tao ZaloProvider dung giao thuc khong chinh thuc.
 */

class UnauthorizedProvider extends MessageProvider {
  constructor() {
    super({
      name: 'unauthorized',
      available: false,
      reason:
        'Chua cau hinh nha cung cap Zalo duoc cap quyen. ' +
        'Hien chi ho tro MockProvider (mo phong) de kiem thu.',
    });
  }

  async getStatus() {
    return {
      provider: this.name,
      available: false,
      simulated: false,
      reason: this.reason,
      capabilities: this.getCapabilities(),
    };
  }

  async sendMessage() {
    return makeResult({
      success: false,
      errorCode: ERROR_CODES.DISABLED,
      errorMessage: this.reason,
      deliveryStatus: DELIVERY_STATUS.FAILED,
      retryable: false,
    });
  }

  getCapabilities() {
    return {
      sendMessage: false,
      deliveryConfirmation: false,
      supportsGroup: false,
      maxLength: 0,
    };
  }
}

/**
 * Tao provider theo ten.
 * @param {string} name
 * @param {object} [opts]
 */
function createProvider(name, opts = {}) {
  const n = String(name || config.provider.name || 'mock')
    .trim()
    .toLowerCase();

  if (n === 'mock') {
    return new MockProvider({
      scenario: opts.scenario || config.provider.mockScenario,
      delayMs: opts.delayMs !== undefined ? opts.delayMs : config.provider.mockDelayMs,
    });
  }

  // Tuoi lai: khi co nha cung cap duoc cap quyen, them nhanh tai day.
  return new UnauthorizedProvider();
}

module.exports = { createProvider, MockProvider, UnauthorizedProvider };
