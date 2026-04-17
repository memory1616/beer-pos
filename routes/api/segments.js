/**
 * BeerPOS - Customer Segmentation API
 *
 * API endpoints cho phân khúc khách hàng:
 * - GET /api/segments - Lấy danh sách segments
 * - POST /api/segments - Tạo segment mới
 * - PUT /api/segments/:id - Cập nhật segment
 * - DELETE /api/segments/:id - Xóa segment
 * - POST /api/customers/apply-segment/:id - Áp dụng rules cho 1 khách
 * - POST /api/customers/apply-all-segments - Áp dụng rules cho tất cả
 */

const express = require('express');
const router = express.Router();

const { cache, cacheKeys } = require('../../src/cache');

/**
 * GET /api/segments
 * Lấy tất cả phân khúc
 */
router.get('/', (req, res) => {
  try {
    const segments = db.prepare(`
      SELECT * FROM customer_segments ORDER BY name
    `).all();

    res.json({ success: true, data: segments });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/segments/:id
 * Lấy chi tiết 1 segment
 */
router.get('/:id', (req, res) => {
  try {
    const segment = db.prepare('SELECT * FROM customer_segments WHERE id = ?').get(req.params.id);

    if (!segment) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy phân khúc' });
    }

    // Đếm số khách trong segment này
    const customerCount = db.prepare(
      'SELECT COUNT(*) as c FROM customers WHERE segment_id = ? AND archived = 0'
    ).get(req.params.id);

    res.json({
      success: true,
      data: {
        ...segment,
        customerCount: customerCount?.c || 0
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/segments
 * Tạo segment mới
 */
router.post('/', (req, res) => {
  try {
    const { name, code, color, icon, rules, discount_percent, priority, active } = req.body;

    if (!name || !code) {
      return res.status(400).json({ success: false, error: 'Thiếu tên hoặc mã phân khúc' });
    }

    // Check unique code
    const existing = db.prepare('SELECT id FROM customer_segments WHERE code = ?').get(code);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Mã phân khúc đã tồn tại' });
    }

    const rulesJson = rules ? JSON.stringify(rules) : null;

    const result = db.prepare(`
      INSERT INTO customer_segments (name, code, color, icon, rules, discount_percent, priority, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      code,
      color || '#3B82F6',
      icon || '👥',
      rulesJson,
      discount_percent || 0,
      priority || 0,
      active !== undefined ? (active ? 1 : 0) : 1
    );

    res.json({ success: true, data: { segmentId: result.lastInsertRowid } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * PUT /api/segments/:id
 * Cập nhật segment
 */
router.put('/:id', (req, res) => {
  try {
    const { name, code, color, icon, rules, discount_percent, priority, active } = req.body;

    const existing = db.prepare('SELECT * FROM customer_segments WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy phân khúc' });
    }

    // Check unique code if changing
    if (code && code !== existing.code) {
      const codeExists = db.prepare('SELECT id FROM customer_segments WHERE code = ? AND id != ?').get(code, req.params.id);
      if (codeExists) {
        return res.status(400).json({ success: false, error: 'Mã phân khúc đã tồn tại' });
      }
    }

    const rulesJson = rules ? JSON.stringify(rules) : existing.rules;

    db.prepare(`
      UPDATE customer_segments SET
        name = ?,
        code = ?,
        color = ?,
        icon = ?,
        rules = ?,
        discount_percent = ?,
        priority = ?,
        active = ?
      WHERE id = ?
    `).run(
      name || existing.name,
      code || existing.code,
      color || existing.color,
      icon || existing.icon,
      rulesJson,
      discount_percent !== undefined ? discount_percent : existing.discount_percent,
      priority !== undefined ? priority : existing.priority,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      req.params.id
    );

    // Invalidate customer caches
    cache.clear();

    res.json({ success: true, message: 'Đã cập nhật phân khúc' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * DELETE /api/segments/:id
 * Xóa segment
 */
router.delete('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM customer_segments WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy phân khúc' });
    }

    // Không cho xóa segment mặc định
    if (['new', 'regular', 'vip', 'inactive'].includes(existing.code)) {
      return res.status(400).json({ success: false, error: 'Không thể xóa phân khúc mặc định' });
    }

    // Chuyển khách sang segment mặc định (regular)
    const defaultSegment = db.prepare("SELECT id FROM customer_segments WHERE code = 'regular'").get();
    if (defaultSegment) {
      db.prepare('UPDATE customers SET segment_id = ? WHERE segment_id = ?').run(defaultSegment.id, req.params.id);
    }

    db.prepare('DELETE FROM customer_segments WHERE id = ?').run(req.params.id);

    res.json({ success: true, message: 'Đã xóa phân khúc' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/customers/:id/apply-segment
 * Áp dụng rules để tự động phân loại 1 khách
 */
router.post('/apply-segment/:customerId', (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND archived = 0').get(customerId);

    if (!customer) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy khách hàng' });
    }

    // Lấy stats
    const stats = getCustomerStats(customer);

    // Lấy segments và rules
    const segments = db.prepare('SELECT * FROM customer_segments WHERE active = 1 ORDER BY priority DESC').all();

    // Đánh giá và tìm segment phù hợp
    const result = evaluateCustomerSegment(customer, stats, segments);

    // Cập nhật segment
    if (result.segment) {
      db.prepare('UPDATE customers SET segment_id = ? WHERE id = ?').run(result.segment.id, customerId);
    }

    res.json({
      success: true,
      data: {
        customerId,
        segment: result.segment,
        matchedRules: result.matchedRules,
        stats
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/customers/apply-all-segments
 * Áp dụng rules cho tất cả khách hàng
 */
router.post('/apply-all-segments', (req, res) => {
  try {
    const customers = db.prepare('SELECT * FROM customers WHERE archived = 0').all();
    const segments = db.prepare('SELECT * FROM customer_segments WHERE active = 1 ORDER BY priority DESC').all();

    let updated = 0;
    const results = [];

    for (const customer of customers) {
      const stats = getCustomerStats(customer);
      const result = evaluateCustomerSegment(customer, stats, segments);

      if (result.segment && result.segment.id !== customer.segment_id) {
        db.prepare('UPDATE customers SET segment_id = ? WHERE id = ?').run(result.segment.id, customer.id);
        updated++;
      }

      results.push({
        customerId: customer.id,
        customerName: customer.name,
        oldSegmentId: customer.segment_id,
        newSegmentId: result.segment?.id,
        newSegmentName: result.segment?.name
      });
    }

    // Invalidate caches
    cache.clear();
    cache.delete(cacheKeys.CUSTOMERS);

    res.json({
      success: true,
      data: {
        total: customers.length,
        updated,
        results
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Lấy stats của customer
 */
function getCustomerStats(customer) {
  const sales = db.prepare(`
    SELECT * FROM sales
    WHERE customer_id = ? AND type = 'sale' AND archived = 0
    ORDER BY date DESC
  `).all(customer.id);

  const orderCount = sales.length;
  const totalSpent = sales.reduce((sum, s) => sum + (s.total || 0), 0);
  const totalQty = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as total
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.customer_id = ? AND s.type = 'sale'
  `).get(customer.id)?.total || 0;

  const avgOrderValue = orderCount > 0 ? totalSpent / orderCount : 0;

  // Last order date
  let lastOrderDate = null;
  if (sales.length > 0) {
    const dates = sales.map(s => new Date(s.date)).filter(d => !isNaN(d.getTime()));
    if (dates.length > 0) {
      lastOrderDate = new Date(Math.max(...dates));
    }
  }

  return {
    orderCount,
    totalSpent,
    totalQty,
    avgOrderValue,
    lastOrderDate,
    sales
  };
}

/**
 * Đánh giá customer và tìm segment phù hợp
 */
function evaluateCustomerSegment(customer, stats, segments) {
  // Đầu tiên kiểm tra "inactive" (quá 30 ngày không mua)
  const lastOrder = customer.last_order_date ? new Date(customer.last_order_date) : null;
  const daysSince = lastOrder
    ? Math.floor((Date.now() - lastOrder.getTime()) / (1000 * 60 * 60 * 24))
    : 999;

  // Nếu quá 30 ngày không mua → suy giảm
  const inactiveSegment = segments.find(s => s.code === 'inactive');
  if (inactiveSegment && daysSince > 30) {
    return {
      segment: inactiveSegment,
      matchedRules: [`days_since_order: ${daysSince}`]
    };
  }

  // Nếu chưa mua hoặc < 2 đơn → khách mới
  if (stats.orderCount === 0) {
    const newSegment = segments.find(s => s.code === 'new');
    if (newSegment) {
      return {
        segment: newSegment,
        matchedRules: ['order_count: 0']
      };
    }
  }

  // Đánh giá các rules
  for (const segment of segments) {
    if (!segment.rules) continue;

    let rules;
    try {
      rules = typeof segment.rules === 'string' ? JSON.parse(segment.rules) : segment.rules;
    } catch (e) {
      continue;
    }

    const matched = [];
    let passed = true;

    // Min orders
    if (rules.min_orders !== undefined && rules.min_orders !== null) {
      if (stats.orderCount >= rules.min_orders) {
        matched.push(`min_orders: ${stats.orderCount} >= ${rules.min_orders}`);
      } else {
        passed = false;
      }
    }

    // Min spent
    if (passed && rules.min_spent !== undefined && rules.min_spent !== null) {
      if (stats.totalSpent >= rules.min_spent) {
        matched.push(`min_spent: ${stats.totalSpent} >= ${rules.min_spent}`);
      } else {
        passed = false;
      }
    }

    // Max spent
    if (passed && rules.max_spent !== undefined && rules.max_spent !== null) {
      if (stats.totalSpent > rules.max_spent) {
        passed = false;
      } else {
        matched.push(`max_spent: ${stats.totalSpent} <= ${rules.max_spent}`);
      }
    }

    // Last order days
    if (passed && rules.last_order_days !== undefined && rules.last_order_days !== null) {
      if (daysSince <= rules.last_order_days) {
        matched.push(`last_order_days: ${daysSince} <= ${rules.last_order_days}`);
      } else {
        passed = false;
      }
    }

    // Avg order value
    if (passed && rules.avg_order_value !== undefined && rules.avg_order_value !== null) {
      if (stats.avgOrderValue >= rules.avg_order_value) {
        matched.push(`avg_order_value: ${stats.avgOrderValue} >= ${rules.avg_order_value}`);
      } else {
        passed = false;
      }
    }

    if (passed) {
      return { segment, matchedRules: matched };
    }
  }

  // Default: regular
  const regularSegment = segments.find(s => s.code === 'regular');
  return {
    segment: regularSegment,
    matchedRules: ['default']
  };
}

module.exports = router;
