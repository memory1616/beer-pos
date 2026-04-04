// Beer POS - IndexedDB (Dexie.js) for offline-first
// This file provides local database functionality for offline operation

// Guard: prevent re-declaration if already loaded
if (typeof window._dbInit !== 'undefined') {
  // Already initialized, skip
} else {
  window._dbInit = true;

  // Create Dexie database
  const db = new Dexie('BeerPOS');
  window.db = db; // expose for sync-orders.js

  // ── Blocked handler: close stale connections before upgrade ─────────────────
  // IndexedDB v30→v31 upgrade can be blocked by old tabs or cached SW instances
  // holding version 3. Listen for the blocked event and force-close those
  // connections by deleting the version-3 database, then re-open.
  db.on('blocked', () => {
    console.log('[DB] Upgrade blocked — clearing stale DB connections');
    const staleReq = indexedDB.deleteDatabase('BeerPOS');
    staleReq.onsuccess = staleReq.onerror = () => {
      // Give blocked connections a moment to close, then re-open
      setTimeout(() => db.open(), 200);
    };
  });

// Define schema — version 31 forces all contexts (old tabs, cached SW, etc.)
// to a clean state, fixing "Upgrade blocked by other connection holding version 3"
db.version(31).stores({
  customers: '++id, name, phone, deposit, keg_balance, archived, synced',
  products: '++id, name, stock, cost_price, synced',
  sales: '++id, customer_id, date, total, profit, synced',
  sale_items: '++id, sale_id, product_id, quantity, price, synced',
  sync_queue: '++id, entity, action, data, url, method, synced, created_at, retry_count'
}).upgrade(tx => {
  // Add routing fields to existing sales
  return tx.table('sales').toCollection().modify(sale => {
    if (sale.distance_km === undefined) sale.distance_km = null;
    if (sale.duration_min === undefined) sale.duration_min = null;
    if (sale.route_index === undefined) sale.route_index = 0;
    if (sale.route_polyline === undefined) sale.route_polyline = null;
  });
});

// ==================== SALE FUNCTIONS ====================

// Create sale offline - saves to IndexedDB first
async function createSaleOffline(customerId, items, total, profit) {
  const saleData = {
    customer_id: customerId,
    date: new Date().toISOString(),
    total: total,
    profit: profit,
    synced: 0
  };

  // PERFORMANCE: Single transaction for ALL operations — 1x transaction vs N+1
  let saleId;
  await db.transaction('rw', [db.sales, db.sale_items, db.products, db.sync_queue], async () => {
    saleId = await db.sales.add(saleData);

    // Batch all item operations
    for (const item of items) {
      await db.sale_items.add({
        sale_id: saleId,
        product_id: item.productId,
        quantity: item.quantity,
        price: item.price || 0,
        cost_price: item.costPrice || 0,
        synced: 0
      });

      // UPDATE STOCK in local DB
      const product = await db.products.get(item.productId);
      if (product) {
        await db.products.update(item.productId, {
          stock: product.stock - item.quantity
        });
      }
    }

    // Add to sync queue
    await db.sync_queue.add({
      type: 'sale',
      action: 'create',
      data: JSON.stringify({ id: saleId, customerId, items, total, profit, date: saleData.date }),
      synced: 0,
      created_at: new Date().toISOString()
    });
  });

  // Try to register background sync
  registerBackgroundSync();

  return saleId;
}

// ==================== STOCK FUNCTIONS ====================

// Update stock in local DB
async function updateStockLocal(productId, quantityChange) {
  const product = await db.products.get(productId);
  if (product) {
    await db.products.update(productId, {
      stock: product.stock + quantityChange
    });
  }
}

// Get product stock from local DB
async function getProductStock(productId) {
  const product = await db.products.get(productId);
  return product ? product.stock : 0;
}

// ==================== SYNC QUEUE FUNCTIONS ====================

// Helper: Add to sync queue
async function addToSyncQueue(type, action, data) {
  await db.sync_queue.add({
    type,
    action,
    data: JSON.stringify(data),
    synced: 0,
    created_at: new Date().toISOString()
  });
}

// Helper: Get pending sync items
async function getPendingSyncItems() {
  return await db.sync_queue.where('synced').equals(0).toArray();
}

// Helper: Mark as synced
async function markAsSynced(ids) {
  if (!ids || ids.length === 0) return;
  await db.sync_queue.where('id').anyOf(ids).modify({ synced: 1 });
}

// Helper: Clear synced items
async function clearSyncedItems() {
  await db.sync_queue.where('synced').equals(1).delete();
}

// ==================== BACKGROUND SYNC ====================

// Register for background sync
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

// Request immediate sync
async function requestImmediateSync() {
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready;
    if ('sync' in registration) {
      await registration.sync.register('sync-all');
    } else {
      // Fallback to direct sync
      await syncAllData();
    }
  } else {
    await syncAllData();
  }
}

// ==================== SYNC FUNCTIONS ====================

// Sync all pending data to server
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

  // PERFORMANCE: Parallel fetch — N requests simultaneously vs sequential
  const BATCH_SIZE = 5;
  for (let i = 0; i < pendingItems.length; i += BATCH_SIZE) {
    const batch = pendingItems.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async item => {
      try {
        const response = await fetch(`${cloudUrl}/api/receive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity: item.type,
            entity_id: item.data?.id || null,
            action: item.action,
            data: JSON.parse(item.data || '{}'),
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

// Pull data from cloud
async function pullFromCloud() {
  const cloudUrl = localStorage.getItem('cloudUrl');
  if (!cloudUrl || !navigator.onLine) {
    return { success: false, message: 'Offline or no cloud URL' };
  }

  const lastSync = localStorage.getItem('lastSync') || '';

  try {
    const response = await fetch(`${cloudUrl}/api/export?since=${lastSync}`);
    if (response.status === 503) {
      // Cloud server temporarily unavailable — skip this sync cycle gracefully
      console.log('[DB] Cloud server unavailable (503), skipping pull');
      return { success: false, message: 'Server temporarily unavailable' };
    }
    if (response.status >= 500) {
      // Server error — skip this sync cycle
      console.log(`[DB] Cloud server error (${response.status}), skipping pull`);
      return { success: false, message: `Server error (${response.status})` };
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch from cloud: ${response.status}`);
    }

    const data = await response.json();
    let imported = 0;

    // Import products
    // PERFORMANCE: bulkPut/bulkAdd — single IndexedDB operation vs N
    if (data.products && data.products.length > 0) {
      const toAdd = [];
      for (const p of data.products) {
        const ex = await db.products.get(p.id);
        if (ex) {
          // Update stock if cloud has more
          if (p.stock > ex.stock) {
            await db.products.update(p.id, { stock: p.stock, synced: 1 });
            imported++;
          }
        } else {
          toAdd.push({ ...p, synced: 1 });
          imported++;
        }
      }
      if (toAdd.length > 0) await db.products.bulkAdd(toAdd);
    }

    // Import customers
    if (data.customers && data.customers.length > 0) {
      const toAdd = [];
      for (const c of data.customers) {
        const ex = await db.customers.get(c.id);
        if (!ex) {
          toAdd.push({ ...c, synced: 1, archived: c.archived || 0 });
          imported++;
        }
      }
      if (toAdd.length > 0) await db.customers.bulkAdd(toAdd);
    }

    // Import sales
    if (data.sales && data.sales.length > 0) {
      const toAdd = [];
      for (const s of data.sales) {
        const ex = await db.sales.get(s.id);
        if (!ex) {
          toAdd.push({ ...s, synced: 1 });
          imported++;
        }
      }
      if (toAdd.length > 0) await db.sales.bulkAdd(toAdd);
    }

    localStorage.setItem('lastSync', new Date().toISOString());
    return { success: true, imported };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ==================== INITIALIZATION ====================

// Auto sync when online
window.addEventListener('online', () => {
  console.log('Online! Starting sync...');
  syncAllData().then(result => {
    if (result.success && result.synced > 0) {
      console.log(`Synced ${result.synced} items`);
      // Notify UI
      const event = new CustomEvent('syncComplete', { detail: result });
      window.dispatchEvent(event);
    }
  });
  pullFromCloud().then(result => {
    if (result.success && result.imported > 0) {
      console.log(`Imported ${result.imported} items`);
    }
  });
});

// Periodic sync every 5 minutes (sync is handled by sync.js, this is a fallback)
// Disabled to avoid double-sync — uncomment if sync.js is removed
// setInterval(() => {
//   if (navigator.onLine) {
//     syncAllData();
//   }
// }, 300000);

// Initial sync on load
if (navigator.onLine) {
  setTimeout(() => {
    syncAllData();
    pullFromCloud();
  }, 3000);
}

// Listen for messages from Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data && event.data.type === 'SYNC_COMPLETE') {
      console.log('Background sync complete:', event.data.synced);
      // Reload page to update UI
      location.reload();
    }
  });
}

console.log('Dexie.js initialized - BeerPOS offline ready');
} // end guard
