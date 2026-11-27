/**
 * TÍCH HỢP BEERPOS ↔ BEERPOS ZALO GATEWAY
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi test:
 *  - GatewayAdapter:
 *      • Gửi tin thành công (Gateway trả 202) → ProviderResult success
 *      • Khách chưa liên kết nhóm (Gateway 404) → lỗi VĨNH VIỄN, không retry
 *      • Gateway offline (network error) → 'unknown', KHÔNG retry mù
 *      • Gateway 5xx → retryable
 *      • Gateway 401/403 → lỗi VĨNH VIỄN
 *      • Idempotency key truyền đúng & ổn định
 *  - GatewayClient:
 *      • Timeout → GATEWAY_UNREACHABLE
 *      • Thiếu api key → GATEWAY_NOT_CONFIGURED
 *  - ProviderFactory: chọn đúng provider theo cấu hình (omicall/gateway/mock)
 *  - NotificationWorker + provider=gateway:
 *      • Job KHÔNG bị chặn vì thiếu group cục bộ
 *      • Idempotency key dùng chung format với Gateway
 *
 * ⚠️ KHÔNG gọi mạng thật — GatewayClient được stub hoàn toàn.
 */

process.env.NODE_ENV = 'test';

const GatewayClient = require('../../src/services/notify/GatewayClient');
const { GatewayAdapter, classifyGatewayError } = require('../../src/services/notify/provider/GatewayAdapter');
const ProviderFactory = require('../../src/services/notify/provider');
const { buildGatewayIdempotencyKey } = require('../../src/services/notify/NotificationWorker');
const { DELIVERY_STATUS, ERROR_CODES } = require('../../src/services/notify/provider/NotificationProvider');

jest.setTimeout(30000);

/**
 * Tạo adapter với client giả.
 * @param {object} res - kết quả mà client sẽ trả về
 */
function makeAdapter(res) {
  const calls = [];
  const client = {
    calls,
    async sendMessage(payload, idempotencyKey) {
      calls.push({ payload, idempotencyKey });
      return res;
    },
    async health() {
      return { success: true, status: 200, baseUrl: 'http://localhost:3100', data: { status: 'ok' } };
    },
    getConfig() {
      return { baseUrl: 'http://localhost:3100', apiKey: 'x', configured: true, timeoutMs: 10000 };
    },
  };
  return { adapter: new GatewayAdapter({ client }), calls };
}

// ── GatewayAdapter ───────────────────────────────────────────────────────────

describe('GatewayAdapter — kết quả bàn giao', () => {
  test('Gateway tiếp nhận job → success, deliveryStatus = accepted (KHÔNG delivered)', async () => {
    const { adapter, calls } = makeAdapter({
      ok: true,
      status: 202,
      jobId: 'JOB001',
      status: 'queued',
      duplicate: false,
    });

    const res = await adapter.sendMessage({
      customerId: 'KH001',
      paymentId: 'PAY001',
      text: 'Quán đã thanh toán 2.000.000đ',
      groupId: 'GROUP001',
    });

    expect(res.success).toBe(true);
    expect(res.deliveryStatus).toBe(DELIVERY_STATUS.ACCEPTED);
    expect(res.deliveryStatus).not.toBe(DELIVERY_STATUS.DELIVERED);
    expect(res.providerMessageId).toBe('gw_job_JOB001');
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.customerId).toBe('KH001');
    expect(calls[0].payload.message).toContain('2.000.000đ');
  });

  test('Idempotency key ổn định & theo transactionId', async () => {
    const { adapter, calls } = makeAdapter({ ok: true, status: 202, jobId: 'J1' });
    const msg = { customerId: 'KH001', paymentId: 'PAY001', text: 'x' };

    await adapter.sendMessage(msg);
    await adapter.sendMessage(msg);

    expect(calls[0].idempotencyKey).toBe(calls[1].idempotencyKey);
    expect(calls[0].idempotencyKey).toBe('gateway-notification:PAY001');
  });

  test('Khách chưa liên kết nhóm (404) → lỗi VĨNH VIỄN, không retry', async () => {
    const { adapter } = makeAdapter({
      ok: false,
      status: 404,
      code: 'CUSTOMER_GROUP_NOT_LINKED',
      error: 'Khách hàng chưa được liên kết nhóm',
    });

    const res = await adapter.sendMessage({ customerId: 'KH999', text: 'abc' });

    expect(res.success).toBe(false);
    expect(res.retryable).toBe(false);
    expect(res.errorCode).toBe(ERROR_CODES.INVALID_GROUP);
  });

  test('Gateway offline → unknown, KHÔNG retry mù (timeout)', async () => {
    const { adapter } = makeAdapter({
      ok: false,
      status: 0,
      code: 'GATEWAY_UNREACHABLE',
      error: 'Gateway timeout',
      networkError: true,
      timeout: true,
    });

    const res = await adapter.sendMessage({ customerId: 'KH001', text: 'abc' });

    expect(res.success).toBe(false);
    expect(res.deliveryStatus).toBe(DELIVERY_STATUS.UNKNOWN);
    expect(res.retryable).toBe(false);
  });

  test('Gateway KHÔNG chạy (connection refused) → retryable an toàn', async () => {
    const { adapter } = makeAdapter({
      ok: false,
      status: 0,
      code: 'GATEWAY_UNREACHABLE',
      error: 'Không kết nối được Gateway',
      networkError: true,
      timeout: false,
    });

    const res = await adapter.sendMessage({ customerId: 'KH001', text: 'abc' });

    expect(res.success).toBe(false);
    expect(res.deliveryStatus).toBe(DELIVERY_STATUS.FAILED);
    expect(res.retryable).toBe(true);
  });

  test('Gateway 5xx → lỗi TẠM THỜI (được retry)', async () => {
    const { adapter } = makeAdapter({
      ok: false,
      status: 503,
      code: 'INTERNAL',
      error: 'Service Unavailable',
    });

    const res = await adapter.sendMessage({ customerId: 'KH001', text: 'abc' });

    expect(res.success).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.errorCode).toBe(ERROR_CODES.TEMPORARY_ERROR);
  });

  test('Gateway 429 → retryable', async () => {
    const { adapter } = makeAdapter({ ok: false, status: 429, code: 'RATE_LIMITED', error: 'Too many' });
    const res = await adapter.sendMessage({ customerId: 'KH001', text: 'abc' });
    expect(res.retryable).toBe(true);
  });

  test('Gateway 401/403 → lỗi VĨNH VIỄN', async () => {
    const { adapter } = makeAdapter({ ok: false, status: 403, code: 'FORBIDDEN', error: 'Forbidden' });
    const res = await adapter.sendMessage({ customerId: 'KH001', text: 'abc' });
    expect(res.retryable).toBe(false);
    expect(res.errorCode).toBe(ERROR_CODES.PERMISSION_DENIED);
  });

  test('Gateway 400 → lỗi VĨNH VIỄN', async () => {
    const { adapter } = makeAdapter({ ok: false, status: 400, code: 'VALIDATION_ERROR', error: 'Sai' });
    const res = await adapter.sendMessage({ customerId: 'KH001', text: 'abc' });
    expect(res.retryable).toBe(false);
    expect(res.errorCode).toBe(ERROR_CODES.INVALID_CONTENT);
  });

  test('Thiếu customerId → lỗi VĨNH VIỄN, KHÔNG gọi Gateway', async () => {
    const { adapter, calls } = makeAdapter({ ok: true, status: 202, jobId: 'J' });
    const res = await adapter.sendMessage({ text: 'abc' });
    expect(res.success).toBe(false);
    expect(res.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('Thiếu nội dung → lỗi VĨNH VIỄN, KHÔNG gọi Gateway', async () => {
    const { adapter, calls } = makeAdapter({ ok: true, status: 202, jobId: 'J' });
    const res = await adapter.sendMessage({ customerId: 'KH001', text: '  ' });
    expect(res.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('Adapter KHÔNG BAO GIỜ throw ra ngoài', async () => {
    const adapter = new GatewayAdapter({
      client: {
        async sendMessage() {
          throw new Error('boom');
        },
      },
    });
    const res = await adapter.sendMessage({ customerId: 'KH001', text: 'abc' });
    expect(res).toBeTruthy();
    expect(res.success).toBe(false);
  });
});

// ── classifyGatewayError ─────────────────────────────────────────────────────

describe('classifyGatewayError', () => {
  test('timeout → unknown, KHÔNG retry mù (Gateway có thể đã nhận)', () => {
    const cls = classifyGatewayError({ status: 0, networkError: true, timeout: true });
    expect(cls.unknown).toBe(true);
    expect(cls.retryable).toBe(false);
  });

  test('kết nối thất bại → retryable an toàn (Gateway CHƯA nhận)', () => {
    const cls = classifyGatewayError({ status: 0, networkError: true, timeout: false });
    expect(cls.unknown).toBeUndefined();
    expect(cls.retryable).toBe(true);
    expect(cls.errorCode).toBe(ERROR_CODES.TEMPORARY_ERROR);
  });

  test('chưa cấu hình → CONFIG_ERROR, không retry', () => {
    const cls = classifyGatewayError({ status: 0, code: 'GATEWAY_NOT_CONFIGURED' });
    expect(cls.errorCode).toBe(ERROR_CODES.CONFIG_ERROR);
    expect(cls.retryable).toBe(false);
  });

  test('404 → INVALID_GROUP, không retry', () => {
    const cls = classifyGatewayError({ status: 404 });
    expect(cls.errorCode).toBe(ERROR_CODES.INVALID_GROUP);
    expect(cls.retryable).toBe(false);
  });

  test('5xx → TEMPORARY_ERROR, retry', () => {
    const cls = classifyGatewayError({ status: 500 });
    expect(cls.retryable).toBe(true);
  });
});

// ── Idempotency key dùng chung ──────────────────────────────────────────────

describe('Idempotency key dùng chung BeerPOS ↔ Gateway', () => {
  test('có transactionId → payment-notification:<txId>', () => {
    expect(buildGatewayIdempotencyKey({ transaction_id: 42 })).toBe('payment-notification:42');
  });

  test('không có transactionId → fallback theo khách + job', () => {
    const key = buildGatewayIdempotencyKey({ customer_id: 7, id: 9 });
    expect(key).toBe('payment-notification:7:9');
  });

  test('key ổn định qua nhiều lần gọi', () => {
    const job = { transaction_id: 100, customer_id: 3, id: 5 };
    expect(buildGatewayIdempotencyKey(job)).toBe(buildGatewayIdempotencyKey(job));
  });
});

// ── ProviderFactory ─────────────────────────────────────────────────────────

describe('ProviderFactory — chọn provider theo cấu hình', () => {
  afterEach(() => {
    ProviderFactory.resetProviders();
    delete process.env.NOTIFICATION_PROVIDER;
  });

  test('có provider gateway', () => {
    expect(ProviderFactory.PROVIDERS.GATEWAY).toBe('gateway');
    expect(ProviderFactory.createProvider('gateway')).toBeInstanceOf(GatewayAdapter);
  });

  test('provider gateway KHÔNG bị coi là mô phỏng', () => {
    expect(ProviderFactory.isSimulated('gateway')).toBe(false);
    expect(ProviderFactory.isGateway('gateway')).toBe(true);
  });

  test('env NOTIFICATION_PROVIDER= gateway → chọn GatewayAdapter', () => {
    process.env.NOTIFICATION_PROVIDER = 'gateway';
    expect(ProviderFactory.getProviderName()).toBe('gateway');
    expect(ProviderFactory.getProvider()).toBeInstanceOf(GatewayAdapter);
  });

  test('provider lạ → fallback mock (không throw)', () => {
    expect(ProviderFactory.createProvider('khong_ton_tai')).toBeTruthy();
  });
});

// ── GatewayClient — không gọi mạng thật ─────────────────────────────────────

describe('GatewayClient — an toàn khi Gateway offline', () => {
  const savedFetch = global.fetch;

  afterEach(() => {
    global.fetch = savedFetch;
  });

  test('thiếu API key → GATEWAY_NOT_CONFIGURED, không gọi mạng', async () => {
    global.fetch = jest.fn();
    const savedKey = process.env.NOTIFY_GATEWAY_API_KEY;
    const savedUrl = process.env.NOTIFY_GATEWAY_URL;
    delete process.env.NOTIFY_GATEWAY_API_KEY;
    delete process.env.NOTIFY_GATEWAY_URL;

    const res = await GatewayClient.request('GET', '/health');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('GATEWAY_NOT_CONFIGURED');
    expect(global.fetch).not.toHaveBeenCalled();

    if (savedKey) process.env.NOTIFY_GATEWAY_API_KEY = savedKey;
    if (savedUrl) process.env.NOTIFY_GATEWAY_URL = savedUrl;
  });

  test('mất mạng → GATEWAY_UNREACHABLE, networkError = true', async () => {
    const savedKey = process.env.NOTIFY_GATEWAY_API_KEY;
    process.env.NOTIFY_GATEWAY_API_KEY = 'test_key';
    global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED')));

    const res = await GatewayClient.request('GET', '/health');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('GATEWAY_UNREACHABLE');
    expect(res.networkError).toBe(true);
    // Kết nối thất bại (chưa hề gửi) → timeout = false → retry an toàn.
    expect(res.timeout).toBe(false);

    if (savedKey) process.env.NOTIFY_GATEWAY_API_KEY = savedKey;
    else delete process.env.NOTIFY_GATEWAY_API_KEY;
  });

  test('timeout → GATEWAY_UNREACHABLE, timeout = true (KHÔNG retry mù)', async () => {
    const savedKey = process.env.NOTIFY_GATEWAY_API_KEY;
    process.env.NOTIFY_GATEWAY_API_KEY = 'test_key';

    global.fetch = jest.fn((url, options) => {
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const res = await GatewayClient.request('GET', '/health', null, { timeoutMs: 1000 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('GATEWAY_UNREACHABLE');
    expect(res.networkError).toBe(true);
    expect(res.timeout).toBe(true);

    if (savedKey) process.env.NOTIFY_GATEWAY_API_KEY = savedKey;
    else delete process.env.NOTIFY_GATEWAY_API_KEY;
  });

  test('nội dung rỗng → từ chối ngay, không gọi mạng', async () => {
    global.fetch = jest.fn();
    const res = await GatewayClient.sendMessage({ customerId: 'KH001', message: '  ' }, 'k1');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('VALIDATION_ERROR');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('nội dung quá dài → từ chối ngay', async () => {
    global.fetch = jest.fn();
    const res = await GatewayClient.sendMessage(
      { customerId: 'KH001', message: 'x'.repeat(5000) },
      'k1'
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('VALIDATION_ERROR');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
