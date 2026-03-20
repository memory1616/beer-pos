// Customers Page JavaScript
// Tách riêng để dễ bảo trì và cache

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// Toast notification
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  const bgColor = type === 'success' ? 'bg-green-500' : (type === 'error' ? 'bg-red-500' : 'bg-blue-500');
  toast.className = `fixed top-4 right-4 ${bgColor} text-white px-6 py-3 rounded-lg shadow-lg z-50 transform transition-all duration-300 translate-x-full`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.remove('translate-x-full'), 100);
  setTimeout(() => {
    toast.classList.add('translate-x-full');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

let customers = [];
let archivedCustomers = [];
let currentTab = 'active';
let products = [];

function initCustomersPage(data) {
  customers = data.customers;
  archivedCustomers = data.archived || [];
  products = data.products;
  
  updateCount();
  renderCustomers();
}

function updateCount() {
  const countEl = document.getElementById('customerCount');
  if (!countEl) return;
  if (currentTab === 'active') {
    countEl.textContent = customers.length;
  } else {
    countEl.textContent = archivedCustomers.length;
  }
}

function switchCustomerTab(tab) {
  currentTab = tab;
  const tabActive = document.getElementById('tabActive');
  const tabArchived = document.getElementById('tabArchived');
  const archivedSection = document.getElementById('archivedSection');

  if (tab === 'active') {
    tabActive.className = 'flex-1 py-2.5 rounded-xl font-semibold text-sm transition-all bg-blue-600 text-white shadow';
    tabArchived.className = 'flex-1 py-2.5 rounded-xl font-semibold text-sm transition-all bg-white text-gray-600 border border-gray-200 shadow-sm';
    if (archivedSection) archivedSection.classList.add('hidden');
  } else {
    tabActive.className = 'flex-1 py-2.5 rounded-xl font-semibold text-sm transition-all bg-white text-gray-600 border border-gray-200 shadow-sm';
    tabArchived.className = 'flex-1 py-2.5 rounded-xl font-semibold text-sm transition-all bg-gray-500 text-white shadow';
    if (archivedSection) archivedSection.classList.remove('hidden');
  }

  updateCount();
  renderCustomers();
}

function renderCustomers() {
  const container = document.getElementById('customersList');
  if (!container) return;
  
  const searchInput = document.getElementById('searchInput');
  const search = searchInput ? searchInput.value.toLowerCase() : '';

  const source = currentTab === 'active' ? customers : archivedCustomers;
  const filtered = source.filter(c => c.name.toLowerCase().includes(search));

  if (filtered.length === 0) {
    container.innerHTML = '<div class="text-center text-gray-500 py-8 bg-white rounded-xl shadow-sm">Không có khách hàng nào</div>';
    return;
  }

  container.innerHTML = filtered.map(c => {
    const hasLocation = c.lat && c.lng;
    
    // Status badge based on daily average and days since last order
    // 🟢 hoạt động (trung bình ngày > 10 bình)
    // 🟡 ít mua (trung bình ngày < 5 bình)
    // 🔴 7 ngày chưa mua
    let statusBadge = '';
    let statusClass = '';
    let statusBg = '';
    if (currentTab === 'active') {
      if (c.days_since_last_order !== null && c.days_since_last_order !== undefined) {
        if (c.days_since_last_order >= 7) {
          statusBadge = '🔴';
          statusClass = 'text-red-600';
          statusBg = 'bg-red-50';
        } else if (c.daily_avg < 5) {
          statusBadge = '🟡';
          statusClass = 'text-yellow-600';
          statusBg = 'bg-yellow-50';
        } else {
          statusBadge = '🟢';
          statusClass = 'text-green-600';
          statusBg = 'bg-green-50';
        }
      } else {
        statusBadge = '🟡';
        statusClass = 'text-yellow-600';
        statusBg = 'bg-yellow-50';
      }
    }

    return `
      <div class="card customer-card hover:shadow-lg transition-all duration-200 bg-white rounded-xl border border-gray-100 ${c.archived ? 'opacity-70' : ''}" data-name="${c.name.toLowerCase()}">
        <div class="flex justify-between items-start">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-1">
              <a href="/customers/${c.id}" class="font-bold text-lg text-gray-800 hover:text-green-600">${c.name}</a>
              <span class="text-xl" title="${statusClass.includes('red') ? '7+ ngày chưa mua' : (statusClass.includes('yellow') ? 'Ít mua' : 'Hoạt động')}">${statusBadge}</span>
            </div>
            <div class="text-gray-500 text-sm flex items-center gap-1">
              <span>📱</span> ${c.phone || 'Chưa có SĐT'}
            </div>
          </div>
          <div class="text-right">
            <div class="inline-flex items-center gap-1 px-3 py-1.5 bg-amber-50 rounded-lg border border-amber-200">
              <span class="text-amber-600 font-bold">📦 ${c.keg_balance || 0}</span>
              <span class="text-xs text-amber-500">vỏ</span>
            </div>
            ${((c.horizontal_fridge || 0) > 0 || (c.vertical_fridge || 0) > 0) ? `
              <div class="mt-1 text-xs text-indigo-600 font-medium">
                ❄️ ${c.horizontal_fridge || 0} + 🥶 ${c.vertical_fridge || 0}
              </div>
            ` : ''}
            ${c.monthly_liters > 0 ? `
              <div class="mt-1 text-xs text-green-600 font-medium flex items-center justify-end gap-1">
                <span>📈</span> ${c.monthly_liters} bình/tháng
              </div>
            ` : ''}
          </div>
        </div>
        
        ${currentTab === 'active' ? `
        <div class="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-100">
          <button onclick="getLocation(${c.id})" class="flex-1 px-3 py-2.5 bg-gradient-to-r from-orange-50 to-orange-100 text-orange-700 rounded-lg font-medium text-sm border border-orange-200 hover:from-orange-100 hover:to-orange-150 transition-all">
            📍 GPS
          </button>
          <button onclick="editCustomer(${c.id}, '${c.name}', '${c.phone || ''}', ${c.deposit})" class="flex-1 px-3 py-2.5 bg-gradient-to-r from-blue-50 to-blue-100 text-blue-700 rounded-lg font-medium text-sm border border-blue-200 hover:from-blue-100 hover:to-blue-150 transition-all">
            ✏️ Sửa
          </button>
          <button onclick="showPriceModal(${c.id}, '${c.name}')" class="flex-1 px-3 py-2.5 bg-gradient-to-r from-green-50 to-green-100 text-green-700 rounded-lg font-medium text-sm border border-green-200 hover:from-green-100 hover:to-green-150 transition-all">
            💰 Giá
          </button>
          <button onclick="archiveCustomer(${c.id})" class="px-3 py-2.5 bg-gray-100 text-gray-500 rounded-lg border border-gray-200 hover:bg-gray-200 transition-all" title="Lưu trữ">
            📦
          </button>
        </div>
        ` : `
        <div class="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-100">
          <button onclick="unarchiveCustomer(${c.id})" class="flex-1 px-3 py-2.5 bg-gradient-to-r from-green-50 to-green-100 text-green-700 rounded-lg font-medium text-sm border border-green-200 hover:from-green-100 hover:to-green-150 transition-all">
            📤 Khôi phục
          </button>
          <button onclick="deleteCustomer(${c.id})" class="px-3 py-2.5 bg-red-50 text-red-500 rounded-lg border border-red-100 hover:bg-red-100 transition-all">
            🗑️ Xóa
          </button>
        </div>
        `}
        
        <div class="mt-3 pt-3 border-t border-gray-100 flex justify-between items-center">
          <div class="text-sm flex items-center gap-2">
            <span class="text-gray-400">💵 Đặt cọc:</span>
            <span class="font-semibold ${c.deposit > 0 ? 'text-blue-600' : 'text-gray-400'}">${formatVND(c.deposit)}</span>
          </div>
          <div class="flex items-center gap-3">
            ${currentTab === 'active' ? `
            <button onclick="editKegBalance(${c.id}, ${c.keg_balance}, '${c.name}')" class="text-xs text-blue-500 hover:text-blue-700 hover:bg-blue-50 px-2 py-1 rounded transition-colors">✏️ Sửa vỏ</button>
            ` : ''}
            ${hasLocation ? '<span class="text-green-500 text-xs" title="Đã có vị trí">✅</span>' : ''}
          </div>
        </div>
        ${c.last_sale_date ? '<div class="text-xs text-gray-400 mt-2 flex items-center gap-1">🕐 Mua lần cuối: ' + new Date(c.last_sale_date).toLocaleDateString('vi-VN') + '</div>' : ''}
        ${c.archived ? '<div class="text-xs text-gray-400 mt-2 flex items-center gap-1">📦 Đã lưu trữ</div>' : ''}
      </div>
    `;
  }).join('');
}

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.getElementById(id).classList.add('flex');
}

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.getElementById(id).classList.remove('flex');
}

async function saveKegBalance() {
  const customerId = document.getElementById('kegCustomerId').value;
  const newBalance = parseInt(document.getElementById('kegBalanceInput').value);
  const note = document.getElementById('kegNote').value;

  if (isNaN(newBalance) || newBalance < 0) {
    alert('Số bình không hợp lệ!');
    return;
  }

  try {
    const res = await fetch('/api/payments/keg/update-balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: parseInt(customerId), balance: newBalance, note: note })
    });

    if (res.ok) {
      alert(`✅ Cập nhật vỏ thành công!\n\nSố vỏ còn tại quán: ${newBalance}`);
      hideModal('kegModal');
      location.reload();
    } else {
      const data = await res.json();
      alert(data.error || 'Lỗi khi lưu');
    }
  } catch (e) {
    alert('Lỗi kết nối: ' + e.message);
  }
}

function filterCustomers() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const searchInput = document.getElementById('searchInput');
    const search = searchInput ? searchInput.value.toLowerCase() : '';
    const source = currentTab === 'active' ? customers : archivedCustomers;
    const filtered = source.filter(c => c.name.toLowerCase().includes(search));
    const container = document.getElementById('customersList');
    if (!container) return;
    if (filtered.length === 0) {
      container.innerHTML = '<div class="text-center text-gray-500 py-8 bg-white rounded-xl shadow-sm">Không có khách hàng nào</div>';
      return;
    }
    // Use existing render logic
    window._filtered = filtered;
    renderCustomers();
  }, 200);
}

function editCustomer(id, name, phone, deposit) {
  document.getElementById('editId').value = id;
  document.getElementById('editName').value = name;
  document.getElementById('editPhone').value = phone;
  document.getElementById('editDeposit').value = deposit;
  
  // Load fridge counts
  fetch('/api/customers/' + id)
    .then(res => res.json())
    .then(data => {
      document.getElementById('editHorizontalFridge').value = data.horizontal_fridge || 0;
      document.getElementById('editVerticalFridge').value = data.vertical_fridge || 0;
    });
  
  showModal('editModal');
}

async function saveCustomerEdit() {
  const id = document.getElementById('editId').value;
  const name = document.getElementById('editName').value;
  const phone = document.getElementById('editPhone').value || null;
  const deposit = parseFormattedNumber(document.getElementById('editDeposit').value);
  const horizontal_fridge = parseInt(document.getElementById('editHorizontalFridge').value.replace(/,/g, '')) || 0;
  const vertical_fridge = parseInt(document.getElementById('editVerticalFridge').value.replace(/,/g, '')) || 0;
  
  if (!id) {
    alert('Lỗi: Không tìm thấy ID khách hàng');
    return;
  }
  
  if (!name || name.trim() === '') {
    alert('Vui lòng nhập tên khách hàng');
    return;
  }
  
  try {
    const res = await fetch('/api/customers/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, deposit, horizontal_fridge, vertical_fridge })
    });
    
    if (res.ok) {
      hideModal('editModal');
      location.reload();
    } else {
      const data = await res.json();
      alert(data.error || 'Cập nhật thất bại');
    }
  } catch (e) {
    alert('Lỗi kết nối: ' + e.message);
  }
}

function showPriceModal(id, name) {
  document.getElementById('priceCustomerName').textContent = name;
  document.getElementById('priceList').innerHTML = '<div class="text-gray-500 text-center py-4">Đang tải sản phẩm...</div>';
  
  // Load products and existing prices in parallel
  Promise.all([
    fetch('/api/products').then(res => {
      if (!res.ok) throw new Error('Failed to load products');
      return res.json();
    }),
    fetch('/api/products/prices?customerId=' + id).then(res => {
      if (!res.ok) throw new Error('Failed to load prices');
      return res.json();
    })
  ]).then(([products, existingPrices]) => {
    const productPrices = {};
    existingPrices.forEach(p => {
      productPrices[p.product_id] = p.price;
    });
    
    const container = document.getElementById('priceList');
    if (products.length === 0) {
      container.innerHTML = '<div class="text-gray-500 text-center py-4">Chưa có sản phẩm nào</div>';
      return;
    }
    
    let html = '';
    products.forEach(p => {
      const price = productPrices[p.id] || '';
      html += '<div class="flex justify-between items-center py-2 border-b">' +
        '<div class="font-medium">' + p.name + '</div>' +
        '<input type="text" data-product="' + p.id + '" value="' + price + '" data-format-number inputmode="decimal" ' +
        'class="border p-2 w-28 rounded text-right" placeholder="Giá">' +
      '</div>';
    });
    container.innerHTML = html;
    window.currentPriceCustomerId = id;
    
    // Initialize number format for new inputs
    initAllNumberFormats();
  }).catch(err => {
    console.error('Error loading data:', err);
    document.getElementById('priceList').innerHTML = '<div class="text-red-500 text-center py-4">❌ Lỗi tải dữ liệu: ' + err.message + '</div>';
  });
  
  showModal('priceModal');
}

async function savePrices() {
  const customerId = window.currentPriceCustomerId;
  if (!customerId) return;
  
  const inputs = document.querySelectorAll('#priceList input');
  const prices = [];
  
  inputs.forEach(i => {
    const rawValue = i.value.replace(/,/g, '');
    const price = parseFloat(rawValue);
    if (!isNaN(price)) {
      prices.push({
        product_id: parseInt(i.dataset.product),
        price: price
      });
    }
  });
  
  const res = await fetch('/api/products/prices/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId, prices: prices })
  });
  
  if (res.ok) {
    alert('Đã lưu bảng giá!');
    hideModal('priceModal');
    location.reload();
  } else {
    alert('Lưu thất bại');
  }
}

let addProductsLoaded = false;
function toggleAddPrices() {
  const priceFields = document.getElementById('addPriceFields');
  const toggleBtn = document.getElementById('togglePriceBtn');
  
  if (priceFields.classList.contains('hidden')) {
    priceFields.classList.remove('hidden');
    toggleBtn.textContent = '− Ẩn giá';
    if (!addProductsLoaded) loadAddProducts();
  } else {
    priceFields.classList.add('hidden');
    toggleBtn.textContent = '+ Thêm giá';
  }
}

async function loadAddProducts() {
  try {
    const res = await fetch('/api/products');
    if (!res.ok) throw new Error('Failed to load products');
    const products = await res.json();
    
    const container = document.getElementById('addPriceList');
    if (products.length === 0) {
      container.innerHTML = '<div class="text-gray-500 text-sm text-center py-2">Chưa có sản phẩm nào</div>';
    } else {
      container.innerHTML = products.map(p => 
        '<div class="flex items-center justify-between py-2 border-b border-gray-100">' +
          '<span class="text-sm font-medium text-gray-700">' + p.name + '</span>' +
          '<input type="text" name="price_' + p.id + '" data-product="' + p.id + '" data-format-number inputmode="decimal" ' +
            'class="border border-gray-300 rounded px-2 py-1 w-24 text-right text-sm" ' +
            'placeholder="Giá">' +
        '</div>'
      ).join('');
      addProductsLoaded = true;
      
      // Initialize number format for new inputs
      initAllNumberFormats();
    }
  } catch (e) {
    console.error('Failed to load products:', e);
  }
}

document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  data.deposit = parseFormattedNumber(data.deposit);
  data.horizontal_fridge = parseInt(String(data.horizontal_fridge).replace(/,/g, '')) || 0;
  data.vertical_fridge = parseInt(String(data.vertical_fridge).replace(/,/g, '')) || 0;
  
  const prices = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('price_') && value) {
      const productId = key.replace('price_', '');
      prices[productId] = parseFloat(String(value).replace(/,/g, ''));
    }
  }
  data.prices = prices;
  
  const res = await fetch('/api/customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (res.ok) location.reload();
  else alert('Thêm thất bại');
});

document.getElementById('editForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveCustomerEdit();
});

async function archiveCustomer(id) {
  if (!confirm('Lưu trữ khách hàng này?\n\n- Khách sẽ không hiển thị khi bán hàng\n- Doanh thu vẫn giữ nguyên')) return;
  const res = await fetch('/api/customers/' + id + '/archive', { method: 'PUT' });
  if (res.ok) {
    showToast('Đã lưu trữ khách hàng!', 'success');
    location.reload();
  } else {
    const data = await res.json();
    alert(data.error || 'Lỗi');
  }
}

async function unarchiveCustomer(id) {
  if (!confirm('Khôi phục khách hàng này?')) return;
  const res = await fetch('/api/customers/' + id + '/archive', { method: 'PUT' });
  if (res.ok) {
    showToast('Đã khôi phục khách hàng!', 'success');
    location.reload();
  } else {
    const data = await res.json();
    alert(data.error || 'Lỗi');
  }
}

async function deleteCustomer(id) {
  if (!confirm('⚠️ XÓA VĨNH VIỄN khách hàng này?\n\nTất cả dữ liệu (đơn hàng, công nợ...) sẽ bị mất!\n\nKhuyến nghị: Nên dùng "Lưu trữ" thay vì xóa.')) return;
  const res = await fetch('/api/customers/' + id, { method: 'DELETE' });
  if (res.ok) location.reload();
  else alert('Xóa thất bại');
}

function getLocation(customerId) {
  document.getElementById('locationCustomerId').value = customerId;
  document.getElementById('manualLat').value = '';
  document.getElementById('manualLng').value = '';
  document.getElementById('gpsStatus').innerHTML = '';
  document.getElementById('detectedAddress').innerHTML = '';
  window.detectedAddress = null;
  showModal('locationModal');

  // Auto-trigger GPS after modal opens
  setTimeout(() => {
    if (navigator.geolocation) {
      getGPSLocation();
    }
  }, 500);
}

function getGPSLocation() {
  const customerId = document.getElementById('locationCustomerId').value;
  const statusEl = document.getElementById('gpsStatus');
  const addressEl = document.getElementById('detectedAddress');

  if (!navigator.geolocation) {
    statusEl.innerHTML = '<p class="text-red-500">❌ Trình duyệt không hỗ trợ lấy vị trí</p><p class="text-sm text-gray-500">Vui lòng nhập thủ công</p>';
    return;
  }

  // Show loading
  statusEl.innerHTML = `
    <div class="animate-pulse">
      <p class="text-blue-500">⏳ Đang lấy vị trí GPS...</p>
      <p class="text-xs text-gray-400">⏱ Chờ quyền truy cập...</p>
    </div>
    <button onclick="getGPSLocation()" class="mt-2 text-sm text-orange-600 hover:text-orange-800 underline">
      Thử lại
    </button>
  `;

  const options = {
    enableHighAccuracy: true,
    timeout: 20000,
    maximumAge: 0
  };

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const accuracy = Math.round(position.coords.accuracy);

      // Display accuracy
      let accuracyText = '';
      if (accuracy <= 10) {
        accuracyText = '<span class="text-green-600">Rất tốt (≤10m)</span>';
      } else if (accuracy <= 50) {
        accuracyText = '<span class="text-yellow-600">Tốt (≤50m)</span>';
      } else if (accuracy <= 100) {
        accuracyText = '<span class="text-orange-600">Trung bình (≤100m)</span>';
      } else {
        accuracyText = '<span class="text-red-600">Kém (>100m)</span>';
      }

      statusEl.innerHTML = `<p class="text-green-600">✅ Đã lấy được vị trí!</p>
        <p class="text-sm text-gray-600">Độ chính xác: ${accuracyText}</p>
        <p class="text-xs text-gray-500">Tọa độ: ${lat.toFixed(6)}, ${lng.toFixed(6)}</p>`;

      // Fill in the coordinates
      document.getElementById('manualLat').value = lat.toFixed(6);
      document.getElementById('manualLng').value = lng.toFixed(6);

      // Try reverse geocoding to get address
      try {
        addressEl.innerHTML = '<p class="text-blue-500">⏳ Đang lấy địa chỉ...</p>';
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`);
        const data = await res.json();

        if (data.display_name) {
          addressEl.innerHTML = `<p class="text-sm text-gray-700">📍 ${data.display_name}</p>
            <button onclick="useDetectedAddress('${data.display_name.replace(/'/g, "\\'")}')" class="mt-2 text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
              Sử dụng địa chỉ này
            </button>`;
          // Store the address for later use
          window.detectedAddress = data.display_name;
        }
      } catch (err) {
        console.log('Reverse geocoding failed:', err);
        addressEl.innerHTML = '<p class="text-gray-400">Không thể lấy địa chỉ</p>';
      }
    },
    (error) => {
      let errorMsg = 'Lỗi không xác định';
      switch (error.code) {
        case error.PERMISSION_DENIED:
          errorMsg = '❌ Bạn đã từ chối cho phép truy cập vị trí';
          break;
        case error.POSITION_UNAVAILABLE:
          errorMsg = '❌ Không thể xác định vị trí';
          break;
        case error.TIMEOUT:
          errorMsg = '❌ Hết thời gian chờ';
          break;
      }
      statusEl.innerHTML = `
        <p class="text-red-500 font-medium">${errorMsg}</p>
        <p class="text-sm text-gray-500 mt-1">Vui lòng nhập thủ công hoặc thử lại</p>
        <button onclick="getGPSLocation()" class="mt-3 px-4 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600">
          📍 Thử lại
        </button>
      `;
    },
    options
  );
}

function useDetectedAddress(address) {
  // Store the address to be saved with coordinates
  window.detectedAddress = address;
  alert('Địa chỉ đã được chọn! Bấm "Lưu" để lưu tọa độ và địa chỉ.');
}

async function saveManualLocation() {
  const customerId = document.getElementById('locationCustomerId').value;
  const lat = parseFloat(document.getElementById('manualLat').value);
  const lng = parseFloat(document.getElementById('manualLng').value);
  const address = window.detectedAddress || null;

  if (isNaN(lat) || isNaN(lng)) {
    alert('Vui lòng nhập đầy đủ vĩ độ và kinh độ!');
    return;
  }

  // Validate coordinate ranges for Vietnam
  if (lat < 8 || lat > 24 || lng < 102 || lng > 110) {
    if (!confirm('Tọa độ có vẻ không nằm trong Việt Nam. Bạn có muốn tiếp tục không?')) {
      return;
    }
  }

  try {
    const res = await fetch('/api/customers/location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: parseInt(customerId),
        lat,
        lng,
        address
      })
    });

    const data = await res.json();
    if (res.ok) {
      hideModal('locationModal');
      window.detectedAddress = null;
      showToast('Đã cập nhật vị trí!', 'success');
      location.reload();
    } else {
      alert('Cập nhật thất bại: ' + (data.error || 'Lỗi không xác định'));
    }
  } catch (err) {
    alert('Lỗi kết nối: ' + err.message);
  }
}

function editKegBalance(id, balance, name) {
  document.getElementById('kegCustomerId').value = id;
  document.getElementById('kegCustomerName').textContent = name;
  document.getElementById('kegBalanceInput').value = balance;
  document.getElementById('kegNote').value = '';
  showModal('kegModal');
}

// Initialize bottom nav active state
const path = window.location.pathname;
document.querySelectorAll('.bottomnav a').forEach(a => {
  const href = a.getAttribute('href');
  if (href === path || (path === '/' && href === '/')) {
    a.classList.add('active');
  }
});
