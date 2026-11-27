/**
 * NotificationProviderFactory — Chọn provider theo cấu hình
 * ─────────────────────────────────────────────────────────────────────────────
 * Provider hiện có:
 *  - 'mock'    : MockZaloAdapter — mô phỏng cho LOCAL DEVELOPMENT / test.
 *  - 'omicall' : OmniCallAdapter — provider đang chạy production.
 *
 * Provider tương lai:
 *  - Chỉ được thêm vào SAU khi có API hợp lệ & được xác minh thực tế.
 *    Không viết connector giả lập, không reverse-engineer giao thức riêng tư,
 *    không điều khiển app Zalo.
 *
 * ƯU TIÊN CẤU HÌNH:
 *  1. `process.env.NOTIFICATION_PROVIDER` (dễ ghi đè khi chạy local/test)
 *  2. `settings.debt_notify_provider` (cấu hình trong UI)
 *  3. Mặc định: 'omicall' — GIỮ NGUYÊN hành vi production hiện tại.
 *
 * ⚠️ Vì sao mặc định là 'omicall' chứ không phải 'mock'?
 *  Mặc định 'mock' sẽ khiến hệ thống NGỪNG gửi tin thật khi ai đó cài lại /
 *  deploy mà quên set biến môi trường → mất thông báo cho khách. Giữ mặc định
 *  là provider đang chạy (omicall) an toàn hơn; muốn chạy local thì BẬT TẮT
 *  rõ ràng qua `NOTIFICATION_PROVIDER=mock` hoặc `debt_notify_provider=mock`.
 *
 * ⚠️ Provider MOCK mô phỏng — KHÔNG gửi tin thật vào Zalo.
 */

const logger = require('../../../utils/logger');
const db = require('../../../../database');
const { MockZaloAdapter } = require('./MockZaloAdapter');
const { OmniCallAdapter } = require('./OmniCallAdapter');

/** Tên provider hợp lệ. */
const PROVIDERS = {
  MOCK: 'mock',
  OMICALL: 'omicall',
};

const registry = new Map();

/** Đọc setting `debt_notify_provider`. */
function getConfiguredProviderName() {
  const fromEnv = String(process.env.NOTIFICATION_PROVIDER || '').trim().toLowerCase();
  if (fromEnv) return fromEnv;

  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('debt_notify_provider');
    const val = row && row.value ? String(row.value).trim().toLowerCase() : '';
    if (val) return val;
  } catch (_) {
    /* ignore */
  }

  // Mặc định: 'omicall' — giữ nguyên hành vi production hiện tại.
  return PROVIDERS.OMICALL;
}

/** Tạo instance provider theo tên (không cache). */
function createProvider(name) {
  switch (name) {
    case PROVIDERS.OMICALL:
      return new OmniCallAdapter();
    case PROVIDERS.MOCK:
    default:
      return new MockZaloAdapter();
  }
}

/**
 * Lấy provider đang cấu hình (singleton theo tên).
 * @param {string} [name] - ép dùng provider cụ thể
 */
function getProvider(name) {
  const target = String(name || getConfiguredProviderName() || PROVIDERS.MOCK)
    .trim()
    .toLowerCase();

  if (!registry.has(target)) {
    const instance = createProvider(target);
    registry.set(target, instance);
    logger.info('[NOTIFY] Provider khởi tạo', {
      provider: target,
      simulated: target === PROVIDERS.MOCK,
    });
  }
  return registry.get(target);
}

/** Xoá cache provider (dùng trong test / sau khi đổi cấu hình). */
function resetProviders() {
  registry.clear();
}

/**
 * Tên provider đang dùng (để ghi vào DB).
 */
function getProviderName() {
  return String(getConfiguredProviderName() || PROVIDERS.MOCK).trim().toLowerCase();
}

/**
 * Provider có phải bản mô phỏng không (để UI cảnh báo).
 */
function isSimulated(name) {
  return String(name || getProviderName()).trim().toLowerCase() === PROVIDERS.MOCK;
}

module.exports = {
  PROVIDERS,
  getProvider,
  getProviderName,
  getConfiguredProviderName,
  isSimulated,
  resetProviders,
  createProvider,
};
