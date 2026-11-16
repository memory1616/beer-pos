/**
 * AUTO REVERSE-GEOCODE — Test suite
 * ─────────────────────────────────────────────────────────────────────────────
 * Kiểm chứng cơ chế "TỰ ĐỘNG LẤY ĐỊA CHỈ KHI CÓ GPS":
 *
 *  A. GeocodeService.normalizeAddress — chuẩn hóa chuỗi địa chỉ kiểu VN.
 *  B. GeocodeService.isInServiceArea — chặn tọa độ ngoài vùng phục vụ.
 *  C. GeocodeService.ensureCustomerAddress — điền địa chỉ khi có GPS + thiếu địa chỉ;
 *     KHÔNG ghi đè địa chỉ đã có; KHÔNG ghi khi thiếu tọa độ.
 *  D. Cache + dedupe — cùng tọa độ chỉ gọi ra ngoài 1 lần.
 *  E. API /api/geocode/reverse — trả địa chỉ, cache hit, từ chối tọa độ rác.
 *  F. API /api/geocode/backfill — ADMIN được backfill, DRIVER bị chặn 403.
 *  G. Hook tự động trong POST /api/customers/location (có GPS → tự điền địa chỉ).
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const db = require('../database');
const GeocodeService = require('../src/services/GeocodeService');
const { hashPassword } = require('../src/utils/password');
const { ROLE_ADMIN, ROLE_DRIVER } = require('../middleware/permissions');

jest.setTimeout(30000);

const ADMIN_USER = 'geo_admin';
const DRIVER_USER = 'geo_driver';

// ── Mock mạng: chặn fetch ra ngoài, trả kết quả giả ────────────────────────
const realFetch = global.fetch;
let fetchCalls = 0;

beforeAll(() => {
  global.fetch = jest.fn(async (url) => {
    fetchCalls += 1;
    const u = String(url);
    if (u.includes('nominatim')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          display_name: 'Số 12, Đường Lê Lợi, Phường 2, Thị xã Trảng Bàng, Tây Ninh, Việt Nam',
          address: {
            house_number: '12',
            road: 'Đường Lê Lợi',
            ward: 'Phường 2',
            town: 'Thị xã Trảng Bàng',
            state: 'Tây Ninh',
            country: 'Việt Nam',
          },
        }),
      };
    }
    if (u.includes('arcgis')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          address: {
            Address: 'Số 12, Đường Lê Lợi',
            Neighborhood: 'Phường 2',
            SubadminCity: 'Thị xã Trảng Bàng',
            Admin2: 'Tây Ninh',
            Region: 'Tây Ninh',
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
});

afterAll(() => {
  global.fetch = realFetch;
});

beforeEach(() => {
  fetchCalls = 0;
  GeocodeService._cache.clear();
  GeocodeService._inflight.clear();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildApp(role, username) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    req.user = { username: username, role: role };
    next();
  });
  a.use('/api/geocode', require('../routes/api/geocode'));
  a.use('/api/customers', require('../routes/api/customers'));
  return a;
}

function createUser(username, role) {
  const hash = hashPassword('test_pw_123');
  const existing = db.prepare('SELECT id FROM app_users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE app_users SET password_hash = ?, role = ?, active = 1 WHERE id = ?').run(
      hash, role, existing.id
    );
    return existing.id;
  }
  return db
    .prepare('INSERT INTO app_users (username, password_hash, role, active) VALUES (?, ?, ?, 1)')
    .run(username, hash, role).lastInsertRowid;
}

function makeCustomer(name, { lat = null, lng = null, address = null } = {}) {
  const r = db
    .prepare(
      `INSERT INTO customers (name, phone, deposit, keg_balance, lat, lng, address, created_at, updated_at)
       VALUES (?, '', 0, 0, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(name, lat, lng, address);
  return r.lastInsertRowid;
}

const TAYNINH_LAT = 11.3119;
const TAYNINH_LNG = 106.0984;

// ═══════════════════════════════════════════════════════════════════════════
// A. normalizeAddress
// ═══════════════════════════════════════════════════════════════════════════
describe('A. GeocodeService.normalizeAddress', () => {
  it('bỏ "Việt Nam" và giữ tối đa 4 cấp', () => {
    const out = GeocodeService.normalizeAddress(
      'Số 12, Đường Lê Lợi, Phường 2, Thị xã Trảng Bàng, Tây Ninh, Việt Nam'
    );
    expect(out).toBe('Số 12, Đường Lê Lợi, Phường 2, Thị xã Trảng Bàng');
  });

  it('trả null khi rỗng', () => {
    expect(GeocodeService.normalizeAddress('')).toBeNull();
    expect(GeocodeService.normalizeAddress(null)).toBeNull();
    expect(GeocodeService.normalizeAddress('Việt Nam')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. isInServiceArea
// ═══════════════════════════════════════════════════════════════════════════
describe('B. GeocodeService.isInServiceArea', () => {
  it('nhận tọa độ Tây Ninh', () => {
    expect(GeocodeService.isInServiceArea(TAYNINH_LAT, TAYNINH_LNG)).toBe(true);
  });

  it('từ chối tọa độ ngoài vùng (Hà Nội / quốc tế)', () => {
    expect(GeocodeService.isInServiceArea(21.0285, 105.8542)).toBe(false);
    expect(GeocodeService.isInServiceArea(0, 0)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. ensureCustomerAddress
// ═══════════════════════════════════════════════════════════════════════════
describe('C. GeocodeService.ensureCustomerAddress', () => {
  it('tự điền địa chỉ khi có GPS nhưng thiếu địa chỉ', async () => {
    const id = makeCustomer('GEO_A', { lat: TAYNINH_LAT, lng: TAYNINH_LNG, address: null });
    const res = await GeocodeService.ensureCustomerAddress(db, id);

    expect(res.filled).toBe(true);
    const row = db.prepare('SELECT address FROM customers WHERE id = ?').get(id);
    expect(row.address).toBeTruthy();
    expect(row.address).toContain('Đường Lê Lợi');
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });

  it('KHÔNG ghi đè địa chỉ đã có', async () => {
    const id = makeCustomer('GEO_B', { lat: TAYNINH_LAT, lng: TAYNINH_LNG, address: 'Số 9 Đường ABC' });
    const res = await GeocodeService.ensureCustomerAddress(db, id);

    expect(res.filled).toBe(false);
    const row = db.prepare('SELECT address FROM customers WHERE id = ?').get(id);
    expect(row.address).toBe('Số 9 Đường ABC');
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });

  it('KHÔNG ghi khi thiếu tọa độ', async () => {
    const id = makeCustomer('GEO_C', { lat: null, lng: null, address: null });
    const res = await GeocodeService.ensureCustomerAddress(db, id);

    expect(res.filled).toBe(false);
    const row = db.prepare('SELECT address FROM customers WHERE id = ?').get(id);
    expect(row.address).toBeNull();
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });

  it('KHÔNG ghi khi tọa độ ngoài vùng phục vụ', async () => {
    const id = makeCustomer('GEO_D', { lat: 21.0285, lng: 105.8542, address: null });
    const res = await GeocodeService.ensureCustomerAddress(db, id);

    expect(res.filled).toBe(false);
    const row = db.prepare('SELECT address FROM customers WHERE id = ?').get(id);
    expect(row.address).toBeNull();
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Cache + dedupe
// ═══════════════════════════════════════════════════════════════════════════
describe('D. Cache & dedupe', () => {
  it('gọi ra ngoài 1 lần cho cùng tọa độ (cache hit lần 2)', async () => {
    await GeocodeService.reverseGeocode(TAYNINH_LAT, TAYNINH_LNG);
    const after1 = fetchCalls;
    const r2 = await GeocodeService.reverseGeocode(TAYNINH_LAT, TAYNINH_LNG);

    expect(fetchCalls).toBe(after1); // không gọi thêm
    expect(r2.cached).toBe(true);
  });

  it('dedupe: 3 request cùng tọa độ chạy song song → chỉ 1 lần gọi ra ngoài', async () => {
    await Promise.all([
      GeocodeService.reverseGeocode(11.5, 106.5),
      GeocodeService.reverseGeocode(11.5, 106.5),
      GeocodeService.reverseGeocode(11.5, 106.5),
    ]);
    // Nguồn ưu tiên Nominatim chạy TUẦN TỰ (không đua với Esri)
    // → chỉ 1 request cho 1 tọa độ.
    expect(fetchCalls).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. API /api/geocode/reverse
// ═══════════════════════════════════════════════════════════════════════════
describe('E. API /api/geocode/reverse', () => {
  let app;

  beforeAll(() => {
    createUser(ADMIN_USER, ROLE_ADMIN);
    createUser(DRIVER_USER, ROLE_DRIVER);
    app = buildApp(ROLE_ADMIN, ADMIN_USER);
  });

  it('trả địa chỉ hợp lệ', async () => {
    const res = await request(app).get('/api/geocode/reverse?lat=11.3119&lng=106.0984');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.address).toContain('Đường Lê Lợi');
    expect(['nominatim', 'esri']).toContain(res.body.source);
  });

  it('lần 2 → cached = true', async () => {
    // Gọi lần 1 trong cùng test để không bị beforeEach xóa cache.
    const first = await request(app).get('/api/geocode/reverse?lat=11.3119&lng=106.0984');
    expect(first.status).toBe(200);
    expect(first.body.cached).toBe(false);

    const res = await request(app).get('/api/geocode/reverse?lat=11.3119&lng=106.0984');
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
  });

  it('từ chối tọa độ thiếu / sai', async () => {
    const r1 = await request(app).get('/api/geocode/reverse');
    expect(r1.status).toBe(400);
    const r2 = await request(app).get('/api/geocode/reverse?lat=abc&lng=xyz');
    expect(r2.status).toBe(400);
  });

  it('từ chối tọa độ ngoài vùng phục vụ', async () => {
    const res = await request(app).get('/api/geocode/reverse?lat=21.0285&lng=105.8542');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('GEOCODE_INVALID_COORDS');
  });

  it('ưu tiên Nominatim (chất lượng VN tốt hơn Esri)', async () => {
    GeocodeService._cache.clear();
    const res = await request(app).get('/api/geocode/reverse?lat=11.9&lng=106.2');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('nominatim');
  });

  it('fallback sang Esri khi Nominatim lỗi', async () => {
    GeocodeService._cache.clear();
    const prev = global.fetch;
    global.fetch = jest.fn(async (url) => {
      const u = String(url);
      if (u.includes('nominatim')) throw new Error('network down');
      return prev(url);
    });
    try {
      const res = await request(app).get('/api/geocode/reverse?lat=11.77&lng=106.33');
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('esri');
    } finally {
      global.fetch = prev;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. API /api/geocode/backfill (quyền)
// ═══════════════════════════════════════════════════════════════════════════
describe('F. API /api/geocode/backfill', () => {
  let adminApp;
  let driverApp;

  beforeAll(() => {
    adminApp = buildApp(ROLE_ADMIN, ADMIN_USER);
    driverApp = buildApp(ROLE_DRIVER, DRIVER_USER);
  });

  it('ADMIN được backfill', async () => {
    const id = makeCustomer('GEO_F1', { lat: 11.312, lng: 106.099, address: null });
    const res = await request(adminApp)
      .post('/api/geocode/backfill')
      .send({ ids: [id], delayMs: 0 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.updated).toBeGreaterThanOrEqual(1);

    const row = db.prepare('SELECT address FROM customers WHERE id = ?').get(id);
    expect(row.address).toBeTruthy();
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });

  it('DRIVER bị chặn 403', async () => {
    const res = await request(driverApp)
      .post('/api/geocode/backfill')
      .send({ all: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_ONLY');
  });

  it('yêu cầu ids[] hoặc all=true', async () => {
    const res = await request(adminApp).post('/api/geocode/backfill').send({});
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. Hook tự động khi lưu tọa độ
// ═══════════════════════════════════════════════════════════════════════════
describe('G. Hook tự động khi lưu tọa độ', () => {
  let app;

  beforeAll(() => {
    app = buildApp(ROLE_ADMIN, ADMIN_USER);
  });

  it('POST /api/customers/location với GPS → tự điền địa chỉ', async () => {
    const id = makeCustomer('GEO_G1', { lat: null, lng: null, address: null });

    const res = await request(app)
      .post('/api/customers/location')
      .send({ customerId: id, lat: 11.3119, lng: 106.0984 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Hook chạy nền → chờ tối đa 5s để địa chỉ được ghi
    let address = null;
    for (let i = 0; i < 50; i++) {
      const row = db.prepare('SELECT address FROM customers WHERE id = ?').get(id);
      address = row.address;
      if (address) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(address).toBeTruthy();
    expect(address).toContain('Đường Lê Lợi');
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });

  it('không ghi đè khi client gửi kèm address', async () => {
    const id = makeCustomer('GEO_G2', { lat: null, lng: null, address: null });

    await request(app)
      .post('/api/customers/location')
      .send({ customerId: id, lat: 11.3119, lng: 106.0984, address: 'Địa chỉ nhập tay' });

    await new Promise((r) => setTimeout(r, 400));
    const row = db.prepare('SELECT address FROM customers WHERE id = ?').get(id);
    expect(row.address).toBe('Địa chỉ nhập tay');
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });
});
