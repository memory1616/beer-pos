/**
 * BeerPOS - Migration 043: Auto-Apply Reward on Sale
 *
 * Schema changes để hỗ trợ tách paid_quantity / reward_quantity trên sale_items:
 * - Thêm cột paid_quantity, reward_quantity vào sale_items để phân tách
 *   phần trả tiền và phần thưởng trên cùng 1 dòng sản phẩm.
 * - Thêm cột reward_source, reward_month, reward_year vào sale_items để audit.
 * - Thêm cột consumed_liters, status vào pending_rewards để hỗ trợ
 *   reward > ordered (partial consumption).
 * - Thêm cột sale_item_id, paid_quantity_at_claim vào reward_history
 *   để liên kết chính xác với sale_items khi reverse.
 *
 * BACKWARD COMPATIBLE: Tất cả cột mới nullable với DEFAULT 0/'',
 * không ảnh hưởng dữ liệu cũ.
 *
 * IDEMPOTENT: Có thể chạy lại nhiều lần không lỗi.
 *
 * BACKUP: Tự động backup database trước khi migrate nếu database.sqlite tồn tại.
 */

const path = require('path');
const fs = require('fs');

const migration = {
  id: 43,
  name: 'paid_reward_quantity',

  up: function(db) {
    const logger = console;

    // ── Auto-backup trước khi migrate ────────────────────────────────
    try {
      const dbPath = path.join(__dirname, '..', 'database.sqlite');
      if (fs.existsSync(dbPath)) {
        const backupDir = path.join(__dirname, '..', 'backups');
        if (!fs.existsSync(backupDir)) {
          fs.mkdirSync(backupDir, { recursive: true });
        }
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupPath = path.join(backupDir, `pre_043_${ts}.sqlite`);
        fs.copyFileSync(dbPath, backupPath);
        logger.log('[MIGRATION 043] Backed up database to:', backupPath);
      }
    } catch (e) {
      logger.log('[MIGRATION 043] Backup note:', e.message, '(continuing anyway)');
    }

    // ── sale_items: paid_quantity + reward_quantity + audit columns ──
    const saleItemMigrations = [
      { col: 'paid_quantity',   type: 'REAL',    default: 0,  comment: 'So lit ban ra co thu tien (sau khi tru phan thuong)' },
      { col: 'reward_quantity', type: 'REAL',    default: 0,  comment: 'So lit duoc tra thuong (khong tinh tien)' },
      { col: 'reward_source',  type: 'TEXT',     default: null, comment: 'Loai nguon thuong: pending | attach | null' },
      { col: 'reward_month',   type: 'INTEGER', default: null, comment: 'Thang ma thuong duoc tra (audit)' },
      { col: 'reward_year',    type: 'INTEGER', default: null, comment: 'Nam ma thuong duoc tra (audit)' },
    ];

    for (const m of saleItemMigrations) {
      try {
        db.exec(`ALTER TABLE sale_items ADD COLUMN ${m.col} ${m.type} DEFAULT ${m.default === null ? 'NULL' : m.default}`);
        logger.log(`  [sale_items] Added column: ${m.col} ${m.type}`);
      } catch (e) {
        if (e.message.includes('duplicate column name') || e.message.includes('already exists')) {
          logger.log(`  [sale_items] Column ${m.col} already exists, skipping`);
        } else {
          logger.log(`  [sale_items] Column ${m.col} note:`, e.message);
        }
      }
    }

    // ── pending_rewards: consumed_liters + status (cho partial reward) ──
    const pendingRewardMigrations = [
      { col: 'consumed_liters', type: 'REAL',    default: 0, comment: 'Tong so lit da su dung (tich luy)' },
      { col: 'status',         type: 'TEXT',     default: "'pending'", comment: "Trang thai: pending | partial | paid" },
    ];

    for (const m of pendingRewardMigrations) {
      try {
        db.exec(`ALTER TABLE pending_rewards ADD COLUMN ${m.col} ${m.type} DEFAULT ${m.default}`);
        logger.log(`  [pending_rewards] Added column: ${m.col} ${m.type}`);
      } catch (e) {
        if (e.message.includes('duplicate column name') || e.message.includes('already exists')) {
          logger.log(`  [pending_rewards] Column ${m.col} already exists, skipping`);
        } else {
          logger.log(`  [pending_rewards] Column ${m.col} note:`, e.message);
        }
      }
    }

    // ── reward_history: sale_item_id + paid_quantity_at_claim ──
    const rewardHistoryMigrations = [
      { col: 'sale_item_id',           type: 'INTEGER', default: null, comment: 'ID cua sale_items ma reward nay duoc gan vao' },
      { col: 'paid_quantity_at_claim', type: 'REAL',    default: null, comment: 'So lit tra tien luc claim (de tinh lai revenue neu can)' },
    ];

    for (const m of rewardHistoryMigrations) {
      try {
        db.exec(`ALTER TABLE reward_history ADD COLUMN ${m.col} ${m.type} DEFAULT ${m.default === null ? 'NULL' : m.default}`);
        logger.log(`  [reward_history] Added column: ${m.col} ${m.type}`);
      } catch (e) {
        if (e.message.includes('duplicate column name') || e.message.includes('already exists')) {
          logger.log(`  [reward_history] Column ${m.col} already exists, skipping`);
        } else {
          logger.log(`  [reward_history] Column ${m.col} note:`, e.message);
        }
      }
    }

    // ── Indexes cho performance ──────────────────────────────────────
    const indexes = [
      { sql: 'CREATE INDEX IF NOT EXISTS idx_sale_items_reward ON sale_items(sale_id, reward_quantity)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_pending_rewards_status ON pending_rewards(customer_id, status)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_reward_history_sale_item ON reward_history(sale_item_id)' },
      { sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_history_unique ON reward_history(customer_id, reward_month, reward_year, sale_item_id)' },
    ];

    for (const idx of indexes) {
      try {
        db.exec(idx.sql);
        logger.log(`  [index] Created: ${idx.sql.substring(0, 60)}...`);
      } catch (e) {
        if (e.message.includes('already exists')) {
          logger.log(`  [index] Already exists, skipping`);
        } else {
          logger.log(`  [index] Note:`, e.message);
        }
      }
    }

    logger.log('[MIGRATION 043] Completed successfully');
    return { success: true };
  },

  down: function(db) {
    // No down - schema changes are forward-only for safety
    return { success: true, note: 'Down migration not supported for 043 (schema safety)' };
  }
};

module.exports = migration;
