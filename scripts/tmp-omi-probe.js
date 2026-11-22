const svc = require('../src/services/OmiCallService');

(async () => {
  const convId = '6afe6913fca59218a5d662ad'; // Tiệm Nướng 1998 (từng gửi OK)
  const text = '[TEST] kiem tra gui lai OmiCall qua service';

  console.log('--- Gọi service.sendZaloPersonalMessage:');
  const res = await svc.sendZaloPersonalMessage({ convId, text });
  console.log('success:', res.success);
  console.log('error:', res.error);
  console.log('messageId:', res.messageId);
  console.log('raw:', JSON.stringify(res.raw, null, 1).slice(0, 900));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
