// Sales Page JavaScript — Card-Based POS v2
// Single column layout: customer search → product cards → total/checkout

// ============================================================
// STATE
// ============================================================
let products = [];
let customers = [];
let priceMap = {};
let editingSaleId = null;
let kegEditSaleId = null;  // Sale ID đang thao tác vỏ

let saleState = {
  customerId: null,
  items: []  // [{productId, qty, price}]
};

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
  if (productId == null) return null;
  return _productById.get(Number(productId)) || null;
}

function getCustomer(customerId) {
  if (customerId == null) return null;
  return _customerById.get(Number(customerId)) || null;
}

function getProductBySlug(slug) {
  if (!slug) return null;
  return _productBySlug.get(String(slug)) || null;
}

// ============================================================
// PRICING
// ============================================================
function getEffectivePrice(product) {
  if (!product) return 0;
  var cid = saleState.customerId ? String(saleState.customerId) : null;
  var pid = product.id;
  var pslug = product.slug || '';

  if (cid && priceMap[cid]) {
    var cmap = priceMap[cid];
    if (cmap[pid] !== undefined && cmap[pid] !== null && cmap[pid] !== '') {
      var p = Number(cmap[pid]);
      if (Number.isFinite(p) && p > 0) return p;
    }
    if (cmap._bySlug && cmap._bySlug[pslug] !== undefined) {
      var sp = Number(cmap._bySlug[pslug]);
      if (Number.isFinite(sp) && sp > 0) return sp;
    }
  }
  return product.sell_price || 0;
}

// ============================================================
// INIT
// ============================================================
window.addEventListener('data:mutated', function(e) {
  if (e.detail?.entity === 'sale') loadSaleHistory();
});

window.addEventListener('realtime:refetch', function(e) {
  var entities = e.detail?.entities || [];
  if (entities.includes('all') || entities.includes('orders') || entities.includes('sales')) {
    loadSaleHistory();
  }
});

function initSalesPage(data) {
  products = data.products || [];
  customers = data.customers || [];
  priceMap = data.priceMap || {};

  Object.keys(priceMap).forEach(function(cid) {
    var cmap = priceMap[cid];
    if (cmap._bySlug === undefined) {
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
  loadSaleHistory();
}

function loadSaleHistory() {
  fetch('/sale/history?limit=5', { cache: 'no-store' })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      var sales = data.sales || [];
      renderSaleHistory(sales);
    })
    .catch(function() {
      var el = document.getElementById('saleHistoryList');
      if (el) el.innerHTML = '<div class="sale-history-empty">Không tải được lịch sử</div>';
    });
}

function renderSaleHistory(sales) {
  var container = document.getElementById('saleHistoryList');
  if (!container) return;

  if (sales.length === 0) {
    container.innerHTML = '<div class="sale-history-empty">Chưa có đơn nào gần đây</div>';
    return;
  }

  container.innerHTML = sales.map(function(s) {
    var customerName = s.customer_name || 'Khách lẻ';
    var dateStr = s.date ? new Date(s.date).toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    }) : '';
    var itemNames = (s.items || []).map(function(i) {
      return (i.product_name || 'SP') + ' x' + i.quantity;
    }).join(', ');
    var totalStr = formatVND(s.total || 0);
    var isReturned = s.status === 'returned';
    var typeLabel = '';
    if (s.type === 'replacement') typeLabel = '<span style="color:#f59e0b;font-size:11px;margin-left:6px;">Đổi lỗi</span>';
    else if (s.type === 'damage_return') typeLabel = '<span style="color:#f6465d;font-size:11px;margin-left:6px;">Trả hàng</span>';

    return '<div class="sale-history-item">' +
      '<div class="sale-history-top">' +
        '<div class="sale-history-customer">' + escHtml(customerName) + typeLabel + '</div>' +
        '<div class="sale-history-total">' + totalStr + '</div>' +
      '</div>' +
      '<div class="sale-history-meta">#' + s.id + ' · ' + dateStr + '</div>' +
      '<div class="sale-history-items">' + escHtml(itemNames) + '</div>' +
      '<div class="sale-history-actions">' +
        '<button class="action-view" onclick="viewSale(' + s.id + ')">👁 Xem</button>' +
        '<button class="action-return" onclick="returnSale(' + s.id + ')"' + (isReturned ? ' disabled' : '') + '>🔄 Trả</button>' +
        '<button class="action-edit" onclick="openEditSale(' + s.id + ')"' + (isReturned ? ' disabled' : '') + '>✏️ Sửa</button>' +
        '<button class="action-delete" onclick="deleteSale(' + s.id + ')">🗑 Xóa</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

// View sale — open checkout modal in read-only mode
function viewSale(saleId) {
  fetch('/sale/' + saleId, { cache: 'no-store' })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (!data.sale) { showToast('Không tìm thấy đơn', 'error'); return; }
      var sale = data.sale;
      var customerName = sale.customer_name || 'Khách lẻ';
      var total = sale.total || 0;
      var itemsHtml = (sale.items || []).map(function(item) {
        return '<div class="pos-modal-item">' +
          '<div class="pos-modal-item-name">' + escHtml(item.name || 'SP') + '</div>' +
          '<div class="pos-modal-item-qty">x' + item.quantity + '</div>' +
          '<div class="pos-modal-item-total">' + formatVND(item.quantity * item.price) + '</div>' +
        '</div>';
      }).join('');

      var body = document.getElementById('checkoutModalBody');
      if (!body) return;
      body.innerHTML =
        '<div class="pos-modal-customer">👤 ' + escHtml(customerName) + ' <span style="color:#848e9c;font-size:12px;">#' + sale.id + '</span></div>' +
        itemsHtml +
        '<div class="pos-modal-summary">' +
          '<div class="pos-modal-summary-label">Tổng cộng</div>' +
          '<div class="pos-modal-summary-value">' + formatVND(total) + '</div>' +
        '</div>' +
        '<div class="pos-modal-actions">' +
          '<button type="button" onclick="closeCheckoutModal()" class="pos-modal-btn-cancel">Đóng</button>' +
        '</div>';

      var modal = document.getElementById('checkoutModal');
      if (modal) modal.classList.remove('hidden');
    })
    .catch(function() { showToast('Lỗi tải đơn', 'error'); });
}

// Open keg modal for a specific sale — load sale data first
function returnSale(saleId) {
  fetch('/sale/' + saleId, { cache: 'no-store' })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      var sale = data.sale || data;
      if (!sale) { showToast('Không tìm thấy đơn', 'error'); return; }
      kegEditSaleId = saleId;
      openKegModalForSale(saleId, sale.customer_id, sale.deliver_kegs, sale.return_kegs);
    })
    .catch(function() { showToast('Lỗi tải đơn', 'error'); });
}

// Open keg modal pre-filled with sale info
function openKegModalForSale(saleId, customerId, deliverKegs, returnKegs) {
  var modal = document.getElementById('collectKegModal');
  if (!modal) return;

  saleState.customerId = customerId ? Number(customerId) : null;

  var customer = customerId ? getCustomer(customerId) : null;
  var customerName = customer ? customer.name : 'Chưa chọn';
  var balance = customer ? (customer.keg_balance || 0) : 0;

  var info = document.getElementById('collectKegInfo');
  if (info) {
    info.innerHTML = '<div style="font-size:13px;">👤 ' + escHtml(customerName) + ' | Vỏ hiện tại: <b>' + balance + '</b></div>';
    info.dataset.balance = balance;
  }

  // Reset inputs
  var deliverEl = document.getElementById('collectKegDeliver');
  var returnEl = document.getElementById('collectKegReturn');
  if (deliverEl) deliverEl.value = String(deliverKegs || 0);
  if (returnEl) returnEl.value = String(returnKegs || 0);

  updateCollectKegPreview();
  modal.classList.remove('hidden');
}

// Submit keg update for a sale
function submitCollectKegForSale(saleId) {
  var customerId = saleState.customerId;
  var deliver = parseInt(document.getElementById('collectKegDeliver')?.value) || 0;
  var returned = parseInt(document.getElementById('collectKegReturn')?.value) || 0;

  if (!customerId) {
    showToast('Vui lòng chọn khách hàng trước', 'error');
    return;
  }
  if (deliver === 0 && returned === 0) {
    showToast('Vui lòng nhập số vỏ', 'error');
    return;
  }

  // Call update-kegs API with saleId
  var body = { customer_id: customerId, sale_id: saleId, deliver_kegs: deliver, return_kegs: returned };
  fetch('/api/sales/update-kegs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(function(res) { return res.json(); })
  .then(function(data) {
    if (data.success) {
      showToast('Đã cập nhật vỏ', 'success');
      closeCollectKegModal();
      loadSaleHistory();
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'kegs' } }));
    } else {
      showToast(data.error || 'Lỗi cập nhật vỏ', 'error');
    }
  })
  .catch(function(err) {
    console.error('submitCollectKegForSale error:', err);
    showToast('Lỗi kết nối', 'error');
  });
}

// Delete sale
function deleteSale(saleId) {
  if (!confirm('Xóa đơn #' + saleId + '? Hành động này không thể hoàn tác.')) return;
  fetch('/api/sales/' + saleId, { method: 'DELETE' })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.success) {
        showToast('Đã xóa đơn', 'success');
        loadSaleHistory();
        window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
      } else {
        showToast(data.error || 'Lỗi xóa đơn', 'error');
      }
    })
    .catch(function() { showToast('Lỗi kết nối', 'error'); });
}

function openEditSale(saleId) {
  editingSaleId = saleId;

  fetch('/sale/' + saleId, { cache: 'no-store' })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      // data.sale or data itself (from proxy)
      var sale = data.sale || data;
      if (!sale) { showToast('Không tìm thấy đơn', 'error'); return; }
      if (sale.status === 'returned') {
        showToast('Đơn đã trả hàng, không thể sửa', 'error');
        return;
      }

      saleState.customerId = sale.customer_id ? Number(sale.customer_id) : null;

      // Load items
      var saleItems = sale.items || [];
      saleState.items = saleItems.map(function(item) {
        return {
          productId: Number(item.product_id),
          qty: item.quantity || 0,
          price: item.price || 0
        };
      });

      // Update customer UI
      var customerSelect = document.getElementById('customerSelect');
      var customerSearch = document.getElementById('customerSearch');
      var badge = document.getElementById('selectedCustomerBadge');
      if (customerSelect) customerSelect.value = saleState.customerId || '';
      if (saleState.customerId) {
        var customer = getCustomer(saleState.customerId);
        if (customerSearch) customerSearch.value = customer?.name || '';
        if (badge) {
          badge.classList.remove('hidden');
          badge.innerHTML = '<span>👤</span> ' + escHtml(customer?.name || '');
        }
      }

      renderProducts();
      updateTotal();

      var sellBtn = document.getElementById('sellBtn');
      if (sellBtn) {
        sellBtn.disabled = false;
        sellBtn.innerHTML = '💾 Cập nhật đơn';
      }

      // Show edit bar
      var sheet = document.getElementById('saleEditAuxSheet');
      if (sheet) sheet.classList.remove('hidden');

      // Scroll to top
      document.getElementById('saleMainContent')?.scrollTo(0, 0);
    })
    .catch(function(err) {
      console.error('openEditSale error:', err);
      showToast('Lỗi tải đơn', 'error');
    });
}

// ============================================================
// RENDER PRODUCTS
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
// QTY CHANGE
// ============================================================
function onQtyChange(productId, value) {
  var qty = parseInt(value) || 0;
  var product = getProduct(productId);
  if (!product) return;

  if (qty <= 0) {
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
  var input = document.getElementById('qty-' + productId);
  if (input) setTimeout(function() { input.select(); }, 0);
}

function onQtyKeydown(event, productId) {
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
// CUSTOMER SELECTION
// ============================================================
function filterCustomerOptions(query) {
  var dropdown = document.getElementById('customerDropdown');
  if (!dropdown) return;

  if (!query || query.length < 1) {
    // Show all customers when empty
    renderCustomerDropdown(customers.slice(0, 20));
    return;
  }

  var q = query.toLowerCase().trim();
  var filtered = customers.filter(function(c) {
    return (c.name && c.name.toLowerCase().indexOf(q) !== -1) ||
           (c.phone && c.phone.indexOf(q) !== -1);
  });

  renderCustomerDropdown(filtered.slice(0, 20));
}

function renderCustomerDropdown(list) {
  var dropdown = document.getElementById('customerDropdown');
  if (!dropdown) return;

  if (list.length === 0) {
    dropdown.innerHTML = '<div class="customer-dd-item" style="color:#848e9c;cursor:default;">Không tìm thấy</div>';
  } else {
    dropdown.innerHTML = list.map(function(c) {
      return '<div class="customer-dd-item" onclick="selectCustomer(\'' + c.id + '\', \'' + escAttr(c.name || '') + '\')">' +
        '<span style="font-weight:600;">' + escHtml(c.name || 'Khách') + '</span>' +
        '<span style="font-size:12px;color:#848e9c;margin-left:8px;">' + escHtml(c.phone || '') + '</span>' +
      '</div>';
    }).join('');
  }
  dropdown.classList.remove('hidden');
}

function showCustomerDropdown(show) {
  var dropdown = document.getElementById('customerDropdown');
  if (!dropdown) return;
  if (show) {
    filterCustomerOptions('');
  } else {
    setTimeout(function() { dropdown.classList.add('hidden'); }, 200);
  }
}

function selectCustomer(customerId, customerName) {
  var customerSelect = document.getElementById('customerSelect');
  var customerSearch = document.getElementById('customerSearch');
  var dropdown = document.getElementById('customerDropdown');
  var badge = document.getElementById('selectedCustomerBadge');

  if (customerSelect) customerSelect.value = customerId;
  if (customerSearch) customerSearch.value = customerName;
  if (dropdown) dropdown.classList.add('hidden');

  saleState.customerId = customerId ? Number(customerId) : null;

  if (badge) {
    badge.classList.remove('hidden');
    badge.className = 'sale-customer-badge';
    badge.innerHTML = '<span>👤</span> ' + escHtml(customerName || 'Khách hàng');
  }

  // Update prices in state
  saleState.items.forEach(function(item) {
    var product = getProduct(item.productId);
    if (product) item.price = getEffectivePrice(product);
  });

  renderProducts();
  updateTotal();

  // Fire onCustomerSelected hook
  if (typeof onCustomerSelected === 'function') onCustomerSelected();
}

function onCustomerSelected() {
  // Hook for future use (e.g. load customer-specific data)
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

  var sellBtn = document.getElementById('sellBtn');
  if (sellBtn) {
    var hasItems = saleState.items.some(function(i) { return i.qty > 0; });
    sellBtn.disabled = !(hasItems && editingSaleId == null);
  }
}

// ============================================================
// CHECKOUT MODAL
// ============================================================
function openCheckoutModal() {
  var validItems = saleState.items.filter(function(i) { return i.qty > 0; });
  if (validItems.length === 0) return;

  var modal = document.getElementById('checkoutModal');
  var body = document.getElementById('checkoutModalBody');
  if (!modal || !body) return;

  var customerName = 'Khách lẻ';
  if (saleState.customerId) {
    var customer = getCustomer(saleState.customerId);
    if (customer) customerName = customer.name || 'Khách hàng';
  }

  var total = 0;
  validItems.forEach(function(item) { total += item.qty * item.price; });

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
// SUBMIT SALE (create or update)
// ============================================================
function submitSale() {
  var validItems = saleState.items.filter(function(i) { return i.qty > 0 && i.price > 0; });
  if (validItems.length === 0) return;

  var btn = document.getElementById('sellBtn');
  var isEditing = editingSaleId != null;
  var btnText = isEditing ? 'Đang cập nhật...' : 'Đang xử lý...';
  if (btn) { btn.disabled = true; btn.innerHTML = btnText; }

  var payload = {
    customerId: saleState.customerId || null,
    items: validItems.map(function(item) {
      return { productId: item.productId, quantity: item.qty, price: item.price };
    })
  };

  var url = isEditing ? '/sale/update/' + editingSaleId : '/sale/create';
  var method = isEditing ? 'PUT' : 'POST';

  fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(function(res) { return res.json(); })
  .then(function(data) {
    if (data.success) {
      showToast(isEditing ? 'Cập nhật thành công!' : 'Bán hàng thành công!', 'success');
      editingSaleId = null;
      resetSaleState();
      loadSaleHistory();
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
    } else {
      showToast(data.error || 'Lỗi khi bán hàng', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = isEditing ? '💾 Cập nhật đơn' : '✅ BÁN HÀNG'; }
    }
  })
  .catch(function(err) {
    console.error('[POS] submitSale error:', err);
    showToast('Lỗi kết nối', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = isEditing ? '💾 Cập nhật đơn' : '✅ BÁN HÀNG'; }
  });
}

function resetSaleState() {
  saleState.items = [];
  saleState.customerId = null;
  editingSaleId = null;
  renderProducts();
  updateTotal();

  var customerSelect = document.getElementById('customerSelect');
  var customerSearch = document.getElementById('customerSearch');
  var badge = document.getElementById('selectedCustomerBadge');

  if (customerSelect) customerSelect.value = '';
  if (customerSearch) customerSearch.value = '';
  if (badge) { badge.classList.add('hidden'); badge.innerHTML = ''; }

  var sheet = document.getElementById('saleEditAuxSheet');
  if (sheet) sheet.classList.add('hidden');

  var btn = document.getElementById('sellBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '✅ BÁN HÀNG'; }
}

// ============================================================
// REPLACEMENT MODAL
// ============================================================
function openReplacementModal() {
  var modal = document.getElementById('replacementModal');
  if (!modal) return;

  // Populate customer dropdown
  var customerSelect = document.getElementById('replacementCustomer');
  if (customerSelect) {
    customerSelect.innerHTML = '<option value="">-- Chọn khách hàng --</option>' +
      customers.map(function(c) {
        return '<option value="' + c.id + '">' + escHtml(c.name || 'Khách') + '</option>';
      }).join('');
  }

  // Reset fields
  var productSelect = document.getElementById('replacementProduct');
  if (productSelect) productSelect.innerHTML = '<option value="">-- Chọn sản phẩm --</option>';
  var qtyInput = document.getElementById('replacementQty');
  if (qtyInput) qtyInput.value = '1';
  var giftCheck = document.getElementById('giftKegs');
  if (giftCheck) giftCheck.checked = false;
  var giftRow = document.getElementById('giftGuestRow');
  if (giftRow) giftRow.classList.add('hidden');

  modal.classList.remove('hidden');
}

function loadReplacementProducts() {
  var customerId = document.getElementById('replacementCustomer')?.value;
  var productSelect = document.getElementById('replacementProduct');
  if (!productSelect) return;

  if (!customerId) {
    productSelect.innerHTML = '<option value="">-- Chọn sản phẩm --</option>';
    return;
  }

  productSelect.innerHTML = '<option value="">Đang tải...</option>';

  fetch('/api/products?active=1')
    .then(function(res) { return res.json(); })
    .then(function(allProducts) {
      var cidStr = String(customerId);
      var hasPrices = priceMap[cidStr];
      var list = hasPrices ? allProducts : allProducts;

      productSelect.innerHTML = '<option value="">-- Chọn sản phẩm --</option>' +
        list.map(function(p) {
          return '<option value="' + p.id + '">' + escHtml(p.name) + '</option>';
        }).join('');
    })
    .catch(function() {
      productSelect.innerHTML = '<option value="">Lỗi tải</option>';
    });
}

function toggleGiftMode() {
  var giftCheck = document.getElementById('giftKegs');
  var giftRow = document.getElementById('giftGuestRow');
  if (!giftCheck || !giftRow) return;
  giftRow.classList.toggle('hidden', !giftCheck.checked);
}

function submitReplacement() {
  var customerId = document.getElementById('replacementCustomer')?.value;
  var productId = document.getElementById('replacementProduct')?.value;
  var qty = parseInt(document.getElementById('replacementQty')?.value) || 1;
  var reason = document.getElementById('replacementReason')?.value || 'Bia hư';
  var isGift = document.getElementById('giftKegs')?.checked || false;
  var giftGuestName = isGift ? document.getElementById('giftGuestName')?.value : '';

  if (!productId) {
    showToast('Vui lòng chọn sản phẩm', 'error');
    return;
  }

  var btn = document.querySelector('[onclick="submitReplacement()"]');
  if (btn) { btn.disabled = true; btn.innerText = 'Đang xử lý...'; }

  fetch('/api/sales/replacement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: customerId ? Number(customerId) : null,
      product_id: parseInt(productId),
      quantity: qty,
      reason: reason,
      gift: isGift,
      giftGuestName: giftGuestName
    })
  })
  .then(function(res) { return res.json(); })
  .then(function(data) {
    if (data.success) {
      showToast(data.message || 'Đã đổi bia lỗi', 'success');
      closeReplacementModal();
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
    } else {
      showToast(data.error || 'Lỗi khi đổi bia', 'error');
    }
  })
  .catch(function(err) {
    console.error('submitReplacement error:', err);
    showToast('Lỗi kết nối', 'error');
  })
  .finally(function() {
    if (btn) { btn.disabled = false; btn.innerText = '💾 Cập nhật'; }
  });
}

function closeReplacementModal() {
  var modal = document.getElementById('replacementModal');
  if (modal) modal.classList.add('hidden');
}

// ============================================================
// KEG MODAL
// ============================================================
function openKegModal() {
  var modal = document.getElementById('kegModal');
  if (!modal) return;

  // Reset inputs
  var deliverEl = document.getElementById('kegDeliver');
  var returnEl = document.getElementById('kegReturn');
  if (deliverEl) deliverEl.value = '0';
  if (returnEl) returnEl.value = '0';

  var badge = document.getElementById('kegModalBadge');
  if (badge) badge.classList.add('hidden');

  var beerQty = document.getElementById('kegBeerQuantity');
  if (beerQty) beerQty.textContent = '0';

  updateKegModalPreview();
  modal.classList.remove('hidden');
}

function updateKegModalPreview() {
  var deliver = parseInt(document.getElementById('kegDeliver')?.value) || 0;
  var returned = parseInt(document.getElementById('kegReturn')?.value) || 0;
  var currentBalance = parseInt(document.getElementById('kegCurrentBalance')?.dataset.balance) || 0;
  var newBalance = currentBalance + deliver - returned;

  var deliverPreview = document.getElementById('kegDeliverPreview');
  var returnPreview = document.getElementById('kegReturnPreview');
  var newBalanceEl = document.getElementById('kegNewBalance');
  var warningEl = document.getElementById('kegModalWarning');
  var saveBtn = document.getElementById('kegSaveBtn');

  if (deliverPreview) deliverPreview.textContent = '+' + deliver;
  if (returnPreview) returnPreview.textContent = '-' + returned;
  if (newBalanceEl) {
    newBalanceEl.textContent = newBalance;
    newBalanceEl.style.color = newBalance < 0 ? '#f6465d' : '#0d9f6e';
  }
  if (warningEl) {
    if (newBalance < 0) {
      warningEl.classList.remove('hidden');
      warningEl.textContent = '⚠️ Số vỏ thu vượt quá khách đang giữ';
    } else {
      warningEl.classList.add('hidden');
    }
  }
  if (saveBtn) saveBtn.disabled = newBalance < 0;
}

function saveKegUpdate() {
  var customerId = saleState.customerId;
  var deliver = parseInt(document.getElementById('kegDeliver')?.value) || 0;
  var returned = parseInt(document.getElementById('kegReturn')?.value) || 0;

  if (!customerId) {
    showToast('Vui lòng chọn khách hàng trước', 'error');
    return;
  }

  var btn = document.getElementById('kegSaveBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = 'Đang lưu...'; }

  fetch('/api/sales/update-kegs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: customerId,
      deliver_kegs: deliver,
      return_kegs: returned
    })
  })
  .then(function(res) { return res.json(); })
  .then(function(data) {
    if (data.success) {
      showToast('Đã cập nhật vỏ', 'success');
      closeKegModal();
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'kegs' } }));
    } else {
      showToast(data.error || 'Lỗi cập nhật vỏ', 'error');
    }
  })
  .catch(function(err) {
    console.error('saveKegUpdate error:', err);
    showToast('Lỗi kết nối', 'error');
  })
  .finally(function() {
    if (btn) { btn.disabled = false; btn.innerHTML = '💾 Lưu'; }
  });
}

function closeKegModal() {
  var modal = document.getElementById('kegModal');
  if (modal) modal.classList.add('hidden');
}

// ============================================================
// COLLECT KEG MODAL
// ============================================================
function openCollectKegModal() {
  var modal = document.getElementById('collectKegModal');
  if (!modal) return;
  kegEditSaleId = null;

  var info = document.getElementById('collectKegInfo');
  var deliverEl = document.getElementById('collectKegDeliver');
  var returnEl = document.getElementById('collectKegReturn');

  if (deliverEl) deliverEl.value = '0';
  if (returnEl) returnEl.value = '0';

  var customerName = saleState.customerId ? (getCustomer(saleState.customerId)?.name || 'Khách') : 'Chưa chọn';
  var balance = saleState.customerId ? (getCustomer(saleState.customerId)?.keg_balance || 0) : 0;

  if (info) {
    info.innerHTML = '<div style="font-size:13px;">👤 ' + escHtml(customerName) + ' | Vỏ hiện tại: <b>' + balance + '</b></div>';
    info.dataset.balance = balance;
  }

  updateCollectKegPreview();
  modal.classList.remove('hidden');
}

function updateCollectKegPreview() {
  var deliver = parseInt(document.getElementById('collectKegDeliver')?.value) || 0;
  var returned = parseInt(document.getElementById('collectKegReturn')?.value) || 0;
  var info = document.getElementById('collectKegInfo');
  var currentBalance = parseInt(info?.dataset?.balance) || 0;
  var remaining = currentBalance + deliver - returned;

  var deliverPreview = document.getElementById('collectKegDeliverPreview');
  var returnPreview = document.getElementById('collectKegReturnPreview');
  var remainingEl = document.getElementById('collectKegRemaining');
  var warningEl = document.getElementById('collectKegWarning');

  if (deliverPreview) deliverPreview.textContent = '+' + deliver;
  if (returnPreview) returnPreview.textContent = '-' + returned;
  if (remainingEl) {
    remainingEl.textContent = remaining;
    remainingEl.style.color = remaining < 0 ? '#f6465d' : '#0d9f6e';
  }
  if (warningEl) {
    warningEl.classList.toggle('hidden', remaining >= 0);
    if (remaining < 0) warningEl.textContent = '⚠️ Số vỏ thu vượt quá khách đang giữ';
  }
}

function submitCollectKeg() {
  var customerId = saleState.customerId;
  var deliver = parseInt(document.getElementById('collectKegDeliver')?.value) || 0;
  var returned = parseInt(document.getElementById('collectKegReturn')?.value) || 0;

  if (!customerId) {
    showToast('Vui lòng chọn khách hàng trước', 'error');
    return;
  }
  if (deliver === 0 && returned === 0) {
    showToast('Vui lòng nhập số vỏ', 'error');
    return;
  }

  // If editing a sale (from history), use /api/sales/update-kegs
  if (kegEditSaleId != null) {
    fetch('/api/sales/update-kegs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        saleId: kegEditSaleId,
        customer_id: customerId,
        deliver_kegs: deliver,
        return_kegs: returned
      })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.success) {
        showToast('Đã cập nhật vỏ', 'success');
        closeCollectKegModal();
        loadSaleHistory();
        window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'kegs' } }));
      } else {
        showToast(data.error || 'Lỗi cập nhật vỏ', 'error');
      }
    })
    .catch(function(err) {
      console.error('submitCollectKeg error:', err);
      showToast('Lỗi kết nối', 'error');
    });
    return;
  }

  // Standalone mode — use /api/kegs/collect and /api/kegs/deliver
  if (deliver > 0) {
    fetch('/api/kegs/deliver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: customerId, quantity: deliver })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (!data.success) showToast(data.error || 'Lỗi giao vỏ', 'error');
    });
  }

  if (returned > 0) {
    fetch('/api/kegs/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: customerId, quantity: returned })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.success) {
        showToast('Đã thu vỏ', 'success');
        closeCollectKegModal();
        window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'kegs' } }));
      } else {
        showToast(data.error || 'Lỗi thu vỏ', 'error');
      }
    })
    .catch(function(err) {
      console.error('submitCollectKeg error:', err);
      showToast('Lỗi kết nối', 'error');
    });
  }
}

function closeCollectKegModal() {
  var modal = document.getElementById('collectKegModal');
  if (modal) modal.classList.add('hidden');
  kegEditSaleId = null;
}

// ============================================================
// EDIT SALE
// ============================================================
function cancelEdit() {
  editingSaleId = null;
  var sheet = document.getElementById('saleEditAuxSheet');
  if (sheet) sheet.classList.add('hidden');
  resetSaleState();
}

function updateSale() {
  submitSale();
}

// ============================================================
// INVOICE
// ============================================================
function closeInvoice() {
  var modal = document.getElementById('invoiceModal');
  if (modal) modal.classList.add('hidden');
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

function escAttr(str) {
  if (str == null) return '';
  return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function formatVND(n) {
  if (n == null || isNaN(n)) return '0đ';
  return new Intl.NumberFormat('vi-VN').format(Math.round(n)) + 'đ';
}
