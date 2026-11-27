const { makeApp, adminHeaders, truncateAll } = require('../helpers');

const CSV_HEADER = 'customerId,customerName,groupId,groupName,note';

describe('Import CSV', () => {
  let app;
  let request;

  beforeAll(async () => {
    ({ app, request } = await makeApp());
  });

  beforeEach(() => {
    truncateAll();
  });

  test('import CSV hop le (preview)', async () => {
    const csv = `${CSV_HEADER}\nKH001,Quán A,GROUP001,Nhóm A,note1\nKH002,Quán B,GROUP002,Nhóm B,note2`;

    const res = await request(app)
      .post('/api/groups/import/preview')
      .set(adminHeaders())
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.valid).toBe(2);
    expect(res.body.invalid).toBe(0);
  });

  test('import CSV hop le (commit)', async () => {
    const csv = `${CSV_HEADER}\nKH001,Quán A,GROUP001,Nhóm A,note1\nKH002,Quán B,GROUP002,Nhóm B,note2`;

    const res = await request(app)
      .post('/api/groups/import')
      .set(adminHeaders())
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(2);
    expect(res.body.invalid).toBe(0);

    const list = await request(app).get('/api/groups').set(adminHeaders());
    expect(list.body.total).toBe(2);
  });

  test('import CSV co du lieu trung trong file', async () => {
    const csv = `${CSV_HEADER}\nKH001,Quán A,GROUP001,Nhóm A,\nKH001,Quán A2,GROUP002,Nhóm A2,`;

    const res = await request(app)
      .post('/api/groups/import/preview')
      .set(adminHeaders())
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.body.total).toBe(2);
    expect(res.body.valid).toBe(1);
    expect(res.body.invalid).toBe(1);
    expect(res.body.errors[0].message).toMatch(/trung/i);
  });

  test('import CSV loi mot phan - dong loi bi bo qua, dong hop le duoc ghi', async () => {
    const csv =
      `${CSV_HEADER}\n` +
      'KH001,Quán A,GROUP001,Nhóm A,\n' +
      ',Tên thiếu ID,GROUP002,Nhóm B,\n' +
      'KH003,Tên thiếu Group,,Nhóm C,';

    const res = await request(app)
      .post('/api/groups/import')
      .set(adminHeaders())
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    expect(res.body.invalid).toBe(2);
    expect(res.body.errors.length).toBe(2);

    const list = await request(app).get('/api/groups').set(adminHeaders());
    expect(list.body.total).toBe(1);
  });

  test('Group ID da thuoc khach khac bi bao loi va bo qua dong do', async () => {
    await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH999', groupId: 'GROUP999' });

    const csv = `${CSV_HEADER}\nKH001,Quán A,GROUP999,Nhóm A,\nKH002,Quán B,GROUP002,Nhóm B,`;

    const res = await request(app)
      .post('/api/groups/import')
      .set(adminHeaders())
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    expect(res.body.invalid).toBe(1);
    expect(res.body.errors[0].message).toMatch(/khach hang khac/i);
  });

  test('Customer ID da co mapping bi bao loi va bo qua dong do', async () => {
    await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: 'GROUP001' });

    const csv = `${CSV_HEADER}\nKH001,Quán A,GROUP555,Nhóm A,`;

    const res = await request(app)
      .post('/api/groups/import')
      .set(adminHeaders())
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.body.inserted).toBe(0);
    expect(res.body.invalid).toBe(1);
    expect(res.body.errors[0].message).toMatch(/da co lien ket/i);
  });

  test('CSV thieu cot bat buoc bi tu choi', async () => {
    const csv = 'customerId,customerName\nKH001,Quán A';

    const res = await request(app)
      .post('/api/groups/import')
      .set(adminHeaders())
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CSV');
  });

  test('import chua xac nhan khong ghi du lieu', async () => {
    const csv = `${CSV_HEADER}\nKH001,Quán A,GROUP001,Nhóm A,`;

    // dryRun mac dinh = false trong controller -> explicit dryRun=true de preview
    const res = await request(app)
      .post('/api/groups/import?dryRun=true')
      .set(adminHeaders())
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.body.dryRun).toBe(true);
    expect(res.body.inserted).toBeUndefined();

    const list = await request(app).get('/api/groups').set(adminHeaders());
    expect(list.body.total).toBe(0);
  });

  test('CSV rong bi tu choi', async () => {
    const res = await request(app)
      .post('/api/groups/import')
      .set(adminHeaders())
      .set('Content-Type', 'text/csv')
      .send('');

    expect(res.status).toBe(400);
  });

  test('tai file mau CSV', async () => {
    const res = await request(app).get('/api/groups/template.csv').set(adminHeaders());
    expect(res.status).toBe(200);
    expect(res.text).toContain('customerId,customerName,groupId,groupName,note');
    expect(res.text).toContain('GROUP001');
  });

  test('import duoc audit', async () => {
    const csv = `${CSV_HEADER}\nKH001,Quán A,GROUP001,Nhóm A,`;
    await request(app)
      .post('/api/groups/import')
      .set(adminHeaders())
      .set('Content-Type', 'text/csv')
      .send(csv);

    const res = await request(app).get('/api/audit-logs?action=GROUP_IMPORT').set(adminHeaders());
    expect(res.body.total).toBe(1);
  });
});
