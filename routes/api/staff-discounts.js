const express = require('express');
const router = express.Router();
const db = require('../../database');

// ========== HELPERS ==========

// Lấy chiết khấu cho một nhân viên và sản phẩm
function getStaffDiscount(staffId, productId, productType) {
  // Ưu tiên: product_id cụ thể > product_type
  const productDiscount = db.prepare(`
    SELECT discount_percent FROM staff_product_discounts
    WHERE staff_id = ? AND product_id = ? AND active = 1
  `).get(staffId, productId);

  if (productDiscount) return productDiscount.discount_percent;

  const typeDiscount = db.prepare(`
    SELECT discount_percent FROM staff_type_discounts
    WHERE staff_id = ? AND product_type = ? AND active = 1
  `).get(staffId, productType || 'keg');

  return typeDiscount ? typeDiscount.discount_percent : 0;
}

// ========== APIs ==========

// GET /api/staff-discounts/:staffId - Lấy tất cả chiết khấu của 1 staff
router.get('/:staffId', (req, res) => {
  const { staffId } = req.params;

  try {
    // Lấy thông tin staff
    const staff = db.prepare('SELECT * FROM sales_staff WHERE id = ?').get(staffId);
    if (!staff) {
      return res.status(404).json({ error: 'Không tìm thấy nhân viên' });
    }

    // Lấy chiết khấu theo sản phẩm cụ thể
    const productDiscounts = db.prepare(`
      SELECT sd.*, p.name as product_name, p.type as product_type
      FROM staff_product_discounts sd
      LEFT JOIN products p ON sd.product_id = p.id
      WHERE sd.staff_id = ?
      ORDER BY sd.active DESC, p.name ASC
    `).all(staffId);

    // Lấy chiết khấu theo loại sản phẩm
    const typeDiscounts = db.prepare(`
      SELECT * FROM staff_type_discounts
      WHERE staff_id = ?
      ORDER BY product_type ASC
    `).all(staffId);

    res.json({
      staff,
      productDiscounts,
      typeDiscounts
    });
  } catch (err) {
    console.error('Get staff discounts error:', err);
    res.status(500).json({ error: 'Lỗi khi lấy chiết khấu: ' + err.message });
  }
});

// GET /api/staff-discounts/:staffId/product/:productId - Tính chiết khấu cho 1 sản phẩm
router.get('/:staffId/product/:productId', (req, res) => {
  const { staffId, productId } = req.params;

  try {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }

    const discount = getStaffDiscount(parseInt(staffId), parseInt(productId), product.type);

    res.json({
      product,
      discount_percent: discount,
      // Giá sau chiết khấu
      original_price: product.sell_price,
      discounted_price: product.sell_price * (1 - discount / 100)
    });
  } catch (err) {
    console.error('Get product discount error:', err);
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// POST /api/staff-discounts/:staffId/product - Thêm/cập nhật chiết khấu sản phẩm
router.post('/:staffId/product', (req, res) => {
  const { staffId } = req.params;
  const { productId, discountPercent } = req.body;

  if (discountPercent === undefined || discountPercent < 0 || discountPercent > 100) {
    return res.status(400).json({ error: 'Chiết khấu phải từ 0 đến 100%' });
  }

  try {
    // Kiểm tra staff tồn tại
    const staff = db.prepare('SELECT * FROM sales_staff WHERE id = ?').get(staffId);
    if (!staff) {
      return res.status(404).json({ error: 'Không tìm thấy nhân viên' });
    }

    // Kiểm tra product tồn tại
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }

    // Upsert: thêm mới hoặc cập nhật
    const existing = db.prepare('SELECT id FROM staff_product_discounts WHERE staff_id = ? AND product_id = ?').get(staffId, productId);

    if (existing) {
      db.prepare(`
        UPDATE staff_product_discounts
        SET discount_percent = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(discountPercent, existing.id);
    } else {
      db.prepare(`
        INSERT INTO staff_product_discounts (staff_id, product_id, discount_percent)
        VALUES (?, ?, ?)
      `).run(staffId, productId, discountPercent);
    }

    res.json({
      success: true,
      message: `Đã ${existing ? 'cập nhật' : 'thêm'} chiết khấu ${discountPercent}% cho ${product.name}`,
      discount: discountPercent
    });
  } catch (err) {
    console.error('Save product discount error:', err);
    res.status(500).json({ error: 'Lỗi khi lưu chiết khấu: ' + err.message });
  }
});

// POST /api/staff-discounts/:staffId/type - Thêm/cập nhật chiết khấu theo loại sản phẩm
router.post('/:staffId/type', (req, res) => {
  const { staffId } = req.params;
  const { productType, discountPercent } = req.body;

  if (discountPercent === undefined || discountPercent < 0 || discountPercent > 100) {
    return res.status(400).json({ error: 'Chiết khấu phải từ 0 đến 100%' });
  }

  if (!['keg', 'pet', 'box'].includes(productType)) {
    return res.status(400).json({ error: 'Loại sản phẩm không hợp lệ' });
  }

  try {
    const staff = db.prepare('SELECT * FROM sales_staff WHERE id = ?').get(staffId);
    if (!staff) {
      return res.status(404).json({ error: 'Không tìm thấy nhân viên' });
    }

    const existing = db.prepare('SELECT id FROM staff_type_discounts WHERE staff_id = ? AND product_type = ?').get(staffId, productType);

    if (existing) {
      db.prepare(`
        UPDATE staff_type_discounts
        SET discount_percent = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(discountPercent, existing.id);
    } else {
      db.prepare(`
        INSERT INTO staff_type_discounts (staff_id, product_type, discount_percent)
        VALUES (?, ?, ?)
      `).run(staffId, productType, discountPercent);
    }

    res.json({
      success: true,
      message: `Đã ${existing ? 'cập nhật' : 'thêm'} chiết khấu ${discountPercent}% cho loại ${productType}`,
      discount: discountPercent
    });
  } catch (err) {
    console.error('Save type discount error:', err);
    res.status(500).json({ error: 'Lỗi khi lưu chiết khấu: ' + err.message });
  }
});

// DELETE /api/staff-discounts/:staffId/product/:productId - Xóa chiết khấu sản phẩm
router.delete('/:staffId/product/:productId', (req, res) => {
  const { staffId, productId } = req.params;

  try {
    const result = db.prepare('DELETE FROM staff_product_discounts WHERE staff_id = ? AND product_id = ?').run(staffId, productId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Không tìm thấy chiết khấu để xóa' });
    }

    res.json({ success: true, message: 'Đã xóa chiết khấu sản phẩm' });
  } catch (err) {
    console.error('Delete product discount error:', err);
    res.status(500).json({ error: 'Lỗi khi xóa chiết khấu: ' + err.message });
  }
});

// GET /api/staff-discounts/:staffId/calculate - Tính giá sau chiết khấu cho nhiều sản phẩm
router.post('/:staffId/calculate', (req, res) => {
  const { staffId } = req.params;
  const { items } = req.body; // [{productId, quantity}]

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Danh sách sản phẩm trống' });
  }

  try {
    const result = [];

    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
      if (!product) continue;

      const discount = getStaffDiscount(parseInt(staffId), parseInt(item.productId), product.type);
      const originalPrice = product.sell_price || 0;
      const discountedPrice = originalPrice * (1 - discount / 100);

      result.push({
        productId: item.productId,
        productName: product.name,
        quantity: item.quantity,
        originalPrice,
        discountPercent: discount,
        discountedPrice,
        totalDiscount: (originalPrice - discountedPrice) * item.quantity,
        totalWithDiscount: discountedPrice * item.quantity
      });
    }

    const totals = result.reduce((acc, item) => ({
      originalTotal: acc.originalTotal + originalPriceFunc(item),
      totalDiscount: acc.totalDiscount + item.totalDiscount,
      finalTotal: acc.finalTotal + item.totalWithDiscount
    }), { originalTotal: 0, totalDiscount: 0, finalTotal: 0 });

    function originalPriceFunc(item) {
      return item.originalPrice * item.quantity;
    }

    res.json({ items: result, summary: totals });
  } catch (err) {
    console.error('Calculate discounts error:', err);
    res.status(500).json({ error: 'Lỗi khi tính chiết khấu: ' + err.message });
  }
});

module.exports = router;
