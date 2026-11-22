const { PromotionService } = { PromotionService: null };
const svc = require('../src/services/OmiCallService');

(async () => {
  const cfg = svc.getConfig();
  console.log('baseUrl:', cfg.baseUrl);
  console.log('apiKey:', String(cfg.apiKey).slice(0, 6) + '***');

  // 1) Lấy token
  let token = null;
  try {
    token = await svc.__getAccessToken ? await svc.__getAccessToken({ force: true }) : null;
  } catch (e) { console.log('token err', e.message); }

  // 2) Probe các endpoint gửi tin với group đã biết là thành công trước đây
  const convId = '6afe6913fca59218a5d662ad';
  const text = '[TEST] kiem tra gui lai OmiCall';
  const res = await svc.probeSendEndpoints({ convId, text });
  console.log('--- PROBE attempts:');
  for (const a of res.attempts) {
    console.log(`${a.result} | http=${a.http} | sc=${a.status_code} | ${a.host}${a.path} | body=${a.body} | detail=${a.detail}`);
  }
  console.log('--- BEST:', JSON.stringify(res.best, null, 1));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
