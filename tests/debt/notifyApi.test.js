/**
 * THÔNG BÁO CÔNG NỢ ZALO QUA OMICALL — API routes + RBAC
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi test:
 *  - GET  /api/debt-ledger/notify/settings  — trả cấu hình (mask API key)
 *  - POST /api/debt-ledger/notify/settings  — lưu cấu hình (chỉ ADMIN)
 *  - POST /api/debt-ledger/notify/test      — kiểm tra kết nối (chỉ ADMIN)
 *  - POST /api/debt-ledger/notify/test-send — gửi tin thử (chỉ ADMIN)
 *  - GET  /api/debt-ledger/notify/history   — lịch sử gửi
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const db = require('../../database');
const debtLedgerRouter = require('../../routes/api/debtLedger');
const OmiCallService = require('../../src/services/OmiCallService');

jest.setTimeout(25000);

// ── App test ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const username = req.headers['x-test-user'];
  if (username) {
    req.user = {
      username: String(username),
      role: req.headers['x-test-role'] || 'ADMIN',
    };
  }
  next();
});
app.use('/api/debt-ledger', debtLedgerRouter);

const ADMIN = { 'x-test-user': 'admin', 'x-test-role': 'ADMIN' };
const STAFF = { 'x-test-user': 'staff_a', 'x-test-role': 'STAFF' };
const CUSTOMER = { 'x-test-user': 'cust_x', 'x-test-role': 'CUSTOMER' };

// ── Settings backup/restore ─────────────────────────────────────────────────
const savedSettings = {};
const KEYS = [
  'omicall_api_key',
  'omicall_base_url',
  'debt_notify_enabled',
  'debt_notify_channel',
  'debt_notify_manual_debt',
  'debt_notify_title',
];

beforeAll(() => {
  KEYS.forEach((k) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    savedSettings[k] = row ? row.value : null;
  });
});

afterAll(() => {
  KEYS.forEach((k) => {
    const v = savedSettings[k];
    if (v === null || v === undefined) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(k);
    } else {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(k, v);
    }
  });
  OmiCallService.clearTokenCache();
  if (global.fetch && global.fetch.mockRestore) global.fetch.mockRestore();
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /notify/settings
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /notify/settings', () => {
  it('trả cấu hình, KHÔNG lộ api key rõ', async () => {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run('omicall_api_key', 'SECRET_KEY_XYZ');

    const res = await request(app).get('/api/debt-ledger/notify/settings').set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.hasApiKey).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('SECRET_KEY_XYZ');
    expect(res.body.data).toHaveProperty('summary');
  });

  it('chặn khách không đăng nhập', async () => {
    const res = await request(app).get('/api/debt-ledger/notify/settings');
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /notify/settings
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /notify/settings', () => {
  it('ADMIN lưu được cấu hình', async () => {
    const res = await request(app)
      .post('/api/debt-ledger/notify/settings')
      .set(ADMIN)
      .send({ enabled: true, title: 'TEST TITLE', notifyManualDebt: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.title).toBe('TEST TITLE');
  });

  it('STAFF bị chặn', async () => {
    const res = await request(app)
      .post('/api/debt-ledger/notify/settings')
      .set(STAFF)
      .send({ enabled: false });
    expect(res.status).toBe(403);
  });

  it('CUSTOMER bị chặn', async () => {
    const res = await request(app)
      .post('/api/debt-ledger/notify/settings')
      .set(CUSTOMER)
      .send({ enabled: false });
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /notify/test
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /notify/test', () => {
  it('ADMIN kiểm tra kết nối thành công (mock fetch)', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ status_code: 9999, payload: { access_token: 'T' } })
    );
    OmiCallService.clearTokenCache();

    const res = await request(app)
      .post('/api/debt-ledger/notify/test')
      .set(ADMIN)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('báo lỗi khi API key sai', async () => {
    global.fetch = jest.fn(async () => jsonResponse({ message: 'invalid key' }, 401));
    OmiCallService.clearTokenCache();

    const res = await request(app)
      .post('/api/debt-ledger/notify/test')
      .set(ADMIN)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('STAFF bị chặn', async () => {
    const res = await request(app).post('/api/debt-ledger/notify/test').set(STAFF).send({});
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /notify/test-send
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /notify/test-send', () => {
  it('ADMIN gửi tin thử thành công', async () => {
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/api/auth')) {
        return jsonResponse({ status_code: 9999, payload: { access_token: 'T' } });
      }
      return jsonResponse({ status_code: 9999, payload: { message_id: 'MSG_T' } });
    });
    OmiCallService.clearTokenCache();

    const res = await request(app)
      .post('/api/debt-ledger/notify/test-send')
      .set(ADMIN)
      .send({ convId: 'CONV_TEST', text: 'xin chào' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('thiếu convId → 400', async () => {
    const res = await request(app)
      .post('/api/debt-ledger/notify/test-send')
      .set(ADMIN)
      .send({});
    expect(res.status).toBe(400);
  });

  it('STAFF bị chặn', async () => {
    const res = await request(app)
      .post('/api/debt-ledger/notify/test-send')
      .set(STAFF)
      .send({ convId: 'X' });
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /notify/history
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /notify/history', () => {
  it('trả danh sách lịch sử', async () => {
    const res = await request(app).get('/api/debt-ledger/notify/history?limit=10').set(STAFF);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it('chặn khách không đăng nhập', async () => {
    const res = await request(app).get('/api/debt-ledger/notify/history');
    expect(res.status).toBe(401);
  });
});
