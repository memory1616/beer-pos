const express = require('express');
const router = express.Router();
const db = require('../database');

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

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

  // Expense categories
  const categories = ['Xăng dầu', 'Khấu hao', 'Hư hỏng', 'Điện nước', 'Nhân công', 'Thuê mặt bằng', 'Bảo trì', 'Marketing', 'Khác'];

  // Build category summary HTML
  let categoryHtml = '';
  if (categorySummary.length > 0) {
    categoryHtml = categorySummary.map(c => {
      return '<div class="flex justify-between items-center py-2 border-b last:border-0">' +
        '<span class="text-gray-600">' + c.category + '</span>' +
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
      return '<div class="flex justify-between items-center py-3 border-b last:border-0" data-id="' + e.id + '">' +
        '<div class="flex-1">' +
        '<div class="font-medium">' + e.category + '</div>' +
        '<div class="text-sm text-gray-500">' + desc + '</div>' +
        '<div class="text-xs text-gray-400">' + dateStr + '</div>' +
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
'      <h2 class="text-xl font-semibold mb-4">Thêm chi phí</h2>' +
'      <form id="addExpenseForm" method="POST" class="space-y-4">' +
'        <div>' +
'          <label class="block text-sm font-medium text-gray-700 mb-1">Loại chi phí</label>' +
'          <select name="category" required class="w-full border border-gray-300 rounded-lg px-4 py-3 text-lg focus:ring-2 focus:ring-red-500">' +
'            <option value="">-- Chọn loại --</option>' +
            optionsHtml +
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
'  </script>' +
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
'    // Wait for DOM to be ready before adding event listeners' +
'    document.addEventListener(\'DOMContentLoaded\', function() {' +
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