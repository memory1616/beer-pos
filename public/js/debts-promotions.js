/**
 * BeerPOS - Debts & Promotions State Management (Frontend)
 *
 * Sử dụng chung store từ backend để đồng bộ UI.
 * Các function để gọi API và cập nhật UI state.
 */

// Đã inject từ backend: window.apiBatch, window.debts, window.promotions

const DebtsUI = {
  /**
   * Load debts list
   */
  async loadDebts(filters = {}) {
    const params = new URLSearchParams();
    if (filters.hasDebt) params.set('hasDebt', '1');
    if (filters.overdue) params.set('overdue', '1');

    const res = await fetch(`/api/debts?${params}`);
    const data = await res.json();
    return data;
  },

  /**
   * Load customer debt details
   */
  async loadCustomerDebt(customerId) {
    const res = await fetch(`/api/debts/${customerId}`);
    const data = await res.json();
    return data;
  },

  /**
   * Add payment
   */
  async addPayment(customerId, amount, note = '') {
    const res = await fetch('/api/debts/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId, amount, note })
    });
    const data = await res.json();
    return data;
  },

  /**
   * Get debt summary for dashboard
   */
  async getSummary() {
    const res = await fetch('/api/debts/summary');
    const data = await res.json();
    return data;
  },

  /**
   * Render debts list UI
   */
  renderDebtsList(debts, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!debts || debts.length === 0) {
      container.innerHTML = `
        <div class="text-center py-8 text-gray-500">
          <div class="text-4xl mb-2">💰</div>
          <p>Không có công nợ</p>
        </div>
      `;
      return;
    }

    container.innerHTML = debts.map(d => `
      <div class="bg-white rounded-lg shadow p-4 mb-3" data-customer-id="${d.id}">
        <div class="flex justify-between items-start">
          <div>
            <h3 class="font-semibold text-gray-900">${d.name}</h3>
            <p class="text-sm text-gray-500">${d.phone || 'Không có SĐT'}</p>
            <p class="text-xs text-gray-400 mt-1">
              Lần mua cuối: ${d.last_order_date ? formatDate(d.last_order_date) : 'Chưa mua'}
            </p>
          </div>
          <div class="text-right">
            <div class="text-xl font-bold text-red-600">
              ${formatCurrency(d.debt || 0)}
            </div>
            <div class="text-xs text-gray-500">Công nợ</div>
          </div>
        </div>
        <div class="mt-3 flex gap-2">
          <button onclick="DebtsUI.showPaymentModal(${d.id}, '${d.name}', ${d.debt || 0})"
                  class="flex-1 bg-green-500 text-white py-2 px-3 rounded-lg text-sm hover:bg-green-600">
            💰 Thu nợ
          </button>
          <button onclick="DebtsUI.showDebtHistory(${d.id})"
                  class="flex-1 bg-blue-500 text-white py-2 px-3 rounded-lg text-sm hover:bg-blue-600">
            📋 Chi tiết
          </button>
        </div>
      </div>
    `).join('');
  },

  /**
   * Show payment modal
   */
  showPaymentModal(customerId, customerName, currentDebt) {
    const modal = document.createElement('div');
    modal.id = 'paymentModal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
    modal.innerHTML = `
      <div class="bg-white rounded-xl p-6 w-full max-w-md mx-4">
        <h2 class="text-xl font-bold mb-4">💰 Thu nợ</h2>
        <div class="mb-4">
          <p class="text-gray-600">Khách hàng: <strong>${customerName}</strong></p>
          <p class="text-gray-600">Công nợ hiện tại: <strong class="text-red-600">${formatCurrency(currentDebt)}</strong></p>
        </div>

        <div class="mb-4">
          <label class="block text-sm font-medium text-gray-700 mb-1">Số tiền thu</label>
          <input type="number" id="paymentAmount"
                 class="w-full px-4 py-3 border rounded-lg text-lg"
                 placeholder="Nhập số tiền"
                 max="${currentDebt}"
                 value="${currentDebt}">
        </div>

        <div class="mb-4">
          <label class="block text-sm font-medium text-gray-700 mb-1">Ghi chú (tùy chọn)</label>
          <input type="text" id="paymentNote"
                 class="w-full px-4 py-2 border rounded-lg"
                 placeholder="VD: Thanh toán đơn hàng #123">
        </div>

        <div class="flex gap-3">
          <button onclick="DebtsUI.closeModal('paymentModal')"
                  class="flex-1 bg-gray-200 text-gray-800 py-3 rounded-lg font-medium hover:bg-gray-300">
            Hủy
          </button>
          <button onclick="DebtsUI.submitPayment(${customerId})"
                  class="flex-1 bg-green-500 text-white py-3 rounded-lg font-medium hover:bg-green-600">
            Xác nhận
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) DebtsUI.closeModal('paymentModal');
    });
  },

  /**
   * Submit payment
   */
  async submitPayment(customerId) {
    const amount = parseFloat(document.getElementById('paymentAmount').value);
    const note = document.getElementById('paymentNote').value;

    if (!amount || amount <= 0) {
      alert('Vui lòng nhập số tiền hợp lệ');
      return;
    }

    try {
      const result = await this.addPayment(customerId, amount, note);

      if (result.success) {
        this.closeModal('paymentModal');
        showToast(`Đã thu ${formatCurrency(amount)}`, 'success');

        // Refresh list
        if (typeof loadDebts === 'function') loadDebts();
      } else {
        alert(result.error || 'Có lỗi xảy ra');
      }
    } catch (e) {
      alert('Lỗi kết nối: ' + e.message);
    }
  },

  /**
   * Show debt history modal
   */
  async showDebtHistory(customerId) {
    const modal = document.createElement('div');
    modal.id = 'historyModal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
    modal.innerHTML = `
      <div class="bg-white rounded-xl p-6 w-full max-w-lg mx-4 max-h-[80vh] overflow-auto">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-xl font-bold">📋 Lịch sử công nợ</h2>
          <button onclick="DebtsUI.closeModal('historyModal')" class="text-gray-500 hover:text-gray-700">
            ✕
          </button>
        </div>
        <div id="historyContent" class="text-center py-8">
          <div class="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full mx-auto"></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Load history
    const data = await this.loadCustomerDebt(customerId);
    const container = document.getElementById('historyContent');

    if (!data.data) {
      container.innerHTML = '<p class="text-gray-500">Không có dữ liệu</p>';
      return;
    }

    const { customer, payments, unpaidSales } = data.data;

    container.innerHTML = `
      <div class="mb-4 p-3 bg-red-50 rounded-lg">
        <p class="text-sm text-gray-600">Công nợ hiện tại</p>
        <p class="text-2xl font-bold text-red-600">${formatCurrency(customer.debt || 0)}</p>
      </div>

      <h3 class="font-semibold mb-2">💳 Thanh toán (${payments?.length || 0})</h3>
      <div class="space-y-2 mb-4 max-h-48 overflow-auto">
        ${(payments || []).map(p => `
          <div class="flex justify-between items-center p-2 bg-green-50 rounded">
            <div>
              <p class="text-sm font-medium text-green-700">+${formatCurrency(p.amount)}</p>
              <p class="text-xs text-gray-500">${formatDate(p.date)}</p>
            </div>
            <span class="text-xs text-green-600">✓</span>
          </div>
        `).join('') || '<p class="text-sm text-gray-400">Chưa có thanh toán</p>'}
      </div>

      <h3 class="font-semibold mb-2">🧾 Đơn hàng chưa thanh toán (${unpaidSales?.length || 0})</h3>
      <div class="space-y-2 max-h-48 overflow-auto">
        ${(unpaidSales || []).map(s => `
          <div class="flex justify-between items-center p-2 bg-gray-50 rounded">
            <div>
              <p class="text-sm">Đơn #${s.id}</p>
              <p class="text-xs text-gray-500">${formatDate(s.date)}</p>
            </div>
            <div class="text-right">
              <p class="text-sm font-medium">${formatCurrency(s.total)}</p>
              <span class="text-xs px-2 py-0.5 rounded ${s.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}">
                ${s.payment_status === 'partial' ? 'Một phần' : 'Chưa thanh toán'}
              </span>
            </div>
          </div>
        `).join('') || '<p class="text-sm text-gray-400">Không có đơn chưa thanh toán</p>'}
      </div>
    `;
  },

  /**
   * Close modal
   */
  closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.remove();
  }
};

// ============================================================
// PROMOTIONS UI
// ============================================================

const PromotionsUI = {
  /**
   * Load active promotions
   */
  async getActivePromotions() {
    const res = await fetch('/api/promotions/active');
    const data = await res.json();
    return data;
  },

  /**
   * Calculate discount for cart
   */
  async calculateDiscount(cart) {
    const res = await fetch('/api/promotions/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cart)
    });
    const data = await res.json();
    return data;
  },

  /**
   * Render promotion badge
   */
  renderPromotionBadge(promo, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let badgeClass = 'bg-blue-100 text-blue-700';
    let icon = '🏷️';

    if (promo.type === 'percentage') {
      badgeClass = 'bg-green-100 text-green-700';
      icon = '💯';
    } else if (promo.type === 'fixed') {
      badgeClass = 'bg-purple-100 text-purple-700';
      icon = '💵';
    }

    const discountText = promo.type === 'percentage'
      ? `${promo.value}%`
      : formatCurrency(promo.value);

    container.innerHTML = `
      <div class="inline-flex items-center gap-1 px-2 py-1 rounded-full ${badgeClass} text-sm">
        <span>${icon}</span>
        <span class="font-medium">Giảm ${discountText}</span>
        ${promo.customer_tier && promo.customer_tier !== 'all' ? `
          <span class="text-xs opacity-75">(${promo.customer_tier.toUpperCase()})</span>
        ` : ''}
      </div>
    `;
  },

  /**
   * Show promotion applied toast
   */
  showPromotionApplied(result) {
    if (!result.promotionsApplied || result.promotionsApplied.length === 0) return;

    const promotionsText = result.promotionsApplied
      .map(p => `${p.name}: -${formatCurrency(p.discount)}`)
      .join(', ');

    showToast(`Áp dụng khuyến mãi: ${promotionsText}`, 'success', 4000);
  },

  /**
   * Render promotions management UI
   */
  renderPromotionsList(promotions, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!promotions || promotions.length === 0) {
      container.innerHTML = `
        <div class="text-center py-8 text-gray-500">
          <div class="text-4xl mb-2">🎁</div>
          <p>Chưa có khuyến mãi nào</p>
          <button onclick="PromotionsUI.showCreateModal()"
                  class="mt-4 bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600">
            Tạo khuyến mãi mới
          </button>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="space-y-3">
        ${promotions.map(p => this.renderPromotionCard(p)).join('')}
      </div>
    `;
  },

  /**
   * Render single promotion card
   */
  renderPromotionCard(promo) {
    const statusClass = promo.active ? 'border-green-500' : 'border-gray-300 opacity-60';
    let typeLabel = '';
    let valueDisplay = '';

    if (promo.type === 'percentage') {
      typeLabel = 'Phần trăm';
      valueDisplay = `${promo.value}%`;
    } else if (promo.type === 'fixed') {
      typeLabel = 'Số tiền cố định';
      valueDisplay = formatCurrency(promo.value);
    } else {
      typeLabel = 'Mua X tặng Y';
      valueDisplay = `Mua ${promo.buy_quantity} tặng ${promo.get_quantity}`;
    }

    return `
      <div class="bg-white rounded-lg shadow border-l-4 ${statusClass} p-4">
        <div class="flex justify-between items-start">
          <div>
            <h3 class="font-semibold text-gray-900">${promo.name}</h3>
            <p class="text-sm text-gray-500">${typeLabel}: <strong>${valueDisplay}</strong></p>
            ${promo.min_order_value ? `<p class="text-xs text-gray-400">Đơn tối thiểu: ${formatCurrency(promo.min_order_value)}</p>` : ''}
            ${promo.max_discount ? `<p class="text-xs text-gray-400">Giảm tối đa: ${formatCurrency(promo.max_discount)}</p>` : ''}
          </div>
          <div class="flex items-center gap-2">
            <span class="px-2 py-1 text-xs rounded ${promo.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}">
              ${promo.active ? '✓ Hoạt động' : 'Tắt'}
            </span>
            ${promo.customer_tier && promo.customer_tier !== 'all' ? `
              <span class="px-2 py-1 text-xs rounded bg-yellow-100 text-yellow-700">
                ${promo.customer_tier.toUpperCase()}
              </span>
            ` : ''}
          </div>
        </div>
        <div class="mt-3 flex gap-2">
          <button onclick="PromotionsUI.showEditModal(${promo.id})"
                  class="text-blue-500 text-sm hover:underline">Sửa</button>
          <button onclick="PromotionsUI.togglePromotion(${promo.id}, ${!promo.active})"
                  class="text-gray-500 text-sm hover:underline">
            ${promo.active ? 'Tắt' : 'Bật'}
          </button>
        </div>
      </div>
    `;
  },

  /**
   * Show create/edit modal
   */
  showCreateModal() {
    this.showFormModal();
  },

  showEditModal(promoId) {
    // Load promo then show modal
    fetch(`/api/promotions/${promoId}`)
      .then(r => r.json())
      .then(data => this.showFormModal(data.data));
  },

  showFormModal(promo = null) {
    const isEdit = !!promo;
    const modal = document.createElement('div');
    modal.id = 'promoFormModal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4';
    modal.innerHTML = `
      <div class="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-auto">
        <h2 class="text-xl font-bold mb-4">${isEdit ? '✏️ Sửa khuyến mãi' : '🎁 Tạo khuyến mãi mới'}</h2>

        <form id="promoForm" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Tên khuyến mãi *</label>
            <input type="text" name="name" required
                   value="${promo?.name || ''}"
                   class="w-full px-3 py-2 border rounded-lg">
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Loại</label>
              <select name="type" class="w-full px-3 py-2 border rounded-lg">
                <option value="percentage" ${promo?.type === 'percentage' ? 'selected' : ''}>Phần trăm (%)</option>
                <option value="fixed" ${promo?.type === 'fixed' ? 'selected' : ''}>Số tiền cố định</option>
                <option value="buy_x_get_y" ${promo?.type === 'buy_x_get_y' ? 'selected' : ''}>Mua X tặng Y</option>
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Giá trị *</label>
              <input type="number" name="value" required
                     value="${promo?.value || ''}"
                     class="w-full px-3 py-2 border rounded-lg">
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Đơn tối thiểu</label>
              <input type="number" name="min_order_value"
                     value="${promo?.min_order_value || ''}"
                     placeholder="VD: 500000"
                     class="w-full px-3 py-2 border rounded-lg">
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Giảm tối đa</label>
              <input type="number" name="max_discount"
                     value="${promo?.max_discount || ''}"
                     placeholder="VD: 50000"
                     class="w-full px-3 py-2 border rounded-lg">
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Áp dụng cho</label>
            <select name="customer_tier" class="w-full px-3 py-2 border rounded-lg">
              <option value="all" ${promo?.customer_tier === 'all' || !promo ? 'selected' : ''}>Tất cả khách hàng</option>
              <option value="vip" ${promo?.customer_tier === 'vip' ? 'selected' : ''}>Chỉ VIP</option>
              <option value="normal" ${promo?.customer_tier === 'normal' ? 'selected' : ''}>Khách thường</option>
            </select>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Ngày bắt đầu</label>
              <input type="date" name="start_date"
                     value="${promo?.start_date || ''}"
                     class="w-full px-3 py-2 border rounded-lg">
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Ngày kết thúc</label>
              <input type="date" name="end_date"
                     value="${promo?.end_date || ''}"
                     class="w-full px-3 py-2 border rounded-lg">
            </div>
          </div>

          <div class="flex items-center gap-2">
            <input type="checkbox" name="active" id="promoActive"
                   ${promo?.active !== 0 ? 'checked' : ''}
                   class="w-5 h-5 text-blue-600 rounded">
            <label for="promoActive" class="text-sm text-gray-700">Hoạt động</label>
          </div>

          <div class="flex gap-3 pt-4">
            <button type="button" onclick="PromotionsUI.closeModal('promoFormModal')"
                    class="flex-1 bg-gray-200 text-gray-800 py-3 rounded-lg font-medium hover:bg-gray-300">
              Hủy
            </button>
            <button type="submit"
                    class="flex-1 bg-blue-500 text-white py-3 rounded-lg font-medium hover:bg-blue-600">
              ${isEdit ? 'Cập nhật' : 'Tạo mới'}
            </button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('promoForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = {
        name: form.name.value,
        type: form.type.value,
        value: parseFloat(form.value.value),
        min_order_value: form.min_order_value.value ? parseFloat(form.min_order_value.value) : null,
        max_discount: form.max_discount.value ? parseFloat(form.max_discount.value) : null,
        customer_tier: form.customer_tier.value,
        start_date: form.start_date.value || null,
        end_date: form.end_date.value || null,
        active: form.active.checked ? 1 : 0
      };

      try {
        const url = isEdit ? `/api/promotions/${promo.id}` : '/api/promotions';
        const method = isEdit ? 'PUT' : 'POST';

        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });

        const result = await res.json();
        if (result.success) {
          this.closeModal('promoFormModal');
          showToast(isEdit ? 'Đã cập nhật khuyến mãi' : 'Đã tạo khuyến mãi', 'success');
          if (typeof loadPromotions === 'function') loadPromotions();
        } else {
          alert(result.error || 'Có lỗi xảy ra');
        }
      } catch (err) {
        alert('Lỗi: ' + err.message);
      }
    });
  },

  /**
   * Toggle promotion active status
   */
  async togglePromotion(promoId, active) {
    try {
      const res = await fetch(`/api/promotions/${promoId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: active ? 1 : 0 })
      });
      const data = await res.json();
      if (data.success) {
        showToast(active ? 'Đã bật khuyến mãi' : 'Đã tắt khuyến mãi', 'success');
        if (typeof loadPromotions === 'function') loadPromotions();
      }
    } catch (e) {
      alert('Lỗi: ' + e.message);
    }
  },

  /**
   * Close modal
   */
  closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.remove();
  }
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    minimumFractionDigits: 0
  }).format(amount || 0);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg z-50 transform transition-all duration-300 ${
    type === 'success' ? 'bg-green-500 text-white' :
    type === 'error' ? 'bg-red-500 text-white' :
    'bg-blue-500 text-white'
  }`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Export for global access
window.DebtsUI = DebtsUI;
window.PromotionsUI = PromotionsUI;
window.formatCurrency = formatCurrency;
window.formatDate = formatDate;
window.showToast = showToast;
