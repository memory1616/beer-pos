/**
 * BeerPOS - Add Debt Tracking & Promotion Tables
 *
 * Migration file để thêm:
 * 1. Bảng promotions (khuyến mãi)
 * 2. Bảng customer_segments (phân khúc khách hàng)
 * 3. Bảng delivery_schedules (lịch giao hàng)
 * 4. Cột tier cho customers (VIP/Normal/New)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

const logger = console;

function runMigration() {
  logger.log('[MIGRATION] Running business features migration...');

  // ========== 1. PROMOTIONS TABLE ==========
  db.exec(`
    CREATE TABLE IF NOT EXISTS promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,

      -- Type: 'percentage', 'fixed', 'buy_x_get_y'
      type TEXT NOT NULL DEFAULT 'percentage',
      value REAL NOT NULL DEFAULT 0,

      -- Conditions
      min_order_value REAL DEFAULT 0,
      max_discount REAL DEFAULT 0,
      customer_tier TEXT DEFAULT 'all',  -- 'all', 'vip', 'normal'
      customer_segments TEXT,  -- JSON array of segment IDs

      -- Product-specific promotion
      product_id INTEGER,
      buy_quantity INTEGER DEFAULT 1,
      get_quantity INTEGER DEFAULT 1,

      -- Status & Timing
      active INTEGER DEFAULT 1,
      start_date TEXT,
      end_date TEXT,
      priority INTEGER DEFAULT 0,

      -- Metadata
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    )
  `);

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_promotions_active ON promotions(active)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_promotions_dates ON promotions(start_date, end_date)`);
  } catch (e) {
    logger.log('Promotion indexes note:', e.message);
  }

  // ========== 2. CUSTOMER SEGMENTS TABLE ==========
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      color TEXT DEFAULT '#3B82F6',
      icon TEXT DEFAULT '👥',

      -- Auto-assignment rules (JSON)
      rules TEXT,
      /*
      Rules format:
      {
        "min_orders": 10,
        "min_spent": 10000000,
        "max_spent": null,
        "last_order_days": 30
      }
      */

      -- Benefits
      discount_percent REAL DEFAULT 0,
      priority_support INTEGER DEFAULT 0,
      free_delivery_threshold REAL DEFAULT 0,

      -- Status
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default segments
  const defaultSegments = [
    { name: 'Khách mới', code: 'new', color: '#10B981', icon: '🌱', discount_percent: 0 },
    { name: 'Khách thường', code: 'regular', color: '#3B82F6', icon: '👤', discount_percent: 0 },
    { name: 'Khách VIP', code: 'vip', color: '#F59E0B', icon: '⭐', discount_percent: 5 },
    { name: 'Khách suy giảm', code: 'inactive', color: '#EF4444', icon: '📉', discount_percent: 0 }
  ];

  const insertSeg = db.prepare(`
    INSERT OR IGNORE INTO customer_segments (name, code, color, icon, discount_percent)
    VALUES (?, ?, ?, ?, ?)
  `);

  defaultSegments.forEach(seg => {
    insertSeg.run(seg.name, seg.code, seg.color, seg.icon, seg.discount_percent);
  });

  // ========== 3. DELIVERY SCHEDULES TABLE ==========
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      route TEXT,
      vehicle TEXT,

      -- Status: 'scheduled', 'in_progress', 'completed', 'cancelled'
      status TEXT DEFAULT 'scheduled',

      -- Summary
      total_orders INTEGER DEFAULT 0,
      total_revenue REAL DEFAULT 0,
      total_distance_km REAL DEFAULT 0,

      -- Driver info
      driver_name TEXT,
      driver_phone TEXT,
      notes TEXT,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Delivery schedule items (orders in a schedule)
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_schedule_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL,
      sale_id INTEGER,
      customer_id INTEGER,

      -- Sequence in route
      sequence INTEGER DEFAULT 0,

      -- Delivery info
      scheduled_time TEXT,
      actual_time TEXT,

      -- Status: 'pending', 'delivered', 'failed', 'skipped'
      status TEXT DEFAULT 'pending',

      -- Customer info snapshot
      customer_name TEXT,
      customer_address TEXT,
      customer_phone TEXT,

      -- Order summary
      order_total REAL DEFAULT 0,
      keg_count INTEGER DEFAULT 0,

      -- Delivery result
      notes TEXT,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (schedule_id) REFERENCES delivery_schedules(id) ON DELETE CASCADE,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
    )
  `);

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_date ON delivery_schedules(date)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery_schedules(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_items_schedule ON delivery_schedule_items(schedule_id)`);
  } catch (e) {
    logger.log('Delivery indexes note:', e.message);
  }

  // ========== 4. CUSTOMER TIER (VIP/Normal) ==========
  try {
    db.exec(`ALTER TABLE customers ADD COLUMN tier TEXT DEFAULT 'normal'`);  // 'normal', 'vip'
  } catch (e) {
    // Column exists
  }

  try {
    db.exec(`ALTER TABLE customers ADD COLUMN segment_id INTEGER`);
    db.exec(`ALTER TABLE customers ADD FOREIGN KEY (segment_id) REFERENCES customer_segments(id) ON DELETE SET NULL`);
  } catch (e) {
    // Column exists or FK issue
  }

  // ========== 5. DEBT TRANSACTIONS (audit trail) ==========
  // payments table đã có, nhưng thêm audit cho debt changes
  db.exec(`
    CREATE TABLE IF NOT EXISTS debt_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,

      -- Type: 'increase' (nợ thêm), 'decrease' (trả nợ), 'adjust' (điều chỉnh)
      type TEXT NOT NULL,

      -- Amount changed
      amount REAL NOT NULL,
      balance_before REAL NOT NULL,
      balance_after REAL NOT NULL,

      -- Reference
      sale_id INTEGER,
      payment_id INTEGER,

      -- Note
      note TEXT,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL,
      FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL
    )
  `);

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_debt_tx_customer ON debt_transactions(customer_id, created_at DESC)`);
  } catch (e) {
    // Index exists
  }

  // ========== 6. ORDER DEBT (chi tiết công nợ theo đơn) ==========
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_debts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,

      -- Debt amount
      original_amount REAL NOT NULL,
      paid_amount REAL DEFAULT 0,
      remaining_amount REAL NOT NULL,

      -- Status: 'pending', 'partial', 'paid', 'overdue'
      status TEXT DEFAULT 'pending',

      -- Due date (optional)
      due_date TEXT,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )
  `);

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_order_debt_customer ON order_debts(customer_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_order_debt_status ON order_debts(status)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_order_debt_sale ON order_debts(sale_id)`);
  } catch (e) {
    // Index exists
  }

  // ========== MIGRATE EXISTING DATA ==========
  migrateExistingData();

  logger.log('[MIGRATION] Business features migration completed!');
}

function migrateExistingData() {
  // Auto-assign customer tiers based on spending
  try {
    const customers = db.prepare(`
      SELECT c.id, c.tier,
        COALESCE((SELECT SUM(total) FROM sales WHERE customer_id = c.id AND type = 'sale'), 0) as total_spent,
        COALESCE((SELECT COUNT(*) FROM sales WHERE customer_id = c.id AND type = 'sale'), 0) as order_count
      FROM customers c
      WHERE c.tier IS NULL OR c.tier = ''
    `).all();

    const updateTier = db.prepare('UPDATE customers SET tier = ? WHERE id = ?');

    customers.forEach(c => {
      let newTier = 'normal';
      if (c.total_spent >= 50000000 || c.order_count >= 20) {
        newTier = 'vip';
      }
      updateTier.run(newTier, c.id);
    });

    if (customers.length > 0) {
      logger.log(`[MIGRATION] Assigned tiers to ${customers.length} customers`);
    }
  } catch (e) {
    logger.log('[MIGRATION] Tier assignment note:', e.message);
  }

  // Seed sample promotions
  try {
    const promoCount = db.prepare('SELECT COUNT(*) as c FROM promotions').get();
    if (promoCount.c === 0) {
      const samplePromos = [
        {
          name: 'Giảm 5% cho VIP',
          type: 'percentage',
          value: 5,
          customer_tier: 'vip',
          active: 1
        },
        {
          name: 'Giảm 10K cho đơn từ 500K',
          type: 'fixed',
          value: 10000,
          min_order_value: 500000,
          active: 1
        },
        {
          name: 'Khuyến mãi tháng 4',
          type: 'percentage',
          value: 3,
          min_order_value: 1000000,
          start_date: '2026-04-01',
          end_date: '2026-04-30',
          active: 1
        }
      ];

      const insertPromo = db.prepare(`
        INSERT INTO promotions (name, type, value, min_order_value, customer_tier, start_date, end_date, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      samplePromos.forEach(p => {
        insertPromo.run(p.name, p.type, p.value, p.min_order_value || null,
                        p.customer_tier || null, p.start_date || null, p.end_date || null, p.active);
      });

      logger.log('[MIGRATION] Seeded sample promotions');
    }
  } catch (e) {
    logger.log('[MIGRATION] Promotion seeding note:', e.message);
  }
}

// Run if called directly
if (require.main === module) {
  runMigration();
  db.close();
}

module.exports = { runMigration };
