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
  updateSaleTotal();

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
    const priceInputVal = (saleData[p.id] && saleData[p.id].price !== undefined)
      ? saleData[p.id].price
      : (p.sell_price != null && p.sell_price !== '' ? p.sell_price : '');
    const isLowStock = p.stock < 5;
    const currentQty = saleData[p.id] ? saleData[p.id].quantity : '';
    const priceLine = isKhachLe
      ? `· Tồn: <span class="${p.stock < 5 ? 'text-danger font-semibold' : 'text-muted'}">${p.stock}</span>`
      : `Giá: <span class="text-primary font-bold">${formatVND(price)}</span> · Tồn: <span class="${p.stock < 5 ? 'text-danger' : 'text-muted'}">${p.stock}</span>`;
    const priceField = isKhachLe
      ? `<label class="block text-xs font-semibold text-primary mt-2 mb-1">Giá bán (đ)</label>
        <input type="number" id="price-${p.id}" min="0" step="1000" value="${priceInputVal}" placeholder="Nhập giá"
          inputmode="decimal" enterkeyhint="done"
          class="w-full border-2 border-primary rounded-xl p-3 text-center text-lg font-bold text-main focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
          onchange="updateSaleData(${p.id}, 'price', this.value); updateSaleTotal();"
          oninput="updateSaleData(${p.id}, 'price', this.value); updateSaleTotal();">`
      : '';
    return `
      <div class="p-3 border-2 ${isLowStock ? 'border-warning bg-warning/5' : 'border-primary bg-primary/5'} rounded-xl transition-all">
        <div class="text-sm font-bold text-main">${p.name}</div>
        <div class="text-xs text-muted mt-0.5">${priceLine}</div>
        ${priceField}
        <input type="number" id="qty-${p.id}" min="0" max="${p.stock}" value="${currentQty > 0 ? currentQty : ''}" data-stock="${p.stock}"
          placeholder="Nhập SL"
          inputmode="numeric" enterkeyhint="done"
          class="mt-2 w-full border-2 border-primary rounded-xl p-3 text-center text-lg font-bold focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none ${currentQty > 0 ? 'bg-primary/10' : ''}"
          onchange="updateSaleData(${p.id}, 'quantity', this.value); updateSaleTotal();"
          oninput="updateSaleData(${p.id}, 'quantity', this.value); updateSaleTotal();">
      </div>
    `;
  }).join('');
}

// Quick adjust quantity (inline -10, -, +, +10)
function adjustQty(productId, amount) {
  haptic && haptic('light');
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
  modal.className = 'fixed inset-0 bg-overlay flex items-end z-50';
  modal.onclick = function(e) {
    if (e.target === modal) closeQtyModal();
  };
  
  modal.innerHTML = `
    <div class="card w-full max-w-md mx-auto rounded-t-2xl p-5 pb-8">
      <div class="card mb-4">
        <div class="flex justify-between items-start">
          <div class="flex-1">
            <div class="font-semibold text-main break-words whitespace-normal text-lg">${product.name}</div>
            <div class="text-sm text-muted mt-1">Tồn kho: ${product.stock}</div>
          </div>
          <button onclick="closeQtyModal()" class="text-muted text-2xl ml-2">&times;</button>
        </div>
      </div>

      <div class="flex items-center justify-between gap-6 mb-6">
        <button type="button" onclick="adjustQtyModal(${productId}, -1); haptic('light')" class="btn btn-ghost flex-1 h-14 text-xl font-bold">-</button>
        <input type="number" id="qty-${productId}" min="0" max="${product.stock}" value="${currentQty}"
          inputmode="numeric" enterkeyhint="done" autofocus
          class="flex-1 h-14 border-2 border-primary rounded-xl text-center text-2xl font-bold focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
          onchange="updateSaleData(${productId}, 'quantity', this.value)"
          oninput="updateSaleData(${productId}, 'quantity', this.value)">
        <button type="button" onclick="adjustQtyModal(${productId}, 1); haptic('light')" class="btn btn-primary flex-1 h-14 text-xl font-bold">+</button>
      </div>

      <div class="flex items-center justify-center gap-3 mb-6">
        <button type="button" onclick="adjustQtyModal(${productId}, 1); haptic('light')" class="btn btn-warning flex-1 py-3 text-sm font-bold">+1</button>
        <button type="button" onclick="adjustQtyModal(${productId}, 5); haptic('light')" class="btn btn-warning flex-1 py-3 text-sm font-bold">+5</button>
        <button type="button" onclick="adjustQtyModal(${productId}, 10); haptic('light')" class="btn btn-warning flex-1 py-3 text-sm font-bold">+10</button>
        <button type="button" onclick="adjustQtyModal(${productId}, 20); haptic('light')" class="btn btn-warning flex-1 py-3 text-sm font-bold">+20</button>
      </div>

      <div class="mb-4">
        <label class="block text-sm font-medium text-main mb-2">Giá bán</label>
        <input type="number" id="price-${productId}" step="1000" value="${currentPrice}"
          inputmode="decimal" enterkeyhint="done"
          class="w-full border-2 border-primary rounded-xl px-4 py-3 text-right text-xl font-bold focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
          onchange="updateSaleData(${productId}, 'price', this.value)"
          oninput="updateSaleData(${productId}, 'price', this.value)">
      </div>

      <button onclick="closeQtyModal(); haptic('medium')" class="btn btn-primary w-full h-14 text-xl">
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
      const lineTotal = item.quantity * item.price;
      total += lineTotal;
      hasItems = true;
      itemCount += item.quantity;
      const name = product ? product.name : 'SP';
      cartHtml += '<div class="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-sm py-1.5 border-b border-primary/20 last:border-0">' +
        '<span class="font-semibold text-main min-w-0 flex-1 truncate">' + name + '</span>' +
        '<span class="text-muted shrink-0 tabular-nums">' + Format.number(item.price) + ' đ × ' + item.quantity + '</span>' +
        '<span class="font-bold text-money shrink-0 tabular-nums w-full text-right sm:w-auto sm:text-left">' + Format.number(lineTotal) + ' đ</span></div>';
    }
  });
  
  const totalEl = document.getElementById('totalAmount');
  if (totalEl) {
    const formatted = Format.number(total);
    totalEl.innerHTML = '<span class="value">' + formatted + '</span><span class="unit"> đ</span>';
  }
  
  const itemCountEl = document.getElementById('itemCount');
  if (itemCountEl) itemCountEl.textContent = itemCount + ' items';
  
  const cartEl = document.getElementById('cartItems');
  if (cartEl) cartEl.innerHTML = cartHtml || '<div class="text-muted text-center">Chưa có sản phẩm</div>';

  const previewEl = document.getElementById('saleCartPreview');
  if (previewEl) {
    if (!cartHtml) {
      previewEl.innerHTML = '<div class="max-h-40 overflow-y-auto">' + cartHtml + '</div>';
    } else {
      previewEl.innerHTML = '<div class="text-xs font-bold text-primary mb-1">Đơn đang bán</div><div class="max-h-40 overflow-y-auto">' + cartHtml + '</div>';
    }
  }

  const sellBtn = document.getElementById('sellBtn');
  if (sellBtn) {
    sellBtn.disabled = !hasItems;
    if (hasItems) {
      sellBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      sellBtn.classList.add('shadow-md', 'hover:from-green-600', 'hover:to-green-700');
    } else {
      sellBtn.classList.add('opacity-50', 'cursor-not-allowed');
      sellBtn.classList.remove('shadow-md', 'hover:from-green-600', 'hover:to-green-700');
    }
  }
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
      haptic && haptic('success');
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
      try {
        await showInvoiceModal(result.id);
      } catch(err) {
        console.error('Lỗi hiển thị hóa đơn:', err);
        // Fallback: hiện modal rỗng với thông tin cơ bản
        const modal = document.getElementById('invoiceModal');
        if (modal) {
          document.getElementById('invoiceTotal').textContent = formatVND(result.total || 0);
          document.getElementById('invoiceContent').innerHTML =
            '<div class="text-center text-muted py-8">Đơn hàng #'+ result.id +'</div>';
          document.getElementById('qrCode').src = '';
          modal.classList.remove('hidden');
          modal.classList.add('flex');
        }
      }
    } else {
      showToast(result.error || 'Bán hàng thất bại', 'error');
    }
  } catch (err) {
    console.error('Sale error:', err);
    showToast('Lỗi kết nối, vui lòng thử lại', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✔ Bán hàng';
  }
}

function closeInvoice() {
  document.getElementById('invoiceModal').classList.add('hidden');
  document.getElementById('invoiceModal').classList.remove('flex');
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
  document.getElementById('giftKegs').checked = false;
  document.getElementById('giftGuestName').value = '';
  toggleGiftMode();

  document.getElementById('replacementModal').classList.remove('hidden');
  document.getElementById('replacementModal').classList.add('flex');
}

function toggleGiftMode() {
  const isGift = document.getElementById('giftKegs').checked;
  document.getElementById('giftGuestRow').classList.toggle('hidden', !isGift);
  document.getElementById('replacementCustomerRow').classList.toggle('hidden', isGift);
  // Clear customer selection when switching modes
  if (isGift) {
    document.getElementById('replacementCustomer').value = '';
    // Load products for guest (no customer-specific pricing)
    loadReplacementProductsForGuest();
  }
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
  productSelect.innerHTML = '<option value="">-- Chọn sản phẩm --</option>' +
    products.map(p => '<option value="' + p.id + '">' + p.name + ' (Tồn: ' + p.stock + ')</option>').join('');
}

function loadReplacementProductsForGuest() {
  const productSelect = document.getElementById('replacementProduct');
  productSelect.innerHTML = '<option value="">-- Chọn sản phẩm --</option>' +
    products.map(p => '<option value="' + p.id + '">' + p.name + ' (Tồn: ' + p.stock + ')</option>').join('');
}

async function submitReplacement() {
  const customerId = document.getElementById('replacementCustomer').value;
  const productId = document.getElementById('replacementProduct').value;
  const quantity = parseInt(document.getElementById('replacementQty').value) || 0;
  const reason = document.getElementById('replacementReason').value;
  const isGift = document.getElementById('giftKegs').checked;
  const customerName = isGift ? (document.getElementById('giftGuestName').value.trim() || 'Khách tặng') : null;

  if (!productId || quantity <= 0) {
    alert('Vui lòng chọn sản phẩm và số lượng');
    return;
  }
  if (!isGift && !customerId) {
    alert('Vui lòng chọn khách hàng');
    return;
  }

  try {
    const res = await fetch('/api/sales/replacement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: customerId ? parseInt(customerId) : null,
        customer_name: customerName,
        product_id: parseInt(productId),
        quantity,
        reason,
        gift: isGift
      })
    });

    const data = await res.json();
    if (data.success) {
      alert('✅ ' + data.message);
      closeReplacementModal();
      loadSalesHistory();
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
  const modal = document.getElementById('invoiceModal');
  if (!modal) {
    console.error('Không tìm thấy phần tử #invoiceModal');
    return;
  }

  const res = await fetch('/api/sales/' + saleId);
  if (!res.ok) {
    console.error('Không lấy được dữ liệu hóa đơn:', res.status);
    return;
  }
  const sale = await res.json();
  
  const dateStr = new Date(sale.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const customerName = sale.customer_name || 'Khách lẻ';
  const isGift = sale.type === 'gift';
  
  let itemsHtml = '';
  (sale.items || []).forEach(item => {
    const unitPrice = item.price || 0;
    const totalPrice = unitPrice * (item.quantity || 0);
    itemsHtml += `
      <div class="invoice-item">
        <div class="invoice-name">🍺 ${item.name || 'Sản phẩm'}</div>
        <div class="invoice-row">
          <span>${item.quantity || 0} × ${formatVND(unitPrice)}</span>
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
    kegHtml = '<div class="border-t border-muted pt-3 mt-3 space-y-1">';
    if (deliverKegs > 0) {
      kegHtml += '<div class="flex justify-between text-sm"><span class="text-muted">📦 Giao vỏ</span><span class="font-semibold text-success">+' + deliverKegs + '</span></div>';
    }
    if (returnKegs > 0) {
      kegHtml += '<div class="flex justify-between text-sm"><span class="text-muted">🔁 Thu vỏ</span><span class="font-semibold text-warning">-' + returnKegs + '</span></div>';
    }
    kegHtml += '<div class="flex justify-between text-sm font-semibold pt-1"><span class="text-main">Vỏ đang giữ:</span><span>' + newBalance + '</span></div></div>';
  }

  const giftBadge = isGift ? '<div class="text-center mb-2"><span class="badge badge-warning">🎁 Tặng uống thử</span></div>' : '';

  const invoiceContent = document.getElementById('invoiceContent');
  if (invoiceContent) {
    invoiceContent.innerHTML =
      giftBadge +
      '<div class="text-sm text-muted mb-1">' + dateStr + '</div>' +
      '<div class="text-sm font-medium text-main mb-3">Khách: ' + customerName + '</div>' +
      '<div class="border-t border-muted pt-2">' + itemsHtml + '</div>' +
      kegHtml;
  }
  
  const invoiceTotal = document.getElementById('invoiceTotal');
  if (invoiceTotal) {
    const formatted = Format.number(sale.total || 0);
    invoiceTotal.innerHTML = '<span class="value">' + formatted + '</span><span class="unit"> đ</span>';
  }
  
  const qrSection = document.querySelector('#invoiceModal .mt-4.pt-4.border-t.border-muted');
  if (qrSection) {
    if (isGift) {
      qrSection.classList.add('hidden');
    } else {
      qrSection.classList.remove('hidden');
      const qrCode = document.getElementById('qrCode');
      if (qrCode) {
        qrCode.src = 'https://img.vietqr.io/image/970415-107875230331-compact2.png?amount=' + (sale.total || 0) + '&addInfo=Chuyen%20Khoan%20' + sale.id;
      }
    }
  }
  
  modal.classList.remove('hidden');
  modal.classList.add('flex');
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

function formatSaleListDate(raw) {
  if (!raw) return '—';
  const s = String(raw).trim().split(/[\sT]/)[0];
  const p = s.split('-');
  if (p.length === 3) return p[2] + '/' + p[1] + '/' + p[0];
  try {
    return new Date(raw).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (e) {
    return s;
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
    container.innerHTML = '<p class="text-muted text-center py-4">Chưa có hóa đơn nào</p>';
    renderPagination();
    return;
  }
  
  container.innerHTML = '<div class="flex flex-col gap-3">' +
    salesHistory.map(sale => {
    const date = formatSaleListDate(sale.date);
    const customerName = sale.customer_name || 'Khách lẻ';
    const isReturned = sale.status === 'returned';
    const itemsQty = parseInt(sale.items_qty, 10) || 0;

    const isReplacement = sale.type === 'replacement';
    const isGift = sale.type === 'gift';

    const badgeHtml = isReplacement
      ? '<span class="badge badge-warning">🔁 Đổi lỗi</span>'
      : isGift
      ? '<span class="badge badge-primary">🎁 Tặng thử</span>'
      : '';
    const badgeLeft = isReplacement
      ? 'border-l-4 border-warning'
      : isGift
      ? 'border-l-4 border-primary'
      : 'border-l-4 border-success';

    const qtyLabel = itemsQty > 0 ? '📦 ' + itemsQty + 'L' : '';
    const saleMoney = typeof Format !== 'undefined' ? Format.number(sale.total) : formatVND(sale.total).replace(' đ', '');

    return `
      <div class="order-item ${badgeLeft}">
        <div class="order-header">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="text-xs font-semibold text-muted shrink-0">#${sale.id}</span>
            <span class="order-title">${customerName}</span>
            ${badgeHtml ? '<span class="shrink-0">' + badgeHtml + '</span>' : ''}
          </div>
          <span class="order-meta">📅 ${date}</span>
        </div>

        <div class="order-footer">
          <div class="flex items-baseline gap-1">
            <span class="money text-money text-xl">${saleMoney} <span class="unit">đ</span></span>
          </div>
          ${qtyLabel ? '<span class="order-meta">' + qtyLabel + '</span>' : ''}
        </div>

        <div class="order-actions">
          <button onclick="viewSale(${sale.id})" class="btn btn-secondary btn-sm">Hóa đơn</button>
          ${!isReturned ? `
          <button onclick="openCollectKegModal(${sale.id})" class="btn btn-warning btn-sm">Thu vỏ</button>
          <button onclick="editSale(${sale.id})" class="btn btn-ghost btn-sm">Sửa</button>
          <button onclick="deleteSale(${sale.id})" class="btn btn-danger btn-sm">Xóa</button>` : ''}
        </div>
      </div>
    `;
  }).join('') + '</div>';
  
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
    <div class="flex justify-center items-center gap-2 mt-3 py-3 bg-bg">
      <button type="button" onclick="changeSalesPage(${page - 1})" ${prevDisabled ? 'disabled' : ''}
        class="px-4 py-2 rounded-lg min-w-[4rem] ${prevDisabled ? 'bg-bg text-muted cursor-not-allowed' : 'btn btn-ghost px-4 h-10 shadow-sm'}">
        ‹ Trước
      </button>
      <span class="text-sm text-muted px-2">${page}/${totalPages}</span>
      <button type="button" onclick="changeSalesPage(${page + 1})" ${nextDisabled ? 'disabled' : ''}
        class="px-4 py-2 rounded-lg min-w-[4rem] ${nextDisabled ? 'bg-bg text-muted cursor-not-allowed' : 'btn btn-ghost px-4 h-10 shadow-sm'}">
        Sau ›
      </button>
      <span class="text-xs text-muted ml-2">(${total} đơn)</span>
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
    <div class="flex items-center justify-between py-2 border-b border-muted">
      <div>
        <div class="font-medium text-main">${item.name}</div>
        <div class="text-xs text-muted">Giá: ${formatVND(item.price)} | Đã mua: ${item.quantity}</div>
      </div>
      <div class="flex items-center gap-2">
        <input type="number" id="return_qty_${item.product_id}"
          data-price="${item.price}"
          min="0" max="${item.quantity}" value="0"
          class="w-16 border-2 border-primary rounded px-2 py-1 text-center focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
          placeholder="0" onchange="updateReturnPreview(this, ${item.quantity})" oninput="updateReturnPreview(this, ${item.quantity})">
        <span class="text-xs text-muted">/${item.quantity}</span>
      </div>
    </div>
  `).join('');

  // Tạo modal
  const modalHtml = `
    <div id="returnModal" class="fixed inset-0 bg-overlay flex items-center justify-center z-50 p-4">
      <div class="card w-full max-w-md max-h-[80vh] overflow-hidden">
        <div class="p-4 border-b border-muted bg-primary text-main">
          <h3 class="font-bold text-lg">↩️ TRẢ HÀNG</h3>
          <div class="text-sm opacity-80">#${id} - ${customerName}</div>
        </div>

        <div class="p-4 overflow-y-auto max-h-[40vh]">
          <div class="font-medium text-main mb-2">Chọn sản phẩm và số lượng trả:</div>
          ${itemsHtml}

          <div class="mt-4 p-3 card">
            <div class="flex justify-between">
              <span class="text-main">Tổng tiền hoàn:</span>
              <span id="returnPreview" class="font-bold text-money">0 đ</span>
            </div>
          </div>
        </div>

        <div class="p-4 border-t border-muted">
          <div class="font-medium text-main mb-2">Loại trả:</div>
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
            <label class="block text-sm font-medium text-main mb-1">Lý do:</label>
            <input type="text" id="returnReason"
              class="w-full border-2 border-primary rounded px-3 py-2 focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
              placeholder="Bia hư, chua,...">
          </div>

          <div class="flex gap-2">
            <button onclick="closeReturnModal()"
              class="btn btn-ghost flex-1 py-3">
              Hủy
            </button>
            <button onclick="submitPartialReturn(${id})"
              class="btn btn-warning flex-1 py-3">
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
