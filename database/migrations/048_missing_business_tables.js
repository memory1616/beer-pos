/**
 * Migration: Missing Business Tables (048)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  `database/migrations/004_business_features.js` tạo các bảng nghiệp vụ
 *  (customer_segments, delivery_schedules, delivery_schedule_items,
 *   debt_transactions) + cột `customers.tier` / `customers.segment_id`.
 *  NHƯNG nó bị SKIP trên các DB đã có `business_features_version` cao hơn
 *  mà code gate (BUSINESS_FEATURES_VERSION = 2026041602) — tức là version
 *  của DB được set bởi con đường khác (migration.js ghi version kể cả khi
 *  004 bị skip), dẫn tới các bảng này KHÔNG tồn tại trong DB thật.
 *
 *  Hậu quả: các route đọc/ghi `customer_segments`, `delivery_schedules`,
 *  `debt_transactions` sẽ ném lỗi "no such table" (HTTP 500).
 *
 * Mục tiêu:
 *  1. Tạo idempotent các bảng còn thiếu (CREATE TABLE IF NOT EXISTS).
 *  2. Thêm cột `customers.tier` / `customers.segment_id` nếu thiếu
 *     (ALTER TABLE bọc try/catch → idempotent).
 *  3. Seed sẵn các phân khúc mặc định (INSERT OR IGNORE).
 *
 * ADDITIVE — KHÔNG sửa/xoá dữ liệu kinh doanh hiện có.
 * Rollback: chỉ gỡ các bảng/cột MỚI tạo ra (không đụng bảng đã có sẵn).
 */

const migration = {
  id: 48,
  name: 'missing_business_tables',

  up: (db) => {
    // ── 1. customer_segments ───────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        color TEXT DEFAULT '#3B82F6',
        icon TEXT DEFAULT '👥',
        rules TEXT,
        discount_percent REAL DEFAULT 0,
        priority_support INTEGER DEFAULT 0,
        free_delivery_threshold REAL DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_customer_segments_active ON customer_segments(active)`);

    // Seed các phân khúc mặc định (bỏ qua nếu đã tồn tại)
    const defaultSegments = [
      { name: 'Khách mới', code: 'new', color: '#10B981', icon: '🌱' },
      { name: 'Khách thường', code: 'regular', color: '#3B82F6', icon: '👤' },
      { name: 'Khách VIP', code: 'vip', color: '#F59E0B', icon: '⭐', discount: 5 },
      { name: 'Khách suy giảm', code: 'inactive', color: '#EF4444', icon: '📉' },
    ];
    const insertSeg = db.prepare(`
      INSERT OR IGNORE INTO customer_segments (name, code, color, icon, discount_percent)
      VALUES (?, ?, ?, ?, ?)
    `);
    defaultSegments.forEach((seg) => {
      insertSeg.run(seg.name, seg.code, seg.color, seg.icon, seg.discount || 0);
    });

    // ── 2. delivery_schedules + items ──────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        route TEXT,
        vehicle TEXT,
        status TEXT DEFAULT 'scheduled',
        total_orders INTEGER DEFAULT 0,
        total_revenue REAL DEFAULT 0,
        total_distance_km REAL DEFAULT 0,
        driver_name TEXT,
        driver_phone TEXT,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_date ON delivery_schedules(date)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery_schedules(status)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_schedule_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id INTEGER NOT NULL,
        sale_id INTEGER,
        customer_id INTEGER,
        sequence INTEGER DEFAULT 0,
        scheduled_time TEXT,
        actual_time TEXT,
        status TEXT DEFAULT 'pending',
        customer_name TEXT,
        customer_address TEXT,
        customer_phone TEXT,
        order_total REAL DEFAULT 0,
        keg_count INTEGER DEFAULT 0,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (schedule_id) REFERENCES delivery_schedules(id) ON DELETE CASCADE,
        FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_items_schedule ON delivery_schedule_items(schedule_id)`);

    // ── 3. debt_transactions ───────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS debt_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        balance_before REAL NOT NULL,
        balance_after REAL NOT NULL,
        sale_id INTEGER,
        payment_id INTEGER,
        note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL,
        FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_debt_tx_customer ON debt_transactions(customer_id, created_at DESC)`);

    // ── 4. Cột customers.tier / customers.segment_id ────────────────────────
    try {
      db.exec(`ALTER TABLE customers ADD COLUMN tier TEXT DEFAULT 'normal'`);
    } catch (e) {
      // Cột đã tồn tại → idempotent
    }

    try {
      db.exec(`ALTER TABLE customers ADD COLUMN segment_id INTEGER`);
    } catch (e) {
      // Cột đã tồn tại → idempotent
    }

    try {
      db.exec(
        `ALTER TABLE customers ADD FOREIGN KEY (segment_id) REFERENCES customer_segments(id) ON DELETE SET NULL`
      );
    } catch (e) {
      // FK đã tồn tại hoặc SQLite không hỗ trợ thêm FK qua ALTER
    }

    // ── 5. sync_dedup — idempotency sống qua restart server ────────────────
    // Client có thể push lại cùng batch sau khi server restart giữa chừng.
    // Bảng này ghi lại sync_id đã xử lý để chống ghi trùng dữ liệu.
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_dedup (
        sync_id TEXT PRIMARY KEY,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_dedup_created ON sync_dedup(created_at)`);
  },

  // Rollback: chỉ gỡ những gì migration này tạo ra.
  down: (db) => {
    db.exec(`DROP INDEX IF EXISTS idx_sync_dedup_created`);
    db.exec(`DROP TABLE IF EXISTS sync_dedup`);

    db.exec(`DROP INDEX IF EXISTS idx_debt_tx_customer`);
    db.exec(`DROP TABLE IF EXISTS debt_transactions`);

    db.exec(`DROP INDEX IF EXISTS idx_delivery_items_schedule`);
    db.exec(`DROP INDEX IF EXISTS idx_delivery_date`);
    db.exec(`DROP INDEX IF EXISTS idx_delivery_status`);
    db.exec(`DROP TABLE IF EXISTS delivery_schedule_items`);
    db.exec(`DROP TABLE IF EXISTS delivery_schedules`);

    db.exec(`DROP INDEX IF EXISTS idx_customer_segments_active`);
    db.exec(`DROP TABLE IF EXISTS customer_segments`);
  },
};

module.exports = migration;
