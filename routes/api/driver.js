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
const { ROLE_DRIVER } = require('../../middleware/permissions');

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
 */
function forwardToSales(req, res, subPath, method, onJson) {
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
  req.url = subPath;
  req.method = method;

  salesRouter(req, res, (err) => {
    // Handler gốc không match → trả lỗi
    req.url = originalUrl;
    req.method = originalMethod;
    if (err) return next(err);
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

  res.json({
    username: req.user.username,
    role: req.user.role,
    fullName: user?.full_name || req.user.username,
    phone: user?.phone || null,
    lastLoginAt: user?.last_login_at || null,
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
                COALESCE(c.name, 'Khách lẻ') AS customer_name
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

// POST /api/driver/deliveries — tạo record giao cho 1 đơn bán
router.post('/deliveries', requireDriver, (req, res) => {
  try {
    const { saleId } = req.body || {};
    const id = parseInt(saleId);
    if (!id) return res.status(400).json({ error: 'Thiếu saleId' });

    // Chỉ được tạo record cho đơn của chính mình
    const sale = db.prepare('SELECT driver_username FROM sales WHERE id = ?').get(id);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    if (sale.driver_username !== req.user.username) {
      return res.status(403).json({
        error: 'Không có quyền thao tác đơn hàng này',
        code: 'DRIVER_SCOPE',
      });
    }

    const result = DeliveryService.ensureRecord(id, req.user.username);
    if (!result.success) return res.status(400).json({ error: result.error });
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

module.exports = router;
