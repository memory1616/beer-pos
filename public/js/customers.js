// Customers Page JavaScript — Performance Optimized
// filterCustomers already has 200ms debounce (line ~210).
// PERFORMANCE: add patchUpdateCustomer() for in-place DOM updates (no full re-render).
// PERFORMANCE: use CSS contain + will-change on customer list container.

// Patch a single customer card in-place when data changes
const _custCardMap = new Map(); // id → DOM element

function patchCustomerRow(customer) {
  const card = document.querySelector(`[data-customer-id="${customer.id}"]`);
  if (!card) return;
  const nameEl  = card.querySelector('.order-title');
  const kegEl   = card.querySelector('.customer-keg-box-num');
  const phoneEl  = card.querySelector('.customer-card-phone');
  if (nameEl)  nameEl.textContent  = customer.name;
  if (kegEl)   kegEl.textContent   = customer.keg_balance || 0;
  if (phoneEl)  phoneEl.textContent = '📱 ' + (customer.phone || 'Chưa có SĐT');
}

// ========== PHONE UTILITY ==========
// Normalize all phone formats to 0xxxxxxxxx
const Phone = {
  normalize(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let digits = raw.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('84')) {
      digits = '0' + digits.slice(2);
    } else if (digits.length === 12 && digits.startsWith('84')) {
      digits = '0' + digits.slice(2);
    }
    return digits;
  },
  format(normalized) {
    if (!normalized || normalized.length < 9) return normalized || '';
    const p = normalized.replace(/\D/g, '');
    if (p.length === 10) {
      return p.slice(0, 4) + ' ' + p.slice(4, 7) + ' ' + p.slice(7);
    }
    return normalized;
  },
  isValid(normalized) {
    const p = normalized || '';
    return /^0\d{9}$/.test(p);
  },
  findDuplicate(normalized) {
    if (!normalized || !Phone.isValid(normalized)) return null;
    const allCustomers = [...customers, ...archivedCustomers];
    const found = allCustomers.find(c => c.phone && Phone.normalize(c.phone) === normalized);
    return found ? found.name : null;
  },
  getDisplayValue(inputEl) {
    return Phone.format(Phone.normalize(inputEl.value));
  }
};

// ========== STEPPER ==========
function setupSteppers() {
  document.querySelectorAll('[data-action="increment"], [data-action="decrement"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const target = document.getElementById(targetId);
      if (!target) return;
      const min = parseInt(target.min) || 0;
      const max = parseInt(target.max) || Infinity;
      let val = parseInt(target.value) || 0;
      val += btn.dataset.action === 'increment' ? 1 : -1;
      val = Math.max(min, Math.min(max, val));
      target.value = val;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

// ========== KEYBOARD FLOW ==========
function setupKeyboardFlow() {
  const modal = document.getElementById('addModal');
  if (!modal) return;
  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const target = e.target;
    if (target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA' || target.type === 'submit' || target.type === 'checkbox') return;
    if (e.shiftKey) { e.preventDefault(); focusPreviousField(target); return; }
    e.preventDefault();
    focusNextField(target);
  });
}

function focusNextField(current) {
  const fields = getFormFields('addForm');
  const idx = fields.indexOf(current);
  if (idx >= 0 && idx < fields.length - 1) {
    const next = fields[idx + 1];
    next.focus();
    if (next.select) next.select();
  } else {
    submitAddForm();
  }
}

function focusPreviousField(current) {
  const fields = getFormFields('addForm');
  const idx = fields.indexOf(current);
  if (idx > 0) {
    const prev = fields[idx - 1];
    prev.focus();
    if (prev.select) prev.select();
  }
}

function getFormFields(formId) {
  const form = document.getElementById(formId);
  if (!form) return [];
  return Array.from(form.querySelectorAll(
    'input[data-field], select[data-field], textarea[data-field]'
  )).filter(el => !el.disabled && !el.closest('.hidden'));
}

// ========== PHONE DUPLICATE CHECK (debounced) ==========
let phoneCheckTimer = null;

function schedulePhoneCheck() {
  clearTimeout(phoneCheckTimer);
  const input = document.getElementById('addPhone');
  if (!input) return;
  phoneCheckTimer = setTimeout(() => {
    const raw = input.value || '';
    const normalized = Phone.normalize(raw);
    if (normalized.length >= 9) {
      const dupName = Phone.findDuplicate(normalized);
      const warningEl = document.getElementById('addPhoneWarning');
      const dupNameEl = document.getElementById('addPhoneDupName');
      if (dupName && !warningEl.classList.contains('shown')) {
        warningEl.classList.remove('hidden');
        warningEl.classList.add('shown');
        if (dupNameEl) dupNameEl.textContent = '→ ' + dupName;
        input.dataset.duplicateCustomer = dupName;
        input.style.borderColor = 'var(--color-warning)';
        input.style.boxShadow = '0 0 0 3px rgba(249,115,22,0.15)';
      } else if (!dupName) {
        clearPhoneWarning();
      }
    } else {
      clearPhoneWarning();
    }
  }, 600);
}

function clearPhoneWarning() {
  const warningEl = document.getElementById('addPhoneWarning');
  const input = document.getElementById('addPhone');
  if (warningEl) { warningEl.classList.add('hidden'); warningEl.classList.remove('shown'); }
  if (input) {
    delete input.dataset.duplicateCustomer;
    input.style.borderColor = '';
    input.style.boxShadow = '';
  }
}

// ========== FORM VALIDATION ==========
function validateAddForm() {
  var nameEl = document.getElementById('addName');
  var phoneEl = document.getElementById('addPhone');
  var name = nameEl ? nameEl.value.trim() : '';
  var phone = phoneEl ? phoneEl.value.trim() : '';
  if (!name) {
    showToast('Vui lòng nhập tên khách hàng', 'error');
    if (nameEl) nameEl.focus();
    return null;
  }
  if (phone) {
    var normalized = Phone.normalize(phone);
    if (!Phone.isValid(normalized)) {
      showToast('Số điện thoại không hợp lệ (cần 10 số, bắt đầu 0)', 'error');
      if (phoneEl) phoneEl.focus();
      return null;
    }
  }
  return { name, phone: Phone.normalize(phone) || null };
}

// ========== SUBMIT ADD FORM ==========
async function submitAddForm() {
  clearTimeout(phoneCheckTimer);
  const validation = validateAddForm();
  if (!validation) return;

  const name = validation.name;
  const phone = validation.phone;
  const addPhoneInput = document.getElementById('addPhone');
  const existingCustomer = addPhoneInput ? addPhoneInput.dataset.duplicateCustomer : null;

  if (existingCustomer && phone) {
    if (!confirm('SĐT đã tồn tại: "' + existingCustomer + '"\n\nBạn muốn cập nhật khách này thay vì tạo mới?')) {
      return;
    }
  }

  var data = { name: name, phone: phone };
  var addDepositEl = document.getElementById('addDeposit');
  var addHorizontalFridgeEl = document.getElementById('addHorizontalFridge');
  var addVerticalFridgeEl = document.getElementById('addVerticalFridge');
  data.deposit = parseFormattedNumber(addDepositEl ? addDepositEl.value : '0');
  data.horizontal_fridge = parseInt(addHorizontalFridgeEl ? addHorizontalFridgeEl.value : '0') || 0;
  data.vertical_fridge = parseInt(addVerticalFridgeEl ? addVerticalFridgeEl.value : '0') || 0;

  const prices = {};
  document.querySelectorAll('#addPriceList input[data-product]').forEach(input => {
    const raw = input.value.replace(/,/g, '');
    const price = parseFloat(raw);
    if (!isNaN(price) && price > 0) prices[input.dataset.product] = price;
  });
  if (Object.keys(prices).length > 0) data.prices = prices;

  const btn = document.querySelector('[onclick="submitAddForm()"]');
  var btnState = btn ? setButtonLoading(btn) : null;

  try {
    var res = await fetch('/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      cache: 'no-store'
    });
    var result;
    try { result = await res.json(); } catch (_) { result = {}; }
    if (!res.ok) throw new Error(result.error || 'Thêm khách hàng thất bại');
    showToast('Đã thêm khách hàng thành công!', 'success');
    hideModal('addModal');
    resetAddForm();
    await loadPageData(currentTab);
  } catch (err) {
    // silenced
    showToast('Lỗi khi thêm khách hàng', 'error');
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

function resetAddForm() {
  var nameEl = document.getElementById('addName');
  var phoneEl = document.getElementById('addPhone');
  var depositEl = document.getElementById('addDeposit');
  var hfEl = document.getElementById('addHorizontalFridge');
  var vfEl = document.getElementById('addVerticalFridge');
  if (nameEl) nameEl.value = '';
  if (phoneEl) phoneEl.value = '';
  if (depositEl) {
    depositEl.value = '0';
    formatNumberInput(depositEl, true);
  }
  if (hfEl) hfEl.value = 0;
  if (vfEl) vfEl.value = 0;
  clearPhoneWarning();
  var pf = document.getElementById('addPriceFields');
  if (pf && !pf.classList.contains('hidden')) pf.classList.add('hidden');
  var tb = document.getElementById('togglePriceBtn');
  if (tb) tb.textContent = '+ Thêm giá';
  addProductsLoaded = false;
}

function formatVND(amount) {
  if (amount === null || amount === undefined || amount === '') return '0 đ';
  const num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

// PERFORMANCE: Extract card rendering to separate function for virtual scroll
function renderCustomerCard(c) {
  const hasLocation = c.lat && c.lng;
  const hFridge = c.horizontal_fridge || 0;
  const vFridge = c.vertical_fridge || 0;

  let statusDotClass = 'customer-status-dot--muted';
  if (currentTab === 'active') {
    if (c.days_since_last_order !== null && c.days_since_last_order !== undefined) {
      if (c.days_since_last_order >= 7) {
        statusDotClass = 'customer-status-dot--danger';
      } else if (c.daily_avg < 5) {
        statusDotClass = 'customer-status-dot--warning';
      } else {
        statusDotClass = 'customer-status-dot--success';
      }
    } else {
      statusDotClass = 'customer-status-dot--warning';
    }
  }

  const volumeLine = c.monthly_liters > 0
    ? `<div class="customer-card-volume">📈 ${c.monthly_liters} bình/tháng</div>`
    : '';

  const actionsBlock = currentTab === 'active' ? `
        <div class="order-actions customer-card-actions">
          <button type="button" onclick="getLocation(${c.id})" class="btn btn-ghost btn-sm">📍 GPS</button>
          <button type="button" onclick="editCustomer(${c.id}, '${String(c.name).replace(/'/g, "\\'")}', '${String(c.phone || '').replace(/'/g, "\\'")}', ${c.deposit})" class="btn btn-ghost btn-sm">✏️ Sửa</button>
          <button type="button" onclick="showPriceModal(${c.id}, '${String(c.name).replace(/'/g, "\\'")}')" class="btn btn-ghost btn-sm">💰 Giá</button>
          <button type="button" onclick="archiveCustomer(${c.id})" class="btn btn-ghost btn-sm" title="Lưu trữ">📦</button>
        </div>
        ` : `
        <div class="order-actions customer-card-actions">
          <button type="button" onclick="unarchiveCustomer(${c.id})" class="btn btn-ghost btn-sm">📤 Khôi phục</button>
          <button type="button" onclick="deleteCustomer(${c.id})" class="btn btn-danger btn-sm">🗑️ Xóa</button>
        </div>
        `;

  return `
    <div class="order-item ${c.archived ? 'opacity-70' : ''}" data-customer-id="${c.id}" data-name="${c.name.toLowerCase()}">
      <div class="customer-card-head">
        <div class="customer-card-info">
          <div class="customer-card-name-row">
            <a href="/customers/${c.id}" class="order-title hover:text-primary">${c.name}</a>
            <span class="customer-status-dot ${statusDotClass}" title="Trạng thái mua hàng"></span>
          </div>
          <div class="customer-card-phone">📱 ${c.phone || 'Chưa có SĐT'}</div>
          ${volumeLine}
        </div>
        <div class="customer-card-keg-panel">
          <div class="customer-keg-box">
            <span class="customer-keg-box-icon">📦</span>
            <span class="customer-keg-box-num">${c.keg_balance || 0}</span>
            <span class="customer-keg-box-unit">vỏ</span>
          </div>
          <div class="customer-fridge-mini">
            <span title="Tủ lạnh nằm">❄️ Tủ Nằm ${hFridge}</span>
            <span title="Tủ mát đứng">🥶 Tủ Đứng ${vFridge}</span>
          </div>
        </div>
      </div>

      ${actionsBlock}

      <div class="customer-card-deposit-row">
        <div class="flex items-center gap-2 flex-wrap min-w-0">
          <span class="deposit-label">💵 Đặt cọc:</span>
          <span class="deposit-amount ${c.deposit > 0 ? '' : 'text-muted'}">${formatVND(c.deposit)}</span>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          ${currentTab === 'active' ? `
          <button type="button" onclick='editKegBalance(${c.id}, ${c.keg_balance || 0}, ${JSON.stringify(c.name)})' class="text-xs text-info font-semibold hover:underline px-1 py-0.5 bg-transparent border-0 cursor-pointer">✏️ Sửa vỏ</button>
          ` : ''}
          ${hasLocation ? '<span class="text-success text-xs" title="Đã có vị trí">✅</span>' : ''}
        </div>
      </div>
      ${c.last_sale_date ? '<div class="customer-card-last">🕐 Mua lần cuối: ' + new Date(c.last_sale_date).toLocaleDateString('vi-VN') + '</div>' : ''}
      ${c.archived ? '<div class="customer-card-last">📦 Đã lưu trữ</div>' : ''}
    </div>`;
}

// Toast notification
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  const bgClass = type === 'success' ? 'bg-success' : (type === 'error' ? 'bg-danger' : 'bg-info');
  toast.className = `fixed top-4 right-4 ${bgClass} text-main px-6 py-3 rounded-lg shadow-lg z-50 transform transition-all duration-300 translate-x-full`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.remove('translate-x-full'), 100);
  setTimeout(() => {
    toast.classList.add('translate-x-full');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ========== PAGINATION STATE ==========
let customers = [];
let archivedCustomers = [];
let currentTab = 'active';
let products = [];

// For server-side pagination
let custPagination = {
  page: 1,
  limit: 5,
  total: 0,
  totalPages: 0
};

// Search debounce
let searchTimeout = null;

function initCustomersPage(data) {
  if (data.customers) {
    customers = data.customers;
    window.store.customers = customers;
  }
  if (data.archived) archivedCustomers = data.archived;
  if (products.length === 0 && data.products) products = data.products;

  // Update pagination state from API response
  if (data.page !== undefined) {
    custPagination.page = data.page;
    custPagination.limit = data.limit;
    custPagination.total = data.total;
    custPagination.totalPages = data.totalPages;
  }

  updateCount();
  renderCustomers();
  renderPagination();
}

function updateCount() {
  const countEl = document.getElementById('customerCount');
  if (!countEl) return;
  countEl.textContent = custPagination.total;
}

function switchCustomerTab(tab) {
  currentTab = tab;
  custPagination.page = 1; // Reset to first page on tab switch

  var tabActive = document.getElementById('tabActive');
  var tabArchived = document.getElementById('tabArchived');
  var archivedSection = document.getElementById('archivedSection');

  if (tab === 'active') {
    if (tabActive) tabActive.className = 'btn btn-primary flex-1 h-11 text-sm rounded-xl shadow';
    if (tabArchived) tabArchived.className = 'btn btn-ghost flex-1 h-11 text-sm rounded-xl shadow';
    if (archivedSection) archivedSection.classList.add('hidden');
  } else {
    if (tabActive) tabActive.className = 'btn btn-ghost flex-1 h-11 text-sm rounded-xl shadow';
    if (tabArchived) tabArchived.className = 'btn btn-secondary flex-1 h-11 text-sm rounded-xl shadow';
    if (archivedSection) archivedSection.classList.remove('hidden');
  }

  loadPageData(tab);
}

async function loadPageData(tab) {
  try {
    const params = new URLSearchParams({ page: custPagination.page, limit: custPagination.limit, tab: tab });
    const res = await fetch('/customers/data?' + params.toString(), { cache: 'no-store' });
    const data = await res.json();

    if (tab === 'active') {
      customers = data.customers || [];
    } else {
      archivedCustomers = data.archived || [];
    }

    // Update pagination state
    custPagination.total = data.total || 0;
    custPagination.totalPages = data.totalPages || 0;

    updateCount();
    renderCustomers();
    renderPagination();
  } catch (err) {
    // silenced
  }
}

function renderCustomers() {
  const container = document.getElementById('customersList');
  if (!container) return;

  const searchInput = document.getElementById('searchInput');
  const search = searchInput ? searchInput.value.toLowerCase().trim() : '';

  const source = currentTab === 'active' ? customers : archivedCustomers;
  const filtered = source.filter(c => {
    if (!search) return true;
    const nameMatch = c.name && c.name.toLowerCase().includes(search);
    const phoneMatch = c.phone && (c.phone.includes(search) || Phone.normalize(c.phone).includes(search.replace(/\s/g, '')));
    return nameMatch || phoneMatch;
  });

  if (filtered.length === 0) {
    var noCustomerMsg = search
      ? '<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-title">Không tìm thấy khách hàng</div><div class="empty-state-desc">Thử từ khóa khác hoặc xóa bộ lọc</div></div>'
      : '<div class="empty-state"><div class="empty-state-icon">👤</div><div class="empty-state-title">Chưa có khách hàng nào</div><div class="empty-state-desc">Nhấn <strong>+</strong> để thêm khách hàng đầu tiên</div></div>';
    container.innerHTML = noCustomerMsg;
    return;
  }

  container.innerHTML = filtered.map(renderCustomerCard).join('');

  // Cache DOM refs for patchCustomerRow
  _custCardMap.clear();
  for (const c of filtered) {
    const el = document.querySelector(`[data-customer-id="${c.id}"]`);
    if (el) _custCardMap.set(c.id, el);
  }
}

// ========== PAGINATION CONTROLS ==========
function renderPagination() {
  const container = document.getElementById('customersList');
  if (!container) return;
  const { page, totalPages, total } = custPagination;

  // Remove old pagination nav if exists
  var oldNav = container.querySelector('nav[role="navigation"]');
  var oldTotal = container.querySelector('.history-total-row');
  if (oldNav) oldNav.remove();
  if (oldTotal) oldTotal.remove();

  if (totalPages <= 1) {
    if (total > 0) {
      container.insertAdjacentHTML('beforeend',
        '<div class="history-total-row text-center text-xs text-muted mt-3 pt-2 border-t border-muted/70">Tổng ' + total + ' khách</div>'
      );
    }
    return;
  }

  const prevD = page === 1;
  const nextD = page === totalPages;

  container.insertAdjacentHTML('beforeend',
    `<nav class="flex items-center justify-center gap-3 mt-4 pt-3 border-t border-muted" role="navigation" aria-label="Phân trang">
      <button onclick="changeCustPage(${page - 1})" ${prevD ? 'disabled' : ''}
        class="min-w-[44px] min-h-[44px] w-11 h-11 rounded-full flex items-center justify-center text-base font-semibold transition-all
          ${prevD ? 'border border-muted/30 bg-bg text-muted cursor-not-allowed opacity-50 pointer-events-none' : 'border border-muted shadow-sm text-main hover:bg-bg-hover active:scale-90'}"
        aria-label="Trang trước" aria-disabled="${prevD}">
        ‹
      </button>
      <div class="flex flex-col justify-center items-center min-w-[4.5rem]">
        <span class="text-sm font-bold text-main tabular-nums leading-tight">${page} / ${totalPages}</span>
        <span class="text-[11px] text-muted leading-tight mt-0.5">${total} khách</span>
      </div>
      <button onclick="changeCustPage(${page + 1})" ${nextD ? 'disabled' : ''}
        class="min-w-[44px] min-h-[44px] w-11 h-11 rounded-full flex items-center justify-center text-base font-semibold transition-all
          ${nextD ? 'border border-muted/30 bg-bg text-muted cursor-not-allowed opacity-50 pointer-events-none' : 'border border-muted shadow-sm text-main hover:bg-bg-hover active:scale-90'}"
        aria-label="Trang sau" aria-disabled="${nextD}">
        ›
      </button>
    </nav>`
  );
}

function changeCustPage(newPage) {
  if (newPage < 1 || newPage > custPagination.totalPages) return;
  custPagination.page = newPage;
  loadPageData(currentTab);
  var anchor = document.getElementById('customersList');
  if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ========== SHOW/HIDE MODALS ==========
function showModal(id) {
  var m = document.getElementById(id);
  if (!m) { console.warn("[UI] Modal not found:", id); return; }
  m.classList.remove('hidden');
  m.classList.add('flex');

  // Initialize add form when opened
  if (id === 'addModal') {
    initAddForm();
  }
}

function initAddForm() {
  // Autofocus on name field
  setTimeout(() => {
    const nameEl = document.getElementById('addName');
    if (nameEl) { nameEl.focus(); }
  }, 150);

  // Format deposit input
  const depEl = document.getElementById('addDeposit');
  if (depEl) { formatNumberInput(depEl, true); }

  // Setup steppers if not already
  setupSteppers();

  // Setup keyboard flow
  setupKeyboardFlow();

  // Auto-jump: name field contains only digits → move to phone
  const nameInput = document.getElementById('addName');
  if (nameInput) {
    nameInput.addEventListener('input', () => {
      const val = nameInput.value.trim();
      if (/^\d+$/.test(val) && val.length >= 7) {
        focusNextField(nameInput);
      }
    });
  }

  // Phone input listener — trigger duplicate check on input
  const phoneInput = document.getElementById('addPhone');
  if (phoneInput) {
    phoneInput.addEventListener('input', schedulePhoneCheck);
    phoneInput.addEventListener('blur', () => {
      // Format on blur: show display format if valid
      const raw = phoneInput.value || '';
      const normalized = Phone.normalize(raw);
      if (Phone.isValid(normalized)) {
        phoneInput.value = Phone.format(normalized);
      }
    });
  }

  // Clear any previous warning
  clearPhoneWarning();
}

function hideModal(id) {
  var m = document.getElementById(id);
  if (!m) { console.warn("[UI] Modal not found:", id); return; }
  m.classList.add('hidden');
  m.classList.remove('flex');
}

async function softRefreshCustomers() {
  await loadPageData(currentTab);
}

async function saveKegBalance() {
  var kegCustomerIdEl = document.getElementById('kegCustomerId');
  var kegBalanceInputEl = document.getElementById('kegBalanceInput');
  var kegNoteEl = document.getElementById('kegNote');
  if (!kegCustomerIdEl || !kegBalanceInputEl) return;

  var customerId = kegCustomerIdEl.value;
  var newBalance = parseInt(kegBalanceInputEl.value);
  var note = kegNoteEl ? kegNoteEl.value : '';

  if (isNaN(newBalance) || newBalance < 0) {
    alert('Số bình không hợp lệ!');
    return;
  }

  var btn = document.querySelector('[onclick="saveKegBalance()"]');
  var btnState = btn ? setButtonLoading(btn) : null;

  try {
    var res = await fetch('/api/payments/keg/update-balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: parseInt(customerId), balance: newBalance, note: note }),
      cache: 'no-store'
    });
    var data;
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) throw new Error(data.error || 'Cập nhật thất bại');
    alert('Cập nhật vỏ thành công!\n\nSố vỏ còn tại quán: ' + newBalance);
    hideModal('kegModal');
    var idx = customers.findIndex(function(c) { return String(c.id) === String(customerId); });
    if (idx !== -1) {
      customers[idx].keg_balance = newBalance;
      window.store.customers = customers;
      patchCustomerRow(customers[idx]);
    }
  } catch (err) {
    // silenced
    await softRefreshCustomers();
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

function filterCustomers() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const searchInput = document.getElementById('searchInput');
    const search = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const source = currentTab === 'active' ? customers : archivedCustomers;
    const filtered = source.filter(c => {
      if (!search) return true;
      const nameMatch = c.name && c.name.toLowerCase().includes(search);
      const phoneMatch = c.phone && (c.phone.includes(search) || Phone.normalize(c.phone).includes(search.replace(/\s/g, '')));
      return nameMatch || phoneMatch;
    });

    // Update pagination for filtered results
    custPagination.page = 1;
    custPagination.total = filtered.length;
    custPagination.totalPages = 1;

    const container = document.getElementById('customersList');
    if (!container) return;

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-title">Không tìm thấy khách hàng</div><div class="empty-state-desc">Thử từ khóa khác hoặc xóa bộ lọc</div></div>';
    } else {
      container.innerHTML = filtered.map(renderCustomerCard).join('');
    }

    renderPagination();
  }, 200);
}

function editCustomer(id, name, phone, deposit) {
  var editIdEl = document.getElementById('editId');
  var editNameEl = document.getElementById('editName');
  var editPhoneEl = document.getElementById('editPhone');
  var depEl = document.getElementById('editDeposit');
  var hfEl = document.getElementById('editHorizontalFridge');
  var vfEl = document.getElementById('editVerticalFridge');
  var exEl = document.getElementById('editExcludeExpected');
  if (!editIdEl || !editNameEl || !editPhoneEl || !depEl) return;

  editIdEl.value = id;
  editNameEl.value = name;
  editPhoneEl.value = phone || '';
  depEl.value = deposit != null ? String(deposit) : '0';
  if (typeof formatNumberInput === 'function') {
    formatNumberInput(depEl, true);
  }

  // Load fridge counts and exclude_expected
  fetch('/api/customers/' + id)
    .then(res => res.json())
    .then(data => {
      if (hfEl) hfEl.value = data.horizontal_fridge || 0;
      if (vfEl) vfEl.value = data.vertical_fridge || 0;
      if (exEl) exEl.checked = data.exclude_expected === 1;
    });

  showModal('editModal');

  // Auto focus vào Tên sau khi modal mở
  setTimeout(() => {
    if (editNameEl) { editNameEl.focus(); editNameEl.select(); }
  }, 150);
}

// Nút + / − cho số lượng tủ
function adjustQty(inputId, delta) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const min = parseInt(input.min) || 0;
  let val = parseInt(input.value) || 0;
  val = Math.max(min, val + delta);
  input.value = val;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// Giữ input không âm
function clampQty(input, _min) {
  if (parseInt(input.value) < 0) input.value = 0;
}

async function saveCustomerEdit() {
  var editIdEl = document.getElementById('editId');
  var editNameEl = document.getElementById('editName');
  var editPhoneEl = document.getElementById('editPhone');
  var editDepositEl = document.getElementById('editDeposit');
  var editHfEl = document.getElementById('editHorizontalFridge');
  var editVfEl = document.getElementById('editVerticalFridge');
  var editExEl = document.getElementById('editExcludeExpected');

  if (!editIdEl) { alert('Lỗi: Không tìm thấy ID khách hàng'); return; }
  var id = editIdEl.value;
  var name = editNameEl ? editNameEl.value : '';
  var phone = editPhoneEl ? editPhoneEl.value : '' || null;
  var deposit = editDepositEl ? parseFormattedNumber(editDepositEl.value) : 0;
  var horizontal_fridge = editHfEl ? (parseInt(editHfEl.value) || 0) : 0;
  var vertical_fridge = editVfEl ? (parseInt(editVfEl.value) || 0) : 0;
  var exclude_expected = editExEl && editExEl.checked ? 1 : 0;

  if (!id) {
    alert('Lỗi: Không tìm thấy ID khách hàng');
    return;
  }

  if (!name || name.trim() === '') {
    alert('Vui lòng nhập tên khách hàng');
    return;
  }

  var submitBtn = document.getElementById('editForm')?.querySelector('[type="submit"]');
  var btnState = submitBtn ? setButtonLoading(submitBtn) : null;

  try {
    var res = await fetch('/api/customers/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, deposit, horizontal_fridge, vertical_fridge, exclude_expected }),
      cache: 'no-store'
    });
    var result;
    try { result = await res.json(); } catch (_) { result = {}; }
    if (!res.ok) throw new Error(result.error || 'Cập nhật thất bại');
    hideModal('editModal');
    var updated = result.customer || result;
    var idx = customers.findIndex(function(c) { return String(c.id) === String(updated.id); });
    if (idx !== -1) {
      Object.assign(customers[idx], updated);
      window.store.customers = customers;
      patchCustomerRow(updated);
    }
  } catch (err) {
    // silenced
    await softRefreshCustomers();
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

function showPriceModal(id, name) {
  var priceCustomerNameEl = document.getElementById('priceCustomerName');
  var priceListEl = document.getElementById('priceList');
  if (!priceCustomerNameEl || !priceListEl) return;
  priceCustomerNameEl.textContent = name;
  priceListEl.innerHTML = '<div class="text-muted text-center py-4">Đang tải sản phẩm...</div>';

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
    var productPrices = {};
    existingPrices.forEach(p => {
      productPrices[p.product_id] = p.price;
    });

    var container = document.getElementById('priceList');
    if (!container) return;
    if (products.length === 0) {
      container.innerHTML = '<div class="text-muted text-center py-4">Chưa có sản phẩm nào</div>';
      return;
    }

    var html = '';
    products.forEach(p => {
      var price = productPrices[p.id] || '';
      html += '<div class="flex justify-between items-center py-2 border-b">' +
        '<div class="font-medium">' + p.name + '</div>' +
        '<input type="text" data-product="' + p.id + '" value="' + price + '" data-format-number inputmode="decimal" ' +
        'class="border p-2 w-28 rounded text-right" placeholder="Giá">' +
      '</div>';
    });
    container.innerHTML = html;
    window.currentPriceCustomerId = id;

    // Initialize number format for new inputs
    if (typeof initAllNumberFormats === 'function') initAllNumberFormats();
  }).catch(err => {
    // silenced
    var plEl = document.getElementById('priceList');
    if (plEl) plEl.innerHTML = '<div class="text-danger text-center py-4">Lỗi tải dữ liệu: ' + err.message + '</div>';
  });

  showModal('priceModal');
}

async function savePrices() {
  var customerId = window.currentPriceCustomerId;
  if (!customerId) return;

  var inputs = document.querySelectorAll('#priceList input');
  var prices = [];

  inputs.forEach(function(i) {
    var rawValue = i.value.replace(/,/g, '');
    var price = parseFloat(rawValue);
    if (!isNaN(price)) {
      prices.push({
        product_id: parseInt(i.dataset.product),
        price: price
      });
    }
  });

  var btn = document.querySelector('[onclick="savePrices()"]');
  var btnState = btn ? setButtonLoading(btn) : null;

  try {
    var res = await fetch('/api/products/prices/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: customerId, prices: prices }),
      cache: 'no-store'
    });
    var data;
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) throw new Error(data.error || 'Lưu bảng giá thất bại');
    alert('Đã lưu bảng giá!');
    hideModal('priceModal');
  } catch (err) {
    // silenced
    await softRefreshCustomers();
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

let addProductsLoaded = false;
function toggleAddPrices() {
  var priceFields = document.getElementById('addPriceFields');
  var toggleBtn = document.getElementById('togglePriceBtnWrapper');
  if (!priceFields) return;

  if (priceFields.classList.contains('hidden')) {
    priceFields.classList.remove('hidden');
    if (toggleBtn) {
      toggleBtn.classList.add('open');
    }
    if (!addProductsLoaded) loadAddProducts();
  } else {
    priceFields.classList.add('hidden');
    if (toggleBtn) {
      toggleBtn.classList.remove('open');
    }
  }
}

async function loadAddProducts() {
  try {
    const res = await fetch('/api/products');
    if (!res.ok) throw new Error('Failed to load products');
    const products = await res.json();
    
    var container = document.getElementById('addPriceList');
    if (!container) return;
    if (products.length === 0) {
      container.innerHTML = '<div class="text-muted text-sm text-center py-2">Chưa có sản phẩm nào</div>';
    } else {
      container.innerHTML = products.map(p =>
        '<div class="add-price-item">' +
          '<span class="add-price-name">' + p.name + '</span>' +
          '<input type="text" name="price_' + p.id + '" data-product="' + p.id + '" data-format-number inputmode="decimal" ' +
            'class="add-price-input" placeholder="Giá">' +
        '</div>'
      ).join('');
      addProductsLoaded = true;
      initAllNumberFormats();
    }
  } catch (e) {
    // silenced
  }
}

// addForm submit is now handled by submitAddForm() via button onclick
// Keep Enter key handling via keyboard flow setup in initAddForm

(function() {
  var form = document.getElementById('editForm');
  if (form) form.addEventListener('submit', function(e) {
    e.preventDefault();
    saveCustomerEdit();
  });
})();

async function archiveCustomer(id) {
  var customer = customers.find(c => c.id === id);
  if (!customer) customer = archivedCustomers.find(c => c.id === id);
  if (!customer) return;

  // Show archive modal with keg input
  document.getElementById('archiveCustomerId').value = id;
  document.getElementById('archiveCustomerName').textContent = customer.name;
  document.getElementById('archiveKegCount').textContent = customer.keg_balance || 0;
  document.getElementById('archiveKegsCollect').value = customer.keg_balance || 0;
  document.getElementById('archiveKegsCollect').max = customer.keg_balance || 0;
  updateArchiveKegNote();
  openModal('archiveModal');
}

function updateArchiveKegNote() {
  var total = parseInt(document.getElementById('archiveKegCount').textContent) || 0;
  var collect = parseInt(document.getElementById('archiveKegsCollect').value) || 0;
  var lost = Math.max(0, total - collect);
  var noteEl = document.getElementById('archiveKegNote');
  if (noteEl) {
    if (lost > 0) {
      noteEl.innerHTML = '<span class="text-danger">→ <span class="font-bold">' + lost + '</span> vỏ sẽ tính vào vỏ mất</span>';
    } else {
      noteEl.textContent = '';
    }
  }
}

// Listen for kegs input change
document.addEventListener('DOMContentLoaded', function() {
  var kegCollectInput = document.getElementById('archiveKegsCollect');
  if (kegCollectInput) {
    kegCollectInput.addEventListener('input', updateArchiveKegNote);
  }
});

async function submitArchiveCustomer() {
  var id = parseInt(document.getElementById('archiveCustomerId').value);
  var kegsToCollect = parseInt(document.getElementById('archiveKegsCollect').value) || 0;

  if (!confirm('Lưu trữ khách hàng này?\n\n- Khách sẽ không hiển thị khi bán hàng\n- Doanh thu vẫn giữ nguyên')) return;

  var btn = event.target;
  var originalText = btn.textContent;
  btn.textContent = 'Đang xử lý...';
  btn.disabled = true;

  try {
    var res = await fetch('/api/customers/' + id + '/archive', {
      method: 'PUT',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectKegs: kegsToCollect })
    });
    var data;
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) throw new Error(data.error || 'Lưu trữ thất bại');
    showToast('Đã lưu trữ khách hàng!', 'success');
    hideModal('archiveModal');
    await loadPageData(currentTab);
  } catch (err) {
    showToast(err.message || 'Lưu trữ thất bại', 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function unarchiveCustomer(id) {
  if (!confirm('Khôi phục khách hàng này?')) return;

  var btn = document.querySelector('[onclick="unarchiveCustomer(' + id + ')"]');
  var btnState = btn ? setButtonLoading(btn) : null;

  try {
    var res = await fetch('/api/customers/' + id + '/archive', { method: 'PUT', cache: 'no-store' });
    var data;
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) throw new Error(data.error || 'Khôi phục thất bại');
    showToast('Đã khôi phục khách hàng!', 'success');
    await loadPageData(currentTab);
  } catch (err) {
    // silenced
    await softRefreshCustomers();
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

async function deleteCustomer(id) {
  if (!confirm('XÓA VĨNH VIỄN khách hàng này?\n\nTất cả dữ liệu (đơn hàng, công nợ...) sẽ bị mất!\n\nKhuyến nghị: Nên dùng "Lưu trữ" thay vì xóa.')) return;

  var btn = document.querySelector('[onclick="deleteCustomer(' + id + ')"]');
  var btnState = btn ? setButtonLoading(btn) : null;

  try {
    var res = await fetch('/api/customers/' + id, { method: 'DELETE', cache: 'no-store' });
    var data;
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) throw new Error(data.error || 'Xóa thất bại');
    alert('Đã xóa khách hàng!');
    await loadPageData(currentTab);
  } catch (err) {
    // silenced
    await softRefreshCustomers();
  } finally {
    if (btnState) restoreButtonLoading(btnState);
  }
}

function getLocation(customerId) {
  // Find the customer data to check if GPS already exists
  var customer = customers.find(c => c.id === customerId) || archivedCustomers.find(c => c.id === customerId);
  var hasExistingGPS = customer && customer.lat && customer.lng;

  var locationCustomerIdEl = document.getElementById('locationCustomerId');
  var manualLatEl = document.getElementById('manualLat');
  var manualLngEl = document.getElementById('manualLng');
  var gpsStatusEl = document.getElementById('gpsStatus');
  var detectedAddressEl = document.getElementById('detectedAddress');
  var existingGPSInfoEl = document.getElementById('existingGPSInfo');
  var updateGPSSectionEl = document.getElementById('updateGPSSection');
  if (!locationCustomerIdEl || !manualLatEl || !manualLngEl) return;

  locationCustomerIdEl.value = customerId;
  manualLatEl.value = '';
  manualLngEl.value = '';
  if (gpsStatusEl) gpsStatusEl.innerHTML = '';
  if (detectedAddressEl) detectedAddressEl.innerHTML = '';
  if (existingGPSInfoEl) existingGPSInfoEl.innerHTML = '';
  if (updateGPSSectionEl) updateGPSSectionEl.classList.add('hidden');
  window.detectedAddress = null;
  showModal('locationModal');

  if (hasExistingGPS) {
    // Customer already has GPS — show existing info, don't auto-update
    if (existingGPSInfoEl) existingGPSInfoEl.innerHTML = `
      <div class="card p-3 mb-3">
        <div class="flex items-center gap-2 mb-2">
          <span class="badge badge-success">✅ Đã có vị trí</span>
        </div>
        <div class="text-xs text-muted mb-1">📍 ${customer.lat.toFixed(6)}, ${customer.lng.toFixed(6)}</div>
        ${customer.address ? '<div class="text-xs text-muted">' + customer.address + '</div>' : ''}
      </div>
    `;
    if (manualLatEl) manualLatEl.value = customer.lat.toFixed(6);
    if (manualLngEl) manualLngEl.value = customer.lng.toFixed(6);
    if (updateGPSSectionEl) updateGPSSectionEl.classList.remove('hidden');
  } else {
    // No GPS yet — auto-trigger GPS acquisition
    setTimeout(() => {
      if (navigator.geolocation) {
        getGPSLocation();
      }
    }, 500);
  }
}

function getGPSLocation() {
  var customerIdEl = document.getElementById('locationCustomerId');
  var statusEl = document.getElementById('gpsStatus');
  var addressEl = document.getElementById('detectedAddress');
  var manualLatEl = document.getElementById('manualLat');
  var manualLngEl = document.getElementById('manualLng');

  if (!statusEl) return;
  if (!navigator.geolocation) {
    statusEl.innerHTML = '<p class="text-danger">❌ Trình duyệt không hỗ trợ lấy vị trí</p><p class="text-sm text-muted">Vui lòng nhập thủ công</p>';
    return;
  }

  // Show loading
  statusEl.innerHTML = `
    <div class="animate-pulse">
      <p class="text-info">⏳ Đang lấy vị trí GPS...</p>
      <p class="text-xs text-muted">⏱ Chờ quyền truy cập...</p>
    </div>
    <button onclick="getGPSLocation()" class="mt-2 text-sm text-warning hover:text-warning font-medium underline">
      Thử lại
    </button>
  `;

  var options = {
    enableHighAccuracy: true,
    timeout: 20000,
    maximumAge: 0
  };

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      var lat = position.coords.latitude;
      var lng = position.coords.longitude;
      var accuracy = Math.round(position.coords.accuracy);

      // Display accuracy
      var accuracyText = '';
      if (accuracy <= 10) {
        accuracyText = '<span class="text-success">Rất tốt (≤10m)</span>';
      } else if (accuracy <= 50) {
        accuracyText = '<span class="text-success">Tốt (≤50m)</span>';
      } else if (accuracy <= 100) {
        accuracyText = '<span class="text-warning">Trung bình (≤100m)</span>';
      } else {
        accuracyText = '<span class="text-danger">Kém (>100m)</span>';
      }

      statusEl.innerHTML = '<p class="text-success">✅ Đã lấy được vị trí!</p>' +
        '<p class="text-sm text-muted">Độ chính xác: ' + accuracyText + '</p>' +
        '<p class="text-xs text-muted">Tọa độ: ' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '</p>';

      // Fill in the coordinates
      if (manualLatEl) manualLatEl.value = lat.toFixed(6);
      if (manualLngEl) manualLngEl.value = lng.toFixed(6);

      // Try reverse geocoding to get address
      if (addressEl) {
        addressEl.innerHTML = '<p class="text-info">⏳ Đang lấy địa chỉ...</p>';
        try {
          var res = await fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json');
          var data = await res.json();

          if (data.display_name) {
            addressEl.innerHTML = '<p class="text-sm text-main">📍 ' + data.display_name + '</p>' +
              '<button onclick="useDetectedAddress(\'' + data.display_name.replace(/'/g, "\\'") + '\')" class="mt-2 text-xs btn btn-secondary btn-sm">' +
              'Sử dụng địa chỉ này' +
              '</button>';
            window.detectedAddress = data.display_name;
          }
        } catch (err) {
          // silenced
          addressEl.innerHTML = '<p class="text-muted">Không thể lấy địa chỉ</p>';
        }
      }
    },
    (error) => {
      var errorMsg = 'Lỗi không xác định';
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
      statusEl.innerHTML = '<p class="text-danger font-medium">' + errorMsg + '</p>' +
        '<p class="text-sm text-muted mt-1">Vui lòng nhập thủ công hoặc thử lại</p>' +
        '<button onclick="getGPSLocation()" class="mt-3 px-4 py-2 btn btn-warning text-sm">📍 Thử lại</button>';
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
  var customerIdEl = document.getElementById('locationCustomerId');
  var manualLatEl = document.getElementById('manualLat');
  var manualLngEl = document.getElementById('manualLng');
  if (!customerIdEl || !manualLatEl || !manualLngEl) return;

  var customerId = customerIdEl.value;
  var lat = parseFloat(manualLatEl.value);
  var lng = parseFloat(manualLngEl.value);
  var address = window.detectedAddress || null;

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
    var res = await fetch('/api/customers/location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: parseInt(customerId),
        lat: lat,
        lng: lng,
        address: address
      })
    });

    var data = await res.json();
    if (res.ok) {
      hideModal('locationModal');
      window.detectedAddress = null;
      showToast('Đã cập nhật vị trí!', 'success');
      await softRefreshCustomers();
      if (window.BeerStore && typeof window.BeerStore.invalidateAndRefresh === 'function') {
        window.BeerStore.invalidateAndRefresh('customers:location').catch(function() {});
      }
      window.dispatchEvent(new CustomEvent('data:mutated', {
        detail: { entity: 'customer', source: 'customers:location', at: Date.now() }
      }));
    } else {
      alert('Cập nhật thất bại: ' + (data.error || 'Lỗi không xác định'));
    }
  } catch (err) {
    alert('Lỗi kết nối: ' + err.message);
  }
}

function editKegBalance(id, balance, name) {
  var kegCustomerIdEl = document.getElementById('kegCustomerId');
  var kegCustomerNameEl = document.getElementById('kegCustomerName');
  var kegBalanceInputEl = document.getElementById('kegBalanceInput');
  var kegNoteEl = document.getElementById('kegNote');
  if (!kegCustomerIdEl || !kegCustomerNameEl || !kegBalanceInputEl) return;
  kegCustomerIdEl.value = id;
  kegCustomerNameEl.textContent = name;
  kegBalanceInputEl.value = balance;
  if (kegNoteEl) kegNoteEl.value = '';
  showModal('kegModal');
}

// Initialize bottom nav active state (wrapped in DOMContentLoaded to ensure DOM is ready)
document.addEventListener('DOMContentLoaded', function() {
  var path = window.location.pathname;
  var homePath = path === '/' || path === '/dashboard';
  document.querySelectorAll('.bottomnav a').forEach(function(a) {
    var href = a.getAttribute('href');
    var homeHref = href === '/' || href === '/dashboard';
    if (href === path || (homePath && homeHref)) {
      a.classList.add('active');
    }
  });
});

window.addEventListener('data:mutated', function(evt) {
  var detail = evt && evt.detail ? evt.detail : {};
  if (!detail.entity || detail.entity === 'customer' || detail.entity === 'sale' || detail.entity === 'expense' || detail.entity === 'sync') {
    softRefreshCustomers();
  }
});
