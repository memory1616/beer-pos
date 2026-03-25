const express = require('express');
const router = express.Router();
const db = require('../database');

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// GET /expenses - Main expenses page with month/year filter
router.get('/', (req, res) => {
  const { month, year, mode } = req.query;
  const now = new Date();
  const viewMode = mode === 'year' ? 'year' : 'month';

  // Build date range from filter
  let startStr, endStr, labelThangNam;

  if (viewMode === 'year' && year) {
    const y = parseInt(year, 10);
    startStr = `${y}-01-01`;
    endStr = `${y}-12-31`;
    labelThangNam = `Năm ${y}`;
  } else if (month && year) {
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const lastDay = new Date(y, m, 0).getDate();
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const thangLabels = ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];
    labelThangNam = thangLabels[m] + ' / ' + y;
  } else {
    // Default: tháng này
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const lastDay = new Date(y, m, 0).getDate();
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const thangLabels = ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];
    labelThangNam = thangLabels[m] + ' / ' + y;
  }

  const today = now.toISOString().split('T')[0];

  // Get total expenses for the period
  const periodExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ? AND date <= ?
  `).get(startStr, endStr);

  // Get expense summary by category for the period
  const categorySummary = db.prepare(`
    SELECT category, SUM(amount) as total, COUNT(*) as count
    FROM expenses
    WHERE date >= ? AND date <= ?
    GROUP BY category ORDER BY total DESC
  `).all(startStr, endStr);

  // Get all expenses for the period
  const periodExpensesList = db.prepare(`
    SELECT * FROM expenses WHERE date >= ? AND date <= ? ORDER BY date DESC, id DESC
  `).all(startStr, endStr);

  // Expense categories for form
  const categories = ['Xăng dầu', 'Khấu hao', 'Hư hỏng', 'Điện nước', 'Nhân công', 'Thuê mặt bằng', 'Bảo trì', 'Marketing', 'Khác'];

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

  // Build category summary HTML
  let categoryHtml = '';
  if (categorySummary.length > 0) {
    categoryHtml = categorySummary.map(c => {
      const icon = categoryIcons[c.category] || '📋';
      return '<div class="flex justify-between items-center py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors px-2 -mx-2 rounded-lg">' +
        '<div class="flex items-center gap-3">' +
          '<span class="text-xl">' + icon + '</span>' +
          '<span class="text-gray-700 font-medium">' + c.category + '</span>' +
        '</div>' +
        '<div class="text-right">' +
          '<div class="font-bold text-red-600">' + formatVND(c.total) + '</div>' +
          '<div class="text-xs text-gray-400">' + c.count + ' khoản</div>' +
        '</div>' +
        '</div>';
    }).join('');
  } else {
    categoryHtml = '<div class="text-gray-400 text-center py-4">Chưa có chi phí nào trong kỳ này</div>';
  }

  // Build expense list HTML
  let expensesHtml = '';
  if (periodExpensesList.length > 0) {
    expensesHtml = periodExpensesList.map(e => {
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
        '<button onclick="editExpense(' + e.id + ', \'' + (e.category || '').replace(/'/g, "\\'") + '\', ' + e.amount + ', \'' + e.date + '\', \'' + (e.description || '').replace(/'/g, "\\'") + '\')" class="text-xs text-blue-500 hover:text-blue-700 px-2 py-1 hover:bg-blue-50 rounded">Sửa</button>' +
        '<button onclick="deleteExpense(' + e.id + ')" class="text-xs text-red-400 hover:text-red-600 px-2 py-1 hover:bg-red-50 rounded">Xóa</button>' +
        '</div>' +
        '</div>' +
        '</div>';
    }).join('');
  } else {
    expensesHtml = '<div class="text-gray-400 text-center py-8">📭 Không có chi phí nào trong kỳ này</div>';
  }

  const optionsHtml = categories.map(c => '<option value="' + c + '">' + c + '</option>').join('');

  // Selected values for dropdowns
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const selectedMonth = month ? parseInt(month, 10) : currentMonth;
  const selectedYear = year ? parseInt(year, 10) : currentYear;

  const monthOptions = [1,2,3,4,5,6,7,8,9,10,11,12].map(m =>
    '<option value="' + m + '"' + (m === selectedMonth ? ' selected' : '') + '>Tháng ' + m + '</option>'
  ).join('');
  const yearOptions = [currentYear, currentYear - 1, currentYear - 2].map(y =>
    '<option value="' + y + '"' + (y === selectedYear ? ' selected' : '') + '>' + y + '</option>'
  ).join('');

  res.send('<!DOCTYPE html>' +
'<html lang="vi">' +
'<head>' +
'  <meta charset="UTF-8">' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">' +
'  <title>Chi phí</title>' +
'  <link rel="manifest" href="/manifest.json">' +
'  <meta name="theme-color" content="#dc2626">' +
'  <link rel="apple-touch-icon" href="/icon-192.png">' +
'  <link rel="stylesheet" href="/css/tailwind.css">' +
'  <link rel="stylesheet" href="/css/unified.css">' +
'  <script src="/js/auth.js"></script>' +
'  <script src="/js/layout.js"></script>' +
'  <style>' +
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

'  <!-- Floating Add Button -->' +
'  <button onclick="showModal(\'addExpenseModal\')" class="fixed bottom-24 right-4 w-14 h-14 bg-red-600 text-white rounded-full shadow-xl flex items-center justify-center text-2xl font-bold transition-all duration-200 hover:scale-105 z-40">' +
'    +' +
'  </button>' +

'  <!-- Add/Edit Expense Modal -->' +
'  <div id="addExpenseModal" class="fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center p-4 z-50">' +
'    <div class="bg-white rounded-lg p-6 max-w-sm w-full">' +
'      <h2 id="expenseModalTitle" class="text-xl font-semibold mb-4">Thêm chi phí</h2>' +
'      <form id="addExpenseForm" class="space-y-4">' +
'        <input type="hidden" id="expenseId">' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-700 mb-1">Loại chi phí</label>' +
'          <select name="category" required class="w-full border border-gray-300 rounded-lg px-4 py-3 text-lg focus:ring-2 focus:ring-red-500">' +
'            <option value="">-- Chọn loại --</option>' +
            optionsHtml +
'          </select>' +
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

'  <script>' +
'    const categories = ' + JSON.stringify(categories) + ';' +
'    ' +
'    (async () => {' +
'      document.getElementById(\'app\').innerHTML = ' +
'        getHeader(\'Chi phí\', \'💸\') +' +
'        getContent(`' +

'          <!-- Bộ lọc Tháng/Năm -->' +
'          <div style="background: #fef3c7; border-radius: 16px; border: 2px solid #f59e0b; padding: 16px; margin-bottom: 16px;">' +
'            <div class="flex items-center gap-2 mb-3">' +
'              <span style="color: #92400e; font-size: 14px; font-weight: 600;">📅 Chọn kỳ thống kê</span>' +
'            </div>' +

'            <!-- Tab switcher -->' +
'            <div class="flex gap-1 mb-3 p-1 rounded-xl" style="background: #fde68a;">' +
'              <button type="button" id="tabMonth" onclick="switchMode(\'month\')" class="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"' +
                (viewMode === 'month' ? ' style="background:white;color:#92400e;box-shadow:0 1px 3px rgba(0,0,0,0.15)"' : ' style="background:transparent;color:#b45309"') +
'              >Theo tháng</button>' +
'              <button type="button" id="tabYear" onclick="switchMode(\'year\')" class="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"' +
                (viewMode === 'year' ? ' style="background:white;color:#92400e;box-shadow:0 1px 3px rgba(0,0,0,0.15)"' : ' style="background:transparent;color:#b45309"') +
'              >Theo năm</button>' +
'            </div>' +

'            <!-- Theo tháng -->' +
'            <div id="panelMonth" style="' + (viewMode === 'year' ? 'display:none' : '') + '">' +
'              <div class="flex gap-2 items-center">' +
'                <select id="selMonth" style="flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;">' +
                  monthOptions +
'                </select>' +
'                <select id="selYearMonth" style="flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;">' +
                  yearOptions +
'                </select>' +
'                <button type="button" onclick="applyMonthYear()" style="background: #ea580c; color: white; border: none; border-radius: 8px; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap;">Xem</button>' +
'              </div>' +
'            </div>' +

'            <!-- Theo năm -->' +
'            <div id="panelYear" style="' + (viewMode !== 'year' ? 'display:none' : '') + '">' +
'              <div class="flex gap-2 items-center">' +
'                <select id="selYear" style="flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;">' +
                  yearOptions +
'                </select>' +
'                <button type="button" onclick="applyYear()" style="background: #ea580c; color: white; border: none; border-radius: 8px; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap;">Xem</button>' +
'              </div>' +
'            </div>' +

'            <div class="text-xs text-gray-500 mt-2">Đang xem: <strong>' + labelThangNam + '</strong> · ' + periodExpensesList.length + ' khoản</div>' +
'          </div>' +

'          <!-- Period Summary -->' +
'          <div class="mb-4 p-5 bg-gradient-to-r from-red-500 to-red-600 rounded-xl shadow-lg text-white animate-fade">' +
'            <div class="text-sm opacity-90">Tổng chi phí</div>' +
'            <div class="text-3xl font-bold" id="periodTotal">' + formatVND(periodExpenses.total) + '</div>' +
'          </div>' +

'          <!-- Category Summary -->' +
'          <div class="bg-white rounded-xl shadow-sm border p-4 mb-4 animate-fade">' +
'            <h3 class="font-semibold text-gray-700 mb-3">📊 Theo loại</h3>' +
'            <div id="categoryList">' +
              categoryHtml +
'            </div>' +
'          </div>' +

'          <!-- All Expenses for Period -->' +
'          <div class="bg-white rounded-xl shadow-sm border p-4 animate-fade">' +
'            <h3 class="font-semibold text-gray-700 mb-3">📋 Danh sách chi phí</h3>' +
'            <div id="expenseList">' +
              expensesHtml +
'            </div>' +
'          </div>' +
'        `) +' +
'        getBottomNav(\'/expenses\');' +
'    })();' +
'  </script>' +

'  <script>' +
'    function switchMode(mode) {' +
'      if (mode === \'year\') {' +
'        document.getElementById(\'tabYear\').style.cssText = \'flex:1;background:white;color:#92400e;box-shadow:0 1px 3px rgba(0,0,0,0.15);border-radius:8px;padding:8px\';' +
'        document.getElementById(\'tabMonth\').style.cssText = \'flex:1;background:transparent;color:#b45309;border-radius:8px;padding:8px\';' +
'        document.getElementById(\'panelYear\').style.display = \'\';' +
'        document.getElementById(\'panelMonth\').style.display = \'none\';' +
'      } else {' +
'        document.getElementById(\'tabMonth\').style.cssText = \'flex:1;background:white;color:#92400e;box-shadow:0 1px 3px rgba(0,0,0,0.15);border-radius:8px;padding:8px\';' +
'        document.getElementById(\'tabYear\').style.cssText = \'flex:1;background:transparent;color:#b45309;border-radius:8px;padding:8px\';' +
'        document.getElementById(\'panelMonth\').style.display = \'\';' +
'        document.getElementById(\'panelYear\').style.display = \'none\';' +
'      }' +
'    }' +

'    function applyMonthYear() {' +
'      const m = document.getElementById(\'selMonth\').value;' +
'      const y = document.getElementById(\'selYearMonth\').value;' +
'      window.location.href = \'/expenses?month=\' + m + \'&year=\' + y;' +
'    }' +

'    function applyYear() {' +
'      const y = document.getElementById(\'selYear\').value;' +
'      window.location.href = \'/expenses?mode=year&year=\' + y;' +
'    }' +

'    function showModal(id) {' +
'      document.getElementById(id).classList.remove(\'hidden\');' +
'      document.getElementById(id).classList.add(\'flex\');' +
'    }' +

'    function hideModal(id) {' +
'      document.getElementById(id).classList.add(\'hidden\');' +
'      document.getElementById(id).classList.remove(\'flex\');' +
'    }' +

'    function editExpense(id, category, amount, date, description) {' +
'      document.querySelector(\'#addExpenseModal h2\').textContent = \'Sửa chi phí\';' +
'      document.getElementById(\'expenseId\').value = id;' +
'      document.querySelector(\'select[name="category"]\').value = category;' +
'      document.querySelector(\'input[name="amount"]\').value = amount;' +
'      document.querySelector(\'input[name="date"]\').value = date;' +
'      document.querySelector(\'textarea[name="description"]\').value = description || \'\';' +
'      showModal(\'addExpenseModal\');' +
'    }' +

'    async function submitExpense() {' +
'      const id = document.getElementById(\'expenseId\').value;' +
'      const form = document.getElementById(\'addExpenseForm\');' +
'      const formData = new FormData(form);' +
'      const category = formData.get(\'category\');' +
'      const amountInput = form.querySelector(\'input[name="amount"]\');' +
'      const amount = parseFloat(parseFormattedNumber(amountInput.value));' +
'      const date = formData.get(\'date\');' +
'      const description = formData.get(\'description\') || null;' +

'      if (!category || !amount || !date) {' +
'        alert(\'Vui lòng điền đầy đủ thông tin!\');' +
'        return;' +
'      }' +

'      try {' +
'        let url = \'/api/expenses\';' +
'        let method = \'POST\';' +

'        if (id) {' +
'          url = \'/api/expenses/\' + id;' +
'          method = \'PUT\';' +
'        }' +

'        const res = await fetch(url, {' +
'          method: method,' +
'          headers: { \'Content-Type\': \'application/json\' },' +
'          body: JSON.stringify({ category, amount, date, description })' +
'        });' +

'        if (res.ok) {' +
'          hideModal(\'addExpenseModal\');' +
'          form.reset();' +
'          document.getElementById(\'expenseId\').value = \'\';' +
'          document.querySelector(\'#addExpenseModal h2\').textContent = \'Thêm chi phí\';' +
'          location.reload();' +
'        } else {' +
'          const err = await res.json();' +
'          alert(err.error || \'Lỗi khi lưu\');' +
'        }' +
'      } catch (err) {' +
'        alert(\'Lỗi kết nối: \' + err.message);' +
'      }' +
'    }' +

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
'  <script src="/js/numfmt.js"></script>' +
'  <script src="/sync.js"></script>' +
'</body>' +
'</html>');
});

module.exports = router;
