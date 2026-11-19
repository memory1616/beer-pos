/**
 * THÔNG BÁO CÔNG NỢ ZALO QUA OMICALL — unit test
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi test:
 *  - Migration 062: bảng `debt_notifications` + settings OmiCall.
 *  - OmiCallService:
 *      • getConfig / saveConfig / getPublicConfig (mask API key)
 *      • getAccessToken: parse payload.access_token, cache 24h
 *      • sendZaloPersonalMessage: POST /omni_conv/message/send_text?lng=vi
 *        với body { convId, text }
 *      • Xử lý lỗi HTTP / status_code khác 9999
 *  - DebtNotifyService:
 *      • buildPaymentMessage (đủ/thiếu/dư)
 *      • notifyPayment: tìm convId từ debt_customer_groups, ghi log sent/failed
 *      • Bỏ qua khi khách chưa liên kết nhóm / chưa bật
 *      • Idempotent: không gửi 2 lần cho cùng transaction_id
 */
process.env.NODE_ENV = 'test';

const db = require('../../database');
const OmiCallService = require('../../src/services/OmiCallService');
const DebtNotifyService = require('../../src/services/debt/DebtNotifyService');

jest.setTimeout(20000);

// ── Helpers ──────────────────────────────────────────────────────────────────
let seq = 0;
const createdCustomers = [];
const createdGroups = [];

function makeCustomer(nameSuffix) {
  seq += 1;
  const name = `__NOTIFY_TEST_${nameSuffix}_${Date.now()}_${seq}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name);
  createdCustomers.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function makeGroup(customerId, groupId) {
  const info = db
    .prepare(
      `INSERT INTO debt_customer_groups (customer_id, platform, group_id, group_name, status)
       VALUES (?, 'zalo_personal', ?, ?, 'active')`
    )
    .run(customerId, groupId, `Group ${groupId}`);
  createdGroups.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function readSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

const savedSettings = {};
function snapshotSettings() {
  ['omicall_api_key', 'omicall_base_url', 'debt_notify_enabled', 'debt_notify_channel',
    'debt_notify_manual_debt', 'debt_notify_title'].forEach((k) => {
    savedSettings[k] = readSetting(k);
  });
}

function restoreSettings() {
  Object.keys(savedSettings).forEach((k) => {
    const v = savedSettings[k];
    if (v === null || v === undefined) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(k);
    } else {
      setSetting(k, v);
    }
  });
}

/** Mock fetch trả về JSON. */
function mockFetch(handler) {
  global.fetch = jest.fn(handler);
  return global.fetch;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────
beforeAll(() => {
  snapshotSettings();
  setSetting('omicall_api_key', 'TEST_KEY_123');
  setSetting('omicall_base_url', 'https://public-v1.omicall.com');
  setSetting('debt_notify_enabled', '1');
  setSetting('debt_notify_channel', 'omicall_zalo_personal');
  setSetting('debt_notify_manual_debt', '0');
  setSetting('debt_notify_title', 'BIA TƯƠI — Cập nhật công nợ');
  OmiCallService.clearTokenCache();
});

afterAll(() => {
  restoreSettings();
  OmiCallService.clearTokenCache();
  if (global.fetch && global.fetch.mockRestore) global.fetch.mockRestore();
  createdGroups.forEach((id) => db.prepare('DELETE FROM debt_customer_groups WHERE id = ?').run(id));
  createdCustomers.forEach((id) => db.prepare('DELETE FROM customers WHERE id = ?').run(id));
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Migration 062
// ═══════════════════════════════════════════════════════════════════════════
describe('Migration 062 — bảng debt_notifications', () => {
  it('tạo bảng debt_notifications', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='debt_notifications'")
      .get();
    expect(row).toBeTruthy();
  });

  it('seed settings OmiCall', () => {
    expect(readSetting('omicall_base_url')).toBe('https://public-v1.omicall.com');
    expect(readSetting('debt_notify_channel')).toBe('omicall_zalo_personal');
    expect(readSetting('omicall_api_key')).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. OmiCallService — config
// ═══════════════════════════════════════════════════════════════════════════
describe('OmiCallService — cấu hình', () => {
  it('getConfig đọc đúng settings', () => {
    const cfg = OmiCallService.getConfig();
    expect(cfg.apiKey).toBe('TEST_KEY_123');
    expect(cfg.baseUrl).toBe('https://public-v1.omicall.com');
    expect(cfg.enabled).toBe(true);
  });

  it('getPublicConfig KHÔNG lộ api key rõ', () => {
    const pub = OmiCallService.getPublicConfig();
    expect(pub.hasApiKey).toBe(true);
    expect(pub.apiKeyMasked).toContain('••••');
    expect(pub.apiKeyMasked).not.toBe('TEST_KEY_123');
  });

  it('saveConfig giữ api key cũ khi patch.apiKey undefined', () => {
    const res = OmiCallService.saveConfig({ enabled: false });
    expect(res.success).toBe(true);
    expect(OmiCallService.getConfig().apiKey).toBe('TEST_KEY_123');
    expect(OmiCallService.getConfig().enabled).toBe(false);
    OmiCallService.saveConfig({ enabled: true });
  });

  it('saveConfig đổi base URL → bỏ dấu / cuối', () => {
    OmiCallService.saveConfig({ baseUrl: 'https://example.com/' });
    expect(OmiCallService.getConfig().baseUrl).toBe('https://example.com');
    OmiCallService.saveConfig({ baseUrl: 'https://public-v1.omicall.com' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. OmiCallService — token & gửi tin
// ═══════════════════════════════════════════════════════════════════════════
describe('OmiCallService — access token', () => {
  beforeEach(() => {
    OmiCallService.clearTokenCache();
  });

  it('lấy token từ GET /api/auth?apiKey=', async () => {
    const fetchMock = mockFetch(async (url) => {
      expect(String(url)).toContain('/api/auth?apiKey=TEST_KEY_123');
      return jsonResponse({ status_code: 9999, payload: { access_token: 'TOKEN_ABC' } });
    });

    const token = await OmiCallService.getAccessToken();
    expect(token).toBe('TOKEN_ABC');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cache token (gọi thứ 2 không gọi lại API)', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({ status_code: 9999, payload: { access_token: 'TOKEN_ABC' } })
    );
    await OmiCallService.getAccessToken();
    await OmiCallService.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('báo lỗi khi auth fail', async () => {
    mockFetch(async () => jsonResponse({ message: 'invalid api key' }, 401));
    await expect(OmiCallService.getAccessToken()).rejects.toThrow(/OmiCall auth thất bại/);
  });

  it('báo lỗi khi thiếu API key', async () => {
    const saved = readSetting('omicall_api_key');
    setSetting('omicall_api_key', '');
    await expect(OmiCallService.getAccessToken()).rejects.toThrow(/Chưa cấu hình/);
    setSetting('omicall_api_key', saved);
  });
});

describe('OmiCallService — gửi tin nhắn Zalo Personal', () => {
  beforeEach(() => {
    OmiCallService.clearTokenCache();
  });

  it('POST đúng endpoint + body { convId, text }', async () => {
    const calls = [];
    mockFetch(async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('/api/auth')) {
        return jsonResponse({ status_code: 9999, payload: { access_token: 'TOKEN_ABC' } });
      }
      return jsonResponse({ status_code: 9999, payload: { message_id: 'MSG_1' } });
    });

    const res = await OmiCallService.sendZaloPersonalMessage({
      convId: 'CONV_XYZ',
      text: 'Xin chào',
    });

    expect(res.success).toBe(true);
    expect(res.messageId).toBe('MSG_1');

    const sendCall = calls.find((c) => c.url.includes('/omni_conv/message/send_text'));
    expect(sendCall).toBeTruthy();
    expect(sendCall.url).toContain('lng=vi');
    expect(sendCall.opts.method).toBe('POST');
    expect(sendCall.opts.headers['x-api-key']).toBe('TEST_KEY_123');
    expect(JSON.parse(sendCall.opts.body)).toEqual({ convId: 'CONV_XYZ', text: 'Xin chào' });
  });

  it('thiếu convId → fail, không gọi API', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({}));
    const res = await OmiCallService.sendZaloPersonalMessage({ text: 'abc' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/convId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('status_code khác 9999 → fail', async () => {
    mockFetch(async (url) => {
      if (String(url).includes('/api/auth')) {
        return jsonResponse({ status_code: 9999, payload: { access_token: 'T' } });
      }
      return jsonResponse({ status_code: 4001, message: 'conv not found' });
    });

    const res = await OmiCallService.sendZaloPersonalMessage({
      convId: 'C1',
      text: 'abc',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/conv not found/);
  });

  it('HTTP 500 → fail', async () => {
    mockFetch(async (url) => {
      if (String(url).includes('/api/auth')) {
        return jsonResponse({ status_code: 9999, payload: { access_token: 'T' } });
      }
      return jsonResponse({ message: 'server error' }, 500);
    });

    const res = await OmiCallService.sendZaloPersonalMessage({ convId: 'C1', text: 'a' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/server error/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. DebtNotifyService — nội dung tin nhắn
// ═══════════════════════════════════════════════════════════════════════════
describe('DebtNotifyService — nội dung tin nhắn', () => {
  it('trả đúng: đã nhận + còn nợ', () => {
    const msg = DebtNotifyService.buildPaymentMessage({
      customerName: 'Anh Hùng',
      amount: 100000,
      balanceBefore: 500000,
      balanceAfter: 400000,
    });
    expect(msg).toContain('Anh Hùng');
    expect(msg).toContain('100.000đ');
    expect(msg).toContain('400.000đ');
    expect(msg).toContain('Còn nợ');
  });

  it('trả đủ: số dư 0', () => {
    const msg = DebtNotifyService.buildPaymentMessage({
      customerName: 'Chị Lan',
      amount: 200000,
      balanceBefore: 200000,
      balanceAfter: 0,
    });
    expect(msg).toContain('Đã trả hết công nợ');
  });

  it('trả dư: nêu tiền còn dư', () => {
    const msg = DebtNotifyService.buildPaymentMessage({
      customerName: 'Anh Tuấn',
      amount: 300000,
      balanceBefore: 100000,
      balanceAfter: -200000,
      credit: 200000,
    });
    expect(msg).toContain('dư');
    expect(msg).toContain('200.000đ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. DebtNotifyService — gửi & ghi log
// ═══════════════════════════════════════════════════════════════════════════
describe('DebtNotifyService — notifyPayment', () => {
  beforeEach(() => {
    OmiCallService.clearTokenCache();
    db.prepare("DELETE FROM debt_notifications WHERE customer_name LIKE '__NOTIFY_TEST_%' OR group_id LIKE 'CONV_%'").run();
  });

  it('gửi thành công + ghi log status=sent', async () => {
    const customerId = makeCustomer('sent');
    makeGroup(customerId, 'CONV_SENT');

    mockFetch(async (url) => {
      if (String(url).includes('/api/auth')) {
        return jsonResponse({ status_code: 9999, payload: { access_token: 'T' } });
      }
      return jsonResponse({ status_code: 9999, payload: { message_id: 'MSG_S' } });
    });

    const res = await DebtNotifyService.notifyPayment({
      customerId,
      customerName: 'Test Sent',
      amount: 50000,
      balanceBefore: 100000,
      balanceAfter: 50000,
      source: 'TEST',
      transactionId: null,
    });

    expect(res.status).toBe('sent');

    const log = db
      .prepare('SELECT * FROM debt_notifications WHERE customer_id = ? ORDER BY id DESC LIMIT 1')
      .get(customerId);
    expect(log.status).toBe('sent');
    expect(log.group_id).toBe('CONV_SENT');
    expect(log.content).toContain('Test Sent');
  });

  it('khách chưa liên kết nhóm → skipped, ghi log lý do', async () => {
    const customerId = makeCustomer('nogroup');
    const fetchMock = mockFetch(async () => jsonResponse({}));

    const res = await DebtNotifyService.notifyPayment({
      customerId,
      customerName: 'Test NoGroup',
      amount: 10000,
      balanceBefore: 10000,
      balanceAfter: 0,
    });

    expect(res.status).toBe('skipped');
    expect(res.error).toBe('NO_GROUP');
    expect(fetchMock).not.toHaveBeenCalled();

    const log = db
      .prepare('SELECT * FROM debt_notifications WHERE customer_id = ? ORDER BY id DESC LIMIT 1')
      .get(customerId);
    expect(log.status).toBe('skipped');
  });

  it('lỗi API → failed, KHÔNG throw', async () => {
    const customerId = makeCustomer('failed');
    makeGroup(customerId, 'CONV_FAIL');

    mockFetch(async (url) => {
      if (String(url).includes('/api/auth')) {
        return jsonResponse({ status_code: 9999, payload: { access_token: 'T' } });
      }
      return jsonResponse({ message: 'boom' }, 500);
    });

    const res = await DebtNotifyService.notifyPayment({
      customerId,
      customerName: 'Test Failed',
      amount: 10000,
      balanceBefore: 10000,
      balanceAfter: 0,
    });

    expect(res.status).toBe('failed');

    const log = db
      .prepare('SELECT * FROM debt_notifications WHERE customer_id = ? ORDER BY id DESC LIMIT 1')
      .get(customerId);
    expect(log.status).toBe('failed');
    expect(log.error).toBeTruthy();
  });

  it('tắt thông báo → skipped, không gọi API', async () => {
    const customerId = makeCustomer('disabled');
    makeGroup(customerId, 'CONV_DISABLED');
    const fetchMock = mockFetch(async () => jsonResponse({}));

    setSetting('debt_notify_enabled', '0');
    const res = await DebtNotifyService.notifyPayment({
      customerId,
      amount: 10000,
      balanceBefore: 10000,
      balanceAfter: 0,
    });
    setSetting('debt_notify_enabled', '1');

    expect(res.status).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('idempotent: cùng transaction_id không gửi 2 lần', async () => {
    const customerId = makeCustomer('idem');
    makeGroup(customerId, 'CONV_IDEM');

    const fetchMock = mockFetch(async (url) => {
      if (String(url).includes('/api/auth')) {
        return jsonResponse({ status_code: 9999, payload: { access_token: 'T' } });
      }
      return jsonResponse({ status_code: 9999, payload: { message_id: 'MSG_I' } });
    });

    const payload = {
      customerId,
      customerName: 'Test Idem',
      amount: 10000,
      balanceBefore: 10000,
      balanceAfter: 0,
      transactionId: 987654321,
    };

    const r1 = await DebtNotifyService.notifyPayment(payload);
    const r2 = await DebtNotifyService.notifyPayment(payload);

    expect(r1.status).toBe('sent');
    expect(r2.status).toBe('skipped');
    expect(r2.error).toBe('ALREADY_NOTIFIED');

    const sends = fetchMock.mock.calls.filter((c) => String(c[0]).includes('send_text'));
    expect(sends.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. DebtNotifyService — lịch sử
// ═══════════════════════════════════════════════════════════════════════════
describe('DebtNotifyService — lịch sử', () => {
  it('listHistory trả về items + total', () => {
    const res = DebtNotifyService.listHistory({ limit: 10 });
    expect(res).toHaveProperty('items');
    expect(res).toHaveProperty('total');
    expect(Array.isArray(res.items)).toBe(true);
  });

  it('getSummary trả về số liệu', () => {
    const s = DebtNotifyService.getSummary();
    expect(typeof s.total).toBe('number');
    expect(typeof s.sent).toBe('number');
  });
});
