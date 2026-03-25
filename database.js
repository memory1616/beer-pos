const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

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
    name TEXT NOT NULL,
    stock INTEGER DEFAULT 0,
    damaged_stock INTEGER DEFAULT 0,
    cost_price REAL DEFAULT 0,
    sell_price REAL DEFAULT 0,
    type TEXT DEFAULT 'keg', -- 'keg' = bình 1L, 'pet' = chai nhựa, 'box' = hộp 23L
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Prices table (custom prices per customer-product)
  CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    price REAL NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
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
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
  );

  -- Index for customer sales queries (tối ưu theo dõi lịch sử khách hàng)
  CREATE INDEX IF NOT EXISTS idx_sales_customer_date ON sales(customer_id, date);

  -- Sale items table
  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
    cost_price REAL DEFAULT 0,
    profit REAL DEFAULT 0,
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  -- Damaged products table (theo dõi bia lỗi/hư)
  CREATE TABLE IF NOT EXISTS damaged_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    reason TEXT,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  -- Keg log table (transaction history)
  CREATE TABLE IF NOT EXISTS keg_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    change INTEGER NOT NULL,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    note TEXT,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );

  -- Purchases/Imports table (theo dõi nhập hàng)
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    total_amount REAL NOT NULL,
    note TEXT
  );

  -- Purchase items table
  CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    total_price REAL NOT NULL,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
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
  db.exec(`ALTER TABLE customers ADD COLUMN horizontal_fridge INTEGER DEFAULT 0`);
  db.exec(`ALTER TABLE customers ADD COLUMN vertical_fridge INTEGER DEFAULT 0`);
  console.log('Added fridge columns to customers');
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
  'keg_transactions', 'devices', 'prices', 'purchases', 'purchase_items'
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

// Customer monthly summary table (for fast dashboard queries)
db.exec(`
  CREATE TABLE IF NOT EXISTS customer_monthly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    quantity INTEGER DEFAULT 0,
    revenue REAL DEFAULT 0,
    orders INTEGER DEFAULT 0,
    UNIQUE(customer_id, year, month),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );
`);

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

// Keg inventory table (theo dõi kho vỏ bình rỗng)
db.exec(`
  CREATE TABLE IF NOT EXISTS keg_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quantity INTEGER DEFAULT 0,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    note TEXT
  );
`);
// Sync metadata table (key-value store cho cloud sync)
db.exec(`
  CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
// Keg transactions table (giao/thu vỏ bình)
db.exec(`
  CREATE TABLE IF NOT EXISTS keg_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    note TEXT,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
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

  console.log('Database seeded with sample data');
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
  console.log('Updated sale_items with cost prices');
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
  console.log('Indexes created successfully');
} catch (e) {
  console.log('Indexes may already exist:', e.message);
}

// Migration: Add type column to sales if not exists
try {
  db.exec(`ALTER TABLE sales ADD COLUMN type TEXT DEFAULT 'sale'`);
  console.log('Added type column to sales');
} catch (e) {
  // Column already exists
}

// Migration: Add note column to sales if not exists
try {
  db.exec(`ALTER TABLE sales ADD COLUMN note TEXT`);
  console.log('Added note column to sales');
} catch (e) {
  // Column already exists
}

// Migration: Add status column to sales if not exists
try {
  db.exec(`ALTER TABLE sales ADD COLUMN status TEXT DEFAULT 'completed'`);
  console.log('Added status column to sales');
} catch (e) {
  // Column already exists
}

// Migration: Add return tracking columns to sales if not exists
try {
  db.exec(`ALTER TABLE sales ADD COLUMN returned_amount REAL DEFAULT 0`);
  console.log('Added returned_amount column to sales');
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE sales ADD COLUMN returned_quantity INTEGER DEFAULT 0`);
  console.log('Added returned_quantity column to sales');
} catch (e) {
  // Column already exists
}

// Migration: Add damaged_stock column to products if not exists
try {
  db.exec(`ALTER TABLE products ADD COLUMN damaged_stock INTEGER DEFAULT 0`);
  console.log('Added damaged_stock column to products');
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
  console.log('Created damaged_products table');
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
  console.log('Created devices table');
} catch (e) {
  // Table already exists
}

// Index for devices table (tối ưu truy vấn)
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices(customer_id)`);
  console.log('Created devices indexes');
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
  console.log('Created settings table');

  // Insert default values if not exists
  const defaults = [
    ['delivery_cost_per_km', '3000'],
    ['delivery_base_cost', '0'],
    ['distributor_lat', '10.8231'],
    ['distributor_lng', '106.6297']
  ];

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  defaults.forEach(([key, value]) => insertSetting.run(key, value));
  console.log('Inserted default settings');
} catch (e) {
  console.log('Settings table may already exist:', e.message);
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
  console.log('Created expenses table');

  // Create index for faster date queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_type ON expenses(type)`);
} catch (e) {
  console.log('Expenses table may already exist:', e.message);
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
  console.log('Created sessions table');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date)`);
} catch (e) {
  console.log('Sessions table may already exist:', e.message);
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

// Index for keg_inventory
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_keg_inventory_date ON keg_inventory(date)`);
  console.log('Created keg_inventory index');
} catch (e) {
  // Index may already exist
}

// Migration: Initialize keg_inventory with zero row if empty
try {
  const count = db.prepare('SELECT COUNT(*) as count FROM keg_inventory').get();
  if (count.count === 0) {
    db.prepare('INSERT INTO keg_inventory (quantity) VALUES (0)').run();
    console.log('Initialized keg_inventory table');
  }
} catch (e) {
  // May already exist
}

  // Migration: Add keg_inventory_balance setting if not exists
try {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('keg_inventory_balance', '0');
  console.log('Added keg_inventory_balance setting');
} catch (e) {
  // Setting may already exist
}

// Migration: Add monthly_expected setting if not exists (kỳ vọng bình/tháng chung)
try {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('monthly_expected', '200');
  console.log('Added monthly_expected setting');
} catch (e) {
  // Setting may already exist
}

// Migration: Add box_to_keg_ratio setting (quy đổi box -> bình)
try {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('box_to_keg_ratio', '23');
  console.log('Added box_to_keg_ratio setting');
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
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT single_row CHECK (id = 1)
  );
`);

// Initialize keg_stats with single row if empty
try {
  const count = db.prepare('SELECT COUNT(*) as count FROM keg_stats').get();
  if (count.count === 0) {
    db.prepare('INSERT INTO keg_stats (id, inventory, empty_collected, customer_holding) VALUES (1, 0, 0, 0)').run();
    console.log('Initialized keg_stats table');
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
    type TEXT NOT NULL CHECK(type IN ('deliver', 'collect', 'import', 'adjust', 'sell_empty')),
    quantity INTEGER NOT NULL,
    exchanged INTEGER DEFAULT 0,
    purchased INTEGER DEFAULT 0,
    customer_id INTEGER,
    customer_name TEXT,
    inventory_after INTEGER NOT NULL,
    empty_after INTEGER NOT NULL,
    holding_after INTEGER NOT NULL,
    note TEXT,
    date TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: add customer_id and customer_name columns if missing (backward compat)
try {
  const cols = db.prepare("PRAGMA table_info(keg_transactions_log)").all();
  const colNames = cols.map(c => c.name);
  if (!colNames.includes('customer_id')) {
    db.exec("ALTER TABLE keg_transactions_log ADD COLUMN customer_id INTEGER");
  }
  if (!colNames.includes('customer_name')) {
    db.exec("ALTER TABLE keg_transactions_log ADD COLUMN customer_name TEXT");
  }
  if (!colNames.includes('sell_empty')) {
    db.exec("ALTER TABLE keg_transactions_log ADD COLUMN sell_empty INTEGER DEFAULT 0");
  }
} catch (e) {
  // Columns may already exist
}

// Index for keg_transactions_log
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_keg_tx_log_date ON keg_transactions_log(date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_keg_tx_log_type ON keg_transactions_log(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_keg_tx_log_customer ON keg_transactions_log(customer_id)`);
} catch (e) {
  // Index may exist
}

// Migration: Add updated_at/created_at to sale_items and keg_log (for sync queries)
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

try {
  db.exec(`ALTER TABLE keg_log ADD COLUMN updated_at TEXT`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE keg_log ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP`);
} catch (e) {
  // Column already exists
}

// ================================================================
// audit_log — Theo dõi thay đổi (ai sửa gì, lúc nào, từ đâu)
// Feature #12: Audit trail cho tất cả thao tác CRUD
// ================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type       TEXT NOT NULL,                              -- 'sale', 'customer', 'product', 'keg', 'expense', etc.
    entity_id         INTEGER NOT NULL,                           -- ID của bản ghi bị thay đổi
    action            TEXT NOT NULL CHECK(action IN ('create', 'update', 'delete', 'restore')), -- Loại thao tác
    old_value         TEXT,                                       -- JSON của giá trị cũ (NULL khi create)
    new_value         TEXT,                                       -- JSON của giá trị mới (NULL khi delete)
    changed_fields    TEXT,                                       -- JSON array của các field bị thay đổi: ["name", "keg_balance"]
    user_id           TEXT,                                       -- username từ session
    ip_address        TEXT,                                       -- IP của client
    user_agent        TEXT,                                       -- Browser/app info
    session_id        TEXT,                                       -- session token
    source            TEXT DEFAULT 'web',                         -- 'web', 'api', 'sync', 'migration'
    created_at        TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Index cho audit_log (tối ưu truy vấn)
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_entity     ON audit_log(entity_type, entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_user       ON audit_log(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_date       ON audit_log(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_action      ON audit_log(action)`);
} catch (e) { /* Index may exist */ }

// Auth sessions table — persistent across server restarts
db.exec(`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token  TEXT PRIMARY KEY,
    data   TEXT,
    expires_at INTEGER NOT NULL
  )
`);
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at)`);
} catch (e) { /* index may exist */ }

// Cleanup expired auth sessions on startup
try {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(Date.now());
} catch (e) { /* ignore */ }

// ================================================================
// keg_ledger — Ledger vỏ bình (nguồn tri thức duy nhất cho tồn kho)
// ================================================================
// pool: inventory = kho đầy, empty = kho rỗng, customer = khách giữ, factory = bên ngoài
db.exec(`
  CREATE TABLE IF NOT EXISTS keg_ledger (
    id                           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type  TEXT NOT NULL CHECK(source_type  IN ('sale','delivery','collect','import','adjust','sell_empty','return_sale')),
    source_id    INTEGER,
    customer_id  INTEGER,
    quantity     INTEGER NOT NULL,
    pool_from    TEXT NOT NULL CHECK(pool_from    IN ('inventory','empty','customer','factory')),
    pool_to      TEXT NOT NULL CHECK(pool_to      IN ('inventory','empty','customer','factory')),
    balance_after_inventory      INTEGER NOT NULL,
    balance_after_empty          INTEGER NOT NULL,
    balance_after_customer       INTEGER NOT NULL,
    note         TEXT,
    created_at   TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Index cho keg_ledger
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_keg_ledger_date      ON keg_ledger(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_keg_ledger_customer  ON keg_ledger(customer_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_keg_ledger_source   ON keg_ledger(source_type, source_id)`);
  // Feature #11: Single-column index for source_id queries (追溯源单据)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_keg_ledger_source_id ON keg_ledger(source_id)`);
} catch (e) { /* Index may exist */ }

// Migration: Add source_type/source_id/source_id NOT NULL workaround
// (SQLite allows inserting NULL into NOT NULL CHECK via bypass; we ensure code always passes values)
try {
  db.exec(`ALTER TABLE keg_ledger ADD COLUMN source_id INTEGER`);
} catch (e) { /* Column may exist */ }
try {
  db.exec(`ALTER TABLE keg_ledger ADD COLUMN customer_id INTEGER`);
} catch (e) { /* Column may exist */ }

// ================================================================
// dashboard_cache — Giảm lag dashboard bằng cách cache stats
// Cache có TTL 60s, tự refresh khi có sale/expense mới
// ================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS dashboard_cache (
    key          TEXT PRIMARY KEY,
    data         TEXT,
    updated_at   INTEGER
  )
`);

// Performance indexes cho analytics
try {
  // Index trên profit để sort/filter nhanh
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_profit     ON sales(profit)`);
  // Index trên date string để GROUP BY tháng nhanh hơn
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_date_str   ON sales(date)`);
  // Index trên type để lọc sale/return nhanh
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_type        ON sales(type)`);
  // Index trên sale_items quantity để tính tổng nhanh
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sale_items_qty    ON sale_items(quantity)`);
  // Index trên expenses date + type
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_dt_type ON expenses(date, type)`);
  console.log('Performance indexes created');
} catch (e) { /* indexes may exist */ }

// Cache helper: get cached value if not expired
const CACHE_TTL_MS = 60 * 1000; // 60 giây
function getCached(key) {
  try {
    const row = db.prepare('SELECT data, updated_at FROM dashboard_cache WHERE key = ?').get(key);
    if (!row) return null;
    if (Date.now() - row.updated_at > CACHE_TTL_MS) return null;
    return JSON.parse(row.data);
  } catch (e) { return null; }
}

// Cache helper: set cached value
function setCache(key, value) {
  try {
    db.prepare(
      'INSERT OR REPLACE INTO dashboard_cache (key, data, updated_at) VALUES (?, ?, ?)'
    ).run(key, JSON.stringify(value), Date.now());
  } catch (e) { /* ignore */ }
}

// Cache helper: invalidate (gọi khi có sale/expense mới)
function invalidateCache(key) {
  try {
    db.prepare('DELETE FROM dashboard_cache WHERE key = ?').run(key);
  } catch (e) { /* ignore */ }
}

// Invalidate all cache (gọi khi có thay đổi lớn)
function invalidateAllCache() {
  try {
    db.prepare('DELETE FROM dashboard_cache').run();
  } catch (e) { /* ignore */ }
}

module.exports = db;
module.exports.getCached = getCached;
module.exports.setCache = setCache;
module.exports.invalidateCache = invalidateCache;
module.exports.invalidateAllCache = invalidateAllCache;
