const express = require('express');
const router = express.Router();
const db = require('../database');
const logger = require('../src/utils/logger');

function formatVND(amount) {
  if (amount === null || amount === undefined || amount === '') return '0 đ';
  const num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

// GET /expenses - Main expenses page (lọc theo tháng/năm giống /report/profit-customer)
router.get('/', (req, res, next) => {
  try {
  const today = new Date().toISOString().split('T')[0];
  const { month, year } = req.query;

  const now = new Date();
  let startStr;
  let endStr;
  let labelThangNam;

  if (month && year) {
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const lastDay = new Date(y, m, 0).getDate();
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const thangLabels = ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];
    labelThangNam = thangLabels[m] + ' / ' + y;
  } else {
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const lastDay = new Date(y, m, 0).getDate();
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const thangLabels = ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];
    labelThangNam = thangLabels[m] + ' / ' + y;
  }

  const startDay = startStr.split(' ')[0];
  const endDay = endStr.split(' ')[0];

  const monthExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses
    WHERE date(date) >= date(?) AND date(date) <= date(?)
  `).get(startDay, endDay);

  const categorySummary = db.prepare(`
    SELECT category, SUM(amount) as total
    FROM expenses
    WHERE date(date) >= date(?) AND date(date) <= date(?)
    GROUP BY category
    ORDER BY total DESC
  `).all(startDay, endDay);

  const recentExpenses = db.prepare(`
    SELECT * FROM expenses
    WHERE date(date) >= date(?) AND date(date) <= date(?)
    ORDER BY date DESC, id DESC LIMIT 50
  `).all(startDay, endDay);

  const expenseCountRow = db.prepare(`
    SELECT COUNT(*) as n FROM expenses
    WHERE date(date) >= date(?) AND date(date) <= date(?)
  `).get(startDay, endDay);
  const expenseCount = expenseCountRow ? expenseCountRow.n : 0;

  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const selectedMonth = month ? parseInt(month, 10) : currentMonth;
  const selectedYear = year ? parseInt(year, 10) : currentYear;

  const monthOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) =>
    '<option value="' + m + '"' + (m === selectedMonth ? ' selected' : '') + '>Tháng ' + m + '</option>'
  ).join('');
  const yearSpan = 8;
  const yearOptions = Array.from({ length: yearSpan }, (_, i) => currentYear - i).map((y) =>
    '<option value="' + y + '"' + (y === selectedYear ? ' selected' : '') + '>' + y + '</option>'
  ).join('');

  const vnForLabel = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const curYm = vnForLabel.getUTCFullYear() * 100 + (vnForLabel.getUTCMonth() + 1);
  const selYm = selectedYear * 100 + selectedMonth;
  const totalExpenseLabel = curYm === selYm ? 'Tổng chi phí tháng này' : ('Tổng chi phí — ' + labelThangNam);

  // Bộ lọc trùng markup/style với /report/profit-customer
  const selectStyle = 'flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;';
  const filterBlockHtml =
    '<div style="background: #fef3c7; border-radius: 16px; border: 2px solid #f59e0b; padding: 16px; margin-bottom: 16px; overflow: visible;">' +
    '<div class="flex items-center gap-2 mb-3">' +
    '<span style="color: #92400e; font-size: 14px; font-weight: 600;">📅 Theo tháng - năm</span>' +
    '</div>' +
    '<div class="flex gap-2 items-center">' +
    '<select id="expSelMonth" style="' + selectStyle + '">' +
    monthOptions +
    '</select>' +
    '<select id="expSelYear" style="' + selectStyle + '">' +
    yearOptions +
    '</select>' +
    '<button type="button" onclick="applyExpMonthYear()" style="background: #ea580c; color: white; border: none; border-radius: 8px; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap;">Xem</button>' +
    '</div>' +
    '<div class="text-xs text-muted mt-1">Đang xem: ' + labelThangNam + '</div>' +
    '</div>';

  const summaryBlockHtml =
    '<div class="card card--summary-red mb-4 rounded-2xl overflow-hidden shadow-lg">' +
    '<div class="grid grid-cols-2 gap-3 text-center py-4 px-4">' +
    '<div>' +
    '<div class="sum-label">' + totalExpenseLabel + '</div>' +
    '<div class="sum-value">' + formatVND(monthExpenses.total) + '</div>' +
    '</div>' +
    '<div>' +
    '<div class="sum-label">Giao dịch</div>' +
    '<div class="sum-value">' + expenseCount + '</div>' +
    '</div>' +
    '</div>' +
    '</div>';

  // Expense categories (defaults + custom from DB)
  const defaultCategories = ['Xăng dầu', 'Khấu hao', 'Hư hỏng', 'Điện nước', 'Nhân công', 'Thuê mặt bằng', 'Bảo trì', 'Marketing', 'Khác'];

  // Load custom categories from DB
  let customCategories = [];
  try {
    const rows = db.prepare('SELECT name, icon FROM expense_categories ORDER BY name ASC').all();
    customCategories = rows.map(r => ({ name: r.name, icon: r.icon || '📋' }));
  } catch (e) {
    logger.error('Error loading custom expense categories', { error: e.message });
  }

  const allCategories = [...defaultCategories, ...customCategories.map(c => c.name)];

  const categoryIcons = {
    'Xăng dầu': '⛽',
    'Khấu hao': '📉',
    'Hư hỏng': '🔧',
    'Điện nước': '💡',
    'Nhân công': '👷',
    'Thuê mặt bằng': '🏪',
    'Bảo trì': '🛠️',
    'Marketing': '📢',
    'Khác': '📋'
  };
  // Add custom category icons
  for (var ci = 0; ci < customCategories.length; ci++) {
    categoryIcons[customCategories[ci].name] = customCategories[ci].icon;
  }

  const categories = allCategories;
  const customCategoriesJson = JSON.stringify(customCategories.map(function(c) { return c.name; }));
  let categoryHtml;
  if (categorySummary.length > 0) {
    categoryHtml = categorySummary.map(c => {
      const icon = categoryIcons[c.category] || '📋';
      return '<div class="card card--list-item">' +
        '<div class="flex justify-between items-center">' +
        '<div class="flex items-center gap-3">' +
          '<span class="text-xl">' + icon + '</span>' +
          '<span class="font-bold text-main">' + c.category + '</span>' +
        '</div>' +
        '<div class="money text-money"><span class="value font-bold tabular-nums">' + formatVND(c.total) + '</span><span class="unit">đ</span></div>' +
        '</div></div>';
    }).join('');
  } else {
    categoryHtml = '<div class="card card--list-item text-center py-4">Chưa có chi phí trong tháng này</div>';
  }

  // Build recent expenses HTML
  let expensesHtml = '';
  if (recentExpenses.length > 0) {
    expensesHtml = recentExpenses.map(e => {
      const dateStr = new Date(e.date).toLocaleDateString('vi-VN');
      const desc = e.description || '';
      const icon = categoryIcons[e.category] || '📋';
      return '<div class="card card--list-item" data-id="' + e.id + '">' +
        '<div class="flex justify-between items-start gap-2">' +
        '<div class="flex items-start gap-3 flex-1 min-w-0">' +
        '<span class="text-2xl flex-shrink-0">' + icon + '</span>' +
        '<div class="flex-1 min-w-0">' +
        '<div class="font-bold text-main">' + e.category + '</div>' +
        (desc ? '<div class="text-sm text-muted">' + desc + '</div>' : '') +
        '<div class="text-xs text-muted mt-0.5">' + dateStr + '</div>' +
        '</div>' +
        '</div>' +
        '<div class="text-right flex-shrink-0">' +
        '<div class="money text-money"><span class="value font-bold tabular-nums">' + formatVND(e.amount) + '</span><span class="unit">đ</span></div>' +
        '<div class="flex gap-2 mt-1 justify-end">' +
        '<button type="button" onclick="editExpense(' + e.id + ', \'' + (e.category || '').replace(/'/g, "\\'").replace(/"/g, '\\"') + '\', ' + e.amount + ', \'' + e.date + '\', \'' + (e.description || '').replace(/'/g, "\\'").replace(/"/g, '\\"') + '\')" class="btn btn-ghost btn-sm">Sửa</button>' +
        '<button type="button" onclick="deleteExpense(' + e.id + ')" class="btn btn-danger btn-sm">Xóa</button>' +
        '</div>' +
        '</div>' +
        '</div></div>';
    }).join('');
  } else {
    expensesHtml = '<div class="card card--list-item text-center py-4">Chưa có chi phí trong tháng này</div>';
  }

  const optionsHtml = categories.map(c => '<option value="' + c + '">' + c + '</option>').join('');

  res.send('<!DOCTYPE html>' +
'<html lang="vi">' +
'<head>' +
'  <meta charset="UTF-8">' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">' +
'  <title>Chi phí</title>' +
'  <link rel="manifest" href="/manifest.json">' +
'  <meta name="theme-color" content="#f59e0b">' +
'  <meta name="mobile-web-app-capable" content="yes">' +
'  <link rel="apple-touch-icon" href="/icon-192.png">' +
'  <link rel="icon" type="image/png" href="/icon-192.png">' +
'  <link rel="stylesheet" href="/css/tailwind.css">' +
'  <link rel="stylesheet" href="/css/unified.css?v=20260414">' +
'  <script src="/js/dark-mode.js"></script>' +
'  <script src="/js/auth.js"></script>' +
'  <script src="/js/layout.js?v=20260403"></script>' +
'  <script>requireAuth();</script>' +
'  <style>' +
'    #addCategoryModal { z-index: 60; }' +
'    .animate-fade { animation: fade 0.3s ease-in; }' +
'    @keyframes fade { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }' +
'    .pb-safe { padding-bottom: env(safe-area-inset-bottom, 20px); }' +
'    .pt-safe { padding-top: env(safe-area-inset-top, 20px); }' +
'    .bottomnav { max-width: 500px; margin: auto; }' +
'    button, a { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }' +
'    button:active { transform: scale(0.96); }' +
'    .filter-wrap { overflow: visible !important; }' +
'  </style>' +
'</head>' +
'<body class="bg-bg text-main min-h-screen pb-24">' +
'  <header class="sticky top-0 bg-card border-b border-muted z-50">' +
'    <div class="flex items-center justify-between px-4 h-12 max-w-md mx-auto">' +
'      <div class="flex items-center gap-2">' +
'        <a href="/report" class="text-muted hover:text-main" title="Báo cáo">←</a>' +
'        <span class="font-semibold text-sm">Chi phí</span>' +
'      </div>' +
'    </div>' +
'  </header>' +
'  <main class="p-4 pt-14 pb-24 max-w-md mx-auto">' +
    filterBlockHtml +
    summaryBlockHtml +
'    <div class="section-title">📊 Chi phí theo loại</div>' +
'    <div class="space-y-2 mb-4">' + categoryHtml + '</div>' +
'    <div class="section-title">📋 Chi phí gần đây</div>' +
'    <p class="text-xs text-muted mb-2">Trong kỳ đã chọn (tối đa 50 dòng)</p>' +
'    <div class="space-y-2">' + expensesHtml + '</div>' +
'  </main>' +
'  <div id="bottomNavContainer"></div>' +
'' +
'  <!-- Floating Add Button -->' +
'  <button onclick="showModal(\'addExpenseModal\')" class="fixed bottom-24 right-4 w-14 h-14 bg-blue-600 text-white rounded-full shadow-xl flex items-center justify-center text-2xl font-bold transition-all duration-200 hover:scale-105 z-40">' +
'    +' +
'  </button>' +
'' +
'  <!-- Add Expense Modal -->' +
'  <div id="addExpenseModal" class="fixed inset-0 bg-overlay hidden items-center justify-center p-4 z-50">' +
'    <div class="card p-6 max-w-sm w-full">' +
'      <h2 id="expenseModalTitle" class="text-xl font-semibold mb-4">Thêm chi phí</h2>' +
'      <form id="addExpenseForm" class="space-y-4">' +
'        <input type="hidden" id="expenseId">' +
'        <div>' +
'          <label class="block text-sm font-medium text-main mb-1">Loại chi phí</label>' +
'          <div class="flex gap-2 items-start">' +
'            <select name="category" required id="catSelect" onchange="onCatChange(this.value)" class="flex-1 w-full border border-muted rounded-lg px-4 py-3 text-base focus:ring-2 focus:ring-primary">' +
'              <option value="">-- Chọn loại --</option>' +
              optionsHtml +
'              <option value="__custom__">+ Thêm loại mới...</option>' +
'            </select>' +
'            <button type="button" onclick="showAddCategoryModal()" title="Thêm loại chi phí" class="flex-shrink-0 w-10 h-10 bg-info/20 text-info rounded-lg flex items-center justify-center text-lg font-bold mt-0.5 transition-colors">+</button>' +
'          </div>' +
'          <input type="text" id="customCatInput" placeholder="Nhập tên loại chi phí mới..." class="hidden mt-2 w-full border border-muted rounded-lg px-4 py-3 text-base focus:ring-2 focus:ring-primary">' +
'        </div>' +
'        <div>' +
'          <label class="block text-sm font-medium text-main mb-1">Số tiền (đ)</label>' +
'          <input type="text" name="amount" required min="1000" step="1000" data-format-number class="w-full border border-muted rounded-lg px-4 py-3 text-lg focus:ring-2 focus:ring-primary" placeholder="Nhập số tiền" inputmode="decimal">' +
'        </div>' +
'        <div>' +
'          <label class="block text-sm font-medium text-main mb-1">Ngày</label>' +
'          <input type="date" name="date" required value="' + today + '" class="w-full border border-muted rounded-lg px-4 py-3 text-lg focus:ring-2 focus:ring-primary">' +
'        </div>' +
'        <div>' +
'          <label class="block text-sm font-medium text-main mb-1">Ghi chú</label>' +
'          <textarea name="description" rows="2" class="w-full border border-muted rounded-lg px-4 py-2 focus:ring-2 focus:ring-primary" placeholder="Ghi chú thêm (tùy chọn)"></textarea>' +
'        </div>' +
'      </form>' +
'      <div class="flex gap-2 mt-4">' +
'        <button type="button" onclick="hideModal(\'addExpenseModal\')" class="flex-1 btn btn-ghost">Hủy</button>' +
'        <button type="button" onclick="submitExpense()" class="flex-1 btn btn-primary">Lưu</button>' +
'      </div>' +
'    </div>' +
'  </div>' +
'' +
'  <!-- Add Category Modal (inline) -->' +
'  <div id="addCategoryModal" class="fixed inset-0 bg-overlay hidden items-center justify-center p-4">' +
'    <div class="card p-6 max-w-sm w-full">' +
'      <h3 class="text-lg font-bold text-main mb-4">Thêm loại chi phí mới</h3>' +
'      <input type="text" id="newCategoryName" maxlength="30" placeholder="VD: Thuê xe, Quảng cáo..." class="w-full border border-muted rounded-lg px-4 py-3 text-base focus:ring-2 focus:ring-primary focus:outline-none mb-3">' +
'      <p id="newCatError" class="hidden text-danger text-sm mb-2"></p>' +
'      <div class="flex gap-2">' +
'        <button onclick="hideAddCategory()" class="flex-1 btn btn-ghost">Hủy</button>' +
'        <button onclick="saveNewCategory()" class="flex-1 btn btn-primary">Lưu</button>' +
'      </div>' +
'    </div>' +
'  </div>' +
'' +
'  <script>' +
'    var categories = ' + JSON.stringify(allCategories) + ';' +
'    var customCategories = ' + customCategoriesJson + ';' +
'    var _today = "' + today + '";' +
'' +
'    function showModal(id) { document.getElementById(id).classList.remove("hidden"); document.getElementById(id).classList.add("flex"); }' +
'    function hideModal(id) { document.getElementById(id).classList.add("hidden"); document.getElementById(id).classList.remove("flex"); }' +
'    function onCatChange(val) { var el = document.getElementById("customCatInput"); if (val === "__custom__") { el.classList.remove("hidden"); el.focus(); } else { el.classList.add("hidden"); el.value = ""; } }' +
'    function showAddCategoryModal() { document.getElementById("newCategoryName").value = ""; document.getElementById("newCatError").classList.add("hidden"); document.getElementById("newCategoryName").classList.remove("border-danger"); document.getElementById("newCategoryName").classList.add("border-muted"); showModal("addCategoryModal"); setTimeout(function() { document.getElementById("newCategoryName").focus(); }, 100); }' +
'    function applyExpMonthYear() {' +
'      var m = document.getElementById("expSelMonth").value;' +
'      var y = document.getElementById("expSelYear").value;' +
'      window.location.href = "/expenses?month=" + m + "&year=" + y;' +
'    }' +
'' +
'    function hideAddCategory() { hideModal("addCategoryModal"); }' +
'    function addCategoryToDropdown(name) { var sel = document.getElementById("catSelect"); if (!sel) return; var opt = document.createElement("option"); opt.value = name; opt.textContent = name; var customOpt = sel.querySelector("option[value=__custom__]"); sel.insertBefore(opt, customOpt || null); }' +
'    function getAllCategories() { return categories.slice(); }' +
'' +
'    function submitExpense() {' +
'      var id = document.getElementById("expenseId").value;' +
'      var form = document.getElementById("addExpenseForm");' +
'      var formData = new FormData(form);' +
'      var cat = formData.get("category");' +
'      if (cat === "__custom__") { cat = document.getElementById("customCatInput").value.trim(); if (!cat) { alert("Vui lòng nhập tên loại chi phí."); return; } }' +
'      var amountEl = form.querySelector("input[name=amount]");' +
'      var amount = parseFloat(amountEl.value.replace(/[^0-9]/g, ""));' +
'      var date = formData.get("date");' +
'      var desc = formData.get("description") || null;' +
'      if (!cat || !amount || !date) { alert("Vui lòng điền đầy đủ thông tin!"); return; }' +
'      var url = "/api/expenses"; var method = "POST";' +
'      if (id) { url = "/api/expenses/" + id; method = "PUT"; }' +
'      fetch(url, { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: cat, amount: amount, date: date, description: desc }) }).then(function(res) { if (res.ok) { hideModal("addExpenseModal"); form.reset(); document.getElementById("expenseId").value = ""; var t = document.querySelector("#addExpenseModal h2"); if (t) t.textContent = "Thêm chi phí"; document.querySelector("input[name=date]").value = _today; location.reload(); } else { return res.json(); } }).then(function(e) { if (e && e.error) alert(e.error); }).catch(function(e) { alert("Lỗi: " + e.message); });' +
'    }' +
'' +
'    function deleteExpense(id) { if (!confirm("Xóa chi phí này?")) return; fetch("/api/expenses/" + id, { method: "DELETE" }).then(function(res) { if (res.ok) location.reload(); else alert("Xóa thất bại"); }).catch(function() { alert("Lỗi kết nối"); }); }' +
'' +
'    function editExpense(id, category, amount, date, description) {' +
'      var form = document.getElementById("addExpenseForm"); if (!form) return;' +
'      var title = document.querySelector("#addExpenseModal h2"); if (title) title.textContent = "Sửa chi phí";' +
'      document.getElementById("expenseId").value = id;' +
'      var catSel = document.getElementById("catSelect");' +
'      if (!categories.includes(category) && !customCategories.includes(category)) { addCategoryToDropdown(category); customCategories.push(category); }' +
'      catSel.value = category;' +
'      onCatChange(category);' +
'      var amountInput = form.querySelector("input[name=amount]"); if (amountInput) amountInput.value = amount;' +
'      var dateInput = form.querySelector("input[name=date]"); if (dateInput) dateInput.value = date;' +
'      var descInput = form.querySelector("textarea[name=description]"); if (descInput) descInput.value = description || "";' +
'      showModal("addExpenseModal");' +
'    }' +
'' +
'    async function saveNewCategory() {' +
'      var input = document.getElementById("newCategoryName");' +
'      var errorEl = document.getElementById("newCatError");' +
'      var name = input.value.trim();' +
'      errorEl.classList.add("hidden");' +
'      input.classList.remove("border-danger"); input.classList.add("border-muted");' +
'      if (!name) { errorEl.textContent = "Vui lòng nhập tên loại chi phí."; errorEl.classList.remove("hidden"); input.classList.add("border-danger"); return; }' +
'      if (name.length < 2) { errorEl.textContent = "Tên loại phải có ít nhất 2 ký tự."; errorEl.classList.remove("hidden"); input.classList.add("border-danger"); return; }' +
'      if (categories.includes(name) || customCategories.includes(name)) { errorEl.textContent = "Loại chi phí này đã tồn tại."; errorEl.classList.remove("hidden"); input.classList.add("border-danger"); return; }' +
'      try {' +
'        var res = await fetch("/api/expenses/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name }) });' +
'        var data = await res.json();' +
'        if (res.ok) { customCategories.push(name); categories.push(name); addCategoryToDropdown(name); hideAddCategory(); var catSel = document.getElementById("catSelect"); catSel.value = name; onCatChange(name); }' +
'        else { errorEl.textContent = data.error || "Không thể thêm loại chi phí."; errorEl.classList.remove("hidden"); input.classList.add("border-danger"); }' +
'      } catch (err) { errorEl.textContent = "Lỗi kết nối: " + err.message; errorEl.classList.remove("hidden"); input.classList.add("border-danger"); }' +
'    }' +
'  </script>' +
'  <script src="/js/numfmt.js"></script>' +
'  <script src="/sync.js"></script>' +
'  <script>' +
'    (function() {' +
'      var el = document.getElementById("bottomNavContainer");' +
'      if (el && typeof getBottomNav === "function") el.innerHTML = getBottomNav("/report");' +
'    })();' +
'  </script>' +
'</body>' +
'</html>');
  } catch (err) {
    logger.error('GET /expenses page failed', { message: err.message, stack: err.stack });
    next(err);
  }
});

module.exports = router;
