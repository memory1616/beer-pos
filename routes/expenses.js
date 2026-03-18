const express = require('express');
const router = express.Router();
const db = require('../database');

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// Expense type mapping
const EXPENSE_TYPES = {
  'fuel': { icon: '⛽', label: 'Xăng', color: 'bg-orange-500' },
  'food': { icon: '🍜', label: 'Ăn', color: 'bg-green-500' },
  'repair': { icon: '🔧', label: 'Sửa', color: 'bg-blue-500' },
  'other': { icon: '📦', label: 'Khác', color: 'bg-gray-500' }
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
      return '<div class="flex justify-between items-center py-2 border-b last:border-0">' +
        '<span class="text-gray-600">' + typeInfo.icon + ' ' + c.category + '</span>' +
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
      const timeStr = e.time || '';
      const desc = e.description || '';
      const typeInfo = EXPENSE_TYPES[e.type] || EXPENSE_TYPES.other;
      return '<div class="flex justify-between items-center py-3 border-b last:border-0" data-id="' + e.id + '">' +
        '<div class="flex-1">' +
        '<div class="font-medium">' + typeInfo.icon + ' ' + e.category + '</div>' +
        '<div class="text-sm text-gray-500">' + desc + '</div>' +
        '<div class="text-xs text-gray-400">' + dateStr + (timeStr ? ' ' + timeStr : '') + '</div>' +
        '</div>' +
        '<div class="text-right">' +
        '<div class="font-bold text-red-600">' + formatVND(e.amount) + '</div>' +
        '<button onclick="deleteExpense(' + e.id + ')" class="text-xs text-red-400 hover:text-red-600 mt-1">Xóa</button>' +
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
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'  <title>Chi phí</title>' +
'  <link rel="manifest" href="/manifest.json">' +
'  <meta name="theme-color" content="#f59e0b">' +
'  <link rel="apple-touch-icon" href="/icon-192.png">' +
'  <link rel="stylesheet" href="/css/tailwind.css">' +
'  <link rel="stylesheet" href="/css/unified.css">' +
'  <script src="/js/auth.js"></script>' +
'  <script src="/js/layout.js"></script>' +
'  <script>requireAuth();</script>' +
'  <style>' +
'    .animate-fade { animation: fade 0.3s ease-in; }' +
'    @keyframes fade { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }' +
'    .pb-safe { padding-bottom: env(safe-area-inset-bottom, 20px); }' +
'    .pt-safe { padding-top: env(safe-area-inset-top, 20px); }' +
'    .bottomnav { max-width: 500px; margin: auto; left: 0; right: 0; }' +
'    button, a { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }' +
'    button:active { transform: scale(0.96); }' +
'    .quick-btn { transition: all 0.2s; }' +
'    .quick-btn:active { transform: scale(0.95); }' +
'  </style>' +
'</head>' +
'<body class="bg-gray-100 text-gray-800 min-h-screen pb-24">' +
'  <div id="app"></div>' +
'' +
'  <!-- Quick Add Buttons -->' +
'  <div class="fixed bottom-24 left-0 right-0 max-w-md mx-auto px-4 z-40">' +
'    <div class="flex gap-2 justify-center">' +
'      <button onclick="showQuickAdd(\'fuel\')" class="quick-btn flex-1 bg-orange-500 hover:bg-orange-600 text-white font-bold py-4 px-4 rounded-xl shadow-lg flex flex-col items-center">' +
'        <span class="text-2xl">⛽</span>' +
'        <span class="text-sm">Xăng</span>' +
'      </button>' +
'      <button onclick="showQuickAdd(\'food\')" class="quick-btn flex-1 bg-green-500 hover:bg-green-600 text-white font-bold py-4 px-4 rounded-xl shadow-lg flex flex-col items-center">' +
'        <span class="text-2xl">🍜</span>' +
'        <span class="text-sm">Ăn</span>' +
'      </button>' +
'      <button onclick="showQuickAdd(\'repair\')" class="quick-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white font-bold py-4 px-4 rounded-xl shadow-lg flex flex-col items-center">' +
'        <span class="text-2xl">🔧</span>' +
'        <span class="text-sm">Sửa</span>' +
'      </button>' +
'    </div>' +
'  </div>' +
'' +
'  <!-- Floating Add Button -->' +
'  <button onclick="showModal(\'addExpenseModal\')" class="fixed bottom-24 right-4 w-14 h-14 bg-red-600 text-white rounded-full shadow-xl flex items-center justify-center text-2xl font-bold transition-all duration-200 hover:scale-105 z-40">' +
'    +' +
'  </button>' +
'' +
'  <!-- Quick Add Modal -->' +
'  <div id="quickAddModal" class="fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center p-4 z-50">' +
'    <div class="bg-white rounded-xl p-6 max-w-sm w-full shadow-2xl">' +
'      <div class="flex items-center justify-between mb-4">' +
'        <h2 class="text-xl font-bold" id="quickAddTitle">Thêm chi phí</h2>' +
'        <button onclick="hideQuickAdd()" class="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>' +
'      </div>' +
'      <form id="quickAddForm" class="space-y-4">' +
'        <input type="hidden" name="expenseType" id="quickAddType">' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-700 mb-1">Số tiền (VNĐ)</label>' +
'          <input type="number" name="amount" required min="1000" step="1000" class="w-full border-2 border-gray-300 rounded-lg px-4 py-3 text-xl font-bold focus:ring-2 focus:ring-blue-500 focus:border-blue-500" placeholder="0" autofocus>' +
'        </div>' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-700 mb-1">Ghi chú (tùy chọn)</label>' +
'          <input type="text" name="note" class="w-full border-2 border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500" placeholder="Ghi chú thêm...">' +
'        </div>' +
'        <div id="kmField" class="hidden">' +
'          <label class="block text-sm font-medium text-gray-700 mb-1">Số km</label>' +
'          <input type="number" name="km" class="w-full border-2 border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500" placeholder="Số km đã đi">' +
'        </div>' +
'      </form>' +
'      <div class="flex gap-2 mt-6">' +
'        <button type="button" onclick="hideQuickAdd()" class="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-semibold py-3 rounded-lg">Hủy</button>' +
'        <button type="submit" form="quickAddForm" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-lg">Lưu</button>' +
'      </div>' +
'    </div>' +
'  </div>' +
'' +
'  <!-- Add Expense Modal -->' +
'  <div id="addExpenseModal" class="fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center p-4 z-50">' +
'    <div class="bg-white rounded-lg p-6 max-w-sm w-full">' +
'      <h2 class="text-xl font-semibold mb-4">Thêm chi phí</h2>' +
'      <form id="addExpenseForm" method="POST" class="space-y-4">' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-700 mb-1">Loại chi phí</label>' +
'          <select name="category" required class="w-full border border-gray-300 rounded-lg px-4 py-3 text-lg focus:ring-2 focus:ring-red-500">' +
'            <option value="">-- Chọn loại --</option>' +
'            optionsHtml +
'          </select>' +
'        </div>' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-700 mb-1">Số tiền (VNĐ)</label>' +
'          <input type="number" name="amount" required min="1000" step="1000" class="w-full border border-gray-300 rounded-lg px-4 py-3 text-lg focus:ring-2 focus:ring-red-500" placeholder="Nhập số tiền">' +
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
'        <button type="submit" form="addExpenseForm" class="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-lg">Lưu</button>' +
'      </div>' +
'    </div>' +
'  </div>' +
'' +
'  <script>' +
'    const categories = ' + JSON.stringify(categories) + ';' +
'    ' +
'    (async () => {' +
'      document.getElementById(\'app\').innerHTML = ' +
'        getHeader(\'Chi phí\', \'💸\') +' +
'        getContent(`' +
'          <!-- Today Summary -->' +
'          <div class="mb-4 p-4 bg-gradient-to-r from-red-500 to-red-600 rounded-xl shadow text-white">' +
'            <div class="text-sm opacity-90">Tổng chi phí hôm nay</div>' +
'            <div class="text-3xl font-bold" id="todayTotal">' + formatVND(todayTotal) + '</div>' +
'            <div class="grid grid-cols-3 gap-2 mt-3 text-xs">' +
'              <div class="bg-white bg-opacity-20 rounded-lg p-2 text-center">' +
'                <div>⛽ Xăng</div>' +
'                <div class="font-bold" id="todayFuel">' + formatVND(todayByType.fuel) + '</div>' +
'              </div>' +
'              <div class="bg-white bg-opacity-20 rounded-lg p-2 text-center">' +
'                <div>🍜 Ăn</div>' +
'                <div class="font-bold" id="todayFood">' + formatVND(todayByType.food) + '</div>' +
'              </div>' +
'              <div class="bg-white bg-opacity-20 rounded-lg p-2 text-center">' +
'                <div>🔧 Sửa</div>' +
'                <div class="font-bold" id="todayRepair">' + formatVND(todayByType.repair) + '</div>' +
'              </div>' +
'            </div>' +
'          </div>' +
'' +
'          <!-- Month Summary -->' +
'          <div class="mb-4 p-4 bg-red-500 rounded-xl shadow text-white">' +
'            <div class="text-sm opacity-90">Tổng chi phí tháng này</div>' +
'            <div class="text-3xl font-bold" id="monthTotal">' + formatVND(monthExpenses.total) + '</div>' +
'          </div>' +
'' +
'          <!-- Category Summary -->' +
'          <div class="bg-white rounded-xl shadow-sm border p-4 mb-4">' +
'            <h3 class="font-semibold text-gray-700 mb-3">📊 Chi phí theo loại</h3>' +
'            <div id="categoryList">' +
'              categoryHtml +
'            </div>' +
'          </div>' +
'' +
'          <!-- Recent Expenses -->' +
'          <div class="bg-white rounded-xl shadow-sm border p-4">' +
'            <h3 class="font-semibold text-gray-700 mb-3">📋 Chi phí gần đây</h3>' +
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
'      fuel: { title: \'⛽ Thêm chi phí xăng\', color: \'bg-orange-500\', showKm: true },' +
'      food: { title: \'🍜 Thêm chi phí ăn\', color: \'bg-green-500\', showKm: false },' +
'      repair: { title: \'🔧 Thêm chi phí sửa\', color: \'bg-blue-500\', showKm: false },' +
'      other: { title: \'📦 Thêm chi phí khác\', color: \'bg-gray-500\', showKm: false }' +
'    };' +
'' +
'    function showQuickAdd(type) {' +
'      const config = typeConfig[type];' +
'      if (!config) return;' +
'' +
'      document.getElementById(\'quickAddTitle\').textContent = config.title;' +
'      document.getElementById(\'quickAddType\').value = type;' +
'      document.getElementById(\'quickAddModal\').classList.remove(\'hidden\');' +
'      document.getElementById(\'quickAddModal\').classList.add(\'flex\');' +
'' +
'      // Show/hide km field' +
'      const kmField = document.getElementById(\'kmField\');' +
'      if (config.showKm) {' +
'        kmField.classList.remove(\'hidden\');' +
'      } else {' +
'        kmField.classList.add(\'hidden\');' +
'      }' +
'' +
'      // Focus amount input' +
'      setTimeout(() => {' +
'        document.querySelector(\'#quickAddForm input[name="amount"]\').focus();' +
'      }, 100);' +
'    }' +
'' +
'    function hideQuickAdd() {' +
'      document.getElementById(\'quickAddModal\').classList.add(\'hidden\');' +
'      document.getElementById(\'quickAddModal\').classList.remove(\'flex\');' +
'      document.getElementById(\'quickAddForm\').reset();' +
'    }' +
'' +
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
'            console.log(\'Quick add response:\', res.status);' +
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
'      if (!form) {' +
'        console.error(\'Form not found!\');' +
'        return;' +
'      }' +
'      form.addEventListener(\'submit\', async (e) => {' +
'        e.preventDefault();' +
'        const formData = new FormData(e.target);' +
'        const category = formData.get(\'category\');' +
'        const amount = parseFloat(formData.get(\'amount\'));' +
'        const date = formData.get(\'date\');' +
'        const description = formData.get(\'description\') || null;' +
'' +
'        console.log(\'Submitting:\', { category, amount, date, description });' +
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
'          console.log(\'Response status:\', res.status);' +
'          if (res.ok) {' +
'            hideModal(\'addExpenseModal\');' +
'            e.target.reset();' +
'            document.getElementById(\'addExpenseForm\').querySelector(\'input[name="date"]\').value = \'' + today + '\';' +
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
