const { MessageProvider, makeResult, ERROR_CODES, DELIVERY_STATUS } = require('./MessageProvider');

/**
 * MockProvider — chi dung cho KIEM THU.
 * ─────────────────────────────────────────────────────────────────────────────
 * KHONG goi mang. KHONG bao gio tra `delivered`.
 * Tien to `mock_` cho providerMessageId de phan biet ngay khi nhin log/UI.
 *
 * Scenario:
 *  - success            : gui thanh cong (accepted)
 *  - failure            : loi vinh vien (permanent, khong retry)
 *  - transient          : loi tam thoi (retryable)
 *  - timeout            : khong ro ket qua (unknown -> KHONG tu retry)
 *  - invalid_destination: dinh chi sai (permanent)
 */

const SCENARIOS = [
  'success',
  'failure',
  'transient',
  'timeout',
  'invalid_destination',
];

class MockProvider extends MessageProvider {
  constructor(opts = {}) {
    super({
      name: 'mock',
      available: true,
      simulated: true,
      reason: 'Mock provider - chi mo phong, KHONG gui that den Zalo',
    });
    this.scenario = MockProvider.normalizeScenario(opts.scenario);
    this.delayMs = opts.delayMs !== undefined ? opts.delayMs : 10;
    this.counter = 0;
  }

  static normalizeScenario(value) {
    const v = String(value || 'success').trim().toLowerCase();
    return SCENARIOS.includes(v) ? v : 'success';
  }

  async getStatus() {
    return {
      provider: this.name,
      available: true,
      simulated: true,
      scenario: this.scenario,
      reason: this.reason,
      capabilities: this.getCapabilities(),
    };
  }

  validateDestination(destination) {
    const dest = String(destination || '').trim();
    if (!dest) {
      return {
        valid: false,
        code: ERROR_CODES.INVALID_DESTINATION,
        message: 'Thieu Group ID',
      };
    }
    if (this.scenario === 'invalid_destination') {
      return {
        valid: false,
        code: ERROR_CODES.INVALID_DESTINATION,
        message: 'Dinh chi khong hop le (mock scenario)',
      };
    }
    if (dest.length > 256) {
      return {
        valid: false,
        code: ERROR_CODES.INVALID_DESTINATION,
        message: 'Group ID qua dai',
      };
    }
    return { valid: true };
  }

  async sendMessage(payload = {}) {
    const text = String(payload.text || '').trim();
    const groupId = String(payload.groupId || '').trim();

    const check = this.validateDestination(groupId);
    if (!check.valid) {
      return makeResult({
        success: false,
        errorCode: check.code,
        errorMessage: check.message,
        deliveryStatus: DELIVERY_STATUS.FAILED,
        retryable: false,
        simulated: true,
        raw: { mock: true, scenario: this.scenario },
      });
    }

    if (!text) {
      return makeResult({
        success: false,
        errorCode: ERROR_CODES.INVALID_DESTINATION,
        errorMessage: 'Thieu noi dung tin nhan',
        deliveryStatus: DELIVERY_STATUS.FAILED,
        retryable: false,
        simulated: true,
      });
    }

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    this.counter += 1;
    const providerMessageId = `mock_${Date.now()}_${this.counter}`;

    switch (this.scenario) {
      case 'failure':
        return makeResult({
          success: false,
          providerMessageId,
          errorCode: ERROR_CODES.PERMANENT_ERROR,
          errorMessage: 'Mock: gui that bai (permanent error)',
          deliveryStatus: DELIVERY_STATUS.FAILED,
          retryable: false,
          simulated: true,
          raw: { mock: true, scenario: this.scenario },
        });

      case 'transient':
        return makeResult({
          success: false,
          providerMessageId,
          errorCode: ERROR_CODES.TEMPORARY_ERROR,
          errorMessage: 'Mock: loi tam thoi, duoc retry',
          deliveryStatus: DELIVERY_STATUS.FAILED,
          retryable: true,
          simulated: true,
          raw: { mock: true, scenario: this.scenario },
        });

      case 'timeout':
        // Khong ro tin nhan da gui hay chua -> KHONG retry tu dong.
        return makeResult({
          success: false,
          providerMessageId,
          errorCode: ERROR_CODES.TIMEOUT,
          errorMessage: 'Mock: timeout - khong xac dinh da gui hay chua',
          deliveryStatus: DELIVERY_STATUS.UNKNOWN,
          retryable: false,
          simulated: true,
          raw: { mock: true, scenario: this.scenario, uncertain: true },
        });

      case 'invalid_destination':
        return makeResult({
          success: false,
          providerMessageId,
          errorCode: ERROR_CODES.INVALID_DESTINATION,
          errorMessage: 'Mock: dinh chi khong hop le',
          deliveryStatus: DELIVERY_STATUS.FAILED,
          retryable: false,
          simulated: true,
        });

      case 'success':
      default:
        return makeResult({
          success: true,
          providerMessageId,
          errorCode: ERROR_CODES.SUCCESS,
          errorMessage: null,
          acceptedAt: new Date().toISOString(),
          // Provider khong co API doi soat -> chi "da chap nhan", KHONG "da den".
          deliveryStatus: DELIVERY_STATUS.ACCEPTED,
          retryable: false,
          simulated: true,
          raw: { mock: true, scenario: this.scenario, accepted: true },
        });
    }
  }

  getCapabilities() {
    return {
      sendMessage: true,
      deliveryConfirmation: false,
      supportsGroup: true,
      maxLength: 2000,
      simulated: true,
    };
  }
}

MockProvider.SCENARIOS = SCENARIOS;

module.exports = MockProvider;
