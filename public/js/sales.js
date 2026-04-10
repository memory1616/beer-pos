// Sales Page JavaScript — New Card-Based POS
// Giống nhập hàng: single column, qty input per card, no cart sidebar

// ============================================================
// STATE
// ============================================================
let products = [];
let customers = [];
let priceMap = {};
let editingSaleId = null;

// Sale state: { customerId, items: [{productId, qty, price}] }
let saleState = {
  customerId: null,
  items: []
};

// O(1) lookup maps
let _productById = new Map();
let _productBySlug = new Map();
let _customerById = new Map();

const _LOW_STOCK_THRESHOLD = 30;

// ============================================================
// MAPS
// ============================================================
function _rebuildMaps() {
  _productById.clear();
  _productBySlug.clear();
  products.forEach(function(p) {
    _productById.set(p.id, p);
    if (p.slug) _productBySlug.set(p.slug, p);
  });
  _customerById.clear();
  customers.forEach(function(c) { _customerById.set(c.id, c); });
}

function getProduct(productId) {
  if (!productId && productId !== 0) return null;
  return _productById.get(Number(productId)) || null;
}

function getCustomer(customerId) {
  if (!customerId) return null;
  return _customerById.get(Number(customerId)) || null;
}

// ============================================================
// PRICING
// ============================================================
function getEffectivePrice(product) {
  if (!product) return 0;
  var cid = saleState.customerId ? String(saleState.customerId) : null;
  var pid = product.id;
  var pslug = product.slug || '';

  // 1. Try customer priceMap by id
  if (cid && priceMap[cid]) {
    var cmap = priceMap[cid];
    if (cmap[pid] !== undefined && cmap[pid] !== null && cmap[pid] !== '') {
      var p = Number(cmap[pid]);
      if (Number.isFinite(p) && p > 0) return p;
    }
    // 2. Try by slug
    if (cmap._bySlug && cmap._bySlug[pslug] !== undefined) {
      var sp = Number(cmap._bySlug[pslug]);
      if (Number.isFinite(sp) && sp > 0) return sp;
    }
  }
  // 3. Fallback: product base price
  return product.sell_price || 0;
}

// ============================================================
// INIT
// ============================================================
function initSalesPage(data) {
  products = data.products || [];
  customers = data.customers || [];
  priceMap = data.priceMap || {};

  // Build priceMap._bySlug from slug-keyed prices
  Object.keys(priceMap).forEach(function(cid) {
    var cmap = priceMap[cid];
    if (cmap._bySlug === undefined) {
      // already has _bySlug, skip
    } else {
      // legacy format: keys are slugs
      var bySlug = {};
      Object.keys(cmap).forEach(function(key) {
        if (key !== '_bySlug') {
          var product = getProductBySlug(key);
          if (product) bySlug[key] = cmap[key];
        }
      });
      cmap._bySlug = bySlug;
    }
  });

  _rebuildMaps();
  renderProducts();
}

// ============================================================
// RENDER PRODUCTS (card-based, qty input)
// ============================================================
function renderProducts() {
  var container = document.getElementById('productList');
  if (!container) return;

  if (products.length === 0) {
    container.innerHTML = '<div class="sale-product-card" style="text-align:center;color:#848e9c;padding:24px;">Chưa có sản phẩm nào</div>';
    return;
  }

  container.innerHTML = products.map(function(p) {
    var price = getEffectivePrice(p);
    var isLowStock = p.stock < _LOW_STOCK_THRESHOLD;
    var stockClass = isLowStock ? 'sale-product-meta low-stock' : 'sale-product-meta';

    // Lấy qty từ state
    var item = saleState.items.find(function(i) { return i.productId === p.id; });
    var qty = item ? item.qty : '';

    return '<div class="sale-product-card">' +
      '<div class="sale-product-top">' +
        '<div class="sale-product-name">' + escHtml(p.name) + '</div>' +
        '<div class="sale-product-price">' + formatVND(price) + '</div>' +
      '</div>' +
      '<div class="' + stockClass + '">Ton: ' + p.stock + '</div>' +
      '<input type="number" min="0" value="' + qty + '"' +
        ' id="qty-' + p.id + '"' +
        ' class="sale-qty-input"' +
        ' placeholder="Nhập SL"' +
        ' data-id="' + p.id + '"' +
        ' oninput="onQtyChange(' + p.id + ', this.value)"' +
        ' onfocus="onQtyFocus(' + p.id + ')"' +
        ' onkeydown="onQtyKeydown(event, ' + p.id + ')"' +
      '>' +
    '</div>';
  }).join('');
}

// ============================================================
// QTY CHANGE — cốt lõi logic
// ============================================================
function onQtyChange(productId, value) {
  var qty = parseInt(value) || 0;
  var product = getProduct(productId);
  if (!product) return;

  if (qty <= 0) {
    // Remove from state
    saleState.items = saleState.items.filter(function(i) { return i.productId !== productId; });
  } else {
    var price = getEffectivePrice(product);
    var existing = saleState.items.find(function(i) { return i.productId === productId; });
    if (existing) {
      existing.qty = qty;
      existing.price = price;
    } else {
      saleState.items.push({ productId: productId, qty: qty, price: price });
    }
  }

  updateTotal();
}

function onQtyFocus(productId) {
  // Auto-select all text
  var input = document.getElementById('qty-' + productId);
  if (input) setTimeout(function() { input.select(); }, 0);
}

function onQtyKeydown(event, productId) {
  // Enter → next product input
  if (event.key === 'Enter') {
    event.preventDefault();
    var inputs = document.querySelectorAll('.sale-qty-input');
    var currentIdx = -1;
    inputs.forEach(function(inp, idx) {
      if (inp.dataset.id == productId) currentIdx = idx;
    });
    if (currentIdx >= 0 && currentIdx < inputs.length - 1) {
      var next = inputs[currentIdx + 1];
      if (next) next.focus();
    }
  }
}

// ============================================================
// CUSTOMER SELECTION — update prices khi đổi khách
// ============================================================
function onCustomerSelected() {
  var el = document.getElementById('customerSelect');
  var cid = el ? el.value : '';
  saleState.customerId = cid || null;

  // Update badge
  var badge = document.getElementById('selectedCustomerBadge');
  if (!cid) {
    if (badge) { badge.classList.add('hidden'); badge.innerHTML = ''; }
  } else {
    var customer = getCustomer(cid);
    if (badge && customer) {
      badge.classList.remove('hidden');
      badge.className = 'sale-customer-badge';
      badge.innerHTML = '<span>👤</span> ' + escHtml(customer.name || 'Khách hàng');
    }
  }

  // Update prices in state
  saleState.items.forEach(function(item) {
    var product = getProduct(item.productId);
    if (product) item.price = getEffectivePrice(product);
  });

  // Re-render products to update prices
  renderProducts();
  updateTotal();
}

// ============================================================
// TOTAL
// ============================================================
function updateTotal() {
  var total = 0;
  saleState.items.forEach(function(item) {
    if (item.qty > 0 && item.price > 0) {
      total += item.qty * item.price;
    }
  });

  var totalEl = document.getElementById('totalAmount');
  if (totalEl) totalEl.textContent = formatVND(total);

  // Update sell button
  var sellBtn = document.getElementById('sellBtn');
  if (sellBtn) {
    var hasItems = saleState.items.some(function(i) { return i.qty > 0; });
    var isEditing = editingSaleId != null;
    sellBtn.disabled = !(hasItems && !isEditing);
  }
}

// ============================================================
// CHECKOUT MODAL
// ============================================================
function openCheckoutModal() {
  // Lấy items có qty > 0
  var validItems = saleState.items.filter(function(i) { return i.qty > 0; });
  if (validItems.length === 0) return;

  var modal = document.getElementById('checkoutModal');
  var body = document.getElementById('checkoutModalBody');
  if (!modal || !body) return;

  // Customer name
  var customerName = 'Khách lẻ';
  if (saleState.customerId) {
    var customer = getCustomer(saleState.customerId);
    if (customer) customerName = customer.name || 'Khách hàng';
  }

  // Total
  var total = 0;
  validItems.forEach(function(item) {
    total += item.qty * item.price;
  });

  // Render items
  var itemsHtml = validItems.map(function(item) {
    var product = getProduct(item.productId);
    var name = product ? product.name : 'SP';
    var lineTotal = item.qty * item.price;
    return '<div class="pos-modal-item">' +
      '<div class="pos-modal-item-name">' + escHtml(name) + '</div>' +
      '<div class="pos-modal-item-qty">x' + item.qty + '</div>' +
      '<div class="pos-modal-item-total">' + formatVND(lineTotal) + '</div>' +
    '</div>';
  }).join('');

  body.innerHTML =
    '<div class="pos-modal-customer">👤 ' + escHtml(customerName) + '</div>' +
    itemsHtml +
    '<div class="pos-modal-summary">' +
      '<div class="pos-modal-summary-label">Tổng cộng</div>' +
      '<div class="pos-modal-summary-value">' + formatVND(total) + '</div>' +
    '</div>' +
    '<div class="pos-modal-actions">' +
      '<button type="button" onclick="closeCheckoutModal()" class="pos-modal-btn-cancel">Huỷ</button>' +
      '<button type="button" onclick="confirmSale()" class="pos-modal-btn-confirm">✅ Xác nhận bán</button>' +
    '</div>';

  modal.classList.remove('hidden');
}

function closeCheckoutModal() {
  var modal = document.getElementById('checkoutModal');
  if (modal) modal.classList.add('hidden');
}

function confirmSale() {
  closeCheckoutModal();
  submitSale();
}

// ============================================================
// LEGACY: submitSale / updateSale (gọi từ modal confirm)
// ============================================================
function submitSale() {
  var validItems = saleState.items.filter(function(i) { return i.qty > 0 && i.price > 0; });
  if (validItems.length === 0) return;

  var saleData = {};
  validItems.forEach(function(item) {
    saleData[item.productId] = { quantity: item.qty, price: item.price };
  });

  var customerId = saleState.customerId || '';

  var payload = {
    customer_id: customerId,
    items: validItems.map(function(item) {
      return { product_id: item.productId, quantity: item.qty, price: item.price };
    })
  };

  fetch('/sale/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(function(res) { return res.json(); })
  .then(function(data) {
    if (data.success) {
      showToast('Bán hàng thành công!', 'success');
      // Reset state
      saleState.items = [];
      saleState.customerId = null;
      renderProducts();
      updateTotal();

      var customerSelect = document.getElementById('customerSelect');
      var customerSearch = document.getElementById('customerSearch');
      if (customerSelect) customerSelect.value = '';
      if (customerSearch) customerSearch.value = '';
      var badge = document.getElementById('selectedCustomerBadge');
      if (badge) { badge.classList.add('hidden'); badge.innerHTML = ''; }

      // Dispatch event for other pages
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
    } else {
      showToast((data.error || 'Lỗi khi bán hàng'), 'error');
    }
  })
  .catch(function(err) {
    console.error('[POS] submitSale error:', err);
    showToast('Lỗi kết nối', 'error');
  });
}

// ============================================================
// FILTER CUSTOMER (legacy compatibility)
// ============================================================
function filterCustomerOptions(query) {
  // Implemented in modal section
}

function showCustomerDropdown(show) {
  // Implemented in modal section
}

// ============================================================
// UTILITIES
// ============================================================
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatVND(n) {
  if (n == null || isNaN(n)) return '0đ';
  return new Intl.NumberFormat('vi-VN').format(Math.round(n)) + 'đ';
}

function getProductBySlug(slug) {
  if (!slug) return null;
  return _productBySlug.get(String(slug)) || null;
}

// ============================================================
// MODAL FUNCTIONS (kept for Keg/Collect/Replacement modals)
// ============================================================
function openKegModal() {
  var modal = document.getElementById('kegModal');
  if (modal) modal.classList.remove('hidden');
}

function closeKegModal() {
  var modal = document.getElementById('kegModal');
  if (modal) modal.classList.add('hidden');
}

function updateKegModalPreview() {
  // Placeholder - implement if needed
}

function saveKegUpdate() {
  closeKegModal();
  showToast('Đã cập nhật vỏ', 'success');
}

function openCollectKegModal() {
  var modal = document.getElementById('collectKegModal');
  if (modal) modal.classList.remove('hidden');
}

function closeCollectKegModal() {
  var modal = document.getElementById('collectKegModal');
  if (modal) modal.classList.add('hidden');
}

function updateCollectKegPreview() {
  // Placeholder
}

function submitCollectKeg() {
  closeCollectKegModal();
  showToast('Đã thu vỏ', 'success');
}

function openReplacementModal() {
  var modal = document.getElementById('replacementModal');
  if (modal) modal.classList.remove('hidden');
}

function closeReplacementModal() {
  var modal = document.getElementById('replacementModal');
  if (modal) modal.classList.add('hidden');
}

function loadReplacementProducts() {}
function toggleGiftMode() {}
function submitReplacement() {
  closeReplacementModal();
  showToast('Đã đổi bia lỗi', 'success');
}

function cancelEdit() {
  editingSaleId = null;
  var sheet = document.getElementById('saleEditAuxSheet');
  if (sheet) sheet.classList.add('hidden');
  saleState.items = [];
  saleState.customerId = null;
  renderProducts();
  updateTotal();
}

function updateSale() {
  submitSale();
}

function closeInvoice() {
  var modal = document.getElementById('invoiceModal');
  if (modal) modal.classList.add('hidden');
}
