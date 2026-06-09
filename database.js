const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const logger = console;

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Run database migrations
try {
  const { runMigrations, runBusinessFeaturesMigration } = require('./database/migration');
  const migrationResult = runMigrations(db);
  if (migrationResult.success && !migrationResult.skipped) {
    logger.log('[MIGRATION] Database migrations completed successfully');
  }

  // Run business features migration
  const bizResult = runBusinessFeaturesMigration(db);
  if (bizResult.success && !bizResult.skipped) {
    logger.log('[MIGRATION] Business features migration completed');
  }
} catch (error) {
  logger.error('[MIGRATION] Migration error:', error.message);
}

// Helper: get current Vietnam date string (YYYY-MM-DD) in Asia/Ho_Chi_Minh timezone
function getVietnamDateStr() {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return vn.getUTCFullYear() + '-' +
    String(vn.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(vn.getUTCDate()).padStart(2, '0');
}

// Export for use in other modules
module.exports = { db, getVietnamDateStr };

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Tổng bình keg trong kho: chỉ cộng tồn dương (hiển thị ô Kho — vỏ đang nắm giữ thực tế)
db.SQL_KEG_WAREHOUSE_POSITIVE_STOCK =
  "SELECT COALESCE(SUM(CASE WHEN stock > 0 THEN stock ELSE 0 END), 0) as total FROM products WHERE type = 'keg'";
// Tổng đại số SUM(stock) keg — có âm; dùng cho TỔNG VỎ BÌNH = raw + khách + rỗng
db.SQL_KEG_WAREHOUSE_RAW_STOCK =
  "SELECT COALESCE(SUM(stock), 0) as total FROM products WHERE type = 'keg'";

// ========== MIGRATION: Merge keg_log + keg_transactions → keg_transactions_log ==========
// Run before creating tables so CREATE TABLE IF NOT EXISTS is safe
try {
  const logCount = db.prepare('SELECT COUNT(*) as c FROM keg_log').get();
  const txCount  = db.prepare('SELECT COUNT(*) as c FROM keg_transactions').get();

  if ((logCount?.c || 0) > 0) {
    db.prepare(`
      INSERT INTO keg_transactions_log
        (type, quantity, exchanged, purchased, customer_id, customer_name,
         inventory_after, empty_after, holding_after, note, date)
      SELECT
        'adjust' as type,
        COALESCE(change, 0) as quantity,
        0, 0,
        customer_id, NULL,
        0, 0, 0,
        COALESCE(note, '') as note,
        COALESCE(date, CURRENT_TIMESTAMP) as date
      FROM keg_log
    `).run();
    logger.log('Migrated', logCount.c, 'rows from keg_log → keg_transactions_log');
  }

  if ((txCount?.c || 0) > 0) {
    db.prepare(`
      INSERT INTO keg_transactions_log
        (type, quantity, exchanged, purchased, customer_id, customer_name,
         inventory_after, empty_after, holding_after, note, date)
      SELECT
        CASE type
          WHEN 'delivery' THEN 'deliver'
          WHEN 'return'  THEN 'collect'
          ELSE type
        END as type,
        quantity,
        0, 0,
        customer_id, NULL,
        0, 0, 0,
        COALESCE(note, '') as note,
        COALESCE(date, CURRENT_TIMESTAMP) as date
      FROM keg_transactions
    `).run();
    logger.log('Migrated', txCount.c, 'rows from keg_transactions → keg_transactions_log');
  }

  // Safe to drop old tables (data already migrated)
  db.exec('DROP TABLE IF EXISTS keg_log');
  db.exec('DROP TABLE IF EXISTS keg_transactions');
  logger.log('Dropped legacy keg tables (keg_log, keg_transactions)');
} catch (e) {
  logger.log('Keg migration note:', e.message);
}

// ========== PERFORMANCE PRAGMAS ==========
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');
db.pragma('temp_store = MEMORY');
db.pragma('legacy_file_format = OFF');

// ========== KEG TRANSACTIONS LOG — single table for all keg movements ==========
// Create FIRST so migration (below) can use it on existing DB
db.exec(`
  CREATE TABLE IF NOT EXISTS keg_transactions_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('deliver','collect','import','adjust','sell_empty','gift','lost','replacement','sale_delete')),
    quantity INTEGER NOT NULL,
    exchanged INTEGER DEFAULT 0,
    purchased INTEGER DEFAULT 0,
    customer_id INTEGER,
    customer_name TEXT,
    inventory_after INTEGER NOT NULL,
    empty_after INTEGER NOT NULL,
    holding_after INTEGER NOT NULL,
    lost_after INTEGER DEFAULT 0,
    note TEXT,
    date TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_keg_tx_log_date ON keg_transactions_log(date)`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_keg_tx_log_type ON keg_transactions_log(type)`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_keg_tx_log_customer ON keg_transactions_log(customer_id)`); } catch (_) {}
// Migration: Add lost_after column if not exists
try { db.exec(`ALTER TABLE keg_transactions_log ADD COLUMN lost_after INTEGER DEFAULT 0`); } catch (_) {}

// Migration: Update CHECK constraint for new transaction types
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS keg_transactions_log_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('deliver', 'collect', 'import', 'adjust', 'sell_empty', 'gift', 'lost', 'replacement', 'sale_delete')),
      quantity INTEGER NOT NULL,
      exchanged INTEGER DEFAULT 0,
      purchased INTEGER DEFAULT 0,
      customer_id INTEGER,
      customer_name TEXT,
      inventory_after INTEGER,
      empty_after INTEGER,
      holding_after INTEGER DEFAULT 0,
      lost_after INTEGER DEFAULT 0,
      note TEXT,
      date TEXT
    )
  `);
  db.exec(`INSERT INTO keg_transactions_log_new SELECT * FROM keg_transactions_log`);
  db.exec(`DROP TABLE keg_transactions_log`);
  db.exec(`ALTER TABLE keg_transactions_log_new RENAME TO keg_transactions_log`);
  logger.log('Migrated keg_transactions_log CHECK constraint');
} catch (_) {}

// Create tables
db.exec(`
  -- Customers table
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    deposit REAL DEFAULT 0,
    keg_balance INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Products table
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE,
    name TEXT NOT NULL,
    stock INTEGER DEFAULT 0,
    damaged_stock INTEGER DEFAULT 0,
    cost_price REAL DEFAULT 0,
    sell_price REAL DEFAULT 0,
    type TEXT DEFAULT 'keg', -- 'keg' = bình 1L, 'pet' = chai nhựa, 'box' = hộp 23L
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Prices table (custom prices per customer-product)
  -- Note: Changed to NO ACTION to preserve prices when products are soft-deleted
  CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    price REAL NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE NO ACTION,
    UNIQUE(customer_id, product_id)
  );

  -- Sales table
  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    total REAL NOT NULL,
    profit REAL DEFAULT 0,
    deliver_kegs INTEGER DEFAULT 0,
    return_kegs INTEGER DEFAULT 0,
    keg_balance_after INTEGER DEFAULT 0,
    type TEXT DEFAULT 'sale',
    note TEXT,
    status TEXT DEFAULT 'completed',
    archived INTEGER DEFAULT 0,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
  );

  -- Index for customer sales queries (tối ưu theo dõi lịch sử khách hàng)
  CREATE INDEX IF NOT EXISTS idx_sales_customer_date ON sales(customer_id, date);

  -- Sale items table
  -- Note: Changed to NO ACTION to preserve sale_items when products are soft-deleted
  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
    cost_price REAL DEFAULT 0,
    profit REAL DEFAULT 0,
    product_slug TEXT,
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE NO ACTION
  );

  -- Damaged products table (theo dõi bia lỗi/hư)
  -- Note: Changed to NO ACTION to preserve records when products are soft-deleted
  CREATE TABLE IF NOT EXISTS damaged_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    reason TEXT,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE NO ACTION
  );

  -- Purchases/Imports table (theo dõi nhập hàng)
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    total_amount REAL NOT NULL,
    note TEXT,
    archived INTEGER DEFAULT 0
  );

  -- Purchase items table
  -- Note: Changed to NO ACTION to preserve records when products are soft-deleted
  CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    total_price REAL NOT NULL,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE NO ACTION
  );
`);

// Migration: Add cost_price column if it doesn't exist
try {
  db.exec(`ALTER TABLE products ADD COLUMN cost_price REAL DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE sales ADD COLUMN profit REAL DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE sales ADD COLUMN deliver_kegs INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE sales ADD COLUMN return_kegs INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE sales ADD COLUMN keg_balance_after INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE sales ADD COLUMN date TEXT DEFAULT CURRENT_TIMESTAMP`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add payment_status column to sales
try {
  db.exec(`ALTER TABLE sales ADD COLUMN payment_status TEXT DEFAULT 'unpaid'`);
} catch (e) {
  // Column already exists, ignore
}

// Backwards-compat view: if legacy DB has no date column, populate it from created_at
// This ensures all s.date references in queries work on both old and new DBs
try {
  // Only populate if date column exists but most rows are NULL/empty
  const nullCount = db.prepare("SELECT COUNT(*) as c FROM sales WHERE date IS NULL OR date = ''").get();
  if (nullCount && nullCount.c > 0) {
    db.prepare("UPDATE sales SET date = COALESCE(created_at, date, CURRENT_TIMESTAMP) WHERE date IS NULL OR date = ''").run();
  }
} catch (e) {
  // Ignore — column may not exist yet or other DB errors
}

try {
  db.exec(`ALTER TABLE sale_items ADD COLUMN cost_price REAL DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE sale_items ADD COLUMN profit REAL DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add price_at_time for price snapshot (STEP 5)
try {
  db.exec(`ALTER TABLE sale_items ADD COLUMN price_at_time REAL DEFAULT 0`);
} catch (e) {
  // Column already exists
}

// Migration: Add debt, address, lat, lng to customers
try {
  db.exec(`ALTER TABLE customers ADD COLUMN debt REAL DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE customers ADD COLUMN address TEXT`);
} catch (e) {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE customers ADD COLUMN lat REAL`);
} catch (e) {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE customers ADD COLUMN lng REAL`);
} catch (e) {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE customers ADD COLUMN note TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add last_order_date to customers (for fast queries)
try {
  db.exec(`ALTER TABLE customers ADD COLUMN last_order_date TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add fridge counts to customers
try {
} catch (e) {
  // Columns already exist
}

// Index for customer alerts (tìm khách lâu ngày chưa mua)
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customer_last_order ON customers(last_order_date)`);
} catch (e) {
  // Index may already exist, ignore
}

// Migration: Add archived column to customers (for soft-delete / lưu trữ)
try {
  db.exec(`ALTER TABLE customers ADD COLUMN archived INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists
}

// Migration: Add exclude_expected column to customers (bỏ qua khỏi doanh số kỳ vọng)
try {
  db.exec(`ALTER TABLE customers ADD COLUMN exclude_expected INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists
}

// Index for archived customers
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customers_archived ON customers(archived)`);
} catch (e) {
  // Index may already exist
}

// Sync migrations: Add updated_at for conflict detection ============
// updated_at dùng cho sync - detect conflict (last-write-wins)
const syncTables = [
  'customers', 'products', 'sales', 'expenses', 'payments',
  'keg_transactions_log', 'devices', 'prices', 'purchases', 'purchase_items'
];
syncTables.forEach(table => {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT`);
  } catch (e) {
    // Column already exists
  }
});

// Migration: Add type column to products (keg, pet, box)
try {
  db.exec(`ALTER TABLE products ADD COLUMN type TEXT DEFAULT 'keg'`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add sell_price column to products (retail price fallback when prices table has no entry)
try {
  db.exec(`ALTER TABLE products ADD COLUMN sell_price REAL DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add slug column to products (stable string ID replacing auto-increment)
// Also add slug to prices and sale_items so the chain stays consistent
try {
  db.exec(`ALTER TABLE products ADD COLUMN slug TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// ========== SOFT DELETE MIGRATIONS ==========
// Migration: Add archived column to products (soft delete)
try {
  db.exec(`ALTER TABLE products ADD COLUMN archived INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add archived column to sales (soft delete)
try {
  db.exec(`ALTER TABLE sales ADD COLUMN archived INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add archived column to expenses (soft delete)
try {
  db.exec(`ALTER TABLE expenses ADD COLUMN archived INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add archived column to purchases (soft delete)
try {
  db.exec(`ALTER TABLE purchases ADD COLUMN archived INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add product_slug to prices (string-based product reference)
try {
  db.exec(`ALTER TABLE prices ADD COLUMN product_slug TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add product_slug to sale_items (for historical records to stay readable)
try {
  db.exec(`ALTER TABLE sale_items ADD COLUMN product_slug TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// Populate slug from product name for existing products (slug = lowercase, spaces→underscores, strip diacritics)
function toSlug(name) {
  if (!name) return '';
  return name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim().replace(/\s+/g, '_');
}

// Seed slug for existing products without slug
try {
  const productsNeedingSlug = db.prepare("SELECT id, name FROM products WHERE slug IS NULL OR slug = ''").all();
  const updateSlug = db.prepare('UPDATE products SET slug = ? WHERE id = ?');
  productsNeedingSlug.forEach(function(p) {
    var slug = toSlug(p.name);
    if (slug) {
      updateSlug.run(slug, p.id);
    }
  });
  if (productsNeedingSlug.length > 0) {
  }
} catch (e) {
}

// Seed product_slug in prices table (backfill from product slug)
try {
  var updatedPrices = 0;
  var priceRows = db.prepare("SELECT pr.id, p.slug FROM prices pr JOIN products p ON pr.product_id = p.id WHERE pr.product_slug IS NULL OR pr.product_slug = ''").all();
  var updatePriceSlug = db.prepare('UPDATE prices SET product_slug = ? WHERE id = ?');
  priceRows.forEach(function(r) {
    if (r.slug) {
      updatePriceSlug.run(r.slug, r.id);
      updatedPrices++;
    }
  });
  if (updatedPrices > 0) {
  }
} catch (e) {
}

// Seed product_slug in sale_items table (backfill from product slug)
try {
  var updatedItems = 0;
  var itemRows = db.prepare("SELECT si.id, p.slug FROM sale_items si JOIN products p ON si.product_id = p.id WHERE si.product_slug IS NULL OR si.product_slug = ''").all();
  var updateItemSlug = db.prepare('UPDATE sale_items SET product_slug = ? WHERE id = ?');
  itemRows.forEach(function(r) {
    if (r.slug) {
      updateItemSlug.run(r.slug, r.id);
      updatedItems++;
    }
  });
  if (updatedItems > 0) {
  }
} catch (e) {
}

// Ensure unique slug constraint on products
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON products(slug)');
} catch (e) {
  // Index may already exist
}

// Customer monthly summary — DENORMALIZED, removed (replaced by real-time query on sales)
db.exec(`DROP TABLE IF EXISTS customer_monthly`);

// Payments table (theo dõi thanh toán công nợ)
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    note TEXT,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );
`);

// Sync Queue table (cho cloud sync)
db.exec(`
  CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    data TEXT,
    synced INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Sync metadata table (key-value store cho cloud sync)
db.exec(`
  CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
// Helper function to add to sync queue
function addToSyncQueue(entity, entityId, action, data) {
  try {
    db.prepare(`
      INSERT INTO sync_queue (entity, entity_id, action, data)
      VALUES (?, ?, ?, ?)
    `).run(entity, entityId, action, JSON.stringify(data));
  } catch (e) {
    console.error('Error adding to sync queue:', e);
  }
}

// Helper function to get pending sync items
function getPendingSyncItems(limit = 50) {
  return db.prepare(`
    SELECT * FROM sync_queue
    WHERE synced = 0
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit);
}

// Helper function to mark as synced
function markAsSynced(ids) {
  if (!ids || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`
    UPDATE sync_queue
    SET synced = 1
    WHERE id IN (${placeholders})
  `).run(...ids);
}

// Seed initial data if empty
const productCount = db.prepare('SELECT COUNT(*) as count FROM products').get();
if (productCount.count === 0) {
  // Seed products with cost_price (in VNĐ)
  const insertProduct = db.prepare('INSERT INTO products (name, stock, cost_price) VALUES (?, ?, ?)');
  insertProduct.run('Heineken Keg 30L', 50, 1800000);  // Cost: 1,800,000 VNĐ
  insertProduct.run('Carlsberg Keg 30L', 30, 1680000); // Cost: 1,680,000 VNĐ
  insertProduct.run('Guinness Keg 30L', 20, 1920000); // Cost: 1,920,000 VNĐ
  insertProduct.run('Stella Artois Keg 30L', 25, 2040000); // Cost: 2,040,000 VNĐ

  // Seed customers (deposit in VNĐ)
  const insertCustomer = db.prepare('INSERT INTO customers (name, phone, deposit, keg_balance) VALUES (?, ?, ?, ?)');
  insertCustomer.run("Quán Joe", '0901234567', 12000000, 5);
  insertCustomer.run('Quán Bar Địa Phương', '0902345678', 7200000, 3);
  insertCustomer.run('Nhà hàng Ven Sông', '0903456789', 19200000, 8);

  // Seed prices (in VNĐ)
  const insertPrice = db.prepare('INSERT INTO prices (customer_id, product_id, price) VALUES (?, ?, ?)');
  insertPrice.run(1, 1, 2880000);  // Quán Joe - Heineken
  insertPrice.run(1, 2, 2760000);  // Quán Joe - Carlsberg
  insertPrice.run(2, 1, 3000000);  // Quán Local - Heineken
  insertPrice.run(2, 3, 3120000);  // Quán Local - Guinness
  insertPrice.run(3, 1, 2640000);  // Riverside - Heineken
  insertPrice.run(3, 4, 3240000);  // Riverside - Stella

}

// Update existing sale_items with cost_price if empty
const itemsWithoutCost = db.prepare("SELECT si.* FROM sale_items si WHERE si.cost_price = 0 OR si.cost_price IS NULL").all();
if (itemsWithoutCost.length > 0) {
  const updateItem = db.prepare('UPDATE sale_items SET cost_price = ? WHERE id = ?');
  const getProduct = db.prepare('SELECT cost_price FROM products WHERE id = ?');
  itemsWithoutCost.forEach(item => {
    const product = getProduct.get(item.product_id);
    if (product && product.cost_price) {
      updateItem.run(product.cost_price, item.id);
    }
  });
}

// ==================== INDEXES ====================
// Tạo index để tăng tốc query (đặc biệt quan trọng khi dữ liệu nhiều)
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prices_customer_product ON prices(customer_id, product_id)`);
  // Unique index để tránh trùng giá cho cùng khách-sản phẩm
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prices_unique ON prices(customer_id, product_id)`);
} catch (e) {
}

// Migration: Add type column to sales if not exists
try {
  db.exec(`ALTER TABLE sales ADD COLUMN type TEXT DEFAULT 'sale'`);
} catch (e) {
  // Column already exists
}

// Migration: Add note column to sales if not exists
try {
  db.exec(`ALTER TABLE sales ADD COLUMN note TEXT`);
} catch (e) {
  // Column already exists
}

// Migration: Add status column to sales if not exists
try {
  db.exec(`ALTER TABLE sales ADD COLUMN status TEXT DEFAULT 'completed'`);
} catch (e) {
  // Column already exists
}

// Migration: Add return tracking columns to sales if not exists
try {
  db.exec(`ALTER TABLE sales ADD COLUMN returned_amount REAL DEFAULT 0`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE sales ADD COLUMN returned_quantity INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists
}

// Migration: Add routing columns for real driving distance/duration
try {
  db.exec(`ALTER TABLE sales ADD COLUMN distance_km REAL`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE sales ADD COLUMN duration_min INTEGER`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE sales ADD COLUMN route_index INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE sales ADD COLUMN route_polyline TEXT`);
} catch (e) {
  // Column already exists
}

// Migration: Add damaged_stock column to products if not exists
try {
  db.exec(`ALTER TABLE products ADD COLUMN damaged_stock INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists
}

// Migration: Create damaged_products table if not exists
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS damaged_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      reason TEXT,
      date TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `);
} catch (e) {
  // Table already exists
}

// Devices table for managing equipment (tủ nằm, tủ đứng)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('horizontal', 'vertical')),
      serial_number TEXT,
      status TEXT DEFAULT 'available' CHECK(status IN ('available', 'in_use', 'maintenance')),
      customer_id INTEGER,
      assigned_date TEXT,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
    )
  `);
} catch (e) {
  // Table already exists
}

// Index for devices table (tối ưu truy vấn)
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices(customer_id)`);
} catch (e) {
  // Indexes may already exist
}

// Settings table for app configuration
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Insert default values if not exists
  const defaults = [
    ['delivery_cost_per_km', '3000'],
    ['delivery_base_cost', '0'],
    ['distributor_lat', '10.8231'],
    ['distributor_lng', '106.6297']
  ];

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  defaults.forEach(([key, value]) => insertSetting.run(key, value));
} catch (e) {
}

// Expense Categories table — loại chi phí tự thêm, lưu trên server
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      icon TEXT DEFAULT '📋',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
} catch (e) {
}

// Migrate expense_categories — add icon column if missing
try {
  const cols = db.prepare("PRAGMA table_info(expense_categories)").all();
  if (!cols.find(c => c.name === 'icon')) {
    db.exec('ALTER TABLE expense_categories ADD COLUMN icon TEXT DEFAULT \'📋\'');
  }
} catch (e) {
}

// Expenses table for tracking operational costs
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      type TEXT DEFAULT 'other',
      amount REAL NOT NULL,
      description TEXT,
      date TEXT DEFAULT CURRENT_TIMESTAMP,
      time TEXT DEFAULT CURRENT_TIMESTAMP,
      km INTEGER,
      order_id INTEGER,
      is_auto INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Audit log for product stock changes (import/export/adjust/delete/return)
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      type TEXT NOT NULL,          -- 'import' | 'export' | 'restore' | 'adjust'
      quantity INTEGER NOT NULL,   -- số lượng thay đổi (dương=cộng, âm=trừ)
      reason TEXT,                 -- 'purchase' | 'sale' | 'sale_delete' | 'return' | 'adjust' | 'manual'
      ref_id INTEGER,              -- purchase_id / sale_id / null
      ref_type TEXT,               -- 'purchase' | 'sale' | null
      customer_name TEXT,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_product_audit_product ON product_audit_log(product_id, created_at DESC)`);

  // Create index for faster date queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_type ON expenses(type)`);
} catch (e) {
}

// Sessions table for daily session grouping (STEP 1 - Session Layer)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      date TEXT UNIQUE NOT NULL,
      orders TEXT,
      expenses TEXT,
      total_revenue REAL DEFAULT 0,
      total_expense REAL DEFAULT 0,
      profit REAL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date)`);
} catch (e) {
  // Sessions table may already exist
}

// Migration: Add new expense fields if not exists
try {
  db.exec(`ALTER TABLE expenses ADD COLUMN type TEXT DEFAULT 'other'`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE expenses ADD COLUMN time TEXT DEFAULT CURRENT_TIMESTAMP`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE expenses ADD COLUMN km INTEGER`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE expenses ADD COLUMN order_id INTEGER`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE expenses ADD COLUMN is_auto INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists
}

// Migration: DB cũ có thể tạo bảng expenses trước khi có cột category → mọi query GROUP BY category sẽ lỗi
try {
  db.exec(`ALTER TABLE expenses ADD COLUMN category TEXT DEFAULT 'Khác'`);
} catch (e) {
  // Column already exists
}
try {
  db.exec(`UPDATE expenses SET category = 'Khác' WHERE category IS NULL OR TRIM(category) = ''`);
} catch (e) {
  // ignore
}

// (keg_inventory table removed — keg_stats is the single source of truth for keg state)
  // Migration: Add keg_inventory_balance setting if not exists
try {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('keg_inventory_balance', '0');
} catch (e) {
  // Setting may already exist
}

// Migration: Add monthly_expected setting if not exists (kỳ vọng bình/tháng chung)
try {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('monthly_expected', '200');
} catch (e) {
  // Setting may already exist
}

// Migration: Add box_to_keg_ratio setting (quy đổi box -> bình)
try {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('box_to_keg_ratio', '23');
} catch (e) {
  // Setting may already exist
}

// Migration: Add max_debt_per_customer setting (giới hạn công nợ mặc định)
try {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('max_debt_per_customer', '5000000');
} catch (e) {
  // Setting may already exist
}

// Keg Stats table - Centralized keg state management
db.exec(`
  CREATE TABLE IF NOT EXISTS keg_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    inventory INTEGER DEFAULT 0,
    empty_collected INTEGER DEFAULT 0,
    customer_holding INTEGER DEFAULT 0,
    lost INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT single_row CHECK (id = 1)
  );
`);

// Add lost column if not exists (migration)
try {
  db.exec(`ALTER TABLE keg_stats ADD COLUMN lost INTEGER DEFAULT 0`);
} catch (e) {
  // Column may already exist
}

// Initialize keg_stats with single row if empty
try {
  const count = db.prepare('SELECT COUNT(*) as count FROM keg_stats').get();
  if (count.count === 0) {
    db.prepare('INSERT INTO keg_stats (id, inventory, empty_collected, customer_holding) VALUES (1, 0, 0, 0)').run();
  }
} catch (e) {
  // May already exist
}

// Index for keg_stats
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_keg_stats ON keg_stats(id)`);
} catch (e) {
  // Index may exist
}

// Keg Transactions Log table - for tracking all keg movements
db.exec(`
  CREATE TABLE IF NOT EXISTS keg_transactions_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('deliver', 'collect', 'import', 'adjust', 'sell_empty', 'gift', 'lost', 'replacement', 'sale_delete')),
    quantity INTEGER NOT NULL,
    exchanged INTEGER DEFAULT 0,
    purchased INTEGER DEFAULT 0,
    customer_id INTEGER,
    customer_name TEXT,
    inventory_after INTEGER NOT NULL,
    empty_after INTEGER NOT NULL,
    holding_after INTEGER NOT NULL,
    lost_after INTEGER DEFAULT 0,
    note TEXT,
    date TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// (keg_transactions_log table and indexes already created at top of file)
// Index for keg_transactions_log (keg_log table removed — use keg_transactions_log)
try {
  db.exec(`ALTER TABLE sale_items ADD COLUMN updated_at TEXT`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE sale_items ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP`);
} catch (e) {
  // Column already exists
}

// ========== CONSTRAINTS: CHECK enums ==========
// Add CHECK constraints for columns that accept limited values
// These are idempotent — harmless if constraint already exists
const addConstraint = (sql) => {
  try { db.exec(sql); } catch (e) { /* already exists or table missing */ }
};

addConstraint(`ALTER TABLE sales ADD CONSTRAINT chk_sales_type  CHECK (type  IN ('sale','replacement','gift'))`);
addConstraint(`ALTER TABLE sales ADD CONSTRAINT chk_sales_status CHECK (status IN ('completed','returned'))`);
addConstraint(`ALTER TABLE products ADD CONSTRAINT chk_products_type CHECK (type IN ('keg','pet','box'))`);

// ========== ADDITIONAL INDEXES ==========
const addIndex = (sql) => {
  try { db.exec(sql); } catch (e) { /* already exists */ }
};
addIndex(`CREATE INDEX IF NOT EXISTS idx_sales_date_type ON sales(date, type)`);
addIndex(`CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id)`);
addIndex(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)`);
addIndex(`CREATE INDEX IF NOT EXISTS idx_products_archived ON products(archived)`);
addIndex(`CREATE INDEX IF NOT EXISTS idx_sales_archived ON sales(archived)`);
addIndex(`CREATE INDEX IF NOT EXISTS idx_expenses_archived ON expenses(archived)`);
addIndex(`CREATE INDEX IF NOT EXISTS idx_purchases_archived ON purchases(archived)`);
// PERFORMANCE: Missing indexes identified during codebase scan
// sync_queue: queries filter by synced=0, entity, or both
addIndex(`CREATE INDEX IF NOT EXISTS idx_sync_queue_synced ON sync_queue(synced)`);
addIndex(`CREATE INDEX IF NOT EXISTS idx_sync_queue_entity_synced ON sync_queue(entity, synced)`);
// payments: debt report aggregates by customer_id
addIndex(`CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id)`);
// keg_transactions_log: compound index for type+date queries
addIndex(`CREATE INDEX IF NOT EXISTS idx_keg_tx_log_type_date ON keg_transactions_log(type, date DESC)`);
addIndex(`CREATE INDEX IF NOT EXISTS idx_keg_tx_log_customer_date ON keg_transactions_log(customer_id, date DESC)`);

// ========== AUTO BACKUP — runs every day at 2 AM ==========
try {
  const cron = require('node-cron');
  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  cron.schedule('0 2 * * *', () => {
    const timestamp = new Date().toISOString().slice(0, 10);
    const backupPath = path.join(backupDir, `db_${timestamp}.sqlite`);
    try {
      db.backup(backupPath);
      logger.log('[BACKUP] SQLite backup saved:', backupPath);
    } catch (e) {
      logger.error('[BACKUP] Failed:', e.message);
    }
    // Keep only last 30 backups
    try {
      const files = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('db_') && f.endsWith('.sqlite'))
        .sort()
        .reverse();
      files.slice(30).forEach(f => fs.unlinkSync(path.join(backupDir, f)));
    } catch (_) {}
  }, { timezone: 'Asia/Ho_Chi_Minh' });

  logger.log('[BACKUP] Daily cron scheduled (2 AM)');
} catch (e) {
  logger.log('[BACKUP] node-cron not available, auto-backup disabled');
}

// ========== EXPORT HELPERS for other modules ==========
// logKegTransaction — unified function used by kegs.js, payments.js, stock.js
function logKegTransaction(type, quantity, state, opts = {}) {
  const { exchanged = 0, purchased = 0, customerId = null, customerName = null, note = null } = opts;
  try {
    db.prepare(`
      INSERT INTO keg_transactions_log
        (type, quantity, exchanged, purchased, customer_id, customer_name,
         inventory_after, empty_after, holding_after, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(type, quantity, exchanged, purchased, customerId, customerName,
           state.inventory, state.emptyCollected, state.customerHolding, note);
  } catch (e) {
    logger.error('logKegTransaction error:', e.message);
  }
}

// getVietnamDateStr already added at top of file — see above
module.exports = db;
module.exports.getVietnamDateStr = getVietnamDateStr;
module.exports.logKegTransaction = logKegTransaction;
module.exports.toSlug = toSlug;

// ========== PROMOTION SYSTEM MIGRATIONS ==========
// Thêm fields cho khuyến mãi quán mới và thưởng doanh số tháng

// Customers: first_order_date (ngày đơn đầu tiên)
try {
  db.exec(`ALTER TABLE customers ADD COLUMN first_order_date TEXT`);
} catch (e) { /* already exists */ }

// Backfill first_order_date cho khách cũ (khách đã có đơn hàng trước khi có migration)
// Điều kiện: khách có sales và first_order_date = NULL → lấy ngày đơn đầu tiên
try {
  db.prepare(`
    UPDATE customers
    SET first_order_date = (
      SELECT MIN(s.date) FROM sales s
      WHERE s.customer_id = customers.id
        AND s.type = 'sale'
        AND s.archived = 0
    )
    WHERE first_order_date IS NULL
      AND EXISTS (
        SELECT 1 FROM sales s
        WHERE s.customer_id = customers.id
          AND s.type = 'sale'
          AND s.archived = 0
      )
  `).run();
} catch (e) { /* ignore errors */ }

// Customers: monthly_purchased_liters (tổng lít mua trong tháng - denormalized cho performance)
try {
  db.exec(`ALTER TABLE customers ADD COLUMN monthly_purchased_liters REAL DEFAULT 0`);
} catch (e) { /* already exists */ }

// Customers: reward_tier (NONE | BONUS_10L | BONUS_20L)
try {
  db.exec(`ALTER TABLE customers ADD COLUMN reward_tier TEXT DEFAULT 'NONE'`);
} catch (e) { /* already exists */ }

// Customers: reward_claimed (đã nhận thưởng tháng chưa)
try {
  db.exec(`ALTER TABLE customers ADD COLUMN reward_claimed INTEGER DEFAULT 0`);
} catch (e) { /* already exists */ }

// Customers: reward_claimed_at
try {
  db.exec(`ALTER TABLE customers ADD COLUMN reward_claimed_at TEXT`);
} catch (e) { /* already exists */ }

// Sales: promo_free_liters (tổng lít được tặng trong đơn này)
try {
  db.exec(`ALTER TABLE sales ADD COLUMN promo_free_liters REAL DEFAULT 0`);
} catch (e) { /* already exists */ }

// Sales: promo_type (NEW_SHOP | MONTHLY_BONUS | null)
try {
  db.exec(`ALTER TABLE sales ADD COLUMN promo_type TEXT`);
} catch (e) { /* already exists */ }

// Sales: reward_liters_used (lít thưởng tháng đã dùng trong đơn)
try {
  db.exec(`ALTER TABLE sales ADD COLUMN reward_liters_used REAL DEFAULT 0`);
} catch (e) { /* already exists */ }

// Reward History table - lưu lịch sử nhận thưởng tháng
db.exec(`
  CREATE TABLE IF NOT EXISTS reward_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    reward_tier TEXT NOT NULL,
    reward_liters INTEGER NOT NULL,
    claimed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    note TEXT,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  )
`);
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reward_history_customer ON reward_history(customer_id)`);
} catch (e) { /* index may exist */ }

// Promotions table - quản lý khuyến mãi
db.exec(`
  CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'percentage',
    value REAL DEFAULT 0,
    min_order_value REAL,
    max_discount REAL,
    customer_tier TEXT,
    customer_segments TEXT,
    product_id INTEGER,
    buy_quantity INTEGER,
    get_quantity INTEGER,
    active INTEGER DEFAULT 1,
    start_date TEXT,
    end_date TEXT,
    priority INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  )
`);
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_promotions_active ON promotions(active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_promotions_dates ON promotions(start_date, end_date)`);
} catch (e) { /* indexes may exist */ }


// ================================================================
// PROMOTION SYSTEM v3 — ADMIN SETTINGS PAGE
// ================================================================

// Customers: promotionEnabled flag
try {
  db.exec(`ALTER TABLE customers ADD COLUMN promotion_enabled INTEGER DEFAULT 1`);
} catch (e) { /* already exists */ }

// Customer-level promotion overrides — cho phép bật/tắt riêng từng loại khuyến mãi
try {
  db.exec(`ALTER TABLE customers ADD COLUMN new_shop_enabled INTEGER DEFAULT 1`);
} catch (e) { /* already exists */ }
try {
  db.exec(`ALTER TABLE customers ADD COLUMN reward_enabled INTEGER DEFAULT 1`);
} catch (e) { /* already exists */ }

// Promotion Settings table — lưu config hệ thống khuyến mãi
db.exec(`
  CREATE TABLE IF NOT EXISTS promotion_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    -- KHUYEN MÃI QUAN MOI
    new_shop_enabled INTEGER DEFAULT 1,
    new_shop_days INTEGER DEFAULT 30,
    new_shop_gold_buy INTEGER DEFAULT 10,
    new_shop_gold_free INTEGER DEFAULT 1,
    new_shop_black_buy INTEGER DEFAULT 20,
    new_shop_black_free INTEGER DEFAULT 1,
    -- THUONG DOANH SO
    reward_enabled INTEGER DEFAULT 1,
    -- reward_tiers stored as JSON array: [{threshold: 300, reward: 10}, {threshold: 500, reward: 20}]
    reward_tiers TEXT DEFAULT '[{"threshold":300,"reward":10},{"threshold":500,"reward":20}]',
    -- updated_at for cache busting
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT single_row CHECK (id = 1)
  )
`);
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_promotion_settings ON promotion_settings(id)`);
} catch (e) { /* index may exist */ }

// Seed default settings if empty
try {
  const count = db.prepare('SELECT COUNT(*) as c FROM promotion_settings').get();
  if (count.c === 0) {
    db.prepare('INSERT INTO promotion_settings (id) VALUES (1)').run();
    logger.log('[PROMOTION] Seeded default promotion_settings');
  }
} catch (e) { /* may already exist */ }

// Migration: Add start_date/end_date columns if not exists (for promotion validity period)
try {
  const cols = db.prepare("PRAGMA table_info(promotion_settings)").all();
  const colNames = cols.map(c => c.name);
  if (!colNames.includes('start_date')) {
    db.exec("ALTER TABLE promotion_settings ADD COLUMN start_date TEXT");
    logger.log('[PROMOTION] Added start_date column');
  }
  if (!colNames.includes('end_date')) {
    db.exec("ALTER TABLE promotion_settings ADD COLUMN end_date TEXT");
    logger.log('[PROMOTION] Added end_date column');
  }
} catch (e) {
  logger.error('[PROMOTION] Migration start_date/end_date failed:', e.message);
}

// Customer Monthly Reward Tracking table — theo dõi sản lượng tháng theo từng khách
db.exec(`
  CREATE TABLE IF NOT EXISTS customer_monthly_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    purchased_liters REAL DEFAULT 0,
    reward_tier TEXT DEFAULT 'NONE',
    reward_claimed INTEGER DEFAULT 0,
    reward_claimed_at TEXT,
    reward_claimed_liters REAL DEFAULT 0,
    reward_claimed_sale_id INTEGER,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(customer_id, year, month)
  )
`);
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customer_monthly_customer ON customer_monthly_stats(customer_id, year, month)`);
} catch (e) { /* index may exist */ }

// Seed customer_monthly_stats cho các tháng trước (backfill)
try {
  // Get all customers and their monthly purchased liters
  const customers = db.prepare('SELECT id FROM customers WHERE archived = 0').all();
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-based

  for (const cust of customers) {
    for (let m = 1; m <= currentMonth; m++) {
      const liters = db.prepare(`
        SELECT COALESCE(SUM(si.quantity), 0) as total
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        JOIN products p ON p.id = si.product_id
        WHERE s.customer_id = ?
          AND s.type = 'sale'
          AND s.archived = 0
          AND s.promo_type IS DISTINCT FROM 'MONTHLY_BONUS'
          AND si.price > 0
          AND p.type = 'keg'
          AND strftime('%Y', s.date) = ?
          AND strftime('%m', s.date) = ?
      `).get(String(cust.id), String(currentYear), String(m).padStart(2, '0'));

      db.prepare(`
        INSERT OR IGNORE INTO customer_monthly_stats
          (customer_id, year, month, purchased_liters)
        VALUES (?, ?, ?, ?)
      `).run(cust.id, currentYear, m, liters ? liters.total : 0);
    }
  }
  logger.log('[PROMOTION] Backfilled customer_monthly_stats for', customers.length, 'customers');
} catch (e) {
  logger.log('[PROMOTION] customer_monthly_stats backfill note:', e.message);
}

// Backfill promotionEnabled for existing customers (default to 1 = enabled)
try {
  db.exec(`UPDATE customers SET promotion_enabled = 1 WHERE promotion_enabled IS NULL`);
} catch (e) { /* ignore */ }

// Seed promotion_enabled = 0 for known inactive customers (those with old promotion data)
try {
  // Check if any customers were previously excluded from promotions
  const excluded = db.prepare(`
    SELECT COUNT(*) as c FROM customers
    WHERE archived = 0
      AND (SELECT COUNT(*) FROM sales WHERE customer_id = customers.id AND promo_type IS NOT NULL) = 0
      AND (SELECT COUNT(*) FROM sales WHERE customer_id = customers.id AND type = 'sale') > 10
  `).get();
  // Only disable if there's a clear pattern — for now, keep all enabled
  logger.log('[PROMOTION] Existing customers with promotions:', excluded ? excluded.c : 0);
} catch (e) { /* ignore */ }


// ============================================================
// SALES STAFF & COMMISSION SYSTEM
// Quản lý nhân viên sales và tính hoa hồng/lương
// ============================================================

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
    product_type TEXT,
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
    type TEXT DEFAULT 'new_shop',
    amount REAL NOT NULL,
    status TEXT DEFAULT 'pending',
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
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT,
    FOREIGN KEY (sales_id) REFERENCES sales_staff(id) ON DELETE CASCADE,
    UNIQUE(sales_id, year, month)
  )
`);

// Khởi tạo config mặc định
try {
  db.exec(`INSERT OR IGNORE INTO sales_commission_config (id, new_shop_commission) VALUES (1, 500000)`);
} catch (e) { /* ignore */ }

// Dọn cấu hình hoa hồng trùng (giữ bản ghi id nhỏ nhất cho mỗi cặp product_id + product_type)
try {
  db.exec(`
    DELETE FROM sales_product_commission
    WHERE id NOT IN (
      SELECT MIN(id) FROM sales_product_commission
      GROUP BY COALESCE(product_id, -1), product_type
    )
  `);
} catch (e) { /* ignore */ }

// Chỉ tạo mặc định khi bảng trống (lần đầu cài đặt, không tự thêm lại khi restart)
try {
  const commissionCount = db.prepare('SELECT COUNT(*) as c FROM sales_product_commission').get();
  if (commissionCount.c === 0) {
    db.prepare(`INSERT INTO sales_product_commission (product_type, salary_per_liter) VALUES ('all', 1000)`).run();
  }
} catch (e) { /* ignore */ }

// Indexes cho sales staff
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customer_sales ON customer_sales_assignments(customer_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_assignments ON customer_sales_assignments(sales_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_commissions_sales ON sales_commissions(sales_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_salary_sales ON sales_monthly_salary(sales_id)`);
} catch (e) { /* ignore */ }

// ============================================================
// STAFF PRODUCT DISCOUNTS - Chiết khấu theo sản phẩm cho từng nhân viên
// ============================================================

// Bảng chiết khấu sản phẩm theo nhân viên
db.exec(`
  CREATE TABLE IF NOT EXISTS staff_product_discounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    product_id INTEGER,
    product_type TEXT,
    discount_percent REAL NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES sales_staff(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    UNIQUE(staff_id, product_id)
  )
`);

// Bảng chiết khấu mặc định theo loại sản phẩm (khi không có discount riêng cho sản phẩm)
db.exec(`
  CREATE TABLE IF NOT EXISTS staff_type_discounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    product_type TEXT NOT NULL,
    discount_percent REAL NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES sales_staff(id) ON DELETE CASCADE,
    UNIQUE(staff_id, product_type)
  )
`);

// Migration: Thêm cột sales_id vào sales nếu chưa có (để track nhân viên tạo đơn)
try {
  db.exec(`ALTER TABLE sales ADD COLUMN sales_id INTEGER`);
} catch (e) { /* already exists */ }

// Indexes cho staff discounts
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_staff_discount_product ON staff_product_discounts(staff_id, product_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_staff_type_discount ON staff_type_discounts(staff_id, product_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_staff ON sales(sales_id)`);
} catch (e) { /* ignore */ }

// Seed default type discount cho staff mới (nếu chưa có)
try {
  const staffList = db.prepare('SELECT id FROM sales_staff WHERE active = 1').all();
  staffList.forEach(staff => {
    const existing = db.prepare('SELECT COUNT(*) as c FROM staff_type_discounts WHERE staff_id = ?').get(staff.id);
    if (existing.c === 0) {
      // Mặc định chiết khấu 0% cho tất cả các loại
      ['keg', 'pet', 'box'].forEach(type => {
        db.prepare('INSERT OR IGNORE INTO staff_type_discounts (staff_id, product_type, discount_percent) VALUES (?, ?, 0)').run(staff.id, type);
      });
    }
  });
} catch (e) { /* ignore */ }

