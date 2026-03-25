const express = require('express');
const router = express.Router();
const db = require('../database');

// GET /devices - Simple device management by customer
router.get('/', (req, res) => {
  // Get customers with fridge counts directly from customers table
  const customers = db.prepare(`
    SELECT 
      id, name, phone,
      COALESCE(horizontal_fridge, 0) as horizontal_fridge,
      COALESCE(vertical_fridge, 0) as vertical_fridge
    FROM customers 
    WHERE horizontal_fridge > 0 OR vertical_fridge > 0
    ORDER BY name
  `).all();
  
  // Get totals
  const totals = db.prepare(`
    SELECT 
      COALESCE(SUM(horizontal_fridge), 0) as total_horizontal,
      COALESCE(SUM(vertical_fridge), 0) as total_vertical
    FROM customers
  `).get();
  
  // Get available devices (tủ chưa dùng)
  const availableDevices = db.prepare(`
    SELECT type, COUNT(*) as count 
    FROM devices 
    WHERE status = 'available' 
    GROUP BY type
  `).all();
  
  const availableHorizontal = availableDevices.find(d => d.type === 'horizontal')?.count || 0;
  const availableVertical = availableDevices.find(d => d.type === 'vertical')?.count || 0;
  
  const horizontalCustomers = customers.filter(c => c.horizontal_fridge > 0);
  const verticalCustomers = customers.filter(c => c.vertical_fridge > 0);
  
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quản lý thiết bị - Beer POS</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#f59e0b">
  <link rel="stylesheet" href="/css/tailwind.css">
  <script src="/js/auth.js"></script>
  <link rel="stylesheet" href="/css/unified.css">
  <script src="/js/layout.js"></script>
  <style>
    .bottom-nav { max-width: 500px; margin: auto; }
    input, button, a { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    .modal { display: none; }
    .modal.active { display: flex; }
  </style>
</head>
<body class="bg-gray-100 text-gray-800 min-h-screen pb-20">
  <header class="sticky top-0 bg-white border-b z-50 shadow-sm">
    <div class="flex items-center justify-between px-4 h-12 max-w-md mx-auto">
      <div class="flex items-center gap-2">
        <a href="/" class="text-gray-500 hover:text-gray-700 p-1">←</a>
        <span class="font-semibold">Quản lý thiết bị</span>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="openEditModal()" class="text-blue-600 font-medium text-sm flex items-center gap-1">
          ✏️ Sửa kho
        </button>
        <button onclick="openModal()" class="text-amber-600 font-medium text-sm flex items-center gap-1">
          <span class="text-lg">+</span> Nhập tủ
        </button>
      </div>
    </div>
  </header>

  <main class="p-3 pb-24 max-w-md mx-auto">
    <!-- Available devices (tủ trong kho) -->
    <div class="mb-4">
      <div class="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
        <span>📦 Tủ chưa dùng (kho)</span>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="card p-3 text-center bg-green-50">
          <div class="text-2xl font-bold text-amber-600">${availableHorizontal}</div>
          <div class="text-xs text-gray-600">❄️ Tủ nằm</div>
        </div>
        <div class="card p-3 text-center bg-green-50">
          <div class="text-2xl font-bold text-amber-600">${availableVertical}</div>
          <div class="text-xs text-gray-600">🥶 Tủ đứng</div>
        </div>
      </div>
    </div>

    <!-- In use -->
    <div class="space-y-4">
      <!-- Horizontal group -->
      <section>
        <div class="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
          <span>❄️ Tủ lạnh nằm đang được giữ</span>
          <span class="text-xs text-gray-500">(${horizontalCustomers.length} khách)</span>
        </div>
        ${horizontalCustomers.length === 0 ? `
          <div class="text-xs text-gray-500 px-3 py-4 bg-white rounded-lg border border-dashed text-center">
            Chưa có khách giữ tủ nằm
          </div>
        ` : `
          <div class="space-y-2">
            ${horizontalCustomers.map(c => `
              <a href="/customers/${c.id}" class="card p-3 flex items-center justify-between hover:bg-gray-50">
                <div>
                  <div class="font-medium">${c.name}</div>
                  <div class="text-xs text-gray-500">${c.phone || ''}</div>
                </div>
                <span class="px-2 py-1 bg-blue-100 text-blue-700 rounded-lg text-xs font-medium">
                  ❄️ ${c.horizontal_fridge}
                </span>
              </a>
            `).join('')}
          </div>
        `}
      </section>

      <!-- Vertical group -->
      <section>
        <div class="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
          <span>🥶 Tủ mát đứng đang được giữ</span>
          <span class="text-xs text-gray-500">(${verticalCustomers.length} khách)</span>
        </div>
        ${verticalCustomers.length === 0 ? `
          <div class="text-xs text-gray-500 px-3 py-4 bg-white rounded-lg border border-dashed text-center">
            Chưa có khách giữ tủ đứng
          </div>
        ` : `
          <div class="space-y-2">
            ${verticalCustomers.map(c => `
              <a href="/customers/${c.id}" class="card p-3 flex items-center justify-between hover:bg-gray-50">
                <div>
                  <div class="font-medium">${c.name}</div>
                  <div class="text-xs text-gray-500">${c.phone || ''}</div>
                </div>
                <span class="px-2 py-1 bg-purple-100 text-purple-700 rounded-lg text-xs font-medium">
                  🥶 ${c.vertical_fridge}
                </span>
              </a>
            `).join('')}
          </div>
        `}
      </section>
    </div>
  </main>

  <!-- Modal nhập tủ -->
  <div id="addModal" class="modal fixed inset-0 bg-black/50 z-50 items-center justify-center p-4">
    <div class="bg-white rounded-xl w-full max-w-sm">
      <div class="p-4 border-b flex items-center justify-between">
        <h3 class="font-semibold">Nhập tủ mới</h3>
        <button onclick="closeModal()" class="text-gray-500 hover:text-gray-700">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <form id="addForm" onsubmit="submitForm(event)" class="p-4 space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Loại tủ</label>
          <div class="grid grid-cols-2 gap-2">
            <label class="cursor-pointer">
              <input type="radio" name="type" value="horizontal" class="peer sr-only" checked>
              <div class="p-3 border-2 border-gray-200 rounded-lg text-center peer-checked:border-blue-500 peer-checked:bg-blue-50">
                <div class="text-2xl mb-1">❄️</div>
                <div class="text-sm font-medium">Tủ nằm</div>
              </div>
            </label>
            <label class="cursor-pointer">
              <input type="radio" name="type" value="vertical" class="peer sr-only">
              <div class="p-3 border-2 border-gray-200 rounded-lg text-center peer-checked:border-purple-500 peer-checked:bg-purple-50">
                <div class="text-2xl mb-1">🥶</div>
                <div class="text-sm font-medium">Tủ đứng</div>
              </div>
            </label>
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Số lượng</label>
          <input type="number" name="quantity" min="1" value="1" required
            class="w-full border rounded-lg px-3 py-2 text-center text-lg">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Mã serial (tùy chọn)</label>
          <input type="text" name="serial" placeholder="Nhập mã serial"
            class="w-full border rounded-lg px-3 py-2">
        </div>
        <button type="submit" class="w-full bg-green-500 text-white py-3 rounded-lg font-medium">
          Thêm vào kho
        </button>
      </form>
    </div>
  </div>

  <!-- Modal sửa tồn kho -->
  <div id="editModal" class="modal fixed inset-0 bg-black/50 z-50 items-center justify-center p-4">
    <div class="bg-white rounded-xl w-full max-w-sm">
      <div class="p-4 border-b flex items-center justify-between">
        <h3 class="font-semibold">Sửa tồn kho</h3>
        <button onclick="closeEditModal()" class="text-gray-500 hover:text-gray-700">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <form id="editForm" onsubmit="submitEditForm(event)" class="p-4 space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">❄️ Tủ nằm tồn kho</label>
          <input type="number" name="horizontal" min="0" value="${availableHorizontal}" required
            class="w-full border rounded-lg px-3 py-2 text-center text-lg">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">🥶 Tủ đứng tồn kho</label>
          <input type="number" name="vertical" min="0" value="${availableVertical}" required
            class="w-full border rounded-lg px-3 py-2 text-center text-lg">
        </div>
        <button type="submit" class="w-full bg-blue-500 text-white py-3 rounded-lg font-medium">
          Lưu thay đổi
        </button>
      </form>
    </div>
  </div>

  <!-- Bottom Navigation -->
  <nav class="fixed bottom-0 left-0 right-0 bg-white border-t bottom-nav">
    <div class="grid grid-cols-5 text-center text-xs">
      <a href="/" class="py-3 text-gray-500"><div class="text-xl">🏠</div><div>Home</div></a>
      <a href="/delivery" class="py-3 text-gray-500"><div class="text-xl">🚚</div><div>Giao</div></a>
      <a href="/sale" class="py-3 text-gray-500"><div class="text-xl">🍺</div><div>Bán</div></a>
      <a href="/customers" class="py-3 text-gray-500"><div class="text-xl">👤</div><div>KH</div></a>
      <a href="/devices" class="py-3 text-indigo-600"><div class="text-xl">📦</div><div>TB</div></a>
    </div>
  </nav>

  <script>
    if (!isLoggedIn()) { window.location.href = '/login'; }
    
    function openModal() { document.getElementById('addModal').classList.add('active'); }
    function closeModal() { document.getElementById('addModal').classList.remove('active'); }
    
    function openEditModal() { document.getElementById('editModal').classList.add('active'); }
    function closeEditModal() { document.getElementById('editModal').classList.remove('active'); }
    
    function submitForm(e) {
      e.preventDefault();
      const form = e.target;
      const data = {
        type: form.type.value,
        quantity: parseInt(form.quantity.value),
        serial: form.serial.value
      };
      
      fetch('/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          closeModal();
          location.reload();
        } else {
          alert(data.message || 'Có lỗi xảy ra');
        }
      })
      .catch(err => alert('Có lỗi xảy ra'));
    }

    function submitEditForm(e) {
      e.preventDefault();
      const form = e.target;
      const horizontal = parseInt(form.horizontal.value) || 0;
      const vertical = parseInt(form.vertical.value) || 0;
      
      fetch('/devices/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ horizontal, vertical })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          closeEditModal();
          location.reload();
        } else {
          alert(data.message || 'Có lỗi xảy ra');
        }
      })
      .catch(err => alert('Có lỗi xảy ra'));
    }
  </script>
</body>
</html>
  `);
});

// POST /devices - Add new device
router.post('/', (req, res) => {
  const { type, quantity, serial, name } = req.body;
  
  if (!type || !quantity) {
    return res.json({ success: false, message: 'Thiếu thông tin' });
  }
  
  try {
    const stmt = db.prepare(`
      INSERT INTO devices (name, type, serial_number, status, created_at) 
      VALUES (?, ?, ?, 'available', datetime('now'))
    `);
    
    // Auto-generate name if not provided
    const baseName = name || `Tủ ${type === 'horizontal' ? 'Nằm' : 'Đứng'}`;
    
    // Insert multiple devices if quantity > 1
    for (let i = 0; i < quantity; i++) {
      const serialNumber = serial ? (quantity > 1 ? `${serial}-${i+1}` : serial) : null;
      const deviceName = quantity > 1 ? `${baseName} #${i+1}` : baseName;
      stmt.run(deviceName, type, serialNumber);
    }
    
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// POST /devices/adjust - Adjust inventory
router.post('/adjust', (req, res) => {
  const { horizontal, vertical } = req.body;
  
  try {
    // Get current available counts
    const currentHorizontal = db.prepare(`SELECT COUNT(*) as count FROM devices WHERE type = 'horizontal' AND status = 'available'`).get().count;
    const currentVertical = db.prepare(`SELECT COUNT(*) as count FROM devices WHERE type = 'vertical' AND status = 'available'`).get().count;
    
    // Adjust horizontal
    if (horizontal !== currentHorizontal) {
      if (horizontal > currentHorizontal) {
        // Add more
        const toAdd = horizontal - currentHorizontal;
        const stmt = db.prepare(`INSERT INTO devices (name, type, status) VALUES (?, 'horizontal', 'available')`);
        for (let i = 0; i < toAdd; i++) {
          stmt.run(`Tủ Nằm ${currentHorizontal + i + 1}`);
        }
      } else {
        // Remove excess (delete oldest available)
        const toRemove = currentHorizontal - horizontal;
        db.prepare(`DELETE FROM devices WHERE type = 'horizontal' AND status = 'available' ORDER BY id LIMIT ?`).run(toRemove);
      }
    }
    
    // Adjust vertical
    if (vertical !== currentVertical) {
      if (vertical > currentVertical) {
        // Add more
        const toAdd = vertical - currentVertical;
        const stmt = db.prepare(`INSERT INTO devices (name, type, status) VALUES (?, 'vertical', 'available')`);
        for (let i = 0; i < toAdd; i++) {
          stmt.run(`Tủ Đứng ${currentVertical + i + 1}`);
        }
      } else {
        // Remove excess (delete oldest available)
        const toRemove = currentVertical - vertical;
        db.prepare(`DELETE FROM devices WHERE type = 'vertical' AND status = 'available' ORDER BY id LIMIT ?`).run(toRemove);
      }
    }
    
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
