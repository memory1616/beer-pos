/**
 * BeerPOS - Fuzzy Customer Search
 *
 * Tìm kiếm khách hàng với:
 * - Fuzzy search (chịu lỗi typo)
 * - Vietnamese accent removal
 * - Pinyin search (cho tên tiếng Việt)
 * - Keyboard navigation (↑↓ Enter)
 *
 * Usage:
 *   const searcher = new FuzzyCustomerSearch(customers);
 *   searcher.search('quán jo'); // Returns matches sorted by score
 */

class FuzzyCustomerSearch {
  constructor(customers = []) {
    this.customers = customers;
    this.fuse = null;
    this._buildIndex();
  }

  /**
   * Remove Vietnamese accents
   */
  static removeAccents(str) {
    if (!str) return '';
    return str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  /**
   * Convert Vietnamese to Pinyin-like (first chars)
   * "Nguyễn Văn A" → "nguyen van a"
   */
  static toPinyin(str) {
    if (!str) return '';
    // Just remove accents and lowercase
    return this.removeAccents(str);
  }

  /**
   * Build search index
   */
  _buildIndex() {
    if (typeof window.Fuse === 'undefined') {
      console.warn('[FuzzySearch] Fuse.js not loaded');
      return;
    }

    // Create enhanced customer data with searchable fields
    const searchData = this.customers.map(c => ({
      ...c,
      // Pre-compute searchable versions
      _searchName: c.name ? c.name.toLowerCase().trim() : '',
      _searchNameNoAccent: FuzzyCustomerSearch.removeAccents(c.name),
      _searchPhone: c.phone || '',
      _searchNamePinyin: FuzzyCustomerSearch.toPinyin(c.name)
    }));

    const options = {
      keys: [
        { name: '_searchName', weight: 0.4 },
        { name: '_searchNameNoAccent', weight: 0.3 },
        { name: '_searchNamePinyin', weight: 0.2 },
        { name: '_searchPhone', weight: 0.1 }
      ],
      threshold: 0.4,        // 0 = exact match, 1 = match anything
      distance: 100,          // How close the match must be
      includeScore: true,
      includeMatches: true,
      minMatchCharLength: 2,
      shouldSort: true,
      findAllMatches: true,
      ignoreLocation: true     // Search anywhere in string
    };

    this.fuse = new window.Fuse(searchData, options);
  }

  /**
   * Update customers data
   */
  update(customers) {
    this.customers = customers;
    this._buildIndex();
  }

  /**
   * Search customers
   * @param {string} query - Search query
   * @param {number} limit - Max results (default: 10)
   * @returns {Array} Sorted matches with scores
   */
  search(query, limit = 10) {
    if (!query || query.trim().length < 2) {
      // Return top customers if no query
      return this.customers.slice(0, limit).map(c => ({
        item: c,
        score: 0,
        matches: []
      }));
    }

    if (!this.fuse) {
      // Fallback to simple filter
      const q = query.toLowerCase();
      return this.customers
        .filter(c =>
          (c.name && c.name.toLowerCase().includes(q)) ||
          (c.phone && c.phone.includes(q))
        )
        .slice(0, limit)
        .map(c => ({ item: c, score: 1, matches: [] }));
    }

    // Use Fuse.js
    const results = this.fuse.search(query);
    return results.slice(0, limit);
  }

  /**
   * Quick filter for autocomplete
   * Faster than full search, good for real-time typing
   */
  quickFilter(query) {
    if (!query || query.trim().length < 1) {
      return this.customers.slice(0, 8);
    }

    const q = FuzzyCustomerSearch.removeAccents(query).toLowerCase();
    const qPinyin = q.replace(/\s+/g, '');

    return this.customers
      .map(c => {
        const nameNoAccent = FuzzyCustomerSearch.removeAccents(c.name || '');
        const nameClean = nameNoAccent.replace(/\s+/g, '');

        let score = 0;
        let match = '';

        // Exact phone match (highest priority)
        if (c.phone && c.phone.includes(query)) {
          score = 0.1;
          match = 'phone';
        }
        // Exact name start
        else if (nameNoAccent.startsWith(q)) {
          score = 0.2;
          match = 'start';
        }
        // Contains
        else if (nameNoAccent.includes(q)) {
          score = 0.4;
          match = 'contains';
        }
        // Pinyin match
        else if (nameClean.includes(qPinyin)) {
          score = 0.5;
          match = 'pinyin';
        }
        // Partial match
        else {
          const queryChars = q.split('');
          const nameChars = nameNoAccent.split('');
          let matchCount = 0;
          for (const ch of queryChars) {
            if (nameChars.includes(ch)) matchCount++;
          }
          if (matchCount > 0) {
            score = 0.6 + (matchCount / queryChars.length) * 0.3;
            match = 'partial';
          }
        }

        return { customer: c, score, match };
      })
      .filter(r => r.score < 1)
      .sort((a, b) => a.score - b.score)
      .slice(0, 8)
      .map(r => r.customer);
  }
}

// ─── UI Component ─────────────────────────────────────────────────────────────

class CustomerSearchUI {
  constructor(config = {}) {
    this.container = config.container; // DOM element or selector
    this.onSelect = config.onSelect || (() => {});
    this.placeholder = config.placeholder || '🔍 Tìm khách hàng...';
    this.searcher = null;

    this._selectedIndex = -1;
    this._results = [];
    this._input = null;
    this._dropdown = null;
  }

  /**
   * Initialize with customers data
   */
  init(customers) {
    this.searcher = new FuzzyCustomerSearch(customers);
    this._render();
    this._attachEvents();
  }

  /**
   * Update customers data
   */
  update(customers) {
    if (this.searcher) {
      this.searcher.update(customers);
    } else {
      this.searcher = new FuzzyCustomerSearch(customers);
    }
  }

  /**
   * Render UI
   */
  _render() {
    if (!this.container) return;

    const html = `
      <div class="fuzzy-search-wrapper">
        <div class="fuzzy-search-input-wrap">
          <input type="text"
                 id="fuzzySearchInput"
                 class="fuzzy-search-input"
                 placeholder="${this.placeholder}"
                 autocomplete="off"
                 autocorrect="off"
                 autocapitalize="off"
                 spellcheck="false">
          <button class="fuzzy-search-clear hidden" id="fuzzySearchClear">×</button>
        </div>
        <div id="fuzzySearchDropdown" class="fuzzy-search-dropdown hidden"></div>
      </div>
    `;

    if (typeof this.container === 'string') {
      this.container = document.querySelector(this.container);
    }

    if (this.container.innerHTML !== undefined) {
      this.container.innerHTML = html;
    }

    this._input = document.getElementById('fuzzySearchInput');
    this._dropdown = document.getElementById('fuzzySearchDropdown');
  }

  /**
   * Attach event handlers
   */
  _attachEvents() {
    if (!this._input) return;

    // Input event
    this._input.addEventListener('input', (e) => {
      this._onInput(e.target.value);
    });

    // Focus
    this._input.addEventListener('focus', () => {
      if (this._input.value.trim()) {
        this._showResults(this._input.value);
      }
    });

    // Keyboard navigation
    this._input.addEventListener('keydown', (e) => {
      this._onKeydown(e);
    });

    // Blur - hide dropdown after delay
    this._input.addEventListener('blur', () => {
      setTimeout(() => this._hideResults(), 200);
    });

    // Clear button
    const clearBtn = document.getElementById('fuzzySearchClear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this._clear());
    }
  }

  /**
   * Handle input
   */
  _onInput(value) {
    // Update clear button
    const clearBtn = document.getElementById('fuzzySearchClear');
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', !value);
    }

    // Search and show results
    if (value.trim()) {
      this._showResults(value);
    } else {
      this._hideResults();
      this._selectedIndex = -1;
    }
  }

  /**
   * Handle keyboard
   */
  _onKeydown(e) {
    const results = this._results;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._selectedIndex = Math.min(this._selectedIndex + 1, results.length - 1);
        this._updateSelection();
        break;

      case 'ArrowUp':
        e.preventDefault();
        this._selectedIndex = Math.max(this._selectedIndex - 1, -1);
        this._updateSelection();
        break;

      case 'Enter':
        e.preventDefault();
        if (this._selectedIndex >= 0 && this._selectedIndex < results.length) {
          this._selectItem(results[this._selectedIndex]);
        } else if (results.length > 0) {
          this._selectItem(results[0]);
        }
        break;

      case 'Escape':
        this._hideResults();
        this._input.blur();
        break;

      case 'Tab':
        if (results.length > 0) {
          this._selectItem(results[0]);
          e.preventDefault();
        }
        break;
    }
  }

  /**
   * Show results dropdown
   */
  _showResults(query) {
    if (!this.searcher) return;

    const startTime = performance.now();
    const results = this.searcher.search(query, 8);
    const elapsed = performance.now() - startTime;

    console.log(`[FuzzySearch] "${query}" → ${results.length} results in ${elapsed.toFixed(2)}ms`);

    this._results = results;
    this._selectedIndex = results.length > 0 ? 0 : -1;

    if (results.length === 0) {
      this._dropdown.innerHTML = `
        <div class="fuzzy-search-empty">
          <span>Không tìm thấy khách hàng</span>
          <button class="fuzzy-search-add-new" onclick="CustomerSearchUI.createNew('${query}')">
            + Thêm mới
          </button>
        </div>
      `;
    } else {
      this._dropdown.innerHTML = results.map((result, idx) => {
        const c = result.item;
        const score = result.score || 0;
        const scoreClass = score < 0.2 ? 'high' : score < 0.5 ? 'medium' : 'low';
        const tierBadge = c.tier === 'VIP' ? '<span class="tier-badge vip">⭐</span>' : '';

        return `
          <div class="fuzzy-search-item ${idx === 0 ? 'selected' : ''}"
               data-index="${idx}"
               onclick="window._fuzzySearchSelect(${idx})">
            <div class="fuzzy-search-item-name">
              ${tierBadge}
              ${this._highlightMatch(c.name, result.matches)}
            </div>
            <div class="fuzzy-search-item-meta">
              <span class="fuzzy-search-phone">${c.phone || '—'}</span>
              ${c.keg_balance ? `<span class="fuzzy-search-keg">📦 ${c.keg_balance}</span>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    this._dropdown.classList.remove('hidden');
  }

  /**
   * Highlight matched text
   */
  _highlightMatch(text, matches) {
    if (!matches || !text) return text;

    // Simple highlight - find match in _searchName
    const matchData = matches.find(m => m.key === '_searchName');
    if (!matchData || !matchData.indices) return text;

    let result = '';
    let lastIdx = 0;

    // Sort indices by start position
    const indices = [...matchData.indices].sort((a, b) => a[0] - b[0]);

    for (const [start, end] of indices) {
      result += text.slice(lastIdx, start);
      result += `<mark class="fuzzy-highlight">${text.slice(start, end + 1)}</mark>`;
      lastIdx = end + 1;
    }
    result += text.slice(lastIdx);

    return result;
  }

  /**
   * Update selection highlight
   */
  _updateSelection() {
    const items = this._dropdown.querySelectorAll('.fuzzy-search-item');
    items.forEach((item, idx) => {
      item.classList.toggle('selected', idx === this._selectedIndex);
    });

    // Scroll into view
    const selected = items[this._selectedIndex];
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Select item
   */
  _selectItem(result) {
    const customer = result.item;
    this._input.value = customer.name;
    this._hideResults();
    this.onSelect(customer);
  }

  /**
   * Hide results
   */
  _hideResults() {
    this._dropdown.classList.add('hidden');
  }

  /**
   * Clear input
   */
  _clear() {
    this._input.value = '';
    this._results = [];
    this._selectedIndex = -1;
    this._hideResults();
    this._input.focus();

    const clearBtn = document.getElementById('fuzzySearchClear');
    if (clearBtn) clearBtn.classList.add('hidden');

    this.onSelect(null);
  }

  /**
   * Focus input
   */
  focus() {
    this._input?.focus();
  }
}

// Global function for onclick
window._fuzzySearchSelect = function(index) {
  const searchUI = window.fuzzySearchUIInstance;
  if (searchUI && searchUI._results[index]) {
    searchUI._selectItem(searchUI._results[index]);
  }
};

// Static method for creating new customer
CustomerSearchUI.createNew = function(name) {
  console.log('[FuzzySearch] Create new customer:', name);
  // Trigger new customer modal or callback
  if (typeof window.showNewCustomerModal === 'function') {
    window.showNewCustomerModal(name);
  }
};

// ─── Export ───────────────────────────────────────────────────────────────────

window.FuzzyCustomerSearch = FuzzyCustomerSearch;
window.CustomerSearchUI = CustomerSearchUI;