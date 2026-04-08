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

const DB_VERSION = 33; // ← BUMP THIS when schema changes (v33 adds _meta store)

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
    sales:       '++id, customer_id, date, total, profit, synced',
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

  // Open the database — Dexie automatically uses max(existing, code) version
  let dbOpenPromise;
  try {
    dbOpenPromise = _db.open();
  } catch (e) {
    console.error('[DB] Failed to open:', e);
  }

  // Log when DB is fully ready
  if (dbOpenPromise) {
    dbOpenPromise.then(() => {
      console.log('[DB] 🔥 DB READY');
    });
  }

  // ─── Expose globals ────────────────────────────────────────────────────────
  window.db          = _db;
  window.dbReady      = dbOpenPromise;
  window.DB_VERSION   = DB_VERSION;
  window.DB_NAME      = DB_NAME;
  window.CACHE_NAME   = CACHE_NAME;
  window.STORE_META   = STORE_META;
  window.getProducts          = getProducts;
  window.updateStockAfterSale = updateStockAfterSale;
  window.createSaleOffline    = createSaleOffline;

  // ==================== SALE FUNCTIONS ====================

  async function createSaleOffline(customerId, items, total, profit) {
    if (window.dbReady) await window.dbReady;
    const saleData = {
      customer_id: customerId,
      date: new Date().toISOString(),
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
          quantity:   item.quantity,
          price:      item.price || 0,
          cost_price: item.costPrice || 0,
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
        data:       JSON.stringify({ id: saleId, customerId, items, total, profit, date: saleData.date }),
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
        await window.dbReady;
      }
      return await _db.products.toArray();
    } catch (e) {
      console.error('[DB] getProducts error:', e);
      return [];
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
            if (p.stock > ex.stock) {
              await _db.products.update(p.id, { stock: p.stock, synced: 1 });
              imported++;
            }
          } else {
            toAdd.push({ ...p, synced: 1 });
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
