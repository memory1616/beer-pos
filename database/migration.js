/**
 * BeerPOS - Database Migration System
 * ─────────────────────────────────────────────────────────────────────────────
 * Quản lý tất cả schema migrations với:
 * - Version tracking
 * - Idempotent migrations (chạy lại nhiều lần không lỗi)
 * - Rollback support (optional)
 * - Migration history
 * ─────────────────────────────────────────────────────────────────────────────
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ── Constants ──────────────────────────────────────────────────────────────────

const MIGRATION_VERSION = 2026041001;
const SCHEMA_VERSION_KEY = 'schema_version';

// Các bảng cần thêm metadata
const META_TABLES = [
  'customers',
  'products',
  'sales',
  'sale_items',
  'purchases',
  'purchase_items',
  'expenses',
  'payments',
  'devices',
  'prices',
  'keg_transactions_log'
];

// ── Helper Functions ─────────────────────────────────────────────────────────

function log(message, data = null) {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] [MIGRATION] ${message}`, data);
  } else {
    console.log(`[${timestamp}] [MIGRATION] ${message}`);
  }
}

function getCurrentVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM sync_meta WHERE key = ?").get(SCHEMA_VERSION_KEY);
    return row ? parseInt(row.value) : 0;
  } catch (e) {
    return 0;
  }
}

function setVersion(db, version) {
  db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)").run(SCHEMA_VERSION_KEY, version);
}

// ── Migration: Add Metadata Columns ─────────────────────────────────────────

function migrateAddMetadata(db) {
  log('Bắt đầu migration: Thêm metadata columns');

  const migrations = [
    // id (UUID) - cho các bảng chính
    { table: 'customers',      col: 'uuid',          type: 'TEXT',     default: null },
    { table: 'products',       col: 'uuid',          type: 'TEXT',     default: null },
    { table: 'sales',          col: 'uuid',          type: 'TEXT',     default: null },
    { table: 'expenses',       col: 'uuid',          type: 'TEXT',     default: null },
    { table: 'purchases',      col: 'uuid',          type: 'TEXT',     default: null },
    { table: 'payments',       col: 'uuid',          type: 'TEXT',     default: null },
    { table: 'devices',        col: 'uuid',          type: 'TEXT',     default: null },

    // created_at, updated_at, version, deleted
    { table: 'customers',      col: 'created_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'customers',      col: 'updated_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'customers',      col: 'version',       type: 'INTEGER',  default: '1' },
    { table: 'customers',      col: 'deleted',       type: 'INTEGER',  default: '0' },

    { table: 'products',       col: 'created_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'products',       col: 'updated_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'products',       col: 'version',       type: 'INTEGER',  default: '1' },
    { table: 'products',       col: 'deleted',       type: 'INTEGER',  default: '0' },

    { table: 'sales',          col: 'created_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'sales',          col: 'updated_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'sales',          col: 'version',       type: 'INTEGER',  default: '1' },
    { table: 'sales',          col: 'deleted',       type: 'INTEGER',  default: '0' },

    { table: 'expenses',       col: 'created_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'expenses',       col: 'updated_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'expenses',       col: 'version',       type: 'INTEGER',  default: '1' },
    { table: 'expenses',       col: 'deleted',       type: 'INTEGER',  default: '0' },

    { table: 'purchases',      col: 'created_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'purchases',      col: 'updated_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'purchases',      col: 'version',       type: 'INTEGER',  default: '1' },
    { table: 'purchases',      col: 'deleted',       type: 'INTEGER',  default: '0' },

    { table: 'payments',       col: 'created_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'payments',       col: 'updated_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'payments',       col: 'version',       type: 'INTEGER',  default: '1' },
    { table: 'payments',       col: 'deleted',       type: 'INTEGER',  default: '0' },

    { table: 'devices',        col: 'created_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'devices',        col: 'updated_at',    type: 'TEXT',     default: "CURRENT_TIMESTAMP" },
    { table: 'devices',        col: 'version',       type: 'INTEGER',  default: '1' },
    { table: 'devices',        col: 'deleted',       type: 'INTEGER',  default: '0' },
  ];

  let added = 0;
  for (const m of migrations) {
    try {
      // Check if column exists
      const cols = db.prepare(`PRAGMA table_info(${m.table})`).all();
      const exists = cols.some(c => c.name === m.col);

      if (!exists) {
        const defaultStr = m.default === "CURRENT_TIMESTAMP"
          ? "DEFAULT CURRENT_TIMESTAMP"
          : `DEFAULT ${m.default}`;
        db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.col} ${m.type} ${defaultStr}`);
        added++;
        log(`  Added ${m.table}.${m.col}`);
      }
    } catch (e) {
      // Column might already exist or other error - continue
      if (!e.message.includes('duplicate column')) {
        log(`  Warning: ${m.table}.${m.col}: ${e.message}`);
      }
    }
  }

  log(`Hoàn thành migration metadata: đã thêm ${added} columns`);
  return added;
}

// ── Migration: Create Action Logs Table ──────────────────────────────────────

function migrateCreateActionLogs(db) {
  log('Bắt đầu migration: Tạo bảng action_logs');

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT,
        entity_uuid TEXT,
        actor_id TEXT,
        actor_name TEXT,
        payload TEXT,
        previous_state TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        synced INTEGER DEFAULT 0,
        synced_at TEXT
      )
    `);

    // Indexes
    db.exec(`CREATE INDEX IF NOT EXISTS idx_action_logs_entity ON action_logs(entity, entity_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_action_logs_action ON action_logs(action)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_action_logs_created ON action_logs(created_at DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_action_logs_uuid ON action_logs(uuid)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_action_logs_synced ON action_logs(synced)`);

    log('Hoàn thành: Đã tạo bảng action_logs');
    return true;
  } catch (e) {
    log(`Lỗi tạo action_logs: ${e.message}`);
    return false;
  }
}

// ── Migration: Create Sync Queue Table (Enhanced) ─────────────────────────────

function migrateCreateSyncQueue(db) {
  log('Bắt đầu migration: Tạo bảng sync_queue (enhanced)');

  try {
    // Drop old sync_queue if exists (recreate with new schema)
    db.exec(`DROP TABLE IF EXISTS sync_queue`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT,
        entity_uuid TEXT,
        action TEXT NOT NULL,
        payload TEXT,
        priority INTEGER DEFAULT 0,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 5,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_attempt TEXT,
        next_retry TEXT,
        synced_at TEXT,
        device_id TEXT,
        version INTEGER DEFAULT 1
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_queue_uuid ON sync_queue(uuid)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_queue_entity ON sync_queue(entity, entity_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_queue_priority ON sync_queue(priority DESC, created_at ASC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_queue_next_retry ON sync_queue(next_retry)`);

    log('Hoàn thành: Đã tạo bảng sync_queue (enhanced)');
    return true;
  } catch (e) {
    log(`Lỗi tạo sync_queue: ${e.message}`);
    return false;
  }
}

// ── Migration: Create Devices Table ──────────────────────────────────────────

function migrateCreateDevicesTable(db) {
  log('Bắt đầu migration: Tạo bảng devices');

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('horizontal', 'vertical')),
        serial_number TEXT,
        status TEXT DEFAULT 'available' CHECK(status IN ('available', 'in_use', 'maintenance')),
        customer_id INTEGER,
        assigned_date TEXT,
        note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        version INTEGER DEFAULT 1,
        deleted INTEGER DEFAULT 0,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(type)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices(customer_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_uuid ON devices(uuid)`);

    log('Hoàn thành: Đã tạo bảng devices');
    return true;
  } catch (e) {
    log(`Lỗi tạo devices: ${e.message}`);
    return false;
  }
}

// ── Migration: Generate UUIDs for Existing Records ──────────────────────────

function migrateGenerateUUIDs(db) {
  log('Bắt đầu migration: Tạo UUIDs cho records hiện có');

  const tables = ['customers', 'products', 'sales', 'expenses', 'purchases', 'payments', 'devices'];

  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  let totalGenerated = 0;

  for (const table of tables) {
    try {
      // Get rows without UUID
      const rows = db.prepare(`SELECT id FROM ${table} WHERE uuid IS NULL OR uuid = ''`).all();

      if (rows.length > 0) {
        const updateStmt = db.prepare(`UPDATE ${table} SET uuid = ? WHERE id = ?`);

        for (const row of rows) {
          const uuid = generateUUID();
          updateStmt.run(uuid, row.id);
          totalGenerated++;
        }

        log(`  ${table}: Đã tạo ${rows.length} UUIDs`);
      }
    } catch (e) {
      log(`  Warning: ${table}: ${e.message}`);
    }
  }

  log(`Hoàn thành: Đã tạo ${totalGenerated} UUIDs`);
  return totalGenerated;
}

// ── Migration: Create Indexes for Performance ─────────────────────────────────

function migrateCreateIndexes(db) {
  log('Bắt đầu migration: Tạo indexes');

  const indexes = [
    // Customers
    { sql: `CREATE INDEX IF NOT EXISTS idx_customers_uuid ON customers(uuid)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_customers_deleted ON customers(deleted)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)` },

    // Products
    { sql: `CREATE INDEX IF NOT EXISTS idx_products_uuid ON products(uuid)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_products_deleted ON products(deleted)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_products_type ON products(type)` },

    // Sales
    { sql: `CREATE INDEX IF NOT EXISTS idx_sales_uuid ON sales(uuid)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sales_deleted ON sales(deleted)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sales_customer_date ON sales(customer_id, date DESC)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status)` },

    // Expenses
    { sql: `CREATE INDEX IF NOT EXISTS idx_expenses_uuid ON expenses(uuid)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_expenses_deleted ON expenses(deleted)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date DESC)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category)` },

    // Purchases
    { sql: `CREATE INDEX IF NOT EXISTS idx_purchases_uuid ON purchases(uuid)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_purchases_deleted ON purchases(deleted)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(date DESC)` },

    // Payments
    { sql: `CREATE INDEX IF NOT EXISTS idx_payments_uuid ON payments(uuid)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_payments_deleted ON payments(deleted)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id)` },

    // Sale Items
    { sql: `CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id)` },

    // Prices
    { sql: `CREATE INDEX IF NOT EXISTS idx_prices_customer_product ON prices(customer_id, product_id)` },
  ];

  let created = 0;
  for (const idx of indexes) {
    try {
      db.exec(idx.sql);
      created++;
    } catch (e) {
      if (!e.message.includes('already exists')) {
        log(`  Warning: ${e.message}`);
      }
    }
  }

  log(`Hoàn thành: Đã tạo ${created} indexes`);
  return created;
}

// ── Migration: Add Foreign Keys ───────────────────────────────────────────────

function migrateAddForeignKeys(db) {
  log('Bắt đầu migration: Thêm foreign keys');

  const foreignKeys = [
    // Sale Items
    {
      sql: `ALTER TABLE sale_items ADD CONSTRAINT fk_sale_items_sale FOREIGN KEY (sale_id) REFERENCES sales(id)`,
      exists: () => {
        const cols = db.prepare(`PRAGMA table_info(sale_items)`).all();
        return cols.some(c => c.name === 'sale_id');
      }
    },
    {
      sql: `ALTER TABLE sale_items ADD CONSTRAINT fk_sale_items_product FOREIGN KEY (product_id) REFERENCES products(id)`,
      exists: () => {
        const cols = db.prepare(`PRAGMA table_info(sale_items)`).all();
        return cols.some(c => c.name === 'product_id');
      }
    },

    // Payments
    {
      sql: `ALTER TABLE payments ADD CONSTRAINT fk_payments_customer FOREIGN KEY (customer_id) REFERENCES customers(id)`,
      exists: () => {
        const cols = db.prepare(`PRAGMA table_info(payments)`).all();
        return cols.some(c => c.name === 'customer_id');
      }
    },
  ];

  let added = 0;
  for (const fk of foreignKeys) {
    try {
      if (fk.exists()) {
        db.exec(fk.sql);
        added++;
      }
    } catch (e) {
      // Constraint might already exist or table doesn't support ALTER TABLE ADD CONSTRAINT
      if (!e.message.includes('duplicate') && !e.message.includes('no such table')) {
        log(`  Note: ${fk.sql.substring(0, 50)}...: ${e.message}`);
      }
    }
  }

  log(`Hoàn thành migration foreign keys`);
  return added;
}

// ── Main Migration Runner ─────────────────────────────────────────────────────

function runMigrations(db) {
  const currentVersion = getCurrentVersion(db);
  log(`Schema version hiện tại: ${currentVersion}`);
  log(`Target version: ${MIGRATION_VERSION}`);

  if (currentVersion >= MIGRATION_VERSION) {
    log('Database đã được migrate, bỏ qua.');
    return { success: true, skipped: true };
  }

  const startTime = Date.now();
  const results = {
    metadataColumns: 0,
    uuids: 0,
    indexes: 0,
    actionLogs: false,
    syncQueue: false,
    devices: false,
  };

  // Run migrations in order
  const migrationSteps = [
    { name: 'metadata', fn: () => migrateAddMetadata(db) },
    { name: 'uuids', fn: () => migrateGenerateUUIDs(db) },
    { name: 'actionLogs', fn: () => migrateCreateActionLogs(db) },
    { name: 'syncQueue', fn: () => migrateCreateSyncQueue(db) },
    { name: 'devices', fn: () => migrateCreateDevicesTable(db) },
    { name: 'indexes', fn: () => migrateCreateIndexes(db) },
    { name: 'foreignKeys', fn: () => migrateAddForeignKeys(db) },
  ];

  for (const step of migrationSteps) {
    try {
      log(`\n[${step.name.toUpperCase()}]`);
      const result = step.fn();

      if (typeof result === 'number') {
        results[step.name] = result;
      } else if (typeof result === 'boolean') {
        results[step.name] = result;
      }
    } catch (e) {
      log(`Lỗi trong migration [${step.name}]: ${e.message}`);
      throw e; // Stop migration on error
    }
  }

  // Update version
  setVersion(db, MIGRATION_VERSION);

  const elapsed = Date.now() - startTime;
  log(`\n✓ Migration hoàn thành trong ${elapsed}ms`);
  log(`  Schema version: ${currentVersion} → ${MIGRATION_VERSION}`);
  log(`  Kết quả:`, results);

  return {
    success: true,
    version: MIGRATION_VERSION,
    elapsed,
    results
  };
}

// ── Utility: Generate UUID ─────────────────────────────────────────────────────

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  MIGRATION_VERSION,
  runMigrations,
  generateUUID,
  getCurrentVersion,
  setVersion,
};
