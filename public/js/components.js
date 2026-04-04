/**
 * Beer POS - Reusable UI Components
 * Shared component builders for consistent UI across the app
 */

const StatCard = {
  /**
   * Build a stat card HTML string
   * @param {Object} config
   * @param {string} config.type - 'green'|'blue'|'amber'|'emerald'|'red'|'info'|'success'|'danger'|'profit'|'warning'
   * @param {string} config.label - Label text
   * @param {string} config.value - Main value (already formatted)
   * @param {string} [config.sub] - Sub-label beneath value
   * @param {string} [config.icon] - Icon emoji/text
   * @param {string} [config.cls] - Extra classes for sc-value
   * @param {string} [config.href] - If provided, wraps in <a>
   * @param {string} [config.onclick] - onclick attribute
   * @returns {string} HTML string
   */
  build(config) {
    const type = config.type || 'green';
    const icon = config.icon ? `<span class="sc-icon">${config.icon}</span>` : '';
    const sub = config.sub ? `<div class="sc-sub">${config.sub}</div>` : '';
    const cls = config.cls ? ` ${config.cls}` : '';

    const inner = `<div class="sc-label">${icon}${config.label}</div>` +
                  `<div class="sc-value${cls}">${config.value}</div>${sub}`;

    if (config.href) {
      return `<a href="${config.href}" class="card stat-card--${type}">${inner}</a>`;
    }
    if (config.onclick) {
      return `<div class="card stat-card--${type}" onclick="${config.onclick}" style="cursor:pointer">${inner}</div>`;
    }
    return `<div class="card stat-card--${type}">${inner}</div>`;
  },

  /**
   * Build a grid of stat cards
   * @param {Array} configs - Array of StatCard config objects
   * @param {number} [cols=2] - Number of columns
   * @returns {string} HTML string with grid wrapper
   */
  grid(configs, cols) {
    cols = cols || 2;
    const gridClass = cols === 3 ? 'grid-cols-3' : 'grid-cols-2';
    return '<div class="grid ' + gridClass + ' gap-3">' +
      configs.map(c => this.build(c)).join('') +
      '</div>';
  }
};

const Money = {
  /**
   * Build a money display HTML
   * @param {number|string} amount - Amount to format
   * @param {string} [size] - 'hero'|'xl'|'lg'|'base'|'sm'
   * @param {string} [color] - 'success'|'danger'|'warning'|'info'|'muted'
   * @param {boolean} [omitUnit] - Skip the currency unit
   * @returns {string} HTML string
   */
  display(amount, size, color, omitUnit) {
    const sizeClass = size ? ` md-${size}` : ' md-base';
    const colorClass = color ? ` md-${color}` : ' md-success';
    const unitHtml = omitUnit ? '' : '<span class="md-unit">đ</span>';
    return '<span class="money-display' + sizeClass + colorClass + '">' +
      '<span class="md-value">' + (typeof Format !== 'undefined' ? Format.number(amount) : amount) + '</span>' +
      unitHtml +
      '</span>';
  },

  /** Large KPI number (2rem) */
  hero(amount, omitUnit)    { return this.display(amount, 'hero', 'success', omitUnit); },
  /** Extra large (1.5rem) */
  xl(amount, omitUnit)     { return this.display(amount, 'xl', 'success', omitUnit); },
  /** Large (1.25rem) */
  lg(amount, omitUnit)     { return this.display(amount, 'lg', 'success', omitUnit); },
  /** Base size (1rem) */
  base(amount, omitUnit)   { return this.display(amount, 'base', 'success', omitUnit); },
  /** Danger color */
  danger(amount, omitUnit) { return this.display(amount, 'xl', 'danger', omitUnit); },
  /** Success color */
  success(amount, omitUnit){ return this.display(amount, 'xl', 'success', omitUnit); },
  /** Warning color */
  warning(amount, omitUnit){ return this.display(amount, 'xl', 'warning', omitUnit); },
  /** Info color */
  info(amount, omitUnit)   { return this.display(amount, 'xl', 'info', omitUnit); }
};

const SummaryCard = {
  /**
   * Build a full-gradient summary card (replaces inline gradient styles)
   * @param {Object} config
   * @param {string} config.type - 'green'|'red'|'blue'|'purple'|'teal'
   * @param {Array} config.items - [{label, value}]
   * @returns {string} HTML string
   */
  build(config) {
    const items = config.items.map(item =>
      '<div><div class="sum-label">' + item.label + '</div><div class="sum-value">' + item.value + '</div></div>'
    ).join('');
    return '<div class="card card--summary-' + config.type + ' rounded-2xl overflow-hidden shadow-lg">' +
      '<div class="grid grid-cols-' + config.items.length + ' gap-3 text-center py-4 px-4">' + items + '</div>' +
      '</div>';
  }
};

const ListCard = {
  /**
   * Build a list item card (hover-friendly)
   * @param {Object} config
   * @param {string} [config.cls] - Extra classes
   * @param {string} config.left - Left content
   * @param {string} config.right - Right content
   * @param {string} [config.onclick] - onclick attribute
   * @param {string} [config.href] - If provided, wraps in <a>
   * @returns {string} HTML string
   */
  build(config) {
    const cls = config.cls ? ' ' + config.cls : '';
    const inner = '<div class="flex justify-between items-center' + cls + '">' +
      '<div class="flex-1 min-w-0">' + config.left + '</div>' +
      (config.right ? '<div class="shrink-0 ml-3">' + config.right + '</div>' : '') +
      '</div>';

    if (config.href) {
      return '<a href="' + config.href + '" class="card card--list-item">' + inner + '</a>';
    }
    if (config.onclick) {
      return '<div class="card card--list-item" onclick="' + config.onclick + '" style="cursor:pointer">' + inner + '</div>';
    }
    return '<div class="card card--list-item">' + inner + '</div>';
  }
};
