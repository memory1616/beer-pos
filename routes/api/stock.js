const express = require('express');
const router = express.Router();
const db = require('../../database');

// Validate ID parameter
function validateId(id) {
  const parsed = parseInt(id);
  if (isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

// Validate stock input
function validateStockInput(body) {
  const errors = [];

  if (!body) {
    errors.push('Dữ liệu yêu cầu trống');
    return { valid: false, errors };
  }

  const { productId, quantity, stock } = body;

  // For stock import
  if (quantity !== undefined) {
    const qty = parseInt(quantity);
    if (isNaN(qty) || qty <= 0) {
      errors.push('Số lượng nhập phải lớn hơn 0');
    }
  }

  // For stock set
  if (stock !== undefined) {
    const s = parseInt(stock);
    if (isNaN(s) || s < 0) {
      errors.push('Tồn kho không được âm');
    }
  }

  // Validate productId
  const prodId = validateId(productId);
  if (!prodId) {
    errors.push('ID sản phẩm không hợp lệ');
  }

  return { valid: errors.length === 0, errors };
}

// GET /api/stock/alerts - Lấy cảnh báo tồn kho thấp
router.get('/alerts', (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 10;
    const products = db.prepare(`
      SELECT id, name, stock, type
      FROM products
      WHERE stock <= ?
      ORDER BY stock ASC
    `).all(threshold);

    res.json({
      count: products.length,
      threshold: threshold,
      products: products
    });
  } catch (err) {
    console.error('Error fetching stock alerts:', err);
    res.status(500).json({ error: 'Lỗi khi lấy cảnh báo tồn kho' });
  }
});

// GET /api/stock/history - Lịch sử nhập/xuất kho
router.get('/history', (req, res) => {
  try {
    const productId = req.query.productId;
    const limit = parseInt(req.query.limit) || 20;

    let query = '';
    let params = [];

    if (productId) {
      const prodId = validateId(productId);
      if (!prodId) {
        return res.status(400).json({ error: 'ID sản phẩm không hợp lệ' });
      }

      // Get import history (from purchases)
      const imports = db.prepare(`
        SELECT pi.id, pi.quantity, pi.unit_price, pi.total_price, p.date, 'import' as type
        FROM purchase_items pi
        JOIN purchases p ON pi.purchase_id = p.id
        WHERE pi.product_id = ?
        ORDER BY p.date DESC
        LIMIT ?
      `).all(prodId, limit);

      // Get export history (from sales)
      const exports = db.prepare(`
        SELECT si.id, si.quantity, si.price as unit_price, si.quantity * si.price as total_price, s.date, 'export' as type
        FROM sale_items si
        JOIN sales s ON si.sale_id = s.id
        WHERE si.product_id = ?
        ORDER BY s.date DESC
        LIMIT ?
      `).all(prodId, limit);

      // Combine and sort
      const history = [...imports, ...exports].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);

      res.json(history);
    } else {
      res.json([]);
    }
  } catch (err) {
    console.error('Error fetching stock history:', err);
    res.status(500).json({ error: 'Lỗi khi lấy lịch sử kho' });
  }
});

// POST /api/stock - Nhập hàng (cộng dồn)
router.post('/', (req, res) => {
  const validation = validateStockInput(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.errors.join(', ') });
  }

  try {
    const { productId, quantity } = req.body;
    const prodId = validateId(productId);
    const qty = parseInt(quantity);

    // Check if product exists
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(prodId);
    if (!product) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }

    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, prodId);
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(prodId));
  } catch (err) {
    console.error('Error importing stock:', err);
    res.status(500).json({ error: 'Lỗi khi nhập kho' });
  }
});

// POST /api/stock/set - Đặt trực tiếp số lượng tồn kho
router.post('/set', (req, res) => {
  const { productId, stock } = req.body;

  const prodId = validateId(productId);
  if (!prodId) {
    return res.status(400).json({ error: 'ID sản phẩm không hợp lệ' });
  }

  if (stock === undefined || stock === null || isNaN(parseInt(stock)) || parseInt(stock) < 0) {
    return res.status(400).json({ error: 'Tồn kho không hợp lệ' });
  }

  try {
    // Check if product exists
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(prodId);
    if (!product) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }

    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(parseInt(stock), prodId);
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(prodId));
  } catch (err) {
    console.error('Error setting stock:', err);
    res.status(500).json({ error: 'Lỗi khi cập nhật tồn kho' });
  }
});

// POST /api/stock/multiple - Nhập kho nhiều sản phẩm
router.post('/multiple', (req, res) => {
  const { items, note } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Danh sách sản phẩm trống' });
  }

  try {
    const updateStmt = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
    const results = [];

    for (const item of items) {
      const prodId = validateId(item.productId);
      const qty = parseInt(item.quantity);

      if (!prodId || isNaN(qty) || qty <= 0) {
        continue;
      }

      updateStmt.run(qty, prodId);
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(prodId);
      if (product) {
        results.push(product);
      }
    }

    res.json(results);
  } catch (err) {
    console.error('Error bulk importing stock:', err);
    res.status(500).json({ error: 'Lỗi khi nhập kho' });
  }
});

module.exports = router;
