const MockProvider = require('../../src/providers/MockProvider');
const { createProvider, UnauthorizedProvider } = require('../../src/providers');

describe('MockProvider', () => {
  test('mock success -> accepted (KHONG phai delivered)', async () => {
    const p = new MockProvider({ scenario: 'success' });
    const res = await p.sendMessage({ groupId: 'GROUP001', text: 'Xin chào' });

    expect(res.success).toBe(true);
    expect(res.deliveryStatus).toBe('accepted');
    expect(res.deliveryStatus).not.toBe('delivered');
    expect(res.simulated).toBe(true);
    expect(res.providerMessageId).toMatch(/^mock_/);
  });

  test('mock failure -> permanent, khong retry', async () => {
    const p = new MockProvider({ scenario: 'failure' });
    const res = await p.sendMessage({ groupId: 'GROUP001', text: 'abc' });

    expect(res.success).toBe(false);
    expect(res.retryable).toBe(false);
    expect(res.deliveryStatus).toBe('failed');
  });

  test('mock transient -> retryable', async () => {
    const p = new MockProvider({ scenario: 'transient' });
    const res = await p.sendMessage({ groupId: 'GROUP001', text: 'abc' });

    expect(res.success).toBe(false);
    expect(res.retryable).toBe(true);
  });

  test('mock timeout -> unknown, khong retry', async () => {
    const p = new MockProvider({ scenario: 'timeout' });
    const res = await p.sendMessage({ groupId: 'GROUP001', text: 'abc' });

    expect(res.success).toBe(false);
    expect(res.deliveryStatus).toBe('unknown');
    expect(res.retryable).toBe(false);
  });

  test('mock invalid_destination -> validateDestination that bai', async () => {
    const p = new MockProvider({ scenario: 'invalid_destination' });
    const check = p.validateDestination('GROUP001');
    expect(check.valid).toBe(false);

    const res = await p.sendMessage({ groupId: 'GROUP001', text: 'abc' });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_DESTINATION');
  });

  test('validateDestination: thieu groupId', async () => {
    const p = new MockProvider({ scenario: 'success' });
    const check = p.validateDestination('');
    expect(check.valid).toBe(false);
    expect(check.code).toBe('INVALID_DESTINATION');
  });

  test('noi dung rong bi tu choi', async () => {
    const p = new MockProvider({ scenario: 'success' });
    const res = await p.sendMessage({ groupId: 'GROUP001', text: '   ' });
    expect(res.success).toBe(false);
  });

  test('getStatus bao hieu simulated', async () => {
    const p = new MockProvider({ scenario: 'success' });
    const st = await p.getStatus();
    expect(st.simulated).toBe(true);
    expect(st.available).toBe(true);
    expect(st.provider).toBe('mock');
  });

  test('getCapabilities: khong co delivery confirmation', () => {
    const p = new MockProvider({ scenario: 'success' });
    expect(p.getCapabilities().deliveryConfirmation).toBe(false);
    expect(p.getCapabilities().simulated).toBe(true);
  });

  test('scenario khong hop le -> fallback success', async () => {
    const p = new MockProvider({ scenario: 'khong_ton_tai' });
    expect(p.scenario).toBe('success');
  });
});

describe('Provider factory', () => {
  test('tao mock provider', () => {
    const p = createProvider('mock');
    expect(p).toBeInstanceOf(MockProvider);
  });

  test('provider khong duoc cap quyen -> unavailable', async () => {
    const p = createProvider('zalo_official');
    expect(p).toBeInstanceOf(UnauthorizedProvider);
    const st = await p.getStatus();
    expect(st.available).toBe(false);
    const res = await p.sendMessage({ groupId: 'G', text: 't' });
    expect(res.success).toBe(false);
    expect(res.retryable).toBe(false);
  });

  test('khong provider nao bao hieu da gui den Zalo that', async () => {
    const providers = [createProvider('mock'), createProvider('khong_x')];
    for (const p of providers) {
      const caps = p.getCapabilities();
      if (p.name === 'mock') {
        expect(caps.deliveryConfirmation).toBe(false);
      } else {
        expect(caps.sendMessage).toBe(false);
      }
    }
  });
});
