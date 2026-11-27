const { makeApp, truncateAll } = require('../helpers');
const { safeEqual, fingerprint } = require('../../src/utils/crypto');
const { sanitizeDetails } = require('../../src/services/AuditService');

describe('Security', () => {
  let app;
  let request;

  beforeAll(async () => {
    ({ app, request } = await makeApp());
  });

  beforeEach(() => {
    truncateAll();
  });

  test('health check khong can API key', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('health check khong lo secret', async () => {
    const res = await request(app).get('/health');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('test_admin_key');
    expect(text).not.toContain('test_integration_key');
    expect(res.body.database.path).toBeUndefined();
  });

  test('moi endpoint admin deu yeu cau key', async () => {
    const endpoints = [
      ['get', '/api/account/status'],
      ['get', '/api/groups'],
      ['get', '/api/dashboard'],
      ['get', '/api/settings'],
      ['get', '/api/audit-logs'],
    ];
    for (const [method, url] of endpoints) {
      const res = await request(app)[method](url);
      expect(res.status).toBe(401);
    }
  });

  test('moi endpoint integration deu yeu cau key', async () => {
    const endpoints = [
      ['post', '/api/messages/send'],
      ['get', '/api/messages/history'],
      ['get', '/api/messages/jobs/1'],
      ['post', '/api/messages/jobs/1/retry'],
      ['post', '/api/messages/jobs/1/cancel'],
    ];
    for (const [method, url] of endpoints) {
      const res = await request(app)[method](url).send({});
      expect(res.status).toBe(401);
    }
  });

  test('key sai bi tu choi', async () => {
    const res = await request(app).get('/api/groups').set({ 'X-API-Key': 'sai' });
    expect(res.status).toBe(403);
  });

  test('endpoint khong ton tai -> 404 JSON (khong lo stack)', async () => {
    const res = await request(app).get('/api/khong-co');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.text).not.toMatch(/at Object\./);
  });

  test('safeEqual hoat dong dung', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  test('fingerprint khong lo nguyên ban key', () => {
    const fp = fingerprint('test_admin_key');
    expect(fp).not.toBe('test_admin_key');
    expect(fp).toHaveLength(8);
  });

  test('audit loai bo truong nhay cam', () => {
    const cleaned = sanitizeDetails({
      apiKey: 'secret',
      api_key: 'secret',
      password: 'secret',
      authorization: 'Bearer x',
      token: 'secret',
      cookie: 'secret',
      customerId: 'KH001',
    });
    expect(cleaned).toEqual({ customerId: 'KH001' });
  });

  test('setting khong cho phep luu secret', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set({ 'X-API-Key': 'test_admin_key' })
      .send({ key: 'api_key', value: 'hacker' });

    expect(res.status).toBe(400);
  });

  test('CORS chi cho phep origin trong danh sach', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'http://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();

    const ok = await request(app)
      .get('/health')
      .set('Origin', 'http://localhost:3100');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3100');
  });

  test('helmet dat header bao mat', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('khong cho phep nhieu thuoc tinh cua nhom khac', async () => {
    const res = await request(app)
      .post('/api/messages/send')
      .set({ 'X-API-Key': 'test_integration_key' })
      .send({ customerId: 'KH001', message: 'abc' });

    // 400 (thieu Idempotency-Key) chu khong phai 403 -> key hop le
    expect(res.status).toBe(400);
  });
});
