// API Routes cho Sales Staff & Commission System
const express = require('express');
const router = express.Router();
const SalesStaffService = require('../../src/services/salesStaff');

// ==================== CONFIG ROUTES (phải đặt trước /:id) ====================

// GET /api/sales-staff/config/commissions - Cấu hình hoa hồng
router.get('/config/commissions', (req, res) => {
  try {
    const config = SalesStaffService.getCommissionConfig();
    const products = SalesStaffService.getProductCommissions();
    res.json({ success: true, data: { config, products } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/sales-staff/config/new-shop-commission - Cập nhật hoa hồng mở cửa hàng
router.put('/config/new-shop-commission', (req, res) => {
  try {
    const { amount, windowDays, minimumKegLiters } = req.body;
    if (amount === undefined || windowDays === undefined || minimumKegLiters === undefined) {
      return res.status(400).json({ success: false, error: 'Thiếu cấu hình hoa hồng mở cửa hàng' });
    }
    const result = SalesStaffService.updateCommissionConfig({
      newShopCommission: parseFloat(amount),
      newShopWindowDays: parseInt(windowDays, 10),
      newShopMinKegLiters: parseFloat(minimumKegLiters)
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/sales-staff/config/product-commission/:id - Cập nhật hoa hồng theo sản phẩm
router.put('/config/product-commission/:id', (req, res) => {
  try {
    const { salaryPerLiter } = req.body;
    if (salaryPerLiter === undefined) return res.status(400).json({ success: false, error: 'Thiếu số tiền' });
    SalesStaffService.updateProductCommission(req.params.id, parseFloat(salaryPerLiter));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/sales-staff/config/product-commission/:id - Xóa cấu hình hoa hồng
router.delete('/config/product-commission/:id', (req, res) => {
  try {
    SalesStaffService.deleteProductCommission(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sales-staff/config/product-commission - Thêm cấu hình hoa hồng cho sản phẩm
router.post('/config/product-commission', (req, res) => {
  try {
    const { productId, productType, salaryPerLiter } = req.body;
    if (salaryPerLiter === undefined) {
      return res.status(400).json({ success: false, error: 'Thiếu thông tin' });
    }
    const result = SalesStaffService.addProductCommission(
      productId ? parseInt(productId) : null,
      parseFloat(salaryPerLiter),
      productType || 'all'
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sales-staff/assign - Gán khách hàng cho sales
router.post('/assign', (req, res) => {
  try {
    const { customerId, salesId } = req.body;
    if (!customerId || !salesId) {
      return res.status(400).json({ success: false, error: 'Thiếu thông tin' });
    }
    SalesStaffService.assignCustomer(parseInt(customerId), parseInt(salesId));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sales-staff/customer/:customerId - Lấy sales của khách hàng
router.get('/customer/:customerId', (req, res) => {
  try {
    const sales = SalesStaffService.getSalesForCustomer(req.params.customerId);
    res.json({ success: true, data: sales });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sales-staff/salary-summary/:year/:month - Tổng hợp lương tháng
router.get('/salary-summary/:year/:month', (req, res) => {
  try {
    const { year, month } = req.params;
    const results = SalesStaffService.calculateAllMonthlySalaries(parseInt(year), parseInt(month));
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sales-staff/mark-salary-paid - Đánh dấu lương đã trả
router.post('/mark-salary-paid', (req, res) => {
  try {
    const { salesId, year, month } = req.body;
    SalesStaffService.markSalaryPaid(parseInt(salesId), parseInt(year), parseInt(month));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sales-staff/mark-commission-paid - Đánh dấu hoa hồng đã trả
router.post('/mark-commission-paid', (req, res) => {
  try {
    const { commissionId } = req.body;
    SalesStaffService.markCommissionPaid(parseInt(commissionId));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== MAIN ROUTES ====================

// GET /api/sales-staff - Danh sách nhân viên
router.get('/', (req, res) => {
  try {
    const staff = SalesStaffService.getAll();
    res.json({ success: true, data: staff });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sales-staff/:id - Chi tiết nhân viên
router.get('/:id', (req, res) => {
  try {
    const staff = SalesStaffService.getById(req.params.id);
    if (!staff) return res.status(404).json({ success: false, error: 'Không tìm thấy' });
    res.json({ success: true, data: staff });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sales-staff - Tạo nhân viên mới
router.post('/', (req, res) => {
  try {
    const { name, phone, email } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Thiếu tên' });
    const result = SalesStaffService.create({ name, phone, email });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/sales-staff/:id - Cập nhật nhân viên
router.put('/:id', (req, res) => {
  try {
    const { name, phone, email } = req.body;
    const result = SalesStaffService.update(req.params.id, { name, phone, email });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/sales-staff/:id - Xóa nhân viên
router.delete('/:id', (req, res) => {
  try {
    SalesStaffService.delete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sales-staff/:id/customers - Danh sách khách hàng được gán
router.get('/:id/customers', (req, res) => {
  try {
    const customers = SalesStaffService.getAssignedCustomers(req.params.id);
    res.json({ success: true, data: customers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sales-staff/:id/salary/:year/:month - Lương tháng
router.get('/:id/salary/:year/:month', (req, res) => {
  try {
    const { id, year, month } = req.params;
    const salary = SalesStaffService.calculateMonthlySalary(parseInt(id), parseInt(year), parseInt(month));
    res.json({ success: true, data: salary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sales-staff/:id/salary-history - Lịch sử lương
router.get('/:id/salary-history', (req, res) => {
  try {
    const history = SalesStaffService.getSalaryHistory(req.params.id);
    res.json({ success: true, data: history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sales-staff/:id/commissions - Lịch sử hoa hồng
router.get('/:id/commissions', (req, res) => {
  try {
    const commissions = SalesStaffService.getCommissionHistory(req.params.id);
    res.json({ success: true, data: commissions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sales-staff/:id/breakdown/:year/:month - Chi tiết doanh số theo sản phẩm
router.get('/:id/breakdown/:year/:month', (req, res) => {
  try {
    const { id, year, month } = req.params;
    const breakdown = SalesStaffService.getSalesBreakdown(parseInt(id), parseInt(year), parseInt(month));
    res.json({ success: true, data: breakdown });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== STAFF SALARY CONFIG ROUTES ====================

// GET /api/sales-staff/:id/salary-config - Lấy cấu hình lương của nhân viên
router.get('/:id/salary-config', (req, res) => {
  try {
    const db = require('../../database');
    const configs = db.prepare(`
      SELECT * FROM staff_salary_config WHERE staff_id = ? ORDER BY product_type
    `).all(req.params.id);
    res.json({ success: true, data: configs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/sales-staff/:id/salary-config - Cập nhật cấu hình lương
router.put('/:id/salary-config', (req, res) => {
  try {
    const db = require('../../database');
    const { configs } = req.body; // [{productType, salaryPerLiter}]
    
    if (!configs || !Array.isArray(configs)) {
      return res.status(400).json({ success: false, error: 'Dữ liệu không hợp lệ' });
    }
    
    const updateOrInsert = db.transaction(() => {
      configs.forEach(cfg => {
        const existing = db.prepare('SELECT id FROM staff_salary_config WHERE staff_id = ? AND product_type = ?')
          .get(req.params.id, cfg.productType);
        
        if (existing) {
          db.prepare('UPDATE staff_salary_config SET salary_per_liter = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(cfg.salaryPerLiter, existing.id);
        } else {
          db.prepare('INSERT INTO staff_salary_config (staff_id, product_type, salary_per_liter) VALUES (?, ?, ?)')
            .run(req.params.id, cfg.productType, cfg.salaryPerLiter);
        }
      });
    });
    
    updateOrInsert();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
