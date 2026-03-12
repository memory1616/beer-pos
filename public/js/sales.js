// Sales Page JavaScript
// Tách riêng để dễ bảo trì và cache

let products = [];
let priceMap = {};
let customers = [];
let editingSaleId = null;
let saleData = {};

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// Show loading indicator
function showLoading(message = 'Đang xử lý...') {
  let overlay = document.getElementById('loadingOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loadingOverlay';
    overlay.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-50';
    overlay.innerHTML = `
      <div class="bg-white rounded-lg p-6 flex flex-col items-center shadow-xl">
        <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mb-4"></div>
        <p class="text-gray-700 font-medium" id="loadingMessage">${message}</p>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  document.getElementById('loadingMessage').textContent = message;
  overlay.classList.remove('hidden');
}

// Hide loading indicator
function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
}

// Show toast notification
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  const bgColor = type === 'success' ? 'bg-green-500' : (type === 'error' ? 'bg-red-500' : 'bg-blue-500');
  toast.className = `fixed top-4 right-4 ${bgColor} text-white px-6 py-3 rounded-lg shadow-lg z-50 transform transition-all duration-300 translate-x-full`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Animate in
  setTimeout(() => toast.classList.remove('translate-x-full'), 100);

  // Remove after 3 seconds
  setTimeout(() => {
    toast.classList.add('translate-x-full');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function initSalesPage(data) {
  products = data.products;
  customers = data.customers;
  priceMap = data.priceMap;
  
  // Render customer select - include "Khach le" option
  const customerSelect = document.getElementById('customerSelect');
  customerSelect.innerHTML = '<option value="">📋 Khách lẻ (giá thường)</option>' + 
    customers.map(c => '<option value="' + c.id + '">' + c.name + ' (' + c.keg_balance + ' bình)</option>').join('');
  
  // Render products in list format (like import form)
  renderSaleProducts();
  
  // Load history
  loadSalesHistory();
}

function renderSaleProducts() {
  const container = document.getElementById('saleProducts');
  
  container.innerHTML = products.map(p => {
    const price = p.sell_price || 0;
    const isLowStock = p.stock < 5;
    return `
      <div class="bg-white rounded-xl p-4 shadow-sm ${isLowStock ? 'border border-orange-300 bg-orange-50' : ''}">
        <div class="flex justify-between items-center gap-3 mb-3">
          <div>
            <div class="font-semibold text-gray-800 text-lg">${p.name}</div>
            <div class="text-xs text-gray-500">Tồn kho: ${p.stock}</div>
          </div>
          <div class="text-right">
            <div class="text-sm text-gray-500">Giá</div>
            <input type="number" id="price-${p.id}" step="1000"
              class="w-32 border-2 border-amber-200 rounded-2xl px-3 py-2 text-right font-bold text-lg focus:border-amber-500"
              value="${price}"
              onchange="updateSaleData(${p.id}, 'price', this.value)"
              oninput="updateSaleData(${p.id}, 'price', this.value)">
          </div>
        </div>
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between gap-6">
            <button type="button" onclick="adjustQty(${p.id}, -1)" class="w-16 h-14 rounded-xl bg-gray-200 hover:bg-gray-300 text-xl font-bold">-</button>
            <input type="number" id="qty-${p.id}" min="0" max="${p.stock}" placeholder="0"
              class="w-24 h-14 border-2 border-amber-400 rounded-xl text-center text-2xl font-bold border-dashed"
              onchange="updateSaleData(${p.id}, 'quantity', this.value)"
              oninput="updateSaleData(${p.id}, 'quantity', this.value)">
            <button type="button" onclick="adjustQty(${p.id}, 1)" class="w-16 h-14 rounded-xl bg-amber-400 hover:bg-amber-500 text-white text-xl font-bold">+</button>
          </div>
          <div class="flex items-center justify-center gap-4">
            <button type="button" onclick="adjustQty(${p.id}, 1)" class="w-20 py-3 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-xl font-bold text-sm">+1</button>
            <button type="button" onclick="adjustQty(${p.id}, 5)" class="w-20 py-3 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-xl font-bold text-sm">+5</button>
            <button type="button" onclick="adjustQty(${p.id}, 10)" class="w-20 py-3 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-xl font-bold text-sm">+10</button>
            <button type="button" onclick="adjustQty(${p.id}, 20)" class="w-20 py-3 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-xl font-bold text-sm">+20</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Quick adjust quantity
function adjustQty(productId, amount) {
  const input = document.getElementById('qty-' + productId);
  const current = parseInt(input.value) || 0;
  const product = products.find(p => p.id === productId);
  const maxStock = product ? product.stock : 999;
  
  let newValue = current + amount;
  if (newValue < 0) newValue = 0;
  if (newValue > maxStock) newValue = maxStock;
  
  input.value = newValue;
  updateSaleData(productId, 'quantity', newValue);
}

function updateSaleData(productId, field, value) {
  if (!saleData[productId]) {
    const product = products.find(p => p.id === productId);
    saleData[productId] = {
      quantity: 0,
      price: product.sell_price || 0
    };
  }
  
  if (field === 'quantity') {
    saleData[productId].quantity = parseInt(value) || 0;
  } else if (field === 'price') {
    saleData[productId].price = parseFloat(value) || 0;
  }
  
  updateSaleTotal();
}

function updateSaleTotal() {
  let total = 0;
  let hasItems = false;
  
  Object.keys(saleData).forEach(productId => {
    const item = saleData[productId];
    if (item.quantity > 0 && item.price > 0) {
      total += item.quantity * item.price;
      hasItems = true;
    }
  });
  
  document.getElementById('totalAmount').textContent = formatVND(total);
  document.getElementById('sellBtn').disabled = !hasItems;
}

// Quick add product for fast sales
function quickAddProduct(amount) {
  const customerId = document.getElementById('customerSelect').value;
  if (!customerId) {
    alert('Vui lòng chọn khách hàng trước');
    return;
  }

  // Find product with highest stock or first available
  const availableProducts = products.filter(p => p.stock > 0);
  if (availableProducts.length === 0) {
    alert('Không có sản phẩm trong kho');
    return;
  }

  // Add to first product (or you can customize this logic)
  const product = availableProducts[0];
  const input = document.getElementById('input-' + product.id);
  const currentQty = parseInt(input.value) || 0;
  const maxAdd = product.stock - currentQty;
  const toAdd = Math.min(amount, maxAdd);

  if (toAdd <= 0) {
    alert('Sản phẩm ' + product.name + ' đã hết hàng');
    return;
  }

  input.value = currentQty + toAdd;
  document.getElementById('qty-' + product.id).textContent = currentQty + toAdd;
  updateCartFromInputs();
}

// Change quantity with +/- buttons
function changeQty(productId, delta) {
  const input = document.getElementById('input-' + productId);
  if (input) {
    const currentVal = parseInt(input.value) || 0;
    const stock = parseInt(input.dataset.stock);
    const newVal = Math.max(0, Math.min(currentVal + delta, stock));
    input.value = newVal;
    document.getElementById('qty-' + productId).textContent = newVal;
    updateCartFromInputs();
  }
}

function updatePrices() {
  const customerId = document.getElementById('customerSelect').value;
  
  // If customer selected, load their prices
  if (customerId) {
    fetch('/api/products/prices?customerId=' + customerId)
      .then(res => res.json())
      .then(prices => {
        // Update price inputs
        products.forEach(p => {
          const priceInput = document.getElementById('price-' + p.id);
          const customerPrice = prices.find(price => price.product_id === p.id);
          if (customerPrice) {
            priceInput.value = customerPrice.price;
            saleData[p.id] = saleData[p.id] || { quantity: 0, price: 0 };
            saleData[p.id].price = customerPrice.price;
          } else {
            priceInput.value = p.sell_price || 0;
          }
        });
        updateSaleTotal();
      })
      .catch(err => {
        console.error('Error loading prices:', err);
        // Fallback to default prices
        products.forEach(p => {
          const priceInput = document.getElementById('price-' + p.id);
          priceInput.value = p.sell_price || 0;
        });
        updateSaleTotal();
      });
  } else {
    // Reset to default prices
    products.forEach(p => {
      const priceInput = document.getElementById('price-' + p.id);
      priceInput.value = p.sell_price || 0;
      if (saleData[p.id]) {
        saleData[p.id].price = p.sell_price || 0;
      }
    });
    updateSaleTotal();
  }
}

function updateCartFromInputs() {
  const customerId = document.getElementById('customerSelect').value;
  if (!customerId) {
    alert('Vui lòng chọn khách hàng trước');
    document.getElementById('customerSelect').focus();
    return;
  }

  cart = [];
  let total = 0;

  products.forEach(p => {
    const input = document.getElementById('input-' + p.id);
    const qty = parseInt(input.value) || 0;
    if (qty > 0) {
      const productId = p.id;
      const stock = parseInt(input.dataset.stock);
      const costPrice = parseFloat(input.dataset.costPrice) || 0;
      const priceEl = document.getElementById('price-' + productId);
      const price = parseFloat(priceEl.dataset.price) || 0;

      if (qty > stock) {
        alert('Sản phẩm ' + p.name + ' không đủ tồn kho');
        input.value = stock;
        document.getElementById('qty-' + productId).textContent = stock;
      }

      cart.push({ productId, quantity: qty, price, costPrice });
      total += price * qty;
    }
  });

  document.getElementById('totalAmount').textContent = formatVND(total);
  document.getElementById('sellBtn').disabled = cart.length === 0;
}

async function submitSale() {
  const customerId = document.getElementById('customerSelect').value;

  // Build items from saleData
  const items = [];
  Object.keys(saleData).forEach(productId => {
    const item = saleData[productId];
    if (item.quantity > 0 && item.price > 0) {
      items.push({
        productId: parseInt(productId),
        quantity: item.quantity,
        price: item.price
      });
    }
  });

  if (items.length === 0) return showToast('Chưa chọn sản phẩm nào', 'error');

  let total = items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  if (total === 0) return showToast('Tổng tiền bằng 0, vui lòng kiểm tra lại giá sản phẩm', 'error');

  // Show loading
  const btn = document.getElementById('sellBtn');
  btn.disabled = true;
  btn.textContent = 'Đang xử lý...';
  showLoading('Đang tạo hóa đơn...');

  try {
    const res = await fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: customerId ? parseInt(customerId) : null,
        items: items,
        deliverKegs: 0,
        returnKegs: 0
      })
    });

    const result = await res.json();
    if (res.ok) {
      // Reset form
      saleData = {};
      renderSaleProducts();
      updateSaleTotal();
      loadSalesHistory();
      showToast('Bán hàng thành công!', 'success');
      showInvoiceModal(result.id);
    } else {
      showToast(result.error || 'Bán hàng thất bại', 'error');
    }
  } catch (err) {
    console.error('Sale error:', err);
    showToast('Lỗi kết nối, vui lòng thử lại', 'error');
  } finally {
    hideLoading();
    btn.disabled = false;
    btn.textContent = 'Bán Hàng';
  }
}

function closeInvoice() {
  location.reload();
}

// Keg Modal Functions
let currentKegSaleId = null;
let currentKegCustomerId = null;
let currentKegBalance = 0;
let saleTotalQuantity = 0;

// Hàm kiểm tra sản phẩm có phải là bia pet (chai nhựa) không
function isPetBia(productName, productType) {
  // Ưu tiên kiểm tra type từ database
  if (productType === 'pet') return true;
  if (productType === 'keg' || productType === 'can') return false;
  
  // Fallback: kiểm tra tên sản phẩm
  const name = (productName || '').toLowerCase();
  return name.includes('pet') || name.includes('nhựa');
}

async function openKegModal(saleId) {
  currentKegSaleId = saleId;
  
  const res = await fetch('/api/sales/' + saleId);
  const sale = await res.json();
  
  currentKegCustomerId = sale.customer_id;
  
  const customer = customers.find(c => c.id == sale.customer_id);
  currentKegBalance = customer ? (customer.keg_balance || 0) : 0;
  
  // Chỉ tính bia bom (lon/chai thủy tinh), không tính bia pet (chai nhựa)
  saleTotalQuantity = sale.items.reduce((sum, item) => {
    if (isPetBia(item.name, item.type)) return sum;
    return sum + item.quantity;
  }, 0);
  
  document.getElementById('kegBeerQuantity').textContent = saleTotalQuantity;
  
  // Auto-fill: nếu chưa có deliver_kegs thì điền = số bia (chỉ bom, không pet)
  if (!sale.deliver_kegs || sale.deliver_kegs === 0) {
    document.getElementById('kegDeliver').value = saleTotalQuantity;
  } else {
    document.getElementById('kegDeliver').value = sale.deliver_kegs;
  }
  document.getElementById('kegReturn').value = sale.return_kegs || 0;
  
  updateKegModalPreview();
  
  document.getElementById('kegModal').classList.remove('hidden');
  document.getElementById('kegModal').classList.add('flex');
}

function closeKegModal() {
  document.getElementById('kegModal').classList.add('hidden');
  document.getElementById('kegModal').classList.remove('flex');
  currentKegSaleId = null;
  currentKegCustomerId = null;
}

// Replacement Modal Functions
function openReplacementModal() {
  const customerSelect = document.getElementById('replacementCustomer');
  customerSelect.innerHTML = '<option value="">-- Chọn khách hàng --</option>' + 
    customers.map(c => '<option value="' + c.id + '">' + c.name + '</option>').join('');
  
  document.getElementById('replacementProduct').innerHTML = '<option value="">-- Chọn sản phẩm --</option>';
  document.getElementById('replacementQty').value = 1;
  
  document.getElementById('replacementModal').classList.remove('hidden');
  document.getElementById('replacementModal').classList.add('flex');
}

function closeReplacementModal() {
  document.getElementById('replacementModal').classList.add('hidden');
  document.getElementById('replacementModal').classList.remove('flex');
}

function loadReplacementProducts() {
  const customerId = document.getElementById('replacementCustomer').value;
  const productSelect = document.getElementById('replacementProduct');
  
  if (!customerId) {
    productSelect.innerHTML = '<option value="">-- Chọn sản phẩm --</option>';
    return;
  }
  
  // Load all products for replacement
  productSelect.innerHTML = '<option value="">-- Chọn sản phẩm --</option>' + 
    products.map(p => '<option value="' + p.id + '">' + p.name + ' (Tồn: ' + p.stock + ')</option>').join('');
}

async function submitReplacement() {
  const customerId = document.getElementById('replacementCustomer').value;
  const productId = document.getElementById('replacementProduct').value;
  const quantity = parseInt(document.getElementById('replacementQty').value) || 0;
  const reason = document.getElementById('replacementReason').value;
  
  if (!customerId || !productId || quantity <= 0) {
    alert('Vui lòng chọn đầy đủ thông tin');
    return;
  }
  
  try {
    const res = await fetch('/api/sales/replacement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: parseInt(customerId),
        product_id: parseInt(productId),
        quantity: quantity,
        reason: reason
      })
    });
    
    const data = await res.json();
    
    if (data.success) {
      alert('✅ ' + data.message);
      closeReplacementModal();
      loadSalesHistory();
      loadProducts(); // Refresh stock
    } else {
      alert('❌ ' + (data.error || 'Lỗi không xác định'));
    }
  } catch (err) {
    console.error(err);
    alert('❌ Lỗi kết nối');
  }
}

function updateKegModalPreview() {
  const deliverKegs = parseInt(document.getElementById('kegDeliver').value) || 0;
  const returnKegs = parseInt(document.getElementById('kegReturn').value) || 0;
  const newBalance = currentKegBalance + deliverKegs - returnKegs;
  
  document.getElementById('kegCurrentBalance').textContent = currentKegBalance;
  document.getElementById('kegNewBalance').textContent = newBalance;
  
  const warningEl = document.getElementById('kegModalWarning');
  if (returnKegs > currentKegBalance) {
    warningEl.classList.remove('hidden');
  } else {
    warningEl.classList.add('hidden');
  }
}

function addKegDeliver(amount) {
  const current = parseInt(document.getElementById('kegDeliver').value) || 0;
  document.getElementById('kegDeliver').value = current + amount;
  updateKegModalPreview();
}

function addKegReturn(amount) {
  const current = parseInt(document.getElementById('kegReturn').value) || 0;
  document.getElementById('kegReturn').value = current + amount;
  updateKegModalPreview();
}

function returnAllKegs() {
  document.getElementById('kegReturn').value = currentKegBalance;
  updateKegModalPreview();
}

async function saveKegUpdate() {
  if (!currentKegSaleId || !currentKegCustomerId) return;
  
  const deliverKegs = parseInt(document.getElementById('kegDeliver').value) || 0;
  const returnKegs = parseInt(document.getElementById('kegReturn').value) || 0;
  
  const res = await fetch('/api/sales/update-kegs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ saleId: currentKegSaleId, customerId: currentKegCustomerId, deliver: deliverKegs, returned: returnKegs })
  });
  
  const result = await res.json();
  if (res.ok) {
    const newBalance = currentKegBalance + deliverKegs - returnKegs;
    alert(`✅ Cập nhật vỏ thành công!\n\nSố vỏ còn tại quán: ${newBalance}`);
    closeKegModal();
    loadSalesHistory();
    showInvoiceModal(currentKegSaleId);
  } else {
    alert(result.error || 'Cập nhật vỏ thất bại');
  }
}

async function showInvoiceModal(saleId) {
  const res = await fetch('/api/sales/' + saleId);
  const sale = await res.json();
  
  let itemsHtml = '';
  sale.items.forEach(item => {
    const unitPrice = item.price;
    const totalPrice = item.price * item.quantity;
    itemsHtml += `
      <div class="py-2 border-b border-gray-100">
        <div class="font-semibold text-gray-800">🍺 ${item.name}</div>
        <div class="flex justify-between items-center mt-1">
          <span class="text-gray-500 text-sm">${item.quantity} × ${formatVND(unitPrice)}</span>
          <span class="font-bold text-gray-800">${formatVND(totalPrice)}</span>
        </div>
      </div>
    `;
  });

  let kegHtml = '';
  const deliverKegs = sale.deliver_kegs || 0;
  const returnKegs = sale.return_kegs || 0;
  const newBalance = sale.keg_balance_after || 0;
  
  if (deliverKegs > 0 || returnKegs > 0) {
    kegHtml = '<div class="border-t border-b py-2 my-2">';
    if (deliverKegs > 0) {
      kegHtml += '<div class="flex justify-between text-sm py-1"><span class="text-gray-600">📦 Giao vỏ</span><span class="font-bold text-green-600">+' + deliverKegs + '</span></div>';
    }
    if (returnKegs > 0) {
      kegHtml += '<div class="flex justify-between text-sm py-1"><span class="text-gray-600">🔁 Thu vỏ</span><span class="font-bold text-orange-600">-' + returnKegs + '</span></div>';
    }
    kegHtml += '</div><div class="flex justify-between text-sm font-bold py-1"><span>Vỏ đang giữ:</span><span>' + newBalance + '</span></div>';
  }
  
  document.getElementById('invoiceContent').innerHTML = 
    '<div class="text-sm mb-2 text-gray-500">Ngày: ' + new Date(sale.date).toLocaleDateString('vi-VN') + '</div>' +
    '<div class="text-sm mb-3 font-medium text-gray-700">Khách: ' + sale.customer_name + '</div>' +
    itemsHtml +
    kegHtml;
  
  document.getElementById('invoiceTotal').textContent = formatVND(sale.total);
  document.getElementById('qrCode').src = 'https://img.vietqr.io/image/970415-107875230331-compact2.png?amount=' + sale.total + '&addInfo=Chuyen%20Khoan%20' + sale.id;
  
  document.getElementById('invoiceModal').classList.remove('hidden');
  document.getElementById('invoiceModal').classList.add('flex');
}

let currentPage = 1;
const itemsPerPage = 5;

// Global state for pagination
let salesPagination = {
  page: 1,
  limit: 5,
  total: 0,
  totalPages: 0,
  month: new Date().toISOString().slice(0, 7) // Current month YYYY-MM
};

async function loadSalesHistory() {
  const { page, limit, month } = salesPagination;
  const res = await fetch(`/api/sales?page=${page}&limit=${limit}&month=${month}`);
  const data = await res.json();
  
  const salesHistory = data.sales;
  salesPagination.total = data.total;
  salesPagination.totalPages = data.totalPages;
  
  const container = document.getElementById('salesHistoryList');
  if (salesHistory.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-center py-4">Chưa có hóa đơn nào</p>';
    renderPagination();
    return;
  }
  
  container.innerHTML = salesHistory.map(sale => {
    const date = new Date(sale.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const customerName = sale.customer_name || 'Khách lẻ';
    const hasKegUpdate = (sale.deliver_kegs || 0) > 0 || (sale.return_kegs || 0) > 0;
    
    // Style based on sale type
    let typeBadge = '';
    let totalDisplay = '';
    let rowClass = '';
    
    if (sale.type === 'replacement') {
      typeBadge = '<span class="bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded text-xs">🔁 Đổi lỗi</span>';
      totalDisplay = '<span class="font-bold text-orange-600">0 đ</span>';
      rowClass = 'bg-orange-50';
    } else {
      totalDisplay = '<span class="font-bold text-green-600">' + formatVND(sale.total) + '</span>';
    }
    
    return `
      <div class="flex justify-between items-center p-2 border-b ${rowClass}">
        <div>
          <div class="font-medium">#${sale.id} - ${customerName} ${typeBadge}</div>
          <div class="text-xs text-gray-500">${date}${hasKegUpdate ? ' • 📦' : ''}</div>
        </div>
        <div class="flex items-center gap-1">
          ${totalDisplay}
          ${sale.type !== 'replacement' ? `
          <button onclick="viewSale(${sale.id})" class="text-blue-500 text-sm px-1">👁️</button>
          <button onclick="openKegModal(${sale.id})" class="text-purple-500 text-sm px-1">📦</button>
          <button onclick="editSale(${sale.id})" class="text-orange-500 text-sm px-1">✏️</button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
  
  // Render pagination
  renderPagination();
}

function changePage(page) {
  currentPage = page;
  loadSalesHistory();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderPagination() {
  const container = document.getElementById('salesHistoryList');
  const { page, totalPages, total } = salesPagination;
  
  if (totalPages <= 1) return;
  
  const paginationHTML = `
    <div class="flex justify-center items-center gap-2 mt-4 py-2">
      <button onclick="changeSalesPage(${page - 1})" ${page === 1 ? 'disabled' : ''} 
        class="px-3 py-1 rounded ${page === 1 ? 'bg-gray-200 text-gray-400' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}">
        ‹
      </button>
      <span class="text-sm text-gray-600">Trang ${page}/${totalPages}</span>
      <button onclick="changeSalesPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}
        class="px-3 py-1 rounded ${page === totalPages ? 'bg-gray-200 text-gray-400' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}">
        ›
      </button>
      <span class="text-xs text-gray-500 ml-2">(${total} đơn)</span>
    </div>
  `;
  
  container.insertAdjacentHTML('beforeend', paginationHTML);
}

function changeSalesPage(newPage) {
  if (newPage < 1 || newPage > salesPagination.totalPages) return;
  salesPagination.page = newPage;
  loadSalesHistory();
}

async function viewSale(id) {
  showInvoiceModal(id);
}

async function deleteSale(id) {
  if (!confirm('Bạn có chắc muốn xóa hóa đơn #' + id + '?')) return;
  
  const res = await fetch('/api/sales/' + id, { method: 'DELETE' });
  const result = await res.json();
  
  if (res.ok) {
    alert(result.message);
    loadSalesHistory();
  } else {
    alert(result.error);
  }
}

async function editSale(id) {
  const res = await fetch('/api/sales/' + id);
  const sale = await res.json();

  editingSaleId = id;

  document.getElementById('sellBtn').classList.add('hidden');
  document.getElementById('updateBtn').classList.remove('hidden');
  document.getElementById('cancelEditBtn').classList.remove('hidden');

  document.getElementById('customerSelect').value = sale.customer_id || '';
  
  // Load customer prices
  if (sale.customer_id) {
    updatePrices();
  }

  // Reset all quantities
  saleData = {};
  products.forEach(p => {
    const qtyInput = document.getElementById('qty-' + p.id);
    const priceInput = document.getElementById('price-' + p.id);
    if (qtyInput) {
      qtyInput.value = '';
    }
    if (priceInput) {
      priceInput.value = p.sell_price || 0;
    }
  });

  // Set quantities from sale
  sale.items.forEach(item => {
    const qtyInput = document.getElementById('qty-' + item.product_id);
    const priceInput = document.getElementById('price-' + item.product_id);
    if (qtyInput) {
      qtyInput.value = item.quantity;
    }
    if (priceInput) {
      priceInput.value = item.price;
    }
    saleData[item.product_id] = {
      quantity: item.quantity,
      price: item.price
    };
  });

  updateSaleTotal();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEdit() {
  editingSaleId = null;
  saleData = {};

  document.getElementById('sellBtn').classList.remove('hidden');
  document.getElementById('updateBtn').classList.add('hidden');
  document.getElementById('cancelEditBtn').classList.add('hidden');

  document.getElementById('customerSelect').value = '';

  products.forEach(p => {
    const qtyInput = document.getElementById('qty-' + p.id);
    const priceInput = document.getElementById('price-' + p.id);
    if (qtyInput) {
      qtyInput.value = '';
    }
    if (priceInput) {
      priceInput.value = p.sell_price || 0;
    }
  });
  updateSaleTotal();
}

async function updateSale() {
  if (!editingSaleId) return;
  
  const customerId = document.getElementById('customerSelect').value;
  
  // Build items from saleData
  const items = [];
  Object.keys(saleData).forEach(productId => {
    const item = saleData[productId];
    if (item.quantity > 0 && item.price > 0) {
      items.push({
        productId: parseInt(productId),
        quantity: item.quantity,
        price: item.price
      });
    }
  });
  
  if (items.length === 0) return alert('Chưa chọn sản phẩm nào');
  
  const res = await fetch('/api/sales/' + editingSaleId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      customerId: customerId ? parseInt(customerId) : null,
      items: items 
    })
  });
  
  const result = await res.json();
  if (res.ok) {
    alert('Cập nhật thành công!');
    cancelEdit();
    loadSalesHistory();
  } else {
    alert(result.error || 'Cập nhật thất bại');
  }
}
