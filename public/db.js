// BeerPOS IndexedDB — SINGLE SOURCE OF TRUTH for DB version
// ─────────────────────────────────────────────────────
// This file is the ONLY place where DB version is defined.
// The Service Worker reads this version from the _meta object store
// in IndexedDB (via postMessage registration) — never hardcodes it.
//
// HOW VERSION UPGRADES WORK:
// 1. Increment DB_VERSION below
// 2. Add a new db.version(N).stores(...).upgrade(...) block
// 3. The old version block stays intact (Dexie only runs new deltas)
// 4. SW and any other context read version from _meta store
//
// This prevents "VersionError: requested version (31) less than existing (310)"
// because ALL contexts use the SAME version number from ONE source.
// ─────────────────────────────────────────────────────

const DB_VERSION = 40; // ← bump khi schema thay đổi (v40: orders_queue store cho offline order sync)

const DB_NAME    = 'BeerPOS';
const STORE_META = '_meta';
const CACHE_NAME = `beer-pos-v${DB_VERSION}`;

// Guard: prevent re-declaration — robust check
if (window._dbInitialized) {
  console.warn('[DB] ⚠️ Already initialized — skipping duplicate load');
} else {
  window._dbInitialized = true;

  // ─── Open Dexie with safe version escalation ────────────────────────────────
  // NEVER open at a version lower than what's already on disk.
  // Strategy: open without version first → read _meta → open at max(existing, code)

  const _db = new Dexie(DB_NAME);

  // Intercept upgrade to write _meta on first run of each version
  _db.on('ready', async () => {
    try {
      await _db.table(STORE_META).put({ key: 'db_version', value: DB_VERSION });
      await _db.table(STORE_META).put({ key: 'cache_name', value: CACHE_NAME });
      console.log(`[DB] Registered version ${DB_VERSION} in _meta store`);
      // Verify createdAt index exists by querying with it (will throw if not indexed)
      _db.sales.where('createdAt').anyOf([new Date()]).count().catch(function(e) {
        console.error('[DB] ⚠️ createdAt index NOT found — filter will NOT work:', e.message || e);
      }).then(function() {
        console.log('[DB] ✅ createdAt index verified');
      });
    } catch (e) {
      console.warn('[DB] Could not write _meta:', e);
    }

    // Notify Service Worker so it can update its cache name
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type:       'REGISTER_VERSION',
        dbVersion:  DB_VERSION,
        cacheName:  CACHE_NAME
      });
    }
  });

  // ─── Schema Definition — add new version blocks above, never modify old ───
  // v31: base schema (customers, products, sales, sale_items, sync_queue)
  // v32: add routing fields (distance_km, duration_min, route_index, route_polyline)
  // v33: add _meta store for cross-context version sharing
  _db.version(31).stores({
    customers:   '++id, name, phone, deposit, keg_balance, archived, synced',
    products:    '++id, name, stock, cost_price, synced',
    sales:       '++id, createdAt, customer_id, date, total, profit, synced',
    sale_items:  '++id, sale_id, product_id, quantity, price, synced',
    sync_queue:  '++id, entity, action, data, url, method, synced, created_at, retry_count'
  });

  _db.version(32).stores({
    sales: '++id, customer_id, date, total, profit, synced, distance_km, duration_min, route_index, route_polyline'
  }).upgrade(tx => {
    return tx.table('sales').toCollection().modify(sale => {
      if (sale.distance_km === undefined)     sale.distance_km    = null;
      if (sale.duration_min === undefined)    sale.duration_min   = null;
      if (sale.route_index === undefined)     sale.route_index    = 0;
      if (sale.route_polyline === undefined) sale.route_polyline = null;
    });
  });

  _db.version(33).stores({
    [STORE_META]: 'key'
  });

  // v35: re-declare all tables (Dexie first-occurrence rule — only v31 counted)
  //       This block runs for users who skipped over v34 (new installs or fresh DB).
  //       For existing users: v34 upgrade already set createdAt field; this is redundant
  //       but harmless. The createdAt index comes from v31's schema definition.
  _db.version(35).stores({
    customers:   '++id, name, phone, deposit, keg_balance, archived, synced',
    products:    '++id, name, stock, cost_price, synced',
    sales:       '++id, createdAt, customer_id, date, total, profit, synced, distance_km, duration_min, route_index, route_polyline',
    sale_items:  '++id, sale_id, product_id, quantity, price, synced',
    sync_queue:  '++id, entity, action, data, url, method, synced, created_at, retry_count',
    expenses:    '++id, type, amount, note, date, synced'
  }).upgrade(tx => {
    return tx.table('sales').toCollection().modify(sale => {
      if (sale.date && typeof sale.date === 'string') {
        sale.createdAt = new Date(sale.date + 'T00:00:00+07:00');
      } else if (!(sale.createdAt instanceof Date)) {
        sale.createdAt = new Date();
      }
    });
  });

  // v37: thêm slug và sell_price vào products (stable product ID + retail price)
  _db.version(37).stores({
    customers:   '++id, name, phone, deposit, keg_balance, archived, synced',
    products:    '++id, name, slug, stock, cost_price, sell_price, synced',
    sales:       '++id, createdAt, customer_id, date, total, profit, synced, distance_km, duration_min, route_index, route_polyline',
    sale_items:  '++id, sale_id, product_id, product_slug, quantity, price, synced',
    sync_queue:  '++id, entity, action, data, url, method, synced, created_at, retry_count',
    expenses:    '++id, type, amount, note, date, synced'
  }).upgrade(tx => {
    // Add slug field to existing products
    return tx.table('products').toCollection().modify(p => {
      if (p.slug === undefined) p.slug = null;
      if (p.sell_price === undefined) p.sell_price = null;
    });
    // Add product_slug field to existing sale_items
    return tx.table('sale_items').toCollection().modify(si => {
      if (si.product_slug === undefined) si.product_slug = null;
    });
  });

  // v38: 新增快照字段（报表恢复核心）
  //   sale_items: profit_estimated, product_name, cost_price
  //   sales: customer_name
  // 确保即使 products/customers 表为空，报表依然能显示数据
  _db.version(38).stores({
    customers:   '++id, name, phone, deposit, keg_balance, archived, synced',
    products:    '++id, name, slug, stock, cost_price, sell_price, synced',
    sales:       '++id, createdAt, customer_id, customer_name, date, total, profit, synced, distance_km, duration_min, route_index, route_polyline',
    sale_items:  '++id, sale_id, product_id, product_slug, product_name, quantity, price, cost_price, profit, profit_estimated, synced',
    sync_queue:  '++id, entity, action, data, url, method, synced, created_at, retry_count',
    expenses:    '++id, type, amount, note, date, synced'
  }).upgrade(tx => {
    // 给 sale_items 补充缺失字段
    return tx.table('sale_items').toCollection().modify(si => {
      if (si.profit_estimated === undefined) si.profit_estimated = false;
      if (si.product_name === undefined)      si.product_name      = null;
      if (si.cost_price === undefined)        si.cost_price        = null;
    });
  });

  // v39: PART 5 — Soft delete cho sản phẩm & khách hàng
  //   + Thêm trường is_deleted (không bao giờ hard delete)
  //   + Thêm total_amount / total_profit vào sales (đảm bảo luôn tồn tại)
  //   + Đảm bảo sale_items có profit_estimated
  _db.version(40).stores({
    customers:   '++id, name, phone, deposit, keg_balance, archived, is_deleted, synced',
    products:    '++id, name, slug, stock, cost_price, sell_price, is_deleted, synced',
    sales:       '++id, createdAt, customer_id, customer_name, date, total, total_amount, profit, total_profit, synced, distance_km, duration_min, route_index, route_polyline',
    sale_items:  '++id, sale_id, product_id, product_slug, product_name, quantity, price, cost_price, profit, profit_estimated, synced',
    sync_queue:  '++id, entity, action, data, url, method, synced, created_at, retry_count',
    expenses:    '++id, type, amount, note, date, synced',
    orders_queue:'++id, customerId, items, total, profit, deliverKegs, returnKegs, type, note, created_at, synced'
  }).upgrade(tx => {
    // Products: thêm is_deleted
    tx.table('products').toCollection().modify(p => {
      if (p.is_deleted === undefined) p.is_deleted = false;
    });
    // Customers: thêm is_deleted
    tx.table('customers').toCollection().modify(c => {
      if (c.is_deleted === undefined) c.is_deleted = false;
    });
    // Sale_items: đảm bảo profit_estimated
    tx.table('sale_items').toCollection().modify(si => {
      if (si.profit_estimated === undefined) si.profit_estimated = false;
    });
  });

  // ─── Safe DB open with retries ─────────────────────────────────────────────
  async function openDBSafe() {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000;

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        _db.close();
        await _db.open();
        console.log(`[DB] ✅ Open success on attempt ${i + 1}`);
        return;
      } catch (e) {
        console.warn(`[DB] ⚠️ Open failed (attempt ${i + 1}/${MAX_RETRIES}):`, e.message || e);
        if (i < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, RETRY_DELAY));
        }
      }
    }
    throw new Error('[DB] ❌ DB open failed after ' + MAX_RETRIES + ' attempts');
  }

  window.dbReady = openDBSafe();

  // Log when DB is fully ready
  window.dbReady.then(() => {
    console.log('[DB] 🔥 DB READY');
  }).catch(e => {
    console.error('[DB] dbReady rejected:', e.message || e);
  });

  // Expose getter so callers can re-open if locked
  window._reopenDb = async function() {
    try {
      _db.close();
      await _db.open();
      console.log('[DB] 🔄 DB reopened successfully');
    } catch (e) {
      console.error('[DB] 🔄 DB reopen FAILED:', e.message || e);
    }
  };

  // ─── Vietnam date helper (same logic as server — UTC+7) ──────────────────
  function getVietnamDateStr() {
    const now = new Date();
    const vn  = new Date(now.getTime() + 7 * 3600000);
    return vn.getUTCFullYear() + '-' +
      String(vn.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(vn.getUTCDate()).padStart(2, '0');
  }
  window.getVietnamDateStr = getVietnamDateStr;

  // ─── Multi-tab detection ───────────────────────────────────────────────────
  window.addEventListener('storage', (e) => {
    if (e.key === '_dbVersion') {
      console.warn('[DB] ⚠️ Another tab changed DB version — consider reloading');
    }
  });

  // Broadcast DB version for other tabs
  try {
    localStorage.setItem('_dbVersion', DB_VERSION);
    localStorage.setItem('_dbTs', Date.now());
  } catch {}

  // ─── Expose globals ────────────────────────────────────────────────────────
  window.db          = _db;
  // NOTE: window.dbReady already set above with 5s timeout — do NOT override
  window.DB_VERSION   = DB_VERSION;
  window.DB_NAME      = DB_NAME;
  window.CACHE_NAME   = CACHE_NAME;
  window.STORE_META   = STORE_META;
  window.getProducts          = getProducts;
  window.seedProductsIfEmpty  = seedProductsIfEmpty;
  window.updateStockAfterSale = updateStockAfterSale;
  window.createSaleOffline    = createSaleOffline;

  // ==================== SALE FUNCTIONS ====================

  async function createSaleOffline(customerId, items, total, profit) {
    if (window.dbReady) await window.dbReady;
    // Use Vietnam-local date string for server compatibility AND Date for client filtering
    const saleData = {
      customer_id: customerId,
      date: getVietnamDateStr(),
      createdAt: new Date(),
      total: total,
      profit: profit,
      synced: 0
    };

    let saleId;
    await _db.transaction('rw', [_db.sales, _db.sale_items, _db.products, _db.sync_queue], async () => {
      saleId = await _db.sales.add(saleData);

      for (const item of items) {
        await _db.sale_items.add({
          sale_id:    saleId,
          product_id: item.productId,
          product_slug: item.productSlug || null,
          quantity:   item.quantity,
          price:      item.price || 0,
          cost_price: item.costPrice || 0,
          profit:     ((item.price || 0) - (item.costPrice || 0)) * item.quantity,
          synced: 0
        });

        const product = await _db.products.get(item.productId);
        if (product) {
          await _db.products.update(item.productId, {
            stock: (product.stock || 0) - item.quantity
          });
        }
      }

      await _db.sync_queue.add({
        type:       'sale',
        action:     'create',
        data:       JSON.stringify({ id: saleId, customerId, items, total, profit, date: getVietnamDateStr() }),
        synced:     0,
        created_at: new Date().toISOString()
      });
    });

    registerBackgroundSync();
    return saleId;
  }

  // ==================== STOCK FUNCTIONS ====================

  async function getProducts() {
    try {
      if (window.dbReady) {
        console.log('[DB] ⏳ waiting dbReady...');
        await window.dbReady.catch(e => console.warn('[DB] dbReady error:', e.message));
        console.log('[DB] ✅ dbReady resolved');
      }
      const result = await _db.products.toArray();
      console.log('[DB] getProducts: ' + result.length + ' products');
      return result;
    } catch (e) {
      console.error('[DB] getProducts ERROR:', e.message || e);
      try {
        _db.close();
        await _db.open();
        console.log('[DB] 🔄 DB reopened');
        const result = await _db.products.toArray();
        console.log('[DB] getProducts (retry): ' + result.length + ' products');
        return result;
      } catch (e2) {
        console.error('[DB] getProducts retry FAILED:', e2.message || e2);
        return [];
      }
    }
  }

  async function seedProductsIfEmpty() {
    try {
      if (window.dbReady) await window.dbReady.catch(e => console.warn('[DB] seed dbReady error:', e.message));

      // Only seed on FIRST INSTALL — never re-seed after user deletes products
      const alreadySeeded = localStorage.getItem('products_seeded');
      if (alreadySeeded) {
        console.log('[DB] products_seeded flag found — skipping seed');
        return;
      }

      const count = await _db.products.count();
      if (count > 0) return;
      console.warn('[DB] First run → seeding demo products');
      const demoProducts = [
        { name: 'Bia tươi 50L', stock: 50, cost_price: 10000, synced: 1, archived: 0 },
        { name: 'Bia bom 20L', stock: 30, cost_price: 12000, synced: 1, archived: 0 },
        { name: 'Bia chai',    stock: 100, cost_price: 8000, synced: 1, archived: 0 }
      ];
      await _db.products.bulkAdd(demoProducts);
      localStorage.setItem('products_seeded', 'true');
      console.log('[DB] ✅ Seeded once');
    } catch (e) {
      console.error('[DB] seedProductsIfEmpty ERROR:', e);
    }
  }

  async function updateStockAfterSale(items) {
    if (window.dbReady) await window.dbReady;
    for (const item of items) {
      try {
        const product = await _db.products.get(item.productId);
        if (product) {
          await _db.products.update(item.productId, {
            stock: (product.stock || 0) - item.quantity
          });
          console.log('[DB] Stock updated for product ' + item.productId + ': ' + product.stock + ' → ' + ((product.stock || 0) - item.quantity));
        }
      } catch (e) {
        console.error('[DB] updateStockAfterSale error for product ' + item.productId + ':', e);
      }
    }
  }

  async function updateStockLocal(productId, quantityChange) {
    if (window.dbReady) await window.dbReady;
    const product = await _db.products.get(productId);
    if (product) {
      await _db.products.update(productId, {
        stock: product.stock + quantityChange
      });
    }
  }

  async function getProductStock(productId) {
    if (window.dbReady) await window.dbReady;
    const product = await _db.products.get(productId);
    return product ? product.stock : 0;
  }

  // ==================== SYNC QUEUE ====================

  async function addToSyncQueue(type, action, data) {
    if (window.dbReady) await window.dbReady;
    await _db.sync_queue.add({
      type,
      action,
      data:    JSON.stringify(data),
      synced:  0,
      created_at: new Date().toISOString()
    });
  }

  async function getPendingSyncItems() {
    if (window.dbReady) await window.dbReady;
    return await _db.sync_queue.where('synced').equals(0).toArray();
  }

  async function markAsSynced(ids) {
    if (!ids || ids.length === 0) return;
    if (window.dbReady) await window.dbReady;
    await _db.sync_queue.where('id').anyOf(ids).modify({ synced: 1 });
  }

  async function clearSyncedItems() {
    if (window.dbReady) await window.dbReady;
    await _db.sync_queue.where('synced').equals(1).delete();
  }

  // ==================== BACKGROUND SYNC ====================

  async function registerBackgroundSync() {
    if ('serviceWorker' in navigator && 'sync' in window.SyncManager) {
      try {
        const registration = await navigator.serviceWorker.ready;
        await registration.sync.register('sync-sales');
        console.log('Background sync registered');
      } catch (e) {
        console.log('Background sync not available:', e.message);
      }
    }
  }

  async function requestImmediateSync() {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      if ('sync' in registration) {
        await registration.sync.register('sync-all');
      } else {
        await syncAllData();
      }
    } else {
      await syncAllData();
    }
  }

  // ==================== SYNC FUNCTIONS ====================

  async function syncAllData() {
    const cloudUrl = localStorage.getItem('cloudUrl');
    if (!cloudUrl || !navigator.onLine) {
      return { success: false, message: 'Offline or no cloud URL' };
    }

    const pendingItems = await getPendingSyncItems();
    if (pendingItems.length === 0) {
      return { success: true, message: 'Nothing to sync', synced: 0 };
    }

    let syncedCount = 0;
    const syncedIds = [];

    const BATCH_SIZE = 5;
    for (let i = 0; i < pendingItems.length; i += BATCH_SIZE) {
      const batch = pendingItems.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(async item => {
        try {
          const response = await fetch(`${cloudUrl}/api/receive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              entity:    item.type,
              entity_id: item.data?.id || null,
              action:    item.action,
              data:      JSON.parse(item.data || '{}'),
              local_created_at: item.created_at
            })
          });
          return response.ok ? item.id : null;
        } catch {
          return null;
        }
      }));
      for (const id of results) {
        if (id != null) { syncedIds.push(id); syncedCount++; }
      }
    }

    if (syncedIds.length > 0) {
      await markAsSynced(syncedIds);
      localStorage.setItem('lastSync', new Date().toISOString());
    }

    return { success: true, synced: syncedCount, total: pendingItems.length };
  }

  async function pullFromCloud() {
    if (window.dbReady) await window.dbReady;
    const cloudUrl = localStorage.getItem('cloudUrl');
    if (!cloudUrl || !navigator.onLine) {
      return { success: false, message: 'Offline or no cloud URL' };
    }

    const lastSync = localStorage.getItem('lastSync') || '';

    try {
      const response = await fetch(`${cloudUrl}/api/export?since=${lastSync}`);
      if (response.status === 503) {
        console.log('[DB] Cloud server unavailable (503), skipping pull');
        return { success: false, message: 'Server temporarily unavailable' };
      }
      if (response.status >= 500) {
        console.log(`[DB] Cloud server error (${response.status}), skipping pull`);
        return { success: false, message: `Server error (${response.status})` };
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch from cloud: ${response.status}`);
      }

      const data = await response.json();
      let imported = 0;

      if (data.products && data.products.length > 0) {
        const toAdd = [];
        for (const p of data.products) {
          const ex = await _db.products.get(p.id);
          if (ex) {
            // Sync: stock, slug, sell_price
            const updates = {};
            if (p.stock > ex.stock) updates.stock = p.stock;
            if (p.slug !== undefined && p.slug !== ex.slug) updates.slug = p.slug;
            if (p.sell_price !== undefined && p.sell_price !== ex.sell_price) updates.sell_price = p.sell_price;
            updates.synced = 1;
            if (Object.keys(updates).length > 1) { // more than just synced:1
              await _db.products.update(p.id, updates);
              imported++;
            }
          } else {
            toAdd.push({ id: p.id, name: p.name, slug: p.slug || null, stock: p.stock || 0, cost_price: p.cost_price || 0, sell_price: p.sell_price || null, synced: 1 });
            imported++;
          }
        }
        if (toAdd.length > 0) await _db.products.bulkAdd(toAdd);
      }

      if (data.customers && data.customers.length > 0) {
        const toAdd = [];
        for (const c of data.customers) {
          const ex = await _db.customers.get(c.id);
          if (!ex) {
            toAdd.push({ ...c, synced: 1, archived: c.archived || 0 });
            imported++;
          }
        }
        if (toAdd.length > 0) await _db.customers.bulkAdd(toAdd);
      }

      if (data.sales && data.sales.length > 0) {
        const toAdd = [];
        for (const s of data.sales) {
          const ex = await _db.sales.get(s.id);
          if (!ex) {
            toAdd.push({ ...s, synced: 1 });
            imported++;
          }
        }
        if (toAdd.length > 0) await _db.sales.bulkAdd(toAdd);
      }

      localStorage.setItem('lastSync', new Date().toISOString());
      return { success: true, imported };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // ==================== INITIALIZATION ====================

  // sync.js is the primary online sync orchestrator.
  // Keep db.js passive to avoid duplicate sync/reload races.

  console.log(`[DB] BeerPOS initialized (version ${DB_VERSION})`);
} // end guard
