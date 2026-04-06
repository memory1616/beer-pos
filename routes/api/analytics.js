const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');

function formatVND(amount) {
  if (amount === null || amount === undefined || amount === '') return '0 đ';
  const num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

function vnDateExpr(column) {
  return `date(datetime(${column}, '+7 hours'))`;
}

// GET /api/analytics/profit-by-product - Lợi nhuận theo sản phẩm
router.get('/profit-by-product', (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    let query = `
      SELECT
        p.id,
        p.name,
        p.type,
        SUM(si.quantity) as total_qty,
        SUM(si.quantity * si.price) as revenue,
        SUM(si.quantity * si.cost_price) as cost,
        SUM(si.profit) as profit
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      JOIN sales s ON s.id = si.sale_id
      WHERE (s.status IS NULL OR s.status != 'returned')
    `;

    const params = [];
    if (startDate && endDate) {
      query += ` AND ${vnDateExpr('s.date')} >= date(?) AND ${vnDateExpr('s.date')} <= date(?)`;
      params.push(startDate, endDate);
    }

    query += ` GROUP BY p.id ORDER BY profit DESC`;
    
    const results = db.prepare(query).all(...params);
    
    const totalRevenue = results.reduce((sum, r) => sum + r.revenue, 0);
    const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
    const totalProfit = results.reduce((sum, r) => sum + r.profit, 0);
    
    res.json({ 
      products: results,
      summary: { totalRevenue, totalCost, totalProfit }
    });
  } catch (err) {
    logger.error('Error fetching analytics', { error: err.message });
    res.status(500).json({ error: 'Error getting profit by product' });
  }
});

// GET /api/analytics/profit-by-customer - Lợi nhuận theo khách hàng
router.get('/profit-by-customer', (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    let query = `
      SELECT
        c.id,
        c.name,
        COUNT(s.id) as total_orders,
        SUM(s.total) as revenue,
        SUM(s.profit) as profit
      FROM sales s
      JOIN customers c ON c.id = s.customer_id
      WHERE (s.status IS NULL OR s.status != 'returned')
    `;

    const params = [];
    if (startDate && endDate) {
      query += ` AND ${vnDateExpr('s.date')} >= date(?) AND ${vnDateExpr('s.date')} <= date(?)`;
      params.push(startDate, endDate);
    }

    query += ` GROUP BY c.id ORDER BY profit DESC`;
    
    const results = db.prepare(query).all(...params);
    
    const totalRevenue = results.reduce((sum, r) => sum + r.revenue, 0);
    const totalProfit = results.reduce((sum, r) => sum + r.profit, 0);
    
    res.json({ 
      customers: results,
      summary: { totalRevenue, totalProfit }
    });
  } catch (err) {
    logger.error('Error fetching analytics', { error: err.message });
    res.status(500).json({ error: 'Error getting profit by customer' });
  }
});

// GET /api/analytics/daily-cashflow - Báo cáo dòng tiền hàng ngày
router.get('/daily-cashflow', (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const today = new Date().toISOString().split('T')[0];
    const start = startDate || today;
    const end = endDate || today;

    // Doanh thu bán hàng theo ngày
    const salesByDay = db.prepare(`
      SELECT
        ${vnDateExpr('date')} as day,
        SUM(total) as revenue,
        SUM(profit) as profit,
        COUNT(*) as orders
      FROM sales
      WHERE (status IS NULL OR status != 'returned')
        AND ${vnDateExpr('date')} >= date(?)
        AND ${vnDateExpr('date')} <= date(?)
      GROUP BY ${vnDateExpr('date')}
      ORDER BY day DESC
    `).all(start, end);
    
    // Chi phí mua hàng theo ngày (nếu có bảng purchases)
    let purchasesByDay = [];
    try {
      purchasesByDay = db.prepare(`
        SELECT
          ${vnDateExpr('date')} as day,
          SUM(total) as expense
        FROM purchases
        WHERE ${vnDateExpr('date')} >= date(?)
          AND ${vnDateExpr('date')} <= date(?)
        GROUP BY ${vnDateExpr('date')}
      `).all(start, end) || [];
    } catch (e) {
      purchasesByDay = [];
    }
    
    // Merge sales and purchases
    const allDays = new Set([...salesByDay.map(s => s.day), ...purchasesByDay.map(p => p.day)]);
    const cashflow = [];
    
    allDays.forEach(day => {
      const sale = salesByDay.find(s => s.day === day) || { revenue: 0, profit: 0, orders: 0 };
      const purchase = purchasesByDay.find(p => p.day === day) || { expense: 0 };
      cashflow.push({
        day,
        revenue: sale.revenue,
        profit: sale.profit,
        expense: purchase.expense,
        netCash: sale.revenue - purchase.expense,
        orders: sale.orders
      });
    });
    
    cashflow.sort((a, b) => b.day.localeCompare(a.day));
    
    const totalRevenue = cashflow.reduce((sum, r) => sum + r.revenue, 0);
    const totalExpense = cashflow.reduce((sum, r) => sum + r.expense, 0);
    const totalProfit = cashflow.reduce((sum, r) => sum + r.profit, 0);
    const netCash = totalRevenue - totalExpense;
    
    res.json({ 
      daily: cashflow,
      summary: { totalRevenue, totalExpense, totalProfit, netCash }
    });
  } catch (err) {
    logger.error('Error fetching analytics', { error: err.message });
    res.status(500).json({ error: 'Error getting cashflow' });
  }
});

// GET /api/analytics/customer-history/:customerId - Lịch sử mua hàng của khách
router.get('/customer-history/:customerId', (req, res) => {
  try {
    const { customerId } = req.params;
    const { limit = 20 } = req.query;
    
    // Thông tin khách hàng
    const customer = db.prepare(`
      SELECT id, name, phone, address, lat, lng
      FROM customers WHERE id = ?
    `).get(customerId);
    
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Lịch sử đơn hàng
    const orders = db.prepare(`
      SELECT 
        s.id,
        s.date,
        s.total,
        s.profit,
        s.type,
        s.note,
        COUNT(si.id) as items_count
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      WHERE s.customer_id = ?
      GROUP BY s.id
      ORDER BY s.date DESC
      LIMIT ?
    `).all(customerId, parseInt(limit));
    
    // Chi tiết từng đơn - PERFORMANCE: Batch query to avoid N+1
    if (orders.length === 0) {
      orderDetails = [];
    } else {
      const orderIds = orders.map(o => o.id);
      const allItems = db.prepare(`
        SELECT si.sale_id, si.product_id, p.name, si.quantity, si.price, si.cost_price, si.profit
        FROM sale_items si
        JOIN products p ON p.id = si.product_id
        WHERE si.sale_id IN (${orderIds.map(() => '?').join(',')})
      `).all(...orderIds);

      const itemsBySale = {};
      for (const item of allItems) {
        if (!itemsBySale[item.sale_id]) itemsBySale[item.sale_id] = [];
        itemsBySale[item.sale_id].push(item);
      }
      orderDetails = orders.map(o => ({ ...o, items: itemsBySale[o.id] || [] }));
    }
    
    // Tổng kết
    const summary = db.prepare(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(total) as total_revenue,
        SUM(profit) as total_profit
      FROM sales WHERE customer_id = ?
    `).get(customerId);
    
    res.json({ customer, orders: orderDetails, summary });
  } catch (err) {
    logger.error('Error fetching analytics', { error: err.message });
    res.status(500).json({ error: 'Error getting customer history' });
  }
});

module.exports = router;
