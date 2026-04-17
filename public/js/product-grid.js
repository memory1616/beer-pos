/**
 * BeerPOS - Product Grid Component
 *
 * Grid layout cho sản phẩm với:
 * - Responsive grid (2-4 columns)
 * - Quantity badge
 * - Keyboard shortcuts
 * - Touch-friendly
 *
 * Usage:
 *   const grid = new ProductGrid({
 *     container: '#productGrid',
 *     products: productsData,
 *     onSelect: (product) => addToCart(product)
 *   });
 *   grid.render();
 */

class ProductGrid {
  constructor(config = {}) {
    this.products = config.products || [];
    this.onSelect = config.onSelect || (() => {});
    this.onQuantityChange = config.onQuantityChange || (() => {});

    this.selectedIndex = -1;
    this.quantities = new Map(); // productId -> quantity

    this.container = config.container;
    this.columns = config.columns || this._getAutoColumns();
  }

  /**
   * Get auto columns based on screen width
   */
  _getAutoColumns() {
    if (typeof window === 'undefined') return 2;

    const width = window.innerWidth;
    if (width >= 1024) return 4;
    if (width >= 640) return 3;
    return 2;
  }

  /**
   * Update products data
   */
  updateProducts(products) {
    this.products = products;
    this.quantities.clear();
  }

  /**
   * Get quantity for product
   */
  getQuantity(productId) {
    return this.quantities.get(productId) || 0;
  }

  /**
   * Set quantity for product
   */
  setQuantity(productId, qty) {
    if (qty > 0) {
      this.quantities.set(productId, qty);
    } else {
      this.quantities.delete(productId);
    }
    this._updateItemBadge(productId);
  }

  /**
   * Increment quantity
   */
  incrementQuantity(productId) {
    const current = this.getQuantity(productId);
    this.setQuantity(productId, current + 1);
  }

  /**
   * Decrement quantity
   */
  decrementQuantity(productId) {
    const current = this.getQuantity(productId);
    if (current > 1) {
      this.setQuantity(productId, current - 1);
    } else {
      this.setQuantity(productId, 0);
    }
  }

  /**
   * Clear all quantities
   */
  clearQuantities() {
    this.quantities.clear();
  }

  /**
   * Get total cart count
   */
  getTotalCount() {
    let total = 0;
    this.quantities.forEach(qty => total += qty);
    return total;
  }

  /**
   * Get selected products for cart
   */
  getSelectedProducts() {
    const selected = [];
    this.quantities.forEach((qty, productId) => {
      if (qty > 0) {
        const product = this.products.find(p => p.id === productId);
        if (product) {
          selected.push({ ...product, quantity: qty });
        }
      }
    });
    return selected;
  }

  /**
   * Render grid
   */
  render() {
    if (!this.container) {
      console.warn('[ProductGrid] No container');
      return;
    }

    const containerEl = typeof this.container === 'string'
      ? document.querySelector(this.container)
      : this.container;

    if (!containerEl) {
      console.warn('[ProductGrid] Container not found:', this.container);
      return;
    }

    const html = `
      <div class="product-grid" style="
        display: grid;
        grid-template-columns: repeat(${this.columns}, 1fr);
        gap: 8px;
        padding: 8px;
      ">
        ${this.products.map((product, idx) => this._renderItem(product, idx)).join('')}
      </div>
    `;

    containerEl.innerHTML = html;
    this._attachEvents();
  }

  /**
   * Render single product item
   */
  _renderItem(product, index) {
    const qty = this.getQuantity(product.id);
    const stockClass = product.stock <= 0 ? 'out-of-stock' :
                       product.stock < 5 ? 'low-stock' : '';
    const selectedClass = index === this.selectedIndex ? 'selected' : '';

    return `
      <div class="product-card ${stockClass} ${selectedClass}"
           data-product-id="${product.id}"
           data-index="${index}"
           style="
             background: var(--card);
             border: 2px solid var(--border);
             border-radius: 12px;
             padding: 12px;
             cursor: pointer;
             transition: all 0.15s ease;
             position: relative;
             overflow: hidden;
           "
           onclick="window._productGridSelect(${product.id})">

        <!-- Quantity Badge -->
        ${qty > 0 ? `
          <div class="qty-badge" style="
            position: absolute;
            top: -4px;
            right: -4px;
            width: 28px;
            height: 28px;
            background: var(--primary);
            color: var(--btn-primary-color);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: 700;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          ">
            ${qty}
          </div>
        ` : ''}

        <!-- Product Name -->
        <div class="product-name" style="
          font-weight: 600;
          font-size: 13px;
          color: var(--text-primary);
          margin-bottom: 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        ">
          ${product.name}
        </div>

        <!-- Price -->
        <div class="product-price" style="
          font-size: 15px;
          font-weight: 700;
          color: var(--success);
          margin-bottom: 8px;
        ">
          ${this._formatPrice(product.sell_price || product.price)}
        </div>

        <!-- Stock & Controls -->
        <div style="
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        ">
          <!-- Stock -->
          <div class="product-stock ${stockClass}" style="
            font-size: 11px;
            color: ${product.stock <= 5 ? 'var(--warning)' : 'var(--text-secondary)'};
          ">
            ${product.stock <= 0 ? '❌ Hết' : `📦 ${product.stock}`}
          </div>

          <!-- Quantity Controls -->
          <div class="qty-controls" style="
            display: flex;
            gap: 4px;
          ">
            ${qty > 0 ? `
              <button class="qty-btn qty-minus"
                      onclick="event.stopPropagation(); window._productGridDecrement(${product.id})"
                      style="
                width: 28px;
                height: 28px;
                border-radius: 6px;
                border: 1px solid var(--border);
                background: var(--bg-hover);
                color: var(--text-secondary);
                font-size: 16px;
                cursor: pointer;
              ">
                −
              </button>
              <span class="qty-value" style="
                min-width: 24px;
                text-align: center;
                font-weight: 600;
                font-size: 14px;
              ">
                ${qty}
              </span>
            ` : ''}

            <button class="qty-btn qty-plus"
                    onclick="event.stopPropagation(); window._productGridIncrement(${product.id})"
                    style="
              width: 28px;
              height: 28px;
              border-radius: 6px;
              border: none;
              background: var(--primary);
              color: var(--btn-primary-color);
              font-size: 16px;
              font-weight: 700;
              cursor: pointer;
            ">
              +
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Update item badge (without full re-render)
   */
  _updateItemBadge(productId) {
    const containerEl = typeof this.container === 'string'
      ? document.querySelector(this.container)
      : this.container;

    if (!containerEl) return;

    const card = containerEl.querySelector(`[data-product-id="${productId}"]`);
    if (!card) return;

    const qty = this.getQuantity(productId);
    const badge = card.querySelector('.qty-badge');
    const qtyValue = card.querySelector('.qty-value');
    const controls = card.querySelector('.qty-controls');

    if (qty > 0) {
      if (badge) {
        badge.textContent = qty;
      } else {
        // Create badge
        const badgeHtml = `<div class="qty-badge" style="position:absolute;top:-4px;right:-4px;width:28px;height:28px;background:var(--primary);color:var(--btn-primary-color);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,0.3)">${qty}</div>`;
        card.insertAdjacentHTML('afterbegin', badgeHtml);
      }

      if (qtyValue) {
        qtyValue.textContent = qty;
      } else if (controls) {
        // Add quantity value
        const minusBtn = controls.querySelector('.qty-minus');
        if (minusBtn) {
          const valueHtml = `<span class="qty-value" style="min-width:24px;text-align:center;font-weight:600;font-size:14px">${qty}</span>`;
          minusBtn.insertAdjacentHTML('afterend', valueHtml);
        }
      }
    } else {
      // Remove badge
      if (badge) badge.remove();

      // Remove qty value
      if (qtyValue) qtyValue.remove();
    }
  }

  /**
   * Attach events
   */
  _attachEvents() {
    // Keyboard navigation
    document.addEventListener('keydown', this._handleKeydown.bind(this));
  }

  /**
   * Handle keyboard
   */
  _handleKeydown(e) {
    // Only handle if not in input/textarea
    if (e.target.matches('input, textarea, select')) return;

    const cols = this.columns;
    const maxIdx = this.products.length - 1;

    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, maxIdx);
        this._updateSelection();
        break;

      case 'ArrowLeft':
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this._updateSelection();
        break;

      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + cols, maxIdx);
        this._updateSelection();
        break;

      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - cols, 0);
        this._updateSelection();
        break;

      case 'Enter':
      case ' ':
        if (this.selectedIndex >= 0) {
          e.preventDefault();
          const product = this.products[this.selectedIndex];
          if (product) {
            this.incrementQuantity(product.id);
            this.onSelect(product);
          }
        }
        break;

      case '+':
      case '=':
        if (this.selectedIndex >= 0) {
          e.preventDefault();
          const product = this.products[this.selectedIndex];
          if (product) this.incrementQuantity(product.id);
        }
        break;

      case '-':
      case '_':
        if (this.selectedIndex >= 0) {
          e.preventDefault();
          const product = this.products[this.selectedIndex];
          if (product) this.decrementQuantity(product.id);
        }
        break;
    }
  }

  /**
   * Update selection highlight
   */
  _updateSelection() {
    const containerEl = typeof this.container === 'string'
      ? document.querySelector(this.container)
      : this.container;

    if (!containerEl) return;

    const cards = containerEl.querySelectorAll('.product-card');
    cards.forEach((card, idx) => {
      card.classList.toggle('selected', idx === this.selectedIndex);
    });

    // Scroll into view
    const selected = cards[this.selectedIndex];
    if (selected) {
      selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /**
   * Format price
   */
  _formatPrice(amount) {
    if (!amount) return '—';
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
      minimumFractionDigits: 0
    }).format(amount);
  }
}

// ─── Global handlers ──────────────────────────────────────────────────────────

// Store instance globally
window._productGridInstance = null;

/**
 * Select product (add to cart)
 */
window._productGridSelect = function(productId) {
  if (window._productGridInstance) {
    const product = window._productGridInstance.products.find(p => p.id === productId);
    if (product) {
      window._productGridInstance.incrementQuantity(productId);
      window._productGridInstance.onSelect(product);
    }
  }
};

/**
 * Increment quantity
 */
window._productGridIncrement = function(productId) {
  window._productGridInstance?.incrementQuantity(productId);
};

/**
 * Decrement quantity
 */
window._productGridDecrement = function(productId) {
  window._productGridInstance?.decrementQuantity(productId);
};

// ─── Export ───────────────────────────────────────────────────────────────────

window.ProductGrid = ProductGrid;