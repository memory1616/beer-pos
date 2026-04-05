/**
 * Beer POS - Realtime UI State & Mutation System
 * Global state store + mutate helper for instant UI updates without full reload
 * @module public/js/realtime
 */

/** ============================================================
 * 1. GLOBAL STATE STORE (window.store)
 * Single source of truth - prevents duplicate data across app
 * ============================================================ */
window.store = {
  sales: [],
  expenses: [],
  purchases: [],
  products: [],
  customers: [],
};

/** ============================================================
 * 2. MUTATE HELPER
 * Wraps fetch calls with optimistic UI update
 * - Always hits network (cache: 'no-store')
 * - Falls back to loadData() on failure
 * ============================================================ */
async function mutate(requestFn, onSuccess, onError) {
  try {
    const res = await requestFn();
    const data = await res.json();

    if (res.ok && data.success !== false) {
      if (typeof onSuccess === 'function') {
        onSuccess(data);
      }
    } else {
      if (typeof onError === 'function') {
        onError(data);
      } else {
        alert(data.error || 'Đã xảy ra lỗi');
      }
    }
  } catch (err) {
    console.error('Mutate error:', err);
    if (typeof onError === 'function') {
      onError({ error: err.message });
    } else {
      alert('Lỗi kết nối: ' + err.message);
    }
  }
}

/** ============================================================
 * 3. RENDERING HELPERS
 * Granular DOM update functions (no full re-render)
 * ============================================================ */

/**
 * Render a single expense item to the list
 * @param {Object} expense - expense data
 * @param {Object} opts - { prepend: true } to add at top
 */
function renderExpenseItem(expense, opts) {
  opts = opts || {};
  var container = document.getElementById('expensesList');
  if (!container) return;

  var icon = _getIconByName(expense.category);
  var catLabel = _getLabelByName(expense.category);
  var dateStr = expense.date ? expense.date.split('T')[0].split('-').reverse().join('/') : '';
  var html = [
    '<div class="card p-3 flex items-center justify-between" data-expense-id="' + expense.id + '">',
      '<div class="flex items-center gap-3">',
        '<div class="text-2xl">' + icon + '</div>',
        '<div>',
          '<div class="font-medium">' + catLabel + '</div>',
          '<div class="text-sm text-muted">' + (expense.note || '—') + '</div>',
          '<div class="text-xs text-muted">' + dateStr + '</div>',
        '</div>',
      '</div>',
      '<div class="flex items-center gap-2">',
        '<div class="font-bold text-money money">' + formatVND(expense.amount) + '</div>',
        '<button onclick="editExpense(' + expense.id + ')" class="btn btn-ghost btn-sm">✏️</button>',
        '<button onclick="deleteExpense(' + expense.id + ')" class="btn btn-ghost btn-sm text-danger">🗑️</button>',
      '</div>',
    '</div>'
  ].join('');

  if (opts.prepend) {
    container.insertAdjacentHTML('afterbegin', html);
  } else {
    container.insertAdjacentHTML('beforeend', html);
  }
}

/**
 * Update an existing expense item in-place
 */
function updateExpenseItem(expense) {
  var card = document.querySelector('[data-expense-id="' + expense.id + '"]');
  if (!card) return;

  var icon = _getIconByName(expense.category);
  var catLabel = _getLabelByName(expense.category);
  var dateStr = expense.date ? expense.date.split('T')[0].split('-').reverse().join('/') : '';

  card.querySelector('.text-2xl').textContent = icon;
  var textEls = card.querySelectorAll('.font-medium, .text-muted');
  if (textEls[0]) textEls[0].textContent = catLabel;
  if (textEls[1]) textEls[1].textContent = expense.note || '—';
  if (textEls[2]) textEls[2].textContent = dateStr;
  var moneyEl = card.querySelector('.money');
  if (moneyEl) moneyEl.textContent = formatVND(expense.amount);

  // Update onclick handlers for edit/delete
  var btns = card.querySelectorAll('button');
  if (btns[0]) btns[0].setAttribute('onclick', 'editExpense(' + expense.id + ')');
  if (btns[1]) btns[1].setAttribute('onclick', 'deleteExpense(' + expense.id + ')');
}

/**
 * Remove an expense item from DOM
 */
function removeExpenseItem(id) {
  var card = document.querySelector('[data-expense-id="' + id + '"]');
  if (card) card.remove();
}

/**
 * Render a single sale item to the list
 */
function renderSaleItem(sale, opts) {
  opts = opts || {};
  var container = document.getElementById('salesHistoryList');
  if (!container) return;

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
  var saleMoney = typeof Format !== 'undefined' ? Format.number(sale.total) : formatVND(sale.total).replace(' đ', '');

  var html = [
    '<div class="order-item ' + badgeLeft + '" data-sale-id="' + sale.id + '">',
      '<div class="order-header">',
        '<div class="flex items-center gap-2 min-w-0 flex-1">',
          '<span class="text-xs font-semibold text-muted shrink-0">#' + sale.id + '</span>',
          '<span class="order-title">' + customerName + '</span>',
          (badgeHtml ? '<span class="shrink-0">' + badgeHtml + '</span>' : ''),
        '</div>',
        '<span class="order-meta">📅 ' + date + '</span>',
      '</div>',
      '<div class="order-footer">',
        '<div class="flex items-baseline gap-1">',
          '<div class="money text-money"><span class="value text-xl font-bold tabular-nums">' + saleMoney + '</span><span class="unit">đ</span></div>',
        '</div>',
        (qtyLabel ? '<span class="order-meta">' + qtyLabel + '</span>' : ''),
      '</div>',
      '<div class="order-actions">',
        (isReturned
          ? '<button class="btn btn-secondary btn-sm">Đã trả</button>'
          : '<button onclick="viewSale(' + sale.id + ')" class="btn btn-secondary btn-sm">Hóa đơn</button>' +
            '<button onclick="openCollectKegModal(' + sale.id + ')" class="btn btn-warning btn-sm">Thu vỏ</button>' +
            '<button onclick="editSale(' + sale.id + ')" class="btn btn-ghost btn-sm">Sửa</button>' +
            '<button onclick="deleteSale(' + sale.id + ')" class="btn btn-danger btn-sm">Xóa</button>'
        ),
      '</div>',
    '</div>'
  ].join('');

  // Insert before pagination nav if exists
  var nav = container.querySelector('nav[role="navigation"]');
  if (nav) {
    nav.insertAdjacentHTML('beforebegin', html);
  } else if (opts.prepend) {
    container.insertAdjacentHTML('afterbegin', html);
  } else {
    container.insertAdjacentHTML('beforeend', html);
  }
}

/**
 * Patch a sale row in-place (no full re-render)
 */
function patchSaleRow(sale) {
  var card = document.querySelector('[data-sale-id="' + sale.id + '"]');
  if (!card) return;

  var date = formatSaleListDate(sale.date);
  var nameEl = card.querySelector('.order-title');
  var dateEl = card.querySelector('.order-meta');
  var moneyEl = card.querySelector('.money .value');
  if (nameEl) nameEl.textContent = sale.customer_name || 'Khách lẻ';
  if (dateEl) dateEl.textContent = '📅 ' + date;
  if (moneyEl) moneyEl.textContent = typeof Format !== 'undefined' ? Format.number(sale.total) : formatVND(sale.total).replace(' đ', '');

  var isReturned = sale.status === 'returned';
  var isReplacement = sale.type === 'replacement';
  var isGift = sale.type === 'gift';
  var actionsEl = card.querySelector('.order-actions');
  if (actionsEl) {
    actionsEl.innerHTML = isReturned
      ? '<button class="btn btn-secondary btn-sm">Đã trả</button>'
      : '<button onclick="viewSale(' + sale.id + ')" class="btn btn-secondary btn-sm">Hóa đơn</button>' +
        '<button onclick="openCollectKegModal(' + sale.id + ')" class="btn btn-warning btn-sm">Thu vỏ</button>' +
        '<button onclick="editSale(' + sale.id + ')" class="btn btn-ghost btn-sm">Sửa</button>' +
        '<button onclick="deleteSale(' + sale.id + ')" class="btn btn-danger btn-sm">Xóa</button>';
  }
  card.className = 'order-item ' + (isReplacement ? 'border-l-4 border-warning' : isGift ? 'border-l-4 border-primary' : 'border-l-4 border-success');
}

/**
 * Remove a sale item from DOM
 */
function removeSaleItem(id) {
  var card = document.querySelector('[data-sale-id="' + id + '"]');
  if (card) card.remove();
}

/**
 * Render a single product card to the list
 */
function renderProductItem(product, opts) {
  opts = opts || {};
  var container = document.getElementById('productList');
  if (!container) return;

  var low = product.stock < 5;
  var html = [
    '<article class="card product-card product-card--interactive ' + (low ? 'border-danger' : 'border-muted') + '"',
      ' role="button" tabindex="0" data-product-id="' + product.id + '"',
      ' aria-label="' + escapeHtmlAttr(product.name) + ' — Tồn ' + product.stock + '. Nhấn để sửa"',
      ' onclick="openProductModal(' + product.id + ')"',
      ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openProductModal(' + product.id + ');}">',
      '<div class="flex justify-between items-start gap-2">',
        '<h3 class="product-card__name min-w-0 flex-1">' + product.name + '</h3>',
        (low ? '<span class="badge badge-danger shrink-0 text-[10px]">Sắp hết</span>' : ''),
      '</div>',
      '<div class="product-card__meta">Giá vốn · ' + formatVND(product.cost_price || 0) + '</div>',
      '<div class="product-card__footer">',
        '<div class="min-w-0">',
          '<div class="product-card__qty-label">Tồn kho</div>',
          '<div class="product-card__qty tabular-nums ' + (low ? 'text-danger' : 'text-success') + '">' + product.stock + '</div>',
        '</div>',
        '<div class="product-card__edit-pill" aria-hidden="true"><span class="product-card__edit-icon">✏️</span><span>Sửa</span></div>',
      '</div>',
    '</article>'
  ].join('');

  // Insert after low stock alert (first card) or at end
  var firstCard = container.querySelector('[data-product-id]');
  if (opts.prepend && firstCard) {
    firstCard.insertAdjacentHTML('beforebegin', html);
  } else {
    container.insertAdjacentHTML('beforeend', html);
  }
}

/**
 * Update a product card in-place
 */
function updateProductItem(product) {
  var card = document.querySelector('[data-product-id="' + product.id + '"]');
  if (!card) return;

  var low = product.stock < 5;
  var nameEl = card.querySelector('.product-card__name');
  var metaEl = card.querySelector('.product-card__meta');
  var qtyEl = card.querySelector('.product-card__qty');
  var qtyLabelEl = card.querySelector('.product-card__qty-label');
  var badgeEl = card.querySelector('.badge-danger');

  if (nameEl) nameEl.textContent = product.name;
  if (metaEl) metaEl.textContent = 'Giá vốn · ' + formatVND(product.cost_price || 0);
  if (qtyEl) {
    qtyEl.textContent = product.stock;
    qtyEl.className = 'product-card__qty tabular-nums ' + (low ? 'text-danger' : 'text-success');
  }
  if (qtyLabelEl && qtyLabelEl.textContent === 'Tồn kho') {
    // already correct
  }

  // Update badge
  var headerEl = card.querySelector('.flex');
  if (headerEl) {
    var existingBadge = headerEl.querySelector('.badge-danger');
    if (low && !existingBadge) {
      var nameWrapper = headerEl.querySelector('.product-card__name');
      if (nameWrapper) {
        nameWrapper.insertAdjacentHTML('afterend', '<span class="badge badge-danger shrink-0 text-[10px]">Sắp hết</span>');
      }
    } else if (!low && existingBadge) {
      existingBadge.remove();
    }
  }
}

/**
 * Remove a product card from DOM
 */
function removeProductItem(id) {
  var card = document.querySelector('[data-product-id="' + id + '"]');
  if (card) card.remove();
}

/**
 * Render a single purchase history item
 */
function renderPurchaseItem(purchase, opts) {
  opts = opts || {};
  var container = document.getElementById('purchaseHistoryList');
  if (!container) return;

  var date = new Date(purchase.date);
  var formattedDate = date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  var count = purchase.item_count != null ? purchase.item_count : 0;
  var html = [
    '<div class="purchase-history-item rounded-xl border border-muted bg-bg/40 p-3 mb-2 last:mb-0" data-purchase-id="' + purchase.id + '">',
      '<div class="flex items-start justify-between gap-2 min-w-0">',
        '<div class="min-w-0 flex-1">',
          '<div class="font-semibold text-primary">Đơn #' + purchase.id + '</div>',
          '<div class="text-xs text-muted mt-0.5">' + formattedDate + ' · ' + count + ' sản phẩm</div>',
        '</div>',
        '<div class="flex items-center gap-0.5 shrink-0">',
          '<button type="button" onclick="editPurchase(' + purchase.id + ')" class="btn btn-ghost btn-sm min-w-[2.25rem] h-9 px-0" title="Sửa">✏️</button>',
          '<button type="button" onclick="deletePurchase(' + purchase.id + ')" class="btn btn-ghost btn-sm min-w-[2.25rem] h-9 px-0 text-danger" title="Xóa">🗑️</button>',
        '</div>',
      '</div>',
      '<div class="mt-2.5 pt-2.5 border-t border-muted/70 flex items-center justify-between gap-3 min-w-0">',
        '<span class="text-xs text-muted shrink-0">Tổng tiền</span>',
        '<div class="card-stat-amount text-success justify-end text-sm sm:text-base font-bold">',
          '<span class="tabular-nums tracking-tight">' + new Intl.NumberFormat('vi-VN').format(Number(purchase.total_amount) || 0) + '</span>',
          '<span class="text-[10px] sm:text-xs opacity-75 shrink-0">đ</span>',
        '</div>',
      '</div>',
    '</div>'
  ].join('');

  if (opts.prepend) {
    container.insertAdjacentHTML('afterbegin', html);
  } else {
    container.insertAdjacentHTML('beforeend', html);
  }
}

/**
 * Update a purchase item in-place
 */
function updatePurchaseItem(purchase) {
  var card = document.querySelector('[data-purchase-id="' + purchase.id + '"]');
  if (!card) return;

  var formattedDate = new Date(purchase.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  var count = purchase.item_count != null ? purchase.item_count : 0;
  var amountEl = card.querySelector('.tabular-nums');
  var metaEl = card.querySelector('.text-xs.text-muted');

  if (metaEl) metaEl.textContent = formattedDate + ' · ' + count + ' sản phẩm';
  if (amountEl) amountEl.textContent = new Intl.NumberFormat('vi-VN').format(Number(purchase.total_amount) || 0);

  // Update buttons
  var btns = card.querySelectorAll('button');
  if (btns[0]) btns[0].setAttribute('onclick', 'editPurchase(' + purchase.id + ')');
  if (btns[1]) btns[1].setAttribute('onclick', 'deletePurchase(' + purchase.id + ')');
}

/**
 * Remove a purchase item from DOM
 */
function removePurchaseItem(id) {
  var card = document.querySelector('[data-purchase-id="' + id + '"]');
  if (card) card.remove();
}

/** ============================================================
 * 4. SUMMARY UPDATE HELPERS
 * Recalculate and update summary elements without full reload
 * ============================================================ */
function updateExpensesSummary() {
  if (typeof _expensesData === 'undefined') return;
  var total = _expensesData.reduce(function(s, e) { return s + (Number(e.amount) || 0); }, 0);
  var el = document.getElementById('headerTotal');
  if (el) el.textContent = formatVND(total);

  // Update category summary cards
  var summary = {};
  for (var i = 0; i < _expensesData.length; i++) {
    var cat = _expensesData[i].category || 'other';
    summary[cat] = (summary[cat] || 0) + (Number(_expensesData[i].amount) || 0);
  }
  renderSummaryCards(summary);
}

function updatePurchasesSummary() {
  // Update total count in pagination area
  var total = typeof allPurchases !== 'undefined' ? allPurchases.length : 0;
  var itemCountEl = document.getElementById('historyItemCount');
  if (itemCountEl) itemCountEl.textContent = total + ' phiếu';
}

function updateProductsSummary() {
  // Update total stock display
  if (typeof currentProducts === 'undefined') return;
  var totalStockEl = document.getElementById('totalStock');
  if (totalStockEl) {
    var total = currentProducts.reduce(function(sum, p) { return sum + Math.max(0, Number(p.stock) || 0); }, 0);
    totalStockEl.textContent = String(total);
  }

  // Update low stock alert
  var lowStockProducts = currentProducts.filter(function(p) { return p.stock < 5; });
  var container = document.getElementById('productList');
  if (!container) return;

  var existingAlert = container.querySelector('.border-danger');
  var newAlertHtml = '';
  if (lowStockProducts.length > 0) {
    newAlertHtml = [
      '<div class="card mb-4 border-danger product-grid__full">',
        '<div class="text-sm font-bold text-danger mb-2">⚠️ Tồn kho thấp (' + lowStockProducts.length + ')</div>',
        '<div class="flex flex-wrap gap-1">',
          lowStockProducts.map(function(p) {
            return '<span class="badge badge-danger">' + p.name + ': <b>' + p.stock + '</b></span>';
          }).join(''),
        '</div>',
      '</div>'
    ].join('');
  }

  var firstCard = container.querySelector('[data-product-id]');
  if (firstCard) {
    var oldAlert = container.querySelector('.border-danger');
    if (oldAlert) oldAlert.remove();
    firstCard.insertAdjacentHTML('beforebegin', newAlertHtml);
  } else if (newAlertHtml) {
    container.insertAdjacentHTML('afterbegin', newAlertHtml);
  }
}

/** ============================================================
 * 5. EMPTY STATE HELPERS
 * ============================================================ */

/**
 * Remove a customer card from DOM
 */
function removeCustomerItem(id) {
  var card = document.querySelector('[data-customer-id="' + id + '"]');
  if (card) card.remove();
}

function checkExpensesEmpty() {
  var container = document.getElementById('expensesList');
  var empty = document.getElementById('emptyState');
  if (!container || !empty) return;
  var filtered = _currentCategory === 'all'
    ? _expensesData
    : _expensesData.filter(function(e) { return e.category === _currentCategory; });
  if (filtered.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
}

function checkPurchasesEmpty() {
  var container = document.getElementById('historyList');
  if (!container) return;
  var total = typeof allPurchases !== 'undefined' ? allPurchases.length : 0;
  if (total === 0) {
    container.innerHTML = '<div class="text-center text-muted py-8">Chưa có phiếu nhập nào</div>';
  }
}

function checkSalesEmpty() {
  var container = document.getElementById('salesHistoryList');
  if (!container) return;
  var nav = container.querySelector('nav[role="navigation"]');
  var totalRow = container.querySelector('.history-total-row');
  var hasCards = container.querySelector('[data-sale-id]');
  if (!hasCards && !nav && !totalRow) {
    container.innerHTML = '<p class="text-muted text-center py-4">Chưa có hóa đơn nào</p>';
  }
}

/** ============================================================
 * 6. DOM UTILITIES
 * ============================================================ */
function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatSaleListDate(raw) {
  if (!raw) return '—';
  var s = String(raw).trim().split(/[\sT]/)[0];
  var p = s.split('-');
  if (p.length === 3) return p[2] + '/' + p[1] + '/' + p[0];
  try {
    return new Date(raw).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (e) {
    return s;
  }
}

function formatVND(amount) {
  if (amount == null || amount === '') return '0 đ';
  var num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}
