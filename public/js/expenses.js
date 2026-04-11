// BeerPOS Expenses Page
// PERFORMANCE: Separated from HTML, lazy loaded on /expenses route
var _expensesData = [];
var _currentCategory = 'all';

function getExpensesState() {
  if (window.BeerStore && typeof window.BeerStore.getSlice === 'function') {
    var storeExpenses = window.BeerStore.getSlice('expenses');
    if (Array.isArray(storeExpenses)) {
      _expensesData = storeExpenses.slice();
    }
  }
  return _expensesData;
}

function setExpensesState(nextExpenses) {
  _expensesData = Array.isArray(nextExpenses) ? nextExpenses.slice() : [];
  if (window.BeerStore && typeof window.BeerStore.setSlice === 'function') {
    window.BeerStore.setSlice('expenses', _expensesData);
  }
  return _expensesData;
}

async function refetchExpensesCurrentMonth() {
  if (!_currentMonth) return;
  await loadExpenses(_currentMonth, { silent: true });
}

var _currentMonth = '';
var _newCatAfterAdd = null; // name of category to auto-select after creation

var _defaultCategories = [
  { name: 'fuel',    label: 'Xăng',     icon: '⛽' },
  { name: 'food',    label: 'Ăn uống',  icon: '🍜' },
  { name: 'repair',  label: 'Sửa chữa', icon: '🔧' },
  { name: 'other',   label: 'Khác',     icon: '📦' }
];

var _customCategories = []; // { id, name, icon }

function _getIconByName(name) {
  for (var i = 0; i < _defaultCategories.length; i++) {
    if (_defaultCategories[i].name === name) return _defaultCategories[i].icon;
  }
  for (var j = 0; j < _customCategories.length; j++) {
    if (_customCategories[j].name === name) return _customCategories[j].icon || '📋';
  }
  return '📋';
}

function _getLabelByName(name) {
  for (var i = 0; i < _defaultCategories.length; i++) {
    if (_defaultCategories[i].name === name) return _defaultCategories[i].label;
  }
  return name || 'Khác'; // custom categories use name as label
}

function formatVND(amount) {
  if (amount == null || amount === '') return '0 đ';
  var num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

/** Chỉ giữ chữ số (dùng cho ô tiền có dấu phân cách) */
function expenseAmountDigitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

/** Hiển thị số tiền trong ô input: 10000 → "10.000" */
function formatExpenseAmountField(digits) {
  if (!digits) return '';
  var n = parseInt(digits, 10);
  if (!isFinite(n) || n < 0) return '';
  return new Intl.NumberFormat('vi-VN').format(n);
}

function onExpenseAmountInput(el) {
  if (!el) return;
  var digits = expenseAmountDigitsOnly(el.value);
  el.value = formatExpenseAmountField(digits);
}

function getParsedExpenseAmount() {
  var el = document.getElementById('expenseAmount');
  if (!el) return 0;
  var d = expenseAmountDigitsOnly(el.value);
  return d ? parseInt(d, 10) : 0;
}

function loadExpenses(monthStr, opts) {
  opts = opts || {};
  _currentMonth = monthStr;
  var list = document.getElementById('expensesList');
  if (!opts.silent && list) list.innerHTML = '<div class="text-center text-muted py-8">Đang tải...</div>';

  var parts = monthStr.split('-');
  var year = parts[0];
  var month = parts[1];

  var lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  var startDate = year + '-' + month + '-01';
  var endDate = year + '-' + month + '-' + String(lastDay).padStart(2, '0');

  Promise.all([
    fetch('/api/expenses?startDate=' + startDate + '&endDate=' + endDate, { cache: 'no-store' }).then(function(r) {
      if (!r.ok) return Promise.reject(new Error('HTTP ' + r.status));
      return r.json();
    }),
    fetch('/api/expenses/categories/all').then(function(r) {
      if (!r.ok) return Promise.reject(new Error('HTTP ' + r.status));
      return r.json();
    })
  ])
    .then(function(results) {
      setExpensesState(Array.isArray(results[0]) ? results[0] : (results[0].expenses || []));
      _customCategories = Array.isArray(results[1]) ? results[1] : [];

      rebuildExpenseCategorySelect();
      rebuildCategoryTabs();
      updateTotal();
      renderExpenses();
    })
    .catch(function(e) {
      if (document.getElementById('expensesList')) {
        document.getElementById('expensesList').innerHTML =
          '<div class="text-center text-danger py-8">Lỗi: ' + e.message + '</div>';
      }
    });
}

function updateTotal() {
  var total = getExpensesState().reduce(function(s, e) { return s + (Number(e.amount) || 0); }, 0);
  var headerEl = document.getElementById('headerTotal');
  var monthEl = document.getElementById('monthTotal');
  var fmt = formatVND(total);
  if (headerEl) headerEl.textContent = fmt;
  if (monthEl) monthEl.textContent = fmt;
}

function renderExpenses() {
  var container = document.getElementById('expensesList');
  var empty = document.getElementById('emptyState');
  if (!container) return;

  var filtered = _currentCategory === 'all'
    ? getExpensesState()
    : getExpensesState().filter(function(e) { return e.category === _currentCategory; });

  if (filtered.length === 0) {
    container.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    renderCategoryChips({});
    return;
  }
  if (empty) empty.classList.add('hidden');

  var summary = {};
  for (var i = 0; i < getExpensesState().length; i++) {
    var cat = getExpensesState()[i].category || 'other';
    summary[cat] = (summary[cat] || 0) + (Number(getExpensesState()[i].amount) || 0);
  }
  renderCategoryChips(summary);

  var html = [];
  for (var j = 0; j < filtered.length; j++) {
    var e = filtered[j];
    var icon = _getIconByName(e.category);
    var catLabel = _getLabelByName(e.category);
    var dateStr = e.date ? e.date.split('T')[0].split('-').reverse().join('/') : '';
    html.push(
      '<div class="expense-item" data-expense-id="' + e.id + '">' +
        '<div class="expense-icon">' + icon + '</div>' +
        '<div class="expense-info">' +
          '<div class="expense-cat">' + catLabel + '</div>' +
          '<div class="expense-note">' + (e.note || '—') + '</div>' +
          '<div class="expense-date">' + dateStr + '</div>' +
        '</div>' +
        '<div class="expense-amount">' + formatVND(e.amount) + '</div>' +
        '<div class="expense-actions">' +
          '<button onclick="editExpense(' + e.id + ')" class="expense-action-btn">✏️</button>' +
          '<button onclick="deleteExpense(' + e.id + ')" class="expense-action-btn delete">🗑️</button>' +
        '</div>' +
      '</div>'
    );
  }
  container.innerHTML = html.join('');
}

function renderCategoryChips(summary) {
  var el = document.getElementById('categoryChips');
  if (!el) return;

  var allCats = _defaultCategories.concat(_customCategories);

  // All chip
  var allTotal = Object.values(summary).reduce(function(s, v) { return s + v; }, 0);
  var html = '<div class="cat-chip ' + (_currentCategory === 'all' ? 'active' : '') + '" onclick="filterCategory(\'all\')">' +
    '<span class="cat-chip-icon">📋</span>' +
    '<span class="cat-chip-label">Tất cả</span>' +
    '<span class="cat-chip-amount">' + formatVND(allTotal) + '</span>' +
    '</div>';

  for (var i = 0; i < allCats.length; i++) {
    var cat = allCats[i];
    var amt = summary[cat.name] || 0;
    html += '<div class="cat-chip ' + (_currentCategory === cat.name ? 'active' : '') + '" onclick="filterCategory(\'' + cat.name.replace(/'/g, "\\'") + '\')">' +
      '<span class="cat-chip-icon">' + cat.icon + '</span>' +
      '<span class="cat-chip-label">' + (cat.label || cat.name) + '</span>' +
      '<span class="cat-chip-amount">' + formatVND(amt) + '</span>' +
      '</div>';
  }

  // Add category button
  html += '<div class="cat-chip" onclick="showAddCategoryModal()" style="border-style:dashed;">' +
    '<span class="cat-chip-icon">➕</span>' +
    '<span class="cat-chip-label">Thêm</span>' +
    '<span class="cat-chip-amount"></span>' +
    '</div>';

  el.innerHTML = html;
}

function switchMonth(dir) {
  var input = document.getElementById('filterMonth');
  if (!input || !input.value) return;
  var parts = input.value.split('-');
  var y = parseInt(parts[0]);
  var m = parseInt(parts[1]) + dir;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  input.value = y + '-' + String(m).padStart(2, '0');
  loadExpenses(input.value);
}

function showAddExpense() {
  _newCatAfterAdd = null;
  var modalTitleEl = document.getElementById('modalTitle');
  var expenseIdEl = document.getElementById('expenseId');
  var expenseFormEl = document.getElementById('expenseForm');
  var expenseAmountEl = document.getElementById('expenseAmount');
  var m = document.getElementById('expenseModal');

  if (modalTitleEl) modalTitleEl.textContent = 'Thêm chi phí';
  if (expenseIdEl) expenseIdEl.value = '';
  if (expenseFormEl) expenseFormEl.reset();
  if (expenseAmountEl) expenseAmountEl.value = '';
  rebuildExpenseCategorySelect();
  if (m) { m.classList.remove('hidden'); m.classList.add('flex'); }
}

function editExpense(id) {
  _newCatAfterAdd = null;
  var exp = getExpensesState().find(function(e) { return String(e.id) === String(id); });
  if (!exp) return;
  var modalTitleEl = document.getElementById('modalTitle');
  var expenseIdEl = document.getElementById('expenseId');
  var expenseAmountEl = document.getElementById('expenseAmount');
  var expenseCategoryEl = document.getElementById('expenseCategory');
  var expenseNoteEl = document.getElementById('expenseNote');
  var m = document.getElementById('expenseModal');

  if (modalTitleEl) modalTitleEl.textContent = 'Sửa chi phí';
  if (expenseIdEl) expenseIdEl.value = id;
  if (expenseAmountEl) expenseAmountEl.value = formatExpenseAmountField(String(Math.round(Number(exp.amount) || 0)));
  rebuildExpenseCategorySelect();
  if (expenseCategoryEl) expenseCategoryEl.value = exp.category || 'other';
  if (expenseNoteEl) expenseNoteEl.value = exp.note || '';
  if (m) { m.classList.remove('hidden'); m.classList.add('flex'); }
}

function hideExpenseModal() {
  var m = document.getElementById('expenseModal');
  if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
}

function saveExpense(e) {
  e.preventDefault();
  var expenseIdEl = document.getElementById('expenseId');
  var expenseCategoryEl = document.getElementById('expenseCategory');
  var expenseNoteEl = document.getElementById('expenseNote');
  var id = expenseIdEl ? expenseIdEl.value : '';
  var amt = getParsedExpenseAmount();
  if (!amt || amt <= 0) {
    alert('Vui lòng nhập số tiền lớn hơn 0.');
    return;
  }
  var data = {
    amount: amt,
    category: expenseCategoryEl ? expenseCategoryEl.value : 'other',
    note: expenseNoteEl ? expenseNoteEl.value : '',
    year: (_currentMonth.split('-')[0] || ''),
    month: (_currentMonth.split('-')[1] || '')
  };
  var method = id ? 'PUT' : 'POST';
  var url = id ? '/api/expenses/' + id : '/api/expenses';
  var isNew = !id;

  hideExpenseModal();

  var form = document.getElementById('expenseForm');
  var saveBtn = form ? form.querySelector('[type="submit"]') : null;
  var btnState = saveBtn ? setButtonLoading(saveBtn) : null;

  (async function() {
    try {
      var res = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        cache: 'no-store'
      });
      var result;
      try { result = await res.json(); } catch (_) { result = {}; }
      if (!res.ok) throw new Error(result.error || 'Lưu chi phí thất bại');

      // REFETCH to sync all data
      if (_currentMonth) {
        await loadExpenses(_currentMonth, { silent: true });
      }
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'expense' } }));
    } catch (err) {
      console.error('[saveExpense]', err);
      showToast('Lưu chi phí thất bại: ' + (err.message || 'Lỗi không xác định'), 'error');
      if (_currentMonth) {
        await loadExpenses(_currentMonth, { silent: true });
      }
    } finally {
      if (btnState) restoreButtonLoading(btnState);
    }
  })();
}

function deleteExpense(id) {
  if (!confirm('Xóa chi phí này?')) return;

  var card = document.querySelector('[data-expense-id="' + id + '"]');
  var deleteBtn = card ? card.querySelector('.text-danger') : null;
  var btnState = deleteBtn ? setButtonLoading(deleteBtn) : null;

  (async function() {
    try {
      var res = await fetch('/api/expenses/' + id, { method: 'DELETE', cache: 'no-store' });
      var data;
      try { data = await res.json(); } catch (_) { data = {}; }
      if (!res.ok) throw new Error(data.error || 'Xóa chi phí thất bại');

      // REFETCH to sync all data
      if (_currentMonth) {
        await loadExpenses(_currentMonth, { silent: true });
      }
      window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: 'expense' } }));
    } catch (err) {
      console.error('[deleteExpense]', err);
      showToast('Xóa chi phí thất bại: ' + (err.message || 'Lỗi không xác định'), 'error');
      if (_currentMonth) {
        await loadExpenses(_currentMonth, { silent: true });
      }
    } finally {
      if (btnState) restoreButtonLoading(btnState);
    }
  })();
}

// ── Dynamic expense category select ─────────────────────────────────────────

var _emojiList = [
  '⛽','🍜','🔧','📦','📋','💡','🛠️','📉','👷','🏪',
  '📢','🚗','🛵','🏠','💊','🎓','📱','💰','🎁','🍕',
  '☕','🚌','✈️','🎬','📚','🎮','🏋️','🛒','💄','🔌',
  '🔋','🛢️','🏗️','🌿','📦','🎯','📊','🧾'
];

function rebuildExpenseCategorySelect() {
  var sel = document.getElementById('expenseCategory');
  if (!sel) return;

  var html = '';

  for (var i = 0; i < _defaultCategories.length; i++) {
    var cat = _defaultCategories[i];
    html += '<option value="' + cat.name + '">' + cat.icon + ' ' + cat.label + '</option>';
  }

  for (var j = 0; j < _customCategories.length; j++) {
    var cat = _customCategories[j];
    html += '<option value="' + cat.name + '">' + (cat.icon || '📋') + ' ' + cat.name + '</option>';
  }

  html += '<option value="__add_new__">➕ Thêm loại mới...</option>';

  sel.innerHTML = html;

  if (_newCatAfterAdd) {
    sel.value = _newCatAfterAdd;
    _newCatAfterAdd = null;
  }
}

// ── Emoji picker ─────────────────────────────────────────────────────────────

function renderEmojiPicker() {
  var picker = document.getElementById('emojiPicker');
  if (!picker) return;
  var html = '';
  for (var i = 0; i < _emojiList.length; i++) {
    html += '<button type="button" class="emoji-btn" ' +
            'onclick="selectEmoji(\'' + _emojiList[i].replace(/'/g, "\\'") + '\')" ' +
            'data-emoji="' + _emojiList[i] + '">' + _emojiList[i] + '</button>';
  }
  picker.innerHTML = html;
}

function selectEmoji(emoji) {
  var iconEl = document.getElementById('categoryIcon');
  if (iconEl) iconEl.value = emoji;
  var btns = document.querySelectorAll('.emoji-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('ring-2', btns[i].getAttribute('data-emoji') === emoji);
    btns[i].classList.toggle('ring-primary', btns[i].getAttribute('data-emoji') === emoji);
  }
}

// ── Category modal ───────────────────────────────────────────────────────────

function showAddCategoryModal(fromSelect) {
  if (fromSelect) {
    _newCatAfterAdd = null; // will be set after creation
  }
  var categoryNameEl = document.getElementById('categoryName');
  var categoryIconEl = document.getElementById('categoryIcon');
  var m = document.getElementById('categoryModal');
  if (categoryNameEl) categoryNameEl.value = '';
  if (categoryIconEl) categoryIconEl.value = '📋';
  selectEmoji('📋');
  renderEmojiPicker();
  if (m) { m.classList.remove('hidden'); m.classList.add('flex'); }
  var nameFocusEl = document.getElementById('categoryName');
  if (nameFocusEl) nameFocusEl.focus();
}

function hideCategoryModal() {
  var m = document.getElementById('categoryModal');
  if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
}

function saveCategory(e) {
  e.preventDefault();
  var nameEl = document.getElementById('categoryName');
  var iconEl = document.getElementById('categoryIcon');
  var name = nameEl ? nameEl.value.trim() : '';
  var icon = iconEl ? iconEl.value : '📋';

  if (!name || name.length < 2) {
    alert('Tên loại chi phí phải có ít nhất 2 ký tự.');
    return;
  }
  if (name.length > 30) {
    alert('Tên loại chi phí tối đa 30 ký tự.');
    return;
  }

  hideCategoryModal();

  fetch('/api/expenses/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, icon: icon })
  })
    .then(function(r) {
      if (!r.ok) return Promise.reject(new Error('HTTP ' + r.status));
      return r.json();
    })
    .then(function(result) {
      return fetch('/api/expenses/categories/all')
        .then(function(r2) {
          if (!r2.ok) return Promise.reject(new Error('HTTP ' + r2.status));
          return r2.json();
        })
        .then(function(data) {
          _customCategories = Array.isArray(data) ? data : [];
          rebuildExpenseCategorySelect();
          rebuildCategoryTabs();
          renderCategoryChips(_getSummaryByCategory());

          // Auto-select newly created category in the dropdown
          var sel = document.getElementById('expenseCategory');
          if (sel && result.name) {
            sel.value = result.name;
            _newCatAfterAdd = result.name;
          }
        });
    })
    .catch(function(err) { alert('Lỗi: ' + err.message); });
}

function deleteCustomCategory(id, name) {
  if (!id || !confirm('Xóa loại chi phí "' + name + '"? Các khoản chi đang gắn loại này sẽ chuyển sang Khác.')) return;

  // Guard: prevent double-delete
  var btn = document.querySelector('[data-delete-cat-id="' + id + '"]');
  if (btn && btn.disabled) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '...';
  }

  fetch('/api/expenses/categories/' + id, { method: 'DELETE', cache: 'no-store' })
    .then(function(r) {
      if (!r.ok) {
        return r.json().then(function(j) { throw new Error(j.error || ('HTTP ' + r.status)); });
      }
      return r.json();
    })
    .then(function(result) {
      console.log('[Expenses] Category deleted:', result);
      // Reset filter if deleted category was active
      if (_currentCategory === name) _currentCategory = 'all';
      // Always refetch from server — clear stale _customCategories
      _customCategories = [];
      loadExpenses(_currentMonth);
    })
    .catch(function(err) {
      console.error('[Expenses] deleteCustomCategory failed:', err);
      alert('Không xóa được: ' + (err.message || 'Lỗi không xác định'));
      // Restore button
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🗑️';
      }
    });
}

// ── Category tabs ────────────────────────────────────────────────────────────

function rebuildCategoryTabs() {
  // New design uses chips, render chips with current summary
  var summary = {};
  for (var i = 0; i < getExpensesState().length; i++) {
    var cat = getExpensesState()[i].category || 'other';
    summary[cat] = (summary[cat] || 0) + (Number(getExpensesState()[i].amount) || 0);
  }
  renderCategoryChips(summary);
}

function filterCategory(cat) {
  _currentCategory = cat;
  var tabs = document.querySelectorAll('.cat-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].dataset.cat === cat || tabs[i].getAttribute('data-custom-cat') === cat);
  }
  renderExpenses();
}

function _getSummaryByCategory() {
  var summary = {};
  for (var i = 0; i < getExpensesState().length; i++) {
    var cat = getExpensesState()[i].category || 'other';
    summary[cat] = (summary[cat] || 0) + (Number(getExpensesState()[i].amount) || 0);
  }
  return summary;
}

// ── Handle "Add new category" option in select ───────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  var sel = document.getElementById('expenseCategory');
  if (sel) {
    sel.addEventListener('change', function() {
      if (this.value === '__add_new__') {
        showAddCategoryModal(true);
        // Reset select to first option so user sees the dropdown in normal state
        if (_newCatAfterAdd) {
          this.value = _newCatAfterAdd;
        } else {
          this.value = 'other';
        }
      }
    });
  }
});

var _expensesRefreshTimer = null;
var _expensesRefreshInFlight = false;

function shouldRefreshExpensesEntity(entity) {
  if (!entity) return true;
  return entity === 'expense' || entity === 'sync';
}

function shouldRefreshExpensesPath(pathname) {
  if (!pathname) return false;
  return pathname.indexOf('/api/expenses') === 0 ||
    pathname.indexOf('/expenses/data') === 0;
}

async function refreshExpensesPage(reason) {
  if (_expensesRefreshInFlight) return;
  _expensesRefreshInFlight = true;
  console.log('[CONSISTENCY][Expenses] refresh', reason || 'mutation');
  try {
    if (_currentMonth) {
      await loadExpenses(_currentMonth, { silent: true });
    }
  } finally {
    _expensesRefreshInFlight = false;
  }
}

function queueExpensesRefresh(reason) {
  clearTimeout(_expensesRefreshTimer);
  _expensesRefreshTimer = setTimeout(function() {
    refreshExpensesPage(reason || 'mutation');
  }, 180);
}

window.addEventListener('data:mutated', function(evt) {
  var detail = evt && evt.detail ? evt.detail : {};
  if (!shouldRefreshExpensesEntity(detail.entity)) return;
  queueExpensesRefresh(detail.entity || 'mutation');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', function(event) {
    var data = event && event.data ? event.data : {};
    if (data.type !== 'DATA_INVALIDATED') return;
    if (!shouldRefreshExpensesPath(data.path || '')) return;
    queueExpensesRefresh('sw:' + (data.path || 'unknown'));
  });
}
