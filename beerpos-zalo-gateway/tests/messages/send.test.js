const { makeApp, adminHeaders, integrationHeaders, truncateAll } = require('../helpers');

describe('Message API', () => {
  let app;
  let request;

  beforeAll(async () => {
    ({ app, request } = await makeApp());
  });

  beforeEach(async () => {
    truncateAll();
    await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', customerName: 'Quán A', groupId: 'GROUP001' });
  });

  test('gui tin hop le -> tao job', async () => {
    const res = await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('payment-notification-PAY001'))
      .send({
        paymentId: 'PAY001',
        customerId: 'KH001',
        message: 'Quán đã thanh toán 2.000.000đ',
      });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.accepted).toBe(true);
    expect(res.body.status).toBe('queued');
    expect(res.body.provider).toBe('mock');
    expect(res.body.jobId).toBeTruthy();
  });

  test('thieu customerId bi tu choi', async () => {
    const res = await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('k1'))
      .send({ message: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('khach chua co Group ID bi tu choi', async () => {
    const res = await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('k2'))
      .send({ paymentId: 'PAY002', customerId: 'KH999', message: 'abc' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_GROUP_NOT_LINKED');
    expect(res.body.accepted).toBe(false);
  });

  test('khach co Group ID bi vo hieu hoa -> khong gui', async () => {
    const list = await request(app).get('/api/groups').set(adminHeaders());
    const id = list.body.items[0].id;
    await request(app).delete(`/api/groups/${id}`).set(adminHeaders());

    const res = await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('k3'))
      .send({ paymentId: 'PAY003', customerId: 'KH001', message: 'abc' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_GROUP_NOT_LINKED');
  });

  test('noi dung rong bi tu choi', async () => {
    const res = await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('k4'))
      .send({ customerId: 'KH001', message: '   ' });

    expect(res.status).toBe(400);
  });

  test('noi dung qua dai bi tu choi', async () => {
    const res = await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('k5'))
      .send({ customerId: 'KH001', message: 'x'.repeat(2001) });

    expect(res.status).toBe(400);
  });

  test('API key sai bi tu choi', async () => {
    const res = await request(app)
      .post('/api/messages/send')
      .set({ 'X-API-Key': 'wrong_key' })
      .send({ customerId: 'KH001', message: 'abc' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  test('thieu API key bi tu choi', async () => {
    const res = await request(app)
      .post('/api/messages/send')
      .send({ customerId: 'KH001', message: 'abc' });

    expect(res.status).toBe(401);
  });

  test('integration key khong co quyen quan tri', async () => {
    const res = await request(app)
      .get('/api/groups')
      .set({ 'X-API-Key': 'test_integration_key' });

    expect(res.status).toBe(403);
  });

  test('admin key khong co quyen gui tin (phan quyen tach biet)', async () => {
    const res = await request(app)
      .post('/api/messages/send')
      .set(adminHeaders())
      .send({ customerId: 'KH001', message: 'abc' });

    expect(res.status).toBe(403);
  });

  test('thieu Idempotency-Key bi tu choi', async () => {
    const res = await request(app)
      .post('/api/messages/send')
      .set({ 'X-API-Key': 'test_integration_key' })
      .send({ customerId: 'KH001', message: 'abc' });

    expect(res.status).toBe(400);
  });

  test('gui lai cung idempotency key -> tra job cu, khong tao job moi', async () => {
    const first = await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('payment-notification-PAY001'))
      .send({ paymentId: 'PAY001', customerId: 'KH001', message: 'abc' });

    const second = await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('payment-notification-PAY001'))
      .send({ paymentId: 'PAY001', customerId: 'KH001', message: 'abc' });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.jobId).toBe(first.body.jobId);
    expect(second.body.duplicate).toBe(true);

    const history = await request(app)
      .get('/api/messages/history')
      .set(integrationHeaders());
    expect(history.body.total).toBe(1);
  });

  test('Payment ID da ton tai voi key khac -> van tao job moi (idempotency theo key)', async () => {
    await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('payment-notification-PAY001'))
      .send({ paymentId: 'PAY001', customerId: 'KH001', message: 'abc' });

    const res = await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('payment-notification-PAY001-v2'))
      .send({ paymentId: 'PAY001', customerId: 'KH001', message: 'abc' });

    expect(res.status).toBe(202);
  });

  test('job snapshot group_id tai thoi diem tao', async () => {
    const created = await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('pay-x'))
      .send({ customerId: 'KH001', message: 'abc' });

    const detail = await request(app)
      .get(`/api/messages/jobs/${created.body.jobId}`)
      .set(integrationHeaders());

    expect(detail.body.job.groupId).toBe('GROUP001');
    expect(detail.body.job.messageContent).toBe('abc');
  });

  test('lich su gui tin co the loc theo customerId', async () => {
    await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('h1'))
      .send({ customerId: 'KH001', message: 'abc' });

    const res = await request(app)
      .get('/api/messages/history?customerId=KH001')
      .set(integrationHeaders());

    expect(res.body.total).toBe(1);
  });

  test('chi tiet job tra ve cac lan thu', async () => {
    const created = await request(app)
      .post('/api/messages/send')
      .set(integrationHeaders('d1'))
      .send({ customerId: 'KH001', message: 'abc' });

    const res = await request(app)
      .get(`/api/messages/jobs/${created.body.jobId}`)
      .set(integrationHeaders());

    expect(res.status).toBe(200);
    expect(res.body.job).toBeTruthy();
    expect(Array.isArray(res.body.attempts)).toBe(true);
  });

  test('job khong ton tai -> 404', async () => {
    const res = await request(app).get('/api/messages/jobs/99999').set(integrationHeaders());
    expect(res.status).toBe(404);
  });
});
