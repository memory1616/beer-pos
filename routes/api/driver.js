/**
 * Driver Portal API — /api/driver/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Mọi endpoint ở đây:
 *  - YÊU CẦU session role = DRIVER (middleware requireAuth + requireDriver).
 *  - Response được sanitize (không cost_price / profit / doanh thu tổng).
 *  - Nghiệp vụ bán hàng ĐƯỢC TÁI SỬ DỤNG nguyên vẹn từ routes/api/sales.js
 *    (forward nội bộ — không viết lại thuật toán).
 *  - Nghiệp vụ giao hàng dùng DeliveryService.
 */

const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const DeliveryService = require('../../src/services/DeliveryService');
const KegReceiptService = require('../../src/services/KegReceiptService');
const DriverSalaryCalculator = require('../../src/services/DriverSalaryCalculator');
const DriverStaffService = require('../../src/services/DriverStaffService');
const { ROLE_DRIVER } = require('../../middleware/permissions');
const { PromotionService } = require('../../src/services');

// Router sales chuẩn — dùng lại để forward (tái sử dụng nghiệp vụ)
const salesRouter = require('./sales');

// ── Middleware: bắt buộc role DRIVER ───────────────────────────────────────
function requireDriver(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  if (req.user.role !== ROLE_DRIVER) {
    return res.status(403).json({
      error: 'API này chỉ dành cho tài khoản tài xế',
      code: 'DRIVER_ONLY',
    });
  }
  next();
}

// ── Helper: forward request nội bộ sang router sales chuẩn ─────────────────
/**
 * Gọi lại handler gốc của POST /api/sales để dùng đúng logic nghiệp vụ
 * (promotion, tier bonus, công nợ, kho, keg balance).
 *
 * @param {object} req
 * @param {object} res
 * @param {string} subPath - path tương đối trong router sales (vd: '/', '/123')
 * @param {string} method
 * @param {function} onJson - callback (payload) sau khi handler gốc res.json
 * @param {object} bodyOverride - body thay thế (dùng khi tài xế gửi payload khác)
 */
function forwardToSales(req, res, subPath, method, onJson, bodyOverride) {
  const originalJson = res.json.bind(res);
  let intercepted = false;

  res.json = (body) => {
    if (!intercepted && onJson) {
      intercepted = true;
      try {
        onJson(body);
      } catch (e) {
        logger.error('[driver] forward onJson error', { error: e.message });
      }
    }
    return originalJson(body);
  };

  const originalUrl = req.url;
  const originalMethod = req.method;
  const originalBody = req.body;
  req.url = subPath;
  req.method = method;
  if (bodyOverride !== undefined) req.body = bodyOverride;

  salesRouter(req, res, (err) => {
    // Handler gốc không match → trả lỗi
    req.url = originalUrl;
    req.method = originalMethod;
    req.body = originalBody;
    if (err) {
      logger.error('[driver] forward error', { error: err.message });
      return res.status(500).json({ error: 'Lỗi xử lý yêu cầu: ' + err.message });
    }
    res.status(404).json({ error: 'Không tìm thấy endpoint' });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// THÔNG TIN TÀI KHOẢN
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/driver/me
router.get('/me', requireDriver, (req, res) => {
  const user = db
    .prepare(
      `SELECT id, username, full_name, phone, role, last_login_at
       FROM app_users WHERE username = ?`
    )
    .get(req.user.username);

  // Lương dự kiến tháng hiện tại + khoản đã ứng (tài xế xem để đối chiếu)
  const today = db.getVietnamDateStr();
  const currentMonth = today.slice(0, 7);
  const estimatedSalary = getEstimatedSalary(req.user.username, currentMonth);

  res.json({
    username: req.user.username,
    role: req.user.role,
    fullName: user?.full_name || req.user.username,
    phone: user?.phone || null,
    lastLoginAt: user?.last_login_at || null,
    estimatedSalary,
  });
});

// GET /api/driver/dashboard
router.get('/dashboard', requireDriver, (req, res) => {
  try {
    const data = DeliveryService.getDashboard(req.user.username, {
      date: req.query.date || undefined,
    });
    res.json(data);
  } catch (err) {
    logger.error('[driver] dashboard error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải dữ liệu trang chủ' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/home — dữ liệu tối giản cho TRANG CHỦ tài xế
// ───────────────────────────────────────────────────────────────────────────
// Query params (tùy chọn):
//   - month=YYYY-MM : thống kê tháng cần xem (mặc định = tháng hiện tại)
//   - date=YYYY-MM-DD: ngày được chọn trong tháng (mặc định = hôm nay)
//
// Chỉ trả về đúng những gì UI cần (nhẹ, nhanh trên mobile):
//   - date        : ngày VN hiện tại (YYYY-MM-DD)
//   - todayOrders : số đơn của tài xế HÔM NAY (bán trực tiếp + giao hàng)
//   - todayLiters : tổng số lít bia HÔM NAY — TÍNH CẢ BIA PET
//                   (quy ước: 1 đơn vị bán của mọi loại = 1 lít)
//   - todayKegs   : tổng số vỏ bình đã thu HÔM NAY (CỦA CHÍNH tài xế)
//   - todayKegsNet: vỏ giao đi - vỏ thu về (vỏ còn lưu lượng của tài xế)
//                   - Gộp 2 nguồn: `sales.return_kegs` (vỏ thu ở màn Bán hàng)
//                     + `delivery_records.collected_kegs` (vỏ thu ở màn Giao hàng)
//                   - Dedupe theo đơn (MAX) → đơn có cả 2 nguồn chỉ tính 1 lần
//                   - Ngày tính = ngày THỰC TẾ hoàn tất (completed_at/updated_at),
//                     không dùng scheduled_date (ngày hẹn) để tránh lệch sang ngày
//                   - Tính mọi trạng thái (DELIVERED / DISCREPANCY) — tài xế đã thu
//                     vỏ thì vẫn phải hiện trong KPI
//
//   - pendingSummary    : tổng lít / vỏ giao / vỏ thu / số đơn cần giao
//   - pendingProducts   : LOẠI HÀNG + SỐ LƯỢNG cần giao hôm nay
//                         [{ name, slug, type, qty, unit }]
//   - month/monthLabel : tháng đang xem
//   - daily            : mảng thống kê theo TỪNG NGÀY trong tháng (cho bộ lọc)
//   - monthTotals      : tổng cả tháng
//   - prevMonth/nextMonth: tháng trước / tháng sau (để điều hướng)
//
// KHÔNG có doanh thu / lợi nhuận / giá vốn.
// ═══════════════════════════════════════════════════════════════════════════

// Chuẩn hoá ngày: chỉ chấp nhận YYYY-MM-DD hợp lệ, và nằm trong tháng yêu cầu
function normalizeHomeDate(rawDate, month) {
  const today = db.getVietnamDateStr();
  const [my, mm] = month.split('-').map(Number);
  const lastDay = new Date(my, mm, 0).getDate();

  if (typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    const day = Number(rawDate.slice(8, 10));
    const year = Number(rawDate.slice(0, 4));
    const mon = Number(rawDate.slice(5, 7));
    // Ngày không tồn tại trong tháng → kẹp vào biên hợp lệ
    if (day >= 1 && day <= lastDay && year === my && mon === mm) {
      return rawDate;
    }
    if (day >= 1 && day <= lastDay && rawDate.slice(0, 7) !== month) {
      // Ngày hợp lệ nhưng nằm ngoài tháng → giữ ngày, kẹp vào tháng đang xem
      return `${month}-${String(day).padStart(2, '0')}`;
    }
    return `${month}-01`;
  }
  return today.slice(0, 7) === month ? today : `${month}-01`;
}

// Đơn vị đếm theo loại sản phẩm (tài xế chất hàng lên xe)
const PRODUCT_UNIT = {
  keg: 'vỏ',
  box: 'thùng',
  pet: 'chai',
};

// Số ngày trong tháng (YYYY-MM)
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// Đổi tháng (YYYY-MM) ± 1
function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// LƯƠNG DỰ KIẾN — (lương cố định ÷ 26) × số ngày làm (chưa tính thưởng/phạt)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Tính lương dự kiến của 1 tài xế cho tháng đang xem.
 *
 * - Tài xế chưa có hồ sơ trong `driver_staff` → trả về null (UI ẩn).
 * - Số ngày làm: từ `start_date` đến ngày hiện tại (tháng đang xem),
 *   KHÔNG tính Chủ Nhật. Nếu admin đã ghi đè số ngày làm trong
 *   `driver_monthly_salary.work_days` → dùng giá trị đó.
 * - KHÔNG cộng thưởng / trừ phạt (đây là lương DỰ KIẾN).
 * - `amount` = lương dự kiến (chưa trừ ứng). `netAmount` = sau khi trừ ứng.
 */
function getEstimatedSalary(username, month) {
  try {
    const [y, m] = month.split('-').map(Number);
    if (!y || !m) return null;

    const driver = db
      .prepare(
        `SELECT id, monthly_salary, start_date
         FROM driver_staff
         WHERE username = ?
         LIMIT 1`
      )
      .get(username);

    if (!driver) return null;

    // Bản ghi lương của tháng (nếu có) — lấy work_days do admin ghi đè tay
    const salary = db
      .prepare(
        `SELECT base_salary, bonus, deduction, work_days
         FROM driver_monthly_salary
         WHERE driver_id = ? AND year = ? AND month = ?`
      )
      .get(driver.id, y, m);

    const baseSalary = salary && salary.base_salary
      ? Number(salary.base_salary)
      : Number(driver.monthly_salary) || 0;

    // Nếu admin đã chốt lương theo ngày làm cho tháng này → dùng số ngày đó
    const manualWorkDays =
      salary && salary.work_days !== null && salary.work_days !== undefined
        ? salary.work_days
        : null;

    const calc = DriverSalaryCalculator.calculate(driver, y, m, {
      baseSalary,
      manualWorkDays,
    });

    // Khoản ứng lương đã ghi nhận trong kỳ
    const advanceTotal = DriverStaffService.getAdvanceTotal(driver.id, y, m);

    return {
      month: `${y}-${String(m).padStart(2, '0')}`,
      baseSalary,
      dailyRate: calc.dailyRate,
      workDays: calc.workDays,
      standardWorkDays: calc.standardWorkDays,
      amount: calc.proratedBase,
      advanceTotal,
      netAmount: Math.max(0, Math.round((calc.proratedBase - advanceTotal) * 100) / 100),
      startDate: calc.startDate,
      isCurrentMonth: calc.isCurrentMonth,
      periodStart: calc.periodStart,
      periodEnd: calc.periodEnd,
    };
  } catch (err) {
    logger.error('[driver] estimated salary error', { error: err.message });
    return null;
  }
}

router.get('/home', requireDriver, (req, res) => {
  try {
    const today = db.getVietnamDateStr();
    const currentMonth = today.slice(0, 7);

    // Tháng đang xem (mặc định: tháng hiện tại)
    let month = currentMonth;
    if (typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month)) {
      const my = Number(req.query.month.slice(0, 4));
      const mm = Number(req.query.month.slice(5, 7));
      // Tháng hợp lệ: 01..12 và năm trong khoảng 2000..2100
      if (mm >= 1 && mm <= 12 && my >= 2000 && my <= 2100) {
        month = req.query.month;
      }
    }
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;

    // Ngày được chọn trong tháng (mặc định: hôm nay)
    const selectedDate = normalizeHomeDate(req.query.date, month);

    // Số đơn + tổng lít theo TỪNG NGÀY trong tháng (BAO GỒM BIA PET / BOX)
    // Quy ước (đồng bộ với routes/api/customers.js và salesStaff.js):
    //   1 đơn vị bán của bất kỳ loại nào (keg / pet / box) = 1 lít.
    const dailyRows = db
      .prepare(
        `
        SELECT DATE(s.date) AS d,
               COUNT(DISTINCT s.id) AS orders,
               COALESCE(SUM(si.quantity), 0) AS liters
        FROM sales s
        LEFT JOIN sale_items si ON si.sale_id = s.id
        WHERE DATE(s.date) BETWEEN ? AND ?
          AND s.type IN ('sale', 'replacement')
          AND s.archived = 0
          AND s.deleted = 0
          AND (s.driver_username = ? OR s.driver_username IS NULL OR s.driver_username = '')
        GROUP BY DATE(s.date)
      `
      )
      .all(monthStart, monthEnd, req.user.username);

    // ── VỎ: 2 khái niệm riêng biệt ──────────────────────────────────────
    //  1) `kegs`   = VỎ ĐÃ THU của CHÍNH tài xế (khách trả lại vỏ rỗng)
    //                - Nguồn A: `sales.return_kegs` của đơn CỦA TÀI XẾ
    //                - Nguồn B: `delivery_records.collected_kegs` của PHIẾU GIAO
    //                  của tài xế
    //                → Dedupe theo đơn (MAX) để không đếm trùng 2 nguồn
    //  2) `kegsNet` = VỎ GIAO ĐI - VỎ THU VỀ  (nguyên tắc "phải trừ vỏ đã giao")
    //                = số vỏ còn lưu lượng trên xe / trong kho của tài xế
    //
    // ⚠ FIX: trước đây query lấy `return_kegs` của MỌI đơn trong tháng
    //   (kể cả đơn Admin tạo, driver_username = NULL) → KPI của tài xế bị
    //   "nhập" vỏ của người khác. Nay CHỈ tính đơn của chính tài xế.
    const kegRows = db
      .prepare(
        `
        WITH keg_rows AS (
          -- Nguồn A: vỏ thu trên đơn bán CỦA TÀI XẾ (màn "Cập nhật vỏ")
          -- KHÔNG gắn prefix ở đây: order_key = sale_id để NGUỒN B (cùng đơn)
          -- gộp chung được. Gắn prefix 'S'/'D' sẽ khiến cùng 1 đơn bị đếm
          -- 2 lần (đếm trùng) vì 2 nguồn luôn có cùng giá trị.
          SELECT s.id AS order_key,
                 DATE(s.date) AS sale_date,
                 NULL AS del_date,
                 COALESCE(s.return_kegs, 0) AS kegs
          FROM sales s
          WHERE s.type IN ('sale', 'replacement')
            AND s.archived = 0
            AND s.deleted = 0
            AND DATE(s.date) BETWEEN ? AND ?
            AND s.driver_username = ?
          UNION ALL
          -- Nguồn B: vỏ thu trên phiếu giao CỦA TÀI XẾ (màn "Xác nhận giao")
          -- order_key = sale_id (dùng -id cho phiếu không gắn đơn) → cùng đơn
          -- với Nguồn A sẽ bị GROUP BY gộp lại, MAX(kegs) chọn 1 giá trị.
          SELECT COALESCE(dr.sale_id, -dr.id) AS order_key,
                 NULL AS sale_date,
                 DATE(COALESCE(NULLIF(dr.completed_at, ''), dr.updated_at, dr.scheduled_date)) AS del_date,
                 COALESCE(dr.collected_kegs, 0) AS kegs
          FROM delivery_records dr
          WHERE COALESCE(dr.collected_kegs, 0) > 0
            AND DATE(COALESCE(NULLIF(dr.completed_at, ''), dr.updated_at, dr.scheduled_date))
                BETWEEN ? AND ?
            AND dr.driver_username = ?
          UNION ALL
          -- Nguồn C: PHIẾU THU VỎ độc lập (thu vỏ rỗng ngoài chuyến giao)
          -- KHÔNG gắn vào sale_id (không có đơn) → dùng số ÂM riêng biệt
          -- để không bao giờ trùng với order_key của đơn.
          SELECT -1000000000 - r.id AS order_key,
                 NULL AS sale_date,
                 DATE(r.created_at) AS del_date,
                 COALESCE(r.kegs, 0) AS kegs
          FROM driver_keg_receipts r
          WHERE COALESCE(r.kegs, 0) > 0
            AND DATE(r.created_at) BETWEEN ? AND ?
            AND r.driver_username = ?
        )
        SELECT COALESCE(sale_date, del_date) AS d,
               SUM(kegs) AS kegs
        FROM (
          SELECT order_key,
                 MAX(sale_date) AS sale_date,
                 MAX(del_date) AS del_date,
                 MAX(kegs) AS kegs
          FROM keg_rows
          GROUP BY order_key
        )
        WHERE COALESCE(sale_date, del_date) IS NOT NULL
        GROUP BY COALESCE(sale_date, del_date)
      `
      )
      .all(
        monthStart,
        monthEnd,
        req.user.username,
        monthStart,
        monthEnd,
        req.user.username,
        monthStart,
        monthEnd,
        req.user.username
      );

    // VỎ GIAO ĐI của tài xế theo từng ngày (để tính NET = giao - thu)
    const kegDeliverRows = db
      .prepare(
        `
        SELECT DATE(s.date) AS d,
               SUM(COALESCE(s.deliver_kegs, 0)) AS kegs
        FROM sales s
        WHERE s.type IN ('sale', 'replacement')
          AND s.archived = 0
          AND s.deleted = 0
          AND DATE(s.date) BETWEEN ? AND ?
          AND s.driver_username = ?
        GROUP BY DATE(s.date)
      `
      )
      .all(monthStart, monthEnd, req.user.username);

    // Gom theo ngày
    const byDate = {};
    for (const r of dailyRows) {
      byDate[r.d] = { orders: r.orders || 0, liters: r.liters || 0, kegs: 0, kegsNet: 0 };
    }
    for (const r of kegRows) {
      if (!byDate[r.d]) byDate[r.d] = { orders: 0, liters: 0, kegs: 0, kegsNet: 0 };
      byDate[r.d].kegs += r.kegs || 0;
    }
    // Gom vỏ giao đi theo ngày
    const deliverByDate = {};
    for (const r of kegDeliverRows) {
      deliverByDate[r.d] = r.kegs || 0;
    }

    // Tính NET cho MỌI ngày có dữ liệu:
    //   kegsNet = vỏ giao đi - vỏ thu về
    // (ngày chỉ có thu mà không có giao → NET âm, vẫn phải tính đúng)
    for (const d of Object.keys(byDate)) {
      byDate[d].kegsNet = (deliverByDate[d] || 0) - (byDate[d].kegs || 0);
    }

    // Mảng 31 ngày (đủ số ngày trong tháng)
    const totalDays = daysInMonth(month);
    const daily = [];
    let monthTotals = { orders: 0, liters: 0, kegs: 0, kegsNet: 0 };
    for (let i = 1; i <= totalDays; i++) {
      const d = `${month}-${String(i).padStart(2, '0')}`;
      const v = byDate[d] || { orders: 0, liters: 0, kegs: 0, kegsNet: 0 };
      daily.push({
        date: d,
        day: i,
        orders: v.orders,
        liters: v.liters,
        kegs: v.kegs,
        kegsNet: v.kegsNet,
      });
      monthTotals.orders += v.orders;
      monthTotals.liters += v.liters;
      monthTotals.kegs += v.kegs;
      monthTotals.kegsNet += v.kegsNet;
    }

    // HÀNG CẦN GIAO HÔM NAY — các đơn hôm nay chưa giao xong
    //   - Chưa có phiếu giao (dr.id IS NULL) → chờ giao
    //   - Có phiếu giao nhưng chưa DELIVERED → đang giao / thất bại / sai lệch
    //     (đồng bộ với DeliveryService.getList: FAILED vẫn cần giao lại)
    // Phạm vi: đơn của chính tài xế + đơn Admin tạo chưa gán tài xế
    const pendingDeliveries = db
      .prepare(
        `
        SELECT s.id AS sale_id,
               s.total,
               s.deliver_kegs,
               s.return_kegs,
               s.payment_status,
               s.sale_time,
               COALESCE(c.name, 'Khách lẻ') AS customer_name,
               c.phone AS customer_phone,
               c.address AS customer_address,
               dr.id AS delivery_id,
               dr.status AS delivery_status,
               dr.expected_kegs,
               dr.collected_kegs,
               (SELECT COALESCE(SUM(si.quantity), 0)
                  FROM sale_items si WHERE si.sale_id = s.id) AS total_liters
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        LEFT JOIN delivery_records dr
               ON dr.sale_id = s.id AND dr.driver_username = ?
        WHERE s.type = 'sale'
          AND s.archived = 0
          AND s.deleted = 0
          AND DATE(s.date) = ?
          AND (c.archived = 0 OR c.id IS NULL)
          AND (s.driver_username = ? OR s.driver_username IS NULL OR s.driver_username = '')
          AND (dr.id IS NULL OR dr.status NOT IN ('DELIVERED'))
        ORDER BY (dr.status IS NULL) DESC,
                 CASE dr.status WHEN 'IN_PROGRESS' THEN 0 ELSE 1 END,
                 s.sale_time IS NULL, s.sale_time, s.id DESC
        LIMIT 100
      `
      )
      .all(req.user.username, today, req.user.username)
      .map((d) => ({
        sale_id: d.sale_id,
        customer_name: d.customer_name,
        customer_phone: d.customer_phone,
        customer_address: d.customer_address,
        total: d.total,
        total_liters: d.total_liters || 0,
        deliver_kegs: d.deliver_kegs || 0,
        return_kegs: d.return_kegs || 0,
        payment_status: d.payment_status,
        delivery_id: d.delivery_id,
        delivery_status: d.delivery_status || 'PENDING',
        expected_kegs: d.expected_kegs,
        collected_kegs: d.collected_kegs || 0,
      }));

    // Tổng hợp "hàng cần giao hôm nay" + breakdown theo sản phẩm
    const pendingSummary = {
      orders: pendingDeliveries.length,
      liters: pendingDeliveries.reduce((a, d) => a + (d.total_liters || 0), 0),
      deliverKegs: pendingDeliveries.reduce((a, d) => a + (d.deliver_kegs || 0), 0),
      returnKegs: pendingDeliveries.reduce((a, d) => a + (d.return_kegs || 0), 0),
    };

    // Breakdown sản phẩm trong các đơn cần giao hôm nay
    const pendingProducts = db
      .prepare(
        `
        SELECT COALESCE(si.product_slug, p.slug, 'khac') AS slug,
               COALESCE(p.name, si.product_slug, 'Sản phẩm') AS name,
               COALESCE(p.type, '') AS ptype,
               SUM(si.quantity) AS qty
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN products p ON p.id = si.product_id
        WHERE s.type = 'sale'
          AND s.archived = 0
          AND s.deleted = 0
          AND DATE(s.date) = ?
          AND (s.driver_username = ? OR s.driver_username IS NULL OR s.driver_username = '')
          AND s.id IN (
            SELECT s2.id FROM sales s2
            LEFT JOIN delivery_records dr2
                   ON dr2.sale_id = s2.id AND dr2.driver_username = ?
            WHERE s2.type = 'sale'
              AND s2.archived = 0
              AND s2.deleted = 0
              AND DATE(s2.date) = ?
              AND (s2.driver_username = ? OR s2.driver_username IS NULL OR s2.driver_username = '')
              AND (dr2.id IS NULL OR dr2.status NOT IN ('DELIVERED'))
          )
        GROUP BY slug, name, ptype
        ORDER BY qty DESC
        LIMIT 20
      `
      )
      .all(today, req.user.username, req.user.username, today, req.user.username)
      .map((r) => ({
        name: r.name,
        slug: r.slug,
        type: r.ptype,
        qty: r.qty || 0,
        unit: PRODUCT_UNIT[r.ptype] || 'lít',
      }));

    // Chỉ số của ngày đang chọn
    const sel = byDate[selectedDate] || { orders: 0, liters: 0, kegs: 0, kegsNet: 0 };

    // ── LƯƠNG DỰ KIẾN THÁNG HIỆN TẠI (chưa tính thưởng/phạt) ─────────────
    // Công thức: (lương cố định tháng ÷ 26) × số ngày làm thực tế
    // (từ ngày vào làm đến ngày hiện tại, không tính Chủ Nhật).
    // LUÔN tính theo tháng hiện tại — không phụ thuộc tháng đang lọc trên lịch.
    const salaryInfo = getEstimatedSalary(req.user.username, currentMonth);

    res.json({
      date: today,
      todayOrders: sel.orders,
      todayLiters: sel.liters,
      todayKegs: sel.kegs,
      todayKegsNet: sel.kegsNet,
      selectedDate,
      isToday: selectedDate === today,
      month,
      monthLabel: `Tháng ${month.slice(5, 7)}/${month.slice(0, 4)}`,
      estimatedSalary: salaryInfo,
      daily,
      monthTotals,
      pendingSummary,
      pendingProducts,
      prevMonth: shiftMonth(month, -1),
      nextMonth: shiftMonth(month, 1),
    });
  } catch (err) {
    logger.error('[driver] home error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải dữ liệu trang chủ' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MODULE BÁN HÀNG — tái sử dụng nghiệp vụ chuẩn
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/driver/sales — chỉ đơn của chính tài xế
router.get('/sales', requireDriver, (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const offset = (page - 1) * limit;

    const where = ["s.driver_username = ?", "s.type = 'sale'", "s.archived = 0", "s.deleted = 0"];
    const params = [req.user.username];

    if (req.query.month) {
      where.push("strftime('%Y-%m', s.date) = ?");
      params.push(req.query.month);
    }
    if (req.query.customerId) {
      where.push('s.customer_id = ?');
      params.push(parseInt(req.query.customerId));
    }
    if (req.query.status) {
      where.push('s.payment_status = ?');
      params.push(req.query.status);
    }

    const whereSql = where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS c FROM sales s WHERE ${whereSql}`).get(...params).c;

    const sales = db
      .prepare(
        `SELECT s.id, s.customer_id, s.date, s.sale_time, s.total, s.deliver_kegs,
                s.return_kegs, s.keg_balance_after, s.type, s.note, s.payment_status,
                s.promo_free_liters, s.promo_type, s.delivery_status,
                COALESCE(c.name, 'Khách lẻ') AS customer_name,
                c.phone AS customer_phone,
                c.address AS customer_address,
                c.lat AS customer_lat,
                c.lng AS customer_lng,
                (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) AS items_qty
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE ${whereSql}
         ORDER BY datetime(s.date) DESC, s.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    res.json({ sales, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    logger.error('[driver] sales list error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách đơn hàng' });
  }
});

// GET /api/driver/sales/:id — chi tiết đơn (chỉ của chính tài xế)
router.get('/sales/:id', requireDriver, (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    if (!saleId) return res.status(400).json({ error: 'ID đơn hàng không hợp lệ' });

    const sale = db
      .prepare(
        `SELECT s.id, s.customer_id, s.date, s.sale_time, s.total, s.deliver_kegs,
                s.return_kegs, s.keg_balance_after, s.type, s.note, s.payment_status,
                s.promo_free_liters, s.promo_type, s.reward_liters_used, s.delivery_status,
                s.driver_username,
                COALESCE(c.name, 'Khách lẻ') AS customer_name,
                c.phone AS customer_phone,
                c.address AS customer_address,
                c.lat AS customer_lat,
                c.lng AS customer_lng,
                c.keg_balance AS customer_keg_balance
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.id = ?`
      )
      .get(saleId);

    if (!sale) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    if (sale.driver_username !== req.user.username) {
      return res.status(403).json({
        error: 'Không có quyền truy cập đơn hàng này',
        code: 'DRIVER_SCOPE',
      });
    }

    const items = db
      .prepare(
        `SELECT si.id, si.product_id, si.product_slug, si.quantity, si.price,
                si.price_at_time, si.paid_quantity, si.reward_quantity, si.reward_source,
                p.name AS product_name, p.type AS product_type
         FROM sale_items si
         LEFT JOIN products p ON p.id = si.product_id
         WHERE si.sale_id = ?`
      )
      .all(saleId);

    // Công nợ của đơn (nếu có) — driver được xem
    const debt = db
      .prepare('SELECT original_amount, paid_amount, remaining_amount, status FROM order_debts WHERE sale_id = ?')
      .get(saleId);

    res.json({ ...sale, items, debt: debt || null });
  } catch (err) {
    logger.error('[driver] sale detail error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải chi tiết đơn hàng' });
  }
});

// POST /api/driver/sales — tạo đơn bán hàng (DÙNG LẠI logic POST /api/sales)
router.post('/sales', requireDriver, (req, res) => {
  try {
    const body = { ...(req.body || {}) };

    // Driver không được tự đặt staffId (giảm giá nhân viên) — bỏ qua.
    delete body.staffId;
    // Không cho driver gửi giá tùy ý quá giá bán — server sẽ tự tính giá khách.
    // (Logic chọn giá đã nằm trong routes/api/sales.js)

    forwardToSales(req, res, '/', 'POST', (payload) => {
      // Ghi nhận tài xế tạo đơn (KHÔNG sửa logic nghiệp vụ, chỉ thêm cột audit)
      if (payload && payload.success && payload.id) {
        try {
          db.prepare('UPDATE sales SET driver_username = ? WHERE id = ?').run(
            req.user.username,
            payload.id
          );
        } catch (e) {
          logger.error('[driver] set driver_username error', { error: e.message });
        }
      }
    });
  } catch (err) {
    logger.error('[driver] create sale error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tạo đơn hàng: ' + err.message });
  }
});

// PUT /api/driver/sales/:id — sửa đơn (forward sang PUT /api/sales/:id)
router.put('/sales/:id', requireDriver, (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    if (!saleId) return res.status(400).json({ error: 'ID đơn hàng không hợp lệ' });

    const sale = db.prepare('SELECT driver_username FROM sales WHERE id = ?').get(saleId);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    if (sale.driver_username !== req.user.username) {
      return res.status(403).json({
        error: 'Không có quyền sửa đơn hàng này',
        code: 'DRIVER_SCOPE',
      });
    }

    const body = { ...(req.body || {}) };
    delete body.staffId;

    forwardToSales(req, res, `/${saleId}`, 'PUT', null);
  } catch (err) {
    logger.error('[driver] update sale error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật đơn hàng: ' + err.message });
  }
});

// DELETE /api/driver/sales/:id — huỷ đơn (forward sang DELETE /api/sales/:id)
router.delete('/sales/:id', requireDriver, (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    if (!saleId) return res.status(400).json({ error: 'ID đơn hàng không hợp lệ' });

    const sale = db.prepare('SELECT driver_username FROM sales WHERE id = ?').get(saleId);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    if (sale.driver_username !== req.user.username) {
      return res.status(403).json({
        error: 'Không có quyền huỷ đơn hàng này',
        code: 'DRIVER_SCOPE',
      });
    }

    forwardToSales(req, res, `/${saleId}`, 'DELETE', null);
  } catch (err) {
    logger.error('[driver] delete sale error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi huỷ đơn hàng: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MODULE KHÁCH HÀNG
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/driver/customers — danh sách khách (chỉ field cần cho bán/giao)
router.get('/customers', requireDriver, (req, res) => {
  try {
    const search = (req.query.q || '').trim();
    const limit = Math.min(200, parseInt(req.query.limit) || 50);

    let sql = `
      SELECT id, name, phone, address, lat, lng, keg_balance, debt, deposit,
             last_order_date, reward_tier, monthly_purchased_liters
      FROM customers
      WHERE archived = 0 AND deleted = 0`;
    const params = [];

    if (search) {
      sql += ` AND (name LIKE ? OR phone LIKE ? OR address LIKE ?)`;
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    sql += ` ORDER BY name LIMIT ?`;
    params.push(limit);

    const customers = db.prepare(sql).all(...params);
    res.json({ customers });
  } catch (err) {
    logger.error('[driver] customers error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách khách hàng' });
  }
});

// GET /api/driver/customers/:id
router.get('/customers/:id', requireDriver, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID khách hàng không hợp lệ' });

    const customer = db
      .prepare(
        `SELECT id, name, phone, address, lat, lng, keg_balance, debt, deposit,
                last_order_date, note, reward_tier, monthly_purchased_liters,
                horizontal_fridge, vertical_fridge
         FROM customers WHERE id = ? AND archived = 0`
      )
      .get(id);

    if (!customer) return res.status(404).json({ error: 'Không tìm thấy khách hàng' });

    // Lịch sử sản phẩm khách đã mua (không có giá vốn/lợi nhuận)
    const history = db
      .prepare(
        `SELECT si.product_slug, si.quantity, si.price, s.date, p.name AS product_name
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
         LEFT JOIN products p ON p.id = si.product_id
         WHERE s.customer_id = ? AND s.archived = 0 AND s.type = 'sale'
         ORDER BY s.date DESC, s.id DESC
         LIMIT 30`
      )
      .all(id);

    res.json({ ...customer, purchaseHistory: history });
  } catch (err) {
    logger.error('[driver] customer detail error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải thông tin khách hàng' });
  }
});

// POST /api/driver/customers — tạo khách mới (chỉ field cần thiết)
router.post('/customers', requireDriver, (req, res) => {
  try {
    const { name, phone, address, lat, lng, deposit } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Tên khách hàng là bắt buộc' });
    }

    const result = db
      .prepare(
        `INSERT INTO customers (name, phone, address, lat, lng, deposit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .run(
        String(name).trim(),
        phone || null,
        address || null,
        lat || null,
        lng || null,
        parseFloat(deposit) || 0
      );

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, id: result.lastInsertRowid, customer });
  } catch (err) {
    logger.error('[driver] create customer error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tạo khách hàng: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MODULE SẢN PHẨM & GIÁ (chỉ thông tin cần bán/giao — KHÔNG cost_price)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/driver/products
router.get('/products', requireDriver, (req, res) => {
  try {
    const products = db
      .prepare(
        `SELECT id, slug, name, type, sell_price, stock, damaged_stock
         FROM products WHERE archived = 0 ORDER BY name`
      )
      .all();
    res.json({ products });
  } catch (err) {
    logger.error('[driver] products error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách sản phẩm' });
  }
});

// GET /api/driver/prices?customerId= — giá bán riêng của khách (cần để bán đúng giá)
router.get('/prices', requireDriver, (req, res) => {
  try {
    const customerId = parseInt(req.query.customerId);
    if (!customerId) return res.status(400).json({ error: 'Thiếu customerId' });

    const prices = db
      .prepare(
        `SELECT pr.product_id, pr.product_slug, pr.price, p.name AS product_name
         FROM prices pr
         LEFT JOIN products p ON p.id = pr.product_id
         WHERE pr.customer_id = ?`
      )
      .all(customerId);

    res.json({ prices });
  } catch (err) {
    logger.error('[driver] prices error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải giá bán' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MODULE GIAO HÀNG
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/driver/deliveries — đơn cần giao hôm nay
router.get('/deliveries', requireDriver, (req, res) => {
  try {
    const rows = DeliveryService.listForDriver(req.user.username, {
      date: req.query.date || undefined,
      limit: req.query.limit,
    });

    // Bổ sung số lít cần giao cho từng đơn
    const result = rows.map((r) => {
      const liters = db
        .prepare(
          `SELECT COALESCE(SUM(si.quantity), 0) AS liters
           FROM sale_items si
           LEFT JOIN products p ON p.id = si.product_id
           WHERE si.sale_id = ? AND (p.type IS NULL OR p.type != 'pet')`
        )
        .get(r.sale_id);
      return { ...r, expected_liters: liters.liters || 0 };
    });

    res.json({
      deliveries: result,
      statusLabels: DeliveryService.STATUS_LABELS,
      date: req.query.date || db.getVietnamDateStr(),
    });
  } catch (err) {
    logger.error('[driver] deliveries list error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách đơn giao' });
  }
});

// GET /api/driver/deliveries/history — lịch sử giao
router.get('/deliveries/history', requireDriver, (req, res) => {
  try {
    const rows = DeliveryService.listHistory(req.user.username, {
      date: req.query.date || undefined,
      status: req.query.status || undefined,
      limit: req.query.limit,
    });
    res.json({ deliveries: rows, statusLabels: DeliveryService.STATUS_LABELS });
  } catch (err) {
    logger.error('[driver] deliveries history error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải lịch sử giao hàng' });
  }
});

// GET /api/driver/delivery/page-data
// Payload GIỐNG HỆT route /delivery của Admin (views/delivery.html):
//   { customers: [...], settings: {...}, todayCount, today, distributorName }
// Dùng để render module GIAO HÀNG gốc của Admin (public/js/delivery.js).
// Scope: đơn của chính tài xế + đơn chưa gán tài xế nào.
router.get('/delivery/page-data', requireDriver, (req, res) => {
  try {
    const today = req.query.date || db.getVietnamDateStr();

    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.phone, c.lat, c.lng, s.id as sale_id, s.date, s.total,
                s.deliver_kegs, s.return_kegs, s.payment_status,
                dr.status AS delivery_status, dr.delivered_liters, dr.missing_liters,
                dr.excess_liters, dr.damaged_liters, dr.collected_kegs, dr.note AS delivery_note
         FROM sales s
         JOIN customers c ON c.id = s.customer_id
         LEFT JOIN delivery_records dr
                ON dr.sale_id = s.id AND dr.driver_username = ?
         WHERE s.archived = 0
           AND s.deleted = 0
           AND s.type = 'sale'
           AND DATE(s.date) = ?
           AND c.archived = 0
           AND (s.driver_username = ? OR s.driver_username IS NULL OR s.driver_username = '')
         ORDER BY s.date DESC`
      )
      .all(req.user.username, today, req.user.username);

    const customers = rows.map((d) => ({
      id: d.id,
      name: d.name,
      phone: d.phone,
      lat: d.lat,
      lng: d.lng,
      sale_id: d.sale_id,
      date: d.date,
      total: d.total,
      hasGPS: !!(d.lat && d.lng),
      delivery_status: d.delivery_status,
      deliver_kegs: d.deliver_kegs,
      return_kegs: d.return_kegs,
      payment_status: d.payment_status,
      collected_kegs: d.collected_kegs,
      delivered_liters: d.delivered_liters,
      missing_liters: d.missing_liters,
      excess_liters: d.excess_liters,
      damaged_liters: d.damaged_liters,
      delivery_note: d.delivery_note,
    }));

    const settings = {};
    db.prepare('SELECT `key`, value FROM settings').all().forEach((s) => {
      settings[s.key] = s.value;
    });

    const numSettings = {
      // KHÔNG gửi delivery_cost_per_km (dữ liệu chi phí) cho tài xế.
      distributor_lat: parseFloat(settings.distributor_lat) || 10.7679,
      distributor_lng: parseFloat(settings.distributor_lng) || 106.6893,
    };

    res.json({
      customers,
      settings: numSettings,
      todayCount: customers.length,
      today,
      distributorName: process.env.DISTRIBUTOR_NAME || 'Bia Tuoi Gia Huy',
    });
  } catch (err) {
    logger.error('[driver] delivery page-data error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải dữ liệu giao hàng' });
  }
});

// POST /api/driver/deliveries — tạo record giao cho 1 đơn bán
router.post('/deliveries', requireDriver, (req, res) => {
  try {
    const { saleId } = req.body || {};
    const id = parseInt(saleId);
    if (!id) return res.status(400).json({ error: 'Thiếu saleId' });

    // Được tạo record cho: đơn của chính mình, HOẶC đơn chưa gán tài xế nào
    const sale = db.prepare('SELECT driver_username FROM sales WHERE id = ?').get(id);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    const isOwn = sale.driver_username === req.user.username;
    const isUnassigned = !sale.driver_username || sale.driver_username === '';
    if (!isOwn && !isUnassigned) {
      return res.status(403).json({
        error: 'Không có quyền thao tác đơn hàng này',
        code: 'DRIVER_SCOPE',
      });
    }

    const result = DeliveryService.ensureRecord(id, req.user.username);
    if (!result.success) return res.status(400).json({ error: result.error });

    // Gán đơn cho tài xế nếu trước đó chưa được gán (đơn Admin tạo)
    if (isUnassigned) {
      try {
        db.prepare('UPDATE sales SET driver_username = ? WHERE id = ?').run(
          req.user.username,
          id
        );
      } catch (e) {
        logger.error('[driver] assign delivery error', { error: e.message });
      }
    }

    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    logger.error('[driver] create delivery error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tạo đơn giao: ' + err.message });
  }
});

// GET /api/driver/deliveries/:id — chi tiết đơn giao
router.get('/deliveries/:id', requireDriver, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID đơn giao không hợp lệ' });

    const record = DeliveryService.getById(id, req.user.username);
    if (!record) {
      return res.status(404).json({ error: 'Không tìm thấy đơn giao' });
    }
    res.json({ ...record, statusLabels: DeliveryService.STATUS_LABELS });
  } catch (err) {
    logger.error('[driver] delivery detail error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải chi tiết đơn giao' });
  }
});

// PATCH /api/driver/deliveries/:id/status — đổi trạng thái
router.patch('/deliveries/:id/status', requireDriver, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID đơn giao không hợp lệ' });

    const { status, note, failureReason } = req.body || {};
    const result = DeliveryService.updateStatus(id, status, req.user.username, {
      note,
      failureReason,
    });

    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    logger.error('[driver] update delivery status error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật trạng thái: ' + err.message });
  }
});

// POST /api/driver/deliveries/:id/confirm — xác nhận số lượng giao + vỏ thu
router.post('/deliveries/:id/confirm', requireDriver, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID đơn giao không hợp lệ' });

    const { items, collectedKegs, note } = req.body || {};
    const result = DeliveryService.confirmDelivery(id, req.user.username, {
      items: Array.isArray(items) ? items : [],
      collectedKegs,
      note,
    });

    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    logger.error('[driver] confirm delivery error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi xác nhận giao hàng: ' + err.message });
  }
});

// POST /api/driver/deliveries/:id/discrepancy — ghi nhận sai lệch
router.post('/deliveries/:id/discrepancy', requireDriver, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID đơn giao không hợp lệ' });

    const result = DeliveryService.recordDiscrepancy(id, req.user.username, req.body || {});
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    logger.error('[driver] discrepancy error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi ghi nhận sai lệch: ' + err.message });
  }
});

// POST /api/driver/deliveries/:id/kegs — cập nhật số vỏ đã thu
router.post('/deliveries/:id/kegs', requireDriver, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID đơn giao không hợp lệ' });

    const { collectedKegs } = req.body || {};
    const result = DeliveryService.updateCollectedKegs(id, req.user.username, collectedKegs);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    logger.error('[driver] update kegs error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật số vỏ: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHIẾU THU VỎ — tài xế thu vỏ rỗng ngoài chuyến giao
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/driver/keg-receipts — danh sách phiếu thu vỏ của tài xế
router.get('/keg-receipts', requireDriver, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const receipts = KegReceiptService.listReceipts(req.user.username, limit);
    res.json({ receipts });
  } catch (err) {
    logger.error('[driver] keg receipts list error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải phiếu thu vỏ' });
  }
});

// GET /api/driver/keg-receipts/:id — chi tiết 1 phiếu (để in / chia sẻ)
router.get('/keg-receipts/:id', requireDriver, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID phiếu không hợp lệ' });

    const receipt = KegReceiptService.getReceipt(id, req.user.username);
    if (!receipt) {
      return res.status(404).json({ error: 'Không tìm thấy phiếu thu vỏ' });
    }
    res.json({ receipt });
  } catch (err) {
    logger.error('[driver] keg receipt detail error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải phiếu thu vỏ' });
  }
});

// POST /api/driver/keg-receipts — tạo phiếu thu vỏ
router.post('/keg-receipts', requireDriver, (req, res) => {
  try {
    const { customerId, kegs, note } = req.body || {};
    const result = KegReceiptService.createReceipt({
      customerId,
      kegs,
      note,
      driverUsername: req.user.username,
    });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.status(201).json(result);
  } catch (err) {
    logger.error('[driver] keg receipt create error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tạo phiếu thu vỏ: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// THANH TOÁN / CÔNG NỢ
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/driver/payments — thu tiền công nợ (dùng chung logic hệ thống)
router.post('/payments', requireDriver, (req, res) => {
  const { customerId, amount, note } = req.body || {};
  const custId = parseInt(customerId);
  const amountValue = parseFloat(amount);

  if (!custId || Number.isNaN(amountValue) || amountValue <= 0) {
    return res.status(400).json({ error: 'Thiếu khách hàng hoặc số tiền không hợp lệ' });
  }

  try {
    // Tái sử dụng DebtService.payDebt (logic công nợ chuẩn)
    const { DebtService } = require('../../src/services');
    const result = DebtService.payDebt(custId, amountValue, note || `Thu tiền tại điểm giao`);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[driver] payment error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi ghi nhận thanh toán: ' + err.message });
  }
});

// GET /api/driver/debts/:customerId — công nợ của 1 khách
router.get('/debts/:customerId', requireDriver, (req, res) => {
  try {
    const custId = parseInt(req.params.customerId);
    if (!custId) return res.status(400).json({ error: 'ID khách hàng không hợp lệ' });

    const customer = db
      .prepare('SELECT id, name, phone, debt, deposit, keg_balance FROM customers WHERE id = ?')
      .get(custId);
    if (!customer) return res.status(404).json({ error: 'Không tìm thấy khách hàng' });

    const debts = db
      .prepare(
        `SELECT od.id, od.sale_id, od.original_amount, od.paid_amount, od.remaining_amount,
                od.status, od.created_at
         FROM order_debts od
         WHERE od.customer_id = ? AND od.status != 'paid'
         ORDER BY od.created_at ASC`
      )
      .all(custId);

    res.json({ customer, debts });
  } catch (err) {
    logger.error('[driver] debts error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải công nợ' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MODULE POS NÂNG CAO — khuyến mãi, QR, vỏ, đổi lỗi, công nợ
// (Tất cả scope theo tài xế / khách hàng — KHÔNG lộ dữ liệu tài chính)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/driver/promotions/overview/:customerId
// Tổng quan KM của khách: quán mới + thưởng sản lượng (KHÔNG có doanh thu/lợi nhuận)
router.get('/promotions/overview/:customerId', requireDriver, (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (!customerId) return res.status(400).json({ error: 'ID khách hàng không hợp lệ' });

    const customer = db
      .prepare(
        `SELECT id, name, promotion_enabled, new_shop_enabled, reward_enabled, created_at
         FROM customers WHERE id = ? AND archived = 0`
      )
      .get(customerId);
    if (!customer) return res.status(404).json({ error: 'Không tìm thấy khách hàng' });

    const settings = PromotionService.getSystemPromotionSettings();
    const customerNewShopEnabled = customer.new_shop_enabled !== null ? customer.new_shop_enabled : 1;
    const customerRewardEnabled = customer.reward_enabled !== null ? customer.reward_enabled : 1;

    const promoType = PromotionService.getCustomerPromotionType(customerId);
    const isNewShopPromotion = promoType.isNewShopPromotion;
    const isRewardEligible = promoType.isRewardEligible;

    let newShopInfo = null;
    if (isNewShopPromotion && customer.promotion_enabled !== 0 && customerNewShopEnabled) {
      newShopInfo = PromotionService.isNewShopEligible(customerId);
    }

    let rewardInfo = null;
    if (isRewardEligible && customer.promotion_enabled !== 0 && customerRewardEnabled) {
      rewardInfo = PromotionService.calculateMonthlyReward(customerId);
    }

    const promoStartDate = PromotionService.getPromotionStartDate(customer);

    res.json({
      success: true,
      data: {
        customerId,
        customerName: customer.name,
        createdAt: customer.created_at,
        promotionEnabled: customer.promotion_enabled !== 0,
        newShopEnabled: customerNewShopEnabled,
        rewardEnabled: customerRewardEnabled,
        systemNewShopEnabled: settings.newShopEnabled,
        systemRewardEnabled: settings.rewardEnabled,
        isNewShopPromotion,
        isRewardEligible,
        promotionReason: promoType.reason,
        promotionStartDate: promoStartDate,
        isInNewShopPeriod: isNewShopPromotion,
        canReceiveReward: isRewardEligible,
        isWithinPromotionPeriod: PromotionService.isWithinPromotionPeriod(),
        promotionEndDate: settings.endDate,
        newShop: newShopInfo,
        newShopSettings: {
          goldBuy: settings.newShopGoldBuy,
          goldFree: settings.newShopGoldFree,
          blackBuy: settings.newShopBlackBuy,
          blackFree: settings.newShopBlackFree,
        },
        monthlyReward: rewardInfo,
      },
    });
  } catch (err) {
    logger.error('[driver] promotions overview error', { error: err.message });
    res.status(500).json({ success: false, error: 'Lỗi khi tải thông tin khuyến mãi' });
  }
});

// GET /api/driver/qr-accounts — danh sách tài khoản QR đang active (để in hoá đơn)
router.get('/qr-accounts', requireDriver, (req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT id, label, bank_code, account_no, account_name, template, default_content
         FROM qr_accounts WHERE active = 1 ORDER BY sort_order ASC, id ASC`
      )
      .all();

    // Fallback: nếu chưa có row nào, đọc từ settings
    if (!rows.length) {
      const settings = db.prepare('SELECT key, value FROM settings').all();
      const map = {};
      settings.forEach((s) => { map[s.key] = s.value; });
      if (map.qr_account_no) {
        res.json([
          {
            id: 0,
            label: 'Tài khoản mặc định',
            bank_code: map.qr_bank_code || 'ICB',
            account_no: map.qr_account_no,
            account_name: map.qr_account_name || '',
            template: map.qr_template || 'compact2',
            default_content: map.qr_default_content || 'Thanh toan HD {invoice_id}',
          },
        ]);
        return;
      }
    }

    res.json(rows);
  } catch (err) {
    logger.error('[driver] qr accounts error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải tài khoản QR' });
  }
});

// POST /api/driver/sales/:id/kegs — cập nhật vỏ giao/thu cho 1 đơn của tài xế
// Dùng chung nghiệp vụ với POST /api/sales/update-kegs (forward nội bộ).
router.post('/sales/:id/kegs', requireDriver, (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    if (!saleId) return res.status(400).json({ error: 'ID đơn hàng không hợp lệ' });

    const sale = db.prepare('SELECT customer_id, driver_username FROM sales WHERE id = ?').get(saleId);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    if (sale.driver_username !== req.user.username) {
      return res.status(403).json({ error: 'Không có quyền cập nhật đơn hàng này', code: 'DRIVER_SCOPE' });
    }
    if (!sale.customer_id) {
      return res.status(400).json({ error: 'Đơn khách lẻ không có số vỏ khách' });
    }

    const { deliver = 0, returned = 0 } = req.body || {};
    forwardToSales(req, res, '/update-kegs', 'POST', null, {
      saleId,
      customerId: sale.customer_id,
      deliver: parseInt(deliver) || 0,
      returned: parseInt(returned) || 0,
    });
  } catch (err) {
    logger.error('[driver] update kegs error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật vỏ: ' + err.message });
  }
});

// POST /api/driver/replacement — đổi bia lỗi / tặng uống thử (KHÔNG tính tiền)
// Dùng chung nghiệp vụ với POST /api/sales/replacement (forward nội bộ).
router.post('/replacement', requireDriver, (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    const quantity = parseInt(body.quantity) || 0;
    const productId = parseInt(body.product_id || body.productId) || 0;
    const isGift = !!body.gift;

    if (!productId || quantity <= 0) {
      return res.status(400).json({ error: 'Thiếu thông tin cần thiết' });
    }
    if (!isGift && !body.customer_id) {
      return res.status(400).json({ error: 'Vui lòng chọn khách hàng' });
    }

    // Chuẩn hoá key cho đúng nghiệp vụ gốc
    forwardToSales(req, res, '/replacement', 'POST', null, {
      customer_id: body.customer_id ? parseInt(body.customer_id) : null,
      product_id: productId,
      quantity,
      reason: body.reason || 'Bia hư',
      gift: isGift,
      giftGuestName: body.giftGuestName || body.gift_guest_name || '',
    });
  } catch (err) {
    logger.error('[driver] replacement error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi đổi bia lỗi: ' + err.message });
  }
});

// PATCH /api/driver/sales/:id/payment-status — cập nhật trạng thái thanh toán
router.patch('/sales/:id/payment-status', requireDriver, (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    if (!saleId) return res.status(400).json({ error: 'ID đơn hàng không hợp lệ' });

    const sale = db.prepare('SELECT driver_username FROM sales WHERE id = ?').get(saleId);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    if (sale.driver_username !== req.user.username) {
      return res.status(403).json({ error: 'Không có quyền cập nhật đơn hàng này', code: 'DRIVER_SCOPE' });
    }

    forwardToSales(req, res, `/${saleId}/payment-status`, 'PATCH', null, req.body || {});
  } catch (err) {
    logger.error('[driver] payment-status error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật trạng thái thanh toán: ' + err.message });
  }
});

module.exports = router;
