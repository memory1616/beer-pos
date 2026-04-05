// Stock Page JavaScript
// Tách riêng để dễ bảo trì và cache
// formatVND, showToast được định nghĩa trong utils.js (global)

let currentProducts = [];
let importData = {}; // Store import data by productId

// PERFORMANCE: Virtual scroll pagination for product list
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

function initStockPage(data) {
  // Render products
  currentProducts = data.products;
  _filteredProducts = data.products;
  window.store.products = data.products;

  _renderProductsPage(_filteredProducts.slice(0, PAGE_SIZE), data.totalStockPositive, _filteredProducts.length > PAGE_SIZE);

  // Render import form
  renderImportForm(data.products);

  // Render purchase history
  if (data.purchases && data.purchases.length > 0) {
    renderPurchaseHistory(data.purchases);
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
  
  if (purchases.length === 0) {
    container.innerHTML = '<div class="text-muted text-center py-2">Chưa có lịch sử nhập hàng</div>';
    return;
  }
  
    container.innerHTML = purchases.map(p => {
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
    const res = await fetch('/api/purchases/' + purchaseId);
    const purchase = await res.json();
    
    document.getElementById('editPurchaseId').value = purchase.id;
    document.getElementById('editPurchaseNote').value = purchase.note || '';
    
    // Load purchase items
    const itemsRes = await fetch('/api/purchases/' + purchaseId);
    const itemsData = await itemsRes.json();
    
    const itemsContainer = document.getElementById('editPurchaseItems');
    itemsContainer.innerHTML = itemsData.items.map(item => `
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
    `).join('');
    
    document.getElementById('purchaseModal').classList.remove('hidden');
    document.getElementById('purchaseModal').classList.add('flex');
  } catch (err) {
    console.error(err);
    alert('Lỗi tải thông tin đơn nhập');
  }
}

function closePurchaseModal() {
  document.getElementById('purchaseModal').classList.add('hidden');
  document.getElementById('purchaseModal').classList.remove('flex');
}

async function deletePurchase(purchaseId) {
  if (!confirm('Bạn có chắc muốn xoá đơn nhập hàng này?')) return;

  mutate(
    function() {
      return fetch('/api/purchases/' + purchaseId, { method: 'DELETE', cache: 'no-store' });
    },
    function() {
      alert('Đã xoá đơn nhập hàng!');
      // Remove from local purchase list and DOM
      if (typeof allPurchases !== 'undefined') {
        allPurchases = allPurchases.filter(function(p) { return String(p.id) !== String(purchaseId); });
        window.store.purchases = allPurchases;
      }
      removePurchaseItem(purchaseId);
      updatePurchasesSummary();
      checkPurchasesEmpty();
    },
    function() {
      location.reload();
    }
  );
}

document.getElementById('editPurchaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const purchaseId = document.getElementById('editPurchaseId').value;
  const note = document.getElementById('editPurchaseNote').value;

  // Get updated items
  const items = [];
  document.querySelectorAll('#editPurchaseItems .edit-qty').forEach(qtyInput => {
    const itemId = qtyInput.dataset.itemId;
    const productId = qtyInput.dataset.productId;
    const quantity = parseInt(qtyInput.value) || 0;
    const costInput = document.querySelector('.edit-cost[data-item-id="' + itemId + '"]');
    const unitPrice = parseFloat(costInput.value) || 0;

    if (quantity > 0) {
      items.push({ item_id: itemId, product_id: productId, quantity, unit_price: unitPrice });
    }
  });

  mutate(
    function() {
      return fetch('/api/purchases/' + purchaseId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, note }),
        cache: 'no-store'
      });
    },
    function(result) {
      closePurchaseModal();
      // Update purchase in store and patch DOM
      var purchase = result.purchase || result;
      if (typeof allPurchases !== 'undefined') {
        var idx = allPurchases.findIndex(function(p) { return String(p.id) === String(purchase.id); });
        if (idx !== -1) allPurchases[idx] = Object.assign({}, allPurchases[idx], purchase);
        window.store.purchases = allPurchases;
      }
      updatePurchaseItem(purchase);
      updatePurchasesSummary();
    },
    function() {
      location.reload();
    }
  );
});

function renderImportForm(products) {
  const container = document.getElementById('importProducts');
  
  // Layout rõ ràng: tên SP, giá vốn 1 dòng, chỉ ô SL (không lặp giá)
  container.innerHTML = products.map(p => `
    <div class="card p-3">
      <div class="text-sm font-semibold text-main">${p.name}</div>
      <div class="text-xs text-muted mt-0.5">Giá vốn: ${formatVND(p.cost_price || 0)} · Tồn: ${p.stock}</div>
      <input type="number" id="qty-${p.id}" min="0" placeholder="Nhập SL"
        class="mt-2 w-full border-2 border-primary rounded-lg p-2.5 text-center font-medium focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
        onchange="updateImportData(${p.id}, this.value)"
        oninput="updateImportData(${p.id}, this.value)">
    </div>
  `).join('');
  
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

  mutate(
    function() {
      return fetch('/api/stock/multiple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, note: 'Nhập kho' }),
        cache: 'no-store'
      });
    },
    function(result) {
      alert('Nhập hàng thành công!');

      // Update local product stock in-place
      items.forEach(function(importedItem) {
        var product = currentProducts.find(function(p) { return p.id === importedItem.productId; });
        if (product) {
          product.stock = (product.stock || 0) + importedItem.quantity;
          updateProductItem(product);
        }
      });

      // Update purchase history
      if (result.purchase) {
        if (typeof allPurchases === 'undefined') {
          window.allPurchases = [];
        }
        allPurchases.unshift(result.purchase);
        window.store.purchases = allPurchases;
        renderPurchaseItem(result.purchase, { prepend: true });
      }

      // Update summaries
      updateProductsSummary();

      // Reset import form
      importData = {};
      document.querySelectorAll('#importProducts input[type="number"]').forEach(function(input) {
        input.value = '';
      });
      calculateImportTotal();
    },
    function() {
      location.reload();
    }
  );
}

// PERFORMANCE: Extract product card HTML for reuse in virtual scrolling
function _productCardHtml(p, totalPositive) {
  const low = p.stock < 5;
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
  if (!container) return;

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
    const lowStockProducts = _filteredProducts.filter(p => p.stock < 5);
    
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
  const lowStockProducts = products.filter(p => p.stock < 5);

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
    const low = p.stock < 5;
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
function openProductModal(productId = null) {
  const modal = document.getElementById('productModal');
  const form = document.getElementById('productForm');
  const title = document.getElementById('modalTitle');
  const deleteBtn = document.getElementById('deleteProductBtn');
  const stockField = document.getElementById('stockField');
  
  form.reset();
  
  if (productId) {
    // Edit mode
    const product = currentProducts.find(p => p.id === productId);
    if (!product) return;
    
    title.textContent = 'Sửa sản phẩm';
    document.getElementById('productId').value = product.id;
    document.getElementById('productName').value = product.name;
    document.getElementById('productType').value = product.type || 'keg';
    document.getElementById('productCostPrice').value = product.cost_price || 0;
    document.getElementById('productStock').value = product.stock;
    deleteBtn.classList.remove('hidden');
    stockField.classList.remove('hidden');
  } else {
    // Add mode
    title.textContent = 'Thêm sản phẩm';
    document.getElementById('productId').value = '';
    document.getElementById('productType').value = 'keg';
    deleteBtn.classList.add('hidden');
    stockField.classList.add('hidden');
  }
  
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeProductModal() {
  const modal = document.getElementById('productModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function deleteProduct() {
  const productId = document.getElementById('productId').value;
  const productName = document.getElementById('productName').value;

  if (!confirm('Bạn có chắc muốn xoá sản phẩm "' + productName + '"?')) {
    return;
  }

  mutate(
    function() {
      return fetch('/api/products/' + productId, {
        method: 'DELETE',
        cache: 'no-store'
      });
    },
    function() {
      alert('Đã xoá sản phẩm!');
      closeProductModal();
      // Remove from local data and DOM
      currentProducts = currentProducts.filter(function(p) { return String(p.id) !== String(productId); });
      _filteredProducts = _filteredProducts.filter(function(p) { return String(p.id) !== String(productId); });
      window.store.products = currentProducts;
      removeProductItem(productId);
      // Update import form
      renderImportForm(currentProducts);
      updateProductsSummary();
    },
    function() {
      location.reload();
    }
  );
}

// Product Form Submit
document.getElementById('productForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const productId = document.getElementById('productId').value;
  const name = document.getElementById('productName').value.trim();
  const type = document.getElementById('productType').value;
  const cost_price = parseFloat(document.getElementById('productCostPrice').value) || 0;
  const stock = productId ? (parseInt(document.getElementById('productStock').value) || 0) : 0;

  if (!name) {
    alert('Vui lòng nhập tên sản phẩm');
    return;
  }

  const data = { name, type, cost_price };
  if (productId) {
    data.stock = stock;
  }

  const method = productId ? 'PUT' : 'POST';
  const url = productId ? '/api/products/' + productId : '/api/products';

  mutate(
    function() {
      return fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        cache: 'no-store'
      });
    },
    function(result) {
      closeProductModal();
      var product = result.product || result;

      if (productId) {
        // Update: patch existing product in list and store
        var idx = currentProducts.findIndex(function(p) { return String(p.id) === String(product.id); });
        if (idx !== -1) currentProducts[idx] = Object.assign({}, currentProducts[idx], product);
        window.store.products = currentProducts;
        updateProductItem(product);
        updateProductsSummary();
      } else {
        // Create: add new product to list and store
        currentProducts.unshift(product);
        window.store.products.unshift(product);
        renderProductItem(product, { prepend: true });
        // Update import form with new product
        renderImportForm(currentProducts);
        updateProductsSummary();
      }
    },
    function() {
      location.reload();
    }
  );
});
