// Sales Page JavaScript
// Tách riêng để dễ bảo trì và cache
// formatVND, showToast đã được định nghĩa trong utils.js

let products = [];
let priceMap = {};
let customers = [];
let editingSaleId = null;
let saleData = {};

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
  const customerId = document.getElementById('customerSelect') ? document.getElementById('customerSelect').value : '';
  const isKhachLe = !customerId;

  // Layout giống Nhập hàng: thẻ từng SP, tên + 1 dòng giá/tồn + ô Nhập SL
  container.innerHTML = products.map(p => {
    const price = p._displayPrice || p.sell_price || 0;
    const currentPrice = (saleData[p.id] && saleData[p.id].price !== undefined) ? saleData[p.id].price : (p.sell_price || 0);
    const isLowStock = p.stock < 5;
    const currentQty = saleData[p.id] ? saleData[p.id].quantity : '';
    const priceLine = isKhachLe
      ? `Giá bán (đ): <input type="number" id="price-input-${p.id}" value="${currentPrice}" min="0" step="1000" inputmode="numeric"
           class="w-24 py-1 px-2 border border-gray-200 rounded-lg text-right text-sm font-medium inline-block"
           onchange="updateSaleData(${p.id}, 'price', this.value); updateSaleTotal();"
           oninput="updateSaleData(${p.id}, 'price', this.value); updateSaleTotal();"> · Tồn: ${p.stock}`
      : `Giá bán: ${formatVND(price)} · Tồn: ${p.stock}`;
    return `
      <div class="p-3 border border-gray-200 rounded-xl ${isLowStock ? 'bg-orange-50/50 border-orange-200' : 'bg-gray-50'}">
        <div class="text-sm font-semibold text-gray-800">${p.name}</div>
        <div class="text-xs text-gray-600 mt-0.5">${priceLine}</div>
        <input type="number" id="qty-${p.id}" min="0" max="${p.stock}" value="${currentQty > 0 ? currentQty : ''}" data-stock="${p.stock}"
          placeholder="Nhập SL"
          class="mt-2 w-full border-2 border-gray-200 rounded-lg p-2.5 text-center font-medium"
          onchange="updateSaleData(${p.id}, 'quantity', this.value); updateSaleTotal();"
          oninput="updateSaleData(${p.id}, 'quantity', this.value); updateSaleTotal();">
      </div>
    `;
  }).join('');
}

// Quick adjust quantity (inline -10, -, +, +10)
function adjustQty(productId, amount) {
  const input = document.getElementById('qty-' + productId);
  if (!input) return;
  const current = parseInt(input.value) || 0;
  const product = products.find(p => p.id === productId);
  const maxStock = product ? product.stock : 999;
  
  let newValue = current + amount;
  if (newValue < 0) newValue = 0;
  if (newValue > maxStock) newValue = maxStock;
  
  input.value = newValue;
  updateSaleData(productId, 'quantity', newValue);
  updateSaleTotal();
}

// Toggle quantity control modal
let currentEditingProduct = null;

function toggleQtyControl(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;
  
  currentEditingProduct = productId;
  const currentQty = saleData[productId] ? saleData[productId].quantity : '';
  const currentPrice = saleData[productId] ? saleData[productId].price : (product._displayPrice || product.sell_price);
  
  const modal = document.createElement('div');
  modal.id = 'qtyModal';
  modal.className = 'fixed inset-0 bg-black/50 flex items-end z-50';
  modal.onclick = function(e) {
    if (e.target === modal) closeQtyModal();
  };
  
  modal.innerHTML = `
    <div class="bg-white w-full max-w-md mx-auto rounded-t-2xl p-5 pb-8" style="border-radius: 20px 20px 0 0;">
      <div class="bg-white rounded-xl p-4 shadow mb-4">
        <div class="flex justify-between items-start">
          <div class="flex-1">
            <div class="font-semibold text-gray-800 break-words whitespace-normal text-lg">${product.name}</div>
            <div class="text-sm text-gray-500 mt-1">Tồn kho: ${product.stock}</div>
          </div>
          <button onclick="closeQtyModal()" class="text-gray-500 text-2xl ml-2">&times;</button>
        </div>
      </div>
      
      <div class="flex items-center justify-between gap-6 mb-6">
        <button type="button" onclick="adjustQtyModal(${productId}, -1)" class="flex-1 h-14 rounded-xl bg-gray-200 hover:bg-gray-300 text-xl font-bold">-</button>
        <input type="number" id="qty-${productId}" min="0" max="${product.stock}" value="${currentQty}"
          class="flex-1 h-14 border-2 border-amber-400 rounded-xl text-center text-2xl font-bold"
          onchange="updateSaleData(${productId}, 'quantity', this.value)"
          oninput="updateSaleData(${productId}, 'quantity', this.value)">
        <button type="button" onclick="adjustQtyModal(${productId}, 1)" class="flex-1 h-14 rounded-xl bg-amber-400 hover:bg-amber-500 text-white text-xl font-bold">+</button>
      </div>
      
      <div class="flex items-center justify-center gap-3 mb-6">
        <button type="button" onclick="adjustQtyModal(${productId}, 1)" class="flex-1 py-3 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-xl font-bold text-sm">+1</button>
        <button type="button" onclick="adjustQtyModal(${productId}, 5)" class="flex-1 py-3 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-xl font-bold text-sm">+5</button>
        <button type="button" onclick="adjustQtyModal(${productId}, 10)" class="flex-1 py-3 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-xl font-bold text-sm">+10</button>
        <button type="button" onclick="adjustQtyModal(${productId}, 20)" class="flex-1 py-3 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-xl font-bold text-sm">+20</button>
      </div>
      
      <div class="mb-4">
        <label class="block text-sm font-medium mb-2">Giá bán</label>
        <input type="number" id="price-${productId}" step="1000" value="${currentPrice}"
          class="w-full border-2 border-amber-200 rounded-xl px-4 py-3 text-right text-xl font-bold"
          onchange="updateSaleData(${productId}, 'price', this.value)"
          oninput="updateSaleData(${productId}, 'price', this.value)">
      </div>
      
      <button onclick="closeQtyModal()" class="w-full bg-amber-500 text-white font-bold py-4 rounded-xl text-xl">
        Xác nhận
      </button>
    </div>
  `;
  
  document.body.appendChild(modal);
}

function adjustQtyModal(productId, amount) {
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

function closeQtyModal() {
  const modal = document.getElementById('qtyModal');
  if (modal) modal.remove();
}

function updateSaleData(productId, field, value) {
  if (!saleData[productId]) {
    const product = products.find(p => p.id === productId);
    saleData[productId] = {
      quantity: 0,
      price: product._displayPrice || product.sell_price || 0
    };
  }
  
  // STEP 6: Input validation - prevent NaN and invalid values
  if (field === 'quantity') {
    const parsed = parseInt(value);
    saleData[productId].quantity = (isNaN(parsed) || parsed < 0) ? 0 : parsed;
  } else if (field === 'price') {
    const parsed = parseFloat(value);
    saleData[productId].price = (isNaN(parsed) || parsed < 0) ? 0 : parsed;
  }
  
  updateSaleTotal();
}

function updateSaleTotal() {
  let total = 0;
  let hasItems = false;
  let itemCount = 0;
  let cartHtml = '';
  
  Object.keys(saleData).forEach(productId => {
    const item = saleData[productId];
    if (item.quantity > 0 && item.price > 0) {
      const product = products.find(p => p.id == productId);
      total += item.quantity * item.price;
      hasItems = true;
      itemCount += item.quantity;
      cartHtml += `<div class="flex justify-between"><span>${product ? product.name : 'SP'}</span><span>x${item.quantity}</span></div>`;
    }
  });
  
  const totalEl = document.getElementById('totalAmount');
  if (totalEl) totalEl.textContent = formatVND(total);
  
  const itemCountEl = document.getElementById('itemCount');
  if (itemCountEl) itemCountEl.textContent = itemCount + ' items';
  
  const cartEl = document.getElementById('cartItems');
  if (cartEl) cartEl.innerHTML = cartHtml || '<div class="text-gray-400 text-center">Chưa có sản phẩm</div>';
  
  const sellBtn = document.getElementById('sellBtn');
  if (sellBtn) sellBtn.disabled = !hasItems;
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
  const input = document.getElementById('qty-' + product.id);
  const currentQty = parseInt(input.value) || 0;
  const maxAdd = product.stock - currentQty;
  const toAdd = Math.min(amount, maxAdd);

  if (toAdd <= 0) {
    alert('Sản phẩm ' + product.name + ' đã hết hàng');
    return;
  }

  input.value = currentQty + toAdd;
  updateSaleData(product.id, 'quantity', currentQty + toAdd);
  updateSaleTotal();
}

// Change quantity with +/- buttons
function changeQty(productId, delta) {
  const input = document.getElementById('qty-' + productId);
  if (input) {
    const currentVal = parseInt(input.value) || 0;
    const stock = parseInt(input.max) || 999;
    const newVal = Math.max(0, Math.min(currentVal + delta, stock));
    input.value = newVal;
    updateSaleData(productId, 'quantity', newVal);
    updateSaleTotal();
  }
}

function updatePrices() {
  const customerId = document.getElementById('customerSelect').value;
  
  // Store customer prices in products for display
  if (customerId) {
    fetch('/api/products/prices?customerId=' + customerId)
      .then(res => res.json())
      .then(prices => {
        // Update price in products array and saleData
        products.forEach(p => {
          const customerPrice = prices.find(price => price.product_id === p.id);
          if (customerPrice) {
            // Store the customer price for display
            p._displayPrice = customerPrice.price;
            // Also update saleData
            saleData[p.id] = saleData[p.id] || { quantity: 0, price: customerPrice.price };
            saleData[p.id].price = customerPrice.price;
          } else {
            p._displayPrice = p.sell_price || 0;
          }
        });
        // Re-render products to show new prices
        renderSaleProducts();
        updateSaleTotal();
      })
      .catch(err => {
        console.error('Error loading prices:', err);
        // Reset to default prices
        products.forEach(p => {
          p._displayPrice = p.sell_price || 0;
        });
        renderSaleProducts();
        updateSaleTotal();
      });
  } else {
    // Khách lẻ: dùng giá mặc định, user sẽ nhập giá trong ô
    products.forEach(p => {
      p._displayPrice = p.sell_price || 0;
      if (saleData[p.id]) {
        saleData[p.id].price = p.sell_price || 0;
      }
    });
    renderSaleProducts();
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
    const input = document.getElementById('qty-' + p.id);
    const qty = parseInt(input.value) || 0;
    if (qty > 0) {
      const productId = p.id;
      const stock = parseInt(input.max) || 0;
      const costPrice = p.cost_price || 0;
      const price = p._displayPrice || p.sell_price || 0;

      if (qty > stock) {
        alert('Sản phẩm ' + p.name + ' không đủ tồn kho');
        input.value = stock;
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

  // Build items from saleData - STEP 5: Use priceAtTime for price snapshot
  const items = [];
  Object.keys(saleData).forEach(productId => {
    const item = saleData[productId];
    if (item.quantity > 0 && item.price > 0) {
      // STEP 5: Capture price at time of sale for historical accuracy
      items.push({
        productId: parseInt(productId),
        quantity: item.quantity,
        price: item.price,
        priceAtTime: item.price  // Snapshot price
      });
    }
  });

  if (items.length === 0) return showToast('Chưa chọn sản phẩm nào', 'error');

  // STEP 6: Validate totals
  let total = items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  if (total === 0) return showToast('Tổng tiền bằng 0, vui lòng kiểm tra lại giá sản phẩm', 'error');
  
  // STEP 6: Validate each item has valid quantity and price
  for (const item of items) {
    if (!item.quantity || item.quantity <= 0) {
      return showToast('Số lượng sản phẩm phải lớn hơn 0', 'error');
    }
    if (!item.price || item.price < 0) {
      return showToast('Giá sản phẩm không hợp lệ', 'error');
    }
  }

  const btn = document.getElementById('sellBtn');
  btn.disabled = true;
  btn.textContent = 'Đang xử lý...';

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
      // Reset all product display prices to default
      products.forEach(p => {
        p._displayPrice = p.sell_price || 0;
      });
      renderSaleProducts();
      updateSaleTotal();
      // Reset customer select
      document.getElementById('customerSelect').value = '';
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
    btn.disabled = false;
    btn.textContent = 'Bán Hàng';
  }
}

function closeInvoice() {
  document.getElementById('invoiceModal').classList.add('hidden');
  document.getElementById('invoiceModal').classList.remove('flex');
}

async function reloadPage() {
  try {
    const res = await fetch('/sale/data');
    const data = await res.json();
    products = data.products;
    customers = data.customers;
    saleData = {};
    document.getElementById('customerSelect').value = '';
    products.forEach(p => { p._displayPrice = p.sell_price || 0; });
    renderSaleProducts();
    updateSaleTotal();
    await loadSalesHistory();
    closeInvoice();
  } catch (e) {
    showToast('Lỗi tải dữ liệu', 'error');
  }
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
  if (productType === 'keg' || productType === 'box') return false;
  
  // Fallback: kiểm tra tên sản phẩm
  const name = (productName || '').toLowerCase();
  return name.includes('pet') || name.includes('nhựa');
}

async function openKegModal(saleId) {
  currentKegSaleId = saleId;

  const res = await fetch('/api/sales/' + saleId);
  const sale = await res.json();

  currentKegCustomerId = sale.customer_id;

  // Lấy balance THỰC TẾ từ DB (không dùng customers array — có thể cũ)
  const custRes = await fetch('/api/customers/' + sale.customer_id);
  const custData = await custRes.json();
  currentKegBalance = custData.keg_balance || 0;

  // Chỉ tính bia bom (lon/chai thủy tinh), không tính bia pet (chai nhựa)
  saleTotalQuantity = sale.items.reduce((sum, item) => {
    if (isPetBia(item.name, item.type)) return sum;
    return sum + item.quantity;
  }, 0);

  document.getElementById('kegBeerQuantity').textContent = saleTotalQuantity;

  // Lưu giá trị TRƯỚC đó để tính delta khi preview
  _kegModalPrevDeliver = sale.deliver_kegs || 0;
  _kegModalPrevReturn = sale.return_kegs || 0;

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
  const deliver = parseInt(String(document.getElementById('kegDeliver').value).trim(), 10) || 0;
  const returned = parseInt(String(document.getElementById('kegReturn').value).trim(), 10) || 0;
  const deltaDeliver = deliver - _kegModalPrevDeliver;
  const deltaReturn = returned - _kegModalPrevReturn;
  const newBalance = currentKegBalance + deltaDeliver - deltaReturn;

  document.getElementById('kegCurrentBalance').textContent = currentKegBalance;
  document.getElementById('kegNewBalance').textContent = newBalance;

  const warningEl = document.getElementById('kegModalWarning');
  const heldFromThisSale = _kegModalPrevDeliver - _kegModalPrevReturn;
  if (returned > heldFromThisSale) {
    warningEl.classList.remove('hidden');
  } else {
    warningEl.classList.add('hidden');
  }
}

function addKegDeliver(amount) {
  const current = parseInt(String(document.getElementById('kegDeliver').value).trim(), 10) || 0;
  document.getElementById('kegDeliver').value = current + amount;
  updateKegModalPreview();
}

function addKegReturn(amount) {
  const current = parseInt(String(document.getElementById('kegReturn').value).trim(), 10) || 0;
  document.getElementById('kegReturn').value = current + amount;
  updateKegModalPreview();
}

function returnAllKegs() {
  const totalHeldFromThisSale = _kegModalPrevDeliver - _kegModalPrevReturn;
  document.getElementById('kegReturn').value = Math.max(0, totalHeldFromThisSale);
  updateKegModalPreview();
}

async function saveKegUpdate() {
  if (!currentKegSaleId || !currentKegCustomerId) return;
  
  const deliverKegs = parseInt(String(document.getElementById('kegDeliver').value).trim(), 10) || 0;
  const returnKegs = parseInt(String(document.getElementById('kegReturn').value).trim(), 10) || 0;
  
  const res = await fetch('/api/sales/update-kegs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ saleId: currentKegSaleId, customerId: currentKegCustomerId, deliver: deliverKegs, returned: returnKegs })
  });
  
  const result = await res.json();
  if (res.ok) {
    const custListRes = await fetch('/api/customers');
    customers = await custListRes.json();
    alert(`Cập nhật vỏ thành công!\n\nGiao: ${deliverKegs} | Thu: ${returnKegs}\nVỏ tại khách: ${result.newBalance}`);
    closeKegModal();
    loadSalesHistory();
    if (window.location.pathname === '/' || window.location.pathname === '/dashboard') {
      loadData();
    }
  } else {
    alert(result.error || 'Cập nhật vỏ thất bại');
  }
}

async function showInvoiceModal(saleId) {
  const res = await fetch('/api/sales/' + saleId);
  const sale = await res.json();
  
  const dateStr = new Date(sale.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const customerName = sale.customer_name || 'Khách lẻ';
  
  // Sản phẩm: layout 2 dòng chuẩn POS (tên rõ, đơn giá + thành tiền căn phải)
  let itemsHtml = '';
  sale.items.forEach(item => {
    const unitPrice = item.price;
    const totalPrice = item.price * item.quantity;
    itemsHtml += `
      <div class="invoice-item">
        <div class="invoice-name">🍺 ${item.name}</div>
        <div class="invoice-row">
          <span>${item.quantity} × ${formatVND(unitPrice)}</span>
          <span class="invoice-total">${formatVND(totalPrice)}</span>
        </div>
      </div>
    `;
  });

  const deliverKegs = sale.deliver_kegs || 0;
  const returnKegs = sale.return_kegs || 0;
  const newBalance = sale.keg_balance_after || 0;
  
  let kegHtml = '';
  if (deliverKegs > 0 || returnKegs > 0) {
    kegHtml = '<div class="border-t border-gray-200 pt-3 mt-3 space-y-1">';
    if (deliverKegs > 0) {
      kegHtml += '<div class="flex justify-between text-sm"><span class="text-gray-600">📦 Giao vỏ</span><span class="font-semibold text-green-600">+' + deliverKegs + '</span></div>';
    }
    if (returnKegs > 0) {
      kegHtml += '<div class="flex justify-between text-sm"><span class="text-gray-600">🔁 Thu vỏ</span><span class="font-semibold text-orange-600">-' + returnKegs + '</span></div>';
    }
    kegHtml += '<div class="flex justify-between text-sm font-semibold pt-1"><span class="text-gray-700">Vỏ đang giữ:</span><span>' + newBalance + '</span></div></div>';
  }
  
  document.getElementById('invoiceContent').innerHTML = 
    '<div class="text-sm text-gray-500 mb-1">' + dateStr + '</div>' +
    '<div class="text-sm font-medium text-gray-700 mb-3">Khách: ' + customerName + '</div>' +
    '<div class="border-t border-gray-200 pt-2">' + itemsHtml + '</div>' +
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
  limit: 10,
  total: 0,
  totalPages: 0,
  month: new Date().toISOString().slice(0, 7) // Current month YYYY-MM
};

// ========== KEG MODAL STATE ==========
let _kegModalPrevDeliver = 0;
let _kegModalPrevReturn = 0;

// ========== COLLECT KEG MODAL (Simple "Thu vỏ" modal) ==========
let _collectKegSaleId = null;
let _collectKegCustomerId = null;
let _collectKegRemaining = 0;
let _collectKegBalance = 0;
let _collectKegDelivered = 0;
let _collectKegReturned = 0;

async function openCollectKegModal(saleId) {
  _collectKegSaleId = saleId;

  const res = await fetch('/api/sales/' + saleId);
  const sale = await res.json();
  _collectKegCustomerId = sale.customer_id;

  const customer = customers.find(c => c.id == sale.customer_id);
  _collectKegBalance = customer ? (customer.keg_balance || 0) : 0;
  _collectKegDelivered = sale.deliver_kegs || 0;
  _collectKegReturned = sale.return_kegs || 0;
  _collectKegRemaining = _collectKegDelivered - _collectKegReturned;

  document.getElementById('collectKegInfo').textContent =
    `Đã giao: ${_collectKegDelivered} vỏ · Đã thu: ${_collectKegReturned} vỏ · Còn lại: ${_collectKegRemaining} vỏ`;

  const input = document.getElementById('collectKegQty');
  input.value = _collectKegRemaining;
  input.max = _collectKegRemaining;
  input.placeholder = `0 - ${_collectKegRemaining}`;

  document.getElementById('collectKegModal').classList.remove('hidden');
  document.getElementById('collectKegModal').classList.add('flex');
  updateCollectKegPreview();
}

function closeCollectKegModal() {
  document.getElementById('collectKegModal').classList.add('hidden');
  document.getElementById('collectKegModal').classList.remove('flex');
  _collectKegSaleId = null;
  _collectKegCustomerId = null;
  _collectKegRemaining = 0;
  _collectKegBalance = 0;
  _collectKegDelivered = 0;
  _collectKegReturned = 0;
}

function updateCollectKegPreview() {
  const qty = parseInt(document.getElementById('collectKegQty').value, 10) || 0;
  const actualCollect = Math.min(qty, _collectKegRemaining);
  const newBalance = _collectKegBalance - actualCollect;
  document.getElementById('collectKegInfo').textContent =
    `Thu: ${actualCollect} vỏ · Còn lại: ${_collectKegRemaining - actualCollect} vỏ · Vỏ tại khách: ${newBalance}`;
}

async function submitCollectKeg() {
  const saleId = _collectKegSaleId;
  const customerId = _collectKegCustomerId;
  const collectQty = parseInt(document.getElementById('collectKegQty').value, 10) || 0;

  if (collectQty < 0) {
    alert('Số vỏ không hợp lệ');
    return;
  }

  const actualCollect = Math.min(collectQty, _collectKegRemaining);
  if (actualCollect <= 0) {
    alert('Không có vỏ để thu (khách không còn giữ vỏ)');
    return;
  }

  const newReturned = Math.min(_collectKegReturned + collectQty, _collectKegDelivered);
  const newBalance = _collectKegBalance - actualCollect;

  const res = await fetch('/api/sales/update-kegs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ saleId, customerId, deliver: _collectKegDelivered, returned: newReturned })
  });
  const result = await res.json();

  if (res.ok) {
    const custListRes = await fetch('/api/customers');
    customers = await custListRes.json();
    alert(`Đã thu ${actualCollect} vỏ. Vỏ tại khách: ${newBalance}`);
    closeCollectKegModal();
    loadSalesHistory();
    if (window.location.pathname === '/' || window.location.pathname === '/dashboard') {
      loadData();
    }
  } else {
    alert(result.error || 'Thu vỏ thất bại');
  }
}

// ========== SALES HISTORY RENDER ==========
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
    const isReturned = sale.status === 'returned';
    
    // Style based on sale type
    let typeBadge = '';
    let totalDisplay = '';
    let rowClass = '';
    let actionButtons = '';
    
    if (sale.type === 'replacement') {
      typeBadge = '<span class="bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded text-xs">🔁 Đổi lỗi</span>';
      totalDisplay = '<span class="font-bold text-orange-600">0 đ</span>';
      rowClass = 'bg-orange-50';
    } else if (isReturned) {
      // Phân biệt trả lại kho và bia lỗi
      if (sale.type === 'damage_return') {
        typeBadge = '<span class="bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded text-xs">⚠️ Bia lỗi</span>';
      } else {
        typeBadge = '<span class="bg-red-100 text-red-700 px-1.5 py-0.5 rounded text-xs">🔴 Đã trả hàng</span>';
      }
      totalDisplay = '<span class="font-bold text-gray-400 line-through">' + formatVND(sale.total) + '</span>';
      rowClass = 'bg-red-50 opacity-70';
    } else {
      totalDisplay = '<span class="font-bold text-green-600">' + formatVND(sale.total) + '</span>';
    }
    
    // Hiển thị nút hành động cho hóa đơn chưa trả
    if (!isReturned) {
      actionButtons = `
        <button onclick="viewSale(${sale.id})" class="text-blue-500 text-sm px-1">👁️</button>
        <button onclick="openKegModal(${sale.id})" class="text-purple-500 text-sm px-1">📦</button>
        <button onclick="editSale(${sale.id})" class="text-orange-500 text-sm px-1">✏️</button>
        <button onclick="deleteSale(${sale.id})" class="text-red-500 text-sm px-1">🗑️</button>
      `;
    } else {
      actionButtons = `<button onclick="viewSale(${sale.id})" class="text-blue-500 text-sm px-1">👁️</button>`;
    }
    
    return `
      <div class="flex justify-between items-center p-2 border-b ${rowClass}">
        <div>
          <div class="font-medium">#${sale.id} - ${customerName} ${typeBadge}</div>
          <div class="text-xs text-gray-500">${date}${hasKegUpdate ? ' • 📦' : ''}</div>
        </div>
        <div class="flex items-center gap-1">
          ${totalDisplay}
          ${actionButtons}
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
  
  const prevDisabled = page === 1;
  const nextDisabled = page === totalPages;
  const paginationHTML = `
    <div class="flex justify-center items-center gap-2 mt-3 py-3 bg-gray-50">
      <button type="button" onclick="changeSalesPage(${page - 1})" ${prevDisabled ? 'disabled' : ''}
        class="px-4 py-2 rounded-lg min-w-[4rem] ${prevDisabled ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 shadow-sm'}">
        ‹ Trước
      </button>
      <span class="text-sm text-gray-600 px-2">${page}/${totalPages}</span>
      <button type="button" onclick="changeSalesPage(${page + 1})" ${nextDisabled ? 'disabled' : ''}
        class="px-4 py-2 rounded-lg min-w-[4rem] ${nextDisabled ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 shadow-sm'}">
        Sau ›
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

// Trả hàng - xác nhận và thực hiện (hỗ trợ trả một phần)
async function confirmReturnSale(id) {
  // Lấy thông tin hóa đơn trước
  const res = await fetch('/api/sales/' + id);
  if (!res.ok) {
    alert('Không tìm thấy hóa đơn');
    return;
  }
  const sale = await res.json();
  
  if (!sale.items || sale.items.length === 0) {
    alert('Hóa đơn không có sản phẩm');
    return;
  }
  
  const customerName = sale.customer_name || 'Khách lẻ';
  
  // Tạo HTML cho danh sách sản phẩm có thể trả
  const itemsHtml = sale.items.map(item => `
    <div class="flex items-center justify-between py-2 border-b">
      <div>
        <div class="font-medium">${item.name}</div>
        <div class="text-xs text-gray-500">Giá: ${formatVND(item.price)} | Đã mua: ${item.quantity}</div>
      </div>
      <div class="flex items-center gap-2">
        <input type="number" id="return_qty_${item.product_id}" 
          data-price="${item.price}"
          min="0" max="${item.quantity}" value="0"
          class="w-16 border-2 border-gray-200 rounded px-2 py-1 text-center"
          placeholder="0" onchange="updateReturnPreview(this, ${item.quantity})" oninput="updateReturnPreview(this, ${item.quantity})">
        <span class="text-xs text-gray-500">/${item.quantity}</span>
      </div>
    </div>
  `).join('');
  
  // Tạo modal
  const modalHtml = `
    <div id="returnModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl w-full max-w-md max-h-[80vh] overflow-hidden">
        <div class="p-4 border-b bg-amber-500 text-white">
          <h3 class="font-bold text-lg">↩️ TRẢ HÀNG</h3>
          <div class="text-sm opacity-90">#${id} - ${customerName}</div>
        </div>
        
        <div class="p-4 overflow-y-auto max-h-[40vh]">
          <div class="font-medium mb-2">Chọn sản phẩm và số lượng trả:</div>
          ${itemsHtml}
          
          <div class="mt-4 p-3 bg-gray-100 rounded-lg">
            <div class="flex justify-between">
              <span>Tổng tiền hoàn:</span>
              <span id="returnPreview" class="font-bold text-amber-600">0 ₫</span>
            </div>
          </div>
        </div>
        
        <div class="p-4 border-t">
          <div class="font-medium mb-2">Loại trả:</div>
          <div class="flex gap-2 mb-4">
            <label class="flex-1 cursor-pointer">
              <input type="radio" name="returnType" value="stock_return" checked 
                class="mr-2" onchange="updateReturnType()">
              <span class="text-sm">📦 Trả lại kho</span>
            </label>
            <label class="flex-1 cursor-pointer">
              <input type="radio" name="returnType" value="damage_return" 
                class="mr-2" onchange="updateReturnType()">
              <span class="text-sm">⚠️ Bia lỗi</span>
            </label>
          </div>
          
          <div id="reasonInput" class="mb-4 hidden">
            <label class="block text-sm font-medium mb-1">Lý do:</label>
            <input type="text" id="returnReason" 
              class="w-full border-2 border-gray-200 rounded px-3 py-2"
              placeholder="Bia hư, chua,...">
          </div>
          
          <div class="flex gap-2">
            <button onclick="closeReturnModal()" 
              class="flex-1 py-3 bg-gray-200 text-gray-700 rounded-lg font-medium">
              Hủy
            </button>
            <button onclick="submitPartialReturn(${id})" 
              class="flex-1 py-3 bg-amber-500 text-white rounded-lg font-bold">
              Xác nhận
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // Xóa modal cũ nếu có và thêm modal mới
  document.getElementById('returnModal')?.remove();
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// Cập nhật preview tiền hoàn
function updateReturnPreview(input, maxQty) {
  let qty = parseInt(input.value) || 0;
  const price = parseFloat(input.dataset.price) || 0;
  
  // Validate
  if (qty > maxQty) {
    qty = maxQty;
    input.value = maxQty;
  }
  if (qty < 0) {
    qty = 0;
    input.value = 0;
  }
  
  // Tính tổng
  calculateReturnTotal();
}

// Tính tổng tiền hoàn
function calculateReturnTotal() {
  const modal = document.getElementById('returnModal');
  if (!modal) return 0;
  
  const inputs = modal.querySelectorAll('[id^="return_qty_"]');
  let total = 0;
  
  inputs.forEach(input => {
    const productId = input.id.replace('return_qty_', '');
    const price = parseFloat(input.dataset.price) || 0;
    const qty = parseInt(input.value) || 0;
    total += qty * price;
  });
  
  const previewEl = document.getElementById('returnPreview');
  if (previewEl) {
    previewEl.textContent = formatVND(total);
  }
  
  return total;
}

// Cập nhật hiển thị lý do theo loại trả
function updateReturnType() {
  const returnType = document.querySelector('input[name="returnType"]:checked').value;
  const reasonInput = document.getElementById('reasonInput');
  
  if (returnType === 'damage_return') {
    reasonInput.classList.remove('hidden');
  } else {
    reasonInput.classList.add('hidden');
  }
}

// Đóng modal
function closeReturnModal() {
  document.getElementById('returnModal')?.remove();
}

// Gửi yêu cầu trả hàng
async function submitPartialReturn(saleId) {
  const modal = document.getElementById('returnModal');
  if (!modal) return;
  
  // Lấy danh sách sản phẩm trả
  const returnItems = [];
  const inputs = modal.querySelectorAll('[id^="return_qty_"]');
  
  inputs.forEach(input => {
    const productId = parseInt(input.id.replace('return_qty_', ''));
    const qty = parseInt(input.value) || 0;
    
    if (qty > 0) {
      returnItems.push({ productId, quantity: qty });
    }
  });
  
  if (returnItems.length === 0) {
    alert('Vui lòng chọn sản phẩm để trả');
    return;
  }
  
  const returnType = document.querySelector('input[name="returnType"]:checked').value;
  const reason = document.getElementById('returnReason')?.value || '';
  
  // Gọi API trả hàng
  try {
    const returnRes = await fetch('/api/sales/' + saleId + '/return-items', { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        items: returnItems, 
        returnType: returnType, 
        reason: reason 
      })
    });
    const result = await returnRes.json();
    
    if (returnRes.ok) {
      closeReturnModal();
      const msg = returnType === 'stock_return' 
        ? '✅ Đã trả hàng (trả lại kho)!\n\n'
        : '✅ Đã ghi nhận bia lỗi!\n\n';
      alert(msg +
        'Hoàn tiền: ' + formatVND(result.returnedAmount) + '\n' +
        'Sản phẩm: ' + result.returnedQuantity + '\n' +
        'Vỏ trả: ' + result.returnedKegs);
      loadSalesHistory();
    } else {
      alert('❌ ' + result.error);
    }
  } catch (err) {
    alert('❌ Lỗi: ' + err.message);
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
  
  // Load customer prices first if customer is selected
  if (sale.customer_id) {
    await fetch('/api/products/prices?customerId=' + sale.customer_id)
      .then(res => res.json())
      .then(prices => {
        products.forEach(p => {
          const customerPrice = prices.find(price => price.product_id === p.id);
          p._displayPrice = customerPrice ? customerPrice.price : p.sell_price;
        });
      })
      .catch(() => {
        products.forEach(p => {
          p._displayPrice = p.sell_price;
        });
      });
  } else {
    products.forEach(p => {
      p._displayPrice = p.sell_price;
    });
  }
  
  renderSaleProducts();

  // Reset all quantities
  saleData = {};
  products.forEach(p => {
    const qtyInput = document.getElementById('qty-' + p.id);
    const priceInput = document.getElementById('price-' + p.id);
    if (qtyInput) {
      qtyInput.value = '';
    }
    if (priceInput) {
      priceInput.value = p._displayPrice || p.sell_price || 0;
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

  // Reset product display prices to default
  products.forEach(p => {
    p._displayPrice = p.sell_price || 0;
  });
  renderSaleProducts();
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
