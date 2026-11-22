const svc = require('../src/services/OmiCallService');

// Nhóm DÀNH RIÊNG CHO TEST — không gửi vào nhóm khách thật.
const TEST_CONV = '6afe6913fca59218a5d662b0';

(async () => {
  console.log('=== A. Kiểm tra conv co ton tai khong (chi doc):');
  const probe = await svc.probeSendEndpoints({ convId: TEST_CONV, text: '[TEST] kiem tra OmiCall' });
  console.log('attempts:', probe.attempts.length, '| best:', probe.best ? 'OK' : 'null');
  for (const a of probe.attempts) {
    if (a.host.includes('omicrm')) {
      console.log(`  ${a.result} | http=${a.http} | sc=${a.status_code} | body=${a.body} | detail=${a.detail}`);
    }
  }

  console.log('\n=== B. Gui tin that qua service vao nhom TEST:');
  const res = await svc.sendZaloPersonalMessage({
    convId: TEST_CONV,
    text: '[TEST] kiem tra OmiCall - nhom test',
  });
  console.log('success:', res.success);
  console.log('error:', res.error);
  console.log('messageId:', res.messageId);
  console.log('raw:', JSON.stringify(res.raw).slice(0, 500));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
