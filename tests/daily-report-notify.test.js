/**
 * Unit test cho DailyReportService + ReportNotifyService
 *
 * Mục tiêu: bảo đảm báo cáo tự động (B1 — Zalo OA) luôn đúng số liệu,
 * đúng định dạng tiền tệ, và không gửi trùng.
 *
 * Mỗi test file chạy trên DB riêng (copy từ database.sqlite) — xem tests/setup.js.
 */
const db = require('../database');
const DailyReportService = require('../src/services/DailyReportService');
const ReportNotifyService = require('../src/services/ReportNotifyService');

describe('DailyReportService — helpers', () => {
  test('formatVND dùng dấu phân cách kiểu Việt Nam', () => {
    expect(DailyReportService.formatVND(0)).toBe('0 ₫');
    expect(DailyReportService.formatVND(150000)).toBe('150.000 ₫');
    expect(DailyReportService.formatVND(12577000)).toBe('12.577.000 ₫');
    expect(DailyReportService.formatVND(null)).toBe('0 ₫');
    expect(DailyReportService.formatVND(undefined)).toBe('0 ₫');
  });

  test('formatVND làm tròn số thực', () => {
    expect(DailyReportService.formatVND(1000.4)).toBe('1.000 ₫');
    expect(DailyReportService.formatVND(1000.6)).toBe('1.001 ₫');
  });

  test('formatLiters hiển thị số lít', () => {
    expect(DailyReportService.formatLiters(0)).toBe('0 lít');
    expect(DailyReportService.formatLiters(355)).toBe('355 lít');
    expect(DailyReportService.formatLiters(12.34)).toBe('12,3 lít');
  });

  test('shiftDate cộng/trừ ngày qua ranh giới tháng/năm', () => {
    expect(DailyReportService.shiftDate('2026-11-13', -1)).toBe('2026-11-12');
    expect(DailyReportService.shiftDate('2026-11-01', -1)).toBe('2026-10-31');
    expect(DailyReportService.shiftDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(DailyReportService.shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(DailyReportService.shiftDate('2026-09-01', -7)).toBe('2026-08-25');
  });

  test('litersFromProductName bóc số lít từ tên sản phẩm', () => {
    expect(DailyReportService.litersFromProductName('Bia Vàng 20L')).toBe(20);
    expect(DailyReportService.litersFromProductName('Bia 30 lít')).toBe(30);
    expect(DailyReportService.litersFromProductName('Box 23 lít')).toBe(23);
    expect(DailyReportService.litersFromProductName('Bia Lon G8')).toBe(0);
    expect(DailyReportService.litersFromProductName(null)).toBe(0);
  });

  test('todayVN trả về định dạng YYYY-MM-DD', () => {
    expect(DailyReportService.todayVN()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('DailyReportService — queryDayStats', () => {
  const DATE = '2026-09-01';

  afterAll(() => {
    // Dọn dữ liệu test
    db.prepare('DELETE FROM sales WHERE note = ?').run('__TEST_REPORT__');
  });

  test('trả về đầy đủ chỉ số cho một ngày có dữ liệu', () => {
    const stats = DailyReportService.queryDayStats(DATE);
    expect(stats).toHaveProperty('date', DATE);
    expect(typeof stats.revenue).toBe('number');
    expect(typeof stats.profit).toBe('number');
    expect(typeof stats.orders).toBe('number');
    expect(typeof stats.liters).toBe('number');
    expect(typeof stats.expense).toBe('number');
    expect(typeof stats.payment).toBe('number');
    expect(Array.isArray(stats.topProducts)).toBe(true);
    expect(Array.isArray(stats.topCustomers)).toBe(true);
  });

  test('ngày không có dữ liệu → mọi chỉ số bằng 0, không throw', () => {
    const stats = DailyReportService.queryDayStats('1999-01-01');
    expect(stats.revenue).toBe(0);
    expect(stats.profit).toBe(0);
    expect(stats.orders).toBe(0);
    expect(stats.liters).toBe(0);
    expect(stats.topProducts).toEqual([]);
    expect(stats.topCustomers).toEqual([]);
  });

  test('không tính đơn archived / returned vào doanh thu', () => {
    const before = DailyReportService.queryDayStats(DATE);

    db.prepare(
      `INSERT INTO sales (customer_id, date, total, profit, type, archived, note)
       VALUES (NULL, ?, 999999, 999999, 'sale', 1, '__TEST_REPORT__')`
    ).run(DATE);

    const after = DailyReportService.queryDayStats(DATE);
    expect(after.revenue).toBe(before.revenue);
    expect(after.orders).toBe(before.orders);

    db.prepare('DELETE FROM sales WHERE note = ?').run('__TEST_REPORT__');
  });
});

describe('DailyReportService — buildDailyReport + formatReportText', () => {
  test('buildDailyReport có so sánh hôm qua và tuần trước', () => {
    const report = DailyReportService.buildDailyReport('2026-09-01');
    expect(report.date).toBe('2026-09-01');
    expect(report.today).toBeDefined();
    expect(report.comparison).toBeDefined();
    expect(report.comparison).toHaveProperty('yesterday');
    expect(report.comparison).toHaveProperty('lastWeek');
    expect(report.comparison.yesterday.date).toBe('2026-08-31');
    expect(report.comparison.lastWeek.date).toBe('2026-08-25');
  });

  test('pctChange = null khi không có mốc so sánh', () => {
    const report = DailyReportService.buildDailyReport('1999-01-01');
    expect(report.comparison.revenueChange).toBeNull();
    expect(report.comparison.ordersChange).toBeNull();
  });

  test('formatReportText sinh đủ các mục chính', () => {
    const report = DailyReportService.buildDailyReport('2026-09-01');
    const text = DailyReportService.formatReportText(report);

    expect(text).toContain('BÁO CÁO 01/09/2026');
    expect(text).toContain('DOANH THU');
    expect(text).toContain('LỢI NHUẬN');
    expect(text).toContain('ĐƠN HÀNG');
    expect(text).toContain('KEG');
    expect(text).toContain('CÔNG NỢ');
    expect(text).toContain('Tin nhắn tự động từ Beer POS');
    // Không được chứa HTML — Zalo/Telegram dùng plain text
    expect(text).not.toContain('<');
    expect(text).not.toContain('&nbsp;');
  });

  test('formatReportText hiển thị tiền theo định dạng VN', () => {
    const report = DailyReportService.buildDailyReport('2026-09-01');
    const text = DailyReportService.formatReportText(report);
    expect(text).toMatch(/Doanh thu: [\d.,]+ ₫/);
  });

  test('ngày không phát sinh → có cảnh báo', () => {
    const report = DailyReportService.buildDailyReport('1999-01-01');
    const text = DailyReportService.formatReportText(report);
    expect(text).toContain('chưa có phát sinh nào');
  });
});

describe('ReportNotifyService — config & guard', () => {
  afterEach(() => {
    db.prepare('DELETE FROM settings WHERE key LIKE ?').run('report_notify_%');
    db.prepare('DELETE FROM settings WHERE key LIKE ?').run('zalo_%');
    db.prepare('DELETE FROM settings WHERE key LIKE ?').run('telegram_%');
  });

  test('mặc định tắt và kênh zalo', () => {
    expect(ReportNotifyService.isEnabled()).toBe(false);
    expect(ReportNotifyService.getChannel()).toBe('zalo');
  });

  test('bật/tắt qua setting report_notify_enabled', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('report_notify_enabled', '1');
    expect(ReportNotifyService.isEnabled()).toBe(true);

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('report_notify_enabled', '0');
    expect(ReportNotifyService.isEnabled()).toBe(false);
  });

  test('kênh không hợp lệ → fallback về zalo', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('report_notify_channel', 'sms');
    expect(ReportNotifyService.getChannel()).toBe('zalo');
  });

  test('dispatchDailyReport bỏ qua khi đang tắt', async () => {
    const result = await ReportNotifyService.dispatchDailyReport({});
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('đang tắt');
  });

  test('dryRun dựng được nội dung mà KHÔNG gửi', async () => {
    const result = await ReportNotifyService.dispatchDailyReport({
      date: '2026-09-01',
      force: true,
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(typeof result.text).toBe('string');
    expect(result.text).toContain('BÁO CÁO');
  });

  test('gửi không có token → báo lỗi rõ ràng, không throw', async () => {
    const result = await ReportNotifyService.dispatchDailyReport({
      date: '2026-09-01',
      force: true,
      channel: 'zalo',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('hasSent chống gửi trùng cùng ngày', () => {
    const date = '2026-09-01';
    expect(ReportNotifyService.hasSent(date, 'zalo')).toBe(false);

    ReportNotifyService.logNotification({
      reportDate: date,
      channel: 'zalo',
      status: 'sent',
      summary: 'test',
    });

    expect(ReportNotifyService.hasSent(date, 'zalo')).toBe(true);
    // Kênh khác vẫn chưa gửi
    expect(ReportNotifyService.hasSent(date, 'telegram')).toBe(false);

    db.prepare('DELETE FROM report_notifications WHERE report_date = ?').run(date);
  });

  test('lịch sử gửi trả về theo thứ tự mới nhất', () => {
    ReportNotifyService.logNotification({
      reportDate: '2026-09-01',
      channel: 'zalo',
      status: 'sent',
      summary: 'A',
    });
    ReportNotifyService.logNotification({
      reportDate: '2026-09-02',
      channel: 'zalo',
      status: 'sent',
      summary: 'B',
    });

    const history = ReportNotifyService.getHistory(5);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].report_date).toBe('2026-09-02');

    db.prepare('DELETE FROM report_notifications WHERE report_date IN (?, ?)')
      .run('2026-09-01', '2026-09-02');
  });
});

describe('ReportNotifyService — shouldRunNow (logic giờ cron)', () => {
  afterEach(() => {
    db.prepare('DELETE FROM settings WHERE key LIKE ?').run('report_notify_%');
  });

  /** Tạo Date tương ứng với giờ VN cụ thể (giờ VN = UTC+7). */
  function vnTime(hour, minute) {
    // 14:00 VN = 07:00 UTC
    return new Date(Date.UTC(2026, 10, 13, hour - 7, minute, 0));
  }

  test('tắt thì không bao giờ chạy', () => {
    expect(ReportNotifyService.shouldRunNow(vnTime(21, 30))).toBe(false);
  });

  test('đúng giờ cấu hình thì chạy', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('report_notify_enabled', '1');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('report_notify_time', '21:30');

    expect(ReportNotifyService.shouldRunNow(vnTime(21, 30))).toBe(true);
  });

  test('sai giờ thì không chạy', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('report_notify_enabled', '1');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('report_notify_time', '21:30');

    expect(ReportNotifyService.shouldRunNow(vnTime(21, 29))).toBe(false);
    expect(ReportNotifyService.shouldRunNow(vnTime(21, 31))).toBe(false);
    expect(ReportNotifyService.shouldRunNow(vnTime(9, 0))).toBe(false);
  });

  test('giờ không hợp lệ → không chạy, không throw', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('report_notify_enabled', '1');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('report_notify_time', 'abc');

    expect(ReportNotifyService.shouldRunNow(vnTime(21, 30))).toBe(false);
  });

  test('giờ nửa đêm (00:00) xử lý đúng', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('report_notify_enabled', '1');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('report_notify_time', '00:00');

    // 00:00 VN = 17:00 UTC hôm trước
    const midnight = new Date(Date.UTC(2026, 10, 12, 17, 0, 0));
    expect(ReportNotifyService.shouldRunNow(midnight)).toBe(true);
  });
});
