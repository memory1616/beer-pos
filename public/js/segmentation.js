/**
 * BeerPOS - Customer Segmentation Rules Engine
 *
 * Tự động phân loại khách hàng dựa trên rules.
 * Runes format:
 * {
 *   "min_orders": 10,        // Số đơn hàng tối thiểu
 *   "min_spent": 5000000,    // Tổng chi tiêu tối thiểu
 *   "max_spent": null,       // Tổng chi tiêu tối đa
 *   "last_order_days": 30,   // Ngày không mua tối đa
 *   "avg_order_value": 500000 // Giá trị đơn TB tối thiểu
 * }
 */

const SegmentRules = {
  /**
   * Đánh giá customer và trả về segment phù hợp nhất
   * @param {Object} customer - Customer data từ DB
   * @param {Object} stats - Customer stats (orders, spent, etc)
   * @param {Array} segments - Danh sách segments từ DB
   * @returns {Object} - { segment, matchedRules }
   */
  evaluate(customer, stats, segments) {
    if (!customer || !segments || segments.length === 0) {
      return { segment: null, matchedRules: [] };
    }

    const results = segments
      .filter(s => s.active)
      .map(segment => {
        const matched = this._checkRules(segment.rules, customer, stats);
        return { segment, matched };
      })
      .filter(r => r.matched);

    if (results.length === 0) {
      // Default: New customer
      return { segment: null, matchedRules: [] };
    }

    // Sort by priority (higher = better match)
    results.sort((a, b) => (b.segment.priority || 0) - (a.segment.priority || 0));

    return {
      segment: results[0].segment,
      matchedRules: results[0].matched
    };
  },

  /**
   * Kiểm tra rules của 1 segment
   */
  _checkRules(rulesJson, customer, stats) {
    if (!rulesJson) return [];

    let rules;
    try {
      rules = typeof rulesJson === 'string' ? JSON.parse(rulesJson) : rulesJson;
    } catch (e) {
      console.error('Invalid rules JSON:', e);
      return [];
    }

    const matched = [];

    // Min orders
    if (rules.min_orders !== undefined && rules.min_orders !== null) {
      if ((stats.orderCount || 0) >= rules.min_orders) {
        matched.push(`min_orders: ${rules.min_orders}`);
      } else {
        return []; // Fail fast
      }
    }

    // Min spent
    if (rules.min_spent !== undefined && rules.min_spent !== null) {
      if ((stats.totalSpent || 0) >= rules.min_spent) {
        matched.push(`min_spent: ${rules.min_spent}`);
      } else {
        return [];
      }
    }

    // Max spent
    if (rules.max_spent !== undefined && rules.max_spent !== null) {
      if ((stats.totalSpent || 0) > rules.max_spent) {
        return []; // Too much spent = not this segment
      }
      matched.push(`max_spent: ${rules.max_spent}`);
    }

    // Last order days
    if (rules.last_order_days !== undefined && rules.last_order_days !== null) {
      const lastOrder = customer.last_order_date ? new Date(customer.last_order_date) : null;
      const daysSince = lastOrder
        ? Math.floor((Date.now() - lastOrder.getTime()) / (1000 * 60 * 60 * 24))
        : 999;

      if (daysSince <= rules.last_order_days) {
        matched.push(`last_order_days: ${daysSince}`);
      } else {
        return [];
      }
    }

    // Avg order value
    if (rules.avg_order_value !== undefined && rules.avg_order_value !== null) {
      const avgOrder = stats.orderCount > 0
        ? (stats.totalSpent || 0) / stats.orderCount
        : 0;

      if (avgOrder >= rules.avg_order_value) {
        matched.push(`avg_order_value: ${avgOrder}`);
      } else {
        return [];
      }
    }

    // Days since registration
    if (rules.min_member_days !== undefined && rules.min_member_days !== null) {
      const created = customer.created_at ? new Date(customer.created_at) : new Date();
      const daysMember = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));

      if (daysMember >= rules.min_member_days) {
        matched.push(`min_member_days: ${daysMember}`);
      } else {
        return [];
      }
    }

    return matched;
  },

  /**
   * Lấy customer stats từ DB
   */
  async getCustomerStats(customerId) {
    try {
      const res = await fetch(`/api/customers/${customerId}/stats`);
      const data = await res.json();
      return data.data || {};
    } catch (e) {
      console.error('Failed to fetch customer stats:', e);
      return {};
    }
  },

  /**
   * Tính stats trực tiếp từ data
   */
  calculateStats(customerData) {
    const orderCount = customerData.sales?.length || 0;
    const totalSpent = customerData.sales?.reduce((sum, s) => sum + (s.total || 0), 0) || 0;
    const totalQty = customerData.sales?.reduce((sum, s) => {
      const items = s.items || [];
      return sum + items.reduce((s2, i) => s2 + (i.quantity || 0), 0);
    }, 0) || 0;

    const avgOrderValue = orderCount > 0 ? totalSpent / orderCount : 0;

    // Calculate last order date
    let lastOrderDate = null;
    if (customerData.sales?.length > 0) {
      const dates = customerData.sales.map(s => new Date(s.date)).filter(d => !isNaN(d));
      if (dates.length > 0) {
        lastOrderDate = new Date(Math.max(...dates));
      }
    }

    return {
      orderCount,
      totalSpent,
      totalQty,
      avgOrderValue,
      lastOrderDate
    };
  }
};

// ============================================================
// SEGMENT MANAGEMENT API
// ============================================================

const SegmentAPI = {
  /**
   * Lấy tất cả segments
   */
  async getAll() {
    const res = await fetch('/api/promotions/segments/list');
    const data = await res.json();
    return data.data || [];
  },

  /**
   * Tạo segment mới
   */
  async create(segment) {
    const res = await fetch('/api/promotions/segments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(segment)
    });
    return await res.json();
  },

  /**
   * Cập nhật segment
   */
  async update(segmentId, segment) {
    const res = await fetch(`/api/promotions/segments/${segmentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(segment)
    });
    return await res.json();
  },

  /**
   * Xóa segment
   */
  async delete(segmentId) {
    const res = await fetch(`/api/promotions/segments/${segmentId}`, {
      method: 'DELETE'
    });
    return await res.json();
  },

  /**
   * Áp dụng rules cho tất cả khách hàng
   */
  async applyToAll() {
    const res = await fetch('/api/customers/apply-segments', {
      method: 'POST'
    });
    return await res.json();
  },

  /**
   * Áp dụng rules cho 1 khách hàng
   */
  async applyToCustomer(customerId) {
    const res = await fetch(`/api/customers/${customerId}/apply-segment`, {
      method: 'POST'
    });
    return await res.json();
  }
};

// ============================================================
// SEGMENT UI COMPONENTS
// ============================================================

const SegmentUI = {
  /**
   * Render segment selector dropdown
   */
  renderSelector(selectedId = null, onChange = () => {}) {
    return `
      <select id="segmentSelector" onchange="SegmentUI.onSelect(this.value)" class="segment-select">
        <option value="">-- Chọn phân khúc --</option>
        ${window.__SEGMENTS__?.map(s => `
          <option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>
            ${s.icon || '👥'} ${s.name}
          </option>
        `).join('') || ''}
      </select>
    `;
  },

  /**
   * Render segment badge
   */
  renderBadge(segment) {
    if (!segment) return '';

    return `
      <span class="segment-badge" style="
        background: ${segment.color || '#3B82F6'}20;
        color: ${segment.color || '#3B82F6'};
        border: 1px solid ${segment.color || '#3B82F6'}40;
        padding: 2px 8px;
        border-radius: 12px;
        font-size: 12px;
        font-weight: 600;
      ">
        ${segment.icon || '👥'} ${segment.name}
      </span>
    `;
  },

  /**
   * Render segment stats card
   */
  renderStatsCard(segment, customerStats) {
    return `
      <div class="segment-stats-card" style="
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 16px;
        margin-bottom: 12px;
      ">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
          <div style="
            width: 48px;
            height: 48px;
            border-radius: 12px;
            background: ${segment.color || '#3B82F6'}20;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
          ">
            ${segment.icon || '👥'}
          </div>
          <div>
            <div style="font-weight:700;font-size:16px;">${segment.name}</div>
            <div style="font-size:12px;color:var(--text-secondary);">${segment.code}</div>
          </div>
        </div>

        ${segment.discount_percent > 0 ? `
          <div style="
            background: ${segment.color || '#3B82F6'}15;
            border-radius: 8px;
            padding: 8px 12px;
            margin-bottom: 12px;
            font-size: 14px;
          ">
            <span style="color:${segment.color || '#3B82F6'};font-weight:700;">
              Giảm ${segment.discount_percent}%
            </span>
            khi mua hàng
          </div>
        ` : ''}

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">
          <div>
            <div style="color:var(--text-secondary);">Đơn hàng</div>
            <div style="font-weight:600;">${customerStats.orderCount || 0}</div>
          </div>
          <div>
            <div style="color:var(--text-secondary);">Chi tiêu</div>
            <div style="font-weight:600;">${Format?.number(customerStats.totalSpent) || 0}đ</div>
          </div>
          <div>
            <div style="color:var(--text-secondary);">TB/đơn</div>
            <div style="font-weight:600;">${Format?.number(Math.round(customerStats.avgOrderValue)) || 0}đ</div>
          </div>
          <div>
            <div style="color:var(--text-secondary);">Số bình</div>
            <div style="font-weight:600;">${customerStats.totalQty || 0}</div>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * Render rules editor
   */
  renderRulesEditor(rules = {}) {
    return `
      <div class="segment-rules-editor" style="display:grid;gap:12px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">
            Số đơn tối thiểu
          </label>
          <input type="number" name="min_orders" value="${rules.min_orders || ''}"
                 placeholder="VD: 10" min="0"
                 style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text-primary);">
        </div>

        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">
            Chi tiêu tối thiểu (VNĐ)
          </label>
          <input type="number" name="min_spent" value="${rules.min_spent || ''}"
                 placeholder="VD: 5000000" min="0"
                 style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text-primary);">
        </div>

        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">
            Chi tiêu tối đa (VNĐ)
          </label>
          <input type="number" name="max_spent" value="${rules.max_spent || ''}"
                 placeholder="VD: 10000000 (để trống = không giới hạn)" min="0"
                 style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text-primary);">
        </div>

        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">
            Ngày không mua tối đa
          </label>
          <input type="number" name="last_order_days" value="${rules.last_order_days || ''}"
                 placeholder="VD: 30 ngày" min="0"
                 style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text-primary);">
        </div>

        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">
            Giá trị đơn TB tối thiểu (VNĐ)
          </label>
          <input type="number" name="avg_order_value" value="${rules.avg_order_value || ''}"
                 placeholder="VD: 500000" min="0"
                 style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text-primary);">
        </div>

        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">
            Số ngày làm thành viên tối thiểu
          </label>
          <input type="number" name="min_member_days" value="${rules.min_member_days || ''}"
                 placeholder="VD: 30 ngày" min="0"
                 style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text-primary);">
        </div>
      </div>
    `;
  },

  /**
   * Parse rules từ form
   */
  parseRulesFromForm(formElement) {
    const rules = {};

    const minOrders = formElement.querySelector('[name="min_orders"]')?.value;
    if (minOrders) rules.min_orders = parseInt(minOrders);

    const minSpent = formElement.querySelector('[name="min_spent"]')?.value;
    if (minSpent) rules.min_spent = parseFloat(minSpent);

    const maxSpent = formElement.querySelector('[name="max_spent"]')?.value;
    if (maxSpent) rules.max_spent = parseFloat(maxSpent);

    const lastOrderDays = formElement.querySelector('[name="last_order_days"]')?.value;
    if (lastOrderDays) rules.last_order_days = parseInt(lastOrderDays);

    const avgOrderValue = formElement.querySelector('[name="avg_order_value"]')?.value;
    if (avgOrderValue) rules.avg_order_value = parseFloat(avgOrderValue);

    const minMemberDays = formElement.querySelector('[name="min_member_days"]')?.value;
    if (minMemberDays) rules.min_member_days = parseInt(minMemberDays);

    return rules;
  }
};

// ============================================================
// DEFAULT SEGMENTS CONFIG
// ============================================================

const DEFAULT_SEGMENTS = [
  {
    name: 'Khách mới',
    code: 'new',
    color: '#10B981', // Green
    icon: '🌱',
    discount_percent: 0,
    priority: 1,
    rules: {
      min_orders: 0,
      max_spent: 1000000
    }
  },
  {
    name: 'Khách thường',
    code: 'regular',
    color: '#3B82F6', // Blue
    icon: '👤',
    discount_percent: 0,
    priority: 2,
    rules: {
      min_orders: 2,
      min_spent: 1000000
    }
  },
  {
    name: 'Khách VIP',
    code: 'vip',
    color: '#F59E0B', // Amber
    icon: '⭐',
    discount_percent: 5,
    priority: 3,
    rules: {
      min_orders: 10,
      min_spent: 10000000,
      avg_order_value: 500000
    }
  },
  {
    name: 'Khách suy giảm',
    code: 'inactive',
    color: '#EF4444', // Red
    icon: '📉',
    discount_percent: 0,
    priority: 1,
    rules: {
      last_order_days: 30
    }
  }
];

// Export
window.SegmentRules = SegmentRules;
window.SegmentAPI = SegmentAPI;
window.SegmentUI = SegmentUI;
window.DEFAULT_SEGMENTS = DEFAULT_SEGMENTS;