/**
 * Daily Report Builder — Tổng hợp số liệu bán hàng theo ngày.
 * ─────────────────────────────────────────────────────────────────────────────
 * Nguồn dữ liệu: cùng bộ với `/report/data` (routes/reportData.js) để báo cáo
 * gửi tự động KHỚP với báo cáo chủ xe xem trên màn hình.
 *
 * Thiết kế:
 *  - `buildDailyReport(dateStr)` → object thuần, KHÔNG phụ thuộc Express.
 *    Nhờ đó dùng được cho: cron job, endpoint preview, test.
 *  - Ngày chuẩn theo giờ Việt Nam (Asia/Ho_Chi_Minh, UTC+7).
 *  - So sánh với hôm qua + cùng kỳ tuần trước để thấy xu hướng.
 */

const db = require('../../database');

// ── Ngày giờ Việt Nam ────────────────────────────────────────────────────────
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Trả về object Date của thời điểm hiện tại theo giờ VN (đọc qua UTC getters). */
function vnNow() {
  return new Date(Date.now() + VN_OFFSET_MS);
}

/** Ngày hôm nay theo giờ VN, định dạng YYYY-MM-DD. */
function todayVN() {
  return formatDate(vnNow());
}

/** Định dạng Date → YYYY-MM-DD (dùng UTC getters để tránh lệch múi giờ). */
function formatDate(d) {
  return (
    d.getUTCFullYear() +
    '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getUTCDate()).padStart(2, '0')
  );
}

/** Cộng/trừ số ngày trên chuỗi YYYY-MM-DD. */
function shiftDate(dateStr, days) {
  const parts = String(dateStr).split('-');
  const d = new Date(
    Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
  );
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Cột ngày thực tế của bảng sales (fallback created_at). */
function salesDateColumn() {
  try {
    const cols = db.prepare('PRAGMA table_info(sales)').all().map((r) => r.name);
    if (cols.includes('date')) return 'date';
    if (cols.includes('created_at')) return 'created_at';
  } catch (_) {
    /* ignore */
  }
  return 'date';
}

/** Số tiền format kiểu Việt Nam: 1.234.567 ₫ */
function formatVND(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('vi-VN') + ' ₫';
}

/** Số lít format: 123,4 L */
function formatLiters(n) {
  const v = Number(n) || 0;
  return (Math.round(v * 10) / 10).toLocaleString('vi-VN') + ' lít';
}

/** Lấy giá trị setting theo key (null nếu không có). */
function getSetting(key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  } catch (_) {
    return fallback;
  }
}

/** Suy ra số lít từ tên sản phẩm (vd: "Bia Vàng 20L" → 20). */
function litersFromProductName(name) {
  if (!name) return 0;
  const m = String(name).match(/(\d+(?:[.,]\d+)?)\s*[Ll]/);
  return m ? parseFloat(m[1].replace(',', '.')) : 0;
}

// ── Truy vấn gốc ─────────────────────────────────────────────────────────────

/**
 * Tính toàn bộ số liệu của MỘT ngày.
 * @param {string} dateStr - YYYY-MM-DD
 */
function queryDayStats(dateStr) {
  const dateCol = salesDateColumn();

  // Điều kiện lọc bán hàng hợp lệ — PHẢI có tiền tố bảng để tránh
  // "ambiguous column name" khi JOIN (products/sales đều có type, archived).
  const salesWhere = (alias) =>
    alias + '.archived = 0 AND ' + alias + '.type = \'sale\' AND (' +
    alias + '.status IS NULL OR ' + alias + '.status != \'returned\')';

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(s.total), 0)  AS revenue,
              COALESCE(SUM(s.profit), 0) AS profit,
              COUNT(*)                  AS orders,
              COALESCE(SUM(s.deliver_kegs), 0) AS deliveredKegs,
              COALESCE(SUM(s.return_kegs), 0)  AS returnedKegs
       FROM sales s
       WHERE ${salesWhere('s')} AND date(s.${dateCol}) = date(?)`
    )
    .get(dateStr);

  const expenses = db
    .prepare(
      `SELECT COALESCE(SUM(e.amount), 0) AS total FROM expenses e
       WHERE e.archived = 0 AND date(e.date) = date(?)`
    )
    .get(dateStr);

  const payments = db
    .prepare(
      `SELECT COALESCE(SUM(p.amount), 0) AS total FROM payments p
       WHERE p.deleted = 0 AND date(p.date) = date(?)`
    )
    .get(dateStr);

  // Sản phẩm bán chạy
  const topProducts = db
    .prepare(
      `SELECT pr.name AS name, pr.type AS type,
              SUM(si.quantity) AS qty,
              SUM(si.quantity * si.price) AS revenue,
              SUM(si.profit) AS profit
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products pr ON pr.id = si.product_id
       WHERE ${salesWhere('s')} AND date(s.${dateCol}) = date(?)
       GROUP BY pr.id
       ORDER BY qty DESC
       LIMIT 5`
    )
    .all(dateStr);

  // Khách mua nhiều nhất
  const topCustomers = db
    .prepare(
      `SELECT c.id AS id, c.name AS name,
              COUNT(DISTINCT s.id) AS orders,
              SUM(s.total) AS revenue,
              SUM(si.quantity) AS qty
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       JOIN sale_items si ON si.sale_id = s.id AND si.price > 0
       WHERE ${salesWhere('s')} AND date(s.${dateCol}) = date(?)
       GROUP BY c.id
       ORDER BY revenue DESC
       LIMIT 5`
    )
    .all(dateStr);

  // Tổng lít bán được — PHẢI khớp SSOT của PromotionService:
  // sản lượng = SUM(si.quantity) với sản phẩm type='keg' và price > 0
  // (mỗi bình tính là 1 đơn vị sản lượng; mốc thưởng 300L = 300 bình).
  const literRow = db
    .prepare(
      `SELECT COALESCE(SUM(si.quantity), 0) AS total
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products pr ON pr.id = si.product_id
       WHERE ${salesWhere('s')} AND date(s.${dateCol}) = date(?)
         AND pr.type = 'keg' AND si.price > 0`
    )
    .get(dateStr);

  const liters = literRow.total || 0;

  // Nợ phát sinh trong ngày (khách mua chịu)
  const debtAdded = db
    .prepare(
      `SELECT COALESCE(SUM(dt.amount), 0) AS total FROM debt_transactions dt
       WHERE dt.type = 'increase' AND date(dt.created_at) = date(?)`
    )
    .get(dateStr);

  // Tồn nợ hiện tại toàn hệ thống
  const totalDebt = db
    .prepare(
      `SELECT COALESCE(SUM(c.debt), 0) AS total FROM customers c
       WHERE c.archived = 0 AND c.deleted = 0 AND c.debt > 0`
    )
    .get();

  // Tồn kho keg
  const stockRow = db
    .prepare(
      `SELECT COALESCE(SUM(p.stock), 0) AS total FROM products p
       WHERE p.deleted = 0 AND p.archived = 0 AND p.type = 'keg'`
    )
    .get();

  const emptyRow = db
    .prepare(
      `SELECT COALESCE(SUM(k.balance_after_empty), 0) AS total
       FROM keg_ledger k ORDER BY k.id DESC LIMIT 1`
    )
    .get();

  // Tồn vỏ rỗng — ưu tiên bảng `keg_stats` (SSOT của module keg),
  // fallback sang dòng ledger mới nhất.
  let emptyKegs = 0;
  try {
    const stats = db
      .prepare('SELECT empty_collected FROM keg_stats ORDER BY id DESC LIMIT 1')
      .get();
    if (stats && stats.empty_collected !== null) {
      emptyKegs = stats.empty_collected || 0;
    } else {
      emptyKegs = emptyRow.total || 0;
    }
  } catch (_) {
    emptyKegs = emptyRow.total || 0;
  }

  return {
    date: dateStr,
    revenue: totals.revenue || 0,
    profit: totals.profit || 0,
    orders: totals.orders || 0,
    expense: expenses.total || 0,
    payment: payments.total || 0,
    liters: liters,
    deliveredKegs: totals.deliveredKegs || 0,
    returnedKegs: totals.returnedKegs || 0,
    netKegs: (totals.deliveredKegs || 0) - (totals.returnedKegs || 0),
    topProducts,
    topCustomers,
    debtAdded: debtAdded.total || 0,
    totalDebt: totalDebt.total || 0,
    stockKegs: stockRow.total || 0,
    emptyKegs: emptyKegs,
  };
}

/**
 * Tính % thay đổi so với giá trị trước.
 * @returns {number|null} null nếu không có mốc so sánh
 */
function pctChange(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (!prev) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
}

// ── API chính ────────────────────────────────────────────────────────────────

/**
 * Tổng hợp báo cáo ngày + so sánh xu hướng.
 * @param {string} [dateStr] - YYYY-MM-DD, mặc định hôm nay (giờ VN)
 * @returns {object}
 */
function buildDailyReport(dateStr) {
  const date = dateStr || todayVN();
  const yesterday = shiftDate(date, -1);
  const lastWeek = shiftDate(date, -7);

  const current = queryDayStats(date);
  const prev = queryDayStats(yesterday);
  const prevWeek = queryDayStats(lastWeek);

  return {
    date,
    today: current,
    comparison: {
      yesterday: prev,
      lastWeek: prevWeek,
      revenueChange: pctChange(current.revenue, prev.revenue),
      profitChange: pctChange(current.profit, prev.profit),
      ordersChange: pctChange(current.orders, prev.orders),
      revenueWeekChange: pctChange(current.revenue, prevWeek.revenue),
      litersWeekChange: pctChange(current.liters, prevWeek.liters),
    },
    distributorName: getSetting('distributor_name', 'Beer POS'),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Render báo cáo thành text thuần cho Zalo/Telegram (plain text, không HTML).
 * @param {object} report - kết quả buildDailyReport()
 * @returns {string}
 */
function formatReportText(report) {
  const t = report.today;
  const c = report.comparison;
  const lines = [];

  const name = report.distributorName || 'Beer POS';
  const [yy, mm, dd] = report.date.split('-');

  lines.push(`📊 ${name} — BÁO CÁO ${dd}/${mm}/${yy}`);
  lines.push('');

  lines.push('💰 DOANH THU');
  lines.push(`• Doanh thu: ${formatVND(t.revenue)}`);
  if (c.revenueChange !== null) {
    const arrow = c.revenueChange >= 0 ? '▲' : '▼';
    lines.push(`  So với hôm qua: ${arrow} ${Math.abs(c.revenueChange)}%`);
  }
  if (c.revenueWeekChange !== null) {
    const arrow = c.revenueWeekChange >= 0 ? '▲' : '▼';
    lines.push(`  So với tuần trước: ${arrow} ${Math.abs(c.revenueWeekChange)}%`);
  }
  lines.push('');

  lines.push('📈 LỢI NHUẬN & CHI PHÍ');
  lines.push(`• Lợi nhuận gộp: ${formatVND(t.profit)}`);
  lines.push(`• Chi phí phát sinh: ${formatVND(t.expense)}`);
  lines.push(
    `• Lợi nhuận ròng: ${formatVND(t.profit - t.expense)}`
  );
  if (c.profitChange !== null) {
    const arrow = c.profitChange >= 0 ? '▲' : '▼';
    lines.push(`  So với hôm qua: ${arrow} ${Math.abs(c.profitChange)}%`);
  }
  lines.push('');

  lines.push('🧾 ĐƠN HÀNG');
  lines.push(`• Số đơn: ${t.orders}`);
  lines.push(`• Sản lượng bia keg: ${formatLiters(t.liters)}`);
  if (c.ordersChange !== null) {
    const arrow = c.ordersChange >= 0 ? '▲' : '▼';
    lines.push(`  So với hôm qua: ${arrow} ${Math.abs(c.ordersChange)}%`);
  }
  lines.push('');

  lines.push('🍺 KEG');
  lines.push(`• Giao ra: ${t.deliveredKegs} bình | Thu về: ${t.returnedKegs} bình`);
  lines.push(`• Rò rỉ trong ngày: ${t.netKegs > 0 ? t.netKegs : 0} bình`);
  lines.push(`• Tồn kho: ${t.stockKegs} bình | Vỏ rỗng: ${t.emptyKegs} bình`);
  lines.push('');

  lines.push('💳 CÔNG NỢ');
  lines.push(`• Thu hôm nay: ${formatVND(t.payment)}`);
  lines.push(`• Nợ phát sinh: ${formatVND(t.debtAdded)}`);
  lines.push(`• Tổng nợ đang treo: ${formatVND(t.totalDebt)}`);
  lines.push('');

  if (t.topProducts && t.topProducts.length) {
    lines.push('🏆 TOP SẢN PHẨM');
    t.topProducts.forEach((p, i) => {
      lines.push(
        `${i + 1}. ${p.name} — ${p.qty} bình (${formatVND(p.revenue)})`
      );
    });
    lines.push('');
  }

  if (t.topCustomers && t.topCustomers.length) {
    lines.push('👥 TOP KHÁCH HÀNG');
    t.topCustomers.forEach((cu, i) => {
      lines.push(`${i + 1}. ${cu.name} — ${formatVND(cu.revenue)}`);
    });
    lines.push('');
  }

  const noData =
    t.orders === 0 && t.revenue === 0 && t.expense === 0 && t.payment === 0;
  if (noData) {
    lines.push('⚠️ Hôm nay chưa có phát sinh nào.');
  }

  lines.push('— Tin nhắn tự động từ Beer POS');

  return lines.join('\n');
}

module.exports = {
  buildDailyReport,
  formatReportText,
  queryDayStats,
  formatVND,
  formatLiters,
  todayVN,
  shiftDate,
  formatDate,
  getSetting,
  litersFromProductName,
};
