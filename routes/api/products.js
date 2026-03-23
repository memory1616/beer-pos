const express = require('express');
const router = express.Router();
const db = require('../../database');

// ========== HELPER: Sync keg_stats.inventory with products stock ==========
// Call this whenever product stock (type='keg') changes
function syncKegInventory() {
  try {
    // Ensure keg_stats row exists
    const exists = db.prepare('SELECT COUNT(*) as count FROM keg_stats WHERE id = 1').get();
    if (!exists || exists.count === 0) {
      db.prepare('INSERT INTO keg_stats (id, inventory, empty_collected, customer_holding) VALUES (1, 0, 0, 0)').run();
    }
    
    const result = db.prepare("SELECT COALESCE(SUM(stock), 0) as total FROM products WHERE type = 'keg'").get();
    db.prepare('UPDATE keg_stats SET inventory = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(result.total);
    console.log('[SYNC] Keg inventory synced:', result.total);
    return result.total;
  } catch (err) {
    console.error('Sync keg inventory error:', err);
    return null;
  }
}

// Validate ID parameter
function validateId(id) {
  const parsed = parseInt(id);
  if (isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

// Validate product input
function validateProductInput(body, isUpdate = false) {
  const errors = [];

  if (!body) {
    errors.push('Dữ liệu yêu cầu trống');
    return { valid: false, errors };
  }

  const { name, stock, cost_price, sell_price, type } = body;

  // Validate name (required for create)
  if (!isUpdate && (!name || name.trim() === '')) {
    errors.push('Tên sản phẩm là bắt buộc');
  }

  // Validate stock
  if (stock !== undefined && stock !== null && (isNaN(parseInt(stock)) || parseInt(stock) < 0)) {
    errors.push('Tồn kho phải là số nguyên không âm');
  }

  // Validate cost_price
  if (cost_price !== undefined && cost_price !== null && isNaN(parseFloat(cost_price))) {
    errors.push('Gía nhập phải là số');
  }

  // Validate sell_price
  if (sell_price !== undefined && sell_price !== null && isNaN(parseFloat(sell_price))) {
    errors.push('Gía bán phải là số');
  }

  // Validate type
  if (type && !['keg', 'pet', 'can'].includes(type)) {
    errors.push('Loại sản phẩm không hợp lệ (keg, pet, can)');
  }

  return { valid: errors.length === 0, errors };
}

// GET /api/products
router.get('/', (req, res) => {
  try {
    const products = db.prepare('SELECT * FROM products ORDER BY name').all();
    res.json(products);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Lỗi khi lấy danh sách sản phẩm' });
  }
});

// GET /api/products/prices
router.get('/prices', (req, res) => {
  try {
    const { customerId } = req.query;
    if (customerId) {
      const id = validateId(customerId);
      if (!id) {
        return res.status(400).json({ error: 'ID khách hàng không hợp lệ' });
      }
      const prices = db.prepare(`SELECT pr.*, p.name as product_name FROM prices pr JOIN products p ON pr.product_id = p.id WHERE pr.customer_id = ?`).all(id);
      return res.json(prices);
    }
    res.json(db.prepare(`SELECT pr.*, c.name as customer_name, p.name as product_name FROM prices pr JOIN customers c ON pr.customer_id = c.id JOIN products p ON pr.product_id = p.id`).all());
  } catch (err) {
    console.error('Error fetching prices:', err);
    res.status(500).json({ error: 'Lỗi khi lấy danh sách giá' });
  }
});

// POST /api/products/prices
router.post('/prices', (req, res) => {
  try {
    const { customerId, productId, price } = req.body;

    // Validate required fields
    if (!customerId || !productId || price === undefined) {
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
    }

    // Validate IDs
    const custId = validateId(customerId);
    const prodId = validateId(productId);
    if (!custId || !prodId) {
      return res.status(400).json({ error: 'ID không hợp lệ' });
    }

    // Validate price
    const priceValue = parseFloat(price);
    if (isNaN(priceValue) || priceValue < 0) {
      return res.status(400).json({ error: 'Giá không hợp lệ' });
    }

    db.prepare(`INSERT OR REPLACE INTO prices (customer_id, product_id, price) VALUES (?, ?, ?)`).run(custId, prodId, priceValue);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving price:', err);
    res.status(500).json({ error: 'Lỗi khi lưu giá' });
  }
});

// Bulk prices
router.post('/prices/bulk', (req, res) => {
  try {
    const { customer_id, prices } = req.body;
    const custId = validateId(customer_id);

    if (!custId || !prices || !Array.isArray(prices)) {
      return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
    }

    const insertPrice = db.prepare(`INSERT OR REPLACE INTO prices (customer_id, product_id, price) VALUES (?, ?, ?)`);

    for (const p of prices) {
      if (p.product_id && p.price !== undefined) {
        const prodId = validateId(p.product_id);
        const priceVal = parseFloat(p.price);
        if (prodId && !isNaN(priceVal) && priceVal >= 0) {
          insertPrice.run(custId, prodId, priceVal);
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error saving bulk prices:', err);
    res.status(500).json({ error: 'Lỗi khi lưu giá' });
  }
});

// GET /api/products/:id
router.get('/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json(product);
});

// POST /api/products
router.post('/', (req, res) => {
  const { name, stock, cost_price, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const productType = type || 'keg';
  const result = db.prepare('INSERT INTO products (name, stock, cost_price, type) VALUES (?, ?, ?, ?)').run(name, parseInt(stock) || 0, parseFloat(cost_price) || 0, productType);
  
  // Sync keg inventory if this is a keg product
  if (productType === 'keg') {
    syncKegInventory();
  }
  
  res.json({ id: result.lastInsertRowid, name, stock: parseInt(stock) || 0, cost_price: parseFloat(cost_price) || 0, type: productType });
});

// PUT /api/products/:id
router.put('/:id', (req, res) => {
  const { name, stock, cost_price, type } = req.body;
  const productType = type || 'keg';
  db.prepare('UPDATE products SET name = ?, stock = ?, cost_price = ?, type = ? WHERE id = ?').run(name, parseInt(stock), parseFloat(cost_price) || 0, productType, req.params.id);
  
  // Sync keg inventory if this is a keg product
  if (productType === 'keg') {
    syncKegInventory();
  }
  
  res.json({ success: true });
});

// DELETE /api/products/:id
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
module.exports.syncKegInventory = syncKegInventory;
