/**
 * Unit test cho Socket.IO Auth (A4)
 *
 * Mục tiêu: bảo đảm
 *  1. Handshake không có session hợp lệ → bị từ chối (trừ chế độ public).
 *  2. Room do SERVER quyết định theo role — client không thể tự khai báo.
 *  3. Payload gửi cho tài xế KHÔNG chứa field tài chính (profit/cost/total).
 *  4. Token lấy đúng từ handshake auth/query/cookie.
 */
const socketAuth = require('../src/socket/socketAuth');

describe('socketAuth — parseCookies', () => {
  test('parse cookie header thành object', () => {
    const c = socketAuth.parseCookies('a=1; b=hello; session_token=abc123');
    expect(c.a).toBe('1');
    expect(c.b).toBe('hello');
    expect(c.session_token).toBe('abc123');
  });

  test('parse cookie giá trị có ký tự đặc biệt', () => {
    const c = socketAuth.parseCookies('session_token=a%3D%3D%3B%20x');
    expect(c.session_token).toBe('a==; x');
  });

  test('header rỗng / null → object rỗng', () => {
    expect(socketAuth.parseCookies('')).toEqual({});
    expect(socketAuth.parseCookies(undefined)).toEqual({});
    expect(socketAuth.parseCookies(null)).toEqual({});
  });

  test('cookie không có "=" bị bỏ qua', () => {
    const c = socketAuth.parseCookies('novalue; x=1');
    expect(c.novalue).toBeUndefined();
    expect(c.x).toBe('1');
  });
});

describe('socketAuth — extractToken', () => {
  test('lấy token từ handshake.auth.token', () => {
    const t = socketAuth.extractToken({ auth: { token: 'tok-auth' } });
    expect(t).toBe('tok-auth');
  });

  test('lấy token từ handshake.query.token khi không có auth', () => {
    const t = socketAuth.extractToken({ query: { token: 'tok-query' } });
    expect(t).toBe('tok-query');
  });

  test('auth.token được ưu tiên hơn query.token', () => {
    const t = socketAuth.extractToken({
      auth: { token: 'tok-auth' },
      query: { token: 'tok-query' },
    });
    expect(t).toBe('tok-auth');
  });

  test('fallback sang cookie session_token', () => {
    const t = socketAuth.extractToken({
      headers: { cookie: 'other=1; session_token=cookie-tok' },
    });
    expect(t).toBe('cookie-tok');
  });

  test('fallback sang cookie driver_session_token', () => {
    const t = socketAuth.extractToken({
      headers: { cookie: 'driver_session_token=drv-tok' },
    });
    expect(t).toBe('drv-tok');
  });

  test('token rỗng / whitespace bị bỏ qua', () => {
    expect(socketAuth.extractToken({ auth: { token: '   ' } })).toBeNull();
    expect(socketAuth.extractToken({})).toBeNull();
  });
});

describe('socketAuth — roomForRole', () => {
  test('ADMIN → room admin', () => {
    expect(socketAuth.roomForRole('ADMIN')).toBe('admin');
  });

  test('DRIVER → room driver (KHÔNG phải admin)', () => {
    expect(socketAuth.roomForRole('DRIVER')).toBe('driver');
  });

  test('role lạ → admin (fail-safe: không rơi vào room public)', () => {
    expect(socketAuth.roomForRole('WEIRD')).toBe('admin');
  });
});

describe('socketAuth — sanitizeForDriver', () => {
  test('xoá field profit ở mọi cấp', () => {
    const input = {
      sale: { id: 1, profit: 5000, total: 100000, note: 'ok' },
      meta: { total_profit: 900 },
    };
    const out = socketAuth.sanitizeForDriver(input);
    expect(out.sale.profit).toBeUndefined();
    expect(out.sale.total).toBeUndefined();
    expect(out.sale.note).toBe('ok');
    expect(out.meta.total_profit).toBeUndefined();
  });

  test('xoá field cost_price / costPrice', () => {
    const out = socketAuth.sanitizeForDriver({
      cost_price: 100,
      costPrice: 100,
      purchase_price: 100,
      id: 5,
    });
    expect(out.cost_price).toBeUndefined();
    expect(out.costPrice).toBeUndefined();
    expect(out.purchase_price).toBeUndefined();
    expect(out.id).toBe(5);
  });

  test('mảng được sanitize đệ quy', () => {
    const out = socketAuth.sanitizeForDriver({
      items: [{ id: 1, profit: 2 }, { id: 2, profit: 3 }],
    });
    expect(out.items).toHaveLength(2);
    expect(out.items[0].profit).toBeUndefined();
    expect(out.items[1].id).toBe(2);
  });

  test('giữ nguyên giá trị nguyên thuỷ', () => {
    expect(socketAuth.sanitizeForDriver(5)).toBe(5);
    expect(socketAuth.sanitizeForDriver('x')).toBe('x');
    expect(socketAuth.sanitizeForDriver(null)).toBeNull();
  });
});

describe('socketAuth — driverSalePayload', () => {
  test('chỉ giữ field an toàn', () => {
    const out = socketAuth.driverSalePayload({
      id: 12,
      date: '2026-11-13',
      customer_id: 3,
      driver_username: 'an',
      type: 'sale',
      status: 'completed',
      archived: 0,
      deliver_kegs: 5,
      return_kegs: 1,
      total: 999999,
      profit: 123456,
      note: 'ghi chú nội bộ',
    });
    expect(out.id).toBe(12);
    expect(out.driver_username).toBe('an');
    expect(out.deliver_kegs).toBe(5);
    expect(out.total).toBeUndefined();
    expect(out.profit).toBeUndefined();
    expect(out.note).toBeUndefined();
  });

  test('sale null → object rỗng', () => {
    expect(socketAuth.driverSalePayload(null)).toEqual({});
  });
});

describe('socketAuth — buildDriverOrderPayload', () => {
  test('thay sale bằng bản rút gọn, các field khác được sanitize', () => {
    const out = socketAuth.buildDriverOrderPayload({
      sale: { id: 1, profit: 999, total: 50000, driver_username: 'an' },
      reason: 'sale_created',
      profit: 12345,
    });
    expect(out.sale.id).toBe(1);
    expect(out.sale.profit).toBeUndefined();
    expect(out.sale.total).toBeUndefined();
    expect(out.sale.driver_username).toBe('an');
    expect(out.reason).toBe('sale_created');
    expect(out.profit).toBeUndefined();
  });

  test('payload không phải object → rỗng', () => {
    expect(socketAuth.buildDriverOrderPayload(null)).toEqual({});
  });
});

describe('socketAuth — resolveSession', () => {
  test('token không hợp lệ → null', () => {
    const s = socketAuth.resolveSession({ auth: { token: 'khong-ton-tai-xyz' } });
    expect(s).toBeNull();
  });

  test('không có token → null', () => {
    expect(socketAuth.resolveSession({})).toBeNull();
  });

  test('token hợp lệ trả về role từ DB', () => {
    const db = require('../database');
    const crypto = require('crypto');
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 60000;

    // Tạo session thật trong DB test
    db.prepare(
      `INSERT OR REPLACE INTO auth_sessions
       (token, username, created_at, expires_at, last_active, role, app_user_id)
       VALUES (?, ?, datetime('now'), ?, ?, ?, ?)`
    ).run(token, 'testadmin', expiresAt, Date.now(), 'ADMIN', null);

    const session = socketAuth.resolveSession({ auth: { token } });
    expect(session).not.toBeNull();
    expect(session.role).toBe('ADMIN');
    expect(session.username).toBe('testadmin');

    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  });

  test('session DRIVER trả role DRIVER', () => {
    const db = require('../database');
    const crypto = require('crypto');
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 60000;

    db.prepare(
      `INSERT OR REPLACE INTO auth_sessions
       (token, username, created_at, expires_at, last_active, role, app_user_id)
       VALUES (?, ?, datetime('now'), ?, ?, ?, ?)`
    ).run(token, 'testdriver', expiresAt, Date.now(), 'DRIVER', 999);

    const session = socketAuth.resolveSession({ auth: { token } });
    expect(session.role).toBe('DRIVER');
    expect(session.appUserId).toBe(999);

    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  });
});
