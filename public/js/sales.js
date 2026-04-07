// Sales Page JavaScript
// Tách riêng để dễ bảo trì và cache
// formatVND, showToast đã được định nghĩa trong utils.js

let products = [];
let priceMap = {};
let customers = [];
let editingSaleId = null;
let saleData = {};

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

/** PERFORMANCE: O(1) Maps — rebuilt once when data loads, reused for all lookups */
let _productById  = new Map();
let _customerById = new Map();

function _rebuildMaps() {
  _productById.clear();
  products.forEach(p => _productById.set(p.id, p));
  _customerById.clear();
  customers.forEach(c => _customerById.set(c.id, c));
}

function getProduct(productId) {
  return _productById.get(Number(productId)) || null;
}

function getCustomer(customerId) {
  if (!customerId) return null;
  return _customerById.get(Number(customerId)) || null;
}

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

/** Giá bán mặc định từ sản phẩm (SQLite / Dexie có thể dùng sell_price hoặc price) */
function effectiveSellPrice(p) {
  if (!p) return 0;
  const v = p.sell_price != null ? p.sell_price : p.price;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Giá theo khách từ payload /sale/data (không cần fetch thêm — tránh mobile lỗi 0 đ) */
function lookupPriceMap(customerId, productId) {
  if (customerId == null || customerId === '' || !priceMap) return undefined;
  const row = priceMap[customerId] || priceMap[String(customerId)];
  if (!row) return undefined;
  const v = row[productId] ?? row[String(productId)];
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Áp giá hiển thị + saleData.price khi có khách.
 * apiPrices: null → chỉ dùng priceMap + sell_price; array → ưu tiên hàng từ API (mới nhất).
 */
function applyResolvedPrices(customerId, apiPrices) {
  if (!customerId) {
    products.forEach(p => {
      p._displayPrice = effectiveSellPrice(p);
      if (saleData[p.id]) {
        saleData[p.id].price = effectiveSellPrice(p);
      }
    });
    return;
  }
  products.forEach(p => {
    let row = null;
    if (Array.isArray(apiPrices)) {
      row = apiPrices.find(x => x.product_id === p.id) || null;
    }
    if (row && row.price != null && row.price !== '') {
      const unit = Number(row.price) || 0;
      p._displayPrice = unit;
      saleData[p.id] = saleData[p.id] || { quantity: 0, price: unit };
      saleData[p.id].price = unit;
      return;
    }
    const mapped = lookupPriceMap(customerId, p.id);
    if (mapped != null) {
      p._displayPrice = mapped;
      saleData[p.id] = saleData[p.id] || { quantity: 0, price: mapped };
      saleData[p.id].price = mapped;
    } else {
      p._displayPrice = effectiveSellPrice(p);
    }
  });
}

function initSalesPage(data) {
  products = data.products;
  customers = data.customers;
  priceMap = data.priceMap || {};

  // PERFORMANCE: rebuild O(1) Maps once after data loads
  _rebuildMaps();

  // Render customer select - include "Khach le" option
  var customerSelect = document.getElementById('customerSelect');
  if (customerSelect) {
    customerSelect.innerHTML = '<option value="">📋 Khách lẻ (giá thường)</option>' +
      customers.map(function(c) { return '<option value="' + c.id + '">' + c.name + ' (' + c.keg_balance + ' bình)</option>'; }).join('');
  }

  // Giá: ưu tiên priceMap cùng /sale/data, sau đó (nếu online) làm mới từ API
  updatePrices();

  // Load keg state for inventory validation
  fetch('/api/kegs/state')
    .then(function(res) { return res.json(); })
    .then(function(state) { kegState = state || {}; })
    .catch(function() { kegState = {}; });

  // Load history
  loadSalesHistory();

  syncSaleEditAuxSheet();
}

// Global keg state for validation
let kegState = {};

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
    const currentPrice = (saleData[p.id] && saleData[p.id].price !== undefined) ? saleData[p.id].price : effectiveSellPrice(p);
    const priceInputVal = (saleData[p.id] && saleData[p.id].price !== undefined)
      ? saleData[p.id].price
      : (effectiveSellPrice(p) || '');
    const isLowStock = p.stock < 5;
    const currentQty = saleData[p.id] ? saleData[p.id].quantity : '';
    const priceLine = isKhachLe
      ? `· Tồn: <span class="${p.stock < 5 ? 'text-danger font-semibold' : 'text-muted'}">${p.stock}</span>`
      : `Giá: <span class="text-primary font-bold">${formatVND(price)}</span> · Tồn: <span class="${p.stock < 5 ? 'text-danger' : 'text-muted'}">${p.stock}</span>`;
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
        <div class="text-xs text-muted mt-0.5">${priceLine}</div>
        ${priceField}
        <input type="number" id="qty-${p.id}" min="0" max="${p.stock}" value="${currentQty > 0 ? currentQty : ''}" data-stock="${p.stock}"
          placeholder="Nhập SL"
          inputmode="numeric" enterkeyhint="done"
          class="mt-2 w-full border-2 border-primary rounded-xl p-3 text-center text-lg font-bold focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none ${currentQty > 0 ? 'bg-primary/10' : ''}"
          onchange="updateSaleData(${p.id}, 'quantity', this.value);"
          oninput="updateSaleData(${p.id}, 'quantity', this.value);">
      </div>
    `;
  }).join('');
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
            <div class="text-sm text-muted mt-1">Tồn kho: ${product.stock}</div>
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
  const input = document.getElementById('qty-' + productId);
  const current = parseInt(input.value) || 0;
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
    saleData[productId] = {
      quantity: 0,
      price: (product && product._displayPrice != null && product._displayPrice !== '')
        ? Number(product._displayPrice)
        : effectiveSellPrice(product)
    };
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
        '<span class="text-muted shrink-0 tabular-nums">' + Format.number(item.price) + ' đ × ' + item.quantity + '</span>' +
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
  const customerId = document.getElementById('customerSelect').value;
  const deliverInput = document.getElementById('saleDeliverKegs');
  const returnInput = document.getElementById('saleReturnKegs');
  const balanceEl = document.getElementById('saleKegBalance');
  const afterEl = document.getElementById('saleKegAfter');
  const warningEl = document.getElementById('saleKegWarning');

  const deliver = parseInt(deliverInput?.value) || 0;
  const returned = parseInt(returnInput?.value) || 0;

  const customer = getCustomer(customerId);
  const currentBalance = customer ? (customer.keg_balance || 0) : 0;
  const afterBalance = currentBalance + deliver - returned;

  if (afterEl) afterEl.textContent = afterBalance + ' vỏ';
  if (balanceEl) balanceEl.textContent = currentBalance + ' vỏ';

  // Check inventory
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
  const customerId = document.getElementById('customerSelect').value;
  if (!customerId) {
    alert('Vui lòng chọn khách hàng trước');
    return;
  }

  // Find product with highest stock or first available
  const availableProducts = products.filter(p => p.stock > 0);
  if (availableProducts.length === 0) {
    alert('Không có sản phẩm trong kho');
    return;
  }

  // Add to first product (or you can customize this logic)
  const product = availableProducts[0];
  const input = document.getElementById('qty-' + product.id);
  const currentQty = parseInt(input.value) || 0;
  const maxAdd = product.stock - currentQty;
  const toAdd = Math.min(amount, maxAdd);

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
  const customerId = document.getElementById('customerSelect').value;

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
  const customerId = document.getElementById('customerSelect').value;

  // Build items from saleData - STEP 5: Use priceAtTime for price snapshot
  const items = [];
  Object.keys(saleData).forEach(productId => {
    const item = saleData[productId];
    if (item.quantity > 0 && item.price > 0) {
      items.push({
        productId: parseInt(productId),
        quantity: item.quantity,
        price: item.price,
        priceAtTime: item.price
      });
    }
  });

  if (items.length === 0) return showToast('Chưa chọn sản phẩm nào', 'error');

  const deliverKegs = parseInt(document.getElementById('saleDeliverKegs')?.value) || 0;
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
  const tempId = 'tmp_sale_' + Date.now();
  const payload = {
    customerId: customerId ? parseInt(customerId) : null,
    items: items,
    deliverKegs: deliverKegs,
    returnKegs: parseInt(document.getElementById('saleReturnKegs')?.value) || 0
  };

  // Snapshot current form state for rollback
  const snapshotCart = Object.assign({}, saleData);
  const snapshotCustomer = customerId;

  optimisticMutate({
    entity: 'sale',
    request: function() {
      return fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store'
      });
    },

    applyOptimistic: function() {
      // Disable button immediately
      if (btn) { btn.disabled = true; btn.textContent = 'Đang xử lý...'; }

      // Optimistically add temp sale card
      const tempSale = {
        id: tempId,
        customer_name: customerId ? (getCustomer(customerId)?.name || 'Khách') : 'Khách lẻ',
        date: new Date().toISOString(),
        total: total,
        items_qty: items.reduce(function(s, it) { return s + it.quantity; }, 0),
        status: 'pending',
        _optimistic: true
      };
      syncSalesState([tempSale].concat(allSales));
      if (historyCurrentPage === 1) {
        renderHistoryPage();
      }

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
    },

    rollback: function() {
      // Restore button
      if (btn) { btn.disabled = false; btn.textContent = '✔ Bán hàng'; }

      // Remove temp sale from store and DOM
      syncSalesState(allSales.filter(function(s) { return s.id !== tempId; }));
      removeSaleItem(tempId);

      // Restore cart
      saleData = snapshotCart;
      var _cs2 = document.getElementById('customerSelect');
      if (_cs2) _cs2.value = snapshotCustomer || '';
      const _dK2 = document.getElementById('saleDeliverKegs');
      const _rK2 = document.getElementById('saleReturnKegs');
      if (_dK2) _dK2.value = payload.deliverKegs;
      if (_rK2) _rK2.value = payload.returnKegs;
      applyResolvedPrices(snapshotCustomer, null);
      renderSaleProducts();
      updateSaleTotal();
      if (snapshotCustomer) updateKegSaleSection(snapshotCustomer);
    },

    onSuccess: function(result) {
      haptic && haptic('success');

      if (btn) { btn.disabled = false; btn.textContent = '✔ Bán hàng'; }

      // Remove temp card from both stores and DOM
      syncSalesState(allSales.filter(function(s) { return s.id !== tempId; }));
      removeSaleItem(tempId);

      // Build a complete sale object for immediate display.
      // The API returns { success, id, total, profit }; use optimistic data
      // for fields not returned by the API.
      var newSale = Object.assign({}, result);
      if (!newSale.customer_name) newSale.customer_name = customerId ? (getCustomer(customerId)?.name || 'Khách') : 'Khách lẻ';
      if (!newSale.date)         newSale.date         = new Date().toISOString();
      if (!newSale.items_qty)    newSale.items_qty    = items.reduce(function(s, it) { return s + it.quantity; }, 0);
      if (!newSale.status)       newSale.status       = null;
      if (!newSale.type)         newSale.type         = 'sale';

      if (historyCurrentPage === 1) {
        syncSalesState([newSale].concat(allSales));
        salesPagination.total = (salesPagination.total || 0) + 1;
        salesPagination.totalPages = Math.ceil(salesPagination.total / HISTORY_PAGE_SIZE);
        try {
          renderHistoryPage();
        } catch (renderErr) {
          console.warn('[submitSale] renderHistoryPage failed:', renderErr);
          loadSalesHistory();
        }
        showToast('Bán hàng thành công!', 'success');
      } else {
        salesPagination.total = (salesPagination.total || 0) + 1;
        salesPagination.totalPages = Math.ceil(salesPagination.total / HISTORY_PAGE_SIZE);
        historyCurrentPage = 1;
        showToast('Bán hàng thành công! Đơn mới ở trang 1.', 'success');
        loadSalesHistory();
      }

      try {
        showInvoiceModal(result.id);
      } catch(err) {
        console.error('Lỗi hiển thị hóa đơn:', err);
        const modal = document.getElementById('invoiceModal');
        if (modal) {
          document.querySelector('#invoiceModal .invoice-total-value').textContent = Format.number(result.total || 0);
          document.getElementById('invoiceContent').innerHTML =
            '<div class="text-center text-muted py-8">Đơn hàng #'+ result.id +'</div>';
          document.getElementById('qrCode').src = '';
          modal.classList.remove('hidden');
          modal.classList.add('flex');
        }
      }
    },

    refetch: refetchSalesHistory,

    onError: function() {
      if (btn) { btn.disabled = false; btn.textContent = '✔ Bán hàng'; }
    }
  });
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

  var tempId = 'tmp_rep_' + Date.now();
  var btn = document.getElementById('submitReplacementBtn');

  optimisticMutate({
    request: function() {
      return fetch('/api/sales/replacement', {
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
    },

    applyOptimistic: function() {
      if (btn) { btn.disabled = true; btn.textContent = 'Đang xử lý...'; }
    },

    rollback: function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Xác nhận đổi lỗi'; }
    },

    onSuccess: function(data) {
      alert('✅ ' + data.message);
      closeReplacementModal();
      if (btn) { btn.disabled = false; btn.textContent = 'Xác nhận đổi lỗi'; }
      if (salesPagination.page === 1) {
        loadSalesHistory();
      } else {
        showToast('Đơn đổi bia đã được tạo', 'success');
        salesPagination.page = 1;
        loadSalesHistory();
      }
    },

    onError: function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Xác nhận đổi lỗi'; }
    }
  });
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
    returnPreviewEl.className = 'font-bold ' + (formThu > 0 ? 'text-danger' : 'text-muted');
  }

  // Validation: cannot return more than customer holds after this edit
  const maxAllowedReturn = _invoiceCustBalance + deltaGiao;
  const warningEl = document.getElementById('kegModalWarning');
  if (formThu > maxAllowedReturn) {
    warningEl.classList.remove('hidden');
    warningEl.textContent = '⚠️ Không thể thu ' + formThu + ' vỏ. Khách chỉ giữ tối đa ' + maxAllowedReturn + ' vỏ';
  } else {
    warningEl.classList.add('hidden');
  }
}

async function saveKegUpdate() {
  if (!_invoiceSaleId || !_invoiceCustomerId) return;

  const formGiao = safeNumber(document.getElementById('kegDeliver').value);
  const formThu  = safeNumber(document.getElementById('kegReturn').value);

  // Delta so với snapshot đã lưu (hoặc 0 nếu create mode)
  const old = _invoiceShell || { giao: 0, thu: 0 };
  const deltaGiao = formGiao - old.giao;
  const deltaThu  = formThu  - old.thu;

  // Validation: cannot return more than customer holds after this edit
  const maxAllowedReturn = _invoiceCustBalance + deltaGiao;
  const errorEl = document.getElementById('kegModalError');
  if (formThu > maxAllowedReturn) {
    errorEl.textContent = '⚠️ Không thể thu ' + formThu + ' vỏ. Khách chỉ giữ tối đa ' + maxAllowedReturn + ' vỏ';
    errorEl.classList.remove('hidden');
    return;
  }
  errorEl.classList.add('hidden');

  const saleId = _invoiceSaleId;
  const btn = document.getElementById('kegSaveBtn');

  optimisticMutate({
    request: function() {
      return fetch('/api/sales/update-kegs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ saleId: saleId, customerId: _invoiceCustomerId, deliver: formGiao, returned: formThu }),
        cache: 'no-store'
      });
    },

    applyOptimistic: function() {
      if (btn) { btn.disabled = true; btn.textContent = 'Đang cập nhật...'; }
    },

    rollback: function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Cập nhật'; }
    },

    onSuccess: async function(result) {
      if (btn) { btn.disabled = false; btn.textContent = 'Cập nhật'; }
      const custListRes = await fetch('/api/customers');
      const custData = await custListRes.json();
      customers = custData.customers || custData;
      window.store.customers = customers;
      _rebuildMaps();

      alert('Cập nhật vỏ thành công!\n\nGiao: ' + formGiao + ' | Thu: ' + formThu + '\nVỏ tại khách: ' + (result.new_balance || result.newBalance));

      closeKegModal();
      patchSaleRow({ id: saleId, deliver_kegs: formGiao, return_kegs: formThu, keg_balance_after: (result.new_balance || result.newBalance) });
      await refreshInvoiceIfOpen(saleId);
    },

    onError: async function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Cập nhật'; }
      await loadSalesHistory();
      if (window.location.pathname === '/' || window.location.pathname === '/dashboard') {
        if (typeof loadData === 'function') await loadData();
      }
    }
  });
}

async function showInvoiceModal(saleId) {
  const modal = document.getElementById('invoiceModal');
  if (!modal) {
    console.error('Không tìm thấy phần tử #invoiceModal');
    return;
  }

  const res = await fetch('/api/sales/' + saleId);
  if (!res.ok) {
    console.error('Không lấy được dữ liệu hóa đơn:', res.status);
    return;
  }
  const sale = await res.json();
  
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
      kegHtml += '<div class="flex justify-between text-sm"><span class="text-muted">📦 Giao vỏ</span><span class="font-semibold text-success">+' + deliverKegs + '</span></div>';
    }
    if (returnKegs > 0) {
      kegHtml += '<div class="flex justify-between text-sm"><span class="text-muted">🔁 Thu vỏ</span><span class="font-semibold text-warning">-' + returnKegs + '</span></div>';
    }
    kegHtml += '<div class="flex justify-between text-sm font-semibold pt-1"><span class="text-main">Vỏ đang giữ:</span><span>' + newBalance + '</span></div></div>';
  }

  const giftBadge = isGift ? '<div class="text-center mb-3"><span class="badge badge-warning">🎁 Tặng uống thử</span></div>' : '';

  const invoiceContent = document.getElementById('invoiceContent');
  if (invoiceContent) {
    invoiceContent.innerHTML =
      giftBadge +
      '<div class="text-xs text-muted mb-1">' + dateStr + '</div>' +
      '<div class="text-sm font-semibold text-main mb-3">Khách: ' + customerName + '</div>' +
      '<div class="border-t border-muted/50 pt-3">' + itemsHtml + '</div>' +
      kegHtml;
  }
  
  const invoiceTotalEl = document.querySelector('#invoiceModal .invoice-total-value');
  if (invoiceTotalEl) {
    invoiceTotalEl.textContent = Format.number(sale.total || 0);
  }
  
  const qrSection = document.querySelector('#invoiceModal .invoice-qr-card');
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
  document.getElementById('collectKegModal').classList.add('hidden');
  document.getElementById('collectKegModal').classList.remove('flex');
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
  const saleId = _collectKegSaleId;
  const returned = safeNumber(document.getElementById('collectKegReturn').value);

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

  const btn = document.getElementById('submitCollectKegBtn');

  optimisticMutate({
    request: function() {
      return fetch('/api/kegs/return', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sale_id: saleId, returned_kegs: returned }),
        cache: 'no-store'
      });
    },

    applyOptimistic: function() {
      if (btn) { btn.disabled = true; btn.textContent = 'Đang cập nhật...'; }
    },

    rollback: function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Cập nhật vỏ'; }
    },

    onSuccess: async function(result) {
      if (btn) { btn.disabled = false; btn.textContent = 'Cập nhật vỏ'; }

      const custListRes = await fetch('/api/customers');
      const custData = await custListRes.json();
      customers = custData.customers || custData;
      window.store.customers = customers;
      _rebuildMaps();

      alert('Cập nhật vỏ thành công!\n\nThu: ' + returned + ' vỏ\nVỏ tại khách: ' + result.new_balance);

      closeCollectKegModal();
      patchSaleRow({ id: saleId, return_kegs: returned, keg_balance_after: result.new_balance });
      await refreshInvoiceIfOpen(saleId);
    },

    onError: async function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Cập nhật vỏ'; }
      await loadSalesHistory();
      if (window.location.pathname === '/' || window.location.pathname === '/dashboard') {
        if (typeof loadData === 'function') await loadData();
      }
    }
  });
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
    ? '<span class="text-xs text-muted ml-1 shrink-0">[G:' + kegDeliver + ' T:' + kegReturn + ']</span>'
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
  const { page, limit, month } = salesPagination;
  const monthParam = month !== 'all' ? `&month=${month}` : '';
  let data;
  try {
    const res = await fetch(`/api/sales?page=${page}&limit=${limit}${monthParam}`, { cache: 'no-store' });
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
      ? '<span class="text-xs text-muted ml-1 shrink-0">[G:' + kegDeliver + ' T:' + kegReturn + ']</span>'
      : '';
    var saleMoney = typeof Format !== 'undefined' ? Format.number(sale.total) : formatVND(sale.total).replace(' đ', '');

    parts.push(
'<div class="order-item ' + badgeLeft + '" data-sale-id="' + sale.id + '">' +
  '<div class="order-header">' +
    '<div class="flex items-center gap-2 min-w-0 flex-1">' +
      '<span class="text-xs font-semibold text-muted shrink-0">#' + sale.id + '</span>' +
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
  checkSalesEmpty();
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
        '<div class="history-total-row text-center text-xs text-muted mt-3 pt-2 border-t border-muted/70">Tổng ' + total + ' đơn</div>'
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
        <span class="text-[11px] text-muted leading-tight mt-0.5">${total} đơn</span>
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

  optimisticMutate({
    entity: 'sale',
    request: function() {
      return fetch('/api/sales/' + id, { method: 'DELETE', cache: 'no-store' });
    },

    applyOptimistic: function() {
      syncSalesState(allSales.filter(function(s) { return s.id !== id; }));
      removeSaleItem(id);
      salesPagination.total = Math.max(0, (salesPagination.total || 1) - 1);
      salesPagination.totalPages = Math.ceil(salesPagination.total / HISTORY_PAGE_SIZE);
      renderHistoryPage();
    },

    rollback: function() {
      if (deletedSale) {
        syncSalesState([deletedSale].concat(allSales));
        renderHistoryPage();
      }
    },

    onSuccess: function(result) {
      showToast(result.message || 'Đã xóa hóa đơn', 'success');
      btnStates.forEach(function(s) { restoreButtonLoading(s); });
      renderHistoryPage();
    },

    refetch: refetchSalesHistory,

    onError: function() {
      btnStates.forEach(function(s) { restoreButtonLoading(s); });
      loadSalesHistory();
    }
  });
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
        <div class="text-xs text-muted">Giá: ${formatVND(item.price)} | Đã mua: ${item.quantity}</div>
      </div>
      <div class="flex items-center gap-2">
        <input type="number" id="return_qty_${item.product_id}"
          data-price="${item.price}"
          min="0" max="${item.quantity}" value="0"
          class="w-16 border-2 border-primary rounded px-2 py-1 text-center focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
          placeholder="0" onchange="updateReturnPreview(this, ${item.quantity})" oninput="updateReturnPreview(this, ${item.quantity})">
        <span class="text-xs text-muted">/${item.quantity}</span>
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
  const modal = document.getElementById('returnModal');
  if (!modal) return;

  const returnItems = [];
  const inputs = modal.querySelectorAll('[id^="return_qty_"]');

  inputs.forEach(input => {
    const productId = parseInt(input.id.replace('return_qty_', ''));
    const qty = parseInt(input.value) || 0;

    if (qty > 0) {
      returnItems.push({ productId, quantity: qty });
    }
  });

  if (returnItems.length === 0) {
    alert('Vui lòng chọn sản phẩm để trả');
    return;
  }

  const returnType = document.querySelector('input[name="returnType"]:checked').value;
  const reason = document.getElementById('returnReason')?.value || '';

  const btn = modal.querySelector('[onclick^="submitPartialReturn"]');
  var btnState = btn ? setButtonLoading(btn) : null;

  optimisticMutate({
    request: function() {
      return fetch('/api/sales/' + saleId + '/return-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: returnItems,
          returnType: returnType,
          reason: reason
        }),
        cache: 'no-store'
      });
    },

    applyOptimistic: function() {
      closeReturnModal();
    },

    rollback: function() {
      if (btnState) restoreButtonLoading(btnState);
    },

    onSuccess: function(result) {
      if (btnState) restoreButtonLoading(btnState);
      const msg = returnType === 'stock_return'
        ? 'Đã trả hàng (trả lại kho)!\n\n'
        : 'Đã ghi nhận bia lỗi!\n\n';
      alert(msg +
        'Hoàn tiền: ' + formatVND(result.returnedAmount) + '\n' +
        'Sản phẩm: ' + result.returnedQuantity + '\n' +
        'Vỏ trả: ' + result.returnedKegs);

      patchSaleRow({ id: saleId, status: 'returned' });
    },

    onError: function() {
      if (btnState) restoreButtonLoading(btnState);
    }
  });
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

  const customerId = document.getElementById('customerSelect').value;

  const items = [];
  Object.keys(saleData).forEach(productId => {
    const item = saleData[productId];
    if (item.quantity > 0 && item.price > 0) {
      items.push({
        productId: parseInt(productId),
        quantity: item.quantity,
        price: item.price
      });
    }
  });

  if (items.length === 0) return alert('Chưa chọn sản phẩm nào');

  const btn = document.getElementById('updateSaleBtn');

  // Snapshot current sale data for rollback
  const oldSale = Object.assign({}, window.store.sales.find(function(s) { return s.id === editingSaleId; }));
  const snapshotCart = Object.assign({}, saleData);
  const snapshotCustomer = document.getElementById('customerSelect') ? document.getElementById('customerSelect').value : '';

  optimisticMutate({
    request: function() {
      return fetch('/api/sales/' + editingSaleId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: customerId ? parseInt(customerId) : null,
          items: items
        }),
        cache: 'no-store'
      });
    },

    applyOptimistic: function() {
      if (btn) { btn.disabled = true; btn.textContent = 'Đang cập nhật...'; }
      // Optimistically patch the row
      patchSaleRow({
        id: editingSaleId,
        customer_name: customerId ? (getCustomer(customerId)?.name || 'Khách') : 'Khách lẻ',
        total: items.reduce(function(s, it) { return s + it.quantity * it.price; }, 0)
      });
    },

    rollback: function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Cập nhật'; }
      if (oldSale) patchSaleRow(oldSale);
      saleData = snapshotCart;
      document.getElementById('customerSelect').value = snapshotCustomer;
    },

    onSuccess: function(result) {
      if (btn) { btn.disabled = false; btn.textContent = 'Cập nhật'; }
      alert('Cập nhật thành công!');
      var updated = result.sale || result;
      var idx = window.store.sales.findIndex(function(s) { return s.id === updated.id; });
      if (idx !== -1) window.store.sales[idx] = updated;
      patchSaleRow(updated);
      cancelEdit();
    },

    onError: function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Cập nhật'; }
      loadSalesHistory();
    }
  });
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
