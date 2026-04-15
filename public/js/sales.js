// Sales Page JavaScript — Card-Based POS v2
// Single column layout: customer search → product cards → total/checkout

// ============================================================
// SAFE JSON — never crash on non-JSON / offline responses
// ============================================================
/**
 * Wraps fetch response.json() with error handling.
 * Returns null on parse failure or offline response.
 * Also checks for offline: true flag in body.
 */
async function safeJson(res) {
  if (!res || !res.ok) {
    // Try to extract offline flag from error response body
    try {
      const clone = res.clone();
      const text = await clone.text();
      if (text && text.length < 200) {
        try {
          const parsed = JSON.parse(text);
          if (parsed.offline || (parsed.error && parsed.error.toLowerCase().includes('offline'))) {
            return { _offline: true, _raw: text };
          }
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }
  try {
    return await res.json();
  } catch (e) {
    try {
      const text = await res.clone().text();
      return null;
    } catch (_) {
      return null;
    }
  }
}

// ============================================================
// STATE
// ============================================================
let products = [];
let customers = [];
let priceMap = {};
let editingSaleId = null;
let kegEditSaleId = null;  // Sale ID đang thao tác vỏ
let kegSubmitting = false; // Guard: prevent double click submit

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
  var ent = e.detail && e.detail.entity;
  if (ent === 'sale' || ent === 'product') {
    loadSaleHistory();
  }
  // Reload products when inventory changes (after sale/delete/edit)
  if (ent === 'inventory' || ent === 'sale') {
    reloadSaleProducts();
  }
  if (ent === 'product' && typeof window.loadSalesData === 'function') {
    window.loadSalesData();
  }
});

window.addEventListener('realtime:refetch', function(e) {
  var entities = e.detail && e.detail.entities ? e.detail.entities : [];
  if (entities.indexOf('all') !== -1 || entities.indexOf('orders') !== -1 ||
      entities.indexOf('sales') !== -1 || entities.indexOf('inventory') !== -1 ||
      entities.indexOf('products') !== -1) {
    loadSaleHistory();
  }
});

function initSalesPage(data) {
  products = data.products || [];
  customers = data.customers || [];
  priceMap = data.priceMap || {};

  // Close dropdown when clicking outside the customer search area
  document.addEventListener('click', function(e) {
    var search = document.getElementById('customerSearch');
    var dropdown = document.getElementById('customerDropdown');
    if (!search || !dropdown) return;
    var searchBox = search.closest('.sale-section-customer');
    if (searchBox && searchBox.contains(e.target)) return;
    if (e.target === search) return;
    showCustomerDropdown(false);
  });

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
  populateSaleHistoryMonthFilter();
  loadSaleHistory();
}

// Reload products from server (for inventory/sale changes)
async function reloadSaleProducts() {
  try {
    const res = await fetch('/api/products');
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data)) {
      products = data;
      _rebuildMaps();
      renderProducts();
      console.log('[reloadSaleProducts] Products refreshed, count:', products.length);
    }
  } catch (err) {
    console.error('[reloadSaleProducts] Error:', err);
  }
}

let saleHistoryPage = 1;
let saleHistoryYear = null;
let saleHistoryMonth = null;
let saleHistoryTotalPages = 1;

function loadSaleHistory() {
  var page = saleHistoryPage || 1;
  var year = saleHistoryYear;
  var month = saleHistoryMonth;

  var url = '/sale/history?page=' + page;
  if (year && month) {
    url += '&year=' + year + '&month=' + month;
  }

  fetch(url, { cache: 'no-store' })
    .then(function(res) { return safeJson(res); })
    .then(function(data) {
      if (!data) return;
      var sales = data.sales || [];
      saleHistoryTotalPages = data.totalPages || 1;
      renderSaleHistory(sales, data.page || 1, saleHistoryTotalPages);
    })
    .catch(function() {
      var el = document.getElementById('saleHistoryList');
      if (el) el.innerHTML = '<div class="sale-history-empty">Không tải được lịch sử</div>';
    });
}

function goSaleHistoryPage(page) {
  if (page < 1 || page > saleHistoryTotalPages) return;
  saleHistoryPage = page;
  loadSaleHistory();
}

function filterSaleHistoryByMonth(year, month) {
  saleHistoryYear = year;
  saleHistoryMonth = month;
  saleHistoryPage = 1;
  loadSaleHistory();
}

function onSaleHistoryMonthChange(value) {
  if (!value) {
    filterSaleHistoryByMonth(null, null);
    return;
  }
  var parts = value.split('-');
  filterSaleHistoryByMonth(parseInt(parts[0]), parseInt(parts[1]));
}

function populateSaleHistoryMonthFilter() {
  var sel = document.getElementById('saleHistoryMonth');
  if (!sel) return;
  var now = new Date();
  var options = [{ label: 'Tất cả', value: '' }];
  for (var i = 0; i < 12; i++) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var label = 'Tháng ' + m + ' / ' + y;
    var val = y + '-' + String(m).padStart(2, '0');
    options.push({ label: label, value: val });
  }
  sel.innerHTML = options.map(function(o) {
    return '<option value="' + o.value + '">' + o.label + '</option>';
  }).join('');
  // Default to current month (not "Tất cả")
  var y = now.getFullYear();
  var m = now.getMonth() + 1;
  var defaultVal = y + '-' + String(m).padStart(2, '0');
  sel.value = defaultVal;
  onSaleHistoryMonthChange(defaultVal);
}

function renderSaleHistory(sales, page, totalPages) {
  var container = document.getElementById('saleHistoryList');
  if (!container) return;

  if (sales.length === 0) {
    container.innerHTML = '<div class="sale-history-empty">Chưa có đơn nào gần đây</div>';
    renderSaleHistoryPagination(page, totalPages);
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

    // Tính tổng số lít từ items (tìm số trong tên sản phẩm VD: "Bia 30L" x 5 = 150L)
    // Nếu tên không chứa số L (VD: bia bom vàng, bia pet) → mặc định 1 lít / dòng
    var totalLiters = 0;
    (s.items || []).forEach(function(item) {
      var name = item.product_name || '';
      var match = name.match(/(\d+)\s*[Ll]/);
      var per = match ? (parseInt(match[1], 10) || 1) : 1;
      totalLiters += per * (parseInt(item.quantity, 10) || 0);
    });

    var totalStr = formatVND(s.total || 0);
    var isReturned = s.status === 'returned';
    var typeLabel = '';
    if (s.type === 'replacement') typeLabel = '<span style="color:var(--warning);font-size:11px;margin-left:6px;">Đổi lỗi</span>';
    else if (s.type === 'damage_return') typeLabel = '<span style="color:var(--red);font-size:11px;margin-left:6px;">Trả hàng</span>';

    // Hiển thị kegs info
    var kegsInfo = '';
    if (totalLiters > 0 || s.deliver_kegs > 0 || s.return_kegs > 0) {
      var parts = [];
      if (totalLiters > 0) parts.push('Số lượng: ' + totalLiters + 'L');
      if (s.deliver_kegs > 0) parts.push('Giao: ' + s.deliver_kegs);
      if (s.return_kegs > 0) parts.push('Thu: ' + s.return_kegs);
      kegsInfo = '<div class="sale-history-kegs">' + parts.join('   |   ') + '</div>';
    }

    return '<div class="sale-history-item">' +
      '<div class="sale-history-top">' +
        '<div class="sale-history-customer">' + escHtml(customerName) + typeLabel + '</div>' +
        '<div class="sale-history-total">' + totalStr + '</div>' +
      '</div>' +
      '<div class="sale-history-meta">#' + s.id + ' · ' + dateStr + '</div>' +
      '<div class="sale-history-items">' + escHtml(itemNames) + '</div>' +
      kegsInfo +
      '<div class="sale-history-actions">' +
        '<button class="action-view" onclick="viewSale(' + s.id + ')">👁 Xem</button>' +
        '<button class="action-return" onclick="returnSale(' + s.id + ')"' + (isReturned ? ' disabled' : '') + '>🔄 Trả</button>' +
        '<button class="action-edit" onclick="openEditSale(' + s.id + ')"' + (isReturned ? ' disabled' : '') + '>✏️ Sửa</button>' +
        '<button class="action-delete" onclick="deleteSale(' + s.id + ')">🗑 Xóa</button>' +
      '</div>' +
    '</div>';
  }).join('');
  renderSaleHistoryPagination(page, totalPages);
}

// Phân trang cho sale history
function renderSaleHistoryPagination(page, totalPages) {
  var container = document.getElementById('saleHistoryPagination');
  if (!container) return;
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }
  var prevDisabled = page <= 1 ? 'disabled' : '';
  var nextDisabled = page >= totalPages ? 'disabled' : '';
  container.innerHTML =
    '<div class="sale-history-pagination">' +
      '<button class="pag-btn" onclick="goSaleHistoryPage(' + (page - 1) + ')" ' + prevDisabled + '>‹</button>' +
      '<span class="pag-info">' + page + ' / ' + totalPages + '</span>' +
      '<button class="pag-btn" onclick="goSaleHistoryPage(' + (page + 1) + ')" ' + nextDisabled + '>›</button>' +
    '</div>';
}

// ============================================================
// INVOICE — single source of truth: window._invoiceContext (set on open, cleared on close)
// ============================================================
window._invoiceContext = null;

/** API có thể trả { sale: {...} } (route /sale/:id) hoặc object phẳng (một số proxy). */
function extractSaleFromResponse(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.error && !data.id) return null;
  if (data.sale && typeof data.sale === 'object') return data.sale;
  if (data.id != null && (data.items !== undefined || data.total !== undefined)) return data;
  return null;
}

/**
 * Chuẩn hóa hóa đơn — luôn dùng items[], totalAmount, bottleGiven / bottleReceived.
 * Hỗ trợ alias: products → items; deliver_kegs / return_kegs.
 */
function normalizeInvoice(sale) {
  if (!sale || typeof sale !== 'object') return null;
  var rawItems = sale.items || sale.products || [];
  if (!Array.isArray(rawItems)) rawItems = [];

  var items = rawItems.map(function(it) {
    var qty = Number(it.quantity != null ? it.quantity : it.qty) || 0;
    var price = Number(it.price != null ? it.price : it.unitPrice) || 0;
    return {
      name: it.name || it.product_name || it.productName || 'SP',
      quantity: qty,
      price: price,
      product_id: it.product_id != null ? it.product_id : it.productId
    };
  });

  var totalAmount = sale.totalAmount != null ? Number(sale.totalAmount) : (sale.total != null ? Number(sale.total) : NaN);
  if (!Number.isFinite(totalAmount)) {
    totalAmount = items.reduce(function(sum, it) { return sum + it.quantity * it.price; }, 0);
  }

  var bottleGiven = sale.bottleGiven != null ? Number(sale.bottleGiven) : (sale.deliver_kegs != null ? Number(sale.deliver_kegs) : 0);
  var bottleReceived = sale.bottleReceived != null ? Number(sale.bottleReceived) : (sale.return_kegs != null ? Number(sale.return_kegs) : 0);
  if (!Number.isFinite(bottleGiven)) bottleGiven = 0;
  if (!Number.isFinite(bottleReceived)) bottleReceived = 0;

  // Tính bottleBefore từ keg_balance_after của invoice
  var bottleAfter = sale.keg_balance_after != null ? Number(sale.keg_balance_after) : null;
  var bottleBefore = null;
  if (bottleAfter !== null && bottleGiven !== null && bottleReceived !== null) {
    bottleBefore = bottleAfter - bottleGiven + bottleReceived;
  }

  var cid = sale.customer_id != null ? sale.customer_id : sale.customerId;
  var createdAt = sale.created_at || sale.date;
  return {
    id: sale.id,
    customer: {
      id: cid != null ? Number(cid) : null,
      name: sale.customer_name || sale.customerName || 'Khách lẻ',
      keg_balance: sale.customer_keg_balance != null ? Number(sale.customer_keg_balance) : null
    },
    items: items,
    totalAmount: totalAmount,
    bottleGiven: bottleGiven,
    bottleReceived: bottleReceived,
    bottleBefore: bottleBefore,
    bottleAfter: bottleAfter,
    date: createdAt,
    status: sale.status,
    type: sale.type,
    raw: sale
  };
}

/**
 * Generate VietQR payment URL
 * @param {object} invoice - invoice object with id and totalAmount
 * @returns {string} VietQR image URL
 */
function generateVietQR(invoice) {
  var amount = invoice && invoice.totalAmount ? Math.round(invoice.totalAmount) : 0;
  var invoiceId = invoice && invoice.id ? invoice.id : '';
  var content = 'Thanh toan HD ' + invoiceId;
  var name = 'NGUYEN MINH QUAN';
  var encodedContent = encodeURIComponent(content);
  var encodedName = encodeURIComponent(name);
  return 'https://img.vietqr.io/image/ICB-107875230331-compact2.png?amount=' +
    amount + '&addInfo=' + encodedContent + '&accountName=' + encodedName;
}

function renderInvoiceModalContent(invoice, saleIdForActions) {
  var orderEl = document.getElementById('invOrderId');
  var metaEl = document.getElementById('invCustomerMeta');
  var itemsList = document.getElementById('invItemsList');
  var invActions = document.getElementById('invActions');
  var vietqrBlock = document.getElementById('vietqrBlock');
  if (!itemsList) { console.warn('[renderInvoiceModalContent] invItemsList not found'); return; }
  if (!orderEl) orderEl = document.getElementById('invOrderId');
  if (!invActions) invActions = document.getElementById('invActions');

  console.log('[renderInvoiceModalContent] invoice:', JSON.stringify(invoice));
  console.log('[renderInvoiceModalContent] items:', invoice && invoice.items);
  console.log('[renderInvoiceModalContent] customer:', invoice && invoice.customer);
  console.log('[renderInvoiceModalContent] saleIdForActions:', saleIdForActions);

  var invDateEl = document.getElementById('invDate');
  var invKegDeliver = document.getElementById('invKegDeliver');
  var invKegReturn = document.getElementById('invKegReturn');
  var invKegBalance = document.getElementById('invKegBalance');
  var invTotalValue = document.getElementById('invTotalValue');
  var vietqrImage = document.getElementById('vietqrImage');

  // Reset all fields to safe defaults
  if (orderEl) orderEl.textContent = '#—';
  if (metaEl) metaEl.textContent = '—';
  if (invDateEl) invDateEl.textContent = '';
  if (invKegDeliver) invKegDeliver.textContent = '0';
  if (invKegReturn) invKegReturn.textContent = '0';
  if (invKegBalance) invKegBalance.textContent = '0';
  if (invTotalValue) invTotalValue.textContent = '0đ';
  if (vietqrBlock) vietqrBlock.style.display = 'none';
  if (vietqrImage) vietqrImage.src = '';

  var modal = document.getElementById('invPosModal');
  if (modal) modal.classList.remove('compact', 'ultra-compact');

  if (!invoice) {
    itemsList.innerHTML =
      '<div class="inv-empty-state" style="text-align:center;padding:28px 16px;color:var(--text-muted);font-size:13px;line-height:1.5;">' +
      'Không có dữ liệu hóa đơn.<br><span style="font-size:12px;opacity:0.85;">Thử tải lại hoặc chọn đơn khác.</span></div>';
    if (invActions) invActions.innerHTML = '';
    return;
  }

  var sid = saleIdForActions != null ? saleIdForActions : invoice.id;
  if (!Number.isFinite(sid) || sid == null) sid = invoice.id;
  var dateStr = '';
  if (invoice.date) {
    var d = new Date(invoice.date);
    // Fix: date-only strings (e.g. "2026-04-12") → new Date parses as UTC midnight → shows 07:00 in UTC+7.
    // Detect: if invoice.date has no time part, assume local date.
    if (/^\d{4}-\d{2}-\d{2}$/.test(invoice.date)) {
      var parts = invoice.date.split('-');
      d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
    }
    dateStr = d.toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  if (orderEl) orderEl.textContent = '#' + sid;
  if (metaEl) metaEl.textContent = (invoice.customer && invoice.customer.name) || 'Khách lẻ';
  if (invDateEl) invDateEl.textContent = dateStr;

  // Compact mode
  var itemCount = (invoice.items || []).length;
  if (modal) {
    modal.classList.remove('compact', 'ultra-compact');
    if (itemCount > 6) modal.classList.add('ultra-compact');
    else if (itemCount > 3) modal.classList.add('compact');
  }

  var rows = (invoice.items || []).map(function(item) {
    var lineTotal = (item.quantity || 0) * (item.price || 0);
    var shortName = (item.name || 'SP').slice(0, 20);
    var isUltra = modal && modal.classList.contains('ultra-compact');
    return '<div class="invoice-item">' +
      '<div class="invoice-item-left">' +
        '<div class="invoice-item-name">' + escHtml(shortName) + '</div>' +
        (isUltra ? '' : '<small>x' + item.quantity + ' · ' + formatVND(item.price) + '</small>') +
      '</div>' +
      '<div class="invoice-item-total">' + (isUltra ? item.quantity + ' × ' : '') + formatVND(lineTotal) + '</div>' +
    '</div>';
  }).join('');

  if (!rows) {
    itemsList.innerHTML =
      '<div class="inv-empty-state" style="text-align:center;padding:20px 16px;color:var(--text-muted);font-size:13px;">Đơn không có dòng sản phẩm.</div>';
  } else {
    itemsList.innerHTML = rows;
  }

  var customer = invoice.customer && invoice.customer.id != null ? getCustomer(invoice.customer.id) : null;
  var balance = (invoice.customer && invoice.customer.keg_balance != null)
    ? invoice.customer.keg_balance
    : (customer ? (customer.keg_balance || 0) : 0);

  if (invKegDeliver) invKegDeliver.textContent = String(invoice.bottleGiven || 0);
  if (invKegReturn) invKegReturn.textContent = String(invoice.bottleReceived || 0);
  if (invKegBalance) invKegBalance.textContent = String(balance);

  var totalDisplay = invoice.totalAmount;
  if (!Number.isFinite(totalDisplay) || totalDisplay == null) {
    totalDisplay = (invoice.items || []).reduce(function(sum, it) { return sum + (it.quantity || 0) * (it.price || 0); }, 0);
  }
  if (invTotalValue) invTotalValue.textContent = formatVND(totalDisplay);

  // QR
  var vietqrUrl = generateVietQR(invoice);
  if (vietqrBlock) vietqrBlock.style.display = '';
  if (vietqrImage) { vietqrImage.src = vietqrUrl; vietqrImage.style.display = ''; }

  // Actions — removed close button (use overlay click to close)
  if (invActions) {
    invActions.innerHTML = '';
  }
}

function showInvoiceModalElement() {
  var overlay = document.getElementById('invoiceModal');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  overlay.style.pointerEvents = 'auto';
  document.body.classList.add('modal-open');
  if (!overlay._invOverlayBound) {
    overlay._invOverlayBound = true;
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeInvoice();
    });
  }
  // Auto-scale modal to fit viewport without scroll
  autoScaleInvoiceModal();
}

/* Auto-scale invoice modal to fit within 90vh without scroll — desktop only */
function autoScaleInvoiceModal() {
  var modal = document.querySelector('.inv-pos');
  if (!modal) return;
  // Skip scaling on mobile — let CSS handle 100dvh
  if (window.innerWidth <= 480) {
    modal.style.transform = '';
    modal.style.width = '100%';
    modal.style.maxWidth = '100%';
    modal.style.marginBottom = '';
    return;
  }
  // Wait for render
  requestAnimationFrame(function() {
    var modalRect = modal.getBoundingClientRect();
    var viewportHeight = window.innerHeight;
    var maxHeight = viewportHeight * 0.9;
    if (modalRect.height > maxHeight) {
      var scale = maxHeight / modalRect.height;
      // Limit minimum scale to keep text readable
      scale = Math.max(scale, 0.7);
      modal.style.transformOrigin = 'top center';
      modal.style.transform = 'scale(' + scale + ')';
      // Adjust width to maintain aspect ratio
      modal.style.width = (420 * scale) + 'px';
      modal.style.maxWidth = (420 * scale) + 'px';
      modal.style.marginBottom = '0';
    } else {
      modal.style.transform = '';
      modal.style.width = '';
      modal.style.maxWidth = '';
    }
  });
}

/**
 * Mở modal hóa đơn — chỉ đọc dữ liệu (GET), không tạo / không cập nhật giao dịch.
 * @param {number|string|object|null} source — saleId, object sale đã có, hoặc null (empty state)
 */
function openInvoiceModal(source) {
  if (source == null || source === '') {
    window._invoiceContext = null;
    renderInvoiceModalContent(null, null);
    showInvoiceModalElement();
    return;
  }

  if (typeof source === 'object') {
    var invObj = normalizeInvoice(source);
    window._invoiceContext = invObj ? { saleId: invObj.id, rawSale: invObj.raw || source } : null;
    renderInvoiceModalContent(invObj, invObj && invObj.id);
    showInvoiceModalElement();
    return;
  }

  var saleId = parseInt(source, 10);
  if (!Number.isFinite(saleId) || saleId <= 0) {
    window._invoiceContext = null;
    renderInvoiceModalContent(null, null);
    showInvoiceModalElement();
    return;
  }

  fetch('/sale/' + saleId, { cache: 'no-store' })
    .then(function(res) {
      console.log('[openInvoiceModal] status:', res.status, 'url:', res.url);
      return safeJson(res);
    })
    .then(function(data) {
      console.log('[openInvoiceModal] raw data:', JSON.stringify(data));
      if (!data) {
        showToast('Không tìm thấy đơn', 'error');
        var inv = null;
        window._invoiceContext = null;
        renderInvoiceModalContent(null, null);
        showInvoiceModalElement();
        return;
      }
      var sale = extractSaleFromResponse(data);
      console.log('[openInvoiceModal] extracted sale:', JSON.stringify(sale));
      if (!sale) {
        showToast('Không tìm thấy đơn', 'error');
        var inv = null;
        window._invoiceContext = null;
        renderInvoiceModalContent(null, null);
        showInvoiceModalElement();
        return;
      }
      var invoice = normalizeInvoice(sale);
      window._invoiceContext = invoice ? { saleId: saleId, rawSale: sale } : null;
      renderInvoiceModalContent(invoice, saleId);
      showInvoiceModalElement();
    })
    .catch(function(err) {
      console.error('openInvoiceModal error:', err);
      window._invoiceContext = null;
      renderInvoiceModalContent(null, null);
      showInvoiceModalElement();
      showToast('Lỗi tải đơn', 'error');
    });
}

function viewSale(saleId) {
  openInvoiceModal(saleId);
}

// Mở modal vỏ từ trong invoice modal (chỉ đọc context / GET — không tạo giao dịch)
function openKegFromInvoice(saleId) {
  var ctx = window._invoiceContext;
  var sale = ctx && ctx.rawSale;
  if (sale && Number(ctx.saleId) === Number(saleId)) {
    openKegFromSaleData(sale, saleId);
    return;
  }
  fetch('/sale/' + saleId, { cache: 'no-store' })
    .then(function(res) { return safeJson(res); })
    .then(function(data) {
      var s = data ? extractSaleFromResponse(data) : null;
      if (s) openKegFromSaleData(s, saleId);
    })
    .catch(function() { showToast('Lỗi tải đơn', 'error'); });
}

function openKegFromSaleData(sale, saleId) {
  closeInvoice();
  openKegModalForSale(saleId, sale.customer_id, sale);
}

// Open keg modal for a specific sale — load sale data first
function returnSale(saleId) {
  fetch('/sale/' + saleId, { cache: 'no-store' })
    .then(function(res) { return safeJson(res); })
    .then(function(data) {
      if (!data) { showToast('Không tìm thấy đơn', 'error'); return; }
      var sale = data.sale || data;
      if (!sale) { showToast('Không tìm thấy đơn', 'error'); return; }
      openKegModalForSale(saleId, sale.customer_id, sale);
    })
    .catch(function() { showToast('Lỗi tải đơn', 'error'); });
}

// Open keg modal pre-filled with sale info — uses INVOICE data, not current customer state
// invoiceData should contain: deliver_kegs, return_kegs, keg_balance_after, customer_keg_balance
function openKegModalForSale(saleId, customerId, invoiceData) {
  var modal = document.getElementById('collectKegModal');
  if (!modal) return;

  kegEditSaleId = saleId;
  saleState.customerId = customerId ? Number(customerId) : null;
  kegSubmitting = false;

  // Extract values from invoice data
  var deliverKegs = invoiceData?.deliver_kegs ?? 0;
  var returnKegs = invoiceData?.return_kegs ?? 0;
  var kegBalanceAfter = invoiceData?.keg_balance_after;
  var customerKegBalance = invoiceData?.customer_keg_balance;

  // Calculate bottleBefore: tồn kho của khách trước khi đơn này tạo
  // Formula: bottleBefore = keg_balance_after - deliver + return
  // If keg_balance_after exists, use it; otherwise calculate from customer balance
  var bottleBefore = null;
  if (kegBalanceAfter != null && kegBalanceAfter !== undefined && !isNaN(kegBalanceAfter)) {
    bottleBefore = kegBalanceAfter - deliverKegs + returnKegs;
  } else if (customerKegBalance != null && customerKegBalance !== undefined && !isNaN(customerKegBalance)) {
    // Fallback: customer_keg_balance is current balance, subtract the invoice's effect
    // customerBalanceAfterInvoice = customerKegBalance
    // invoiceEffect = +deliver - return
    // So: customerBalanceBeforeInvoice = customerKegBalance - deliver + return
    bottleBefore = customerKegBalance - deliverKegs + returnKegs;
  }

  // Store original invoice values for reference
  window._kegEditSale = {
    saleId: saleId,
    customerId: customerId,
    oldDelivered: deliverKegs,
    oldReturned: returnKegs,
    invoiceBefore: bottleBefore,
    invoiceAfter: kegBalanceAfter
  };

  var customer = customerId ? getCustomer(customerId) : null;
  var customerName = customer ? customer.name : 'Chưa chọn';

  // Hiển thị thông tin: Tồn trước, Giao, Thu, Tồn sau
  var info = document.getElementById('collectKegInfo');
  if (info) {
    var beforeText = bottleBefore !== null ? bottleBefore : (customerKegBalance ?? '?');
    info.innerHTML = '<div style="font-size:13px;">👤 ' + escHtml(customerName) + ' | Tồn trước: <b>' + beforeText + '</b></div>';
  }

  // Current balance = bottleBefore (tồn trước của đơn)
  var currentBalance = bottleBefore !== null ? bottleBefore : (customer ? (customer.keg_balance || 0) : 0);

  var currentBalanceEl = document.getElementById('collectKegCurrentBalance');
  if (currentBalanceEl) currentBalanceEl.textContent = currentBalance;

  // Reset inputs với giá trị HIỆN TẠI của invoice
  var deliverEl = document.getElementById('collectKegDeliver');
  var returnEl = document.getElementById('collectKegReturn');
  if (deliverEl) deliverEl.value = String(deliverKegs);
  if (returnEl) returnEl.value = String(returnKegs);

  updateCollectKegPreview();
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

// Submit keg update for a sale
function submitCollectKegForSale(saleId) {
  if (kegSubmitting) return;
  kegSubmitting = true;

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
  var body = { saleId: saleId, customerId: customerId, deliver: deliver, returned: returned };
  fetch('/api/sales/update-kegs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(function(res) { return safeJson(res); })
  .then(function(data) {
    if (!data) { showToast('Lỗi kết nối', 'error'); return; }
    if (data.success) {
      showToast('Đã cập nhật vỏ', 'success');
      closeCollectKegModal();
      loadSaleHistory();
      // Reload invoice to show updated keg values
      var ctx = window._invoiceContext;
      if (ctx) {
        console.log('[submitCollectKegForSale] Reloading invoice for saleId:', ctx.saleId);
        fetch('/sale/' + ctx.saleId, { cache: 'no-store' })
          .then(function(res) { return safeJson(res); })
          .then(function(respData) {
            console.log('[submitCollectKegForSale] /sale response:', respData);
            var sale = respData ? extractSaleFromResponse(respData) : null;
            console.log('[submitCollectKegForSale] extracted sale:', sale);
            if (sale) {
              var inv = normalizeInvoice(sale);
              console.log('[submitCollectKegForSale] normalized invoice:', inv);
              if (inv) {
                window._invoiceContext = { saleId: ctx.saleId, rawSale: sale };
                renderInvoiceModalContent(inv, ctx.saleId);
                console.log('[submitCollectKegForSale] invoice re-rendered');
              }
            }
          })
          .catch(function(err) {
            console.error('[submitCollectKegForSale] reload error:', err);
          });
      }
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'kegs' } }));
    } else {
      showToast(data.error || 'Lỗi cập nhật vỏ', 'error');
    }
  })
  .catch(function(err) {
    console.error('submitCollectKegForSale error:', err);
    showToast('Lỗi kết nối', 'error');
  })
  .finally(function() {
    kegSubmitting = false;
  });
}

// Delete sale
function deleteSale(saleId) {
  if (!confirm('Xóa đơn #' + saleId + '? Hành động này không thể hoàn tác.')) return;
  console.log('[deleteSale] sending DELETE /api/sales/' + saleId);
  fetch('/api/sales/' + saleId, { method: 'DELETE' })
    .then(function(res) {
      console.log('[deleteSale] status:', res.status);
      return safeJson(res);
    })
    .then(function(data) {
      console.log('[deleteSale] response:', JSON.stringify(data));
      if (!data) { showToast('Lỗi kết nối', 'error'); return; }
      if (data.success) {
        showToast('Đã xóa đơn', 'success');
        window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
        window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'product' } }));
      } else {
        showToast(data.error || 'Lỗi xóa đơn', 'error');
      }
    })
    .catch(function(err) { console.error('[deleteSale] fetch error:', err); showToast('Lỗi kết nối', 'error'); });
}

function openEditSale(saleId) {
  editingSaleId = saleId;

  fetch('/sale/' + saleId, { cache: 'no-store' })
    .then(function(res) { return safeJson(res); })
    .then(function(data) {
      if (!data) { showToast('Lỗi tải đơn', 'error'); return; }
      var sale = data.sale || data;
      if (!sale) { showToast('Không tìm thấy đơn', 'error'); return; }
      if (sale.status === 'returned') {
        showToast('Đơn đã trả hàng, không thể sửa', 'error');
        return;
      }

      saleState.customerId = sale.customer_id ? Number(sale.customer_id) : null;
      var saleItems = sale.items || [];
      saleState.items = saleItems.map(function(item) {
        return {
          productId: Number(item.product_id),
          qty: item.quantity || 0,
          price: item.price || 0
        };
      });

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

      var sheet = document.getElementById('saleEditAuxSheet');
      if (sheet) sheet.classList.remove('hidden');
      var editText = document.getElementById('saleEditAuxText');
      if (editText) editText.textContent = '✏️ Đang chỉnh sửa đơn #' + editingSaleId;

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
    container.innerHTML = '<div class="sale-product-card" style="text-align:center;color:var(--text-muted);padding:24px;">Chưa có sản phẩm nào</div>';
    return;
  }

  container.innerHTML = products.map(function(p) {
    // Check if this product has a saved price in saleState (e.g. from editing a sale)
    var savedItem = saleState.items.find(function(i) { return i.productId === p.id; });
    var defaultPrice = p.sell_price || 0;
    var effectivePrice = getEffectivePrice(p);

    // Priority: saved price from saleState > customer-specific price > default sell_price
    var price = savedItem ? savedItem.price : effectivePrice;
    var isCustomPrice = price !== defaultPrice;
    var priceClass = isCustomPrice ? 'sale-product-price sale-price-edited' : 'sale-product-price';
    var isLowStock = p.stock < _LOW_STOCK_THRESHOLD;
    var stockClass = isLowStock ? 'sale-product-meta low-stock' : 'sale-product-meta';
    var qty = savedItem ? savedItem.qty : '';

    return '<div class="sale-product-card">' +
      '<div class="sale-product-top">' +
        '<div class="sale-product-name">' + escHtml(p.name) + '</div>' +
        '<input type="number" min="0" value="' + price + '"' +
          ' id="price-' + p.id + '"' +
          ' class="' + priceClass + '"' +
          ' data-default="' + defaultPrice + '"' +
          ' placeholder="' + formatVND(defaultPrice) + '"' +
          ' oninput="onPriceChange(' + p.id + ', this.value)"' +
          ' onfocus="onPriceFocus(' + p.id + ')"' +
        '>' +
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
// PRICE CHANGE
// ============================================================
function onPriceChange(productId, value) {
  var price = parseInt(value) || 0;
  var product = getProduct(productId);
  if (!product) return;

  var priceInput = document.getElementById('price-' + productId);
  var defaultPrice = product.sell_price || 0;

  // Update visual feedback
  if (priceInput) {
    if (price !== defaultPrice) {
      priceInput.classList.add('sale-price-edited');
    } else {
      priceInput.classList.remove('sale-price-edited');
    }
  }

  // Update saleState
  var existing = saleState.items.find(function(i) { return i.productId === productId; });
  if (existing) {
    existing.price = price;
  }

  updateTotal();
}

function onPriceFocus(productId) {
  var input = document.getElementById('price-' + productId);
  if (input) setTimeout(function() { input.select(); }, 0);
}

// ============================================================
// QTY CHANGE
// ============================================================
function onQtyChange(productId, value) {
  var qty = parseInt(value) || 0;
  var product = getProduct(productId);
  if (!product) return;

  // Get current price from input (may have been edited)
  var priceInput = document.getElementById('price-' + productId);
  var price = 0;
  if (priceInput) {
    price = parseInt(priceInput.value) || 0;
  }
  // Fallback to effective price if no custom price set
  if (price === 0) {
    price = getEffectivePrice(product);
  }

  if (qty <= 0) {
    saleState.items = saleState.items.filter(function(i) { return i.productId !== productId; });
      } else {
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
    dropdown.innerHTML = '<div class="customer-dd-item" style="color:var(--text-muted);cursor:default;">Không tìm thấy</div>';
  } else {
    dropdown.innerHTML = list.map(function(c) {
      return '<div class="customer-dd-item" onclick="selectCustomer(\'' + c.id + '\', \'' + escAttr(c.name || '') + '\')">' +
        '<span style="font-weight:600;">' + escHtml(c.name || 'Khách') + '</span>' +
        '<span style="font-size:12px;color:var(--text-muted);margin-left:8px;">' + escHtml(c.phone || '') + '</span>' +
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
    sellBtn.disabled = !hasItems;
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
  document.body.classList.add('modal-open');
}

function closeCheckoutModal() {
  var modal = document.getElementById('checkoutModal');
  if (modal) modal.classList.add('hidden');
  document.body.classList.remove('modal-open');
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

  var url = isEditing ? '/api/sales/' + editingSaleId : '/api/sales';
  var method = isEditing ? 'PUT' : 'POST';

  fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(function(res) { return safeJson(res); })
  .then(function(data) {
    // ── Handle offline / non-JSON gracefully ──────────────────────
    if (!data || data._offline) {
      showToast('Mất mạng — đơn đã lưu tạm, sẽ đồng bộ khi có mạng', 'warning');
      resetSaleState();
      if (btn) { btn.disabled = false; btn.innerHTML = isEditing ? '💾 Cập nhật đơn' : '✅ BÁN HÀNG'; }
      return;
    }
    if (data.success) {
      console.log('[submitSale] success, data:', JSON.stringify(data));
      showToast(isEditing ? 'Cập nhật thành công!' : 'Bán hàng thành công!', 'success');
      var invoiceSaleId = isEditing ? editingSaleId : (data.id != null ? Number(data.id) : null);
      console.log('[submitSale] invoiceSaleId:', invoiceSaleId);
      editingSaleId = null;
      resetSaleState();
      // Notify both sale and inventory listeners
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'inventory' } }));
      console.log('[submitSale] calling openInvoiceModal with', invoiceSaleId);
      if (invoiceSaleId && typeof openInvoiceModal === 'function') {
        openInvoiceModal(invoiceSaleId);
      } else {
        console.warn('[submitSale] skip openInvoiceModal — saleId:', invoiceSaleId, 'fn:', typeof openInvoiceModal);
      }
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
  document.body.classList.add('modal-open');
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
    .then(function(res) { return safeJson(res); })
    .then(function(allProducts) {
      if (!allProducts) { productSelect.innerHTML = '<option value="">Lỗi tải</option>'; return; }
      var list = allProducts || [];
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
  .then(function(res) { return safeJson(res); })
  .then(function(data) {
    if (!data) { showToast('Lỗi kết nối', 'error'); return; }
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
  document.body.classList.remove('modal-open');
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
  document.body.classList.add('modal-open');
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
    newBalanceEl.style.color = newBalance < 0 ? 'var(--red)' : 'var(--green)';
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
  .then(function(res) { return safeJson(res); })
  .then(function(data) {
    if (!data) { showToast('Lỗi kết nối', 'error'); return; }
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
  document.body.classList.remove('modal-open');
}

// ============================================================
// COLLECT KEG MODAL
// ============================================================
function openCollectKegModal() {
  var modal = document.getElementById('collectKegModal');
  if (!modal) return;
  kegEditSaleId = null;
  window._kegEditSale = null; // Clear invoice edit context
  kegSubmitting = false;

  var info = document.getElementById('collectKegInfo');
  var deliverEl = document.getElementById('collectKegDeliver');
  var returnEl = document.getElementById('collectKegReturn');

  if (deliverEl) deliverEl.value = '0';
  if (returnEl) returnEl.value = '0';

  var customerName = saleState.customerId ? (getCustomer(saleState.customerId)?.name || 'Khách') : 'Chưa chọn';
  var balance = saleState.customerId ? (getCustomer(saleState.customerId)?.keg_balance || 0) : 0;

  if (info) {
    info.innerHTML = '<div style="font-size:13px;">👤 ' + escHtml(customerName) + ' | Tồn hiện tại: <b>' + balance + '</b></div>';
    info.dataset.balance = balance;
  }

  var currentBalanceEl = document.getElementById('collectKegCurrentBalance');
  if (currentBalanceEl) currentBalanceEl.textContent = balance;

  updateCollectKegPreview();
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function updateCollectKegPreview() {
  var deliver = parseInt(document.getElementById('collectKegDeliver')?.value) || 0;
  var returned = parseInt(document.getElementById('collectKegReturn')?.value) || 0;
  var info = document.getElementById('collectKegInfo');

  // Ưu tiên dùng invoice data (từ _kegEditSale), không dùng customer hiện tại
  var currentBalance = 0;
  var invoiceBefore = null;

  if (window._kegEditSale) {
    // Đang edit từ invoice - dùng tồn trước của invoice
    invoiceBefore = window._kegEditSale.invoiceBefore;
    currentBalance = invoiceBefore !== null ? invoiceBefore : 0;
  } else {
    // Modal thường - dùng customer hiện tại
    currentBalance = parseInt(info?.dataset?.balance) || 0;
  }

  var remaining = currentBalance + deliver - returned;

  var deliverPreview = document.getElementById('collectKegDeliverPreview');
  var returnPreview = document.getElementById('collectKegReturnPreview');
  var remainingEl = document.getElementById('collectKegRemaining');
  var warningEl = document.getElementById('collectKegWarning');

  if (deliverPreview) deliverPreview.textContent = '+' + deliver;
  if (returnPreview) returnPreview.textContent = '-' + returned;
  if (remainingEl) {
    remainingEl.textContent = remaining;
    remainingEl.style.color = remaining < 0 ? 'var(--red)' : 'var(--green)';
  }
  if (warningEl) {
    warningEl.classList.toggle('hidden', remaining >= 0);
    if (remaining < 0) warningEl.textContent = '⚠️ Số vỏ thu vượt quá khách đang giữ';
  }
}

function submitCollectKeg() {
  if (kegSubmitting) return;
  kegSubmitting = true;

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

  if (kegEditSaleId != null) {
    fetch('/api/sales/update-kegs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        saleId: kegEditSaleId,
        customerId: customerId,
        deliver: deliver,
        returned: returned
      })
    })
    .then(function(res) { return safeJson(res); })
    .then(function(data) {
      if (!data) { showToast('Lỗi kết nối', 'error'); return; }
      if (data.success) {
        showToast('Đã cập nhật vỏ', 'success');
        closeCollectKegModal();
        loadSaleHistory();
        var ctx = window._invoiceContext;
        if (ctx) {
          fetch('/sale/' + ctx.saleId, { cache: 'no-store' })
            .then(function(res) { return safeJson(res); })
            .then(function(respData) {
              var sale = respData ? extractSaleFromResponse(respData) : null;
              if (sale) {
                var inv = normalizeInvoice(sale);
                if (inv) {
                  window._invoiceContext = { saleId: ctx.saleId, rawSale: sale };
                  renderInvoiceModalContent(inv, ctx.saleId);
                }
              }
            });
        }
        window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'kegs' } }));
      } else {
        showToast(data.error || 'Lỗi cập nhật vỏ', 'error');
      }
    })
    .catch(function(err) {
      console.error('submitCollectKeg error:', err);
      showToast('Lỗi kết nối', 'error');
    })
    .finally(function() { kegSubmitting = false; });
    return;
  }

  // Standalone mode — use /api/kegs/collect and /api/kegs/deliver
  var standaloneDone = false;
  function finishStandalone() {
    if (standaloneDone) return;
    standaloneDone = true;
    closeCollectKegModal();
    loadSaleHistory();
    window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'kegs' } }));
  }

  if (deliver > 0) {
    fetch('/api/kegs/deliver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: customerId, quantity: deliver })
    })
    .then(function(res) { return safeJson(res); })
    .then(function(data) {
      if (!data || !data.success) showToast((data && data.error) || 'Lỗi giao vỏ', 'error');
    })
    .catch(function() { showToast('Lỗi kết nối', 'error'); });
  }

  if (returned > 0) {
    fetch('/api/kegs/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: customerId, quantity: returned })
    })
    .then(function(res) { return safeJson(res); })
    .then(function(data) {
      if (!data) { showToast('Lỗi kết nối', 'error'); return; }
      if (data.success) {
        showToast('Đã thu vỏ', 'success');
        finishStandalone();
      } else {
        showToast(data.error || 'Lỗi thu vỏ', 'error');
      }
    })
    .catch(function(err) {
      console.error('submitCollectKeg error:', err);
      showToast('Lỗi kết nối', 'error');
    });
  } else if (deliver > 0) {
    // If only deliver (no return), close after short delay
    setTimeout(function() { finishStandalone(); }, 500);
  }

  kegSubmitting = false;
}

function closeCollectKegModal() {
  var modal = document.getElementById('collectKegModal');
  if (modal) modal.classList.add('hidden');
  kegEditSaleId = null;
  window._kegEditSale = null; // Clear invoice edit context
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
// INVOICE — close (open/render live above with openInvoiceModal)
// ============================================================
function closeInvoice() {
  var overlay = document.getElementById('invoiceModal');
  if (!overlay) return;
  overlay.classList.add('hidden');
  overlay.style.pointerEvents = 'none';
  document.body.classList.remove('modal-open');
  window._invoiceContext = null;
}

window.closeInvoice = closeInvoice;
window.openInvoiceModal = openInvoiceModal;
window.viewSale = viewSale;

// Auto-scale invoice modal on window resize
window.addEventListener('resize', function() {
  var overlay = document.getElementById('invoiceModal');
  if (overlay && !overlay.classList.contains('hidden')) {
    autoScaleInvoiceModal();
  }
});

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
