const svc = require('../src/services/OmiCallService');

// NHÓM TEST: 6afe6913fca59218a5d662b0 (dành riêng cho test)
const TEST_CONV = '6afe6913fca59218a5d662b0';

(async () => {
  const r = await svc.sendZaloPersonalMessage({
    convId: TEST_CONV,
    text: '[TEST] xac nhan gui lai OmiCall - nhom test',
  });
  console.log('success:', r.success, '| error:', r.error, '| messageId:', r.messageId);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
