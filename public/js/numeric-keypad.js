/**
 * BeerPOS - Numeric Keypad Component
 *
 * UI bàn phím số cho nhập liệu nhanh trên POS.
 * Thay thế input type="number" mặc định bằng keypad touch-friendly.
 *
 * Cách dùng:
 *   NumericKeypad.show({
 *     title: 'Nhập số lượng',
 *     value: 0,
 *     max: 99,
 *     onConfirm: (value) => console.log('Giá trị:', value),
 *     onCancel: () => console.log('Đã hủy')
 *   });
 */

const NumericKeypad = {
  currentConfig: null,

  /**
   * Hiển thị keypad modal
   * @param {Object} config
   * @param {string} config.title - Tiêu đề
   * @param {number} config.value - Giá trị ban đầu
   * @param {number} config.max - Giá trị tối đa
   * @param {number} config.min - Giá trị tối thiểu
   * @param {Function} config.onConfirm - Callback khi xác nhận
   * @param {Function} config.onCancel - Callback khi hủy
   * @param {string} config.unit - Đơn vị hiển thị (VD: 'bình', 'cái')
   */
  show(config) {
    this.currentConfig = {
      title: config.title || 'Nhập số',
      value: config.value || 0,
      max: config.max || 999,
      min: config.min || 0,
      unit: config.unit || '',
      onConfirm: config.onConfirm || (() => {}),
      onCancel: config.onCancel || (() => {})
    };

    this._render();
    this._animateIn();
  },

  /**
   * Ẩn keypad
   */
  hide() {
    const modal = document.getElementById('numericKeypadModal');
    if (!modal) return;

    this._animateOut(() => {
      modal.remove();
      if (this.currentConfig?.onCancel) {
        this.currentConfig.onCancel();
      }
      this.currentConfig = null;
    });
  },

  /**
   * Xác nhận giá trị
   */
  confirm() {
    if (!this.currentConfig) return;

    const value = this.currentConfig.value;
    const modal = document.getElementById('numericKeypadModal');

    this._animateOut(() => {
      modal.remove();
      if (this.currentConfig?.onConfirm) {
        this.currentConfig.onConfirm(value);
      }
      this.currentConfig = null;
    });
  },

  /**
   * Thêm số
   */
  appendDigit(digit) {
    if (!this.currentConfig) return;

    let newValue = this.currentConfig.value * 10 + digit;

    // Giới hạn max
    if (newValue > this.currentConfig.max) {
      newValue = this.currentConfig.max;
    }

    this.currentConfig.value = newValue;
    this._updateDisplay();
    this._playFeedback();
  },

  /**
   * Xóa số cuối
   */
  deleteLast() {
    if (!this.currentConfig) return;

    let newValue = Math.floor(this.currentConfig.value / 10);

    // Giới hạn min
    if (newValue < this.currentConfig.min) {
      newValue = this.currentConfig.min;
    }

    this.currentConfig.value = newValue;
    this._updateDisplay();
    this._playFeedback();
  },

  /**
   * Clear tất cả
   */
  clear() {
    if (!this.currentConfig) return;

    this.currentConfig.value = this.currentConfig.min;
    this._updateDisplay();
    this._playFeedback();
  },

  /**
   * Tăng/giảm giá trị
   */
  increment(amount = 1) {
    if (!this.currentConfig) return;

    let newValue = this.currentConfig.value + amount;

    // Giới hạn
    if (newValue > this.currentConfig.max) {
      newValue = this.currentConfig.max;
    }
    if (newValue < this.currentConfig.min) {
      newValue = this.currentConfig.min;
    }

    this.currentConfig.value = newValue;
    this._updateDisplay();
    this._playFeedback();
  },

  /**
   * Render modal
   */
  _render() {
    const config = this.currentConfig;

    const modal = document.createElement('div');
    modal.id = 'numericKeypadModal';
    modal.className = 'nk-modal-overlay';
    modal.innerHTML = `
      <div class="nk-modal">
        <div class="nk-header">
          <div class="nk-title">${config.title}</div>
          <button class="nk-close" onclick="NumericKeypad.hide()">×</button>
        </div>

        <div class="nk-display" id="nkDisplay">
          <span class="nk-value" id="nkValue">${config.value}</span>
          ${config.unit ? `<span class="nk-unit">${config.unit}</span>` : ''}
        </div>

        <div class="nk-keypad">
          <button class="nk-btn nk-btn-num" onclick="NumericKeypad.appendDigit(1)">1</button>
          <button class="nk-btn nk-btn-num" onclick="NumericKeypad.appendDigit(2)">2</button>
          <button class="nk-btn nk-btn-num" onclick="NumericKeypad.appendDigit(3)">3</button>
          <button class="nk-btn nk-btn-num" onclick="NumericKeypad.appendDigit(4)">4</button>
          <button class="nk-btn nk-btn-num" onclick="NumericKeypad.appendDigit(5)">5</button>
          <button class="nk-btn nk-btn-num" onclick="NumericKeypad.appendDigit(6)">6</button>
          <button class="nk-btn nk-btn-num" onclick="NumericKeypad.appendDigit(7)">7</button>
          <button class="nk-btn nk-btn-num" onclick="NumericKeypad.appendDigit(8)">8</button>
          <button class="nk-btn nk-btn-num" onclick="NumericKeypad.appendDigit(9)">9</button>
          <button class="nk-btn nk-btn-action nk-clear" onclick="NumericKeypad.clear()">C</button>
          <button class="nk-btn nk-btn-num" onclick="NumericKeypad.appendDigit(0)">0</button>
          <button class="nk-btn nk-btn-action nk-delete" onclick="NumericKeypad.deleteLast()">⌫</button>
        </div>

        <div class="nk-actions">
          <button class="nk-btn nk-btn-cancel" onclick="NumericKeypad.hide()">Hủy</button>
          <button class="nk-btn nk-btn-confirm" onclick="NumericKeypad.confirm()">Xác nhận</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Event: click outside để đóng
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.hide();
      }
    });

    // Event: keyboard support
    this._setupKeyboard();
  },

  /**
   * Cập nhật hiển thị giá trị
   */
  _updateDisplay() {
    const valueEl = document.getElementById('nkValue');
    if (valueEl && this.currentConfig) {
      valueEl.textContent = this.currentConfig.value;
    }
  },

  /**
   * Animation in
   */
  _animateIn() {
    const modal = document.getElementById('numericKeypadModal');
    if (!modal) return;

    const keypad = modal.querySelector('.nk-modal');
    if (keypad) {
      keypad.style.transform = 'translateY(100%)';
      keypad.style.opacity = '0';

      requestAnimationFrame(() => {
        keypad.style.transition = 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease';
        keypad.style.transform = 'translateY(0)';
        keypad.style.opacity = '1';
      });
    }
  },

  /**
   * Animation out
   */
  _animateOut(callback) {
    const modal = document.getElementById('numericKeypadModal');
    if (!modal) {
      callback?.();
      return;
    }

    const keypad = modal.querySelector('.nk-modal');
    if (keypad) {
      keypad.style.transform = 'translateY(100%)';
      keypad.style.opacity = '0';

      setTimeout(() => {
        callback?.();
      }, 300);
    } else {
      callback?.();
    }
  },

  /**
   * Keyboard support
   */
  _setupKeyboard() {
    const handler = (e) => {
      if (!this.currentConfig) {
        document.removeEventListener('keydown', handler);
        return;
      }

      if (e.key === 'Escape') {
        this.hide();
        return;
      }

      if (e.key === 'Enter') {
        this.confirm();
        return;
      }

      if (e.key === 'Backspace') {
        this.deleteLast();
        return;
      }

      // Số 0-9
      if (e.key >= '0' && e.key <= '9') {
        this.appendDigit(parseInt(e.key));
        return;
      }
    };

    document.addEventListener('keydown', handler);
  },

  /**
   * Play haptic feedback
   */
  _playFeedback() {
    if ('vibrate' in navigator) {
      navigator.vibrate(10);
    }
  }
};

// ============================================================
// STYLES - Inject CSS
// ============================================================
(function() {
  if (document.getElementById('numericKeypadStyles')) return;

  const style = document.createElement('style');
  style.id = 'numericKeypadStyles';
  style.textContent = `
    .nk-modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      display: flex;
      align-items: flex-end;
      justify-content: center;
      z-index: 9999;
      padding: 16px;
    }

    .nk-modal {
      background: var(--card, #1E2329);
      border-radius: 20px 20px 0 0;
      width: 100%;
      max-width: 360px;
      padding: 16px;
      box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.3);
    }

    .nk-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .nk-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary, #EAECEF);
    }

    .nk-close {
      width: 32px;
      height: 32px;
      border: none;
      background: var(--bg-hover, #2B3139);
      color: var(--text-secondary, #848E9C);
      border-radius: 50%;
      font-size: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .nk-close:hover {
      background: var(--red-dim, #3d1f1f);
      color: var(--red, #EF4444);
    }

    .nk-display {
      background: var(--bg-main, #0B0E11);
      border: 2px solid var(--border, #2B3139);
      border-radius: 12px;
      padding: 16px;
      text-align: center;
      margin-bottom: 12px;
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    .nk-value {
      font-size: 36px;
      font-weight: 700;
      color: var(--accent, #FCD535);
      font-variant-numeric: tabular-nums;
    }

    .nk-unit {
      font-size: 18px;
      color: var(--text-secondary, #848E9C);
    }

    .nk-keypad {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 12px;
    }

    .nk-btn {
      height: 56px;
      border: none;
      border-radius: 12px;
      font-size: 22px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.1s, background 0.1s;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .nk-btn:active {
      transform: scale(0.95);
    }

    .nk-btn-num {
      background: var(--bg-hover, #2B3139);
      color: var(--text-primary, #EAECEF);
    }

    .nk-btn-num:hover {
      background: var(--card, #3B4350);
    }

    .nk-btn-action {
      background: var(--bg-card, #2B3139);
      color: var(--text-secondary, #848E9C);
      font-size: 18px;
    }

    .nk-clear {
      background: var(--red-dim, rgba(239, 68, 68, 0.15));
      color: var(--red, #EF4444);
    }

    .nk-delete {
      background: var(--blue-dim, rgba(59, 130, 246, 0.15));
      color: var(--info, #3B82F6);
    }

    .nk-actions {
      display: grid;
      grid-template-columns: 1fr 2fr;
      gap: 12px;
    }

    .nk-btn-cancel {
      height: 52px;
      border: 1px solid var(--border, #2B3139);
      background: transparent;
      color: var(--text-secondary, #848E9C);
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
    }

    .nk-btn-confirm {
      height: 52px;
      border: none;
      background: var(--success, #0ECB81);
      color: white;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 700;
    }

    .nk-btn-confirm:hover {
      background: #0DB86E;
    }

    /* Quick +/- buttons style */
    .nk-quick-adjust {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }

    .nk-quick-btn {
      flex: 1;
      height: 40px;
      border: 1px solid var(--border, #2B3139);
      background: var(--bg-hover, #2B3139);
      color: var(--text-primary, #EAECEF);
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    .nk-quick-btn:hover {
      background: var(--card, #3B4350);
    }

    /* Dark mode support */
    @media (prefers-color-scheme: dark) {
      .nk-modal {
        --card: #1E2329;
        --bg-main: #0B0E11;
        --bg-hover: #2B3139;
        --border: #2B3139;
        --text-primary: #EAECEF;
        --text-secondary: #848E9C;
        --accent: #FCD535;
        --red: #EF4444;
        --red-dim: rgba(239, 68, 68, 0.15);
        --success: #0ECB81;
        --info: #3B82F6;
        --blue-dim: rgba(59, 130, 246, 0.15);
      }
    }

    /* Light mode */
    [data-theme="light"] .nk-modal {
      --card: #FFFFFF;
      --bg-main: #F3F4F6;
      --bg-hover: #E5E7EB;
      --border: #D1D5DB;
      --text-primary: #111827;
      --text-secondary: #6B7280;
      --accent: #EAB308;
      --red: #DC2626;
      --red-dim: rgba(220, 38, 38, 0.1);
      --success: #059669;
      --info: #2563EB;
      --blue-dim: rgba(37, 99, 235, 0.1);
    }
  `;

  document.head.appendChild(style);
})();

// ============================================================
// QUICK INTEGRATION - Gắn vào product card
// ============================================================

/**
 * Tạo quantity selector với keypad
 * @param {Object} options
 * @param {number} options.value - Giá trị ban đầu
 * @param {number} options.max - Tối đa
 * @param {Function} options.onChange - Callback khi thay đổi
 * @returns {HTMLElement}
 */
function createQuantitySelector(options) {
  const { value = 0, max = 99, onChange = () => {} } = options;

  const container = document.createElement('div');
  container.className = 'qty-selector';
  container.innerHTML = `
    <button class="qty-btn qty-minus" data-action="minus">−</button>
    <input type="text" class="qty-input" value="${value}" readonly>
    <button class="qty-btn qty-plus" data-action="plus">+</button>
  `;

  const input = container.querySelector('.qty-input');

  // Minus button
  container.querySelector('.qty-minus').addEventListener('click', () => {
    const current = parseInt(input.value) || 0;
    if (current > 0) {
      input.value = current - 1;
      onChange(parseInt(input.value));
    } else {
      // Mở keypad để nhập số âm
      NumericKeypad.show({
        title: 'Nhập số lượng bớt',
        value: current,
        max: current,
        unit: 'bình',
        onConfirm: (val) => {
          input.value = val;
          onChange(val);
        }
      });
    }
  });

  // Plus button
  container.querySelector('.qty-plus').addEventListener('click', () => {
    const current = parseInt(input.value) || 0;
    if (current < max) {
      input.value = current + 1;
      onChange(parseInt(input.value));
    } else {
      // Mở keypad để nhập số lớn hơn
      NumericKeypad.show({
        title: 'Nhập số lượng thêm',
        value: current + 1,
        max: max,
        unit: 'bình',
        onConfirm: (val) => {
          input.value = val;
          onChange(val);
        }
      });
    }
  });

  // Tap on input to open keypad
  input.addEventListener('click', () => {
    NumericKeypad.show({
      title: 'Nhập số lượng',
      value: parseInt(input.value) || 0,
      max: max,
      unit: 'bình',
      onConfirm: (val) => {
        input.value = val;
        onChange(val);
      }
    });
  });

  return container;
}

// ============================================================
// EXPORT
// ============================================================
window.NumericKeypad = NumericKeypad;
window.createQuantitySelector = createQuantitySelector;