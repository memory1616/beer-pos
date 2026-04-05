// BeerPOS Expenses Page
// PERFORMANCE: Separated from HTML, lazy loaded on /expenses route
var _expensesData = [];
var _currentCategory = 'all';
var _currentMonth = '';

var _categoryIcons = { fuel: '⛽', food: '🍜', repair: '🔧', other: '📦' };
var _categoryLabels = { fuel: 'Xăng', food: 'Ăn uống', repair: 'Sửa chữa', other: 'Khác' };

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
  list.innerHTML = '<div class="text-center text-muted py-8">Đang tải...</div>';

  var parts = monthStr.split('-');
  var year = parts[0];
  var month = parts[1];

  var lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  var startDate = year + '-' + month + '-01';
  var endDate = year + '-' + month + '-' + String(lastDay).padStart(2, '0');

  // Fetch both expenses and custom categories in parallel
  Promise.all([
    fetch('/api/expenses?startDate=' + startDate + '&endDate=' + endDate).then(function(r) { return r.json(); }),
    fetch('/api/expenses/categories/all').then(function(r) { return r.json(); })
  ])
    .then(function(results) {
      _expensesData = Array.isArray(results[0]) ? results[0] : (results[0].expenses || []);
      _customCategories = Array.isArray(results[1]) ? results[1] : [];
      rebuildCategoryTabs();
      updateTotal();
      renderExpenses();
    })
    .catch(function(e) {
      document.getElementById('expensesList').innerHTML =
        '<div class="text-center text-danger py-8">Lỗi: ' + e.message + '</div>';
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
    : _currentCategory === 'other'
      ? _expensesData.filter(function(e) {
          var cat = e.category || 'other';
          return cat === 'other' && !_customCategories.some(function(c) { return c.name === cat; });
        })
      : _expensesData.filter(function(e) { return e.category === _currentCategory; });

  if (filtered.length === 0) {
    container.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  // Render summary by category
  var summary = {};
  for (var i = 0; i < _expensesData.length; i++) {
    var cat = _expensesData[i].category || 'other';
    summary[cat] = (summary[cat] || 0) + (Number(_expensesData[i].amount) || 0);
  }
  renderSummaryCards(summary);

  // Render list
  var html = [];
  for (var j = 0; j < filtered.length; j++) {
    var e = filtered[j];
    var icon = _categoryIcons[e.category] || '📦';
    var catLabel = _categoryLabels[e.category] || e.category || 'Khác';
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
  var cats = ['fuel', 'food', 'repair', 'other'];
  var html = [];
  for (var i = 0; i < cats.length; i++) {
    var cat = cats[i];
    var icon = _categoryIcons[cat];
    var label = _categoryLabels[cat];
    var amt = summary[cat] || 0;
    html.push(
      '<div class="card p-3 text-center" onclick="filterCategory(\'' + cat + '\')" style="cursor:pointer">' +
        '<div class="text-xl mb-1">' + icon + '</div>' +
        '<div class="text-sm text-muted">' + label + '</div>' +
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
  document.getElementById('modalTitle').textContent = 'Thêm chi phí';
  document.getElementById('expenseId').value = '';
  document.getElementById('expenseForm').reset();
  document.getElementById('expenseAmount').value = '';
  var m = document.getElementById('expenseModal');
  m.classList.remove('hidden');
  m.classList.add('flex');
}

function editExpense(id) {
  var exp = _expensesData.find(function(e) { return String(e.id) === String(id); });
  if (!exp) return;
  document.getElementById('modalTitle').textContent = 'Sửa chi phí';
  document.getElementById('expenseId').value = id;
  document.getElementById('expenseAmount').value = formatExpenseAmountField(
    String(Math.round(Number(exp.amount) || 0))
  );
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
  fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      hideExpenseModal();
      loadExpenses(_currentMonth);
    })
    .catch(function(err) { alert('Lỗi: ' + err.message); });
}

function deleteExpense(id) {
  if (!confirm('Xóa chi phí này?')) return;
  fetch('/api/expenses/' + id, { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function() { loadExpenses(_currentMonth); })
    .catch(function(err) { alert('Lỗi: ' + err.message); });
}

// ── Custom expense categories ──────────────────────────────────────────────

var _customCategories = [];

function showAddCategoryModal() {
  document.getElementById('categoryName').value = '';
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
  if (!name || name.length < 2) {
    alert('Tên loại chi phí phải có ít nhất 2 ký tự.');
    return;
  }
  fetch('/api/expenses/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name })
  })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      hideCategoryModal();
      loadCustomCategories();
      alert('Đã thêm loại chi phí: ' + result.name);
    })
    .catch(function(err) { alert('Lỗi: ' + err.message); });
}

function loadCustomCategories() {
  fetch('/api/expenses/categories/all')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _customCategories = Array.isArray(data) ? data : [];
      rebuildCategoryTabs();
    })
    .catch(function() {});
}

function rebuildCategoryTabs() {
  // Build list of custom category names
  var customNames = _customCategories.map(function(c) { return c.name; });

  // Build HTML for each custom category as a new tab
  var customHtml = customNames.map(function(name) {
    return '<button data-custom-cat="' + name + '" class="cat-tab px-3 py-1.5 rounded-lg text-sm whitespace-nowrap">' + name + '</button>';
  }).join('');

  // Insert after the "Khác" button, before "+ Thêm loại"
  var addBtn = document.querySelector('[onclick="showAddCategoryModal()"]');
  if (addBtn && addBtn.parentNode) {
    var container = addBtn.parentNode;
    // Remove old custom tabs
    var oldCustoms = container.querySelectorAll('[data-custom-cat]');
    for (var i = 0; i < oldCustoms.length; i++) {
      oldCustoms[i].remove();
    }
    // Insert new ones before the add button
    var placeholder = document.createElement('span');
    placeholder.innerHTML = customHtml;
    while (placeholder.firstChild) {
      container.insertBefore(placeholder.firstChild, addBtn);
    }
  }

  // Wire up new custom filter clicks
  var allCustomBtns = document.querySelectorAll('[data-custom-cat]');
  for (var j = 0; j < allCustomBtns.length; j++) {
    allCustomBtns[j].setAttribute('onclick', 'filterCategory(\'' + allCustomBtns[j].getAttribute('data-custom-cat').replace(/'/g, "\\'") + '\')');
  }
}

// Override filterCategory to handle custom categories
function filterCategory(cat) {
  _currentCategory = cat;
  var tabs = document.querySelectorAll('.cat-tab');
  for (var i = 0; i < tabs.length; i++) {
    var customCat = tabs[i].getAttribute('data-custom-cat');
    var isActive = customCat ? customCat === cat : tabs[i].dataset.cat === cat;
    tabs[i].classList.toggle('active', isActive);
  }
  renderExpenses();
}

// custom categories are loaded in loadExpenses() together with expense data
