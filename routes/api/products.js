const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const socketServer = require('../../src/socket/socketServer');

// ========== HELPER: Sync keg_stats.inventory with products stock ==========
function syncKegInventory() {
  try {
    const result = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
    db.prepare('UPDATE keg_stats SET inventory = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(result ? result.total : 0);
    logger.info('Keg inventory synced', { total: result ? result.total : 0 });
    return result ? result.total : 0;
  } catch (err) {
    logger.error('Sync keg inventory error', { error: err.message });
    return null;
  }
}

// ========== HELPER: Slug utilities ==========
function toSlug(name) {
  if (!name) return '';
  return name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim().replace(/\s+/g, '_');
}

function findProduct(query) {
  if (!query) return null;
  // Try slug first, then numeric id
  const bySlug = db.prepare('SELECT * FROM products WHERE slug = ?').get(query);
  if (bySlug) return bySlug;
  const numId = parseInt(query);
  if (!isNaN(numId) && numId > 0) {
    return db.prepare('SELECT * FROM products WHERE id = ?').get(numId);
  }
  return null;
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
  if (type && !['keg', 'pet', 'box'].includes(type)) {
    errors.push('Loại sản phẩm không hợp lệ (keg, pet, box)');
  }

  return { valid: errors.length === 0, errors };
}

// ========== GET /api/products ==========
router.get('/', (req, res) => {
  try {
    // Always include slug in response
    const products = db.prepare('SELECT id, slug, name, stock, damaged_stock, cost_price, sell_price, type, created_at, updated_at FROM products ORDER BY name').all();
    res.json(products);
  } catch (err) {
    logger.error('Error fetching products', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lấy danh sách sản phẩm' });
  }
});

// ========== GET /api/products/prices ==========
router.get('/prices', (req, res) => {
  try {
    const { customerId, slug } = req.query;
    if (customerId) {
      const numId = parseInt(customerId);
      if (isNaN(numId) || numId <= 0) {
        return res.status(400).json({ error: 'ID khách hàng không hợp lệ' });
      }
      // Return prices with both product_id and product_slug
      const prices = db.prepare(`
        SELECT pr.*, p.name as product_name, p.slug as product_slug
        FROM prices pr
        JOIN products p ON pr.product_id = p.id
        WHERE pr.customer_id = ?
      `).all(numId);
      return res.json(prices);
    }
    if (slug) {
      // Get all prices for a specific product by slug
      const product = db.prepare('SELECT id FROM products WHERE slug = ?').get(slug);
      if (!product) return res.json([]);
      const prices = db.prepare(`
        SELECT pr.*, c.name as customer_name, p.slug as product_slug
        FROM prices pr
        JOIN customers c ON pr.customer_id = c.id
        JOIN products p ON pr.product_id = p.id
        WHERE pr.product_id = ?
      `).all(product.id);
      return res.json(prices);
    }
    res.json(db.prepare(`
      SELECT pr.*, c.name as customer_name, p.name as product_name, p.slug as product_slug
      FROM prices pr
      JOIN customers c ON pr.customer_id = c.id
      JOIN products p ON pr.product_id = p.id
    `).all());
  } catch (err) {
    logger.error('Error fetching prices', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lấy danh sách giá' });
  }
});

// ========== POST /api/products/prices ==========
router.post('/prices', (req, res) => {
  try {
    const { customerId, productId, productSlug, price } = req.body;

    if (!customerId || !price === undefined) {
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
    }

    const custId = parseInt(customerId);
    if (isNaN(custId) || custId <= 0) {
      return res.status(400).json({ error: 'ID khách hàng không hợp lệ' });
    }

    // Resolve product: prefer numeric id, fallback to slug
    let prodId;
    if (productId) {
      prodId = parseInt(productId);
      if (isNaN(prodId) || prodId <= 0) prodId = null;
    }
    if (!prodId && productSlug) {
      const product = db.prepare('SELECT id FROM products WHERE slug = ?').get(productSlug);
      prodId = product ? product.id : null;
    }
    if (!prodId) {
      return res.status(400).json({ error: 'Không tìm thấy sản phẩm (dùng productId hoặc productSlug)' });
    }

    const priceValue = parseFloat(price);
    if (isNaN(priceValue) || priceValue < 0) {
      return res.status(400).json({ error: 'Giá không hợp lệ' });
    }

    const product = db.prepare('SELECT slug FROM products WHERE id = ?').get(prodId);
    db.prepare(`INSERT OR REPLACE INTO prices (customer_id, product_id, product_slug, price) VALUES (?, ?, ?, ?)`)
      .run(custId, prodId, product ? product.slug : null, priceValue);
    res.json({ success: true, customerId: custId, productId: prodId, productSlug: product ? product.slug : null, price: priceValue });
  } catch (err) {
    logger.error('Error saving price', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lưu giá' });
  }
});

// ========== POST /api/products/prices/bulk ==========
router.post('/prices/bulk', (req, res) => {
  try {
    const { customer_id, customerId, prices } = req.body;
    const custId = parseInt(customer_id || customerId);
    if (isNaN(custId) || custId <= 0 || !prices || !Array.isArray(prices)) {
      return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
    }

    const insertPrice = db.prepare(`INSERT OR REPLACE INTO prices (customer_id, product_id, product_slug, price) VALUES (?, ?, ?, ?)`);
    let savedCount = 0;

    for (const p of prices) {
      const pPrice = p.price !== undefined ? p.price : p;
      if (pPrice === undefined) continue;

      const priceVal = parseFloat(pPrice);
      if (isNaN(priceVal) || priceVal < 0) continue;

      // Try product_id (numeric) first, then productSlug
      let prodId;
      let prodSlug = null;
      if (p.product_id) {
        prodId = parseInt(p.product_id);
        if (!isNaN(prodId) && prodId > 0) {
          const product = db.prepare('SELECT slug FROM products WHERE id = ?').get(prodId);
          if (product) prodSlug = product.slug;
        } else {
          prodId = null;
        }
      }
      if (!prodId && p.productSlug) {
        const product = db.prepare('SELECT id, slug FROM products WHERE slug = ?').get(p.productSlug);
        if (product) { prodId = product.id; prodSlug = product.slug; }
      }
      if (!prodId && p.slug) {
        const product = db.prepare('SELECT id, slug FROM products WHERE slug = ?').get(p.slug);
        if (product) { prodId = product.id; prodSlug = product.slug; }
      }

      if (prodId) {
        insertPrice.run(custId, prodId, prodSlug, priceVal);
        savedCount++;
      }
    }

    res.json({ success: true, savedCount });
  } catch (err) {
    logger.error('Error saving bulk prices', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lưu giá' });
  }
});

// ========== GET /api/products/:id ==========
router.get('/:id', (req, res) => {
  const product = findProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
  res.json(product);
});

// ========== POST /api/products ==========
router.post('/', (req, res) => {
  const { name, slug, stock, cost_price, sell_price, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Tên sản phẩm là bắt buộc' });

  const productType = type || 'keg';
  // Auto-generate slug from name if not provided
  const productSlug = slug || toSlug(name);

  // Check for duplicate slug
  const existing = db.prepare('SELECT id FROM products WHERE slug = ?').get(productSlug);
  if (existing) {
    return res.status(400).json({ error: 'Slug sản phẩm đã tồn tại: ' + productSlug });
  }

  try {
    const result = db.prepare('INSERT INTO products (slug, name, stock, cost_price, sell_price, type) VALUES (?, ?, ?, ?, ?, ?)')
      .run(productSlug, name, parseInt(stock) || 0, parseFloat(cost_price) || 0, parseFloat(sell_price) || 0, productType);
    const productId = result.lastInsertRowid;

    if (productType === 'keg') {
      syncKegInventory();
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    socketServer.emitInventoryUpdated({ product });
    logger.info('[Products] Created', { id: productId, slug: productSlug, name });
    res.json({ id: productId, slug: productSlug, name, stock: parseInt(stock) || 0, cost_price: parseFloat(cost_price) || 0, sell_price: parseFloat(sell_price) || 0, type: productType });
  } catch (err) {
    logger.error('Error creating product', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tạo sản phẩm: ' + err.message });
  }
});

// ========== PUT /api/products/:id ==========
router.put('/:id', (req, res) => {
  const product = findProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });

  const { name, slug, stock, cost_price, sell_price, type } = req.body;
  const productType = type || product.type || 'keg';

  // Determine slug: new slug provided, re-generate from name, or keep existing
  let finalSlug = product.slug;
  if (slug) {
    finalSlug = toSlug(slug);
  } else if (name && name !== product.name) {
    finalSlug = toSlug(name);
  }

  // Check for duplicate slug (excluding current product)
  if (finalSlug !== product.slug) {
    const duplicate = db.prepare('SELECT id FROM products WHERE slug = ? AND id != ?').get(finalSlug, product.id);
    if (duplicate) {
      return res.status(400).json({ error: 'Slug sản phẩm đã tồn tại: ' + finalSlug });
    }
  }

  try {
    const updatedName = name || product.name;
    db.prepare('UPDATE products SET slug = ?, name = ?, stock = ?, cost_price = ?, sell_price = ?, type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(finalSlug, updatedName, stock !== undefined ? parseInt(stock) : product.stock, cost_price !== undefined ? parseFloat(cost_price) : product.cost_price, sell_price !== undefined ? parseFloat(sell_price) : product.sell_price, productType, product.id);

    // Update product_slug in prices table
    db.prepare('UPDATE prices SET product_slug = ? WHERE product_id = ?').run(finalSlug, product.id);

    if (productType === 'keg') {
      syncKegInventory();
    }

    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(product.id);
    socketServer.emitInventoryUpdated({ product: updated });
    logger.info('[Products] Updated', { id: product.id, slug: finalSlug, name: updatedName });
    res.json({ success: true, product: updated });
  } catch (err) {
    logger.error('Error updating product', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật sản phẩm: ' + err.message });
  }
});

// ========== DELETE /api/products/:id ==========
router.delete('/:id', (req, res) => {
  const product = findProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });

  try {
    db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
    socketServer.emitInventoryUpdated({ productId: product.id, slug: product.slug, deleted: true });
    logger.info('[Products] Deleted', { id: product.id, slug: product.slug, name: product.name });
    res.json({ success: true, id: product.id, slug: product.slug });
  } catch (err) {
    logger.error('Error deleting product', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi xóa sản phẩm: ' + err.message });
  }
});

module.exports = router;
module.exports.syncKegInventory = syncKegInventory;
module.exports.findProduct = findProduct;
