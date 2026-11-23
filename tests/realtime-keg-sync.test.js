/**
 * Test: Realtime event + Service Worker redirect handling
 * ─────────────────────────────────────────────────────
 * BUG ĐÃ SỬA (2026-11-23):
 *  1. Server redirect 302 `/js/realtime.js?v=CU` → `?v=APP_VERSION`.
 *     SW fetch với `cache:'no-store'` KHÔNG follow redirect → fallback trả
 *     503 JSON → browser nạp JSON như JS → "Unexpected token ':'" →
 *     window.Realtime = undefined → socket KHÔNG BAO GIỜ kết nối →
 *     trang Admin & Giao hàng không cập nhật số vỏ khi sửa đơn.
 *  2. `window.APP_MODE` sai ('admin' thay vì 'driver') trên trang /driver/*
 *     → socket vào room admin thay vì room driver.
 *  3. `req.app.get('io')` = undefined (thiếu `app.set('io', ...)`) →
 *     emit socket trong routes/api/sales.js im lặng fail.
 *  4. Debounce key của `order:updated` dùng `data.id` nhưng payload là
 *     `{ sale: {...} }` → key luôn rỗng → nhiều đơn sửa liên tiếp bị nuốt.
 *
 * Các test dưới đây chống lại từng nguyên nhân.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('Service Worker — không trả JSON cho file JS', () => {
  let sw;

  beforeAll(() => {
    sw = read('public/sw.v2.js');
  });

  test('SW có xử lý redirect 302 thủ công (opaqueredirect)', () => {
    expect(sw).toContain('opaqueredirect');
    expect(sw).toMatch(/resp\.status\s*>=\s*300\s*&&\s*resp\.status\s*<\s*400/);
  });

  test('SW fetch lại URL sau redirect với redirect:follow', () => {
    expect(sw).toMatch(/redirect:\s*'follow'/);
  });

  test('Fallback của /js/realtime.js trả JS rỗng, KHÔNG phải JSON', () => {
    // jsFallback() phải trả Content-Type application/javascript
    expect(sw).toMatch(
      /const jsFallback = \(\) => new Response\('[^']*',\s*\{\s*status: 503,\s*headers: \{ 'Content-Type': 'application\/javascript/
    );
    // Không được còn fallback JSON cho realtime.js
    const realtimeBlock = sw.slice(
      sw.indexOf("parsed.pathname === '/js/realtime.js'"),
      sw.indexOf("parsed.pathname.startsWith('/api/auth')")
    );
    expect(realtimeBlock).not.toContain('Network unavailable');
    expect(realtimeBlock).toContain('jsFallback()');
  });

  test('Static assets .js/.css cũng dùng jsFallback, không JSON', () => {
    expect(sw).toContain('jsFallback()');
    expect(sw).toMatch(/\\.\(\?:js\|css\)\$/i);
  });
});

describe('Realtime client — debounce key lấy đúng id đơn', () => {
  let realtime;

  beforeAll(() => {
    realtime = read('public/js/realtime.js');
  });

  test('Có helper orderEventKey đọc data.sale.id', () => {
    expect(realtime).toContain('function orderEventKey');
    expect(realtime).toMatch(/data\.sale\s*\|\|\s*data\.order/);
  });

  test('order:updated / order:created / order:deleted dùng orderEventKey', () => {
    expect(realtime).toContain("'order:updated:' + orderEventKey(data)");
    expect(realtime).toContain("'order:created:' + orderEventKey(data)");
    expect(realtime).toContain("'order:deleted:' + orderEventKey(data)");
  });

  test('order:updated triggerRefetch có entity "deliveries" (trang giao hàng)', () => {
    const idx = realtime.indexOf("_socket.on('order:updated'");
    const block = realtime.slice(idx, realtime.indexOf("_socket.on('order:deleted'"));
    expect(block).toContain("'deliveries'");
  });
});

describe('Loader realtime — không hardcode version cũ', () => {
  test('public/js/layout.js dùng window.APP_VERSION', () => {
    const layout = read('public/js/layout.js');
    expect(layout).toContain('window.APP_VERSION');
    expect(layout).not.toContain("script.src = '/js/realtime.js?v=20261113a'");
  });

  test('public/js/driver/core.js dùng window.APP_VERSION', () => {
    const core = read('public/js/driver/core.js');
    expect(core).toContain('window.APP_VERSION');
    expect(core).not.toContain("script.src = '/js/realtime.js?v=20261113a'");
  });

  test('Không còn file nào hardcode version realtime cũ', () => {
    const files = ['public/js/layout.js', 'public/js/driver/core.js'];
    for (const f of files) {
      expect(read(f)).not.toMatch(/\?v=20261113a['"]/);
    }
  });
});

describe('Server — app.set("io") và APP_MODE cho trang driver', () => {
  let server;

  beforeAll(() => {
    server = read('server.js');
  });

  test('app.set("io", socketServer.getIO()) được gọi sau socketServer.init', () => {
    expect(server).toContain("app.set('io', socketServer.getIO())");
    const initIdx = server.indexOf('socketServer.init(server)');
    const setIdx = server.indexOf("app.set('io', socketServer.getIO())");
    expect(initIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeGreaterThan(initIdx);
  });

  test('Trang views/driver/* ép APP_MODE = driver', () => {
    expect(server).toContain('isDriverPage');
    expect(server).toContain("const effectiveMode = isDriverPage ? 'driver' : mode;");
    expect(server).toContain("window.APP_MODE = '${effectiveMode}'");
  });
});

describe('optionalAuth — hỗ trợ ?token=', () => {
  test('middleware/permissions.js đọc req.query.token', () => {
    const perm = read('middleware/permissions.js');
    expect(perm).toContain('const queryToken = req.query?.token;');
    expect(perm).toMatch(/adminCookieToken\s*\|\|\s*queryToken/);
  });
});

describe('Backend — API sửa đơn trả deliver_kegs đồng bộ', () => {
  test('routes/api/sales.js gọi syncRecordWithSaleItems', () => {
    const sales = read('routes/api/sales.js');
    expect(sales).toContain('DeliveryService.syncRecordWithSaleItems(saleId)');
    expect(sales).toContain('socketServer.emitOrderUpdated(updatedSale)');
  });

  test('DeliveryService.syncRecordWithSaleItems cập nhật expected_kegs + items', () => {
    const svc = read('src/services/DeliveryService.js');
    expect(svc).toContain('SET expected_kegs = ?');
    expect(svc).toContain('expected_quantity');
  });
});
