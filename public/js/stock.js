// Stock Page JavaScript
// Tách riêng để dễ bảo trì và cache
// formatVND, showToast được định nghĩa trong utils.js (global)

let currentProducts = [];
let importData = {}; // Store import data by productId

function initStockPage(data) {
  // Render products
  currentProducts = data.products;
  renderProducts(data.products);
  
  // Render import form
  renderImportForm(data.products);
  
  // Render purchase history
  if (data.purchases && data.purchases.length > 0) {
    renderPurchaseHistory(data.purchases);
  }
}

function renderPurchaseHistory(purchases) {
  const container = document.getElementById('purchaseHistoryList');
  
  if (purchases.length === 0) {
    container.innerHTML = '<div class="text-gray-500 text-center py-2">Chưa có lịch sử nhập hàng</div>';
    return;
  }
  
  container.innerHTML = purchases.map(p => {
    const date = new Date(p.date);
    const formattedDate = date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return `
      <div class="flex justify-between items-center p-2 border-b">
        <div>
          <div class="font-medium">Đơn #${p.id}</div>
          <div class="text-xs text-gray-500">${formattedDate} • ${p.item_count} sản phẩm</div>
        </div>
        <div class="flex items-center gap-2">
          <div class="font-bold text-blue-600">${formatVND(p.total_amount)}</div>
          <button onclick="editPurchase(${p.id})" class="text-blue-500 text-sm">✏️</button>
          <button onclick="deletePurchase(${p.id})" class="text-red-500 text-sm">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

async function editPurchase(purchaseId) {
  try {
    const res = await fetch('/api/purchases/' + purchaseId);
    const purchase = await res.json();
    
    document.getElementById('editPurchaseId').value = purchase.id;
    document.getElementById('editPurchaseNote').value = purchase.note || '';
    
    // Load purchase items
    const itemsRes = await fetch('/api/purchases/' + purchaseId);
    const itemsData = await itemsRes.json();
    
    const itemsContainer = document.getElementById('editPurchaseItems');
    itemsContainer.innerHTML = itemsData.items.map(item => `
      <div class="p-3 border border-amber-200 rounded-xl bg-amber-50/50 space-y-2">
        <div class="font-medium text-sm text-gray-800 truncate">${item.product_name}</div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Số lượng</label>
            <input type="number" data-item-id="${item.id}" data-product-id="${item.product_id}" 
              min="0" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-center edit-qty" 
              value="${item.quantity}">
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Đơn giá (VNĐ)</label>
            <input type="number" data-item-id="${item.id}" data-product-id="${item.product_id}" 
              step="1000" min="0" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-right edit-cost" 
              value="${item.unit_price}">
          </div>
        </div>
      </div>
    `).join('');
    
    document.getElementById('purchaseModal').classList.remove('hidden');
    document.getElementById('purchaseModal').classList.add('flex');
  } catch (err) {
    console.error(err);
    alert('Lỗi tải thông tin đơn nhập');
  }
}

function closePurchaseModal() {
  document.getElementById('purchaseModal').classList.add('hidden');
  document.getElementById('purchaseModal').classList.remove('flex');
}

async function deletePurchase(purchaseId) {
  if (!confirm('Bạn có chắc muốn xoá đơn nhập hàng này?')) return;
  
  try {
    const res = await fetch('/api/purchases/' + purchaseId, { method: 'DELETE' });
    if (res.ok) {
      alert('Đã xoá đơn nhập hàng!');
      location.reload();
    } else {
      const err = await res.json();
      alert(err.error || 'Lỗi xoá đơn');
    }
  } catch (err) {
    alert('Lỗi xoá đơn');
  }
}

document.getElementById('editPurchaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const purchaseId = document.getElementById('editPurchaseId').value;
  const note = document.getElementById('editPurchaseNote').value;
  
  // Get updated items
  const items = [];
  document.querySelectorAll('#editPurchaseItems .edit-qty').forEach(qtyInput => {
    const itemId = qtyInput.dataset.itemId;
    const productId = qtyInput.dataset.productId;
    const quantity = parseInt(qtyInput.value) || 0;
    const costInput = document.querySelector(`.edit-cost[data-item-id="${itemId}"]`);
    const unitPrice = parseFloat(costInput.value) || 0;
    
    if (quantity > 0) {
      items.push({ item_id: itemId, product_id: productId, quantity, unit_price: unitPrice });
    }
  });
  
  try {
    const res = await fetch('/api/purchases/' + purchaseId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, note })
    });
    
    if (res.ok) {
      closePurchaseModal();
      location.reload();
    } else {
      const err = await res.json();
      alert(err.error || 'Lỗi cập nhật');
    }
  } catch (err) {
    alert('Lỗi cập nhật đơn nhập');
  }
});

function renderImportForm(products) {
  const container = document.getElementById('importProducts');
  
  // Layout rõ ràng: tên SP, giá vốn 1 dòng, chỉ ô SL (không lặp giá)
  container.innerHTML = products.map(p => `
    <div class="p-3 border border-gray-200 rounded-xl bg-gray-50">
      <div class="text-sm font-semibold text-gray-800">${p.name}</div>
      <div class="text-xs text-gray-600 mt-0.5">Giá vốn: ${formatVND(p.cost_price || 0)} · Tồn: ${p.stock}</div>
      <input type="number" id="qty-${p.id}" min="0" placeholder="Nhập SL"
        class="mt-2 w-full border-2 border-gray-200 rounded-lg p-2.5 text-center font-medium"
        onchange="updateImportData(${p.id}, this.value)"
        oninput="updateImportData(${p.id}, this.value)">
    </div>
  `).join('');
  
  importData = {};
}

function updateImportData(productId, value) {
  if (!importData[productId]) {
    importData[productId] = { quantity: 0 };
  }
  importData[productId].quantity = parseInt(value) || 0;
  calculateImportTotal();
}

function calculateImportTotal() {
  let total = 0;
  Object.keys(importData).forEach(productId => {
    const item = importData[productId];
    if (item.quantity > 0) {
      const product = currentProducts.find(p => p.id == productId);
      const costPrice = product ? (product.cost_price || 0) : 0;
      total += item.quantity * costPrice;
    }
  });
  const el = document.getElementById('importTotal');
  if (el) el.textContent = formatVND(total);
}

async function submitImport() {
  const items = [];
  Object.keys(importData).forEach(productId => {
    const item = importData[productId];
    if (item.quantity > 0) {
      const product = currentProducts.find(p => p.id == productId);
      const costPrice = product ? (product.cost_price || 0) : 0;
      if (costPrice > 0) {
        items.push({
          productId: parseInt(productId),
          quantity: item.quantity,
          costPrice: costPrice
        });
      } else {
        items.push({
          productId: parseInt(productId),
          quantity: item.quantity,
          costPrice: 0
        });
      }
    }
  });
  
  if (items.length === 0) {
    alert('Vui lòng nhập số lượng');
    return;
  }
  
  const res = await fetch('/api/stock/multiple', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, note: 'Nhập kho' })
  });
  
  if (res.ok) {
    alert('Nhập hàng thành công!');
    location.reload();
  } else {
    const err = await res.json();
    alert(err.error || 'Lỗi nhập hàng');
  }
}

function renderProducts(products) {
  const productList = document.getElementById('productList');
  const totalStockEl = document.getElementById('totalStock');
  
  if (!productList || !totalStockEl) return;
  
  const totalStock = products.reduce((sum, p) => sum + p.stock, 0);
  const lowStockProducts = products.filter(p => p.stock < 5);

  totalStockEl.textContent = totalStock;

  // Add low stock alert section at top if there are low stock products
  let lowStockAlert = '';
  if (lowStockProducts.length > 0) {
    lowStockAlert = `
      <div class="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
        <div class="text-sm font-bold text-red-700 mb-2">⚠️ Tồn kho thấp (${lowStockProducts.length})</div>
        <div class="flex flex-wrap gap-1">
          ${lowStockProducts.map(p => `
            <span class="text-xs bg-red-100 text-red-700 px-2 py-1 rounded">
              ${p.name}: <b>${p.stock}</b>
            </span>
          `).join('')}
        </div>
      </div>
    `;
  }

  productList.innerHTML = lowStockAlert + products.map(p => `
    <div class="card product-card ${p.stock < 5 ? 'border-red-300 bg-red-50' : 'border-gray-200'}">
      <div class="flex justify-between items-start mb-1">
        <div class="font-bold text-sm">${p.name}</div>
        ${p.stock < 5 ? '<span class="badge badge-danger">⚠️ Sắp hết</span>' : ''}
      </div>
      <div class="text-xs text-gray-500 mb-2">Giá vốn: ${formatVND(p.cost_price || 0)}</div>
      <div class="flex justify-between items-center">
        <div class="text-lg font-bold ${p.stock < 5 ? 'text-red-600' : 'text-green-600'}">${p.stock}</div>
        <button onclick="openProductModal(${p.id})" class="text-xs text-blue-500 underline">✏️ Sửa</button>
      </div>
    </div>
  `).join('');
}

// Product Modal Functions
function openProductModal(productId = null) {
  const modal = document.getElementById('productModal');
  const form = document.getElementById('productForm');
  const title = document.getElementById('modalTitle');
  const deleteBtn = document.getElementById('deleteProductBtn');
  const stockField = document.getElementById('stockField');
  
  form.reset();
  
  if (productId) {
    // Edit mode
    const product = currentProducts.find(p => p.id === productId);
    if (!product) return;
    
    title.textContent = 'Sửa sản phẩm';
    document.getElementById('productId').value = product.id;
    document.getElementById('productName').value = product.name;
    document.getElementById('productType').value = product.type || 'keg';
    document.getElementById('productCostPrice').value = product.cost_price || 0;
    document.getElementById('productStock').value = product.stock;
    deleteBtn.classList.remove('hidden');
    stockField.classList.remove('hidden');
  } else {
    // Add mode
    title.textContent = 'Thêm sản phẩm';
    document.getElementById('productId').value = '';
    document.getElementById('productType').value = 'keg';
    deleteBtn.classList.add('hidden');
    stockField.classList.add('hidden');
  }
  
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeProductModal() {
  const modal = document.getElementById('productModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function deleteProduct() {
  const productId = document.getElementById('productId').value;
  const productName = document.getElementById('productName').value;
  
  if (!confirm(`Bạn có chắc muốn xoá sản phẩm "${productName}"?`)) {
    return;
  }
  
  fetch('/api/products/' + productId, {
    method: 'DELETE'
  }).then(res => {
    if (res.ok) {
      alert('Đã xoá sản phẩm!');
      location.reload();
    } else {
      alert('Lỗi xoá sản phẩm');
    }
  });
}

// Product Form Submit
document.getElementById('productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const productId = document.getElementById('productId').value;
  const name = document.getElementById('productName').value.trim();
  const type = document.getElementById('productType').value;
  const cost_price = parseFloat(document.getElementById('productCostPrice').value) || 0;
  const stock = productId ? (parseInt(document.getElementById('productStock').value) || 0) : 0;
  
  if (!name) {
    alert('Vui lòng nhập tên sản phẩm');
    return;
  }
  
  const data = { name, type, cost_price };
  if (productId) {
    data.stock = stock;
  }
  
  const method = productId ? 'PUT' : 'POST';
  const url = productId ? '/api/products/' + productId : '/api/products';
  
  const res = await fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  
  if (res.ok) {
    closeProductModal();
    location.reload();
  } else {
    const err = await res.json();
    alert(err.error || 'Lỗi lưu sản phẩm');
  }
});
