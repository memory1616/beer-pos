// Purchases Page JavaScript
// Tách riêng để dễ bảo trì và cache

let cart = [];

function switchTab(tab) {
  const newSection = document.getElementById('newPurchaseSection');
  const historySection = document.getElementById('historySection');
  const tabNew = document.getElementById('tabNew');
  const tabHistory = document.getElementById('tabHistory');
  
  if (!newSection || !historySection || !tabNew || !tabHistory) return;
  
  if (tab === 'new') {
    newSection.classList.remove('hidden');
    historySection.classList.add('hidden');
    tabNew.classList.add('bg-blue-600', 'text-white');
    tabNew.classList.remove('bg-gray-200', 'text-gray-700');
    tabHistory.classList.remove('bg-blue-600', 'text-white');
    tabHistory.classList.add('bg-gray-200', 'text-gray-700');
  } else {
    newSection.classList.add('hidden');
    historySection.classList.remove('hidden');
    tabHistory.classList.add('bg-blue-600', 'text-white');
    tabHistory.classList.remove('bg-gray-200', 'text-gray-700');
    tabNew.classList.remove('bg-blue-600', 'text-white');
    tabNew.classList.add('bg-gray-200', 'text-gray-700');
  }
}

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

function updateCart() {
  cart = [];
  const inputs = document.querySelectorAll('#productList input[type="number"]');
  
  inputs.forEach(input => {
    const qty = parseInt(input.value) || 0;
    if (qty > 0) {
      cart.push({
        product_id: input.dataset.productId,
        name: input.dataset.name,
        quantity: qty,
        unit_price: parseFloat(input.dataset.cost)
      });
    }
  });
  
  renderCart();
}

function renderCart() {
  const cartEl = document.getElementById('cartItems');
  const totalEl = document.getElementById('cartTotal');
  const submitBtn = document.getElementById('submitBtn');
  
  if (cart.length === 0) {
    cartEl.innerHTML = '<div class="text-gray-500 text-sm">Chưa chọn sản phẩm nào</div>';
    totalEl.textContent = '0 ₫';
    submitBtn.disabled = true;
    return;
  }
  
  let total = 0;
  cartEl.innerHTML = cart.map(item => {
    const itemTotal = item.quantity * item.unit_price;
    total += itemTotal;
    return '<div class="flex justify-between text-sm"><span>' + item.quantity + 'x ' + item.name + '</span><span class="font-medium">' + formatVND(itemTotal) + '</span></div>';
  }).join('');
  
  totalEl.textContent = formatVND(total);
  submitBtn.disabled = false;
}

async function submitPurchase() {
  if (cart.length === 0) return alert('Chưa chọn sản phẩm nào');
  
  const note = document.getElementById('purchaseNote').value;
  const submitBtn = document.getElementById('submitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = '⏳ Đang xử lý...';
  
  try {
    const res = await fetch('/api/purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: cart, note })
    });
    
    const data = await res.json();
    
    if (res.ok) {
      let message = '✅ Nhập hàng thành công!\nTổng tiền: ' + formatVND(data.total_amount);
      if (data.kegsImported > 0) {
        message += '\n\n📦 Nhập ' + data.kegsImported + ' vỏ từ nhà máy';
        message += '\n🔻 Kho vỏ rỗng: ' + data.emptyAfter + ' vỏ';
      }
      alert(message);
      // Reload and switch to history tab
      window.location.href = '/purchases?tab=history';
    } else {
      alert('❌ Lỗi: ' + (data.error || 'Không rõ lỗi'));
      submitBtn.disabled = false;
      submitBtn.textContent = '✅ Xác nhận nhập hàng';
    }
  } catch (err) {
    alert('❌ Lỗi kết nối');
    submitBtn.disabled = false;
    submitBtn.textContent = '✅ Xác nhận nhập hàng';
  }
}

function editPurchase(id) {
  window.location.href = '/purchases?tab=history&edit=' + id;
}

async function deletePurchase(id) {
  if (!confirm('Bạn có chắc muốn xóa phiếu nhập này?')) return;
  
  try {
    const res = await fetch('/api/purchases/' + id, { method: 'DELETE' });
    if (res.ok) {
      location.reload();
    } else {
      alert('Lỗi xóa phiếu nhập');
    }
  } catch (err) {
    alert('Lỗi kết nối');
  }
}
