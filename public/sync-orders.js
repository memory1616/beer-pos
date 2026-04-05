// BeerPOS — Order Sync Layer
// Push local unsynced orders to server, pull server orders to local Dexie.
// Uses existing SW IndexedDB queue for offline resilience.

const ORDERS_STORE = 'orders_queue'; // new object store in BeerPOS IndexedDB

// ============ HELPERS ============

function isOnline() {
  return navigator.onLine;
}

function getCloudUrl() {
  return localStorage.getItem('cloudUrl') || '';
}

// ============ OPEN SW INDEXEDDB (same DB as sw.js) ============

// PERFORMANCE: Singleton DB — open once, reuse across all functions.
// Previously every function called openSWDB() again, causing:
//   • ~10ms overhead per open (IndexedDB is async)
//   • New connection per call → race conditions with other openers
//   • "Upgrade blocked" errors when version changed
// Now: one open, resolved promise cached in _dbPromise, all callers await it.

let _dbPromise = null;

// Retry wrapper to handle race conditions with other DB openers (db.js, sw.js)
function getDB() {
  if (!_dbPromise) {
    _dbPromise = openSWDB();
  }
  return _dbPromise;
}

function openSWDB() {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 100;

  function attemptOpen(resolve, reject, attempt) {
    // Open WITHOUT version — db.js is the single source of truth for schema.
    // This context only reads/writes existing stores (orders_queue).
    const request = indexedDB.open('BeerPOS');

    request.onerror = () => {
      if (attempt < MAX_RETRIES) {
        setTimeout(() => attemptOpen(resolve, reject, attempt + 1), RETRY_DELAY);
      } else {
        reject(request.error);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(ORDERS_STORE)) {
        db.createObjectStore(ORDERS_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
  }

  return new Promise((resolve, reject) => attemptOpen(resolve, reject, 0));
}

// ============ PUSH: Save order to server ============

async function pushOrderToServer(order) {
  if (!isOnline()) return { success: false, reason: 'offline' };
  const cloudUrl = getCloudUrl();
  const target = cloudUrl ? cloudUrl + '/api/orders' : '/api/orders';

  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });

    if (res.ok) {
      const data = await res.json();
      return { success: true, serverId: data.id };
    } else {
      const err = await res.json();
      return { success: false, reason: err.error || `HTTP ${res.status}` };
    }
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

// ============ SYNC: Push pending orders to server ============

async function syncPendingOrders() {
  if (!isOnline()) return;
  const cloudUrl = getCloudUrl();
  if (!cloudUrl) return;

  const db = await getDB();
  const tx = db.transaction(ORDERS_STORE, 'readonly');
  const store = tx.objectStore(ORDERS_STORE);
  const index = store.index('synced');

  const pending = await new Promise((resolve, reject) => {
    const req = index.getAll(IDBKeyRange.only(0));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  if (!pending || pending.length === 0) return;

  console.log(`[OrderSync] Pushing ${pending.length} pending orders`);
  const syncedIds = [];

  for (const order of pending) {
    const result = await pushOrderToServer(order.data);
    if (result.success) {
      syncedIds.push(order.id);
    }
  }

  // Mark synced
  if (syncedIds.length > 0) {
    const delTx = db.transaction(ORDERS_STORE, 'readwrite');
    const delStore = delTx.objectStore(ORDERS_STORE);
    syncedIds.forEach(id => {
      const delReq = delStore.delete(id);
      delReq.onsuccess = () => console.log(`[OrderSync] Synced order id ${id}`);
    });
  }
}

// ============ PULL: Fetch orders from server and merge into local Dexie ============

async function pullOrdersFromServer(since) {
  if (!isOnline()) return;
  const cloudUrl = getCloudUrl();
  if (!cloudUrl) return;

  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
  const target = cloudUrl ? cloudUrl + '/api/orders?' + sinceParam.slice(1) : `/api/orders?${sinceParam.slice(1)}`;

  try {
    const res = await fetch(target);
    if (res.status === 503) {
      // Cloud server temporarily unavailable — skip this sync cycle gracefully
      console.log('[OrderSync] Cloud server unavailable (503), skipping pull');
      return;
    }
    if (res.status >= 500) {
      console.log(`[OrderSync] Cloud server error (${res.status}), skipping pull`);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const orders = data.orders || [];

    if (orders.length === 0) return;

    // Merge into Dexie (local)
    const localDB = window.db; // db.js exports `db` as window.db
    if (!localDB) {
      console.warn('[OrderSync] local Dexie not found — make sure db.js is loaded');
      return;
    }

    let imported = 0;
    for (const order of orders) {
      const existing = await localDB.sales.where('id').equals(order.id).first();
      if (!existing) {
        // Insert into Dexie
        await localDB.sales.add({
          id: order.id,
          customer_id: order.customer_id,
          date: order.date,
          total: order.total,
          profit: order.profit,
          deliver_kegs: order.deliver_kegs || 0,
          return_kegs: order.return_kegs || 0,
          type: order.type || 'sale',
          note: order.note || '',
          status: order.status || 'completed',
          synced: 1
        });

        // Insert sale items
        if (order.items && order.items.length > 0) {
          for (const item of order.items) {
            await localDB.sale_items.add({
              sale_id: order.id,
              product_id: item.productId,
              quantity: item.quantity,
              price: item.price || 0,
              cost_price: item.costPrice || 0,
              synced: 1
            });
          }
        }
        imported++;
      } else if (existing.synced === 0) {
        // Local unsynced version takes priority — skip
        console.log(`[OrderSync] Local unsynced order ${order.id} — skipping server version`);
      }
    }

    if (imported > 0) {
      console.log(`[OrderSync] Imported ${imported} orders from server`);
      showToast(`☁️ Đã tải ${imported} đơn mới`, 'success');
    }

    return imported;
  } catch (e) {
    console.error('[OrderSync] Pull failed:', e.message);
  }
}

// ============ CREATE ORDER: Save locally + queue for sync ============

async function createOrder(orderData) {
  // orderData = { customerId, items, total, profit, deliverKegs, returnKegs, type, note }
  const db = await getDB();
  const tx = db.transaction(ORDERS_STORE, 'readwrite');
  const store = tx.objectStore(ORDERS_STORE);

  const orderRecord = {
    customerId: orderData.customerId,
    items: orderData.items,
    total: orderData.total,
    profit: orderData.profit,
    deliverKegs: orderData.deliverKegs || 0,
    returnKegs: orderData.returnKegs || 0,
    type: orderData.type || 'sale',
    note: orderData.note || '',
    created_at: new Date().toISOString(),
    synced: 0
  };

  const id = await new Promise((resolve, reject) => {
    const req = store.add(orderRecord);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  // Try immediate sync if online
  if (isOnline()) {
    const result = await pushOrderToServer(orderRecord);
    if (result.success) {
      // Remove from pending queue
      const delTx = db.transaction(ORDERS_STORE, 'readwrite');
      delTx.objectStore(ORDERS_STORE).delete(id);
      console.log(`[OrderSync] Order ${id} synced immediately`);
      return { id, synced: true };
    }
  }

  console.log(`[OrderSync] Order ${id} queued for later sync`);
  return { id, synced: false };
}

// ============ RETRY: Re-attempt pending sync on network recovery ============

async function retryPendingOrders() {
  console.log('[OrderSync] Retrying pending orders...');
  await syncPendingOrders();
}

// ============ INIT: Auto-pull orders when cloud URL is configured ============

let _lastOrderSync = localStorage.getItem('lastOrderSync') || null;

async function syncOrders() {
  await syncPendingOrders();
  await pullOrdersFromServer(_lastOrderSync);
  _lastOrderSync = new Date().toISOString();
  localStorage.setItem('lastOrderSync', _lastOrderSync);
}

// ============ EXPORTED API ============

window.createOrder = createOrder;
window.syncOrders = syncOrders;
window.syncPendingOrders = syncPendingOrders;
window.pullOrdersFromServer = pullOrdersFromServer;
window.retryPendingOrders = retryPendingOrders;

// ============ AUTO: Pull on page load (if cloud configured) ============

setTimeout(async () => {
  const cloudUrl = getCloudUrl();
  if (!cloudUrl || !isOnline()) return;

  const firstSync = !localStorage.getItem('hasOrderedFirstSync');
  if (firstSync) {
    localStorage.setItem('hasOrderedFirstSync', '1');
    await pullOrdersFromServer(null); // full pull
  } else {
    await syncOrders();
  }
}, 2000);

// ============ AUTO: Retry on reconnect ============

window.addEventListener('online', () => {
  console.log('[OrderSync] Back online — retrying pending orders');
  setTimeout(() => syncPendingOrders(), 2000);
});