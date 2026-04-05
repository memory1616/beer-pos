// Purchases Page JavaScript
// Tách riêng để dễ bảo trì và cache
// formatVND, showToast được định nghĩa trong utils.js (global)

// Global state for purchase history (used by realtime.js helpers)
var allPurchases = [];
var historyCurrentPage = 1;
var HISTORY_PAGE_SIZE = 5;

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
    tabNew.classList.add('active');
    tabNew.classList.remove('not-active');
    tabHistory.classList.remove('active');
    tabHistory.classList.add('not-active');
  } else {
    newSection.classList.add('hidden');
    historySection.classList.remove('hidden');
    tabHistory.classList.add('active');
    tabHistory.classList.remove('not-active');
    tabNew.classList.remove('active');
    tabNew.classList.add('not-active');
  }
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
    cartEl.innerHTML = '<div class="text-muted text-sm">Chưa chọn sản phẩm nào</div>';
    totalEl.textContent = '0 đ';
    submitBtn.disabled = true;
    return;
  }
  
  let total = 0;
  cartEl.innerHTML = cart.map(item => {
    const itemTotal = item.quantity * item.unit_price;
    total += itemTotal;
    return '<div class="flex justify-between text-sm"><span>' + item.quantity + 'x ' + item.name + '</span><span class="font-medium">' + formatVND(itemTotal) + '</span></div>';
  }).join('');
  
  totalEl.innerHTML = '<span class="value">' + formatVND(total).replace(' đ', '') + '</span><span class="unit"> đ</span>';
  submitBtn.disabled = false;
}

async function submitPurchase() {
  if (cart.length === 0) return alert('Chưa chọn sản phẩm nào');

  const note = document.getElementById('purchaseNote').value;
  const submitBtn = document.getElementById('submitBtn');
  const tempId = 'tmp_pur_' + Date.now();

  var btnState = setButtonLoading(submitBtn, 'Xác nhận nhập hàng');

  optimisticMutate({
    request: function() {
      return fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: cart, note }),
        cache: 'no-store'
      });
    },

    applyOptimistic: function() {
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Đang xử lý...'; }

      // Optimistically add temp purchase card
      if (typeof allPurchases !== 'undefined') {
        var tempPurchase = {
          id: tempId,
          date: new Date().toISOString(),
          item_count: cart.length,
          total_amount: cart.reduce(function(s, it) { return s + it.quantity * it.unit_price; }, 0),
          _optimistic: true
        };
        allPurchases.unshift(tempPurchase);
        window.store.purchases.unshift(tempPurchase);
        renderPurchaseItem(tempPurchase, { prepend: true });
        updatePurchasesSummary();
        checkPurchasesEmpty();
      }
    },

    rollback: function() {
      if (btnState) restoreButtonLoading(btnState);
      if (typeof allPurchases !== 'undefined') {
        allPurchases = allPurchases.filter(function(p) { return p.id !== tempId; });
        window.store.purchases = allPurchases;
        removePurchaseItem(tempId);
        updatePurchasesSummary();
        checkPurchasesEmpty();
      }
    },

    onSuccess: function(result) {
      if (btnState) restoreButtonLoading(btnState);

      let message = 'Nhập hàng thành công!\nTổng tiền: ' + formatVND(result.total_amount);
      if (result.kegsImported > 0) {
        message += '\n\nNhập ' + result.kegsImported + ' vỏ từ nhà máy';
        message += '\nKho vỏ rỗng: ' + result.emptyAfter + ' vỏ';
      }
      alert(message);

      if (result.purchase) {
        // Remove temp and add real
        if (typeof allPurchases !== 'undefined') {
          var tIdx = allPurchases.findIndex(function(p) { return p.id === tempId; });
          if (tIdx !== -1) {
            allPurchases[tIdx] = result.purchase;
            window.store.purchases[tIdx] = result.purchase;
          }
          removePurchaseItem(tempId);
          renderPurchaseItem(result.purchase, { prepend: true });
          // Also update the temp card's data-expense-id to the real one
          var tempCard = document.querySelector('[data-purchase-id="' + tempId + '"]');
          if (tempCard) tempCard.setAttribute('data-purchase-id', result.purchase.id);
        }
        historyCurrentPage = 1;
        updatePurchasesSummary();
        checkPurchasesEmpty();
      }

      cart = [];
      document.querySelectorAll('#productList input[type="number"]').forEach(function(input) {
        input.value = '';
      });
      renderCart();
      switchTab('history');
    },

    onError: function() {
      if (btnState) restoreButtonLoading(btnState);
    }
  });
}

function editPurchase(id) {
  window.location.href = '/purchases?tab=history&edit=' + id;
}

async function deletePurchase(id) {
  if (!confirm('Bạn có chắc muốn xóa phiếu nhập này?')) return;

  // Snapshot for rollback
  var deletedPurchase = Object.assign({}, allPurchases.find(function(p) { return String(p.id) === String(id); }));

  // Disable delete button on the card
  var card = document.querySelector('[data-purchase-id="' + id + '"]');
  var deleteBtn = card ? card.querySelector('[onclick^="deletePurchase"]') : null;
  var btnState = deleteBtn ? setButtonLoading(deleteBtn) : null;

  optimisticMutate({
    request: function() {
      return fetch('/api/purchases/' + id, { method: 'DELETE', cache: 'no-store' });
    },

    applyOptimistic: function() {
      allPurchases = allPurchases.filter(function(p) { return String(p.id) !== String(id); });
      window.store.purchases = allPurchases;
      removePurchaseItem(id);
      updatePurchasesSummary();
      checkPurchasesEmpty();
    },

    rollback: function() {
      if (deletedPurchase) {
        allPurchases.unshift(deletedPurchase);
        window.store.purchases.unshift(deletedPurchase);
        renderPurchaseItem(deletedPurchase, { prepend: true });
        updatePurchasesSummary();
        checkPurchasesEmpty();
      }
    },

    onSuccess: function() {
      if (btnState) restoreButtonLoading(btnState);
      alert('Đã xóa phiếu nhập!');
    },

    onError: function() {
      if (btnState) restoreButtonLoading(btnState);
    }
  });
}
