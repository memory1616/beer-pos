// Purchases Page JavaScript
// Tách riêng để dễ bảo trì và cache

let cart = [];

function switchTab(tab) {
  if (tab === 'new') {
    document.getElementById('newPurchaseSection').classList.remove('hidden');
    document.getElementById('historySection').classList.add('hidden');
    document.getElementById('tabNew').classList.add('bg-blue-600', 'text-white');
    document.getElementById('tabNew').classList.remove('bg-gray-200', 'text-gray-700');
    document.getElementById('tabHistory').classList.remove('bg-blue-600', 'text-white');
    document.getElementById('tabHistory').classList.add('bg-gray-200', 'text-gray-700');
  } else {
    document.getElementById('newPurchaseSection').classList.add('hidden');
    document.getElementById('historySection').classList.remove('hidden');
    document.getElementById('tabHistory').classList.add('bg-blue-600', 'text-white');
    document.getElementById('tabHistory').classList.remove('bg-gray-200', 'text-gray-700');
    document.getElementById('tabNew').classList.remove('bg-blue-600', 'text-white');
    document.getElementById('tabNew').classList.add('bg-gray-200', 'text-gray-700');
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
      alert('✅ Nhập hàng thành công!\nTổng tiền: ' + formatVND(data.total_amount));
      location.reload();
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
