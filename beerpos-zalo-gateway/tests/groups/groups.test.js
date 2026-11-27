const { makeApp, adminHeaders, truncateAll, ensureSchema } = require('../helpers');

describe('Group mapping (API)', () => {
  let app;
  let request;

  beforeAll(async () => {
    ({ app, request } = await makeApp());
  });

  beforeEach(() => {
    truncateAll();
  });

  // ── Them nhom ─────────────────────────────────────────────────────────────
  test('them nhom thanh cong', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({
        customerId: 'KH001',
        customerName: 'Quán A',
        groupId: 'GROUP001',
        groupName: 'Nhóm Quán A',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.group.customerId).toBe('KH001');
    expect(res.body.group.groupId).toBe('GROUP001');
    expect(res.body.group.isActive).toBe(true);
  });

  test('them nhom khong bat buoc ten nhom', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH010', groupId: 'GROUP010' });

    expect(res.status).toBe(201);
    expect(res.body.group.groupName).toBeNull();
  });

  test('trung Customer ID bi tu choi', async () => {
    await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: 'GROUP001' });

    const res = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: 'GROUP002' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_CUSTOMER');
  });

  test('trung Group ID bi tu choi', async () => {
    await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: 'GROUP001' });

    const res = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH002', groupId: 'GROUP001' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_GROUP');
  });

  test('thieu Group ID bi tu choi', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('Group ID rong (whitespace) bi tu choi', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: '   ' });

    expect(res.status).toBe(400);
  });

  test('thieu Customer ID bi tu choi', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ groupId: 'GROUP001' });

    expect(res.status).toBe(400);
  });

  // ── Sua nhom ──────────────────────────────────────────────────────────────
  test('sua Group ID thanh cong', async () => {
    const created = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: 'GROUP001' });

    const res = await request(app)
      .patch(`/api/groups/${created.body.group.id}`)
      .set(adminHeaders())
      .send({ groupId: 'GROUP009', groupName: 'Tên mới' });

    expect(res.status).toBe(200);
    expect(res.body.group.groupId).toBe('GROUP009');
    expect(res.body.group.groupName).toBe('Tên mới');
  });

  test('sua sang Group ID dang thuoc khach khac bi tu choi', async () => {
    await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: 'GROUP001' });
    const second = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH002', groupId: 'GROUP002' });

    const res = await request(app)
      .patch(`/api/groups/${second.body.group.id}`)
      .set(adminHeaders())
      .send({ groupId: 'GROUP001' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_GROUP');
  });

  // ── Ngung hoat dong / xoa ──────────────────────────────────────────────────
  test('ngung hoat dong mapping', async () => {
    const created = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: 'GROUP001' });

    const res = await request(app)
      .patch(`/api/groups/${created.body.group.id}`)
      .set(adminHeaders())
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.group.isActive).toBe(false);
  });

  test('xoa mapping dung soft delete va giu mapping trong DB', async () => {
    const created = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: 'GROUP001' });

    const res = await request(app)
      .delete(`/api/groups/${created.body.group.id}`)
      .set(adminHeaders());

    expect(res.status).toBe(200);
    expect(res.body.deactivated).toBe(true);

    // Van con trong DB (khong xoa lich su)
    // eslint-disable-next-line global-require
    const { getDb } = require('../../src/database/connection');
    const row = getDb()
      .prepare('SELECT * FROM gateway_groups WHERE id = ?')
      .get(created.body.group.id);
    expect(row).toBeTruthy();
    expect(row.is_active).toBe(0);
  });

  // ── List / filter / phan trang ────────────────────────────────────────────
  test('list nhom co phan trang va tim kiem', async () => {
    await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', customerName: 'Quán A', groupId: 'GROUP001' });
    await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH002', customerName: 'Quán B', groupId: 'GROUP002' });

    const all = await request(app).get('/api/groups').set(adminHeaders());
    expect(all.body.total).toBe(2);

    const search = await request(app)
      .get('/api/groups')
      .query({ search: 'Quán B' })
      .set(adminHeaders());
    expect(search.body.total).toBe(1);
    expect(search.body.items[0].customerId).toBe('KH002');

    const paged = await request(app).get('/api/groups?page=1&limit=1').set(adminHeaders());
    expect(paged.body.items.length).toBe(1);
    expect(paged.body.total).toBe(2);
  });

  test('loc theo trang thai', async () => {
    const created = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: 'GROUP001' });
    await request(app)
      .delete(`/api/groups/${created.body.group.id}`)
      .set(adminHeaders());

    const active = await request(app).get('/api/groups?status=active').set(adminHeaders());
    expect(active.body.total).toBe(0);

    const inactive = await request(app).get('/api/groups?status=inactive').set(adminHeaders());
    expect(inactive.body.total).toBe(1);
  });

  // ── Audit ─────────────────────────────────────────────────────────────────
  test('thao tac quan trong duoc audit', async () => {
    const created = await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: 'GROUP001' });

    const res = await request(app).get('/api/audit-logs').set(adminHeaders());
    expect(res.body.total).toBeGreaterThan(0);
    const actions = res.body.items.map((i) => i.action);
    expect(actions).toContain('GROUP_CREATE');
  });

  test('audit khong ghi API key', async () => {
    await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: 'GROUP001' });

    const res = await request(app).get('/api/audit-logs').set(adminHeaders());
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('test_admin_key');
  });
});

module.exports = { ensureSchema };
