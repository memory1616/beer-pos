// Sales Staff Commission Service
// Xử lý tính lương và hoa hồng cho nhân viên sales

const db = require('../../database');
let logger;
try {
  logger = require('../../src/utils/logger');
} catch (e) {
  logger = { info: console.log, error: console.error };
}

const SalesStaffService = {
  // Lấy danh sách nhân viên sales
  getAll() {
    return db.prepare(`
      SELECT ss.*,
        (SELECT COUNT(*) FROM customer_sales_assignments csa WHERE csa.sales_id = ss.id) as total_customers,
        (SELECT COALESCE(SUM(spc.salary_per_liter * si.quantity), 0)
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
         JOIN customer_sales_assignments csa ON csa.customer_id = s.customer_id
         JOIN products p ON p.id = si.product_id
         LEFT JOIN sales_product_commission spc ON (spc.product_id = p.id OR spc.product_type = 'all')
         WHERE csa.sales_id = ss.id
           AND s.type = 'sale'
           AND s.archived = 0
           AND strftime('%Y', s.date) = strftime('%Y', 'now')
           AND strftime('%m', s.date) = strftime('%m', 'now')
           AND si.price > 0
           AND spc.active = 1
        ) as this_month_sales
      FROM sales_staff ss
      WHERE ss.active = 1
      ORDER BY ss.name
    `).all();
  },

  // Lấy 1 nhân viên
  getById(id) {
    return db.prepare('SELECT * FROM sales_staff WHERE id = ?').get(id);
  },

  // Tạo nhân viên mới
  create(data) {
    const result = db.prepare(`
      INSERT INTO sales_staff (name, phone, email)
      VALUES (?, ?, ?)
    `).run(data.name, data.phone || null, data.email || null);
    return { id: result.lastInsertRowid, ...data };
  },

  // Cập nhật nhân viên
  update(id, data) {
    db.prepare(`
      UPDATE sales_staff SET name = ?, phone = ?, email = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(data.name, data.phone || null, data.email || null, id);
    return this.getById(id);
  },

  // Xóa nhân viên (soft delete)
  delete(id) {
    db.prepare('UPDATE sales_staff SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    return { success: true };
  },

  // Gán khách hàng cho sales (ai mở cửa hàng)
  assignCustomer(customerId, salesId) {
    // Kiểm tra đã gán chưa
    const existing = db.prepare('SELECT * FROM customer_sales_assignments WHERE customer_id = ?').get(customerId);
    
    if (existing) {
      // Cập nhật sales mới
      db.prepare('UPDATE customer_sales_assignments SET sales_id = ?, assigned_at = CURRENT_TIMESTAMP WHERE customer_id = ?')
        .run(salesId, customerId);
    } else {
      // Tạo mới
      db.prepare('INSERT INTO customer_sales_assignments (customer_id, sales_id) VALUES (?, ?)')
        .run(customerId, salesId);
      
      // Tạo hoa hồng mở cửa hàng (500.000đ)
      this.createNewShopCommission(customerId, salesId);
    }
    return { success: true };
  },

  // Tạo hoa hồng mở cửa hàng
  createNewShopCommission(customerId, salesId) {
    const config = db.prepare('SELECT * FROM sales_commission_config WHERE id = 1').get();
    const amount = config ? config.new_shop_commission : 500000;

    db.prepare(`
      INSERT INTO sales_commissions (sales_id, customer_id, type, amount, status)
      VALUES (?, ?, 'new_shop', ?, 'pending')
    `).run(salesId, customerId, amount);

    logger.info(`[SalesStaff] New shop commission created: sales=${salesId}, customer=${customerId}, amount=${amount}`);
  },

  // Lấy khách hàng của sales
  getAssignedCustomers(salesId) {
    return db.prepare(`
      SELECT c.*, csa.assigned_at
      FROM customers c
      JOIN customer_sales_assignments csa ON csa.customer_id = c.id
      WHERE csa.sales_id = ?
      ORDER BY c.name
    `).all(salesId);
  },

  // Lấy sales của khách hàng
  getSalesForCustomer(customerId) {
    return db.prepare(`
      SELECT ss.*, csa.assigned_at
      FROM sales_staff ss
      JOIN customer_sales_assignments csa ON csa.sales_id = ss.id
      WHERE csa.customer_id = ?
    `).get(customerId);
  },

  // Lấy cấu hình hoa hồng
  getCommissionConfig() {
    const config = db.prepare('SELECT * FROM sales_commission_config WHERE id = 1').get();
    return config || { id: 1, new_shop_commission: 500000 };
  },

  // Cập nhật cấu hình hoa hồng mở cửa hàng
  updateCommissionConfig(newShopCommission) {
    // Đảm bảo bảng có dữ liệu
    db.exec(`INSERT OR IGNORE INTO sales_commission_config (id, new_shop_commission) VALUES (1, ${newShopCommission})`);
    db.prepare(`
      UPDATE sales_commission_config SET new_shop_commission = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1
    `).run(newShopCommission);
    return this.getCommissionConfig();
  },

  // Lấy cấu hình hoa hồng theo sản phẩm
  getProductCommissions() {
    try {
      return db.prepare(`
        SELECT spc.id, spc.product_id, spc.product_type, spc.salary_per_liter, spc.active, spc.updated_at,
               p.name as product_name
        FROM sales_product_commission spc
        LEFT JOIN products p ON p.id = spc.product_id
        WHERE spc.active = 1
        ORDER BY spc.product_type, p.name
      `).all();
    } catch (e) {
      return [];
    }
  },

  // Cập nhật hoa hồng theo sản phẩm
  updateProductCommission(id, salaryPerLiter) {
    db.prepare(`
      UPDATE sales_product_commission SET salary_per_liter = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(salaryPerLiter, id);
    return { success: true };
  },

  // Thêm cấu hình hoa hồng cho sản phẩm cụ thể
  addProductCommission(productId, salaryPerLiter, productType = 'all') {
    let existing;
    if (productId) {
      existing = db.prepare(`
        SELECT id FROM sales_product_commission WHERE product_id = ?
      `).get(productId);
    } else {
      existing = db.prepare(`
        SELECT id FROM sales_product_commission
        WHERE product_id IS NULL AND product_type = ?
      `).get(productType);
    }

    if (existing) {
      // Cập nhật nếu đã tồn tại
      db.prepare(`
        UPDATE sales_product_commission SET salary_per_liter = ?, active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(salaryPerLiter, existing.id);
      return { id: existing.id, updated: true };
    }
    
    const result = db.prepare(`
      INSERT INTO sales_product_commission (product_id, product_type, salary_per_liter, active)
      VALUES (?, ?, ?, 1)
    `).run(productId || null, productType, salaryPerLiter);
    return { id: result.lastInsertRowid };
  },

  // Xóa cấu hình hoa hồng theo sản phẩm
  deleteProductCommission(id) {
    db.prepare('DELETE FROM sales_product_commission WHERE id = ?').run(id);
    return { success: true };
  },

  // Tính lương tháng cho 1 sales
  calculateMonthlySalary(salesId, year, month) {
    const yearStr = String(year);
    const monthStr = String(month).padStart(2, '0');

    // Lấy trạng thái đã trả
    const paidRecord = db.prepare(`
      SELECT status, paid_at FROM sales_monthly_salary
      WHERE sales_id = ? AND year = ? AND month = ?
    `).get(salesId, yearStr, monthStr);
    const isPaid = paidRecord && paidRecord.status === 'paid';

    // Lấy tất cả đơn hàng của khách được gán cho sales này trong tháng
    // JOIN ưu tiên: product_id cụ thể > product_type > all
    const salesData = db.prepare(`
      SELECT
        si.quantity,
        si.price,
        p.type as product_type,
        p.id as product_id,
        COALESCE(
          (SELECT spc.salary_per_liter FROM sales_product_commission spc 
           WHERE spc.product_id = p.id AND spc.active = 1 LIMIT 1),
          (SELECT spc.salary_per_liter FROM sales_product_commission spc 
           WHERE spc.product_type = p.type AND spc.product_id IS NULL AND spc.active = 1 LIMIT 1),
          1000
        ) as salary_per_liter
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
      JOIN customer_sales_assignments csa ON csa.customer_id = s.customer_id
      WHERE csa.sales_id = ?
        AND s.type = 'sale'
        AND s.archived = 0
        AND strftime('%Y', s.date) = ?
        AND strftime('%m', s.date) = ?
        AND si.price > 0
    `).all(salesId, yearStr, monthStr);

    // Tính tổng lít và lương
    let totalLiters = 0;
    let totalSalary = 0;
    const byProductType = {};

    for (const row of salesData) {
      totalLiters += row.quantity;
      const salary = row.quantity * row.salary_per_liter;
      totalSalary += salary;

      const key = row.product_type || 'other';
      if (!byProductType[key]) {
        byProductType[key] = { liters: 0, salary: 0 };
      }
      byProductType[key].liters += row.quantity;
      byProductType[key].salary += salary;
    }

    // Tính hoa hồng mở cửa hàng
    // Chỉ tính khi tháng gán sale = tháng tạo khách hàng
    const newShopCommission = db.prepare('SELECT new_shop_commission FROM sales_commission_config WHERE id = 1').get();
    const commissionRate = newShopCommission ? newShopCommission.new_shop_commission : 500000;
    
    // Đếm khách hàng được gán trong tháng này mà tháng tạo = tháng gán
    const newCustomerCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM customer_sales_assignments csa
      JOIN customers c ON c.id = csa.customer_id
      WHERE csa.sales_id = ?
        AND strftime('%Y', csa.assigned_at) = ?
        AND strftime('%m', csa.assigned_at) = ?
        AND strftime('%Y-%m', c.created_at) = strftime('%Y-%m', csa.assigned_at)
    `).get(salesId, yearStr, monthStr);
    
    const commissionAmount = (newCustomerCount ? newCustomerCount.count : 0) * commissionRate;

    return {
      salesId,
      year,
      month,
      totalLiters: Math.round(totalLiters * 100) / 100,
      totalSalary: Math.round(totalSalary),
      commissionAmount: Math.round(commissionAmount),
      totalAmount: Math.round(totalSalary + commissionAmount),
      newCustomersCount: newCustomerCount ? newCustomerCount.count : 0,
      commissionRate: commissionRate,
      isPaid: isPaid || false,
      paidAt: paidRecord && paidRecord.paid_at || null,
      byProductType
    };
  },

  // Tính lương tất cả sales trong tháng
  calculateAllMonthlySalaries(year, month) {
    const staff = this.getAll();
    const results = [];
    
    for (const s of staff) {
      const salary = this.calculateMonthlySalary(s.id, year, month);
      results.push({
        ...s,
        ...salary
      });
    }
    
    return results;
  },

  // Lưu kết quả tính lương vào database
  saveMonthlySalary(salesId, year, month) {
    const calc = this.calculateMonthlySalary(salesId, year, month);
    
    const existing = db.prepare(`
      SELECT id FROM sales_monthly_salary WHERE sales_id = ? AND year = ? AND month = ?
    `).get(salesId, year, month);

    if (existing) {
      db.prepare(`
        UPDATE sales_monthly_salary SET
          total_liters = ?,
          salary_amount = ?,
          commission_amount = ?,
          total_amount = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(calc.totalLiters, calc.totalSalary, calc.commissionAmount, calc.totalAmount, existing.id);
    } else {
      db.prepare(`
        INSERT INTO sales_monthly_salary (sales_id, year, month, total_liters, salary_amount, commission_amount, total_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(salesId, year, month, calc.totalLiters, calc.totalSalary, calc.commissionAmount, calc.totalAmount);
    }

    return calc;
  },

  // Lấy lịch sử lương của 1 sales
  getSalaryHistory(salesId) {
    return db.prepare(`
      SELECT * FROM sales_monthly_salary
      WHERE sales_id = ?
      ORDER BY year DESC, month DESC
    `).all(salesId);
  },

  // Lấy lịch sử hoa hồng
  getCommissionHistory(salesId) {
    return db.prepare(`
      SELECT sc.*, c.name as customer_name
      FROM sales_commissions sc
      LEFT JOIN customers c ON c.id = sc.customer_id
      WHERE sc.sales_id = ?
      ORDER BY sc.created_at DESC
    `).all(salesId);
  },

  // Đánh dấu hoa hồng đã trả
  markCommissionPaid(commissionId) {
    db.prepare(`
      UPDATE sales_commissions SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(commissionId);
    return { success: true };
  },

  // Đánh dấu lương tháng đã trả
  markSalaryPaid(salesId, year, month) {
    db.prepare(`
      UPDATE sales_monthly_salary SET status = 'paid', paid_at = CURRENT_TIMESTAMP
      WHERE sales_id = ? AND year = ? AND month = ?
    `).run(salesId, year, month);
    return { success: true };
  },

  // Lấy tổng hợp doanh số theo sản phẩm cho 1 sales
  getSalesBreakdown(salesId, year, month) {
    const yearStr = String(year);
    const monthStr = String(month).padStart(2, '0');

    return db.prepare(`
      SELECT
        p.name as product_name,
        p.type as product_type,
        SUM(si.quantity) as total_liters,
        SUM(si.quantity * spc.salary_per_liter) as total_salary
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
      JOIN customer_sales_assignments csa ON csa.customer_id = s.customer_id
      LEFT JOIN sales_product_commission spc ON (spc.product_id = p.id OR spc.product_type = 'all')
      WHERE csa.sales_id = ?
        AND s.type = 'sale'
        AND s.archived = 0
        AND strftime('%Y', s.date) = ?
        AND strftime('%m', s.date) = ?
        AND si.price > 0
        AND spc.active = 1
      GROUP BY p.id
      ORDER BY total_liters DESC
    `).all(salesId, yearStr, monthStr);
  }
};

module.exports = SalesStaffService;
