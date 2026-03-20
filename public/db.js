// Beer POS - IndexedDB (Dexie.js) for offline-first
// This file provides local database functionality for offline operation

// Create Dexie database
const db = new Dexie('BeerPOS');

// Define schema
db.version(1).stores({
  customers: '++id, name, phone, deposit, keg_balance, archived, synced',
  products: '++id, name, stock, cost_price, synced',
  sales: '++id, customer_id, date, total, profit, synced',
  sale_items: '++id, sale_id, product_id, quantity, price, synced',
  sync_queue: '++id, type, action, data, synced, created_at'
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

  // Add sale to local DB
  const saleId = await db.sales.add(saleData);
  
  // Add sale items and update stock
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
  await addToSyncQueue('sale', 'create', {
    id: saleId,
    customerId,
    items,
    total,
    profit,
    date: saleData.date
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

  for (const item of pendingItems) {
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

      if (response.ok) {
        syncedIds.push(item.id);
        syncedCount++;
      }
    } catch (e) {
      console.error('Sync error:', e.message);
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
    if (!response.ok) {
      throw new Error('Failed to fetch from cloud');
    }

    const data = await response.json();
    let imported = 0;

    // Import products
    if (data.products && data.products.length > 0) {
      for (const product of data.products) {
        const existing = await db.products.get(product.id);
        if (existing) {
          // Update stock if cloud has more
          if (product.stock > existing.stock) {
            await db.products.update(product.id, { stock: product.stock, synced: 1 });
            imported++;
          }
        } else {
          await db.products.add({ ...product, synced: 1 });
          imported++;
        }
      }
    }

    // Import customers
    if (data.customers && data.customers.length > 0) {
      for (const customer of data.customers) {
        const existing = await db.customers.get(customer.id);
        if (!existing) {
          await db.customers.add({ ...customer, synced: 1, archived: customer.archived || 0 });
          imported++;
        }
      }
    }

    // Import sales
    if (data.sales && data.sales.length > 0) {
      for (const sale of data.sales) {
        const existing = await db.sales.get(sale.id);
        if (!existing) {
          await db.sales.add({ ...sale, synced: 1 });
          imported++;
        }
      }
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

// Periodic sync every 60 seconds
setInterval(() => {
  if (navigator.onLine) {
    syncAllData();
  }
}, 60000);

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
