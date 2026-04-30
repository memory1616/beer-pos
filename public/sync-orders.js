// BeerPOS — Order Sync Layer
// Push local unsynced orders to server, pull server orders to local Dexie.
// Uses Dexie (db.js) for all IndexedDB operations — no raw IndexedDB.

const ORDERS_STORE = 'orders_queue';

// ============ HELPERS ============

function isOnline() {
  return navigator.onLine;
}

function getCloudUrl() {
  return localStorage.getItem('cloudUrl') || '';
}

// Resolve the shared Dexie instance from db.js (may still be loading)
async function getOrdersDB() {
  // db.js sets window.db once Dexie is ready
  if (window.db && window.db.tables) {
    const hasTable = window.db.tables.some(t => t.name === ORDERS_STORE);
    if (hasTable) return window.db;
  }
  // Wait a bit and retry (dexie.js loads asynchronously via requestIdleCallback)
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (window.db && window.db.tables) {
      const hasTable = window.db.tables.some(t => t.name === ORDERS_STORE);
      if (hasTable) return window.db;
    }
  }
  throw new Error('[OrderSync] Dexie orders_queue table not found — make sure db.js is loaded and migrated to v40+');
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

  try {
    const db = await getOrdersDB();
    const pending = await db.orders_queue.where('synced').equals(0).toArray();

    if (!pending || pending.length === 0) return;

    console.log(`[OrderSync] Pushing ${pending.length} pending orders`);
    const syncedIds = pending.map(o => o.id);

    for (const order of pending) {
      // order.items is an array of {productId, quantity, price, costPrice}
      const result = await pushOrderToServer(order);
      if (result.success) {
        // Remove from local queue
        await db.orders_queue.delete(order.id);
        console.log(`[OrderSync] Synced order id ${order.id}`);
      }
    }
  } catch (e) {
    if (e.message && e.message.includes('orders_queue')) {
      console.warn('[OrderSync] orders_queue not ready yet, skipping sync cycle:', e.message);
    } else {
      console.error('[OrderSync] syncPendingOrders failed:', e.message);
    }
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

    const localDB = window.db;
    if (!localDB) {
      console.warn('[OrderSync] local Dexie not found — make sure db.js is loaded');
      return;
    }

    let imported = 0;
    for (const order of orders) {
      const existing = await localDB.sales.where('id').equals(order.id).first();
      if (!existing) {
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
        console.log(`[OrderSync] Local unsynced order ${order.id} — skipping server version`);
      }
    }

    if (imported > 0) {
      console.log(`[OrderSync] Imported ${imported} orders from server`);
      if (typeof showToast === 'function') showToast(`☁️ Đã tải ${imported} đơn mới`, 'success');
    }

    return imported;
  } catch (e) {
    console.error('[OrderSync] Pull failed:', e.message);
  }
}

// ============ CREATE ORDER: Save locally + queue for sync ============

async function createOrder(orderData) {
  // orderData = { customerId, items, total, profit, deliverKegs, returnKegs, type, note }
  try {
    const db = await getOrdersDB();
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

    const id = await db.orders_queue.add(orderRecord);

    // Try immediate sync if online
    if (isOnline()) {
      const result = await pushOrderToServer(orderRecord);
      if (result.success) {
        await db.orders_queue.update(id, { synced: 1 });
        console.log(`[OrderSync] Order ${id} synced immediately`);
        return { id, synced: true };
      }
    }

    console.log(`[OrderSync] Order ${id} queued for later sync`);
    return { id, synced: false };
  } catch (e) {
    if (e.message && e.message.includes('orders_queue')) {
      console.warn('[OrderSync] orders_queue not ready — order saved via server API only');
      return await pushOrderToServer(orderData).then(r => ({ id: null, synced: r.success }));
    }
    throw e;
  }
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
