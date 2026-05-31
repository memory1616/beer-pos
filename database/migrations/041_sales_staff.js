// Migration: Sales Staff & Commission System
// Quản lý nhân viên sales và tính hoa hồng/lương

const migration = {
  id: 41,
  name: 'sales_staff_commission',
  up: (db) => {
    // Bảng nhân viên sales
    db.exec(`
      CREATE TABLE IF NOT EXISTS sales_staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Bảng theo dõi gán khách hàng cho sales (ai mở cửa hàng nào)
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_sales_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        sales_id INTEGER NOT NULL,
        assigned_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        FOREIGN KEY (sales_id) REFERENCES sales_staff(id) ON DELETE CASCADE
      )
    `);

    // Bảng cấu hình hoa hồng theo sản phẩm
    db.exec(`
      CREATE TABLE IF NOT EXISTS sales_product_commission (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        product_type TEXT,  -- 'keg' | 'bottle' | 'all'
        salary_per_liter REAL DEFAULT 1000,
        active INTEGER DEFAULT 1,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
      )
    `);

    // Bảng cấu hình hoa hồng mở cửa hàng (mặc định 500.000đ)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sales_commission_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        new_shop_commission REAL DEFAULT 500000,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Bảng hoa hồng mở cửa hàng (theo dõi đã trả chưa)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sales_commissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sales_id INTEGER NOT NULL,
        customer_id INTEGER NOT NULL,
        sale_id INTEGER,
        type TEXT DEFAULT 'new_shop',  -- new_shop | volume_bonus
        amount REAL NOT NULL,
        status TEXT DEFAULT 'pending',  -- pending | paid
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        paid_at TEXT,
        note TEXT,
        FOREIGN KEY (sales_id) REFERENCES sales_staff(id) ON DELETE CASCADE,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL
      )
    `);

    // Bảng lương tháng của sales
    db.exec(`
      CREATE TABLE IF NOT EXISTS sales_monthly_salary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sales_id INTEGER NOT NULL,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        total_liters REAL DEFAULT 0,
        salary_per_liter REAL DEFAULT 1000,
        salary_amount REAL DEFAULT 0,
        commission_amount REAL DEFAULT 0,
        total_amount REAL DEFAULT 0,
        status TEXT DEFAULT 'pending',  -- pending | paid
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        paid_at TEXT,
        FOREIGN KEY (sales_id) REFERENCES sales_staff(id) ON DELETE CASCADE,
        UNIQUE(sales_id, year, month)
      )
    `);

    // Khởi tạo config mặc định
    db.exec(`INSERT OR IGNORE INTO sales_commission_config (id, new_shop_commission) VALUES (1, 500000)`);

    // Khởi tạo commission mặc định cho tất cả sản phẩm (chỉ khi bảng trống)
    const commissionCount = db.prepare('SELECT COUNT(*) as c FROM sales_product_commission').get();
    if (commissionCount.c === 0) {
      db.prepare(`INSERT INTO sales_product_commission (product_type, salary_per_liter) VALUES ('all', 1000)`).run();
    }

    // Indexes
    db.exec(`CREATE INDEX IF NOT EXISTS idx_customer_sales ON customer_sales_assignments(customer_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_assignments ON customer_sales_assignments(sales_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commissions_sales ON sales_commissions(sales_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_salary_sales ON sales_monthly_salary(sales_id)`);

    return { success: true };
  },
  down: (db) => {
    db.exec(`DROP TABLE IF EXISTS sales_monthly_salary`);
    db.exec(`DROP TABLE IF EXISTS sales_commissions`);
    db.exec(`DROP TABLE IF EXISTS sales_commission_config`);
    db.exec(`DROP TABLE IF EXISTS sales_product_commission`);
    db.exec(`DROP TABLE IF EXISTS customer_sales_assignments`);
    db.exec(`DROP TABLE IF EXISTS sales_staff`);
    return { success: true };
  }
};

module.exports = migration;
