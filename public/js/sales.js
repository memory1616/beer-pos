// Sales Page JavaScript
// Tách riêng để dễ bảo trì và cache
// formatVND, showToast đã được định nghĩa trong utils.js

let products = [];
let priceMap = {};       // { [customerId]: { [productId]: price, [productSlug]: price } }
let customers = [];
let editingSaleId = null;
let saleData = {};
const _LOW_STOCK_THRESHOLD = 30;

// ========== PRICE SYSTEM: Stable slug-based pricing ==========

// PERFORMANCE: O(1) Maps — rebuilt once when data loads, reused for all lookups
let _productById   = new Map();  // id (number) → product object
let _productBySlug = new Map();  // slug (string) → product object
let _customerById  = new Map();

function _rebuildMaps() {
  _productById.clear();
  _productBySlug.clear();
  products.forEach(p => {
    _productById.set(p.id, p);
    if (p.slug) _productBySlug.set(p.slug, p);
  });
  _customerById.clear();
  customers.forEach(c => _customerById.set(c.id, c));
  console.log('[PRICE][_rebuildMaps] products:', _productById.size, 'slugs:', _productBySlug.size);
}

function getProduct(productId) {
  if (!productId && productId !== 0) return null;
  return _productById.get(Number(productId)) || null;
}

function getProductBySlug(slug) {
  if (!slug) return null;
  return _productBySlug.get(String(slug)) || null;
}

function getCustomer(customerId) {
  if (!customerId) return null;
  return _customerById.get(Number(customerId)) || null;
}

// ========== CORE PRICING FUNCTION ==========
// Priority: customer.priceMap by id → customer.priceMap by slug → product.sell_price (basePrice)
// Never returns 0 unless all sources are missing/undefined.

function getEffectivePrice(product, customerId) {
  if (!product) {
    console.warn('[PRICE][getEffectivePrice] WARN: null product');
    return 0;
  }

  const pid = product.id;
  const pslug = product.slug || '';
  const cid = customerId ? String(customerId) : null;

  // 1. Try customer priceMap (by numeric id)
  if (cid && priceMap[cid]) {
    const cmap = priceMap[cid];
    if (cmap[pid] !== undefined && cmap[pid] !== null && cmap[pid] !== '') {
      const p = Number(cmap[pid]);
      if (Number.isFinite(p) && p > 0) {
        console.log('[PRICE][getEffectivePrice] HIT by id:', product.name, 'pid=' + pid, 'cid=' + cid, '→', p);
        return p;
      }
    }
    // 2. Try customer priceMap by slug
    if (cmap._bySlug && cmap._bySlug[pslug] !== undefined && cmap._bySlug[pslug] !== null && cmap._bySlug[pslug] !== '') {
      const p = Number(cmap._bySlug[pslug]);
      if (Number.isFinite(p) && p > 0) {
        console.log('[PRICE][getEffectivePrice] HIT by slug:', product.name, 'slug=' + pslug, 'cid=' + cid, '→', p);
        return p;
      }
    }
  }

  // 3. Fallback to product's base sell_price (retail price)
  const base = product.sell_price != null ? Number(product.sell_price) : 0;
  if (!Number.isFinite(base) || base <= 0) {
    console.warn('[PRICE][getEffectivePrice] WARN: no price for "' + product.name + '" (id=' + pid + ', slug=' + pslug + '), falling back to 0. Set sell_price in DB!');
    return 0;
  }
  console.log('[PRICE][getEffectivePrice] BASE price:', product.name, '→', base);
  return base;
}

// ========== LEGACY COMPATIBILITY (kept for reference — do not use directly) ==========

/** Giá bán mặc định từ sản phẩm */
function effectiveSellPrice(p) {
  if (!p) return 0;
  const v = p.sell_price != null ? p.sell_price : p.price;
  const n = Number(v);
  const result = Number.isFinite(n) ? n : 0;
  if (result === 0) {
    console.warn('[PRICE][effectiveSellPrice] WARN: product "' + (p.name || p.id) + '" has sell_price=' + v + ' → returning 0');
  }
  return result;
}

/** Giá theo khách từ priceMap */
function lookupPriceMap(customerId, productId) {
  if (!customerId || customerId === '' || !priceMap) return undefined;
  const row = priceMap[customerId] || priceMap[Number(customerId)];
  if (!row) return undefined;
  const v = row[productId] ?? row[Number(productId)];
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

// ========== PRICE APPLICATION (called on customer change) ==========

/**
 * Áp giá hiển thị khi có khách.
 * apiPrices: array of { product_id, price } from API (highest priority)
 * Falls back to priceMap, then product.sell_price
 */
function applyResolvedPrices(customerId, apiPrices) {
  if (!customerId) {
    products.forEach(p => {
      const defPrice = getEffectivePrice(p, null); // null = no customer = base price
      p._displayPrice = defPrice;
      if (saleData[p.id]) {
        saleData[p.id].price = defPrice;
      }
    });
    return;
  }

  const cid = String(customerId);
  console.log('[PRICE][applyResolvedPrices] customerId:', customerId, '→', cid);

  products.forEach(p => {
    let resolvedPrice = null;

    // Priority 1: API price (freshest from server)
    if (Array.isArray(apiPrices)) {
      const apiRow = apiPrices.find(x =>
        x.product_id === p.id ||
        x.product_id === String(p.id) ||
        (p.slug && (x.product_slug === p.slug || x.productSlug === p.slug))
      );
      if (apiRow && apiRow.price != null && apiRow.price !== '') {
        const priceVal = Number(apiRow.price);
        if (Number.isFinite(priceVal) && priceVal > 0) {
          resolvedPrice = priceVal;
          console.log('[PRICE][applyResolvedPrices] [' + p.name + '] ← API:', priceVal);
        }
      }
    }

    // Priority 2: priceMap from /sale/data
    if (resolvedPrice === null && priceMap[cid]) {
      const cmap = priceMap[cid];
      // Try by numeric id
      if (cmap[p.id] !== undefined && cmap[p.id] !== null && cmap[p.id] !== '') {
        const pr = Number(cmap[p.id]);
        if (Number.isFinite(pr) && pr > 0) resolvedPrice = pr;
      }
      // Try by slug
      if (resolvedPrice === null && cmap._bySlug && p.slug) {
        const pr = Number(cmap._bySlug[p.slug]);
        if (Number.isFinite(pr) && pr > 0) resolvedPrice = pr;
      }
      if (resolvedPrice !== null) {
        console.log('[PRICE][applyResolvedPrices] [' + p.name + '] ← priceMap:', resolvedPrice);
      }
    }

    // Priority 3: product base sell_price (LAST RESORT — must be > 0)
    if (resolvedPrice === null) {
      resolvedPrice = getEffectivePrice(p, null); // null customer = base price
      if (resolvedPrice > 0) {
        console.log('[PRICE][applyResolvedPrices] [' + p.name + '] ← base:', resolvedPrice);
      } else {
        console.warn('[PRICE][applyResolvedPrices] [' + p.name + '] ← NO PRICE (will show 0!)');
      }
    }

    p._displayPrice = resolvedPrice;
    if (saleData[p.id] && saleData[p.id].price === 0) {
      saleData[p.id].price = resolvedPrice;
    }
  });
}

// ========== DEBOUNCE & SYNC HELPERS ==========

/** PERFORMANCE: Debounce — coalesces rapid keystrokes so updateSaleTotal runs once */
function _debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function syncSaleEditAuxSheet() {
  const sheet = document.getElementById('saleEditAuxSheet');
  const repBtn = document.getElementById('replacementOpenBtn');
  const editing = editingSaleId != null;
  if (sheet) sheet.classList.toggle('hidden', !editing);
  if (repBtn) {
    repBtn.disabled = editing;
    repBtn.classList.toggle('opacity-50', editing);
    repBtn.classList.toggle('cursor-not-allowed', editing);
    repBtn.classList.toggle('pointer-events-none', editing);
  }
}

// Sales history state (mirrors purchases.js pattern — primary data source)
var allSales    = [];       // local array for optimistic insert
var historyCurrentPage = 1; // page 1 default

function syncSalesState(nextSales) {
  allSales = Array.isArray(nextSales) ? nextSales.slice() : [];
  window.store.sales = allSales;
  return allSales;
}

async function refetchSalesHistory() {
  await loadSalesHistory();
}

var HISTORY_PAGE_SIZE  = 5;

// ========== PAGE INITIALIZATION ==========

function initSalesPage(data) {
  console.log('[Sales] initSalesPage START');
  products = data.products || [];
  customers = data.customers || [];

  // Rebuild priceMap with slug index
  priceMap = {};
  if (data.priceMap) {
    Object.entries(data.priceMap).forEach(([cid, cmap]) => {
      priceMap[String(cid)] = { ...cmap };
      // If cmap has _bySlug already (from server), keep it
      if (cmap._bySlug) priceMap[String(cid)]._bySlug = cmap._bySlug;
    });
  }

  console.log('[Sales] priceMap from server:', Object.keys(priceMap).length, 'customers');
  console.log('[Sales] products:', products.length, 'items');
  if (products.length > 0) {
    console.log('[Sales] products[0]:', JSON.stringify({ id: products[0].id, slug: products[0].slug, name: products[0].name, sell_price: products[0].sell_price }));
  }

  _rebuildMaps();
  console.log('[Sales] _rebuildMaps DONE');

  // Render customer dropdown (searchable)
  renderCustomerDropdown();
  console.log('[Sales] customerDropdown rendered');

  // Apply prices — starts with no customer (base prices)
  updatePrices();
  console.log('[Sales] updatePrices DONE');

  // Load keg state for inventory validation
  console.log('[Sales] fetching /api/kegs/state...');
  fetch('/api/kegs/state')
    .then(function(res) { console.log('[Sales] /api/kegs/state response:', res.status); return res.json(); })
    .then(function(state) { kegState = state || {}; console.log('[Sales] kegState loaded:', Object.keys(kegState).length, 'entries'); })
    .catch(function() { kegState = {}; });

  // Load history
  console.log('[Sales] calling loadSalesHistory...');
  loadSalesHistory();
  console.log('[Sales] loadSalesHistory returned (async, will log when done)');

  syncSaleEditAuxSheet();
  console.log('[Sales] initSalesPage DONE');
}

// Global keg state for validation
let kegState = {};

// ── Searchable Customer Dropdown ────────────────────────────────────────────
function renderCustomerDropdown(filter) {
  filter = (filter || '').toLowerCase().trim();
  var dd = document.getElementById('customerDropdown');
  if (!dd) return;
  var selectedId = document.getElementById('customerSelect')?.value || '';

  if (filter === '') {
    dd.innerHTML = '<div style="padding:10px 14px;color:var(--text-muted);font-size:12px;">📋 Khách lẻ (giá thường)</div>' +
      '<div class="customer-dd-item' + (!selectedId ? ' active' : '') + '" onclick="selectCustomer(\'\', \'Khách lẻ\')">📋 Khách lẻ (giá thường)</div>' +
      customers.map(function(c) {
        return '<div class="customer-dd-item' + (String(c.id) === String(selectedId) ? ' active' : '') + '" onclick="selectCustomer(\'' + c.id + '\', \'' + c.name.replace(/'/g, '\\\'') + '\')">' +
          '<span>' + c.name + '</span><span style="font-size:11px;color:var(--text-muted);margin-left:8px;">' + (c.keg_balance || 0) + ' vỏ</span></div>';
      }).join('');
  } else {
    var filtered = customers.filter(function(c) { return c.name.toLowerCase().includes(filter); });
    if (filtered.length === 0) {
      dd.innerHTML = '<div style="padding:12px 14px;color:var(--text-muted);font-size:13px;text-align:center;">Không tìm thấy khách hàng</div>';
    } else {
      dd.innerHTML = '<div style="padding:10px 14px;color:var(--text-muted);font-size:12px;">📋 Khách lẻ (giá thường)</div>' +
        '<div class="customer-dd-item' + (!selectedId ? ' active' : '') + '" onclick="selectCustomer(\'\', \'Khách lẻ\')">📋 Khách lẻ (giá thường)</div>' +
        filtered.map(function(c) {
          return '<div class="customer-dd-item' + (String(c.id) === String(selectedId) ? ' active' : '') + '" onclick="selectCustomer(\'' + c.id + '\', \'' + c.name.replace(/'/g, '\\\'') + '\')">' +
            '<span>' + c.name + '</span><span style="font-size:11px;color:var(--text-muted);margin-left:8px;">' + (c.keg_balance || 0) + ' vỏ</span></div>';
        }).join('');
    }
  }
}

function filterCustomerOptions(value) {
  renderCustomerDropdown(value);
  showCustomerDropdown(true);
}

function showCustomerDropdown(show) {
  var dd = document.getElementById('customerDropdown');
  if (!dd) return;
  if (show) {
    dd.classList.remove('hidden');
    renderCustomerDropdown(document.getElementById('customerSearch')?.value || '');
  } else {
    dd.classList.add('hidden');
  }
}

function selectCustomer(id, name) {
  var hiddenInput = document.getElementById('customerSelect');
  var searchInput = document.getElementById('customerSearch');
  if (hiddenInput) hiddenInput.value = id;
  if (searchInput) searchInput.value = name || '';
  showCustomerDropdown(false);
  updatePrices();
}

function onCustomerSelected() {
  updatePrices();
}

document.addEventListener('click', function(e) {
  var searchInput = document.getElementById('customerSearch');
  var dd = document.getElementById('customerDropdown');
  if (!searchInput || !dd) return;
  if (!searchInput.contains(e.target) && !dd.contains(e.target)) {
    showCustomerDropdown(false);
  }
});

// ── Render Sale Products ────────────────────────────────────────────────────
function renderSaleProducts() {
  var container = document.getElementById('saleProducts');
  if (!container) {
    console.warn('[UI] Element not found: #saleProducts — renderSaleProducts skipped');
    return;
  }
  var customerIdEl = document.getElementById('customerSelect');
  var customerId = customerIdEl ? customerIdEl.value : '';
  var isKhachLe = !customerId;

  // Layout giống Nhập hàng: thẻ từng SP, tên + 1 dòng giá/tồn + ô Nhập SL
  container.innerHTML = products.map(p => {
    const defUnit = p._displayPrice != null ? Number(p._displayPrice) : effectiveSellPrice(p);
    const price = Number.isFinite(defUnit) ? defUnit : effectiveSellPrice(p);
    if (price === 0) {
      console.log('[RENDER][WARN] product "' + p.name + '" has price=0! _displayPrice=' + p._displayPrice + ', sell_price=' + p.sell_price);
    }
    const currentPrice = (saleData[p.id] && saleData[p.id].price !== undefined) ? saleData[p.id].price : effectiveSellPrice(p);
    const priceInputVal = (saleData[p.id] && saleData[p.id].price !== undefined)
      ? saleData[p.id].price
      : (effectiveSellPrice(p) || '');
    const isLowStock = p.stock < _LOW_STOCK_THRESHOLD;
    const currentQty = saleData[p.id] ? saleData[p.id].quantity : '';
    const priceLine = isKhachLe
      ? `· Tồn: <span class="${p.stock < _LOW_STOCK_THRESHOLD ? 'text-danger font-semibold' : 'text-secondary'}">${p.stock}</span>`
      : `Giá: <span class="text-primary font-bold">${formatVND(price)}</span> · Tồn: <span class="${p.stock < _LOW_STOCK_THRESHOLD ? 'text-danger' : 'text-secondary'}">${p.stock}</span>`;
    const priceField = isKhachLe
      ? `<label class="block text-xs font-semibold text-primary mt-2 mb-1">Giá bán (đ)</label>
        <input type="number" id="price-${p.id}" min="0" step="1000" value="${priceInputVal}" placeholder="Nhập giá"
          inputmode="decimal" enterkeyhint="done"
          class="w-full border-2 border-primary rounded-xl p-3 text-center text-lg font-bold text-main focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
          onchange="updateSaleData(${p.id}, 'price', this.value);"
          oninput="updateSaleData(${p.id}, 'price', this.value);">`
      : '';
    return `
      <div class="p-3 border-2 ${isLowStock ? 'border-warning bg-warning/5' : 'border-primary bg-primary/5'} rounded-xl transition-all">
        <div class="text-sm font-bold text-main">${p.name}</div>
        <div class="text-xs text-secondary mt-0.5">${priceLine}</div>
        ${priceField}
        <div class="flex items-center gap-2 mt-2">
          <button type="button" onclick="quickAddProduct(${p.id}, -1)" class="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-lg border-2 ${currentQty > 0 ? 'border-primary text-primary' : 'border-primary/40 text-primary/50'} font-bold text-lg select-none transition-all active:scale-95">−</button>
          <input type="number" id="qty-${p.id}" min="0" max="${p.stock}" value="${currentQty > 0 ? currentQty : ''}" data-stock="${p.stock}"
            placeholder="SL"
            inputmode="numeric" enterkeyhint="done"
            class="flex-1 h-10 border-2 border-primary rounded-xl text-center text-lg font-bold focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none ${currentQty > 0 ? 'bg-primary/10' : 'bg-white'} text-main min-w-0"
            onchange="updateSaleData(${p.id}, 'quantity', this.value);"
            oninput="updateSaleData(${p.id}, 'quantity', this.value);">
          <button type="button" onclick="quickAddProduct(${p.id}, 1)" class="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-lg border-2 border-primary bg-primary text-1E2329 font-bold text-lg select-none transition-all active:scale-95">+</button>
          ${!isKhachLe ? `<button type="button" onclick="quickAddProduct(${p.id}, 5)" class="flex-shrink-0 px-2 h-10 rounded-lg border-2 border-primary/40 text-primary font-semibold text-xs select-none transition-all active:scale-95">+5</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// Quick-add: tap + hoặc − trên thẻ sản phẩm — tăng UX bán hàng nhanh
function quickAddProduct(productId, delta) {
  var input = document.getElementById('qty-' + productId);
  if (!input) return;
  var current = parseInt(input.value) || 0;
  var stock = parseInt(input.dataset.stock) || 999;
  var newVal = Math.max(0, Math.min(current + delta, stock));
  var wasEmpty = current === 0 && newVal > 0;
  input.value = newVal;
  updateSaleData(productId, 'quantity', newVal);
  if (wasEmpty) {
    // Toast feedback: đã thêm sản phẩm đầu tiên
    var product = getProduct(productId);
    if (product && typeof showToast === 'function') {
      showToast('Đã thêm ' + product.name + ' x' + newVal, 'success');
    }
  }
}

// Quick adjust quantity (inline -10, -, +, +10)
function adjustQty(productId, amount) {
  haptic && haptic('light');
  const input = document.getElementById('qty-' + productId);
  if (!input) return;
  const current = parseInt(input.value) || 0;
  const product = getProduct(productId);
  const maxStock = product ? product.stock : 999;
  
  let newValue = current + amount;
  if (newValue < 0) newValue = 0;
  if (newValue > maxStock) newValue = maxStock;
  
  input.value = newValue;
  updateSaleData(productId, 'quantity', newValue);
  updateSaleTotal();
}

// Toggle quantity control modal
let currentEditingProduct = null;

function toggleQtyControl(productId) {
  const product = getProduct(productId);
  if (!product) return;
  
  currentEditingProduct = productId;
  const currentQty = saleData[productId] ? saleData[productId].quantity : '';
  const currentPrice = saleData[productId]
    ? saleData[productId].price
    : (product._displayPrice != null ? Number(product._displayPrice) : effectiveSellPrice(product));
  
  const modal = document.createElement('div');
  modal.id = 'qtyModal';
  modal.className = 'fixed inset-0 bg-overlay flex items-end z-50';
  modal.onclick = function(e) {
    if (e.target === modal) closeQtyModal();
  };
  
  modal.innerHTML = `
    <div class="card w-full max-w-md mx-auto rounded-t-2xl p-5 pb-8">
      <div class="card mb-4">
        <div class="flex justify-between items-start">
          <div class="flex-1">
            <div class="font-semibold text-main break-words whitespace-normal text-lg">${product.name}</div>
            <div class="text-sm text-secondary mt-1">Tồn kho: ${product.stock}</div>
          </div>
          <button onclick="closeQtyModal()" class="text-muted text-2xl ml-2">&times;</button>
        </div>
      </div>

      <div class="flex items-center justify-between gap-6 mb-6">
        <button type="button" onclick="adjustQtyModal(${productId}, -1); haptic('light')" class="btn btn-ghost flex-1 h-14 text-xl font-bold">-</button>
        <input type="number" id="qty-${productId}" min="0" max="${product.stock}" value="${currentQty}"
          inputmode="numeric" enterkeyhint="done" autofocus
          class="flex-1 h-14 border-2 border-primary rounded-xl text-center text-2xl font-bold focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
          onchange="updateSaleData(${productId}, 'quantity', this.value)"
          oninput="updateSaleData(${productId}, 'quantity', this.value)">
        <button type="button" onclick="adjustQtyModal(${productId}, 1); haptic('light')" class="btn btn-primary flex-1 h-14 text-xl font-bold">+</button>
      </div>

      <div class="flex items-center justify-center gap-3 mb-6">
        <button type="button" onclick="adjustQtyModal(${productId}, 1); haptic('light')" class="btn btn-warning flex-1 py-3 text-sm font-bold">+1</button>
        <button type="button" onclick="adjustQtyModal(${productId}, 5); haptic('light')" class="btn btn-warning flex-1 py-3 text-sm font-bold">+5</button>
        <button type="button" onclick="adjustQtyModal(${productId}, 10); haptic('light')" class="btn btn-warning flex-1 py-3 text-sm font-bold">+10</button>
        <button type="button" onclick="adjustQtyModal(${productId}, 20); haptic('light')" class="btn btn-warning flex-1 py-3 text-sm font-bold">+20</button>
      </div>

      <div class="mb-4">
        <label class="block text-sm font-medium text-main mb-2">Giá bán</label>
        <input type="number" id="price-${productId}" step="1000" value="${currentPrice}"
          inputmode="decimal" enterkeyhint="done"
          class="w-full border-2 border-primary rounded-xl px-4 py-3 text-right text-xl font-bold focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
          onchange="updateSaleData(${productId}, 'price', this.value)"
          oninput="updateSaleData(${productId}, 'price', this.value)">
      </div>

      <button onclick="closeQtyModal(); haptic('medium')" class="btn btn-primary w-full h-14 text-xl">
        Xác nhận
      </button>
    </div>
  `;
  
  document.body.appendChild(modal);
}

function adjustQtyModal(productId, amount) {
  var input = document.getElementById('qty-' + productId);
  if (!input) return;
  var current = parseInt(input.value) || 0;
  const product = getProduct(productId);
  const maxStock = product ? product.stock : 999;
  
  let newValue = current + amount;
  if (newValue < 0) newValue = 0;
  if (newValue > maxStock) newValue = maxStock;
  
  input.value = newValue;
  updateSaleData(productId, 'quantity', newValue);
}

function closeQtyModal() {
  const modal = document.getElementById('qtyModal');
  if (modal) modal.remove();
}

function updateSaleData(productId, field, value) {
  if (!saleData[productId]) {
    const product = getProduct(productId);
    const customerIdEl = document.getElementById('customerSelect');
    const customerId = customerIdEl ? customerIdEl.value : '';
    // Use getEffectivePrice which checks: customer price > base price
    const initPrice = product ? getEffectivePrice(product, customerId) : 0;
    saleData[productId] = {
      quantity: 0,
      price: initPrice
    };
    console.log('[Sales][updateSaleData] new item, product=' + (product ? product.name : 'unknown') + ', price=' + initPrice);
  }
  
  // STEP 6: Input validation - prevent NaN and invalid values
  if (field === 'quantity') {
    const parsed = parseInt(value);
    saleData[productId].quantity = (isNaN(parsed) || parsed < 0) ? 0 : parsed;
  } else if (field === 'price') {
    const parsed = parseFloat(value);
    saleData[productId].price = (isNaN(parsed) || parsed < 0) ? 0 : parsed;
  }

  _debouncedUpdateTotal();
  autoFillKegFromCart();
}

// Track if user manually edited keg inputs (don't auto-overwrite manual edits)
let _kegDeliverManual = false;
let _kegReturnManual = false;

function autoFillKegFromCart() {
  const customerId = document.getElementById('customerSelect')?.value;
  if (!customerId) return;

  // Auto-fill "Giao vỏ" = total keg qty in cart (only if user hasn't manually typed)
  if (!_kegDeliverManual) {
    const totalKegQty = Object.keys(saleData).reduce((sum, productId) => {
      const item = saleData[productId];
      const product = getProduct(productId);
      if (item.quantity > 0 && product && product.type !== 'pet' && product.type !== 'box') {
        return sum + item.quantity;
      }
      return sum;
    }, 0);
    const input = document.getElementById('saleDeliverKegs');
    if (input && (input.value === '0' || input.value === '')) {
      input.value = totalKegQty;
      updateSaleKegPreview();
    }
  }
}

function updateSaleTotal() {
  let total = 0;
  let hasItems = false;
  let itemCount = 0;
  let cartHtml = '';
  
  Object.keys(saleData).forEach(productId => {
    const item = saleData[productId];
    if (item.quantity > 0 && item.price > 0) {
      const product = getProduct(productId);
      const lineTotal = item.quantity * item.price;
      total += lineTotal;
      hasItems = true;
      itemCount += item.quantity;
      const name = product ? product.name : 'SP';
      cartHtml += '<div class="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-sm py-1.5 border-b border-primary/20 last:border-0">' +
        '<span class="font-semibold text-main min-w-0 flex-1 truncate">' + name + '</span>' +
        '<span class="text-secondary shrink-0 tabular-nums">' + Format.number(item.price) + ' đ × ' + item.quantity + '</span>' +
        '<div class="money text-money shrink-0 w-full text-right sm:w-auto sm:text-left"><span class="value text-sm font-bold tabular-nums">' + Format.number(lineTotal) + '</span><span class="unit">đ</span></div></div>';
    }
  });
  
  const totalEl = document.getElementById('totalAmount');
  if (totalEl) {
    const formatted = Format.number(total);
    totalEl.innerHTML = '<span class="value">' + formatted + '</span><span class="unit"> đ</span>';
  }
  
  const itemCountEl = document.getElementById('itemCount');
  if (itemCountEl) itemCountEl.textContent = itemCount + ' items';
  
  const cartEl = document.getElementById('cartItems');
  if (cartEl) cartEl.innerHTML = cartHtml || '<div class="text-muted text-center">Chưa có sản phẩm</div>';

  const previewEl = document.getElementById('saleCartPreview');
  if (previewEl) {
    if (!cartHtml) {
      previewEl.innerHTML = '<div class="max-h-40 overflow-y-auto">' + cartHtml + '</div>';
    } else {
      previewEl.innerHTML = '<div class="text-xs font-bold text-primary mb-1">Đơn đang bán</div><div class="max-h-40 overflow-y-auto">' + cartHtml + '</div>';
    }
  }

  const sellBtn = document.getElementById('sellBtn');
  if (sellBtn) {
    const editing = editingSaleId != null;
    const canSell = !editing && hasItems;
    sellBtn.disabled = !canSell;
    if (canSell) {
      sellBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      sellBtn.classList.add('shadow-md', 'hover:from-green-600', 'hover:to-green-700');
    } else {
      sellBtn.classList.add('opacity-50', 'cursor-not-allowed');
      sellBtn.classList.remove('shadow-md', 'hover:from-green-600', 'hover:to-green-700');
    }
  }
}

function updateKegSaleSection(customerId) {
  const section = document.getElementById('kegSaleSection');
  if (!section) return;

  const deliverInput = document.getElementById('saleDeliverKegs');
  const returnInput = document.getElementById('saleReturnKegs');
  const balanceEl = document.getElementById('saleKegBalance');
  const afterEl = document.getElementById('saleKegAfter');
  const warningEl = document.getElementById('saleKegWarning');

  if (!customerId) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  const customer = getCustomer(customerId);
  const currentBalance = customer ? (customer.keg_balance || 0) : 0;
  if (balanceEl) balanceEl.textContent = currentBalance + ' vỏ';

  // Reset manual flags when switching customer (allow auto-fill again)
  _kegDeliverManual = false;
  _kegReturnManual = false;

  updateSaleKegPreview();
  autoFillKegFromCart();
}

function updateSaleKegPreview() {
  var customerIdEl = document.getElementById('customerSelect');
  var deliverInput = document.getElementById('saleDeliverKegs');
  var returnInput = document.getElementById('saleReturnKegs');
  var balanceEl = document.getElementById('saleKegBalance');
  var afterEl = document.getElementById('saleKegAfter');
  var warningEl = document.getElementById('saleKegWarning');

  var customerId = customerIdEl ? customerIdEl.value : '';
  var deliver = parseInt(deliverInput ? deliverInput.value : '0') || 0;
  var returned = parseInt(returnInput ? returnInput.value : '0') || 0;

  var customer = getCustomer(customerId);
  var currentBalance = customer ? (customer.keg_balance || 0) : 0;
  var afterBalance = currentBalance + deliver - returned;

  if (afterEl) afterEl.textContent = afterBalance + ' vỏ';
  if (balanceEl) balanceEl.textContent = currentBalance + ' vỏ';

  if (kegState && deliver > kegState.inventory) {
    if (warningEl) {
      warningEl.classList.remove('hidden');
      warningEl.textContent = '⚠️ Không đủ vỏ! Kho chỉ còn ' + (kegState.inventory || 0) + ' vỏ';
    }
  } else {
    if (warningEl) warningEl.classList.add('hidden');
  }
}

// Quick add product for fast sales
function quickAddProduct(amount) {
  var customerIdEl = document.getElementById('customerSelect');
  var customerId = customerIdEl ? customerIdEl.value : '';
  if (!customerId) {
    alert('Vui lòng chọn khách hàng trước');
    return;
  }

  var availableProducts = products.filter(function(p) { return p.stock > 0; });
  if (availableProducts.length === 0) {
    alert('Không có sản phẩm trong kho');
    return;
  }

  var product = availableProducts[0];
  var input = document.getElementById('qty-' + product.id);
  if (!input) return;
  var currentQty = parseInt(input.value) || 0;
  var maxAdd = product.stock - currentQty;
  var toAdd = Math.min(amount, maxAdd);

  if (toAdd <= 0) {
    alert('Sản phẩm ' + product.name + ' đã hết hàng');
    return;
  }

  input.value = currentQty + toAdd;
  updateSaleData(product.id, 'quantity', currentQty + toAdd);
  updateSaleTotal();
}

// Change quantity with +/- buttons
function changeQty(productId, delta) {
  const input = document.getElementById('qty-' + productId);
  if (input) {
    const currentVal = parseInt(input.value) || 0;
    const stock = parseInt(input.max) || 999;
    const newVal = Math.max(0, Math.min(currentVal + delta, stock));
    input.value = newVal;
    updateSaleData(productId, 'quantity', newVal);
    updateSaleTotal();
  }
}

function updatePrices() {
  var customerIdEl = document.getElementById('customerSelect');
  var customerId = customerIdEl ? customerIdEl.value : '';

  console.log('[PRICE][updatePrices] called, customerId="' + customerId + '", priceMap keys:', Object.keys(priceMap || {}).slice(0, 10));
  console.log('[PRICE][updatePrices] priceMap sample:', JSON.stringify(Object.entries(priceMap || {}).slice(0, 2)));

  applyResolvedPrices(customerId, null);
  renderSaleProducts();
  updateSaleTotal();
  updateKegSaleSection(customerId);

  if (!customerId || !navigator.onLine) {
    return;
  }

  fetch('/api/products/prices?customerId=' + encodeURIComponent(customerId))
    .then(res => {
      if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      }
      return res.json();
    })
    .then(prices => {
      if (!Array.isArray(prices)) {
        return;
      }
      console.log('[PRICE][updatePrices] API prices response:', prices.length, 'items');
      applyResolvedPrices(customerId, prices);
      renderSaleProducts();
      updateSaleTotal();
    })
    .catch(err => {
      console.error('Error loading prices:', err);
      // Giữ giá từ priceMap + sell_price (đã áp ở trên)
    });
}

function updateCartFromInputs() {
  var customerIdEl = document.getElementById('customerSelect');
  var customerId = customerIdEl ? customerIdEl.value : '';
  if (!customerId) {
    alert('Vui lòng chọn khách hàng trước');
    var selectEl = document.getElementById('customerSelect');
    if (selectEl) selectEl.focus();
    return;
  }

  cart = [];
  var total = 0;

  products.forEach(function(p) {
    var input = document.getElementById('qty-' + p.id);
    var qty = parseInt(input ? input.value : '0') || 0;
    if (qty > 0) {
      var productId = p.id;
      var stock = input ? (parseInt(input.max) || 0) : 0;
      var costPrice = p.cost_price || 0;
      var price = p._displayPrice != null ? Number(p._displayPrice) : effectiveSellPrice(p);

      if (qty > stock && stock > 0) {
        alert('Sản phẩm ' + p.name + ' không đủ tồn kho');
        if (input) input.value = stock;
        qty = stock;
      }

      cart.push({ productId: productId, quantity: qty, price: price, costPrice: costPrice });
      total += price * qty;
    }
  });

  var totalEl = document.getElementById('totalAmount');
  if (totalEl) {
    totalEl.innerHTML = '<span class="value">' + Format.number(total) + '</span><span class="unit"> đ</span>';
  }
  var sellBtnEl = document.getElementById('sellBtn');
  if (sellBtnEl) sellBtnEl.disabled = cart.length === 0;
}

async function submitSale() {
  var customerIdEl = document.getElementById('customerSelect');
  var customerId = customerIdEl ? customerIdEl.value : '';

  // Build items from saleData - include productSlug for stable reference
  var items = [];
  Object.keys(saleData).forEach(function(productId) {
    var item = saleData[productId];
    if (item.quantity > 0 && item.price > 0) {
      var product = getProduct(productId);
      items.push({
        productId: parseInt(productId),
        productSlug: product ? product.slug : null,
        quantity: item.quantity,
        price: item.price,
        priceAtTime: item.price
      });
    }
  });

  if (items.length === 0) return showToast('Chưa chọn sản phẩm nào', 'error');

  var sellDeliverEl = document.getElementById('saleDeliverKegs');
  var deliverKegs = parseInt(sellDeliverEl ? sellDeliverEl.value : '0') || 0;
  if (deliverKegs > 0 && kegState.inventory < deliverKegs) {
    return showToast('Không đủ vỏ! Kho chỉ còn ' + kegState.inventory + ' vỏ', 'error');
  }

  let total = items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  if (total === 0) return showToast('Tổng tiền bằng 0, vui lòng kiểm tra lại giá sản phẩm', 'error');

  for (const item of items) {
    if (!item.quantity || item.quantity <= 0) {
      return showToast('Số lượng sản phẩm phải lớn hơn 0', 'error');
    }
    if (!item.price || item.price < 0) {
      return showToast('Giá sản phẩm không hợp lệ', 'error');
    }
  }

  const btn = document.getElementById('sellBtn');
  var btnState = btn ? setButtonLoading(btn, 'Đang xử lý') : null;

  const payload = {
    customerId: customerId ? parseInt(customerId) : null,
    items: items,
    deliverKegs: deliverKegs,
    returnKegs: parseInt(document.getElementById('saleReturnKegs')?.value) || 0
  };

  try {
    var res = await fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store'
    });
    var result;
    try { result = await res.json(); } catch (_) { result = {}; }
    if (!res.ok) throw new Error(result.error || 'Bán hàng thất bại');

    haptic && haptic('success');

    // Clear cart UI immediately
    saleData = {};
    var _cs1 = document.getElementById('customerSelect');
    if (_cs1) _cs1.value = '';
    var _dK = document.getElementById('saleDeliverKegs');
    var _rK = document.getElementById('saleReturnKegs');
    if (_dK) _dK.value = 0;
    if (_rK) _rK.value = 0;
    _kegDeliverManual = false;
    _kegReturnManual = false;
    applyResolvedPrices('', null);
    renderSaleProducts();
    updateSaleTotal();
    updateKegSaleSection('');

    showToast('Bán hàng thành công!', 'success');

    if (salesPagination.page === 1) {
      loadSalesHistory();
    } else {
      salesPagination.page = 1;
      loadSalesHistory();
    }

    try {
      showInvoiceModal(result.id);
    } catch(err) {
      console.error('Lỗi hiển thị hóa đơn:', err);
      var modal = document.getElementById('invoiceModal');
      var invoiceContent = document.getElementById('invoiceContent');
      var qrCodeEl = document.getElementById('qrCode');
      if (modal) {
        var invTotalEl = modal.querySelector('.invoice-total-value');
        if (invTotalEl) invTotalEl.textContent = Format.number(result.total || 0);
        if (invoiceContent) invoiceContent.innerHTML =
          '<div class="text-center text-secondary py-8">Đơn hàng #' + result.id + '</div>';
        if (qrCodeEl) qrCodeEl.src = '';
        modal.classList.remove('hidden');
        modal.classList.add('flex');
      }
    }

    // REFETCH products from server to sync stock after sale
    fetch('/api/products', { cache: 'no-store' })
      .then(function(res) { return res.json(); })
      .then(async function(serverProducts) {
        products = serverProducts;
        window.store.products = serverProducts;
        _rebuildMaps();
        renderSaleProducts();

        // Also sync IndexedDB to keep stock page in sync
        try {
          if (window.db && window.dbReady) {
            await window.dbReady.catch(() => {});
            await window.db.products.clear();
            await window.db.products.bulkAdd(serverProducts.map(function(p) {
              return {
                id: p.id,
                name: p.name,
                stock: p.stock,
                cost_price: p.cost_price,
                type: p.type,
                synced: 1,
                archived: p.archived || 0
              };
            }));
            console.log('[Sales] IndexedDB synced after sale');
          }
        } catch (e) {
          console.warn('[Sales] Could not sync IndexedDB:', e.message || e);
        }
      })
      .catch(function(err) {
        console.error('[Sales] submitSale refetch error:', err);
      });

    window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
  } catch (err) {
    console.error('[submitSale]', err);
    showToast('Bán hàng thất bại: ' + (err.message || 'Lỗi không xác định'), 'error');
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

function closeInvoice() {
  var modal = document.getElementById('invoiceModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  _openInvoiceSaleId = null;
}

// Refresh invoice modal if open (used after keg updates)
async function refreshInvoiceIfOpen(saleId) {
  if (_openInvoiceSaleId === saleId) {
    await showInvoiceModal(saleId);
  }
}

// Track the invoice modal open sale ID so we can refresh it after keg updates
let _openInvoiceSaleId = null;

// Hàm kiểm tra sản phẩm có phải là bia pet (chai nhựa) không
function isPetBia(productName, productType) {
  // Ưu tiên kiểm tra type từ database
  if (productType === 'pet') return true;
  if (productType === 'keg' || productType === 'box') return false;
  
  // Fallback: kiểm tra tên sản phẩm
  const name = (productName || '').toLowerCase();
  return name.includes('pet') || name.includes('nhựa');
}

// Tổng vỏ keg theo dòng hàng (chỉ keg, không tính pet vì vỏ pet không thu lại)
function sumShellUnitsFromSaleItems(items) {
  if (!items || !items.length) return 0;
  return items.reduce(function (sum, item) {
    var q = parseInt(item.quantity, 10) || 0;
    if (q <= 0) return sum;
    var t = String(item.type || '').toLowerCase();
    if (t === 'keg') return sum + q;
    return sum;
  }, 0);
}

async function openKegModal(saleId) {
  _invoiceSaleId = saleId;

  var res = await fetch('/api/sales/' + saleId);
  var sale = await res.json();

  _invoiceCustomerId = sale.customer_id;

  // Lấy balance THỰC TẾ từ DB (không dùng customers array — có thể cũ)
  var custRes = await fetch('/api/customers/' + sale.customer_id);
  var custData = await custRes.json();
  _invoiceCustBalance = custData.keg_balance || 0;

  // Tổng bia bom (không pet) — gợi ý giao vỏ
  _invoiceLineQty = sumShellUnitsFromSaleItems(sale.items || []);

  // ─── Mode detection ───────────────────────────────────────────
  // invoiceShell = snapshot đã lưu trên đơn (hoặc null nếu chưa từng ghi)
  var savedGiao = sale.deliver_kegs || 0;
  var savedThu  = sale.return_kegs  || 0;
  var isEditMode = savedGiao > 0 || savedThu > 0;
  _invoiceShell = isEditMode
    ? { giao: savedGiao, thu: savedThu }
    : null;

  // ─── Fill form ─────────────────────────────────────────────────
  // Create mode → 0; Edit mode → pre-fill với giá trị đã lưu
  var formGiao = isEditMode ? savedGiao : _invoiceLineQty;
  var formThu  = isEditMode ? savedThu  : 0;

  var kegBeerQuantityEl = document.getElementById('kegBeerQuantity');
  var kegDeliverEl = document.getElementById('kegDeliver');
  var kegReturnEl = document.getElementById('kegReturn');
  if (kegBeerQuantityEl) kegBeerQuantityEl.textContent = _invoiceLineQty;
  if (kegDeliverEl) kegDeliverEl.value = formGiao;
  if (kegReturnEl) kegReturnEl.value = formThu;

  // ─── UI: badge, title, button ─────────────────────────────────
  var badgeEl = document.getElementById('kegModalBadge');
  var titleEl = document.getElementById('kegModalTitle');
  var saveBtnText = document.getElementById('kegSaveBtnText');
  var kegBadgeGiaoEl = document.getElementById('kegBadgeGiao');
  var kegBadgeThuEl = document.getElementById('kegBadgeThu');

  if (isEditMode) {
    if (badgeEl) badgeEl.classList.remove('hidden');
    if (kegBadgeGiaoEl) kegBadgeGiaoEl.textContent = savedGiao;
    if (kegBadgeThuEl) kegBadgeThuEl.textContent = savedThu;
    if (titleEl) titleEl.textContent = '✏️ Chỉnh sửa vỏ bình';
    if (saveBtnText) saveBtnText.textContent = 'Cập nhật';
  } else {
    if (badgeEl) badgeEl.classList.add('hidden');
    if (titleEl) titleEl.textContent = '📦 Cập nhật vỏ bình';
    if (saveBtnText) saveBtnText.textContent = 'Lưu';
  }

  // Clear old errors/warnings
  var kegModalErrorEl = document.getElementById('kegModalError');
  var kegModalWarningEl = document.getElementById('kegModalWarning');
  if (kegModalErrorEl) kegModalErrorEl.classList.add('hidden');
  if (kegModalWarningEl) kegModalWarningEl.classList.add('hidden');

  updateKegModalPreview();

  var modal = document.getElementById('kegModal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  // Auto-focus into "Giao vỏ" input
  setTimeout(function() {
    var el = document.getElementById('kegDeliver');
    if (el) { el.focus(); el.select(); }
  }, 100);
}

function closeKegModal() {
  var modal = document.getElementById('kegModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  _invoiceSaleId = null;
  _invoiceCustomerId = null;
  _invoiceShell = null;
}

// Replacement Modal Functions
function openReplacementModal() {
  if (editingSaleId != null) {
    alert('Đang sửa hóa đơn. Vui lòng Huỷ hoặc Cập nhật trước.');
    return;
  }

  var customerSelect = document.getElementById('replacementCustomer');
  if (customerSelect) {
    customerSelect.innerHTML = '<option value="">-- Chọn khách hàng --</option>' +
      customers.map(function(c) { return '<option value="' + c.id + '">' + c.name + '</option>'; }).join('');
  }

  var replacementProduct = document.getElementById('replacementProduct');
  var replacementQty = document.getElementById('replacementQty');
  var giftKegs = document.getElementById('giftKegs');
  var giftGuestName = document.getElementById('giftGuestName');
  if (replacementProduct) replacementProduct.innerHTML = '<option value="">-- Chọn sản phẩm --</option>';
  if (replacementQty) replacementQty.value = 1;
  if (giftKegs) giftKegs.checked = false;
  if (giftGuestName) giftGuestName.value = '';
  toggleGiftMode();

  var modal = document.getElementById('replacementModal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

function toggleGiftMode() {
  var isGiftEl = document.getElementById('giftKegs');
  var isGift = isGiftEl ? isGiftEl.checked : false;
  var giftGuestRow = document.getElementById('giftGuestRow');
  var replacementCustomerRow = document.getElementById('replacementCustomerRow');
  if (giftGuestRow) giftGuestRow.classList.toggle('hidden', !isGift);
  if (replacementCustomerRow) replacementCustomerRow.classList.toggle('hidden', isGift);
  // Clear customer selection when switching modes
  if (isGift) {
    var replacementCustomerEl = document.getElementById('replacementCustomer');
    if (replacementCustomerEl) replacementCustomerEl.value = '';
    // Load products for guest (no customer-specific pricing)
    loadReplacementProductsForGuest();
  }
}

function closeReplacementModal() {
  var modal = document.getElementById('replacementModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

function loadReplacementProducts() {
  var customerIdEl = document.getElementById('replacementCustomer');
  var customerId = customerIdEl ? customerIdEl.value : '';
  var productSelect = document.getElementById('replacementProduct');

  if (!customerId) {
    if (productSelect) productSelect.innerHTML = '<option value="">-- Chọn sản phẩm --</option>';
    return;
  }
  if (productSelect) {
    productSelect.innerHTML = '<option value="">-- Chọn sản phẩm --</option>' +
      products.map(function(p) { return '<option value="' + p.id + '">' + p.name + ' (Tồn: ' + p.stock + ')</option>'; }).join('');
  }
}

function loadReplacementProductsForGuest() {
  var productSelect = document.getElementById('replacementProduct');
  if (productSelect) {
    productSelect.innerHTML = '<option value="">-- Chọn sản phẩm --</option>' +
      products.map(function(p) { return '<option value="' + p.id + '">' + p.name + ' (Tồn: ' + p.stock + ')</option>'; }).join('');
  }
}

async function submitReplacement() {
  var customerIdEl = document.getElementById('replacementCustomer');
  var productIdEl = document.getElementById('replacementProduct');
  var quantityEl = document.getElementById('replacementQty');
  var reasonEl = document.getElementById('replacementReason');
  var giftKegsEl = document.getElementById('giftKegs');
  var giftGuestNameEl = document.getElementById('giftGuestName');

  var customerId = customerIdEl ? customerIdEl.value : '';
  var productId = productIdEl ? productIdEl.value : '';
  var quantity = parseInt(quantityEl ? quantityEl.value : '0') || 0;
  var reason = reasonEl ? reasonEl.value : '';
  var isGift = giftKegsEl ? giftKegsEl.checked : false;
  var customerName = isGift ? (giftGuestNameEl ? giftGuestNameEl.value.trim() : '') || 'Khách tặng' : null;

  if (!productId || quantity <= 0) {
    alert('Vui lòng chọn sản phẩm và số lượng');
    return;
  }
  if (!isGift && !customerId) {
    alert('Vui lòng chọn khách hàng');
    return;
  }

  var btn = document.getElementById('submitReplacementBtn');
  var btnState = btn ? setButtonLoading(btn, 'Đang xử lý') : null;

  try {
    var res = await fetch('/api/sales/replacement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: customerId ? parseInt(customerId) : null,
        customer_name: customerName,
        product_id: parseInt(productId),
        quantity,
        reason,
        gift: isGift
      }),
      cache: 'no-store'
    });
    var data;
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) throw new Error(data.error || 'Đổi bia thất bại');

    alert('Đã đổi bia thành công!');
    closeReplacementModal();

    if (salesPagination.page === 1) {
      loadSalesHistory();
    } else {
      salesPagination.page = 1;
      loadSalesHistory();
    }
    showToast('Đơn đổi bia đã được tạo', 'success');
    window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
  } catch (err) {
    console.error('[submitReplacement]', err);
    showToast('Đổi bia thất bại: ' + (err.message || 'Lỗi không xác định'), 'error');
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

// ── Keyboard navigation for keg inputs ────────────────────────────────────
function handleKegInputNav(event, nextId) {
  if (event.key === 'Enter') {
    event.preventDefault();
    const nextEl = document.getElementById(nextId);
    if (nextEl) {
      if (nextId === 'kegSaveBtn') {
        // Second Enter → save
        saveKegUpdate();
      } else {
        nextEl.focus();
        nextEl.select();
      }
    }
  }
}

// ── Safe number parsing ────────────────────────────────────────────────────
function safeNumber(val) {
  const n = Number(val);
  return isNaN(n) || n < 0 ? 0 : Math.floor(n);
}

// ── Preview update ─────────────────────────────────────────────────────────
function updateKegModalPreview() {
  var kegDeliverEl = document.getElementById('kegDeliver');
  var kegReturnEl = document.getElementById('kegReturn');
  var formGiao = safeNumber(kegDeliverEl ? kegDeliverEl.value : '');
  var formThu  = safeNumber(kegReturnEl ? kegReturnEl.value : '');

  // Delta so với snapshot đã lưu (hoặc 0 nếu create mode)
  var old = _invoiceShell || { giao: 0, thu: 0 };
  var deltaGiao = formGiao - old.giao;
  var deltaThu  = formThu  - old.thu;
  var newBalance = _invoiceCustBalance + deltaGiao - deltaThu;

  // Show current inputs — +xanh, -đỏ
  var kegDeliverPreviewEl = document.getElementById('kegDeliverPreview');
  var kegReturnPreviewEl = document.getElementById('kegReturnPreview');
  var kegCurrentBalanceEl = document.getElementById('kegCurrentBalance');
  var kegNewBalanceEl = document.getElementById('kegNewBalance');
  if (kegDeliverPreviewEl) kegDeliverPreviewEl.textContent = '+' + formGiao;
  if (kegReturnPreviewEl) kegReturnPreviewEl.textContent = '-' + formThu;
  if (kegCurrentBalanceEl) kegCurrentBalanceEl.textContent = _invoiceCustBalance;
  if (kegNewBalanceEl) kegNewBalanceEl.textContent = newBalance;

  // Color: voSau >= 0 → xanh, < 0 → đỏ
  if (kegNewBalanceEl) {
    kegNewBalanceEl.className = 'font-bold ' + (newBalance >= 0 ? 'text-success' : 'text-danger');
  }
  // Color: deliver preview — xanh nếu > 0
  if (kegDeliverPreviewEl) {
    kegDeliverPreviewEl.className = 'font-bold ' + (formGiao > 0 ? 'text-success' : 'text-muted');
  }
  // Color: return preview — đỏ nếu > 0
  if (kegReturnPreviewEl) {
    kegReturnPreviewEl.className = 'font-bold ' + (formThu > 0 ? 'text-danger' : 'text-muted');
  }

  // Validation: cannot return more than customer holds after this edit
  var maxAllowedReturn = _invoiceCustBalance + deltaGiao;
  var warningEl = document.getElementById('kegModalWarning');
  if (formThu > maxAllowedReturn) {
    if (warningEl) {
      warningEl.classList.remove('hidden');
      warningEl.textContent = '⚠️ Không thể thu ' + formThu + ' vỏ. Khách chỉ giữ tối đa ' + maxAllowedReturn + ' vỏ';
    }
  } else {
    if (warningEl) warningEl.classList.add('hidden');
  }
}

async function saveKegUpdate() {
  if (!_invoiceSaleId || !_invoiceCustomerId) return;

  var kegDeliverEl = document.getElementById('kegDeliver');
  var kegReturnEl = document.getElementById('kegReturn');
  var formGiao = safeNumber(kegDeliverEl ? kegDeliverEl.value : '0');
  var formThu  = safeNumber(kegReturnEl ? kegReturnEl.value : '0');

  // Delta so với snapshot đã lưu (hoặc 0 nếu create mode)
  var old = _invoiceShell || { giao: 0, thu: 0 };
  var deltaGiao = formGiao - old.giao;
  var deltaThu  = formThu  - old.thu;

  // Validation: cannot return more than customer holds after this edit
  var maxAllowedReturn = _invoiceCustBalance + deltaGiao;
  var errorEl = document.getElementById('kegModalError');
  if (formThu > maxAllowedReturn) {
    if (errorEl) {
      errorEl.textContent = '⚠️ Không thể thu ' + formThu + ' vỏ. Khách chỉ giữ tối đa ' + maxAllowedReturn + ' vỏ';
      errorEl.classList.remove('hidden');
    }
    return;
  }
  if (errorEl) errorEl.classList.add('hidden');

  var saleId = _invoiceSaleId;
  var btn = document.getElementById('kegSaveBtn');
  var btnState = btn ? setButtonLoading(btn, 'Đang cập nhật...') : null;

  try {
    var res = await fetch('/api/sales/update-kegs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saleId: saleId, customerId: _invoiceCustomerId, deliver: formGiao, returned: formThu }),
      cache: 'no-store'
    });
    var result;
    try { result = await res.json(); } catch (_) { result = {}; }
    if (!res.ok) throw new Error(result.error || 'Cập nhật vỏ thất bại');

    alert('Cập nhật vỏ thành công!\n\nGiao: ' + formGiao + ' | Thu: ' + formThu + '\nVỏ tại khách: ' + (result.new_balance || result.newBalance));

    closeKegModal();

    // REFETCH customers to sync
    const custListRes = await fetch('/api/customers');
    const custData = await custListRes.json();
    customers = custData.customers || custData;
    window.store.customers = customers;
    _rebuildMaps();

    patchSaleRow({ id: saleId, deliver_kegs: formGiao, return_kegs: formThu, keg_balance_after: (result.new_balance || result.newBalance) });
    await refreshInvoiceIfOpen(saleId);
    window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale', source: 'keg-update' } }));
  } catch (err) {
    console.error('[saveKegUpdate]', err);
    showToast('Cập nhật vỏ thất bại: ' + (err.message || 'Lỗi không xác định'), 'error');
    await loadSalesHistory();
    if (window.location.pathname === '/' || window.location.pathname === '/dashboard') {
      if (typeof loadData === 'function') await loadData();
    }
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

async function showInvoiceModal(saleId) {
  const modal = document.getElementById('invoiceModal');
  if (!modal) {
    console.error('Không tìm thấy phần tử #invoiceModal');
    return;
  }

  const invoiceContent = document.getElementById('invoiceContent');
  const invoiceTotalEl = document.querySelector('#invoiceModal .invoice-total-value');
  const qrSection = document.querySelector('#invoiceModal .invoice-qr-card');
  if (invoiceContent) invoiceContent.innerHTML = '<div class="text-center py-8 text-muted">Đang tải chi tiết...</div>';

  const res = await fetch('/api/sales/' + saleId);
  if (!res.ok) {
    console.error('Không lấy được dữ liệu hóa đơn:', res.status);
    if (invoiceContent) invoiceContent.innerHTML = '<div class="text-center py-8 text-danger">Lỗi tải hóa đơn</div>';
    return;
  }
  const sale = await res.json();

  console.log('[Invoice Detail]', sale);

  if (!sale.items || sale.items.length === 0) {
    console.error('CRITICAL: Missing sale_items for sale', sale.id);
    showToast('Hóa đơn thiếu dữ liệu chi tiết!', 'error');
  }

  const dateStr = new Date(sale.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const customerName = sale.customer_name || 'Khách lẻ';
  const isGift = sale.type === 'gift';
  
  let itemsHtml = '';
  (sale.items || []).forEach(item => {
    const unitPrice = item.price || 0;
    const totalPrice = unitPrice * (item.quantity || 0);
    itemsHtml += `
      <div class="invoice-item">
        <div class="invoice-name">🍺 ${item.name || 'Sản phẩm'}</div>
        <div class="invoice-row">
          <span>${item.quantity || 0} × ${formatVND(unitPrice)}</span>
          <span class="invoice-total">${formatVND(totalPrice)}</span>
        </div>
      </div>
    `;
  });

  const deliverKegs = sale.deliver_kegs || 0;
  const returnKegs = sale.return_kegs || 0;
  const newBalance = sale.keg_balance_after || 0;
  
  let kegHtml = '';
  if (deliverKegs > 0 || returnKegs > 0) {
    kegHtml = '<div class="border-t border-muted pt-3 mt-3 space-y-1">';
    if (deliverKegs > 0) {
      kegHtml += '<div class="flex justify-between text-sm"><span class="text-secondary">📦 Giao vỏ</span><span class="font-semibold text-success">+' + deliverKegs + '</span></div>';
    }
    if (returnKegs > 0) {
      kegHtml += '<div class="flex justify-between text-sm"><span class="text-secondary">🔁 Thu vỏ</span><span class="font-semibold text-warning">-' + returnKegs + '</span></div>';
    }
    kegHtml += '<div class="flex justify-between text-sm font-semibold pt-1"><span class="text-main">Vỏ đang giữ:</span><span>' + newBalance + '</span></div></div>';
  }

  const giftBadge = isGift ? '<div class="text-center mb-3"><span class="badge badge-warning">🎁 Tặng uống thử</span></div>' : '';

  if (invoiceContent) {
    invoiceContent.innerHTML =
      giftBadge +
      '<div class="text-xs text-secondary mb-1">' + dateStr + '</div>' +
      '<div class="text-sm font-semibold text-main mb-3">Khách: ' + customerName + '</div>' +
      '<div class="border-t border-muted/50 pt-3">' + itemsHtml + '</div>' +
      kegHtml;
  }
  
  if (invoiceTotalEl) {
    invoiceTotalEl.textContent = Format.number(sale.total || 0);
  }
  
  if (qrSection) {
    if (isGift) {
      qrSection.classList.add('hidden');
    } else {
      qrSection.classList.remove('hidden');
      const qrCode = document.getElementById('qrCode');
      if (qrCode) {
        qrCode.src = 'https://img.vietqr.io/image/970415-107875230331-compact2.png?amount=' + (sale.total || 0) + '&addInfo=Chuyen%20Khoan%20' + sale.id;
      }
    }
  }
  
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  _openInvoiceSaleId = saleId;
}

// Global state for pagination (API /api/sales?page=&limit=)
let salesPagination = {
  page: 1,
  limit: 5,
  total: 0,
  totalPages: 0,
  month: 'all'
};

/**
 * Tính số vỏ cuối cùng sau giao/thu — dùng cho TẠO ĐƠN MỚI.
 *
 * ⚠️  KHÔNG dùng cho modal SỬA đơn cũ (sẽ bị double-count).
 *    Với modal sửa, dùng delta-based trong updateKegModalPreview().
 *
 * @param {number} currentBalance - Số vỏ KHÁCH ĐANG GIỮ (chưa bao gồm đơn mới)
 * @param {number} [newDeliver=0] - Số vỏ giao trong đơn mới
 * @param {number} [newReturn=0] - Số vỏ thu trong đơn mới
 * @returns {number} Số vỏ sau cùng
 */
function calcFinalKegBalance(currentBalance, newDeliver, newReturn) {
  return currentBalance + (newDeliver || 0) - (newReturn || 0);
}

// ========== KEG MODAL STATE — single source of truth per invoice ==========
// invoiceShell = { giao: number, thu: number }
// - null → chưa từng lưu vỏ → create mode (form = 0)
// - { giao, thu } → đã lưu → edit mode (form pre-filled)
// Submit dùng delta: deltaGiao = formGiao - invoiceShell.giao
let _invoiceShell = null;   // null = create mode; { giao, thu } = edit mode
let _invoiceSaleId   = null;
let _invoiceCustomerId = null;
let _invoiceCustBalance = 0;  // tồn vỏ KHÁCH hiện tại (từ DB, không tính deliver/return đơn này)
let _invoiceLineQty = 0;      // tổng số bia bom (không pet)

// ========== COLLECT KEG MODAL (Thu vỏ - giao/thu tự tính còn lại) ==========
let _collectKegSaleId = null;
let _collectKegCustomerId = null;
let _collectKegBalance = 0;
/** Giá trị deliver/return đã lưu trên đơn — dùng tính preview (tránh cộng giao vỏ 2 lần vì balance DB đã + deliver) */
let _collectKegPrevDeliver = 0;
let _collectKegPrevReturn = 0;

async function openCollectKegModal(saleId) {
  _collectKegSaleId = saleId;

  const res = await fetch('/api/sales/' + saleId);
  const sale = await res.json();
  _collectKegCustomerId = sale.customer_id;

  // Lấy balance THỰC TẾ từ DB (không dùng customers array — có thể cũ)
  const custRes = await fetch('/api/customers/' + sale.customer_id);
  const custData = await custRes.json();
  _collectKegBalance = custData.keg_balance || 0;

  var recordedDeliver = sale.deliver_kegs || 0;
  var recordedReturn = sale.return_kegs || 0;
  _collectKegPrevDeliver = recordedDeliver;
  _collectKegPrevReturn = recordedReturn;
  var lineShellTotal = sumShellUnitsFromSaleItems(sale.items || []);
  // Nếu lúc bán chỉ ghi 5 vỏ nhưng hóa đơn 50 bom + 50 pet → gợi ý theo dòng hàng
  var effectiveDeliver = Math.max(recordedDeliver, lineShellTotal);
  var defaultReturn = Math.max(0, effectiveDeliver - recordedReturn);

  var collectKegDeliverEl = document.getElementById('collectKegDeliver');
  var collectKegReturnEl = document.getElementById('collectKegReturn');
  var collectKegCurrentBalanceEl = document.getElementById('collectKegCurrentBalance');
  var collectKegWarningEl = document.getElementById('collectKegWarning');
  var collectKegModalEl = document.getElementById('collectKegModal');
  if (collectKegDeliverEl) collectKegDeliverEl.value = effectiveDeliver;
  if (collectKegReturnEl) collectKegReturnEl.value = defaultReturn;

  if (collectKegCurrentBalanceEl) collectKegCurrentBalanceEl.textContent =
    'Hien tai: ' + _collectKegBalance + ' vo';

  // Clear old warning
  if (collectKegWarningEl) collectKegWarningEl.classList.add('hidden');

  if (collectKegModalEl) { collectKegModalEl.classList.remove('hidden'); collectKegModalEl.classList.add('flex'); }
  updateCollectKegPreview();
}

function closeCollectKegModal() {
  var modal = document.getElementById('collectKegModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  _collectKegSaleId = null;
  _collectKegCustomerId = null;
  _collectKegBalance = 0;
  _collectKegPrevDeliver = 0;
  _collectKegPrevReturn = 0;
}

function updateCollectKegPreview() {
  var collectKegDeliverEl = document.getElementById('collectKegDeliver');
  var collectKegReturnEl = document.getElementById('collectKegReturn');
  var collectKegDeliverPreviewEl = document.getElementById('collectKegDeliverPreview');
  var collectKegReturnPreviewEl = document.getElementById('collectKegReturnPreview');
  var collectKegCurrentBalanceEl = document.getElementById('collectKegCurrentBalance');
  var collectKegRemainingEl = document.getElementById('collectKegRemaining');

  var deliver = safeNumber(collectKegDeliverEl ? collectKegDeliverEl.value : '');
  var returned = safeNumber(collectKegReturnEl ? collectKegReturnEl.value : '');

  // Rule: _collectKegBalance đã bao gồm số đã giao trước.
  // voSau = voHienTai + (newDeliver - prevDeliver) - (newReturn - prevReturn)
  var deltaDeliver = deliver - _collectKegPrevDeliver;
  var deltaReturn  = returned - _collectKegPrevReturn;
  var newBalance = _collectKegBalance + deltaDeliver - deltaReturn;

  if (collectKegDeliverPreviewEl) collectKegDeliverPreviewEl.textContent = '+' + deliver;
  if (collectKegReturnPreviewEl) collectKegReturnPreviewEl.textContent = '-' + returned;
  if (collectKegCurrentBalanceEl) collectKegCurrentBalanceEl.textContent = _collectKegBalance + ' vo';
  if (collectKegRemainingEl) collectKegRemainingEl.textContent = newBalance;

  // Color: voSau xanh nếu >=0, đỏ nếu <0; +xanh, -đỏ
  if (collectKegRemainingEl) collectKegRemainingEl.className = 'font-bold ' + (newBalance >= 0 ? 'text-success' : 'text-danger');
  if (collectKegDeliverPreviewEl) collectKegDeliverPreviewEl.className = 'font-bold ' + (deliver > 0 ? 'text-success' : 'text-muted');
  if (collectKegReturnPreviewEl) collectKegReturnPreviewEl.className = 'font-bold ' + (returned > 0 ? 'text-danger' : 'text-muted');

  // Validation: cannot return more than customer holds.
  // customer holds = _collectKegBalance + deltaDeliver
  const maxAllowed = _collectKegBalance + deltaDeliver;
  const warningEl = document.getElementById('collectKegWarning');
  if (returned > maxAllowed) {
    warningEl.textContent = '⚠️ Không thể thu ' + returned + ' vỏ. Khách chỉ giữ tối đa ' + maxAllowed + ' vỏ';
    warningEl.classList.remove('hidden');
  } else {
    warningEl.classList.add('hidden');
  }
}

async function submitCollectKeg() {
  var saleId = _collectKegSaleId;
  var collectKegReturnEl = document.getElementById('collectKegReturn');
  var returned = safeNumber(collectKegReturnEl ? collectKegReturnEl.value : '0');

  if (returned < 0) {
    alert('Số vỏ không hợp lệ');
    return;
  }

  // Validation: cannot return more than customer holds
  const deltaReturn = returned - _collectKegPrevReturn;
  const maxAllowed = _collectKegBalance;
  if (returned > maxAllowed) {
    const warningEl = document.getElementById('collectKegWarning');
    warningEl.textContent = '⚠️ Không thể thu ' + returned + ' vỏ. Khách chỉ giữ tối đa ' + maxAllowed + ' vỏ';
    warningEl.classList.remove('hidden');
    return;
  }

  var btn = document.getElementById('submitCollectKegBtn');
  var btnState = btn ? setButtonLoading(btn, 'Đang cập nhật...') : null;

  try {
    var res = await fetch('/api/kegs/return', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sale_id: saleId, returned_kegs: returned }),
      cache: 'no-store'
    });
    var result;
    try { result = await res.json(); } catch (_) { result = {}; }
    if (!res.ok) throw new Error(result.error || 'Cập nhật vỏ thất bại');

    alert('Cập nhật vỏ thành công!\n\nThu: ' + returned + ' vỏ\nVỏ tại khách: ' + result.new_balance);

    closeCollectKegModal();

    // REFETCH customers to sync
    const custListRes = await fetch('/api/customers');
    const custData = await custListRes.json();
    customers = custData.customers || custData;
    window.store.customers = customers;
    _rebuildMaps();

    patchSaleRow({ id: saleId, return_kegs: returned, keg_balance_after: result.new_balance });
    await refreshInvoiceIfOpen(saleId);
    window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale', source: 'keg-return' } }));
  } catch (err) {
    console.error('[submitCollectKeg]', err);
    showToast('Cập nhật vỏ thất bại: ' + (err.message || 'Lỗi không xác định'), 'error');
    await loadSalesHistory();
    if (window.location.pathname === '/' || window.location.pathname === '/dashboard') {
      if (typeof loadData === 'function') await loadData();
    }
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

function formatSaleListDate(raw) {
  if (!raw) return '—';
  const s = String(raw).trim().split(/[\sT]/)[0];
  const p = s.split('-');
  if (p.length === 3) return p[2] + '/' + p[1] + '/' + p[0];
  try {
    return new Date(raw).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (e) {
    return s;
  }
}

// ========== SALES HISTORY RENDER ==========
// PERFORMANCE: Incremental DOM — each card has data-sale-id, only changed rows re-render.
const _saleCardMap = new Map();

// Replace a single sale row in-place (no full re-render)
function patchSaleRow(sale) {
  const card = document.querySelector(`[data-sale-id="${sale.id}"]`);
  if (!card) return;
  const date = formatSaleListDate(sale.date);
  const nameEl  = card.querySelector('.order-title');
  const dateEl  = card.querySelector('.order-meta');
  const moneyEl = card.querySelector('.money .value');
  if (nameEl && sale.customer_name !== undefined) nameEl.textContent = sale.customer_name || 'Khách lẻ';
  if (dateEl && sale.date !== undefined) dateEl.textContent = '📅 ' + date;
  if (moneyEl && sale.total !== undefined) moneyEl.textContent = typeof Format !== 'undefined' ? Format.number(sale.total) : formatVND(sale.total).replace(' đ', '');
  const isReturned   = sale.status === 'returned';
  const isReplacement = sale.type === 'replacement';
  const isGift        = sale.type === 'gift';
  const kegDeliver = sale.deliver_kegs || 0;
  const kegReturn  = sale.return_kegs  || 0;
  const kegBadgeHtml = (kegDeliver || kegReturn)
    ? '<span class="text-xs text-secondary ml-1 shrink-0">[G:' + kegDeliver + ' T:' + kegReturn + ']</span>'
    : '';
  const actionsEl = card.querySelector('.order-actions');
  if (actionsEl) actionsEl.innerHTML = isReturned
    ? '<button class="btn btn-secondary btn-sm">Đã trả</button>'
    : '<button onclick="viewSale(' + sale.id + ')" class="btn btn-secondary btn-sm">Hóa đơn</button>' +
      '<button onclick="openKegModal(' + sale.id + ')" class="btn btn-warning btn-sm">Sửa vỏ</button>' +
      '<button onclick="editSale(' + sale.id + ')" class="btn btn-ghost btn-sm">Sửa</button>' +
      '<button onclick="deleteSale(' + sale.id + ')" class="btn btn-danger btn-sm">Xóa</button>';
  const footerEl = card.querySelector('.order-footer');
  if (footerEl) {
    const qtyEl = footerEl.querySelector('.order-meta');
    if (kegBadgeHtml) {
      const existingBadge = footerEl.querySelector('.keg-badge');
      if (existingBadge) existingBadge.remove();
      if (qtyEl) qtyEl.insertAdjacentHTML('afterend', kegBadgeHtml);
    }
  }
  card.className = 'order-item ' + (isReplacement ? 'border-l-4 border-warning' : isGift ? 'border-l-4 border-primary' : 'border-l-4 border-success');
}

async function loadSalesHistory() {
  console.log('[Sales] loadSalesHistory START');
  const { page, limit, month } = salesPagination;
  const monthParam = month !== 'all' ? `&month=${month}` : '';
  let data;
  try {
    console.log('[Sales] fetching /api/sales?page=' + page + '&limit=' + limit + monthParam);
    const res = await fetch(`/api/sales?page=${page}&limit=${limit}${monthParam}`, { cache: 'no-store' });
    console.log('[Sales] /api/sales response:', res.status);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('loadSalesHistory error:', err);
    const container = document.getElementById('salesHistoryList');
    if (container) container.innerHTML =
      '<p class="text-danger text-center py-4">Không tải được lịch sử. Kiểm tra kết nối server.</p>';
    return;
  }

  const apiSales = data.sales;
  salesPagination.total = data.total;
  salesPagination.totalPages = data.totalPages;

  // Merge API data into allSales: deduplicate by id, append page data at the end
  if (page === 1) {
    // Page 1: rebuild from scratch — keep optimistic items already in allSales
    const optimisticIds = new Set(
      allSales.filter(function(s) { return s._optimistic; }).map(function(s) { return s.id; })
    );
    const apiIds = new Set(apiSales.map(function(s) { return s.id; }));
    // Keep optimistic items, discard their server-backed duplicates
    allSales = apiSales.concat(allSales.filter(function(s) {
      return s._optimistic && !apiIds.has(s.id);
    }));
  } else {
    // Other pages: merge without duplicates
    const existingIds = new Set(allSales.map(function(s) { return s.id; }));
    for (var i = 0; i < apiSales.length; i++) {
      if (!existingIds.has(apiSales[i].id)) {
        allSales.push(apiSales[i]);
      }
    }
  }

  // Sync window.store.sales with allSales so other pages (e.g. dashboard) get fresh data
  window.store.sales = allSales;

  // Delegate rendering to renderHistoryPage (uses allSales as source)
  renderHistoryPage();
}

/**
 * Render the current page of allSales into #salesHistoryList.
 * Used for both initial load and after optimistic inserts — does NOT fetch from API.
 */
function renderHistoryPage() {
  var container = document.getElementById('salesHistoryList');
  if (!container) return;

  var page = historyCurrentPage;
  var limit = HISTORY_PAGE_SIZE;
  var start = (page - 1) * limit;
  var pageItems = allSales.slice(start, start + limit);

  _saleCardMap.clear();

  if (pageItems.length === 0) {
    container.innerHTML = '<p class="text-muted text-center py-4">Chưa có hóa đơn nào</p>';
    renderPagination();
    return;
  }

  var parts = ['<div class="flex flex-col gap-3">'];
  for (var i = 0; i < pageItems.length; i++) {
    var sale = pageItems[i];
    var date = formatSaleListDate(sale.date);
    var customerName = sale.customer_name || 'Khách lẻ';
    var isReturned = sale.status === 'returned';
    var itemsQty = parseInt(sale.items_qty, 10) || 0;
    var isReplacement = sale.type === 'replacement';
    var isGift = sale.type === 'gift';
    var badgeHtml = isReplacement ? '<span class="badge badge-warning">🔁 Đổi lỗi</span>'
                  : isGift ? '<span class="badge badge-primary">🎁 Tặng thử</span>'
                  : '';
    var badgeLeft = isReplacement ? 'border-l-4 border-warning'
                  : isGift ? 'border-l-4 border-primary'
                  : 'border-l-4 border-success';
    var qtyLabel = itemsQty > 0 ? '📦 ' + itemsQty + 'L' : '';
    var kegDeliver = sale.deliver_kegs || 0;
    var kegReturn  = sale.return_kegs  || 0;
    var kegBadgeHtml = (kegDeliver || kegReturn)
      ? '<span class="text-xs text-secondary ml-1 shrink-0">[G:' + kegDeliver + ' T:' + kegReturn + ']</span>'
      : '';
    var saleMoney = typeof Format !== 'undefined' ? Format.number(sale.total) : formatVND(sale.total).replace(' đ', '');

    parts.push(
'<div class="order-item ' + badgeLeft + '" data-sale-id="' + sale.id + '">' +
  '<div class="order-header">' +
    '<div class="flex items-center gap-2 min-w-0 flex-1">' +
      '<span class="text-xs font-semibold text-secondary shrink-0">#' + sale.id + '</span>' +
      '<span class="order-title">' + customerName + '</span>' +
      (badgeHtml ? '<span class="shrink-0">' + badgeHtml + '</span>' : '') +
    '</div>' +
    '<span class="order-meta">📅 ' + date + '</span>' +
  '</div>' +
  '<div class="order-footer">' +
    '<div class="flex items-baseline gap-1">' +
      '<div class="money text-money"><span class="value text-xl font-bold tabular-nums">' + saleMoney + '</span><span class="unit">đ</span></div>' +
    '</div>' +
    (qtyLabel ? '<span class="order-meta">' + qtyLabel + '</span>' : '') +
    (kegBadgeHtml ? '<span class="order-meta">' + kegBadgeHtml + '</span>' : '') +
  '</div>' +
  '<div class="order-actions">' +
    (isReturned
      ? '<button class="btn btn-secondary btn-sm">Đã trả</button>'
      : '<button onclick="viewSale(' + sale.id + ')" class="btn btn-secondary btn-sm">Hóa đơn</button>' +
        '<button onclick="openKegModal(' + sale.id + ')" class="btn btn-warning btn-sm">Sửa vỏ</button>' +
        '<button onclick="editSale(' + sale.id + ')" class="btn btn-ghost btn-sm">Sửa</button>' +
        '<button onclick="deleteSale(' + sale.id + ')" class="btn btn-danger btn-sm">Xóa</button>'
    ) +
  '</div>' +
'</div>'
    );
  }
  parts.push('</div>');
  container.innerHTML = parts.join('');

  // Cache card DOM refs for patchSaleRow()
  for (var j = 0; j < pageItems.length; j++) {
    _saleCardMap.set(pageItems[j].id, document.querySelector('[data-sale-id="' + pageItems[j].id + '"]'));
  }

  renderPagination();
  console.log('[Sales] renderPagination DONE');
  checkSalesEmpty();
  console.log('[Sales] checkSalesEmpty DONE');
}
function renderPagination() {
  const container = document.getElementById('salesHistoryList');
  if (!container) return;
  const { page, totalPages, total } = salesPagination;

  // Remove old pagination nav if exists
  var oldNav = container.querySelector('nav[role="navigation"]');
  var oldTotal = container.querySelector('.history-total-row');
  if (oldNav) oldNav.remove();
  if (oldTotal) oldTotal.remove();

  if (totalPages <= 1) {
    if (total > 0) {
      container.insertAdjacentHTML('beforeend',
        '<div class="history-total-row text-center text-xs text-secondary mt-3 pt-2 border-t border-muted/70">Tổng ' + total + ' đơn</div>'
      );
    }
    return;
  }

  const prevD = page === 1;
  const nextD = page === totalPages;

  container.insertAdjacentHTML('beforeend',
    `<nav class="flex items-center justify-center gap-3 mt-4 pt-3 border-t border-muted" role="navigation" aria-label="Phân trang">
      <button onclick="changeSalesPage(${page - 1})" ${prevD ? 'disabled' : ''}
        class="min-w-[44px] min-h-[44px] w-11 h-11 rounded-full flex items-center justify-center text-base font-semibold transition-all
          ${prevD ? 'border border-muted/30 bg-bg text-muted cursor-not-allowed opacity-50 pointer-events-none' : 'border border-muted shadow-sm text-main hover:bg-bg-hover active:scale-90'}"
        aria-label="Trang trước" aria-disabled="${prevD}">
        ‹
      </button>
      <div class="flex flex-col justify-center items-center min-w-[4.5rem]">
        <span class="text-sm font-bold text-main tabular-nums leading-tight">${page} / ${totalPages}</span>
        <span class="text-[11px] text-secondary leading-tight mt-0.5">${total} đơn</span>
      </div>
      <button onclick="changeSalesPage(${page + 1})" ${nextD ? 'disabled' : ''}
        class="min-w-[44px] min-h-[44px] w-11 h-11 rounded-full flex items-center justify-center text-base font-semibold transition-all
          ${nextD ? 'border border-muted/30 bg-bg text-muted cursor-not-allowed opacity-50 pointer-events-none' : 'border border-muted shadow-sm text-main hover:bg-bg-hover active:scale-90'}"
        aria-label="Trang sau" aria-disabled="${nextD}">
        ›
      </button>
    </nav>`
  );
}

function changeSalesPage(newPage) {
  if (newPage < 1 || newPage > salesPagination.totalPages) return;
  historyCurrentPage = newPage;
  salesPagination.page = newPage;
  loadSalesHistory();
  var anchor = document.getElementById('salesHistoryList');
  if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function viewSale(id) {
  showInvoiceModal(id);
}

async function deleteSale(id) {
  if (!confirm('Bạn có chắc muốn xóa hóa đơn #' + id + '?')) return;

  // Snapshot for rollback from allSales (not window.store.sales)
  var deletedSale = Object.assign({}, allSales.find(function(s) { return String(s.id) === String(id); }));

  // Disable action buttons on the card
  var card = document.querySelector('[data-sale-id="' + id + '"]');
  var actionBtns = card ? card.querySelectorAll('.order-actions button') : [];
  var btnStates = [];
  actionBtns.forEach(function(b) { btnStates.push(setButtonLoading(b)); });

  try {
    var res = await fetch('/api/sales/' + id, { method: 'DELETE', cache: 'no-store' });
    var result;
    try { result = await res.json(); } catch (_) { result = {}; }
    if (!res.ok) throw new Error(result.error || 'Xóa hóa đơn thất bại');

    showToast(result.message || 'Đã xóa hóa đơn', 'success');
    btnStates.forEach(function(s) { restoreButtonLoading(s); });

    // Remove from local state
    syncSalesState(allSales.filter(function(s) { return s.id !== id; }));
    salesPagination.total = Math.max(0, (salesPagination.total || 1) - 1);
    salesPagination.totalPages = Math.ceil(salesPagination.total / HISTORY_PAGE_SIZE);
    renderHistoryPage();

    // REFETCH products from server to sync stock
    fetch('/api/products', { cache: 'no-store' })
      .then(function(res) { return res.json(); })
      .then(function(serverProducts) {
        products = serverProducts;
        window.store.products = serverProducts;
        _rebuildMaps();
        renderSaleProducts();
      })
      .catch(function(err) {
        console.error('[Sales] deleteSale refetch error:', err);
      });

    window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
  } catch (err) {
    console.error('[deleteSale]', err);
    btnStates.forEach(function(s) { restoreButtonLoading(s); });
    showToast('Xóa hóa đơn thất bại: ' + (err.message || 'Lỗi không xác định'), 'error');
    await loadSalesHistory();
  }
}

// Trả hàng - xác nhận và thực hiện (hỗ trợ trả một phần)
async function confirmReturnSale(id) {
  // Lấy thông tin hóa đơn trước
  const res = await fetch('/api/sales/' + id);
  if (!res.ok) {
    alert('Không tìm thấy hóa đơn');
    return;
  }
  const sale = await res.json();
  
  if (!sale.items || sale.items.length === 0) {
    alert('Hóa đơn không có sản phẩm');
    return;
  }
  
  const customerName = sale.customer_name || 'Khách lẻ';
  
  // Tạo HTML cho danh sách sản phẩm có thể trả
  const itemsHtml = sale.items.map(item => `
    <div class="flex items-center justify-between py-2 border-b border-muted">
      <div>
        <div class="font-medium text-main">${item.name}</div>
        <div class="text-xs text-secondary">Giá: ${formatVND(item.price)} | Đã mua: ${item.quantity}</div>
      </div>
      <div class="flex items-center gap-2">
        <input type="number" id="return_qty_${item.product_id}"
          data-price="${item.price}"
          min="0" max="${item.quantity}" value="0"
          class="w-16 border-2 border-primary rounded px-2 py-1 text-center focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
          placeholder="0" onchange="updateReturnPreview(this, ${item.quantity})" oninput="updateReturnPreview(this, ${item.quantity})">
        <span class="text-xs text-secondary">/${item.quantity}</span>
      </div>
    </div>
  `).join('');

  // Tạo modal
  const modalHtml = `
    <div id="returnModal" class="fixed inset-0 bg-overlay flex items-center justify-center z-50 p-4">
      <div class="card w-full max-w-md max-h-[80vh] overflow-hidden">
        <div class="p-4 border-b border-muted bg-primary text-main">
          <h3 class="font-bold text-lg">↩️ TRẢ HÀNG</h3>
          <div class="text-sm opacity-80">#${id} - ${customerName}</div>
        </div>

        <div class="p-4 overflow-y-auto max-h-[40vh]">
          <div class="font-medium text-main mb-2">Chọn sản phẩm và số lượng trả:</div>
          ${itemsHtml}

          <div class="mt-4 p-3 card">
            <div class="flex justify-between">
              <span class="text-main">Tổng tiền hoàn:</span>
              <div class="money text-money"><span class="value font-bold tabular-nums">0</span><span class="unit">đ</span></div>
            </div>
          </div>
        </div>

        <div class="p-4 border-t border-muted">
          <div class="font-medium text-main mb-2">Loại trả:</div>
          <div class="flex gap-2 mb-4">
            <label class="flex-1 cursor-pointer">
              <input type="radio" name="returnType" value="stock_return" checked
                class="mr-2" onchange="updateReturnType()">
              <span class="text-sm">📦 Trả lại kho</span>
            </label>
            <label class="flex-1 cursor-pointer">
              <input type="radio" name="returnType" value="damage_return"
                class="mr-2" onchange="updateReturnType()">
              <span class="text-sm">⚠️ Bia lỗi</span>
            </label>
          </div>

          <div id="reasonInput" class="mb-4 hidden">
            <label class="block text-sm font-medium text-main mb-1">Lý do:</label>
            <input type="text" id="returnReason"
              class="w-full border-2 border-primary rounded px-3 py-2 focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
              placeholder="Bia hư, chua,...">
          </div>

          <div class="flex gap-2">
            <button onclick="closeReturnModal()"
              class="btn btn-ghost flex-1 py-3">
              Hủy
            </button>
            <button onclick="submitPartialReturn(${id})"
              class="btn btn-warning flex-1 py-3">
              Xác nhận
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // Xóa modal cũ nếu có và thêm modal mới
  document.getElementById('returnModal')?.remove();
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// Cập nhật preview tiền hoàn
function updateReturnPreview(input, maxQty) {
  let qty = parseInt(input.value) || 0;
  const price = parseFloat(input.dataset.price) || 0;
  
  // Validate
  if (qty > maxQty) {
    qty = maxQty;
    input.value = maxQty;
  }
  if (qty < 0) {
    qty = 0;
    input.value = 0;
  }
  
  // Tính tổng
  calculateReturnTotal();
}

// Tính tổng tiền hoàn
function calculateReturnTotal() {
  const modal = document.getElementById('returnModal');
  if (!modal) return 0;
  
  const inputs = modal.querySelectorAll('[id^="return_qty_"]');
  let total = 0;
  
  inputs.forEach(input => {
    const productId = input.id.replace('return_qty_', '');
    const price = parseFloat(input.dataset.price) || 0;
    const qty = parseInt(input.value) || 0;
    total += qty * price;
  });
  
  const formatted = Format.number(total);
  const previewEl = document.getElementById('returnPreview');
  if (previewEl) {
    previewEl.innerHTML = '<span class="value">' + formatted + '</span><span class="unit"> đ</span>';
  }
  
  return total;
}

// Cập nhật hiển thị lý do theo loại trả
function updateReturnType() {
  const returnType = document.querySelector('input[name="returnType"]:checked').value;
  const reasonInput = document.getElementById('reasonInput');
  
  if (returnType === 'damage_return') {
    reasonInput.classList.remove('hidden');
  } else {
    reasonInput.classList.add('hidden');
  }
}

// Đóng modal
function closeReturnModal() {
  document.getElementById('returnModal')?.remove();
}

// Gửi yêu cầu trả hàng
async function submitPartialReturn(saleId) {
  var modal = document.getElementById('returnModal');
  if (!modal) return;

  var returnItems = [];
  var inputs = modal.querySelectorAll('[id^="return_qty_"]');

  inputs.forEach(function(input) {
    var productId = parseInt(input.id.replace('return_qty_', ''));
    var qty = parseInt(input.value) || 0;

    if (qty > 0) {
      returnItems.push({ productId: productId, quantity: qty });
    }
  });

  if (returnItems.length === 0) {
    alert('Vui lòng chọn sản phẩm để trả');
    return;
  }

  var returnType = document.querySelector('input[name="returnType"]:checked').value;
  var reason = document.getElementById('returnReason')?.value || '';

  var btn = modal.querySelector('[onclick^="submitPartialReturn"]');
  var btnState = btn ? setButtonLoading(btn) : null;

  try {
    var res = await fetch('/api/sales/' + saleId + '/return-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: returnItems,
        returnType: returnType,
        reason: reason
      }),
      cache: 'no-store'
    });
    var result;
    try { result = await res.json(); } catch (_) { result = {}; }
    if (!res.ok) throw new Error(result.error || 'Trả hàng thất bại');

    closeReturnModal();

    var msg = returnType === 'stock_return'
      ? 'Đã trả hàng (trả lại kho)!\n\n'
      : 'Đã ghi nhận bia lỗi!\n\n';
    alert(msg +
      'Hoàn tiền: ' + formatVND(result.returnedAmount) + '\n' +
      'Sản phẩm: ' + result.returnedQuantity + '\n' +
      'Vỏ trả: ' + result.returnedKegs);

    patchSaleRow({ id: saleId, status: 'returned' });
    window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
  } catch (err) {
    console.error('[submitPartialReturn]', err);
    showToast('Trả hàng thất bại: ' + (err.message || 'Lỗi không xác định'), 'error');
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

async function editSale(id) {
  var res = await fetch('/api/sales/' + id);
  var sale = await res.json();

  var repModal = document.getElementById('replacementModal');
  if (repModal && repModal.classList.contains('flex')) {
    repModal.classList.add('hidden');
    repModal.classList.remove('flex');
  }

  editingSaleId = id;
  syncSaleEditAuxSheet();

  var customerSelectEl = document.getElementById('customerSelect');
  if (customerSelectEl) customerSelectEl.value = sale.customer_id || '';

  if (sale.customer_id) {
    applyResolvedPrices(sale.customer_id, null);
    try {
      var pres = await fetch('/api/products/prices?customerId=' + encodeURIComponent(sale.customer_id));
      if (pres.ok) {
        var prices = await pres.json();
        if (Array.isArray(prices)) {
          applyResolvedPrices(sale.customer_id, prices);
        }
      }
    } catch (e) {
      console.error('[Sales] editSale prices:', e);
    }
  } else {
    applyResolvedPrices('', null);
  }

  renderSaleProducts();
  updateKegSaleSection(sale.customer_id || '');
  updateSaleKegPreview();
  saleData = {};
  products.forEach(function(p) {
    var qtyInput = document.getElementById('qty-' + p.id);
    var priceInput = document.getElementById('price-' + p.id);
    if (qtyInput) qtyInput.value = '';
    if (priceInput) {
      priceInput.value = p._displayPrice != null ? Number(p._displayPrice) : effectiveSellPrice(p);
    }
  });

  // Pre-fill keg inputs from sale (nếu trang có block vỏ bình)
  var _edD = document.getElementById('saleDeliverKegs');
  var _edR = document.getElementById('saleReturnKegs');
  if (_edD) _edD.value = sale.deliver_kegs || 0;
  if (_edR) _edR.value = sale.return_kegs || 0;
  _kegDeliverManual = true;
  _kegReturnManual = true;

  // Set quantities from sale
  (sale.items || []).forEach(function(item) {
    var qtyInput = document.getElementById('qty-' + item.product_id);
    var priceInput = document.getElementById('price-' + item.product_id);
    if (qtyInput) qtyInput.value = item.quantity;
    if (priceInput) priceInput.value = item.price;
    saleData[item.product_id] = {
      quantity: item.quantity,
      price: item.price
    };
  });

  updateSaleTotal();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEdit() {
  editingSaleId = null;
  saleData = {};

  syncSaleEditAuxSheet();

  var customerSelectEl = document.getElementById('customerSelect');
  if (customerSelectEl) customerSelectEl.value = '';
  var _cxD = document.getElementById('saleDeliverKegs');
  var _cxR = document.getElementById('saleReturnKegs');
  if (_cxD) _cxD.value = 0;
  if (_cxR) _cxR.value = 0;

  applyResolvedPrices('', null);
  renderSaleProducts();
  updateSaleTotal();
  updateKegSaleSection('');
  _kegDeliverManual = false;
  _kegReturnManual = false;
}

async function updateSale() {
  if (!editingSaleId) return;

  var customerIdEl = document.getElementById('customerSelect');
  var customerId = customerIdEl ? customerIdEl.value : '';

  var items = [];
  Object.keys(saleData).forEach(function(productId) {
    var item = saleData[productId];
    if (item.quantity > 0 && item.price > 0) {
      var product = getProduct(productId);
      items.push({
        productId: parseInt(productId),
        productSlug: product ? product.slug : null,
        quantity: item.quantity,
        price: item.price
      });
    }
  });

  if (items.length === 0) return alert('Chưa chọn sản phẩm nào');

  var btn = document.getElementById('updateSaleBtn');
  var btnState = btn ? setButtonLoading(btn, 'Đang cập nhật...') : null;

  try {
    var res = await fetch('/api/sales/' + editingSaleId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: customerId ? parseInt(customerId) : null,
        items: items
      }),
      cache: 'no-store'
    });
    var result;
    try { result = await res.json(); } catch (_) { result = {}; }
    if (!res.ok) throw new Error(result.error || 'Cập nhật thất bại');

    alert('Cập nhật thành công!');
    var updated = result.sale || result;
    var idx = window.store.sales.findIndex(function(s) { return s.id === updated.id; });
    if (idx !== -1) window.store.sales[idx] = updated;
    patchSaleRow(updated);
    cancelEdit();
    window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
  } catch (err) {
    console.error('[updateSale]', err);
    showToast('Cập nhật thất bại: ' + (err.message || 'Lỗi không xác định'), 'error');
    await loadSalesHistory();
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

var _salesRefreshTimer = null;
var _salesRefreshInFlight = false;

function shouldRefreshSalesEntity(entity) {
  if (!entity) return true;
  return entity === 'sale' || entity === 'customer' || entity === 'product' || entity === 'keg' || entity === 'sync';
}

function shouldRefreshSalesPath(pathname) {
  if (!pathname) return false;
  return pathname.indexOf('/api/sales') === 0 ||
    pathname.indexOf('/api/customers') === 0 ||
    pathname.indexOf('/api/products') === 0 ||
    pathname.indexOf('/api/kegs') === 0 ||
    pathname.indexOf('/sale/data') === 0;
}

async function refreshSalesPage(reason) {
  if (_salesRefreshInFlight) return;
  _salesRefreshInFlight = true;
  console.log('[CONSISTENCY][Sales] refresh', reason || 'mutation');
  try {
    if (typeof loadData === 'function') {
      await loadData();
    } else {
      await Promise.all([
        typeof loadSalesHistory === 'function' ? loadSalesHistory() : Promise.resolve(),
        typeof updatePrices === 'function' ? Promise.resolve(updatePrices()) : Promise.resolve()
      ]);
    }
  } finally {
    _salesRefreshInFlight = false;
  }
}

function queueSalesRefresh(reason) {
  clearTimeout(_salesRefreshTimer);
  _salesRefreshTimer = setTimeout(function() {
    refreshSalesPage(reason || 'mutation');
  }, 180);
}

window.addEventListener('data:mutated', function(evt) {
  var detail = evt && evt.detail ? evt.detail : {};
  if (!shouldRefreshSalesEntity(detail.entity)) return;
  queueSalesRefresh(detail.entity || 'mutation');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', function(event) {
    var data = event && event.data ? event.data : {};
    if (data.type !== 'DATA_INVALIDATED') return;
    if (!shouldRefreshSalesPath(data.path || '')) return;
    queueSalesRefresh('sw:' + (data.path || 'unknown'));
  });
}

/** PERFORMANCE: Debounced updateSaleTotal — coalesces rapid keystrokes, max 1 call per 100ms.
 *  Call this from updateSaleData() instead of updateSaleTotal() directly. */
const _debouncedUpdateTotal = _debounce(updateSaleTotal, 100);

// ========== EVENT-DRIVEN SYNC INTEGRATION ==========

// Load scripts in order
async function loadModules() {
  console.log('[EVENT] Loading modules...');

  // Core modules
  await loadScript('/js/db.js');
  await loadScript('/js/event-store.js');
  await loadScript('/js/apply-event.js');
  await loadScript('/js/event-sync.js');
  await loadScript('/js/websocket.js');
  await loadScript('/js/consistency-check.js');
  await loadScript('/js/offline-store.js');

  console.log('[EVENT] All modules loaded');
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// Initialize event-driven sync when page loads
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[EVENT] Initializing event-driven sync...');

  await loadModules();

  // Wait for OfflineStore
  let retries = 0;
  while (!window.OfflineStore && retries < 20) {
    await new Promise(r => setTimeout(r, 100));
    retries++;
  }

  if (window.OfflineStore) {
    await window.OfflineStore.init();
    console.log('[EVENT] Event-driven sync ready');

    // Listen for entity updates → refresh UI
    window.addEventListener('entity:updated', (e) => {
      const { type, data } = e.detail || {};
      
      // Refresh relevant data
      if (type?.startsWith('order:')) {
        if (typeof loadSalesHistory === 'function') {
          loadSalesHistory();
        }
      }
      if (type?.startsWith('product:')) {
        if (typeof loadData === 'function') {
          loadData();
        }
      }
    });

    // Listen for sync status
    window.addEventListener('eventsync:sync:complete', (e) => {
      console.log('[EVENT] Sync complete:', e.detail);
      updateSyncStatusIndicator();
    });

    window.addEventListener('eventsync:conflict', (e) => {
      console.warn('[EVENT] Conflict:', e.detail);
      showToast('Phát hiện xung đột. Đang xử lý...', 'warning');
    });

    // Consistency check listener
    window.addEventListener('consistency:mismatch', (e) => {
      console.warn('[EVENT] Consistency mismatch:', e.detail);
      showToast('Phát hiện lệch dữ liệu. Đang đồng bộ...', 'warning');
    });

    // Update sync status periodically — wrapped in setInterval to prevent unhandled errors
    updateSyncStatusIndicator();
    let _syncStatusInterval = null;
    function _safeUpdateSyncStatus() {
      if (_syncStatusInterval) clearInterval(_syncStatusInterval);
      _syncStatusInterval = setInterval(async () => {
        try {
          await updateSyncStatusIndicator();
        } catch (err) {
          console.warn('[Sales] updateSyncStatusIndicator skipped:', err?.message);
        }
      }, 5000);
    }
    _safeUpdateSyncStatus();
  }
});

async function updateSyncStatusIndicator() {
  if (!window.OfflineStore) return;

  try {
    const status = await window.OfflineStore.getSyncStatus();
    if (!status) return;

    const indicator = document.getElementById('syncStatusIndicator');

    if (indicator) {
      indicator.style.display = 'block';

      if (!status.isOnline) {
        indicator.innerHTML = '📴 Offline';
        indicator.className = 'text-xs text-warning';
      } else if (status.status === 'error') {
        indicator.innerHTML = '⚠️ Sync lỗi';
        indicator.className = 'text-xs text-error';
      } else if ((status.pendingEvents || 0) > 0) {
        indicator.innerHTML = `🔄 Sync (${status.pendingEvents})`;
        indicator.className = 'text-xs text-info';
      } else {
        indicator.innerHTML = '✅ Sync OK';
        indicator.className = 'text-xs text-success';
      }
    }
  } catch (error) {
    console.warn('[Sales] updateSyncStatusIndicator error:', error?.message);
  }
}

console.log('[Sales] Offline integration loaded');
