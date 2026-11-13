/**
 * Socket.IO Auth — Test tích hợp (A4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Dựng server Express + Socket.IO thật (port ngẫu nhiên), rồi kết nối bằng
 * socket.io-client để kiểm tra end-to-end:
 *
 *  1. Handshake không token → bị từ chối (UNAUTHORIZED)
 *  2. Token sai → bị từ chối
 *  3. Token hợp lệ ADMIN → room `admin`, nhận payload đầy đủ (có `profit`)
 *  4. Token hợp lệ DRIVER → room `driver`, nhận payload ĐÃ sanitize
 *  5. Driver tự khai `mode=admin` → vẫn bị gán room `driver`
 *  6. Event admin-only (expense/report) → driver KHÔNG nhận
 *  7. `disconnectToken()` ngắt đúng socket của token bị thu hồi
 *
 * Mỗi test file dùng DB riêng (copy từ database.sqlite) — xem tests/setup.js.
 */
process.env.NODE_ENV = 'test';

const http = require('http');
const express = require('express');
const { io: ioClient } = require('socket.io-client');
const db = require('../database');
const { hashPassword } = require('../src/utils/password');
const socketServer = require('../src/socket/socketServer');

jest.setTimeout(20000);

const ADMIN_USER = 'a4_test_admin';
const DRIVER_USER = 'a4_test_driver';
const PASSWORD = 'Zxcv@1234';

let httpServer;
let baseUrl;
let adminToken;
let driverToken;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Tạo session trong DB và trả về token. */
function createSession(username, role, appUserId = null) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 60000;
  db.prepare(
    `INSERT OR REPLACE INTO auth_sessions
     (token, username, created_at, expires_at, last_active, role, app_user_id)
     VALUES (?, ?, datetime('now'), ?, ?, ?, ?)`
  ).run(token, username, expiresAt, Date.now(), role, appUserId);
  return token;
}

/** Kết nối socket & chờ tới khi có kết quả. */
function connect(opts) {
  return new Promise((resolve) => {
    const socket = ioClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
      ...opts,
    });
    socket.once('connect', () => resolve({ socket, connected: true, error: null }));
    socket.once('connect_error', (err) => {
      resolve({ socket, connected: false, error: err });
    });
  });
}

/** Chờ socket kết nối & nhận event `connected` (chứa thông tin room). */
function connectAndReadHello(opts) {
  return new Promise((resolve) => {
    const socket = ioClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
      ...opts,
    });
    socket.once('connected', (hello) => resolve({ socket, hello }));
    socket.once('connect_error', (err) => resolve({ socket, hello: null, error: err }));
  });
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Tạo app_users (driver cần tồn tại để role hợp lệ)
  db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(ADMIN_USER, DRIVER_USER);
  db.prepare(
    `INSERT INTO app_users (username, password_hash, full_name, role, active)
     VALUES (?, ?, ?, 'DRIVER', 1)`
  ).run(DRIVER_USER, hashPassword(PASSWORD), 'A4 Test Driver');

  adminToken = createSession(ADMIN_USER, 'ADMIN');
  driverToken = createSession(DRIVER_USER, 'DRIVER', 1);

  const app = express();
  httpServer = http.createServer(app);
  socketServer.init(httpServer);

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;
  baseUrl = 'http://127.0.0.1:' + port;
});

afterAll(async () => {
  try { db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(ADMIN_USER, DRIVER_USER); } catch (e) { /* ignore */ }
  try { db.prepare('DELETE FROM auth_sessions WHERE username IN (?, ?)').run(ADMIN_USER, DRIVER_USER); } catch (e) { /* ignore */ }
  try { socketServer.getIO()?.close(); } catch (e) { /* ignore */ }
  try { await new Promise((r) => httpServer.close(r)); } catch (e) { /* ignore */ }
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Socket.IO Auth — handshake', () => {
  test('không có token → bị từ chối với code UNAUTHORIZED', async () => {
    const { socket, connected, error } = await connect({ query: { mode: 'admin' } });
    expect(connected).toBe(false);
    expect(error).toBeTruthy();
    expect(error.data?.code).toBe('UNAUTHORIZED');
    socket.close();
  });

  test('token không tồn tại → bị từ chối', async () => {
    const { socket, connected, error } = await connect({
      auth: { token: 'token-khong-ton-tai-abc' },
      query: { mode: 'admin' },
    });
    expect(connected).toBe(false);
    expect(error?.data?.code).toBe('UNAUTHORIZED');
    socket.close();
  });

  test('mode=public không cần token → được phép', async () => {
    const { socket, connected } = await connect({ query: { mode: 'public' } });
    expect(connected).toBe(true);
    socket.close();
  });
});

describe('Socket.IO Auth — phân quyền room', () => {
  test('ADMIN vào room admin, không vào room driver', async () => {
    const { socket, hello } = await connectAndReadHello({
      auth: { token: adminToken },
      query: { mode: 'admin' },
    });
    expect(hello).toBeTruthy();
    expect(hello.role).toBe('ADMIN');
    expect(hello.rooms).toContain('admin');
    expect(hello.rooms).not.toContain('driver');
    socket.close();
  });

  test('DRIVER vào room driver, KHÔNG vào room admin', async () => {
    const { socket, hello } = await connectAndReadHello({
      auth: { token: driverToken },
      query: { mode: 'driver' },
    });
    expect(hello).toBeTruthy();
    expect(hello.role).toBe('DRIVER');
    expect(hello.rooms).toContain('driver');
    expect(hello.rooms).not.toContain('admin');
    socket.close();
  });

  test('DRIVER tự khai mode=admin vẫn bị gán room driver', async () => {
    const { socket, hello } = await connectAndReadHello({
      auth: { token: driverToken },
      query: { mode: 'admin' },
    });
    expect(hello).toBeTruthy();
    expect(hello.rooms).toContain('driver');
    expect(hello.rooms).not.toContain('admin');
    socket.close();
  });
});

describe('Socket.IO Auth — sanitize payload cho driver', () => {
  let adminSocket;
  let driverSocket;
  let adminEvents;
  let driverEvents;

  beforeEach(async () => {
    adminEvents = [];
    driverEvents = [];

    const a = await connect({ auth: { token: adminToken }, query: { mode: 'admin' } });
    const d = await connect({ auth: { token: driverToken }, query: { mode: 'driver' } });
    adminSocket = a.socket;
    driverSocket = d.socket;

    adminSocket.onAny((name, payload) => adminEvents.push({ name, payload }));
    driverSocket.onAny((name, payload) => driverEvents.push({ name, payload }));

    await new Promise((r) => setTimeout(r, 150));
  });

  afterEach(() => {
    adminSocket?.close();
    driverSocket?.close();
  });

  test('admin nhận payload đầy đủ (có profit, total)', async () => {
    socketServer.emitOrderCreated({
      id: 1001, date: '2026-11-13', customer_id: 1, driver_username: DRIVER_USER,
      type: 'sale', status: 'completed', archived: 0, deliver_kegs: 5, return_kegs: 0,
      total: 500000, profit: 120000, note: 'ghi chú nội bộ',
    });
    await new Promise((r) => setTimeout(r, 400));

    const adminOrder = adminEvents.find((e) => e.name === 'order:created');
    expect(adminOrder).toBeTruthy();
    expect(adminOrder.payload.sale.profit).toBe(120000);
    expect(adminOrder.payload.sale.total).toBe(500000);
  });

  test('driver nhận payload ĐÃ sanitize (không profit/total/note)', async () => {
    socketServer.emitOrderCreated({
      id: 1002, date: '2026-11-13', customer_id: 1, driver_username: DRIVER_USER,
      type: 'sale', status: 'completed', archived: 0, deliver_kegs: 5, return_kegs: 0,
      total: 500000, profit: 120000, note: 'ghi chú nội bộ',
    });
    await new Promise((r) => setTimeout(r, 400));

    const driverOrder = driverEvents.find((e) => e.name === 'order:created');
    expect(driverOrder).toBeTruthy();
    expect(driverOrder.payload.sale.profit).toBeUndefined();
    expect(driverOrder.payload.sale.total).toBeUndefined();
    expect(driverOrder.payload.sale.note).toBeUndefined();
    // Vẫn thấy dữ liệu vận hành cần thiết
    expect(driverOrder.payload.sale.id).toBe(1002);
    expect(driverOrder.payload.sale.deliver_kegs).toBe(5);
    expect(driverOrder.payload.sale.driver_username).toBe(DRIVER_USER);
  });

  test('driver KHÔNG nhận event admin-only (expense / report)', async () => {
    socketServer.emitExpense('created', { id: 9, amount: 999999, profit: 500000 });
    socketServer.emitReportUpdated({ reason: 'test' });
    await new Promise((r) => setTimeout(r, 400));

    expect(driverEvents.find((e) => e.name === 'expense:created')).toBeUndefined();
    expect(driverEvents.find((e) => e.name === 'report:updated')).toBeUndefined();

    // Admin thì CÓ nhận
    expect(adminEvents.find((e) => e.name === 'expense:created')).toBeTruthy();
    expect(adminEvents.find((e) => e.name === 'report:updated')).toBeTruthy();
  });

  test('driver nhận event không nhạy cảm (keg / customer / inventory)', async () => {
    socketServer.emitKegUpdated({ id: 7, state: 'delivered' });
    socketServer.emitCustomerUpdated({ id: 3, name: 'Khách A' });
    await new Promise((r) => setTimeout(r, 400));

    expect(driverEvents.find((e) => e.name === 'keg:updated')).toBeTruthy();
    expect(driverEvents.find((e) => e.name === 'customer:updated')).toBeTruthy();
  });

  test('client PUBLIC (không đăng nhập) KHÔNG nhận dữ liệu nghiệp vụ', async () => {
    const p = await connect({ query: { mode: 'public' } });
    expect(p.connected).toBe(true);
    const pubEvents = [];
    p.socket.onAny((name, payload) => pubEvents.push({ name, payload }));
    await new Promise((r) => setTimeout(r, 150));

    socketServer.emitOrderCreated({
      id: 1003, date: '2026-11-13', customer_id: 1, driver_username: DRIVER_USER,
      type: 'sale', status: 'completed', deliver_kegs: 1, return_kegs: 0,
      total: 500000, profit: 120000,
    });
    await new Promise((r) => setTimeout(r, 400));

    expect(pubEvents.find((e) => e.name === 'order:created')).toBeUndefined();
    p.socket.close();
  });

  test('không client nào join room legacy `all`', async () => {
    const a = await connect({ auth: { token: adminToken }, query: { mode: 'admin' } });
    const d = await connect({ auth: { token: driverToken }, query: { mode: 'driver' } });
    await new Promise((r) => setTimeout(r, 300));

    const io = socketServer.getIO();
    const allRoomSockets = [...io.sockets.adapter.rooms.get('all') || []];
    expect(allRoomSockets).toHaveLength(0);

    a.socket.close();
    d.socket.close();
  });

  test('driver không nhận các key nhạy cảm dùng chung với REST (cost, returned_profit)', async () => {
    socketServer.emitOrderCreated({
      id: 1004, date: '2026-11-13', customer_id: 1, driver_username: DRIVER_USER,
      type: 'sale', status: 'completed', deliver_kegs: 2, return_kegs: 0,
      total: 500000, profit: 120000, cost: 380000, costPrice: 380000,
      returned_profit: 5000, grossProfit: 130000, netProfit: 90000,
      totalCost: 400000, margin: 0.24,
    });
    await new Promise((r) => setTimeout(r, 400));

    const driverOrder = driverEvents.find((e) => e.name === 'order:created');
    expect(driverOrder).toBeTruthy();
    for (const k of ['profit', 'total', 'cost', 'costPrice', 'returned_profit',
      'grossProfit', 'netProfit', 'totalCost', 'margin']) {
      expect(driverOrder.payload.sale[k]).toBeUndefined();
    }
  });
});

describe('Socket.IO Auth — thu hồi phiên', () => {
  test('disconnectToken() ngắt socket của token bị thu hồi', async () => {
    const token = createSession('a4_temp_user', 'DRIVER', 1);
    const { socket } = await connect({ auth: { token }, query: { mode: 'driver' } });
    expect(socket.connected).toBe(true);

    let disconnected = false;
    socket.on('disconnect', () => { disconnected = true; });

    const count = socketServer.disconnectToken(token, 'test_revoke');
    expect(count).toBe(1);

    await new Promise((r) => setTimeout(r, 400));
    expect(disconnected).toBe(true);
    expect(socket.connected).toBe(false);

    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    socket.close();
  });

  test('disconnectUser() ngắt mọi socket của một user', async () => {
    const token = createSession(ADMIN_USER, 'ADMIN');
    const { socket } = await connect({ auth: { token }, query: { mode: 'admin' } });
    expect(socket.connected).toBe(true);

    let disconnected = false;
    socket.on('disconnect', () => { disconnected = true; });

    const count = socketServer.disconnectUser(ADMIN_USER, 'test_revoke_user');
    expect(count).toBeGreaterThanOrEqual(1);

    await new Promise((r) => setTimeout(r, 400));
    expect(disconnected).toBe(true);

    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    socket.close();
  });

  test('socket nhận event session:revoked trước khi bị ngắt', async () => {
    const token = createSession('a4_temp_user2', 'DRIVER', 1);
    const { socket } = await connect({ auth: { token }, query: { mode: 'driver' } });

    let revokedPayload = null;
    socket.on('session:revoked', (p) => { revokedPayload = p; });

    socketServer.disconnectToken(token, 'logout');
    await new Promise((r) => setTimeout(r, 400));

    expect(revokedPayload).toBeTruthy();
    expect(revokedPayload.reason).toBe('logout');

    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    socket.close();
  });
});
