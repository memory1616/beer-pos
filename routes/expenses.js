const express = require('express');
const router = express.Router();
const db = require('../database');

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// Expense type mapping
const EXPENSE_TYPES = {
  'fuel': { icon: '⛽', label: 'Xăng', color: '#f97316', bg: '#fff7ed' },
  'food': { icon: '🍜', label: 'Ăn', color: '#22c55e', bg: '#f0fdf4' },
  'repair': { icon: '🔧', label: 'Sửa', color: '#3b82f6', bg: '#eff6ff' },
  'other': { icon: '📦', label: 'Khác', color: '#6b7280', bg: '#f3f4f6' }
};

// GET /expenses - Main expenses page
router.get('/', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  
  // Get current month stats
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  const startOfMonthStr = startOfMonth.toISOString().split('T')[0];
  
  // Get total expenses this month
  const monthExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ?
  `).get(startOfMonthStr);
  
  // Get today's expenses
  const todayExpenses = db.prepare(`
    SELECT * FROM expenses WHERE date = ? ORDER BY time DESC
  `).all(today);
  
  // Calculate today's total and by type
  let todayTotal = 0;
  const todayByType = { fuel: 0, food: 0, repair: 0, other: 0 };
  todayExpenses.forEach(e => {
    todayTotal += e.amount;
    const type = e.type || 'other';
    if (todayByType[type] !== undefined) {
      todayByType[type] += e.amount;
    }
  });
  
  // Get expense summary by category this month
  const categorySummary = db.prepare(`
    SELECT category, type, SUM(amount) as total
    FROM expenses
    WHERE date >= ?
    GROUP BY category
    ORDER BY total DESC
  `).all(startOfMonthStr);
  
  // Get recent expenses
  const recentExpenses = db.prepare(`
    SELECT * FROM expenses ORDER BY date DESC, time DESC, id DESC LIMIT 20
  `).all();

  // Expense categories
  const categories = ['Xăng dầu', 'Khấu hao', 'Hư hỏng', 'Điện nước', 'Nhân công', 'Thuê mặt bằng', 'Bảo trì', 'Marketing', 'Khác'];

  // Build category summary HTML
  let categoryHtml = '';
  if (categorySummary.length > 0) {
    categoryHtml = categorySummary.map(c => {
      const typeInfo = EXPENSE_TYPES[c.type] || EXPENSE_TYPES.other;
      return `<div class="flex justify-between items-center py-3 border-b border-gray-100 last:border-0">
        <div class="flex items-center gap-2">
          <span style="font-size:18px">${typeInfo.icon}</span>
          <span class="text-gray-600">${c.category}</span>
        </div>
        <span class="font-bold" style="color:${typeInfo.color}">${formatVND(c.total)}</span>
      </div>`;
    }).join('');
  } else {
    categoryHtml = '<div class="text-gray-400 text-center py-8">Chưa có chi phí nào</div>';
  }

  // Build recent expenses HTML
  let expensesHtml = '';
  if (recentExpenses.length > 0) {
    expensesHtml = recentExpenses.map(e => {
      const dateStr = new Date(e.date).toLocaleDateString('vi-VN');
      const timeStr = e.time || '';
      const desc = e.description || '';
      const typeInfo = EXPENSE_TYPES[e.type] || EXPENSE_TYPES.other;
      return `<div class="expense-item" data-id="${e.id}">
        <div class="icon-wrapper ${e.type || 'other'}" style="background:${typeInfo.bg}">
          ${typeInfo.icon}
        </div>
        <div class="content">
          <div class="title">${e.category}</div>
          <div class="subtitle">${desc || ''} ${timeStr ? '• ' + timeStr : ''}</div>
        </div>
        <div class="text-right">
          <div class="amount">${formatVND(e.amount)}</div>
          <button onclick="deleteExpense(${e.id}); event.stopPropagation();" class="text-xs text-red-400 hover:text-red-600 mt-1">Xóa</button>
        </div>
      </div>`;
    }).join('');
  } else {
    expensesHtml = '<div class="text-gray-400 text-center py-8">Chưa có chi phí nào</div>';
  }

  const optionsHtml = categories.map(c => '<option value="' + c + '">' + c + '</option>').join('');

  res.send('<!DOCTYPE html>' +
'<html lang="vi">' +
'<head>' +
'  <meta charset="UTF-8">' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">' +
'  <title>Chi phí - Beer POS</title>' +
'  <link rel="manifest" href="/manifest.json">' +
'  <meta name="theme-color" content="#ef4444">' +
'  <meta name="apple-mobile-web-app-capable" content="yes">' +
'  <link rel="stylesheet" href="/css/tailwind.css">' +
'  <link rel="stylesheet" href="/css/unified.css">' +
'  <script src="/js/auth.js"></script>' +
'  <script src="/js/layout.js"></script>' +
'  <script>requireAuth();</script>' +
'  <style>' +
'    * { -webkit-tap-highlight-color: transparent; }' +
'    body { padding-bottom: 90px; }' +
'    .quick-action-grid { padding: 16px 16px 0; }' +
'    .bottomnav { padding-bottom: env(safe-area-inset-bottom, 0); }' +
'    input, select, textarea { font-size: 16px !important; }' +
'  </style>' +
'</head>' +
'<body class="bg-gray-50 text-gray-800">' +
'  <div id="app"></div>' +
'' +
'  <!-- Quick Add Modal - Bottom Sheet -->' +
'  <div id="quickAddModal" class="quick-add-modal hidden">' +
'    <div class="quick-add-sheet">' +
'      <div class="handle"></div>' +
'      <div class="flex items-center justify-between mb-4">' +
'        <h2 class="text-xl font-bold" id="quickAddTitle">Thêm chi phí</h2>' +
'        <button onclick="hideQuickAdd()" class="text-gray-400 hover:text-gray-600 text-2xl px-2">&times;</button>' +
'      </div>' +
'      <form id="quickAddForm">' +
'        <input type="hidden" name="expenseType" id="quickAddType">' +
'        <div class="text-center mb-4">' +
'          <div class="text-sm text-gray-500 mb-1">Số tiền (VNĐ)</div>' +
'          <input type="number" name="amount" required min="1000" step="1000"' +
'            class="amount-input" placeholder="0" autofocus inputmode="numeric">' +
'        </div>' +
'        <div class="quick-actions justify-center">' +
'          <button type="button" class="quick-amount" onclick="setAmount(50000)">50K</button>' +
'          <button type="button" class="quick-amount" onclick="setAmount(100000)">100K</button>' +
'          <button type="button" class="quick-amount" onclick="setAmount(200000)">200K</button>' +
'          <button type="button" class="quick-amount" onclick="setAmount(300000)">300K</button>' +
'          <button type="button" class="quick-amount" onclick="setAmount(500000)">500K</button>' +
'        </div>' +
'        <div class="mt-4">' +
'          <input type="text" name="note" class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:border-green-500" placeholder="Ghi chú (tùy chọn)">' +
'        </div>' +
'        <div id="kmField" class="hidden mt-4">' +
'          <input type="number" name="km" class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:border-green-500" placeholder="Số km đã đi">' +
'        </div>' +
'        <button type="submit" class="save-btn">Lưu</button>' +
'      </form>' +
'    </div>' +
'  </div>' +
'' +
'  <!-- Full Add Modal -->' +
'  <div id="addExpenseModal" class="quick-add-modal hidden">' +
'    <div class="quick-add-sheet">' +
'      <div class="handle"></div>' +
'      <h2 class="text-xl font-bold mb-4">Thêm chi phí</h2>' +
'      <form id="addExpenseForm" class="space-y-4">' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-600 mb-2">Loại chi phí</label>' +
'          <select name="category" required class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-green-500">' +
'            <option value="">-- Chọn loại --</option>' +
'            optionsHtml +
'          </select>' +
'        </div>' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-600 mb-2">Số tiền (VNĐ)</label>' +
'          <input type="number" name="amount" required min="1000" step="1000" class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-green-500" placeholder="Nhập số tiền">' +
'        </div>' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-600 mb-2">Ngày</label>' +
'          <input type="date" name="date" required value="' + today + '" class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-green-500">' +
'        </div>' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-600 mb-2">Ghi chú</label>' +
'          <textarea name="description" rows="2" class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-green-500" placeholder="Ghi chú thêm (tùy chọn)"></textarea>' +
'        </div>' +
'      </form>' +
'      <div class="flex gap-3 mt-6">' +
'        <button type="button" onclick="hideModal(\'addExpenseModal\')" class="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold py-4 rounded-xl">Hủy</button>' +
'        <button type="submit" form="addExpenseForm" class="flex-1 bg-green-500 hover:bg-green-600 text-white font-semibold py-4 rounded-xl">Lưu</button>' +
'      </div>' +
'    </div>' +
'  </div>' +
'' +
'  <script>' +
'    const categories = ' + JSON.stringify(categories) + ';' +
'    const today = "' + today + '";' +
'    ' +
'    (async () => {' +
'      document.getElementById(\'app\').innerHTML = ' +
'        getHeader(\'Chi phí\', \'💸\') +' +
'        getContent(`' +
'          <!-- Quick Action Buttons -->' +
'          <div class="quick-action-grid">' +
'            <button onclick="showQuickAdd(\'fuel\')" class="quick-action-btn fuel animate-pulse-slow">' +
'              <span class="icon">⛽</span>' +
'              <span class="label">Xăng</span>' +
'            </button>' +
'            <button onclick="showQuickAdd(\'food\')" class="quick-action-btn food animate-pulse-slow">' +
'              <span class="icon">🍜</span>' +
'              <span class="label">Ăn</span>' +
'            </button>' +
'            <button onclick="showQuickAdd(\'repair\')" class="quick-action-btn repair animate-pulse-slow">' +
'              <span class="icon">🔧</span>' +
'              <span class="label">Sửa</span>' +
'            </button>' +
'          </div>' +
'' +
'          <!-- Today Summary - Grab Style -->' +
'          <div class="expense-summary mx-4">' +
'            <div class="total-label">Tổng chi phí hôm nay</div>' +
'            <div class="total-amount" id="todayTotal">' + formatVND(todayTotal) + '</div>' +
'            <div class="breakdown">' +
'              <div class="breakdown-item">' +
'                <div class="icon">⛽</div>' +
'                <div class="value" id="todayFuel">' + formatVND(todayByType.fuel) + '</div>' +
'                <div class="label">Xăng</div>' +
'              </div>' +
'              <div class="breakdown-item">' +
'                <div class="icon">🍜</div>' +
'                <div class="value" id="todayFood">' + formatVND(todayByType.food) + '</div>' +
'                <div class="label">Ăn</div>' +
'              </div>' +
'              <div class="breakdown-item">' +
'                <div class="icon">🔧</div>' +
'                <div class="value" id="todayRepair">' + formatVND(todayByType.repair) + '</div>' +
'                <div class="label">Sửa</div>' +
'              </div>' +
'            </div>' +
'          </div>' +
'' +
'          <!-- Month Summary -->' +
'          <div class="mx-4 mb-4">' +
'            <div class="text-sm font-semibold text-gray-500 mb-3">Tháng này</div>' +
'            <div class="bg-white rounded-2xl p-4 shadow-sm">' +
'              <div class="flex justify-between items-center">' +
'                <span class="text-gray-600">Tổng chi phí</span>' +
'                <span class="text-xl font-bold text-red-500" id="monthTotal">' + formatVND(monthExpenses.total) + '</span>' +
'              </div>' +
'            </div>' +
'          </div>' +
'' +
'          <!-- Category Summary -->' +
'          <div class="mx-4 mb-4">' +
'            <div class="text-sm font-semibold text-gray-500 mb-3">Chi phí theo loại</div>' +
'            <div class="bg-white rounded-2xl p-4 shadow-sm">' +
'              <div id="categoryList">' +
'                categoryHtml +
'              </div>' +
'            </div>' +
'          </div>' +
'' +
'          <!-- Recent Expenses -->' +
'          <div class="mx-4 mb-4">' +
'            <div class="text-sm font-semibold text-gray-500 mb-3">Chi phí gần đây</div>' +
'            <div id="expenseList">' +
'              expensesHtml +
'            </div>' +
'          </div>' +
'        `) +' +
'        getBottomNav(\'/expenses\');' +
'    })();' +
'  </script>' +
'' +
'  <script>' +
'    const typeConfig = {' +
'      fuel: { title: \'⛽ Chi phí xăng\', showKm: true },' +
'      food: { title: \'🍜 Chi phí ăn\', showKm: false },' +
'      repair: { title: \'🔧 Chi phí sửa\', showKm: false },' +
'      other: { title: \'📦 Chi phí khác\', showKm: false }' +
'    };' +
'' +
'    function showQuickAdd(type) {' +
'      const config = typeConfig[type];' +
'      if (!config) return;' +
'' +
'      document.getElementById(\'quickAddTitle\').textContent = config.title;' +
'      document.getElementById(\'quickAddType\').value = type;' +
'      document.getElementById(\'quickAddModal\').classList.remove(\'hidden\');' +
'' +
'      const kmField = document.getElementById(\'kmField\');' +
'      if (config.showKm) {' +
'        kmField.classList.remove(\'hidden\');' +
'      } else {' +
'        kmField.classList.add(\'hidden\');' +
'      }' +
'' +
'      setTimeout(() => {' +
'        document.querySelector(\'#quickAddForm input[name="amount"]\').focus();' +
'      }, 100);' +
'    }' +
'' +
'    function hideQuickAdd() {' +
'      document.getElementById(\'quickAddModal\').classList.add(\'hidden\');' +
'      document.getElementById(\'quickAddForm\').reset();' +
'    }' +
'' +
'    function setAmount(val) {' +
'      document.querySelector(\'#quickAddForm input[name="amount"]\').value = val;' +
'    }' +
'' +
'    function showModal(id) {' +
'      document.getElementById(id).classList.remove(\'hidden\');' +
'    }' +
'' +
'    function hideModal(id) {' +
'      document.getElementById(id).classList.add(\'hidden\');' +
'    }' +
'' +
'    // Quick Add Form Submit' +
'    document.addEventListener(\'DOMContentLoaded\', function() {' +
'      const quickForm = document.getElementById(\'quickAddForm\');' +
'      if (quickForm) {' +
'        quickForm.addEventListener(\'submit\', async (e) => {' +
'          e.preventDefault();' +
'          const formData = new FormData(e.target);' +
'          const expenseType = formData.get(\'expenseType\');' +
'          const amount = parseFloat(formData.get(\'amount\'));' +
'          const note = formData.get(\'note\') || null;' +
'          const km = formData.get(\'km\') ? parseInt(formData.get(\'km\')) : null;' +
'' +
'          if (!expenseType || !amount) {' +
'            alert(\'Vui lòng nhập số tiền!\');' +
'            return;' +
'          }' +
'' +
'          try {' +
'            const res = await fetch(\'/api/expenses/quick\', {' +
'              method: \'POST\',' +
'              headers: { \'Content-Type\': \'application/json\' },' +
'              body: JSON.stringify({ expenseType, amount, note, km })' +
'            });' +
'' +
'            if (res.ok) {' +
'              hideQuickAdd();' +
'              location.reload();' +
'            } else {' +
'              const err = await res.json();' +
'              alert(err.error || \'Lỗi khi lưu\');' +
'            }' +
'          } catch (err) {' +
'            alert(\'Lỗi kết nối: \' + err.message);' +
'          }' +
'        });' +
'      }' +
'' +
'      // Full Add Form Submit' +
'      const form = document.getElementById(\'addExpenseForm\');' +
'      if (!form) return;' +
'      ' +
'      form.addEventListener(\'submit\', async (e) => {' +
'        e.preventDefault();' +
'        const formData = new FormData(e.target);' +
'        const category = formData.get(\'category\');' +
'        const amount = parseFloat(formData.get(\'amount\'));' +
'        const date = formData.get(\'date\');' +
'        const description = formData.get(\'description\') || null;' +
'' +
'        if (!category || !amount || !date) {' +
'          alert(\'Vui lòng điền đầy đủ thông tin!\');' +
'          return;' +
'        }' +
'' +
'        try {' +
'          const res = await fetch(\'/api/expenses\', {' +
'            method: \'POST\',' +
'            headers: { \'Content-Type\': \'application/json\' },' +
'            body: JSON.stringify({ category, amount, date, description })' +
'          });' +
'' +
'          if (res.ok) {' +
'            hideModal(\'addExpenseModal\');' +
'            e.target.reset();' +
'            document.getElementById(\'addExpenseForm\').querySelector(\'input[name="date"]\').value = today;' +
'            location.reload();' +
'          } else {' +
'            const err = await res.json();' +
'            alert(err.error || \'Lỗi khi lưu\');' +
'          }' +
'        } catch (err) {' +
'          alert(\'Lỗi kết nối: \' + err.message);' +
'        }' +
'      });' +
'    });' +
'' +
'    // Close modal on backdrop click' +
'    document.addEventListener(\'click\', function(e) {' +
'      if (e.target.classList.contains(\'quick-add-modal\')) {' +
'        e.target.classList.add(\'hidden\');' +
'      }' +
'    });' +
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
'  </script>' +
'  <script src="/sync.js"></script>' +
'</body>' +
'</html>');
});

module.exports = router;
