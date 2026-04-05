// BeerPOS Expenses Page
// PERFORMANCE: Separated from HTML, lazy loaded on /expenses route
var _expensesData = [];
var _currentCategory = 'all';
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

function loadExpenses(monthStr) {
  _currentMonth = monthStr;
  var list = document.getElementById('expensesList');
  if (list) list.innerHTML = '<div class="text-center text-muted py-8">Đang tải...</div>';

  var parts = monthStr.split('-');
  var year = parts[0];
  var month = parts[1];

  var lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  var startDate = year + '-' + month + '-01';
  var endDate = year + '-' + month + '-' + String(lastDay).padStart(2, '0');

  Promise.all([
    fetch('/api/expenses?startDate=' + startDate + '&endDate=' + endDate, { cache: 'no-store' }).then(function(r) { return r.json(); }),
    fetch('/api/expenses/categories/all').then(function(r) { return r.json(); })
  ])
    .then(function(results) {
      _expensesData = Array.isArray(results[0]) ? results[0] : (results[0].expenses || []);
      _customCategories = Array.isArray(results[1]) ? results[1] : [];

      // Populate global store
      window.store.expenses = _expensesData;

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
  var total = _expensesData.reduce(function(s, e) { return s + (Number(e.amount) || 0); }, 0);
  var el = document.getElementById('headerTotal');
  if (el) el.textContent = formatVND(total);
}

function renderExpenses() {
  var container = document.getElementById('expensesList');
  var empty = document.getElementById('emptyState');
  if (!container) return;

  var filtered = _currentCategory === 'all'
    ? _expensesData
    : _expensesData.filter(function(e) { return e.category === _currentCategory; });

  if (filtered.length === 0) {
    container.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    renderSummaryCards({});
    return;
  }
  if (empty) empty.classList.add('hidden');

  var summary = {};
  for (var i = 0; i < _expensesData.length; i++) {
    var cat = _expensesData[i].category || 'other';
    summary[cat] = (summary[cat] || 0) + (Number(_expensesData[i].amount) || 0);
  }
  renderSummaryCards(summary);

  var html = [];
  for (var j = 0; j < filtered.length; j++) {
    var e = filtered[j];
    var icon = _getIconByName(e.category);
    var catLabel = _getLabelByName(e.category);
    var dateStr = e.date ? e.date.split('T')[0].split('-').reverse().join('/') : '';
    html.push(
      '<div class="card p-3 flex items-center justify-between" data-expense-id="' + e.id + '">' +
        '<div class="flex items-center gap-3">' +
          '<div class="text-2xl">' + icon + '</div>' +
          '<div>' +
            '<div class="font-medium">' + catLabel + '</div>' +
            '<div class="text-sm text-muted">' + (e.note || '—') + '</div>' +
            '<div class="text-xs text-muted">' + dateStr + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="flex items-center gap-2">' +
          '<div class="font-bold text-money money">' + formatVND(e.amount) + '</div>' +
          '<button onclick="editExpense(' + e.id + ')" class="btn btn-ghost btn-sm">✏️</button>' +
          '<button onclick="deleteExpense(' + e.id + ')" class="btn btn-ghost btn-sm text-danger">🗑️</button>' +
        '</div>' +
      '</div>'
    );
  }
  container.innerHTML = html.join('');
}

function renderSummaryCards(summary) {
  var el = document.getElementById('summaryCards');
  if (!el) return;

  var allCats = _defaultCategories.concat(_customCategories);
  var html = [];
  for (var i = 0; i < allCats.length; i++) {
    var cat = allCats[i];
    var amt = summary[cat.name] || 0;
    html.push(
      '<div class="card p-3 text-center" onclick="filterCategory(\'' + cat.name.replace(/'/g, "\\'") + '\')" style="cursor:pointer">' +
        '<div class="text-xl mb-1">' + cat.icon + '</div>' +
        '<div class="text-sm text-muted">' + (cat.label || cat.name) + '</div>' +
        '<div class="font-bold tabular-nums money">' + formatVND(amt) + '</div>' +
      '</div>'
    );
  }
  el.innerHTML = html.join('');
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
  document.getElementById('modalTitle').textContent = 'Thêm chi phí';
  document.getElementById('expenseId').value = '';
  document.getElementById('expenseForm').reset();
  document.getElementById('expenseAmount').value = '';
  rebuildExpenseCategorySelect();
  var m = document.getElementById('expenseModal');
  m.classList.remove('hidden');
  m.classList.add('flex');
}

function editExpense(id) {
  _newCatAfterAdd = null;
  var exp = _expensesData.find(function(e) { return String(e.id) === String(id); });
  if (!exp) return;
  document.getElementById('modalTitle').textContent = 'Sửa chi phí';
  document.getElementById('expenseId').value = id;
  document.getElementById('expenseAmount').value = formatExpenseAmountField(
    String(Math.round(Number(exp.amount) || 0))
  );
  rebuildExpenseCategorySelect();
  document.getElementById('expenseCategory').value = exp.category || 'other';
  document.getElementById('expenseNote').value = exp.note || '';
  var m = document.getElementById('expenseModal');
  m.classList.remove('hidden');
  m.classList.add('flex');
}

function hideExpenseModal() {
  var m = document.getElementById('expenseModal');
  if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
}

function saveExpense(e) {
  e.preventDefault();
  var id = document.getElementById('expenseId').value;
  var amt = getParsedExpenseAmount();
  if (!amt || amt <= 0) {
    alert('Vui lòng nhập số tiền lớn hơn 0.');
    return;
  }
  var data = {
    amount: amt,
    category: document.getElementById('expenseCategory').value,
    note: document.getElementById('expenseNote').value,
    year: _currentMonth.split('-')[0],
    month: _currentMonth.split('-')[1]
  };
  var method = id ? 'PUT' : 'POST';
  var url = id ? '/api/expenses/' + id : '/api/expenses';
  var isNew = !id;

  hideExpenseModal();

  // Disable form buttons to prevent double-submit
  var form = document.getElementById('expenseForm');
  var saveBtn = form ? form.querySelector('[type="submit"]') : null;
  var btnState = saveBtn ? setButtonLoading(saveBtn) : null;

  // For update: snapshot current state for rollback
  var oldItem = null;
  if (!isNew) {
    oldItem = Object.assign({}, _expensesData.find(function(e) { return String(e.id) === String(id); }));
  }

  // Temporary ID for new items
  var tempId = 'tmp_' + Date.now();

  optimisticMutate({
    request: function() {
      return fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        cache: 'no-store'
      });
    },

    applyOptimistic: function() {
      if (isNew) {
        // Create temporary item and prepend to list
        var tempItem = Object.assign({ id: tempId }, data, { _optimistic: true });
        _expensesData.unshift(tempItem);
        window.store.expenses.unshift(tempItem);
        renderExpenseItem(tempItem, { prepend: true });
      } else {
        // Update existing item in-place
        var idx = _expensesData.findIndex(function(e) { return String(e.id) === String(id); });
        if (idx !== -1) {
          Object.assign(_expensesData[idx], data);
          window.store.expenses = _expensesData;
          updateExpenseItem(_expensesData[idx]);
        }
      }
      updateExpensesSummary();
      checkExpensesEmpty();
      rebuildCategoryTabs();
    },

    rollback: function() {
      if (isNew) {
        // Remove temporary item
        _expensesData = _expensesData.filter(function(ex) { return ex.id !== tempId; });
        window.store.expenses = _expensesData;
        removeExpenseItem(tempId);
      } else if (oldItem) {
        // Restore old state
        var idx = _expensesData.findIndex(function(ex) { return String(ex.id) === String(oldItem.id); });
        if (idx !== -1) _expensesData[idx] = oldItem;
        window.store.expenses = _expensesData;
        updateExpenseItem(oldItem);
      }
      updateExpensesSummary();
      checkExpensesEmpty();
      rebuildCategoryTabs();
    },

    onSuccess: function(result) {
      if (btnState) restoreButtonLoading(btnState);
      var realItem = result.expense || result;

      if (isNew) {
        // Replace temp item with real server-assigned item
        var tIdx = _expensesData.findIndex(function(ex) { return ex.id === tempId; });
        if (tIdx !== -1) {
          _expensesData[tIdx] = realItem;
          window.store.expenses[tIdx] = realItem;
          // Replace temp card with real one (update attributes)
          var tempCard = document.querySelector('[data-expense-id="' + tempId + '"]');
          if (tempCard) {
            tempCard.setAttribute('data-expense-id', realItem.id);
            // Update onclick handlers
            var btns = tempCard.querySelectorAll('button');
            if (btns[0]) btns[0].setAttribute('onclick', 'editExpense(' + realItem.id + ')');
            if (btns[1]) btns[1].setAttribute('onclick', 'deleteExpense(' + realItem.id + ')');
            tempCard.classList.remove('optimistic-pending');
            tempCard.style.opacity = '';
            tempCard.style.pointerEvents = '';
          }
        }
      }
    },

    onError: function() {
      if (btnState) restoreButtonLoading(btnState);
    }
  });
}

function deleteExpense(id) {
  if (!confirm('Xóa chi phí này?')) return;

  // Snapshot deleted item for rollback
  var deletedItem = Object.assign({}, _expensesData.find(function(e) { return String(e.id) === String(id); }));
  if (!deletedItem) return;

  // Disable the delete button on the card
  var card = document.querySelector('[data-expense-id="' + id + '"]');
  var deleteBtn = card ? card.querySelector('.text-danger') : null;
  var btnState = deleteBtn ? setButtonLoading(deleteBtn) : null;

  optimisticMutate({
    request: function() {
      return fetch('/api/expenses/' + id, { method: 'DELETE', cache: 'no-store' });
    },

    applyOptimistic: function() {
      _expensesData = _expensesData.filter(function(e) { return String(e.id) !== String(id); });
      window.store.expenses = _expensesData;
      removeExpenseItem(id);
      updateExpensesSummary();
      checkExpensesEmpty();
      rebuildCategoryTabs();
    },

    rollback: function() {
      // Restore deleted item
      _expensesData.unshift(deletedItem);
      window.store.expenses.unshift(deletedItem);
      renderExpenseItem(deletedItem, { prepend: true });
      updateExpensesSummary();
      checkExpensesEmpty();
      rebuildCategoryTabs();
    },

    onSuccess: function() {
      if (btnState) restoreButtonLoading(btnState);
    },

    onError: function() {
      if (btnState) restoreButtonLoading(btnState);
    }
  });
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
    html += '<button type="button" class="emoji-btn text-xl px-1 py-0.5 rounded hover:bg-muted transition" ' +
            'onclick="selectEmoji(\'' + _emojiList[i].replace(/'/g, "\\'") + '\')" ' +
            'data-emoji="' + _emojiList[i] + '">' + _emojiList[i] + '</button>';
  }
  picker.innerHTML = html;
}

function selectEmoji(emoji) {
  document.getElementById('categoryIcon').value = emoji;
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
  document.getElementById('categoryName').value = '';
  document.getElementById('categoryIcon').value = '📋';
  selectEmoji('📋');
  renderEmojiPicker();
  var m = document.getElementById('categoryModal');
  m.classList.remove('hidden');
  m.classList.add('flex');
  document.getElementById('categoryName').focus();
}

function hideCategoryModal() {
  var m = document.getElementById('categoryModal');
  if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
}

function saveCategory(e) {
  e.preventDefault();
  var name = document.getElementById('categoryName').value.trim();
  var icon = document.getElementById('categoryIcon').value || '📋';

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
    .then(function(r) { return r.json(); })
    .then(function(result) {
      // Reload categories then refresh select and auto-select
      return fetch('/api/expenses/categories/all')
        .then(function(r2) { return r2.json(); })
        .then(function(data) {
          _customCategories = Array.isArray(data) ? data : [];
          rebuildExpenseCategorySelect();
          rebuildCategoryTabs();
          renderSummaryCards(_getSummaryByCategory());

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

// ── Category tabs ────────────────────────────────────────────────────────────

function rebuildCategoryTabs() {
  var container = document.getElementById('categoryTabs');
  if (!container) return;

  var html = '<button onclick="filterCategory(\'all\')" class="cat-tab ' + (_currentCategory === 'all' ? 'active' : '') + ' px-3 py-1.5 rounded-lg text-sm whitespace-nowrap" data-cat="all">Tất cả</button>';

  for (var i = 0; i < _defaultCategories.length; i++) {
    var cat = _defaultCategories[i];
    html += '<button onclick="filterCategory(\'' + cat.name + '\')" class="cat-tab ' + (_currentCategory === cat.name ? 'active' : '') + ' px-3 py-1.5 rounded-lg text-sm whitespace-nowrap" data-cat="' + cat.name + '" data-icon="' + cat.icon + '">' + cat.icon + ' ' + cat.label + '</button>';
  }

  for (var j = 0; j < _customCategories.length; j++) {
    var cat = _customCategories[j];
    html += '<button onclick="filterCategory(\'' + cat.name.replace(/'/g, "\\'") + '\')" class="cat-tab ' + (_currentCategory === cat.name ? 'active' : '') + ' px-3 py-1.5 rounded-lg text-sm whitespace-nowrap" data-cat="' + cat.name + '" data-icon="' + (cat.icon || '📋') + '">' + (cat.icon || '📋') + ' ' + cat.name + '</button>';
  }

  container.innerHTML = html;
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
  for (var i = 0; i < _expensesData.length; i++) {
    var cat = _expensesData[i].category || 'other';
    summary[cat] = (summary[cat] || 0) + (Number(_expensesData[i].amount) || 0);
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
