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

  fetch('/api/expenses?startDate=' + startDate + '&endDate=' + endDate)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      // API returns array directly (not { expenses: [...] })
      _expensesData = Array.isArray(data) ? data : (data.expenses || []);
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
  var el = document.getElementById('totalAmount');
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
    var catLabel = _categoryLabels[e.category] || 'Khác';
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
          '<div class="font-bold text-danger">' + formatVND(e.amount) + '</div>' +
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
        '<div class="font-bold tabular-nums">' + formatVND(amt) + '</div>' +
      '</div>'
    );
  }
  el.innerHTML = html.join('');
}

function filterCategory(cat) {
  _currentCategory = cat;
  var tabs = document.querySelectorAll('.cat-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].dataset.cat === cat);
  }
  renderExpenses();
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
  var m = document.getElementById('expenseModal');
  m.classList.remove('hidden');
  m.classList.add('flex');
}

function editExpense(id) {
  var exp = _expensesData.find(function(e) { return String(e.id) === String(id); });
  if (!exp) return;
  document.getElementById('modalTitle').textContent = 'Sửa chi phí';
  document.getElementById('expenseId').value = id;
  document.getElementById('expenseAmount').value = exp.amount;
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
  var data = {
    amount: parseFloat(document.getElementById('expenseAmount').value) || 0,
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
