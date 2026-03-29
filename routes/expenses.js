const express = require('express');
const router = express.Router();
const db = require('../database');
const logger = require('../src/utils/logger');

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// GET /expenses - Main expenses page
router.get('/', (req, res, next) => {
  try {
  const today = new Date().toISOString().split('T')[0];
  
  // Get current month stats
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  const startOfMonthStr = startOfMonth.toISOString().split('T')[0];
  
  // Get total expenses this month
  const monthExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ?
  `).get(startOfMonthStr);
  
  // Get expense summary by category this month
  const categorySummary = db.prepare(`
    SELECT category, SUM(amount) as total
    FROM expenses
    WHERE date >= ?
    GROUP BY category
    ORDER BY total DESC
  `).all(startOfMonthStr);
  
  // Get recent expenses
  const recentExpenses = db.prepare(`
    SELECT * FROM expenses ORDER BY date DESC, id DESC LIMIT 20
  `).all();

  // Expense categories (defaults + custom from DB)
  const defaultCategories = ['Xăng dầu', 'Khấu hao', 'Hư hỏng', 'Điện nước', 'Nhân công', 'Thuê mặt bằng', 'Bảo trì', 'Marketing', 'Khác'];

  // Load custom categories from DB
  let customCategories = [];
  try {
    const rows = db.prepare('SELECT name FROM expense_categories ORDER BY name ASC').all();
    customCategories = rows.map(r => r.name);
  } catch (e) {
    logger.error('Error loading custom expense categories', { error: e.message });
  }

  const allCategories = [...defaultCategories, ...customCategories];

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

  const categories = allCategories;
  const customCategoriesJson = JSON.stringify(customCategories);
  if (categorySummary.length > 0) {
    categoryHtml = categorySummary.map(c => {
      const icon = categoryIcons[c.category] || '📋';
      return '<div class="flex justify-between items-center py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors px-2 -mx-2 rounded-lg">' +
        '<div class="flex items-center gap-3">' +
          '<span class="text-xl">' + icon + '</span>' +
          '<span class="text-gray-700 font-medium">' + c.category + '</span>' +
        '</div>' +
        '<span class="font-bold text-red-600">' + formatVND(c.total) + '</span>' +
        '</div>';
    }).join('');
  } else {
    categoryHtml = '<div class="text-gray-500 text-center py-4">Chưa có chi phí nào</div>';
  }

  // Build recent expenses HTML
  let expensesHtml = '';
  if (recentExpenses.length > 0) {
    expensesHtml = recentExpenses.map(e => {
      const dateStr = new Date(e.date).toLocaleDateString('vi-VN');
      const desc = e.description || '';
      const icon = categoryIcons[e.category] || '📋';
      return '<div class="flex justify-between items-center py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors" data-id="' + e.id + '">' +
        '<div class="flex items-center gap-3 flex-1">' +
        '<span class="text-2xl">' + icon + '</span>' +
        '<div class="flex-1">' +
        '<div class="font-semibold text-gray-800">' + e.category + '</div>' +
        '<div class="text-sm text-gray-500">' + desc + '</div>' +
        '<div class="text-xs text-gray-400 mt-0.5">' + dateStr + '</div>' +
        '</div>' +
        '</div>' +
        '<div class="text-right ml-3">' +
        '<div class="font-bold text-red-600 text-lg">' + formatVND(e.amount) + '</div>' +
        '<div class="flex gap-2 mt-1 justify-end">' +
        '<button onclick="editExpense(' + e.id + ', \'' + e.category.replace(/'/g, "\\'") + '\', ' + e.amount + ', \'' + e.date + '\', \'' + (e.description || '').replace(/'/g, "\\'") + '\')" class="text-xs text-blue-500 hover:text-blue-700 px-2 py-1 hover:bg-blue-50 rounded">Sửa</button>' +
        '<button onclick="deleteExpense(' + e.id + ')" class="text-xs text-red-400 hover:text-red-600 px-2 py-1 hover:bg-red-50 rounded">Xóa</button>' +
        '</div>' +
        '</div>' +
        '</div>';
    }).join('');
  } else {
    expensesHtml = '<div class="text-gray-500 text-center py-4">Chưa có chi phí nào</div>';
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
'  <link rel="stylesheet" href="/css/unified.css">' +
'  <script src="/js/dark-mode.js"><\/script>' +
'  <script src="/js/auth.js"><\/script>' +
'  <script src="/js/layout.js?v=20260329"><\/script>' +
'  <script>requireAuth();<\/script>' +
'  <style>' +
'    /* z-[60] không có trong tailwind.css đã build — modal loại chi phí phải nằm trên modal thêm chi phí (z-50) */' +
'    #addCategoryModal { z-index: 60; }' +
'    .animate-fade { animation: fade 0.3s ease-in; }' +
'    @keyframes fade { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }' +
'    .pb-safe { padding-bottom: env(safe-area-inset-bottom, 20px); }' +
'    .pt-safe { padding-top: env(safe-area-inset-top, 20px); }' +
'    .bottomnav { max-width: 500px; margin: auto; left: 0; right: 0; }' +
'    button, a { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }' +
'    button:active { transform: scale(0.96); }' +
'  </style>' +
'</head>' +
'<body class="bg-gray-100 text-gray-800 min-h-screen pb-24">' +
'  <div id="app"></div>' +
'' +
'  <!-- Floating Add Button -->' +
'  <button onclick="showModal(\'addExpenseModal\')" class="fixed bottom-24 right-4 w-14 h-14 bg-red-600 text-white rounded-full shadow-xl flex items-center justify-center text-2xl font-bold transition-all duration-200 hover:scale-105 z-40">' +
'    +' +
'  </button>' +
'' +
'  <!-- Add Expense Modal -->' +
'  <div id="addExpenseModal" class="fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center p-4 z-50">' +
'    <div class="bg-white rounded-lg p-6 max-w-sm w-full">' +
'      <h2 id="expenseModalTitle" class="text-xl font-semibold mb-4">Thêm chi phí</h2>' +
'      <form id="addExpenseForm" class="space-y-4">' +
'        <input type="hidden" id="expenseId">' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-700 mb-1">Loại chi phí</label>' +
'          <div class="flex gap-2 items-start">' +
'            <select name="category" required id="catSelect" onchange="onCatChange(this.value)" class="flex-1 w-full border border-gray-300 rounded-lg px-4 py-3 text-base focus:ring-2 focus:ring-red-500">' +
'              <option value="">-- Chọn loại --</option>' +
              optionsHtml +
'              <option value="__custom__">+ Thêm loại mới...</option>' +
'            </select>' +
'            <button type="button" onclick="showAddCategoryModal()" title="Thêm loại chi phí" class="flex-shrink-0 w-10 h-10 bg-red-100 hover:bg-red-200 text-red-600 rounded-lg flex items-center justify-center text-lg font-bold mt-0.5 transition-colors">+</button>' +
'          </div>' +
'          <input type="text" id="customCatInput" placeholder="Nhập tên loại chi phí mới..." class="hidden mt-2 w-full border border-gray-300 rounded-lg px-4 py-3 text-base focus:ring-2 focus:ring-red-500">' +
'        </div>' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-700 mb-1">Số tiền (VNĐ)</label>' +
'          <input type="text" name="amount" required min="1000" step="1000" data-format-number class="w-full border border-gray-300 rounded-lg px-4 py-3 text-lg focus:ring-2 focus:ring-red-500" placeholder="Nhập số tiền" inputmode="decimal">' +
'        </div>' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-700 mb-1">Ngày</label>' +
'          <input type="date" name="date" required value="' + today + '" class="w-full border border-gray-300 rounded-lg px-4 py-3 text-lg focus:ring-2 focus:ring-red-500">' +
'        </div>' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-700 mb-1">Ghi chú</label>' +
'          <textarea name="description" rows="2" class="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-red-500" placeholder="Ghi chú thêm (tùy chọn)"></textarea>' +
'        </div>' +
'      </form>' +
'      <div class="flex gap-2 mt-4">' +
'        <button type="button" onclick="hideModal(\'addExpenseModal\')" class="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-semibold py-3 rounded-lg">Hủy</button>' +
'        <button type="button" onclick="submitExpense()" class="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-lg">Lưu</button>' +
'      </div>' +
'    </div>' +
'  </div>' +
'' +
'  <!-- Add Category Modal (inline) -->' +
'  <div id="addCategoryModal" class="fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center p-4">' +
'    <div class="bg-white rounded-xl p-6 max-w-sm w-full">' +
'      <h3 class="text-lg font-bold text-gray-800 mb-4">Thêm loại chi phí mới</h3>' +
'      <input type="text" id="newCategoryName" maxlength="30" placeholder="VD: Thuê xe, Quảng cáo..." class="w-full border border-gray-300 rounded-lg px-4 py-3 text-base focus:ring-2 focus:ring-red-500 focus:outline-none mb-3">' +
'      <p id="newCatError" class="hidden text-red-500 text-sm mb-2"></p>' +
'      <div class="flex gap-2">' +
'        <button onclick="hideAddCategory()" class="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold py-3 rounded-lg transition-colors">Hủy</button>' +
'        <button onclick="saveNewCategory()" class="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-lg transition-colors">Lưu</button>' +
'      </div>' +
'    </div>' +
'  </div>' +
'' +
'  <script>' +
'    const categories = ' + JSON.stringify(allCategories) + ';' +
'    const customCategories = ' + customCategoriesJson + ';' +
'    ' +
'    (async () => {' +
'      document.getElementById(\'app\').innerHTML = ' +
'        getHeader(\'Chi phí\', \'💸\') +' +
'        getContent(`' +
'          <!-- Month Summary -->' +
'          <div class="mb-4 p-5 bg-gradient-to-r from-red-500 to-red-600 rounded-xl shadow-lg text-white">' +
'            <div class="text-sm opacity-90">Tổng chi phí tháng này</div>' +
'            <div class="text-3xl font-bold" id="monthTotal">' + formatVND(monthExpenses.total) + '</div>' +
'          </div>' +
'' +
'          <!-- Category Summary -->' +
'          <div class="bg-white rounded-xl shadow-sm border p-4 mb-4">' +
'            <h3 class="font-semibold text-gray-700 mb-3">📊 Chi phí theo loại</h3>' +
'            <div id="categoryList">' +
              categoryHtml +
'            </div>' +
'          </div>' +
'' +
'          <!-- Recent Expenses -->' +
'          <div class="bg-white rounded-xl shadow-sm border p-4">' +
'            <h3 class="font-semibold text-gray-700 mb-3">📋 Chi phí gần đây</h3>' +
'            <div id="expenseList">' +
              expensesHtml +
'            </div>' +
'          </div>' +
'        `) +' +
'        getBottomNav(\'/expenses\');' +
'    })();' +
'  <' + '/script>' +
'' +
'  <script>' +
'    function formatVND(amount) {' +
'      return new Intl.NumberFormat(\'vi-VN\', { style: \'currency\', currency: \'VND\' }).format(amount);' +
'    }' +
'' +
'    function showModal(id) {' +
'      document.getElementById(id).classList.remove(\'hidden\');' +
'      document.getElementById(id).classList.add(\'flex\');' +
'    }' +
'' +
'    function hideModal(id) {' +
'      document.getElementById(id).classList.add(\'hidden\');' +
'      document.getElementById(id).classList.remove(\'flex\');' +
'    }' +
'' +
'    function editExpense(id, category, amount, date, description) {' +
'      document.querySelector(\'#addExpenseModal h2\').textContent = \'Sửa chi phí\';' +
'      document.getElementById(\'expenseId\').value = id;' +
'      const catSelect = document.getElementById(\'catSelect\');' +
'      // Nếu loại chưa có trong dropdown, thêm vào (trường hợp hiếm gặp)' +
'      if (!categories.includes(category) && !customCategories.includes(category)) {' +
'        addCategoryToDropdown(category);' +
'        customCategories.push(category);' +
'      }' +
'      catSelect.value = category;' +
'      onCatChange(category);' +
'      document.querySelector(\'input[name="amount"]\').value = amount;' +
'      document.querySelector(\'input[name="date"]\').value = date;' +
'      document.querySelector(\'textarea[name="description"]\').value = description || \'\';' +
'      showModal(\'addExpenseModal\');' +
'    }' +

'    function onCatChange(val) {' +
'      const customInput = document.getElementById(\'customCatInput\');' +
'      if (val === \'__custom__\') {' +
'        customInput.classList.remove(\'hidden\');' +
'        customInput.focus();' +
'      } else {' +
'        customInput.classList.add(\'hidden\');' +
'        customInput.value = \'\';' +
'      }' +
'    }' +

'    function showAddCategoryModal() {' +
'      document.getElementById(\'newCategoryName\').value = \'\';' +
'      document.getElementById(\'newCatError\').classList.add(\'hidden\');' +
'      document.getElementById(\'newCategoryName\').classList.remove(\'border-red-400\');' +
'      document.getElementById(\'newCategoryName\').classList.add(\'border-gray-300\');' +
'      showModal(\'addCategoryModal\');' +
'      setTimeout(() => document.getElementById(\'newCategoryName\').focus(), 100);' +
'    }' +

'    function hideAddCategory() {' +
'      hideModal(\'addCategoryModal\');' +
'    }' +

'    async function saveNewCategory() {' +
'      const input = document.getElementById(\'newCategoryName\');' +
'      const errorEl = document.getElementById(\'newCatError\');' +
'      const name = input.value.trim();' +
'      errorEl.classList.add(\'hidden\');' +
'      input.classList.remove(\'border-red-400\');' +
'      input.classList.add(\'border-gray-300\');' +
'      if (!name) {' +
'        errorEl.textContent = \'Vui lòng nhập tên loại chi phí.\';' +
'        errorEl.classList.remove(\'hidden\');' +
'        input.classList.add(\'border-red-400\');' +
'        return;' +
'      }' +
'      if (name.length < 2) {' +
'        errorEl.textContent = \'Tên loại phải có ít nhất 2 ký tự.\';' +
'        errorEl.classList.remove(\'hidden\');' +
'        input.classList.add(\'border-red-400\');' +
'        return;' +
'      }' +
'      if (categories.includes(name) || customCategories.includes(name)) {' +
'        errorEl.textContent = \'Loại chi phí này đã tồn tại.\';' +
'        errorEl.classList.remove(\'hidden\');' +
'        input.classList.add(\'border-red-400\');' +
'        return;' +
'      }' +
'      try {' +
'        const res = await fetch(\'/api/expenses/categories\', {' +
'          method: \'POST\',' +
'          headers: { \'Content-Type\': \'application/json\' },' +
'          body: JSON.stringify({ name })' +
'        });' +
'        const data = await res.json();' +
'        if (res.ok) {' +
'          customCategories.push(name);' +
'          categories.push(name);' +
'          addCategoryToDropdown(name);' +
'          hideAddCategory();' +
'          const catSelect = document.getElementById(\'catSelect\');' +
'          catSelect.value = name;' +
'          onCatChange(name);' +
'        } else {' +
'          errorEl.textContent = data.error || \'Không thể thêm loại chi phí.\';' +
'          errorEl.classList.remove(\'hidden\');' +
'          input.classList.add(\'border-red-400\');' +
'        }' +
'      } catch (err) {' +
'        errorEl.textContent = \'Lỗi kết nối: \' + err.message;' +
'        errorEl.classList.remove(\'hidden\');' +
'        input.classList.add(\'border-red-400\');' +
'      }' +
'    }' +

'    function addCategoryToDropdown(name) {' +
'      const catSelect = document.getElementById(\'catSelect\');' +
'      if (!catSelect) return;' +
'      const customOpt = catSelect.querySelector(\'option[value="__custom__"]\');' +
'      const opt = document.createElement(\'option\');' +
'      opt.value = name;' +
'      opt.textContent = name;' +
'      catSelect.insertBefore(opt, customOpt || null);' +
'    }' +

'    function getAllCategories() {' +
'      return [...categories];' +
'    }' +
'' +
'    async function submitExpense() {' +
'      const id = document.getElementById(\'expenseId\').value;' +
'      const form = document.getElementById(\'addExpenseForm\');' +
'      const formData = new FormData(form);' +
'      let category = formData.get(\'category\');' +
'      if (category === \'__custom__\') {' +
'        category = form.querySelector(\'#customCatInput\').value.trim();' +
'        if (!category) {' +
'          alert(\'Vui lòng nhập tên loại chi phí.\');' +
'          return;' +
'        }' +
'        if (!categories.includes(category) && !customCategories.includes(category)) {' +
'          try {' +
'            const res = await fetch(\'/api/expenses/categories\', {' +
'              method: \'POST\',' +
'              headers: { \'Content-Type\': \'application/json\' },' +
'              body: JSON.stringify({ name: category })' +
'            });' +
'            if (res.ok) {' +
'              customCategories.push(category);' +
'              categories.push(category);' +
'              addCategoryToDropdown(category);' +
'            }' +
'          } catch (_) {}' +
'        }' +
'      }' +
'      const amountInput = form.querySelector(\'input[name="amount"]\');' +
'      const amount = parseFloat(parseFormattedNumber(amountInput.value));' +
'      const date = formData.get(\'date\');' +
'      const description = formData.get(\'description\') || null;' +
'' +
'      console.log(\'Submitting:\', { id, category, amount, date, description });' +
'' +
'      if (!category || !amount || !date) {' +
'        alert(\'Vui lòng điền đầy đủ thông tin!\');' +
'        return;' +
'      }' +
'' +
'      try {' +
'        let url = \'/api/expenses\';' +
'        let method = \'POST\';' +
'' +
'        if (id) {' +
'          url = \'/api/expenses/\' + id;' +
'          method = \'PUT\';' +
'        }' +
'' +
'        const res = await fetch(url, {' +
'          method: method,' +
'          headers: { \'Content-Type\': \'application/json\' },' +
'          body: JSON.stringify({ category, amount, date, description })' +
'        });' +
'' +
'        console.log(\'Response status:\', res.status);' +
'        if (res.ok) {' +
'          hideModal(\'addExpenseModal\');' +
'          form.reset();' +
'          document.getElementById(\'expenseId\').value = \'\';' +
'          document.querySelector(\'#addExpenseModal h2\').textContent = \'Thêm chi phí\';' +
'          document.querySelector(\'input[name="date"]\').value = \'' + today + '\';' +
'          location.reload();' +
'        } else {' +
'          const err = await res.json();' +
'          alert(err.error || \'Lỗi khi lưu\');' +
'        }' +
'      } catch (err) {' +
'        alert(\'Lỗi kết nối: \' + err.message);' +
'      }' +
'    }' +
'' +
'    async function deleteExpense(id) {' +
'      if (!confirm(\'Xóa chi phí này?\')) return;' +
'      ' +
'      try {' +
'        const res = await fetch(\'/api/expenses/\' + id, { method: \'DELETE\' });' +
'        if (res.ok) {' +
'          location.reload();' +
'        } else {' +
'          alert(\'Xóa thất bại\');' +
'        }' +
'      } catch (err) {' +
'        alert(\'Lỗi kết nối\');' +
'      }' +
'    }' +
'  <' + '/script>' +
'  <script src="/js/numfmt.js"><\/script>' +
'  <script src="/sync.js"><\/script>' +
'</body>' +
'</html>');
  } catch (err) {
    logger.error('GET /expenses page failed', { message: err.message, stack: err.stack });
    next(err);
  }
});

module.exports = router;