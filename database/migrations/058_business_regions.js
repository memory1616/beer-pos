/**
 * Migration: Khu vực kinh doanh & phân công tài xế (058)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Doanh nghiệp hiện có 1 tài xế, mục tiêu dài hạn là MỖI TÀI XẾ PHỤ TRÁCH
 *  1 KHU VỰC (thực tế có thể nhiều khu vực). Cần gắn "khu vực" vào từng khách
 *  hàng để phân tuyến giao hàng.
 *
 *  QUAN TRỌNG: 9 khu vực là MÃ VÙNG KINH DOANH NỘI BỘ theo địa bàn CŨ
 *  (TP. Tây Ninh, Hòa Thành, Tân Biên, Tân Châu, Bến Cầu, Châu Thành, Gò Dầu,
 *  Trảng Bàng, Dương Minh Châu) — KHÔNG phải đơn vị hành chính hiện hành.
 *
 * Thiết kế (ADDITIVE — KHÔNG sửa/xoá dữ liệu khách hàng cũ):
 *  1. `business_regions` — danh mục 9 khu vực (id, name, code, active).
 *  2. `customers.region_id` — NULL cho khách cũ (xử lý an toàn).
 *  3. `region_driver_assignments` — tài xế phụ trách khu vực.
 *       * UNIQUE PARTIAL: mỗi khu vực chỉ có 1 tài xế chính đang hoạt động.
 *       * Một tài xế được gán NHIỀU khu vực.
 *  4. `region_assignment_history` — nhật ký mọi thay đổi phân công.
 *  5. `sales.region_id / region_name / region_driver_username` — SNAPSHOT tại
 *     thời điểm tạo đơn → đổi phân công sau này KHÔNG sửa lịch sử đơn cũ.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS + PRAGMA check trước khi ALTER.
 * Rollback an toàn: chỉ gỡ bảng/cột MỚI, không đụng dữ liệu kinh doanh.
 */

const { DEFAULT_BUSINESS_REGIONS } = require('../../src/constants/businessRegions');

const migration = {
  id: 58,
  name: 'business_regions',

  up: (db) => {
    const hasColumn = (table, col) => {
      try {
        return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
      } catch (_) {
        return false;
      }
    };
    const hasTable = (table) => {
      try {
        return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      } catch (_) {
        return false;
      }
    };

    // ── 1. Danh mục khu vực ────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS business_regions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        code TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed 9 khu vực — INSERT OR IGNORE theo `code` (idempotent).
    const insertRegion = db.prepare(
      `INSERT OR IGNORE INTO business_regions (name, code, active, sort_order)
       VALUES (?, ?, 1, ?)`
    );
    for (const r of DEFAULT_BUSINESS_REGIONS) {
      insertRegion.run(r.name, r.code, r.order);
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_business_regions_active ON business_regions(active, sort_order)`);

    // ── 2. customers.region_id (NULL cho khách cũ) ─────────────────────────
    if (hasTable('customers') && !hasColumn('customers', 'region_id')) {
      db.exec('ALTER TABLE customers ADD COLUMN region_id INTEGER');
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_customers_region ON customers(region_id)`);

    // ── 3. Phân công tài xế cho khu vực ────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS region_driver_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        region_id INTEGER NOT NULL,
        driver_username TEXT NOT NULL,
        driver_id INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        assigned_at TEXT DEFAULT CURRENT_TIMESTAMP,
        assigned_by TEXT,
        unassigned_at TEXT,
        note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (region_id) REFERENCES business_regions(id) ON DELETE CASCADE
      )
    `);

    // Mỗi khu vực chỉ 1 tài xế chính đang hoạt động (partial unique index).
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_region_assign_active_unique
      ON region_driver_assignments(region_id) WHERE active = 1
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_region_assign_driver ON region_driver_assignments(driver_username, active)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_region_assign_region ON region_driver_assignments(region_id, active)`);

    // ── 4. Lịch sử phân công ───────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS region_assignment_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        region_id INTEGER NOT NULL,
        region_name TEXT,
        action TEXT NOT NULL,
        previous_driver_username TEXT,
        new_driver_username TEXT,
        note TEXT,
        actor_username TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (region_id) REFERENCES business_regions(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_region_history_region ON region_assignment_history(region_id, created_at DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_region_history_created ON region_assignment_history(created_at DESC)`);

    // ── 5. Snapshot khu vực + tài xế trên đơn hàng ─────────────────────────
    if (hasTable('sales')) {
      if (!hasColumn('sales', 'region_id')) {
        db.exec('ALTER TABLE sales ADD COLUMN region_id INTEGER');
      }
      if (!hasColumn('sales', 'region_name')) {
        db.exec("ALTER TABLE sales ADD COLUMN region_name TEXT");
      }
      if (!hasColumn('sales', 'region_driver_username')) {
        db.exec('ALTER TABLE sales ADD COLUMN region_driver_username TEXT');
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_region ON sales(region_id)`);
    }
  },

  down: (db) => {
    const tryExec = (sql) => {
      try { db.exec(sql); } catch (_) { /* ignore */ }
    };
    tryExec('DROP INDEX IF EXISTS idx_sales_region');
    tryExec('DROP INDEX IF EXISTS idx_region_history_created');
    tryExec('DROP INDEX IF EXISTS idx_region_history_region');
    tryExec('DROP INDEX IF EXISTS idx_region_assign_region');
    tryExec('DROP INDEX IF EXISTS idx_region_assign_driver');
    tryExec('DROP INDEX IF EXISTS idx_region_assign_active_unique');
    tryExec('DROP TABLE IF EXISTS region_assignment_history');
    tryExec('DROP TABLE IF EXISTS region_driver_assignments');
    tryExec('DROP INDEX IF EXISTS idx_customers_region');
    tryExec('DROP INDEX IF EXISTS idx_business_regions_active');
    tryExec('DROP TABLE IF EXISTS business_regions');
    // Cột mới trên sales/customers: DROP COLUMN (SQLite >= 3.35), bỏ qua nếu
    // phiên bản cũ không hỗ trợ (không được phép vỡ dữ liệu cũ).
    tryExec('ALTER TABLE sales DROP COLUMN region_driver_username');
    tryExec('ALTER TABLE sales DROP COLUMN region_name');
    tryExec('ALTER TABLE sales DROP COLUMN region_id');
    tryExec('ALTER TABLE customers DROP COLUMN region_id');
  },
};

module.exports = migration;
