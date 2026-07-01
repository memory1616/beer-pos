// Sales Page JavaScript — Card-Based POS v2
// Single column layout: customer search → product cards → total/checkout

// ============================================================
// SAFE JSON — never crash on non-JSON / offline responses
// ============================================================
async function safeJson(res) {
  if (!res || !res.ok) {
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

// ============================================================
// CURRENCY HELPERS
// ============================================================

/**
 * Format number → "1.000.000"
 */
function _fmt(n) {
  if (n == null || isNaN(n)) return '0';
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(n);
}

function formatVND(n) {
  if (n == null || isNaN(n)) return '0đ';
  return _fmt(n) + 'đ';
}

// ============================================================
// INPUT HANDLERS (gắn vào paymentAmount input)
// ============================================================


/**
 * Gọi trong onChange của input.
 * - Strip dots → parse number
 * - Auto-format hiển thị
 */
// Expose helpers for HTML oninput
window._fmt = _fmt;

let saleState = {
  customerId: null,
  items: [],  // [{productId, qty, price}]
  newShopEligible: false,
  newShopCreatedDay: null,
  promotionEnabled: true,
  promoSettings: null,  // Cài đặt khuyến mãi từ server
  isInNewShopPeriod: false,  // Khách đang trong thời gian quán mới
  canReceiveReward: false,  // Có thể nhận thưởng tháng
  qrConfig: null,  // Cài đặt QR fallback từ server
  qrAccountsCache: [],  // Danh sách QR account active
  currentInvoiceQR: null  // QR đang chọn cho hoá đơn hiện tại
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

// Refresh QR pool khi user quay lại tab (admin vừa đổi QR ở tab khác)
document.addEventListener('visibilitychange', function() {
  if (!document.hidden && saleState.qrAccountsCache) {
    loadQRAccountsForInvoice().catch(function() {});
  }
});

function initSalesPage(data) {
  products = data.products || [];
  customers = (data.customers || []).sort(function(a, b) {
    return (a.name || '').localeCompare(b.name || '', 'vi');
  });
  priceMap = data.priceMap || {};

  // Load promotion settings từ server
  loadPromoSettings();

  // Load QR config từ server
  loadQRConfig();

  // Close dropdown when clicking outside the customer search area
  // Guarded by a flag to prevent duplicate listeners if initSalesPage is re-called
  if (!window._salesOutsideClickBound) {
    window._salesOutsideClickBound = true;
    document.addEventListener('click', function(e) {
      var search = document.getElementById('customerSearch');
      var dropdown = document.getElementById('customerDropdown');
      if (!search || !dropdown) return;
      var searchBox = search.closest('.sale-section-customer');
      if (searchBox && searchBox.contains(e.target)) return;
      if (e.target === search) return;
      showCustomerDropdown(false);
    });
  }

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
    }
  } catch (e) {
    console.error('[SALES] reloadSaleProducts error:', e);
  }
}

// Load promotion settings từ server
async function loadPromoSettings() {
  try {
    const res = await fetch('/api/promotions/settings');
    if (!res.ok) return null;
    const data = await res.json();
    if (data.success) {
      saleState.promoSettings = data.data;
      return data.data;
    }
  } catch (err) {
    // silent
  }
  return null;
}

// Load QR config từ server
async function loadQRConfig() {
  try {
    const res = await fetch('/api/settings/qr-config', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (data) {
      saleState.qrConfig = data;
      return data;
    }
  } catch (err) {
    // silent
  }
  return null;
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
  // Also add event listener as backup
  sel.addEventListener('change', function(e) {
    onSaleHistoryMonthChange(e.target.value);
  });
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

    // Format date with sale_time if available
    var dateStr = '';
    if (s.date) {
      var dateParts = s.date.split('-');
      if (s.sale_time) {
        // Use sale_time for accurate time
        var timeParts = s.sale_time.split(':');
        var d = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]),
                         parseInt(timeParts[0]), parseInt(timeParts[1]), 0);
      } else {
        var d = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]), 7, 0, 0);
      }
      dateStr = d.toLocaleString('vi-VN', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    }
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

    return '<div class="sale-history-item" onclick="viewSale(' + s.id + ')">' +
      '<div class="sale-history-top">' +
        '<div class="sale-history-customer">' + escHtml(customerName) + typeLabel + '</div>' +
        '<div class="sale-history-total">' + totalStr + '</div>' +
      '</div>' +
      '<div class="sale-history-meta">#' + s.id + ' · ' + dateStr + '</div>' +
      '<div class="sale-history-items">' + escHtml(itemNames) + '</div>' +
      kegsInfo +
      '<div class="sale-history-actions">' +
        '<button class="action-view" onclick="viewInvoice(' + s.id + '); event.stopPropagation();">👁 Xem</button>' +
        '<button class="action-return" onclick="returnSale(' + s.id + '); event.stopPropagation();">📦 Trả</button>' +
        '<button class="action-edit" onclick="openEditSale(' + s.id + '); event.stopPropagation();"' + (isReturned ? ' disabled' : '') + '>✏️ Sửa</button>' +
        '<button class="action-delete" onclick="deleteSale(' + s.id + '); event.stopPropagation();">🗑 Xóa</button>' +
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
    sale_time: sale.sale_time || null,
    status: sale.status,
    type: sale.type,
    promo_type: sale.promo_type || null,
    reward_liters_used: sale.reward_liters_used || 0,
    promo_free_liters: sale.promo_free_liters || 0,
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

  var bankCode, accountNo, accountName, template, defaultContent;

  if (saleState.currentInvoiceQR) {
    // Dùng QR đang chọn cho hoá đơn này
    var qr = saleState.currentInvoiceQR;
    bankCode = qr.bank_code;
    accountNo = qr.account_no;
    accountName = qr.account_name;
    template = qr.template || 'compact2';
    defaultContent = qr.default_content || 'Thanh toan HD {invoice_id}';
  } else {
    // Fallback về cài đặt QR cũ
    var config = saleState.qrConfig || {};
    bankCode = config.qrBankCode || 'ICB';
    accountNo = config.qrAccountNo || '107875230331';
    accountName = config.qrAccountName || 'NGUYEN MINH QUAN';
    template = config.qrTemplate || 'compact2';
    defaultContent = config.qrDefaultContent || 'Thanh toan HD {invoice_id}';
  }

  // Xử lý nội dung: thay {invoice_id} bằng số hóa đơn
  var content = defaultContent.replace(/\{invoice_id\}/gi, invoiceId);

  var encodedContent = encodeURIComponent(content);
  var encodedName = encodeURIComponent(accountName.toUpperCase());

  return 'https://img.vietqr.io/image/' + bankCode.toUpperCase() + '-' + accountNo + '-' + template + '.png?amount=' +
    amount + '&addInfo=' + encodedContent + '&accountName=' + encodedName;
}

/**
 * Load danh sách QR account active từ server (cache)
 */
async function loadQRAccountsForInvoice() {
  try {
    var res = await fetch('/api/settings/qr-accounts/active', { cache: 'no-store' });
    if (!res.ok) {
      saleState.qrAccountsCache = [];
      return [];
    }
    var data = await res.json();
    saleState.qrAccountsCache = Array.isArray(data) ? data : [];
    return saleState.qrAccountsCache;
  } catch (err) {
    saleState.qrAccountsCache = [];
    return [];
  }
}

/**
 * Fill dropdown chọn QR trong modal hoá đơn
 */
function populateInvoiceQRSelect() {
  var select = document.getElementById('invQRSelect');
  if (!select) return;

  var list = saleState.qrAccountsCache || [];
  if (list.length === 0) {
    select.style.display = 'none';
    select.innerHTML = '';
    return;
  }

  var html = '';
  list.forEach(function(qr) {
    var label = qr.label + ' — ' + qr.bank_code + ' ' + qr.account_no;
    html += '<option value="' + qr.id + '">' + escHtml(label) + '</option>';
  });
  select.innerHTML = html;
  select.style.display = '';
  // Reset selection to first
  select.value = String(list[0].id);
  saleState.currentInvoiceQR = list[0];
}

/**
 * Handler khi user đổi QR trong dropdown
 */
function onInvoiceQRChange(qrId) {
  var id = parseInt(qrId);
  var list = saleState.qrAccountsCache || [];
  var qr = list.find(function(q) { return q.id === id; });
  if (!qr) {
    saleState.currentInvoiceQR = null;
    return;
  }
  saleState.currentInvoiceQR = qr;
  // Re-render QR image
  var invImg = document.getElementById('vietqrImage');
  if (invImg) {
    var modal = document.getElementById('invPosModal');
    var invoice = modal && modal._currentInvoice ? modal._currentInvoice : null;
    if (invoice) {
      invImg.src = generateVietQR(invoice);
      invImg.style.display = '';
    }
  }
}

function renderInvoiceModalContent(invoice, saleIdForActions) {
  var orderEl = document.getElementById('invOrderId');
  var metaEl = document.getElementById('invCustomerMeta');
  var itemsList = document.getElementById('invItemsList');
  var invActions = document.getElementById('invActions');
  var vietqrBlock = document.getElementById('vietqrBlock');
  if (!itemsList) { return; }
  if (!orderEl) orderEl = document.getElementById('invOrderId');
  if (!invActions) invActions = document.getElementById('invActions');

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
    var parts = invoice.date.split('-');
    if (invoice.sale_time) {
      // Use sale_time for accurate time
      var timeParts = invoice.sale_time.split(':');
      var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]),
                       parseInt(timeParts[0]), parseInt(timeParts[1]), 0);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(invoice.date)) {
      // Legacy: date-only string → assume noon to avoid UTC offset issue
      var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
    } else {
      var d = new Date(invoice.date);
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
    var isFree = item.price === 0 || item.price === null || item.price === undefined;
    var nameHtml = isFree
      ? '<div class="invoice-item-name" style="color:#f97316;">🎁 ' + escHtml(shortName) + ' <small style="color:#f97316;font-size:10px;">TẶNG</small></div>'
      : '<div class="invoice-item-name">' + escHtml(shortName) + '</div>';
    return '<div class="invoice-item">' +
      '<div class="invoice-item-left">' +
        nameHtml +
        (isUltra ? '' : '<small>x' + item.quantity + ' · ' + (isFree ? '<span style="color:#f97316;">Miễn phí</span>' : formatVND(item.price)) + '</small>') +
      '</div>' +
      '<div class="invoice-item-total">' + (isUltra ? item.quantity + ' × ' : '') + (isFree ? '<span style="color:#f97316;">Miễn phí</span>' : formatVND(lineTotal)) + '</div>' +
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

  // Volume promotion note (async - fetch from API then update)
  var promoNoteEl = document.getElementById('invPromoNote');
  if (promoNoteEl) {
    promoNoteEl.innerHTML = ''; // Clear first
    // Async update after modal is shown
    buildVolumePromoNote(invoice).then(function(html) {
      if (html && promoNoteEl) {
        promoNoteEl.innerHTML = html;
      }
    });
  }

  var totalDisplay = invoice.totalAmount;
  if (!Number.isFinite(totalDisplay) || totalDisplay == null) {
    totalDisplay = (invoice.items || []).reduce(function(sum, it) { return sum + (it.quantity || 0) * (it.price || 0); }, 0);
  }
  if (invTotalValue) invTotalValue.textContent = formatVND(totalDisplay);

  // QR — reset selection về QR đầu tiên (nếu có pool)
  saleState.currentInvoiceQR = null;
  if (saleState.qrAccountsCache && saleState.qrAccountsCache.length > 0) {
    saleState.currentInvoiceQR = saleState.qrAccountsCache[0];
  }
  populateInvoiceQRSelect();
  // Lưu invoice hiện tại lên modal để onInvoiceQRChange dùng
  var modal = document.getElementById('invPosModal');
  if (modal) modal._currentInvoice = invoice;

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
async function openInvoiceModal(source) {
  // Load QR accounts (nếu cache rỗng, ví dụ tab mới mở)
  if (!saleState.qrAccountsCache || saleState.qrAccountsCache.length === 0) {
    try { await loadQRAccountsForInvoice(); } catch (e) {}
  }

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

  try {
    var res = await fetch('/sale/' + saleId, { cache: 'no-store' });
    var data = await safeJson(res);
    if (!data) {
      showToast('Không tìm thấy đơn', 'error');
      window._invoiceContext = null;
      renderInvoiceModalContent(null, null);
      showInvoiceModalElement();
      return;
    }
    var sale = extractSaleFromResponse(data);
    if (!sale) {
      showToast('Không tìm thấy đơn', 'error');
      window._invoiceContext = null;
      renderInvoiceModalContent(null, null);
      showInvoiceModalElement();
      return;
    }
    var invoice = normalizeInvoice(sale);
    window._invoiceContext = invoice ? { saleId: saleId, rawSale: sale } : null;
    renderInvoiceModalContent(invoice, saleId);
    showInvoiceModalElement();
  } catch (err) {
    window._invoiceContext = null;
    renderInvoiceModalContent(null, null);
    showInvoiceModalElement();
    showToast('Lỗi tải đơn', 'error');
  }
}

function viewSale(saleId) {
  openInvoiceModal(saleId);
}

function viewInvoice(saleId) {
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
  saleState.newShopEligible = false;
  saleState.newShopCreatedDay = null;
  hideNewShopBadge();
  hidePromoPreview();
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
          })
          .catch(function(err) {
            // Silent fail
          });
      }
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'kegs' } }));
    } else {
      showToast(data.error || 'Lỗi cập nhật vỏ', 'error');
    }
  })
  .catch(function(err) {
    showToast('Lỗi kết nối', 'error');
  })
  .finally(function() {
    kegSubmitting = false;
  });
}

// Delete sale
function deleteSale(saleId) {
  if (!confirm('Xóa đơn #' + saleId + '? Hành động này không thể hoàn tác.')) return;
  fetch('/api/sales/' + saleId, { method: 'DELETE' })
    .then(function(res) { return safeJson(res); })
    .then(function(data) {
      if (!data) { showToast('Lỗi kết nối', 'error'); return; }
      if (data.success) {
        showToast('Đã xóa đơn', 'success');
        window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
        window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'product' } }));
      } else {
        showToast(data.error || 'Lỗi xóa đơn', 'error');
      }
    })
    .catch(function(err) { showToast('Lỗi kết nối', 'error'); });
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
      saleState.newShopEligible = false;
      saleState.newShopCreatedDay = null;
      hideNewShopBadge();
      hidePromoPreview();

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
        checkNewShopPromo(saleState.customerId);
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

  // Cập nhật preview khuyến mãi quán mới
  if (typeof updatePromoPreview === 'function') updatePromoPreview();
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

function isNewShopCustomer(customer) {
  return getNewShopCreatedDay(customer) !== null;
}

function getNewShopCreatedDay(customer) {
  if (!customer.created_at) return null;
  var created = new Date(customer.created_at);
  var now = new Date();
  var isSameMonth = created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear();
  var isDay09Plus = created.getDate() >= 9;
  return (isSameMonth && isDay09Plus) ? created.getDate() : null;
}

function renderCustomerDropdown(list) {
  var dropdown = document.getElementById('customerDropdown');
  if (!dropdown) return;

  if (list.length === 0) {
    dropdown.innerHTML = '<div class="customer-dd-item" style="color:var(--text-muted);cursor:default;">Không tìm thấy</div>';
  } else {
    dropdown.innerHTML = list.map(function(c) {
      var createdDay = getNewShopCreatedDay(c);
      var badge = createdDay
        ? '<span style="background:#ffedd5;color:#c2410c;font-size:11px;font-weight:700;padding:1px 6px;border-radius:10px;margin-left:6px;white-space:nowrap;">🔥 Quán mới ngày ' + createdDay + '</span>'
        : '';
      return '<div class="customer-dd-item" onclick="selectCustomer(\'' + c.id + '\', \'' + escAttr(c.name || '') + '\')">' +
        '<span style="font-weight:600;">' + escHtml(c.name || 'Khách') + '</span>' +
        badge +
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

  // Reset promo state immediately (trước async API response)
  saleState.newShopEligible = false;
  saleState.newShopCreatedDay = null;
  saleState.promotionEnabled = true;
  hideNewShopBadge();
  hidePromoPreview();
  hidePromoDisabledBadge();

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

  // ── Check new shop eligibility ────────────────────────────
  if (saleState.customerId) {
    checkNewShopPromo(saleState.customerId);
    checkMonthlyReward(saleState.customerId);
  }

  // Fire onCustomerSelected hook
  if (typeof onCustomerSelected === 'function') onCustomerSelected();
}

// ── NEW SHOP PROMOTION ──────────────────────────────────────
function checkNewShopPromo(customerId) {
  fetch('/api/promotions/new-shop/check/' + customerId, { cache: 'no-store' })
    .then(function(res) { return safeJson(res); })
    .then(function(data) {
      if (!data || !data.success) return;
      // Guard: bỏ qua nếu customer đã đổi sang quán khác
      if (String(saleState.customerId) !== String(customerId)) return;

      var info = data.data;
      saleState.newShopEligible = info.eligible;
      saleState.newShopCreatedDay = info.createdDay || null;

      if (info.eligible) {
        showNewShopBadge(info.createdDay);
        updatePromoPreview();
      } else {
        hideNewShopBadge();
        hidePromoPreview();

        // Kiểm tra trạng thái CTKM của khách
        var promoEnabled = info.promotionEnabled == 1;
        saleState.promotionEnabled = promoEnabled;
        if (promoEnabled) {
          hidePromoDisabledBadge();
        } else {
          showPromoDisabledBadge();
        }
      }
    })
    .catch(function() {});
}

// Kiểm tra thưởng tháng - chỉ hiển thị nếu KHÔNG đang trong thời gian quán mới
function checkMonthlyReward(customerId) {
  fetch('/api/promotions/customer/' + customerId + '/overview', { cache: 'no-store' })
    .then(function(res) { return safeJson(res); })
    .then(function(data) {
      if (!data || !data.success) return;
      if (String(saleState.customerId) !== String(customerId)) return;

      var overview = data.data;
      // Lưu trạng thái vào saleState
      saleState.isInNewShopPeriod = overview.isInNewShopPeriod;
      saleState.canReceiveReward = overview.canReceiveReward;

      // Hiển thị badge thưởng tháng nếu có thể nhận
      if (overview.monthlyReward && overview.monthlyReward.hasRemaining && overview.canReceiveReward) {
        showMonthlyRewardBadge(overview.monthlyReward);
      } else {
        hideMonthlyRewardBadge();
      }

      // Nếu đang trong thời gian quán mới, hiển thị thông báo
      if (overview.isInNewShopPeriod) {
        showNewShopActiveNotice(overview.newShop);
      } else {
        hideNewShopActiveNotice();
      }
    })
    .catch(function() {});
}

function showMonthlyRewardBadge(reward) {
  var el = document.getElementById('monthlyRewardBadge');
  if (el) {
    el.classList.remove('hidden');
    el.innerHTML = '<span style="font-size:14px;">&#127942;</span> Thưởng tháng: còn <b>' + reward.remainingReward + 'L</b> có thể nhận<br><span style="font-size:11px;color:#6b7280;">(thưởng sẽ được gắn vào đơn đầu tiên)</span>';
  }
}

function hideMonthlyRewardBadge() {
  var el = document.getElementById('monthlyRewardBadge');
  if (el) {
    el.classList.add('hidden');
    el.innerHTML = '';
  }
}

function showNewShopActiveNotice(newShop) {
  var el = document.getElementById('newShopActiveNotice');
  if (el && newShop) {
    el.classList.remove('hidden');
    el.innerHTML = '<span style="font-size:12px;">&#128293;</span> Khách đang trong thời gian quán mới (tạo ngày <b>' + newShop.createdDay + '</b>)<br><span style="font-size:11px;color:#6b7280;">(thưởng tháng sẽ được áp dụng sau khi hết thời gian quán mới)</span>';
  }
}

function hideNewShopActiveNotice() {
  var el = document.getElementById('newShopActiveNotice');
  if (el) {
    el.classList.add('hidden');
    el.innerHTML = '';
  }
}

function showPromoDisabledBadge() {
  var el = document.getElementById('promoDisabledBadge');
  if (el) {
    el.classList.remove('hidden');
  }
  // Xóa toàn bộ promotion khỏi giao diện
  hideNewShopBadge();
  hidePromoPreview();
  // Recalculate
  updateTotal();
}

function hidePromoDisabledBadge() {
  var el = document.getElementById('promoDisabledBadge');
  if (el) {
    el.classList.add('hidden');
  }
}

function showNewShopBadge(createdDay) {
  var badge = document.getElementById('newShopBadge');
  if (badge) {
    badge.classList.remove('hidden');
    badge.innerHTML = '<span style="font-size:14px;">🔥</span> Quán mới ngày <b>' + createdDay + '</b><br><span style="font-size:11px;color:#92400e;">Mua 10L vàng tặng 1L | Mua 20L đen tặng 1L</span>';
  }
}

function hideNewShopBadge() {
  var badge = document.getElementById('newShopBadge');
  if (badge) {
    badge.classList.add('hidden');
    badge.innerHTML = '';
  }
  hidePromoPreview();
}

function hidePromoPreview() {
  var el = document.getElementById('promoPreview');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
}

function updatePromoPreview() {
  if (!saleState.newShopEligible) { hidePromoPreview(); return; }

  // Calculate current quantities (CHỈ tính bia bình keg, KHÔNG tính pet/box)
  var qtyGold = 0;
  var qtyBlack = 0;
  for (var i = 0; i < saleState.items.length; i++) {
    var item = saleState.items[i];
    if (!item.qty || item.qty <= 0) continue;
    var product = getProduct(item.productId);
    if (!product) continue;
    if (product.type !== 'keg') continue; // bỏ qua pet/box
    var beerType = classifyBeerType(product.name);
    if (beerType === 'black') qtyBlack += item.qty;
    else qtyGold += item.qty;
  }

  if (qtyGold <= 0 && qtyBlack <= 0) { hidePromoPreview(); return; }

  // Lấy settings từ server, fallback về mặc định 10/20
  var goldBuy = saleState.promoSettings?.newShopGoldBuy || 10;
  var goldFree = saleState.promoSettings?.newShopGoldFree || 1;
  var blackBuy = saleState.promoSettings?.newShopBlackBuy || 20;
  var blackFree = saleState.promoSettings?.newShopBlackFree || 1;

  // Calculate free liters
  var freeGold = Math.floor(qtyGold / goldBuy) * goldFree;
  var freeBlack = Math.floor(qtyBlack / blackBuy) * blackFree;
  var totalFree = freeGold + freeBlack;
  if (totalFree <= 0) { hidePromoPreview(); return; }

  var lines = [];
  if (freeGold > 0) lines.push('Tặng <b>' + freeGold + 'L</b> bia vàng');
  if (freeBlack > 0) lines.push('Tặng <b>' + freeBlack + 'L</b> bia đen');

  var el = document.getElementById('promoPreview');
  if (el) {
    el.classList.remove('hidden');
    el.innerHTML = '🎁 Khuyến mãi quán mới: ' + lines.join(' | ');
  }
}

function classifyBeerType(productName) {
  if (!productName) return 'gold';
  var name = productName.toLowerCase();
  var blackKeywords = ['guinness', 'kilkenny', 'murphy', 'black', 'đen', 'smithwick'];
  for (var i = 0; i < blackKeywords.length; i++) {
    if (name.indexOf(blackKeywords[i]) !== -1) return 'black';
  }
  return 'gold';
}

function onCustomerSelected() {
  // Hook for future use
}

function buildPromoDetailHtml() {
  if (!saleState.newShopEligible) return '';

  var qtyGold = 0;
  var qtyBlack = 0;
  for (var i = 0; i < saleState.items.length; i++) {
    var item = saleState.items[i];
    if (!item.qty || item.qty <= 0) continue;
    var product = getProduct(item.productId);
    if (!product) continue;
    if (product.type !== 'keg') continue; // bỏ qua pet/box
    var beerType = classifyBeerType(product.name);
    if (beerType === 'black') qtyBlack += item.qty;
    else qtyGold += item.qty;
  }

  var freeGold = 0;
  var freeBlack = 0;

  // Lấy settings từ server, fallback về mặc định 10/20
  var goldBuy = saleState.promoSettings?.newShopGoldBuy || 10;
  var goldFree = saleState.promoSettings?.newShopGoldFree || 1;
  var blackBuy = saleState.promoSettings?.newShopBlackBuy || 20;
  var blackFree = saleState.promoSettings?.newShopBlackFree || 1;

  freeGold = Math.floor(qtyGold / goldBuy) * goldFree;
  freeBlack = Math.floor(qtyBlack / blackBuy) * blackFree;
  if (freeGold <= 0 && freeBlack <= 0) return '';

  var lines = [];
  if (freeGold > 0) lines.push('<div style="color:#f97316;font-size:13px;">🎁 Bia vàng — Tặng khuyến mãi: <b>+' + freeGold + 'L</b></div>');
  if (freeBlack > 0) lines.push('<div style="color:#f97316;font-size:13px;">🎁 Bia đen — Tặng khuyến mãi: <b>+' + freeBlack + 'L</b></div>');

  return '<div style="margin:8px 0;padding:8px;background:linear-gradient(135deg,rgba(249,115,22,0.1),rgba(234,179,8,0.1));border:1px solid rgba(249,115,22,0.3);border-radius:8px;">' +
    '<div style="font-size:11px;color:#f97316;font-weight:700;margin-bottom:4px;">🎁 KHUYẾN MÃI QUÁN MỚI</div>' +
    lines.join('') +
    '<div style="font-size:11px;color:#92400e;margin-top:4px;">Lít tặng KHÔNG tính vào doanh thu</div>' +
  '</div>';
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
    buildPromoDetailHtml() +
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
  .then(function(res) {
    return safeJson(res);
  })
  .then(function(data) {
    // ── Handle offline / non-JSON gracefully ──────────────────────
    if (!data || data._offline) {
      showToast('Mất mạng — đơn đã lưu tạm, sẽ đồng bộ khi có mạng', 'warning');
      resetSaleState();
      if (btn) { btn.disabled = false; btn.innerHTML = isEditing ? '💾 Cập nhật đơn' : '✅ BÁN HÀNG'; }
      return;
    }
    if (data.success) {
      var promoMsg = '';
      if (data.promo && data.promo.totalFree > 0) {
        var parts = [];
        if (data.promo.freeGold > 0) parts.push('+' + data.promo.freeGold + 'L vàng');
        if (data.promo.freeBlack > 0) parts.push('+' + data.promo.freeBlack + 'L đen');
        promoMsg = ' | 🎁 Tặng ' + parts.join(' ');
      }
      showToast((isEditing ? 'Cập nhật thành công!' : 'Bán hàng thành công!') + promoMsg, 'success');
      var invoiceSaleId = isEditing ? editingSaleId : (data.id != null ? Number(data.id) : null);
      editingSaleId = null;
      resetSaleState();
      // Notify both sale and inventory listeners
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'sale' } }));
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'inventory' } }));
      if (invoiceSaleId && typeof openInvoiceModal === 'function') {
        openInvoiceModal(invoiceSaleId);
      }
    } else {
      showToast(data.error || 'Lỗi khi bán hàng', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = isEditing ? '💾 Cập nhật đơn' : '✅ BÁN HÀNG'; }
    }
  })
  .catch(function(err) {
    showToast('Lỗi kết nối: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = isEditing ? '💾 Cập nhật đơn' : '✅ BÁN HÀNG'; }
  });
}

function resetSaleState() {
  saleState.items = [];
  saleState.customerId = null;
  saleState.newShopEligible = false;
  saleState.newShopCreatedDay = null;
  saleState.promotionEnabled = true;
  saleState.isInNewShopPeriod = false;
  saleState.canReceiveReward = false;
  editingSaleId = null;
  hideNewShopBadge();
  hidePromoPreview();
  hidePromoDisabledBadge();
  hideMonthlyRewardBadge();
  hideNewShopActiveNotice();
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

  var isGift = document.getElementById('giftKegs')?.checked || false;

  // Always load products when in gift mode, or when customer is selected
  if (!customerId && !isGift) {
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
  loadReplacementProducts();
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
window.viewInvoice = viewInvoice;

// Auto-scale invoice modal on window resize
window.addEventListener('resize', function() {
  var overlay = document.getElementById('invoiceModal');
  if (overlay && !overlay.classList.contains('hidden')) {
    autoScaleInvoiceModal();
  }
});

// ============================================================
// VOLUME PROMOTION NOTE (Invoice)
// ============================================================

/**
 * Check if promotion is within active period (client-side check)
 */
function isPromoPeriodActive() {
  var settings = saleState.promoSettings;
  if (!settings) return true; // No settings = always active
  
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  // Check start date
  if (settings.startDate) {
    var start = new Date(settings.startDate);
    if (today < start) return false;
  }
  
  // Check end date
  if (settings.endDate) {
    var end = new Date(settings.endDate);
    if (today > end) return false;
  }
  
  return true;
}

/**
 * Cache cho volume promo note - tránh gọi API nhiều lần
 */
var _volumePromoCache = {};
var _volumePromoCacheTime = 0;
var _volumePromoCacheTTL = 60000; // 1 phút

/**
 * Build promotion note for invoice display.
 * Only for customers enrolled in volume reward program, during active promotion period.
 * Only counts Chai Inox (kegs) volume.
 * Shows current tier achieved and next tier target.
 * NOTE: Completed customers only show on the day they achieve final tier.
 * NOTE: Customers in "new shop" period don't participate in volume reward.
 */
async function buildVolumePromoNote(invoice) {
  // Get customer ID from invoice
  var customerId = invoice && invoice.customer && invoice.customer.id;
  if (!customerId) return '';

  // Get customer from cache
  var customer = getCustomer(customerId);
  if (!customer) return '';

  // Check if customer has promotions disabled
  if (customer.promotion_enabled === 0) return '';

  // Get promotion settings from saleState
  var settings = saleState.promoSettings;
  if (!settings || !settings.rewardEnabled) return '';

  // Check if promotion period is active
  if (!isPromoPeriodActive()) return '';

  // Check if customer is eligible for monthly reward
  var customerRewardEnabled = customer.reward_enabled !== 0;
  if (!customerRewardEnabled) return '';

  // Fetch reward data from API if cache is empty or expired
  var now = Date.now();
  var cacheKey = 'customer_' + customerId;
  
  if (!_volumePromoCache[cacheKey] || (now - _volumePromoCacheTime) > _volumePromoCacheTTL) {
    try {
      var res = await fetch('/api/promotions/customer/' + customerId + '/overview', { cache: 'no-store' });
      var data = await safeJson(res);
      if (data && data.success && data.data) {
        _volumePromoCache[cacheKey] = data.data;
        _volumePromoCacheTime = now;
      }
    } catch (e) {
      console.error('[buildVolumePromoNote] fetch error:', e);
    }
  }

  var rewardData = _volumePromoCache[cacheKey];
  if (!rewardData) return '';

  // Check if customer is in new shop period - don't show volume reward if in new shop
  if (rewardData.isNewShopPromotion) return '';

  // Check if can receive reward
  if (!rewardData.isRewardEligible) return '';

  // Get reward data
  var monthlyReward = rewardData.monthlyReward;
  if (!monthlyReward) return '';

  // Check if this invoice has MONTHLY_BONUS (đơn trả thưởng) - hiển thị thông tin thưởng, không hiển thị tích lũy
  if (invoice.promo_type === 'MONTHLY_BONUS' || invoice.reward_liters_used > 0) {
    var rewardLiters = invoice.reward_liters_used || (invoice.promo_free_liters || 0);
    return '<div class="promo-note" style="margin:10px 0;padding:10px 12px;background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.3);border-radius:8px;font-size:11px;line-height:1.5;">' +
      '<div style="font-weight:700;color:#9333ea;margin-bottom:4px;">&#127942; Khuyến mãi Sản lượng Tháng</div>' +
      '<div style="color:#7e22ce;">&#127882; Đơn trả thưởng <strong>+' + rewardLiters + 'L</strong></div>' +
      '<div style="color:#6b21a8;margin-top:4px;">Đã tích lũy tháng này: <strong>' + monthlyLiters + 'L</strong></div>' +
    '</div>';
  }

  // Get data from API
  // monthlyLiters = tổng số L khách đã mua trong tháng
  // litersToNext = số L còn thiếu để đạt tier kế tiếp
  // nextTierLiters = threshold của tier kế tiếp
  var monthlyLiters = monthlyReward.monthlyLiters || 0;
  var litersToNext = monthlyReward.litersToNext || 0;
  var tier = monthlyReward.tier || '';

  // Get tiers from settings
  var tiers = settings.rewardTiers;
  if (!tiers || tiers.length === 0) return '';

  // Sort tiers by threshold
  tiers = [...tiers].sort(function(a, b) { return a.threshold - b.threshold; });

  // Find current and next tiers based on actual purchased volume
  var currentTier = null;
  var currentTierIndex = -1;
  var nextTier = null;
  var nextTierIndex = -1;

  for (var i = 0; i < tiers.length; i++) {
    var tierData = tiers[i];
    if (monthlyLiters >= tierData.threshold) {
      currentTier = tierData;
      currentTierIndex = i;
    } else if (nextTierIndex < 0) {
      nextTier = tierData;
      nextTierIndex = i;
    }
  }

  // Check if completed all tiers (currentTier là tier cuối và không còn nextTier)
  var isCompleted = currentTier && currentTierIndex === tiers.length - 1;

  // Case 3: Completed - only show on the day the tier was achieved
  // Check if this sale was created today
  if (isCompleted) {
    var saleDate = invoice.date ? new Date(invoice.date) : null;
    var today = new Date();
    var isToday = saleDate && (
      saleDate.getFullYear() === today.getFullYear() &&
      saleDate.getMonth() === today.getMonth() &&
      saleDate.getDate() === today.getDate()
    );
    if (!isToday) return '';
  }

  // Build note HTML
  var noteHtml = '';

  if (isCompleted) {
    // Case 3: Completed all tiers
    noteHtml =
      '<div class="promo-note" style="margin:10px 0;padding:10px 12px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:8px;font-size:11px;line-height:1.5;">' +
        '<div style="font-weight:700;color:#16a34a;margin-bottom:4px;">&#127942; Khuyến mãi Sản lượng Tháng</div>' +
        '<div style="color:#15803d;">&#127882; Chúc mừng! Anh/Chị đã hoàn thành chương trình khuyến mãi tháng.</div>' +
        '<div style="color:#166534;margin-top:4px;">Đã nhận thưởng <strong>Mốc ' + (currentTierIndex + 1) + ' (+' + currentTier.reward + 'L)</strong>.</div>' +
      '</div>';
  } else if (currentTier && nextTier) {
    // Case 2: Achieved at least one tier, not the last
    noteHtml =
      '<div class="promo-note" style="margin:10px 0;padding:10px 12px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.3);border-radius:8px;font-size:11px;line-height:1.5;">' +
        '<div style="font-weight:700;color:#2563eb;margin-bottom:4px;">&#127942; Khuyến mãi Sản lượng Tháng</div>' +
        '<div style="color:#1d4ed8;">&#127881; Đã đạt <strong>Mốc ' + (currentTierIndex + 1) + ' (+' + currentTier.reward + 'L)</strong></div>' +
        '<div style="color:#1e40af;margin-top:4px;">Chỉ còn <strong>' + litersToNext + 'L</strong> nữa để nhận <strong>Mốc ' + (nextTierIndex + 1) + ' (+' + nextTier.reward + 'L)</strong>.</div>' +
      '</div>';
  } else if (nextTier) {
    // Case 1: Not yet reached first tier
    noteHtml =
      '<div class="promo-note" style="margin:10px 0;padding:10px 12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;font-size:11px;line-height:1.5;">' +
        '<div style="font-weight:700;color:#d97706;margin-bottom:4px;">&#127919; Khuyến mãi Sản lượng Tháng</div>' +
        '<div style="color:#92400e;">Đã tích lũy: <strong>' + monthlyLiters + 'L</strong></div>' +
        '<div style="color:#b45309;margin-top:4px;">Chỉ còn <strong>' + litersToNext + 'L</strong> nữa để nhận <strong>Mốc ' + (nextTierIndex + 1) + ' (+' + nextTier.reward + 'L)</strong>.</div>' +
      '</div>';
  }

  return noteHtml;
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
