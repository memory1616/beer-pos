// Stock Page JavaScript
// Tách riêng để dễ bảo trì và cache
// formatVND, showToast được định nghĩa trong utils.js (global)

let currentProducts = [];
let importData = {}; // Store import data by productId
let allPurchases = []; // Purchase history for this page
let _stockPage = 'stock'; // 'stock' or 'purchase' — used to determine which container to update

// ── Purchase history helpers (used by deletePurchase / editPurchase on stock page) ──

function removePurchaseItem(purchaseId) {
  var card = document.querySelector('[data-purchase-id="' + purchaseId + '"]');
  if (card) card.remove();
  var remaining = document.querySelectorAll('[data-purchase-id]');
  if (remaining.length === 0) {
    var emptyEl = document.getElementById('purchaseHistoryList');
    if (emptyEl) emptyEl.innerHTML = '<div class="text-muted text-center py-2">Chưa có lịch sử nhập hàng</div>';
  }
}

function updatePurchasesSummary() {
  // Summary is updated via the products total — no-op for stock page
}

function checkPurchasesEmpty() {
  // Handled by removePurchaseItem above — no-op
}

// ── Product list helpers ──────────────────────────────────────────────────

function removeProductItem(productId) {
  var card = document.querySelector('[data-product-id="' + productId + '"]');
  if (card) card.remove();
}

function updateProductsSummary() {
  // Update the total stock display from server data
  var totalStockEl = document.getElementById('totalStock');
  if (totalStockEl) {
    var total = currentProducts.reduce(function(sum, p) {
      return sum + Math.max(0, Number(p.stock) || 0);
    }, 0);
    totalStockEl.textContent = String(total);
  }
}

function updateProductItem(product) {
  // Update a single product card in-place using server data
  var card = document.querySelector('[data-product-id="' + product.id + '"]');
  if (!card) return;

  var stockEl = card.querySelector('.product-card__qty');
  if (stockEl) {
    stockEl.textContent = product.stock;
    stockEl.className = 'product-card__qty tabular-nums ' + (product.stock < _LOW_STOCK_THRESHOLD ? 'text-danger' : 'text-success');
  }

  // Update "Sắp hết" badge
  var badgeEl = card.querySelector('.badge-danger');
  var headerEl = card.querySelector('.product-card__name');
  if (product.stock < _LOW_STOCK_THRESHOLD && !badgeEl && headerEl) {
    headerEl.insertAdjacentHTML('afterend', '<span class="badge badge-danger shrink-0 text-[10px]">Sắp hết</span>');
  } else if (product.stock >= _LOW_STOCK_THRESHOLD && badgeEl) {
    badgeEl.remove();
  }
}

function renderProductItem(product, opts) {
  opts = opts || {};
  var html = _productCardHtml(product, null);
  if (opts.prepend) {
    var container = document.getElementById('productList');
    if (container) container.insertAdjacentHTML('afterbegin', html);
  }
}

const _LOW_STOCK_THRESHOLD = 30;
const PAGE_SIZE = 30;
let _renderedCount = PAGE_SIZE;
let _totalFiltered = 0;
let _hasMore = true;
let _loadMorePending = false;
let _observer = null;
let _filteredProducts = [];

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Load stock page data from IndexedDB — single source of truth.
 * Called by stock.html init script after db.js is loaded.
 */
async function loadData() {
  try {
    console.log('[Stock] loadData: fetching from IndexedDB...');
    if (window.dbReady) await window.dbReady;

    var products = [];
    if (typeof window.getProducts === 'function') {
      products = await window.getProducts();
    }
    console.log('[Stock] loadData: products=' + (products ? products.length : 0));

    initStockPage({ products: products || [], totalStockPositive: 0 });
    hideLoading();
    return products;
  } catch (err) {
    console.error('[Stock] loadData ERROR:', err);
    hideLoading();
    initStockPage({ products: [], totalStockPositive: 0 });
  }

  // Safety fallback — prevent infinite loading
  setTimeout(function() {
    var loadingEl = document.getElementById('loading');
    if (loadingEl && !loadingEl.classList.contains('hidden')) {
      console.warn('[Stock] ⚠️ load timeout fallback — forcing render');
      hideLoading();
      initStockPage({ products: [], totalStockPositive: 0 });
    }
  }, 3000);
}

function hideLoading() {
  var el = document.getElementById('loading');
  if (el) el.classList.add('hidden');
}

function initStockPage(data) {
  try {
    // Render products — data.products comes from IndexedDB (single source of truth)
    currentProducts = data.products || [];
    _filteredProducts = currentProducts;

    // Calculate total positive stock from local data
    var totalStockPositive = currentProducts.reduce(function(sum, p) {
      return sum + Math.max(0, Number(p.stock) || 0);
    }, 0);

    // Reset pagination counter so low-stock alert renders on first page
    _renderedCount = 0;

    // window.store may not exist on all pages — guard safely
    if (typeof window !== 'undefined' && !window.store) {
      window.store = {};
    }
    if (window.store) {
      window.store.products = currentProducts;
    }
    if (data.purchases && Array.isArray(data.purchases)) {
      if (window.store) window.store.purchases = data.purchases;
      allPurchases = data.purchases.slice();
    }

    console.log('[Stock] initStockPage: rendering ' + currentProducts.length + ' products, total=' + totalStockPositive);
    _renderProductsPage(_filteredProducts.slice(0, PAGE_SIZE), totalStockPositive, _filteredProducts.length > PAGE_SIZE);

    // Render import form
    renderImportForm(currentProducts);

    // Render purchase history
    if (data.purchases && data.purchases.length > 0) {
      renderPurchaseHistory(data.purchases);
    }

    console.log('[Stock] initStockPage: OK, products=' + currentProducts.length);
    hideLoading();
  } catch (err) {
    console.error('[Stock] initStockPage ERROR:', err);
    hideLoading();
  }
}

/** Số tiền một dòng (tránh overflow-wrap:anywhere của .card cha) */
function purchaseTotalHtml(amount) {
  const n = Number(amount);
  const num = Number.isFinite(n) ? n : 0;
  const formatted = new Intl.NumberFormat('vi-VN').format(num);
  return (
    '<div class="card-stat-amount text-success justify-end text-sm sm:text-base font-bold">' +
    '<span class="tabular-nums tracking-tight">' + formatted + '</span>' +
    '<span class="text-[10px] sm:text-xs opacity-75 shrink-0">đ</span>' +
    '</div>'
  );
}

function renderPurchaseHistory(purchases) {
  const container = document.getElementById('purchaseHistoryList');

  if (!container) {
    console.warn('[UI] Element not found: #purchaseHistoryList');
    return;
  }

  if (purchases.length === 0) {
    container.innerHTML = '<div class="text-muted text-center py-2">Chưa có lịch sử nhập hàng</div>';
    return;
  }

  container.innerHTML = purchases.map(function(p) {
    const date = new Date(p.date);
    const formattedDate = date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const count = p.item_count != null ? p.item_count : 0;
    return `
      <div class="purchase-history-item rounded-xl border border-muted bg-bg/40 p-3 mb-2 last:mb-0" data-purchase-id="${p.id}">
        <div class="flex items-start justify-between gap-2 min-w-0">
          <div class="min-w-0 flex-1">
            <div class="font-semibold text-primary">Đơn #${p.id}</div>
            <div class="text-xs text-muted mt-0.5">${formattedDate} · ${count} sản phẩm</div>
          </div>
          <div class="flex items-center gap-0.5 shrink-0">
            <button type="button" onclick="editPurchase(${p.id})" class="btn btn-ghost btn-sm min-w-[2.25rem] h-9 px-0" title="Sửa">✏️</button>
            <button type="button" onclick="deletePurchase(${p.id})" class="btn btn-ghost btn-sm min-w-[2.25rem] h-9 px-0 text-danger" title="Xóa">🗑️</button>
          </div>
        </div>
        <div class="mt-2.5 pt-2.5 border-t border-muted/70 flex items-center justify-between gap-3 min-w-0">
          <span class="text-xs text-muted shrink-0">Tổng tiền</span>
          ${purchaseTotalHtml(p.total_amount)}
        </div>
      </div>
    `;
  }).join('');
}

async function editPurchase(purchaseId) {
  try {
    var res = await fetch('/api/purchases/' + purchaseId);
    var purchase = await res.json();

    var editPurchaseIdEl = document.getElementById('editPurchaseId');
    var editPurchaseNoteEl = document.getElementById('editPurchaseNote');
    if (editPurchaseIdEl) editPurchaseIdEl.value = purchase.id;
    if (editPurchaseNoteEl) editPurchaseNoteEl.value = purchase.note || '';

    // Load purchase items
    var itemsRes = await fetch('/api/purchases/' + purchaseId);
    var itemsData = await itemsRes.json();

    var itemsContainer = document.getElementById('editPurchaseItems');
    if (!itemsContainer) {
      console.warn('[UI] Element not found: #editPurchaseItems');
      return;
    }
    itemsContainer.innerHTML = itemsData.items.map(function(item) {
      return `
      <div class="card p-3 space-y-2">
        <div class="font-medium text-sm text-main truncate">${item.product_name}</div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-main mb-1">Số lượng</label>
            <input type="number" data-item-id="${item.id}" data-product-id="${item.product_id}"
              min="0" class="w-full border border-primary rounded-lg px-3 py-2 text-center focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none edit-qty"
              value="${item.quantity}">
          </div>
          <div>
            <label class="block text-xs font-medium text-main mb-1">Đơn giá (đ)</label>
            <input type="number" data-item-id="${item.id}" data-product-id="${item.product_id}"
              step="1000" min="0" class="w-full border border-primary rounded-lg px-3 py-2 text-right focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none edit-cost"
              value="${item.unit_price}">
          </div>
        </div>
      </div>
    `;}).join('');

    var purchaseModal = document.getElementById('purchaseModal');
    if (purchaseModal) {
      purchaseModal.classList.remove('hidden');
      purchaseModal.classList.add('flex');
    }
  } catch (err) {
    console.error('[Stock] editPurchase error:', err);
    alert('Lỗi tải thông tin đơn nhập');
  }
}

function closePurchaseModal() {
  var modal = document.getElementById('purchaseModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

async function deletePurchase(purchaseId) {
  if (!confirm('Bạn có chắc muốn xoá đơn nhập hàng này?')) return;

  var card = document.querySelector('[data-purchase-id="' + purchaseId + '"]');
  var deleteBtn = card ? card.querySelector('[onclick^="deletePurchase"]') : null;
  var btnState = deleteBtn ? setButtonLoading(deleteBtn) : null;

  try {
    var res = await fetch('/api/purchases/' + purchaseId, { method: 'DELETE', cache: 'no-store' });
    var data;
    try { data = await res.json(); } catch (_) { data = {}; }

    if (!res.ok) {
      throw new Error(data.error || 'Xoá thất bại (HTTP ' + res.status + ')');
    }

    allPurchases = allPurchases.filter(function(p) { return String(p.id) !== String(purchaseId); });
    window.store.purchases = allPurchases;
    removePurchaseItem(purchaseId);
    updatePurchasesSummary();
    checkPurchasesEmpty();

    alert('Đã xoá đơn nhập hàng!');

    // REFETCH products from server to sync stock (stock restored on delete)
    fetch('/api/products', { cache: 'no-store' })
      .then(function(res) { return res.json(); })
      .then(function(serverProducts) {
        currentProducts = serverProducts;
        _filteredProducts = serverProducts;
        window.store.products = serverProducts;
        renderImportForm(serverProducts);
        updateProductsSummary();
      })
      .catch(function(err) {
        console.error('[Stock] deletePurchase refetch error:', err);
      });

    window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'purchase' } }));
  } catch (err) {
    console.error('[deletePurchase]', err);
    alert('Xoá thất bại: ' + (err.message || 'Lỗi không xác định'));
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

// ── Page init: all DOM access guarded by DOMContentLoaded ─────────────────────
// Wrap ALL top-level document.getElementById / querySelector / addEventListener
// so they never run before the page DOM is fully rendered.
(function () {
  function initBindings() {
    // ── editPurchaseForm submit ──────────────────────────────────────────────
    var editPurchaseFormEl = document.getElementById('editPurchaseForm');
    if (editPurchaseFormEl) {
      editPurchaseFormEl.addEventListener('submit', async function (e) {
        e.preventDefault();

        var purchaseId = document.getElementById('editPurchaseId');
        var purchaseNote = document.getElementById('editPurchaseNote');
        if (!purchaseId || !purchaseNote) return;
        purchaseId = purchaseId.value;
        purchaseNote = purchaseNote.value;

        // Get updated items
        var items = [];
        var qtyInputs = document.querySelectorAll('#editPurchaseItems .edit-qty');
        for (var qi = 0; qi < qtyInputs.length; qi++) {
          var qtyInput = qtyInputs[qi];
          var itemId = qtyInput.dataset.itemId;
          var productId = qtyInput.dataset.productId;
          var quantity = parseInt(qtyInput.value) || 0;
          var costInput = document.querySelector('.edit-cost[data-item-id="' + itemId + '"]');
          var unitPrice = costInput ? (parseFloat(costInput.value) || 0) : 0;

          if (quantity > 0) {
            items.push({ item_id: itemId, product_id: productId, quantity: quantity, unit_price: unitPrice });
          }
        }

        var submitBtn = (document.getElementById('editPurchaseForm') || {}).querySelector ?
          document.getElementById('editPurchaseForm').querySelector('[type="submit"]') : null;
        var btnState = submitBtn ? setButtonLoading(submitBtn, 'Cập nhật') : null;

        try {
          var res = await fetch('/api/purchases/' + purchaseId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: items, note: purchaseNote }),
            cache: 'no-store'
          });

          var result;
          try { result = await res.json(); } catch (_) { result = {}; }

          if (!res.ok) {
            throw new Error(result.error || 'Cập nhật thất bại (HTTP ' + res.status + ')');
          }

          closePurchaseModal();
          alert('Cập nhật thành công!');

          // Reload from IndexedDB
          if (typeof loadData === 'function') {
            await loadData();
          }

          window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'purchase' } }));
        } catch (err) {
          console.error('[editPurchase]', err);
          alert('Cập nhật thất bại: ' + (err.message || 'Lỗi không xác định'));
        } finally {
          if (btnState) restoreButtonLoading(btnState);
        }
      });
    }

    // ── productForm submit ───────────────────────────────────────────────────
    var productFormEl = document.getElementById('productForm');
    if (productFormEl) {
      productFormEl.addEventListener('submit', async function (e) {
        e.preventDefault();

        var productIdEl = document.getElementById('productId');
        var productNameEl = document.getElementById('productName');
        var productTypeEl = document.getElementById('productType');
        var productCostPriceEl = document.getElementById('productCostPrice');
        var productStockEl = document.getElementById('productStock');
        if (!productIdEl || !productNameEl) return;

        var productId = productIdEl.value;
        var name = productNameEl.value.trim();
        var type = productTypeEl ? productTypeEl.value : 'keg';
        var cost_price = parseFloat(productCostPriceEl ? productCostPriceEl.value : '0') || 0;
        var stock = productId ? (parseInt(productStockEl ? productStockEl.value : '0') || 0) : 0;

        if (!name) {
          alert('Vui lòng nhập tên sản phẩm');
          return;
        }

        var data = { name: name, type: type, cost_price: cost_price };
        if (productId) {
          data.stock = stock;
        }

        var method = productId ? 'PUT' : 'POST';
        var url = productId ? '/api/products/' + productId : '/api/products';
        var isNew = !productId;
        var tempId = 'tmp_prod_' + Date.now();

        var submitBtn = (document.getElementById('productForm') || {}).querySelector ?
          document.getElementById('productForm').querySelector('[type="submit"]') : null;
        var btnState = submitBtn ? setButtonLoading(submitBtn, isNew ? 'Thêm sản phẩm' : 'Cập nhật') : null;

        try {
          var res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
            cache: 'no-store'
          });

          var result;
          try { result = await res.json(); } catch (_) { result = {}; }

          if (!res.ok) {
            throw new Error(result.error || (isNew ? 'Thêm' : 'Cập nhật') + ' thất bại (HTTP ' + res.status + ')');
          }

          closeProductModal();
          alert(isNew ? 'Thêm sản phẩm thành công!' : 'Cập nhật thành công!');

          // REFETCH from server to sync all data
          if (typeof loadData === 'function') {
            await loadData();
          } else {
            var stockRes = await fetch('/stock/data', { cache: 'no-store' });
            var stockData = await stockRes.json();
            initStockPage(stockData);
          }

          window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'product' } }));
        } catch (err) {
          console.error('[productForm]', err);
          alert((isNew ? 'Thêm' : 'Cập nhật') + ' thất bại: ' + (err.message || 'Lỗi không xác định'));
        } finally {
          if (btnState) restoreButtonLoading(btnState);
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBindings);
  } else {
    initBindings();
  }
})();

function renderImportForm(products) {
  const container = document.getElementById('importProducts');

  if (!container) {
    console.warn('[UI] Element not found: #importProducts — renderImportForm skipped');
    return;
  }
  if (!Array.isArray(products)) {
    console.warn('[UI] renderImportForm called without valid products array');
    return;
  }

  // Layout rõ ràng: tên SP, giá vốn 1 dòng, chỉ ô SL (không lặp giá)
  container.innerHTML = products.map(function(p) {
    return `
    <div class="card p-3">
      <div class="text-sm font-semibold text-main">${p.name}</div>
      <div class="text-xs text-muted mt-0.5">Giá vốn: ${formatVND(p.cost_price || 0)} · Tồn: ${p.stock}</div>
      <input type="number" id="qty-${p.id}" min="0" placeholder="Nhập SL"
        class="mt-2 w-full border-2 border-primary rounded-lg p-2.5 text-center font-medium focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
        onchange="updateImportData(${p.id}, this.value)"
        oninput="updateImportData(${p.id}, this.value)">
    </div>
  `;}).join('');

  importData = {};
}

function updateImportData(productId, value) {
  if (!importData[productId]) {
    importData[productId] = { quantity: 0 };
  }
  importData[productId].quantity = parseInt(value) || 0;
  calculateImportTotal();
}

function calculateImportTotal() {
  let total = 0;
  Object.keys(importData).forEach(productId => {
    const item = importData[productId];
    if (item.quantity > 0) {
      const product = currentProducts.find(p => p.id == productId);
      const costPrice = product ? (product.cost_price || 0) : 0;
      total += item.quantity * costPrice;
    }
  });
  const el = document.getElementById('importTotal');
  if (el) el.innerHTML = '<span class="value">' + formatVND(total).replace(' đ', '') + '</span><span class="unit"> đ</span>';
}

async function submitImport() {
  const items = [];
  Object.keys(importData).forEach(productId => {
    const item = importData[productId];
    if (item.quantity > 0) {
      const product = currentProducts.find(p => p.id == productId);
      const costPrice = product ? (product.cost_price || 0) : 0;
      items.push({
        productId: parseInt(productId),
        quantity: item.quantity,
        costPrice: costPrice
      });
    }
  });

  if (items.length === 0) {
    alert('Vui lòng nhập số lượng');
    return;
  }

  var btn = document.getElementById('submitImportBtn');
  var btnState = btn ? setButtonLoading(btn, 'Nhập kho') : null;

  try {
    var res = await fetch('/api/stock/multiple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, note: 'Nhập kho' }),
      cache: 'no-store'
    });

    var result;
    try { result = await res.json(); } catch (_) { result = {}; }

    if (!res.ok) {
      throw new Error(result.error || 'Nhập kho thất bại (HTTP ' + res.status + ')');
    }

    alert('Nhập hàng thành công!');

    // Reset import form immediately
    importData = {};
    var importInputs = document.querySelectorAll('#importProducts input[type="number"]');
    for (var ii = 0; ii < importInputs.length; ii++) { importInputs[ii].value = ''; }
    calculateImportTotal();

    // REFETCH all data from server to sync stock across all components
    if (typeof loadData === 'function') {
      await loadData();
    } else {
      // Fallback: direct fetch
      var stockRes = await fetch('/stock/data', { cache: 'no-store' });
      var stockData = await stockRes.json();
      initStockPage(stockData);
    }

    window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'purchase' } }));
  } catch (err) {
    console.error('[submitImport]', err);
    alert('Nhập kho thất bại: ' + (err.message || 'Lỗi không xác định'));
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

// PERFORMANCE: Extract product card HTML for reuse in virtual scrolling
function _productCardHtml(p, totalPositive) {
  const low = p.stock < _LOW_STOCK_THRESHOLD;
  return `
    <article class="card product-card product-card--interactive ${low ? 'border-danger' : 'border-muted'}"
      role="button" tabindex="0" data-product-id="${p.id}"
      aria-label="${escapeHtmlAttr(p.name)} — Tồn ${p.stock}. Nhấn để sửa"
      onclick="openProductModal(${p.id})"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openProductModal(${p.id});}">
      <div class="flex justify-between items-start gap-2">
        <h3 class="product-card__name min-w-0 flex-1">${p.name}</h3>
        ${low ? '<span class="badge badge-danger shrink-0 text-[10px]">Sắp hết</span>' : ''}
      </div>
      <div class="product-card__meta">Giá vốn · ${formatVND(p.cost_price || 0)}</div>
      <div class="product-card__footer">
        <div class="min-w-0">
          <div class="product-card__qty-label">Tồn kho</div>
          <div class="product-card__qty tabular-nums ${low ? 'text-danger' : 'text-success'}">${p.stock}</div>
        </div>
        <div class="product-card__edit-pill" aria-hidden="true"><span class="product-card__edit-icon">✏️</span><span>Sửa</span></div>
      </div>
    </article>
  `;
}

// PERFORMANCE: Render a page of products
function _renderProductsPage(pageProducts, totalPositive, hasMore) {
  const container = document.getElementById('productList');
  console.log('[Stock] _renderProductsPage: container=' + !!container + ', products=' + (pageProducts ? pageProducts.length : 0));
  if (!container) {
    console.error('[Stock] _renderProductsPage: #productList NOT FOUND in DOM');
    return;
  }

  // If first page, clear container and add low stock alert
  if (_renderedCount <= PAGE_SIZE) {
    // Tổng tồn kho: luôn đồng bộ với tất cả sản phẩm (không chỉ trang/filter)
    const totalStockEl = document.getElementById('totalStock');
    if (totalStockEl) {
      const fromServer =
        typeof totalPositive === 'number' && !Number.isNaN(totalPositive);
      const total = fromServer
        ? totalPositive
        : currentProducts.reduce(
            (sum, p) => sum + Math.max(0, Number(p.stock) || 0),
            0
          );
      totalStockEl.textContent = String(total);
    }

    // Calculate low stock products from filtered products
    const lowStockProducts = _filteredProducts.filter(p => p.stock < _LOW_STOCK_THRESHOLD);
    
    // Build low stock alert HTML
    let lowStockAlert = '';
    if (lowStockProducts.length > 0) {
      lowStockAlert = `
        <div class="card mb-4 border-danger product-grid__full">
          <div class="text-sm font-bold text-danger mb-2">⚠️ Tồn kho thấp (${lowStockProducts.length})</div>
          <div class="flex flex-wrap gap-1">
            ${lowStockProducts.map(p => `
              <span class="badge badge-danger">
                ${p.name}: <b>${p.stock}</b>
              </span>
            `).join('')}
          </div>
        </div>
      `;
    }
    
    container.innerHTML = lowStockAlert;
  }

  for (const p of pageProducts) {
    const html = _productCardHtml(p, totalPositive);
    const div = document.createElement('div');
    div.innerHTML = html;
    container.appendChild(div.firstElementChild);
  }

  _hasMore = hasMore;

  // Remove old sentinel/observer
  if (_observer) { _observer.disconnect(); _observer = null; }
  const oldSentinel = document.getElementById('_loadMoreSentinel');
  if (oldSentinel) oldSentinel.remove();

  if (_hasMore) {
    const sentinel = document.createElement('div');
    sentinel.id = '_loadMoreSentinel';
    sentinel.style.height = '1px';
    container.appendChild(sentinel);

    _observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry.isIntersecting && _hasMore && !_loadMorePending) {
        _loadMorePending = true;
        _loadMoreProducts();
      }
    }, { rootMargin: '300px' });
    _observer.observe(sentinel);
  }
}

// PERFORMANCE: Load more products for virtual scroll
async function _loadMoreProducts() {
  const start = _renderedCount;
  const end = start + PAGE_SIZE;
  const page = _filteredProducts.slice(start, end);
  const totalPositive = parseInt(document.getElementById('totalStock')?.textContent?.replace(/\D/g, '') || '0');

  _renderProductsPage(page, totalPositive, end < _filteredProducts.length);
  _renderedCount += page.length;
  _loadMorePending = false;
}

// PERFORMANCE: Handle search input for virtual scroll
let _stockSearchTimeout = null;
function handleStockSearch(query) {
  clearTimeout(_stockSearchTimeout);
  _stockSearchTimeout = setTimeout(() => {
    const search = query.toLowerCase().trim();
    
    // Filter products based on search query
    if (search === '') {
      _filteredProducts = currentProducts;
    } else {
      _filteredProducts = currentProducts.filter(p => 
        p.name.toLowerCase().includes(search)
      );
    }
    
    // Reset pagination state
    _renderedCount = PAGE_SIZE;
    const totalPositive = parseInt(document.getElementById('totalStock')?.textContent?.replace(/\D/g, '') || '0');
    
    // Re-render first page
    _renderProductsPage(_filteredProducts.slice(0, PAGE_SIZE), totalPositive, _filteredProducts.length > PAGE_SIZE);
  }, 150); // Debounce 150ms
}

function renderProducts(products, serverTotalStockPositive) {
  const productList = document.getElementById('productList');
  const totalStockEl = document.getElementById('totalStock');
  
  if (!productList || !totalStockEl) return;
  
  const totalStock =
    typeof serverTotalStockPositive === 'number' && !Number.isNaN(serverTotalStockPositive)
      ? serverTotalStockPositive
      : products.reduce((sum, p) => sum + Math.max(0, Number(p.stock) || 0), 0);
  const lowStockProducts = products.filter(p => p.stock < _LOW_STOCK_THRESHOLD);

  totalStockEl.textContent = totalStock;

  // Add low stock alert section at top if there are low stock products
  let lowStockAlert = '';
  if (lowStockProducts.length > 0) {
      lowStockAlert = `
      <div class="card mb-0 border-danger product-grid__full">
        <div class="text-sm font-bold text-danger mb-2">⚠️ Tồn kho thấp (${lowStockProducts.length})</div>
        <div class="flex flex-wrap gap-1">
          ${lowStockProducts.map(p => `
            <span class="badge badge-danger">
              ${p.name}: <b>${p.stock}</b>
            </span>
          `).join('')}
        </div>
      </div>
    `;
  }

  productList.innerHTML = lowStockAlert + products.map(p => {
    const low = p.stock < _LOW_STOCK_THRESHOLD;
    return `
    <article class="card product-card product-card--interactive ${low ? 'border-danger' : 'border-muted'}"
      role="button" tabindex="0" data-product-id="${p.id}"
      aria-label="${escapeHtmlAttr(p.name)} — Tồn ${p.stock}. Nhấn để sửa"
      onclick="openProductModal(${p.id})"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openProductModal(${p.id});}">
      <div class="flex justify-between items-start gap-2">
        <h3 class="product-card__name min-w-0 flex-1">${p.name}</h3>
        ${low ? '<span class="badge badge-danger shrink-0 text-[10px]">Sắp hết</span>' : ''}
      </div>
      <div class="product-card__meta">Giá vốn · ${formatVND(p.cost_price || 0)}</div>
      <div class="product-card__footer">
        <div class="min-w-0">
          <div class="product-card__qty-label">Tồn kho</div>
          <div class="product-card__qty tabular-nums ${low ? 'text-danger' : 'text-success'}">${p.stock}</div>
        </div>
        <div class="product-card__edit-pill" aria-hidden="true"><span class="product-card__edit-icon">✏️</span><span>Sửa</span></div>
      </div>
    </article>
  `;
  }).join('');
}

// Product Modal Functions
function openProductModal(productId) {
  var modal = document.getElementById('productModal');
  var form = document.getElementById('productForm');
  var title = document.getElementById('modalTitle');
  var deleteBtn = document.getElementById('deleteProductBtn');
  var stockField = document.getElementById('stockField');

  if (!modal || !form) {
    console.warn('[UI] openProductModal: #productModal or #productForm not found');
    return;
  }

  form.reset();

  if (productId) {
    // Edit mode
    var product = currentProducts.find(function(p) { return p.id === productId; });
    if (!product) return;

    if (title) title.textContent = 'Sửa sản phẩm';
    var productIdEl = document.getElementById('productId');
    var productNameEl = document.getElementById('productName');
    var productTypeEl = document.getElementById('productType');
    var productCostPriceEl = document.getElementById('productCostPrice');
    var productStockEl = document.getElementById('productStock');
    if (productIdEl) productIdEl.value = product.id;
    if (productNameEl) productNameEl.value = product.name;
    if (productTypeEl) productTypeEl.value = product.type || 'keg';
    if (productCostPriceEl) productCostPriceEl.value = product.cost_price || 0;
    if (productStockEl) productStockEl.value = product.stock;
    if (deleteBtn) deleteBtn.classList.remove('hidden');
    if (stockField) stockField.classList.remove('hidden');
  } else {
    // Add mode
    if (title) title.textContent = 'Thêm sản phẩm';
    var productIdEl = document.getElementById('productId');
    var productTypeEl = document.getElementById('productType');
    if (productIdEl) productIdEl.value = '';
    if (productTypeEl) productTypeEl.value = 'keg';
    if (deleteBtn) deleteBtn.classList.add('hidden');
    if (stockField) stockField.classList.add('hidden');
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeProductModal() {
  var modal = document.getElementById('productModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

function deleteProduct() {
  var productIdEl = document.getElementById('productId');
  var productNameEl = document.getElementById('productName');
  if (!productIdEl || !productNameEl) return;
  var productId = productIdEl.value;
  var productName = productNameEl.value;

  if (!confirm('Bạn có chắc muốn xoá sản phẩm "' + productName + '"?')) {
    return;
  }

  var deleteBtn = document.getElementById('deleteProductBtn');
  var btnState = deleteBtn ? setButtonLoading(deleteBtn) : null;

  (async function() {
    try {
      var res = await fetch('/api/products/' + productId, {
        method: 'DELETE',
        cache: 'no-store'
      });

      if (!res.ok) {
        var data;
        try { data = await res.json(); } catch (_) { data = {}; }
        throw new Error(data.error || 'Xoá thất bại (HTTP ' + res.status + ')');
      }

      closeProductModal();
      alert('Đã xoá sản phẩm!');

      // REFETCH from server to sync all data
      if (typeof loadData === 'function') {
        await loadData();
      } else {
        var stockRes = await fetch('/stock/data', { cache: 'no-store' });
        var stockData = await stockRes.json();
        initStockPage(stockData);
      }

      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'product' } }));
    } catch (err) {
      console.error('[deleteProduct]', err);
      alert('Xoá thất bại: ' + (err.message || 'Lỗi không xác định'));
    } finally {
      if (btnState) restoreButtonLoading(btnState);
    }
  })();
}

// Product Form Submit — wrapped in DOMContentLoaded (IIFE at line 203 already handles productForm;
// this outer handler is a duplicate used by some page templates; guard prevents crash when DOM not ready)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    var pf = document.getElementById('productForm');
    if (pf) pf.addEventListener('submit', async function(e) {
  e.preventDefault();

  var productIdEl = document.getElementById('productId');
  var productNameEl = document.getElementById('productName');
  var productTypeEl = document.getElementById('productType');
  var productCostPriceEl = document.getElementById('productCostPrice');
  var productStockEl = document.getElementById('productStock');
  if (!productIdEl || !productNameEl) return;

  var productId = productIdEl.value;
  var name = productNameEl.value.trim();
  var type = productTypeEl ? productTypeEl.value : 'keg';
  var cost_price = parseFloat(productCostPriceEl ? productCostPriceEl.value : '0') || 0;
  var stock = productId ? (parseInt(productStockEl ? productStockEl.value : '0') || 0) : 0;

  if (!name) {
    alert('Vui lòng nhập tên sản phẩm');
    return;
  }

  var data = { name: name, type: type, cost_price: cost_price };
  if (productId) {
    data.stock = stock;
  }

  var method = productId ? 'PUT' : 'POST';
  var url = productId ? '/api/products/' + productId : '/api/products';
  var isNew = !productId;

  var submitBtn = (document.getElementById('productForm') || {}).querySelector ?
    (document.getElementById('productForm').querySelector('[type="submit"]') || null) : null;
  var btnState = submitBtn ? setButtonLoading(submitBtn, isNew ? 'Thêm sản phẩm' : 'Cập nhật') : null;

  try {
    var res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      cache: 'no-store'
    });

    var result;
    try { result = await res.json(); } catch (_) { result = {}; }

    if (!res.ok) {
      throw new Error(result.error || (isNew ? 'Thêm' : 'Cập nhật') + ' thất bại (HTTP ' + res.status + ')');
    }

    closeProductModal();
    alert(isNew ? 'Thêm sản phẩm thành công!' : 'Cập nhật thành công!');

    // REFETCH from server to sync all data
    if (typeof loadData === 'function') {
      await loadData();
    } else {
      var stockRes = await fetch('/stock/data', { cache: 'no-store' });
      var stockData = await stockRes.json();
      initStockPage(stockData);
    }

    window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'product' } }));
  } catch (err) {
    console.error('[productForm outer]', err);
    alert((isNew ? 'Thêm' : 'Cập nhật') + ' thất bại: ' + (err.message || 'Lỗi không xác định'));
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
    });
  });
}

let _stockRefreshTimer = null;
let _stockRefreshInFlight = false;

function shouldRefreshStockEntity(entity) {
  if (!entity) return true;
  return entity === 'product' || entity === 'purchase' || entity === 'stock' || entity === 'sale' || entity === 'sync';
}

function shouldRefreshStockPath(pathname) {
  if (!pathname) return false;
  return pathname.indexOf('/api/products') === 0 ||
    pathname.indexOf('/api/purchases') === 0 ||
    pathname.indexOf('/api/stock') === 0 ||
    pathname.indexOf('/api/sales') === 0 ||
    pathname.indexOf('/stock/data') === 0;
}

async function refreshStockPage(reason) {
  if (_stockRefreshInFlight || typeof loadData !== 'function') return;
  _stockRefreshInFlight = true;
  console.log('[CONSISTENCY][Stock] refresh', reason || 'mutation');
  try {
    await loadData();
  } finally {
    _stockRefreshInFlight = false;
  }
}

function queueStockRefresh(reason) {
  clearTimeout(_stockRefreshTimer);
  _stockRefreshTimer = setTimeout(function() {
    refreshStockPage(reason || 'mutation');
  }, 180);
}

window.addEventListener('data:mutated', function(evt) {
  const detail = evt && evt.detail ? evt.detail : {};
  if (!shouldRefreshStockEntity(detail.entity)) return;
  queueStockRefresh(detail.entity || 'mutation');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', function(event) {
    const data = event && event.data ? event.data : {};
    if (data.type !== 'DATA_INVALIDATED') return;
    if (!shouldRefreshStockPath(data.path || '')) return;
    queueStockRefresh('sw:' + (data.path || 'unknown'));
  });
}

// ── Global renderProducts: safe debug version ──────────────────────────────────
// Works even if #totalStockEl is missing (unlike the main renderProducts)
// Override this to make renderProducts always work from console or code
window.renderProducts = function(products) {
  console.log('[Stock] 🔥 window.renderProducts RUNNING', products);
  try {
    var container = document.getElementById('productList');
    if (!container) {
      console.error('[Stock] ❌ #productList NOT FOUND in DOM');
      return;
    }
    container.innerHTML = '';
    if (!products || products.length === 0) {
      container.innerHTML = '<div class="text-muted text-center py-8">Không có sản phẩm nào</div>';
      return;
    }
    products.forEach(function(p) {
      var low = p.stock < _LOW_STOCK_THRESHOLD;
      var name = String(p.name || 'No name').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      var cost = typeof formatVND === 'function' ? formatVND(p.cost_price || 0) : (p.cost_price || 0);
      var stock = p.stock ?? 0;
      var html = '<article class="card product-card product-card--interactive ' +
        (low ? 'border-danger' : 'border-muted') + '" ' +
        'role="button" tabindex="0" data-product-id="' + p.id + '" ' +
        'onclick="openProductModal(' + p.id + ')" ' +
        'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openProductModal(' + p.id + ');}">' +
        '<div class="flex justify-between items-start gap-2">' +
        '<h3 class="product-card__name min-w-0 flex-1">' + name + '</h3>' +
        (low ? '<span class="badge badge-danger shrink-0 text-[10px]">Sắp hết</span>' : '') +
        '</div>' +
        '<div class="product-card__meta">Giá vốn · ' + cost + '</div>' +
        '<div class="product-card__footer">' +
        '<div class="min-w-0">' +
        '<div class="product-card__qty-label">Tồn kho</div>' +
        '<div class="product-card__qty tabular-nums ' + (low ? 'text-danger' : 'text-success') + '">' + stock + '</div>' +
        '</div>' +
        '<div class="product-card__edit-pill" aria-hidden="true"><span class="product-card__edit-icon">✏️</span><span>Sửa</span></div>' +
        '</div></article>';
      var div = document.createElement('div');
      div.innerHTML = html;
      container.appendChild(div.firstElementChild);
    });
    var total = (products || []).reduce(function(s, p) { return s + Math.max(0, Number(p.stock) || 0); }, 0);
    var totalEl = document.getElementById('totalStock');
    if (totalEl) totalEl.textContent = String(total);
    console.log('[Stock] ✅ window.renderProducts done, rendered ' + products.length + ' products');
  } catch (err) {
    console.error('[Stock] ❌ window.renderProducts ERROR:', err);
  }
};
