/**
 * Trình bày lại các trang: sổ công nợ / thông báo / SePay
 * ─────────────────────────────────────────────────────────────────────────────
 * YÊU CẦU (2026-11-24):
 *   1. "Lịch sử nên làm gọn theo trang" → mỗi trang có phần LỊCH SỬ
 *      gói trong accordion (mặc định thu gọn), không tràn dài.
 *   2. "Cài đặt nên nằm ở vị trí đầu trang và gọn gàng dễ hiểu"
 *      → khối CÀI ĐẶT phải xuất hiện TRƯỚC các khối khác trong cùng tab.
 *
 * Test kiểm tra SOURCE CODE (HTML) vì UI thuần không chạy trong Jest.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEBTS = path.join(ROOT, 'views', 'debts.html');
const REPORT_NOTIFY = path.join(ROOT, 'views', 'report-notify.html');

describe('Trình bày lại trang sổ công nợ / thông báo / SePay', () => {
  let debts;
  let reportNotify;

  beforeAll(() => {
    debts = fs.readFileSync(DEBTS, 'utf8');
    reportNotify = fs.readFileSync(REPORT_NOTIFY, 'utf8');
  });

  // ── CSS: khối accordion dùng chung ────────────────────────────────────
  test('debts.html có CSS khối gọn gàng (accordion)', () => {
    expect(debts).toMatch(/\.dbt-collapse\s*\{/);
    expect(debts).toMatch(/\.dbt-collapse > summary\s*\{/);
    expect(debts).toMatch(/\.dbt-collapse__body\s*\{/);
    expect(debts).toMatch(/\.dbt-collapse__count\s*\{/);
  });

  test('report-notify.html có CSS khối gọn gàng (accordion)', () => {
    expect(reportNotify).toMatch(/\.rn-collapse\s*\{/);
    expect(reportNotify).toMatch(/\.rn-collapse > summary\s*\{/);
    expect(reportNotify).toMatch(/\.rn-collapse__body\s*\{/);
  });

  // ── SePay: cài đặt ở ĐẦU, lịch sử gọn gàng ───────────────────────────
  test('tab Sepay: khối CÀI ĐẶT xuất hiện TRƯỚC bảng giao dịch', () => {
    const fn = debts.slice(
      debts.indexOf('function renderSepay()'),
      debts.indexOf('// ── Render: Groups')
    );
    // Xét theo THỨ TỰ RENDER (phần return cuối cùng) chứ không theo thứ tự khai báo biến
    const retIdx = fn.lastIndexOf('return \'<div class="dbt-section">\'');
    const ret = fn.slice(retIdx);
    const settingsIdx = ret.indexOf('settingsHtml +');
    const txIdx = ret.indexOf('txTableHtml +');
    const smartIdx = ret.indexOf('smartHtml +');
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(txIdx).toBeGreaterThan(-1);
    expect(smartIdx).toBeGreaterThan(-1);
    // Cài đặt phải nằm trước lịch sử + gạch nợ thông minh
    expect(settingsIdx).toBeLessThan(txIdx);
    expect(settingsIdx).toBeLessThan(smartIdx);
  });

  test('tab Sepay: cài đặt dùng accordion (mở khi chưa cấu hình)', () => {
    const fn = debts.slice(
      debts.indexOf('function renderSepay()'),
      debts.indexOf('// ── Render: Groups')
    );
    expect(fn).toMatch(/<details class="dbt-collapse"' \+ \(configured \? '' : ' open'\)/);
  });

  test('tab Sepay: lịch sử giao dịch gói trong accordion', () => {
    const fn = debts.slice(
      debts.indexOf('function renderSepay()'),
      debts.indexOf('// ── Render: Groups')
    );
    expect(fn).toMatch(/<details class="dbt-collapse"' \+ \(pendingCount > 0 \? ' open' : ''\)/);
    expect(fn).toContain('📜 Lịch sử giao dịch');
  });

  test('tab Sepay: gạch nợ thông minh gói trong accordion', () => {
    const fn = debts.slice(
      debts.indexOf('function renderSepay()'),
      debts.indexOf('// ── Render: Groups')
    );
    expect(fn).toContain('🧠 Gạch nợ thông minh');
    expect(fn).toMatch(/smartHtml = '<details class="dbt-collapse"/);
  });

  // ── Thông báo: cài đặt ở ĐẦU, lịch sử gọn gàng ───────────────────────
  test('tab Thông báo: khối CÀI ĐẶT xuất hiện TRƯỚC lịch sử', () => {
    const fn = debts.slice(
      debts.indexOf('function renderNotify()'),
      debts.indexOf('// ── Render: Permissions')
    );
    const settingsIdx = fn.indexOf('⚙️ Cấu hình OmiCall');
    const missingIdx = fn.indexOf('📮 Tin chưa gửi');
    const historyIdx = fn.indexOf('📨 Lịch sử gửi tin nhắn');
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(settingsIdx).toBeLessThan(missingIdx);
    expect(settingsIdx).toBeLessThan(historyIdx);
  });

  test('tab Thông báo: tin chưa gửi + lịch sử gói trong accordion', () => {
    const fn = debts.slice(
      debts.indexOf('function renderNotify()'),
      debts.indexOf('// ── Render: Permissions')
    );
    expect(fn).toMatch(/missingHtml =\s*'<details class="dbt-collapse"/);
    expect(fn).toMatch(/var historyHtml =\s*'<details class="dbt-collapse"/);
  });

  // ── Chi tiết khách: lịch sử gọn gàng ──────────────────────────────────
  test('tab Chi tiết khách: lịch sử + đơn nợ + nhóm Zalo gói trong accordion', () => {
    const fn = debts.slice(
      debts.indexOf('function renderDetail()'),
      debts.indexOf('// ── Render: Sepay')
    );
    expect(fn).toContain('🧾 Đơn hàng đang nợ');
    expect(fn).toContain('📜 Lịch sử giao dịch');
    expect(fn).toContain('💬 Nhóm Zalo liên kết');
    const accCount = (fn.match(/<details class="dbt-collapse"/g) || []).length;
    expect(accCount).toBeGreaterThanOrEqual(3);
  });

  // ── Trang báo cáo tự động (report-notify) ────────────────────────────
  test('report-notify: cài đặt ở ĐẦU trang, lịch sử gọn gàng', () => {
    const fn = reportNotify.slice(
      reportNotify.indexOf('function renderConfig()'),
      reportNotify.indexOf('// ── Events')
    );
    const settingsIdx = fn.indexOf('⚙️ Cài đặt gửi báo cáo');
    expect(settingsIdx).toBeGreaterThan(-1);
    // Accordion cho kênh nhận + token
    expect(fn).toMatch(/<details class="rn-collapse"/);
    // Nút Lưu nằm trong khối cài đặt
    expect(fn.indexOf('id="rnSave"')).toBeGreaterThan(settingsIdx);
  });

  test('report-notify: xem thử & lịch sử gói trong accordion', () => {
    const fn = reportNotify.slice(
      reportNotify.indexOf('function render()'),
      reportNotify.indexOf('// ── Events')
    );
    const accCount = (fn.match(/<details class="rn-collapse"/g) || []).length;
    expect(accCount).toBeGreaterThanOrEqual(2);
    expect(fn).toContain('🧪 Xem thử & gửi ngay');
    expect(fn).toContain('🕘 Lịch sử gửi');
  });

  // ── Mô tả tab giúp người dùng biết đang ở đâu ────────────────────────
  test('debts.html có mô tả ngắn cho từng tab', () => {
    expect(debts).toMatch(/var TAB_DESC = \{/);
    ['overview', 'customers', 'sepay', 'groups', 'notify', 'permissions', 'reconciliation', 'bridge']
      .forEach((id) => {
        expect(debts).toMatch(new RegExp(id + ':'));
      });
    expect(debts).toContain('dbt-tab-desc');
  });

  // ── Không phá vỡ hàm cũ ────────────────────────────────────────────────
  test('giữ nguyên các hàm / id quan trọng', () => {
    // ID input cấu hình Sepay & OmiCall phải còn
    ['sepApiToken', 'sepWebhookSecret', 'sepPrefix', 'sepAutoPollInterval', 'sepAutoSettle', 'sepAutoPoll']
      .forEach((id) => expect(debts).toContain('id="' + id + '"'));
    ['omiApiKey', 'omiBaseUrl', 'omiTitle', 'omiEnabled', 'omiManualDebt']
      .forEach((id) => expect(debts).toContain('id="' + id + '"'));
    ['rnEnabled', 'rnTime', 'rnChannel', 'rnSave', 'rnPreview', 'rnSend']
      .forEach((id) => expect(reportNotify).toContain('id="' + id + '"'));
    // Endpoint gọi API không đổi
    expect(debts).toContain("var SEPAY_API = '/api/debt-ledger/sepay'");
    expect(debts).toContain('saveSepaySettings()');
    expect(debts).toContain('saveNotifySettings()');
  });
});
