/**
 * Beer POS - WebSocket Client
 * Feature #14: Real-time dashboard update
 *
 * Kết nối WebSocket và xử lý các events:
 * - dashboard:stats - Cập nhật dashboard
 * - keg:state - Cập nhật trạng thái keg
 * - inventory:stats - Cập nhật tồn kho
 * - alert - Thông báo alerts
 */

class WebSocketClient {
  constructor(options = {}) {
    this.options = {
      url: options.url || this.getWebSocketUrl(),
      reconnectInterval: options.reconnectInterval || 5000,
      maxReconnectAttempts: options.maxReconnectAttempts || 10,
      ...options
    };

    this.socket = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.listeners = new Map();
    this.isConnected = false;

    // Auto-connect
    this.connect();
  }

  getWebSocketUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}`;
  }

  connect() {
    try {
      this.socket = io(this.options.url, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: this.options.reconnectInterval,
        reconnectionAttempts: this.options.maxReconnectAttempts
      });

      this.socket.on('connect', () => {
        console.log('[WS] Connected:', this.socket.id);
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.emit('connected', { socketId: this.socket.id });
      });

      this.socket.on('disconnect', (reason) => {
        console.log('[WS] Disconnected:', reason);
        this.isConnected = false;
        this.emit('disconnected', { reason });
      });

      this.socket.on('connect_error', (error) => {
        console.error('[WS] Connection error:', error);
        this.emit('error', { error });
      });

      // Dashboard stats
      this.socket.on('dashboard:stats', (data) => {
        console.log('[WS] Dashboard stats:', data);
        this.emit('dashboardStats', data);
      });

      // Keg state
      this.socket.on('keg:state', (data) => {
        console.log('[WS] Keg state:', data);
        this.emit('kegState', data);
      });

      // Keg updated
      this.socket.on('keg:updated', (data) => {
        console.log('[WS] Keg updated:', data);
        this.emit('kegUpdated', data);
      });

      // Inventory stats
      this.socket.on('inventory:stats', (data) => {
        console.log('[WS] Inventory stats:', data);
        this.emit('inventoryStats', data);
      });

      // Inventory updated
      this.socket.on('inventory:updated', (data) => {
        console.log('[WS] Inventory updated:', data);
        this.emit('inventoryUpdated', data);
      });

      // New sale
      this.socket.on('sale:created', (data) => {
        console.log('[WS] New sale:', data);
        this.emit('newSale', data);
      });

      // Alerts
      this.socket.on('alert', (data) => {
        console.log('[WS] Alert:', data);
        this.emit('alert', data);
      });

      // Sync status
      this.socket.on('sync:status', (data) => {
        console.log('[WS] Sync status:', data);
        this.emit('syncStatus', data);
      });

      // Ping
      this.socket.on('dashboard:ping', (data) => {
        this.emit('ping', data);
      });

    } catch (error) {
      console.error('[WS] Failed to connect:', error);
    }
  }

  // Event emitter methods
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
    return this;
  }

  off(event, callback) {
    if (!this.listeners.has(event)) return this;
    const callbacks = this.listeners.get(event);
    const index = callbacks.indexOf(callback);
    if (index > -1) {
      callbacks.splice(index, 1);
    }
    return this;
  }

  emit(event, data) {
    if (!this.listeners.has(event)) return;
    this.listeners.get(event).forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`[WS] Error in ${event} handler:`, error);
      }
    });
  }

  // Request methods
  requestDashboardStats() {
    this.socket?.emit('get:dashboard');
  }

  requestKegState() {
    this.socket?.emit('get:keg');
  }

  requestInventoryStats() {
    this.socket?.emit('get:inventory');
  }

  joinRoom(room) {
    this.socket?.emit('join', room);
  }

  leaveRoom(room) {
    this.socket?.emit('leave', room);
  }

  // Disconnect
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.disconnect();
    this.socket = null;
    this.isConnected = false;
  }

  // Reconnect
  reconnect() {
    this.disconnect();
    this.reconnectAttempts = 0;
    this.connect();
  }

  // Check connection status
  getStatus() {
    return {
      connected: this.isConnected,
      socketId: this.socket?.id,
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

// ==================== Dashboard Integration ====================

// Global WebSocket instance
let wsClient = null;

/**
 * Initialize WebSocket and update dashboard
 */
function initWebSocketDashboard() {
  // Get WebSocket URL from meta tag or default
  const wsUrl = document.querySelector('meta[name="ws-url"]')?.content || '';

  wsClient = new WebSocketClient({ url: wsUrl });

  // Dashboard stats update
  wsClient.on('dashboardStats', (data) => {
    updateDashboardStats(data);
  });

  // Keg state update
  wsClient.on('kegState', (data) => {
    updateKegDisplay(data);
  });

  // Alert notification
  wsClient.on('alert', (data) => {
    showAlert(data);
  });

  return wsClient;
}

/**
 * Update dashboard stats display
 */
function updateDashboardStats(data) {
  // Update today's revenue
  const todayRevenue = document.getElementById('today-revenue');
  if (todayRevenue && data.today) {
    todayRevenue.textContent = formatCurrency(data.today.revenue);
  }

  // Update today's profit
  const todayProfit = document.getElementById('today-profit');
  if (todayProfit && data.today) {
    todayProfit.textContent = formatCurrency(data.today.profit);
  }

  // Update today's orders
  const todayOrders = document.getElementById('today-orders');
  if (todayOrders && data.today) {
    todayOrders.textContent = data.today.orders;
  }

  // Update alerts
  const lowStockBadge = document.getElementById('low-stock-badge');
  if (lowStockBadge && data.alerts) {
    lowStockBadge.textContent = data.alerts.lowStock;
    lowStockBadge.style.display = data.alerts.lowStock > 0 ? 'inline' : 'none';
  }

  // Update charts if Chart.js is available
  if (typeof updateCharts === 'function' && data.today) {
    updateCharts(data);
  }
}

/**
 * Update keg display
 */
function updateKegDisplay(state) {
  const kegInventory = document.getElementById('keg-inventory');
  if (kegInventory) {
    kegInventory.textContent = state.inventory || 0;
  }

  const kegEmpty = document.getElementById('keg-empty');
  if (kegEmpty) {
    kegEmpty.textContent = state.empty || 0;
  }

  const kegCustomer = document.getElementById('keg-customer');
  if (kegCustomer) {
    kegCustomer.textContent = state.customer || 0;
  }
}

/**
 * Show alert notification
 */
function showAlert(data) {
  if (typeof toastr !== 'undefined') {
    toastr[data.type]?.(data.message) || toastr.info(data.message);
  } else if (typeof Swal !== 'undefined') {
    Swal.fire({
      title: data.type === 'error' ? 'Lỗi!' : 'Thông báo',
      text: data.message,
      icon: data.type || 'info',
      timer: 3000,
      showConfirmButton: false
    });
  } else {
    alert(`${data.type?.toUpperCase()}: ${data.message}`);
  }
}

/**
 * Format currency
 */
function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND'
  }).format(amount || 0);
}

// Export for use
window.WebSocketClient = WebSocketClient;
window.initWebSocketDashboard = initWebSocketDashboard;
window.wsClient = wsClient;
