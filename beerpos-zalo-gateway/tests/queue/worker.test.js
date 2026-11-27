const { makeApp, adminHeaders, integrationHeaders, truncateAll } = require('../helpers');
const QueueService = require('../../src/services/QueueService');
const SettingsService = require('../../src/services/SettingsService');
const { JOB_STATUS } = require('../../src/database/repositories/JobRepository');
const WorkerService = require('../../src/services/WorkerService');

describe('Queue & Worker', () => {
  let app;
  let request;
  let queue;
  let settings;

  beforeAll(async () => {
    ({ app, request } = await makeApp());
    queue = new QueueService();
    settings = new SettingsService();
  });

  beforeEach(async () => {
    truncateAll();
    await request(app)
      .post('/api/groups')
      .set(adminHeaders())
      .send({ customerId: 'KH001', groupId: 'GROUP001' });
  });

  function makeJob(overrides = {}) {
    return queue.enqueue({
      idempotencyKey: overrides.idempotencyKey || `key-${Math.random()}`,
      paymentId: 'PAY001',
      customerId: 'KH001',
      customerName: 'Quán A',
      groupId: 'GROUP001',
      groupName: 'Nhóm A',
      messageContent: 'Xin chào',
      provider: 'mock',
      maxAttempts: overrides.maxAttempts || 4,
    });
  }

  /** Thay provider bang stub (dung chung instance cua WorkerService). */
  function stubProvider(result) {
    const orig = settings.getProvider.bind(settings);
    settings.getProvider = () => ({
      name: 'mock',
      async sendMessage() {
        return result;
      },
    });
    return () => {
      settings.getProvider = orig;
    };
  }

  test('tao job thanh cong', () => {
    const { job, created } = makeJob();
    expect(created).toBe(true);
    expect(job.status).toBe(JOB_STATUS.QUEUED);
    expect(job.attempts).toBe(0);
  });

  test('idempotency key trung -> tra job cu', () => {
    const a = makeJob({ idempotencyKey: 'same-key' });
    const b = makeJob({ idempotencyKey: 'same-key' });
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
  });

  test('worker lay job va danh dau processing', () => {
    makeJob();
    const leased = queue.leaseJobs({ limit: 1, workerId: 'w1', leaseSeconds: 60 });
    expect(leased.length).toBe(1);
    expect(leased[0].status).toBe(JOB_STATUS.PROCESSING);
    expect(leased[0].attempts).toBe(1);
  });

  test('hai worker khong lay cung mot job', () => {
    makeJob();
    const a = queue.leaseJobs({ limit: 1, workerId: 'w1', leaseSeconds: 60 });
    const b = queue.leaseJobs({ limit: 1, workerId: 'w2', leaseSeconds: 60 });
    expect(a.length).toBe(1);
    expect(b.length).toBe(0);
  });

  test('job treo (lease het han) duoc recovery', () => {
    makeJob();
    queue.leaseJobs({ limit: 1, workerId: 'w1', leaseSeconds: 5 });
    const { getDb } = require('../../src/database/connection');
    getDb()
      .prepare(
        "UPDATE gateway_jobs SET locked_until = datetime('now', '-1 hour') WHERE status = 'processing'"
      )
      .run();

    expect(queue.recoverStaleJobs()).toBe(1);

    const leased = queue.leaseJobs({ limit: 1, workerId: 'w2', leaseSeconds: 60 });
    expect(leased.length).toBe(1);
  });

  test('job thanh cong -> sent', async () => {
    makeJob();
    const worker = new WorkerService({ intervalMs: 100000 });
    await worker.tick();

    const history = await request(app).get('/api/messages/history').set(integrationHeaders());
    expect(history.body.items[0].status).toBe(JOB_STATUS.SENT);
    expect(history.body.items[0].attempts).toBe(1);
  });

  test('job that bai permanent -> failed, khong retry', async () => {
    const { job } = makeJob();
    const restore = stubProvider({
      success: false,
      errorCode: 'PERMANENT_ERROR',
      errorMessage: 'fail',
      deliveryStatus: 'failed',
      retryable: false,
      raw: null,
    });

    const worker = new WorkerService({ intervalMs: 100000, settings });
    await worker.tick();
    restore();

    const detail = await request(app).get(`/api/messages/jobs/${job.id}`).set(integrationHeaders());
    expect(detail.body.job.status).toBe(JOB_STATUS.FAILED);
    expect(detail.body.job.nextRetryAt).toBeNull();
  });

  test('job loi tam thoi -> retry voi backoff', async () => {
    const { job } = makeJob();
    const restore = stubProvider({
      success: false,
      errorCode: 'TEMPORARY_ERROR',
      errorMessage: 'temp fail',
      deliveryStatus: 'failed',
      retryable: true,
      raw: null,
    });

    const worker = new WorkerService({ intervalMs: 100000, settings });
    await worker.tick();
    restore();

    const detail = await request(app).get(`/api/messages/jobs/${job.id}`).set(integrationHeaders());
    expect(detail.body.job.status).toBe(JOB_STATUS.RETRY);
    expect(detail.body.job.attempts).toBe(1);
    expect(detail.body.job.nextRetryAt).toBeTruthy();
  });

  test('exponential backoff: cac lan retry tang dan', () => {
    const delays = settings.getRetryDelays();
    expect(delays[0]).toBe(10000);
    expect(delays[1]).toBe(30000);
    expect(delays[2]).toBe(120000);
    expect(delays[3]).toBe(300000);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  test('het so lan thu -> failed', async () => {
    const { job } = makeJob({ maxAttempts: 1 });
    const restore = stubProvider({
      success: false,
      errorCode: 'TEMPORARY_ERROR',
      errorMessage: 'temp',
      deliveryStatus: 'failed',
      retryable: true,
      raw: null,
    });

    const worker = new WorkerService({ intervalMs: 100000, settings });
    await worker.tick();
    restore();

    const detail = await request(app).get(`/api/messages/jobs/${job.id}`).set(integrationHeaders());
    expect(detail.body.job.status).toBe(JOB_STATUS.FAILED);
  });

  test('timeout -> unknown va KHONG tu retry', async () => {
    const { job } = makeJob();
    const restore = stubProvider({
      success: false,
      errorCode: 'TIMEOUT',
      errorMessage: 'timeout',
      deliveryStatus: 'unknown',
      retryable: false,
      raw: null,
    });

    const worker = new WorkerService({ intervalMs: 100000, settings });
    await worker.tick();
    restore();

    const detail = await request(app).get(`/api/messages/jobs/${job.id}`).set(integrationHeaders());
    expect(detail.body.job.status).toBe(JOB_STATUS.UNKNOWN);
    expect(detail.body.job.nextRetryAt).toBeNull();
  });

  test('restart ung dung khi co job dang xu ly -> job khong bi mat', async () => {
    const { job } = makeJob();
    queue.leaseJobs({ limit: 1, workerId: 'w1', leaseSeconds: 60 });

    const { getDb } = require('../../src/database/connection');
    getDb()
      .prepare(
        "UPDATE gateway_jobs SET locked_until = datetime('now', '-1 hour') WHERE status = 'processing'"
      )
      .run();

    const worker = new WorkerService({ intervalMs: 100000 });
    await worker.tick();

    const detail = await request(app).get(`/api/messages/jobs/${job.id}`).set(integrationHeaders());
    expect(detail.body.job.id).toBe(job.id);
    expect(['sent', 'processing']).toContain(detail.body.job.status);
  });

  test('moi lan thu duoc ghi log rieng', async () => {
    const { job } = makeJob();
    const worker = new WorkerService({ intervalMs: 100000 });

    await worker.tick();

    const { getDb } = require('../../src/database/connection');
    getDb()
      .prepare("UPDATE gateway_jobs SET status = 'queued', attempts = 0 WHERE id = ?")
      .run(job.id);
    await worker.tick();

    const detail = await request(app).get(`/api/messages/jobs/${job.id}`).set(integrationHeaders());
    expect(detail.body.attempts.length).toBe(2);
  });

  test('retry job failed -> queued', async () => {
    const { job } = makeJob();
    queue.markFailed(job.id, { error: 'x' });

    const res = await request(app)
      .post(`/api/messages/jobs/${job.id}/retry`)
      .set(integrationHeaders());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(JOB_STATUS.QUEUED);
  });

  test('retry job unknown bi tu choi (nguy co tin trung)', async () => {
    const { job } = makeJob();
    queue.markUnknown(job.id, { error: 'uncertain' });

    const res = await request(app)
      .post(`/api/messages/jobs/${job.id}/retry`)
      .set(integrationHeaders());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UNSAFE_RETRY');
  });

  test('retry job sent bi tu choi', async () => {
    const { job } = makeJob();
    queue.markSent(job.id, {});

    const res = await request(app)
      .post(`/api/messages/jobs/${job.id}/retry`)
      .set(integrationHeaders());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE');
  });

  test('huy job dang cho -> cancelled', async () => {
    const { job } = makeJob();
    const res = await request(app)
      .post(`/api/messages/jobs/${job.id}/cancel`)
      .set(integrationHeaders());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(JOB_STATUS.CANCELLED);
  });

  test('huy job da gui bi tu choi', async () => {
    const { job } = makeJob();
    queue.markSent(job.id, {});
    const res = await request(app)
      .post(`/api/messages/jobs/${job.id}/cancel`)
      .set(integrationHeaders());

    expect(res.status).toBe(409);
  });

  test('retry / cancel duoc audit', async () => {
    const { job } = makeJob();
    await request(app).post(`/api/messages/jobs/${job.id}/cancel`).set(integrationHeaders());

    const res = await request(app).get('/api/audit-logs?action=JOB_CANCEL').set(adminHeaders());
    expect(res.body.total).toBe(1);
  });

  test('thong ke hang doi theo trang thai', async () => {
    makeJob();
    makeJob();
    const res = await request(app).get('/api/messages/queue/summary').set(integrationHeaders());
    expect(res.body.counts.queued).toBe(2);
  });
});
