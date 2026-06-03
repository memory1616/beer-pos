// BeerPOS Delivery - Simplified
(function() {
  var data = window.__DELIVERY_DATA__ || {};
  var customers = data.customers || [];
  var settings = data.settings || {};
  
  var state = {
    deliveryCostPerKm: settings.delivery_cost_per_km || 3000,
    distributorLat: settings.distributor_lat || 10.7679,
    distributorLng: settings.distributor_lng || 106.6893,
    currentLat: null,
    currentLng: null,
    map: null,
    userMarker: null
  };

  // Distance calculation
  function calcDistance(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  // Initialize map
  function initMap() {
    if (typeof L === 'undefined') {
      return;
    }

    state.map = L.map('map', {
      center: [state.distributorLat, state.distributorLng],
      zoom: 12,
      zoomControl: true
    });

    // Dark tile
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO',
      maxZoom: 19
    }).addTo(state.map);

    // Warehouse marker
    L.marker([state.distributorLat, state.distributorLng], {
      icon: L.divIcon({
        className: 'warehouse-marker',
        html: '<div style="background:#22c55e;width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      })
    }).addTo(state.map).bindPopup('🏭 Kho');

    // Customer markers
    customers.forEach(function(c) {
      if (c.lat && c.lng) {
        L.marker([parseFloat(c.lat), parseFloat(c.lng)], {
          icon: L.divIcon({
            className: 'customer-marker',
            html: '<div style="background:#3b82f6;width:10px;height:10px;border-radius:50%;border:2px solid white;"></div>',
            iconSize: [10, 10],
            iconAnchor: [5, 5]
          })
        }).addTo(state.map).bindPopup('<b>' + (c.name || '') + '</b><br>' + (c.phone || ''));
      }
    });

    updateUI();
  }

  // Update UI
  function updateUI() {
    var container = document.getElementById('customersList');
    var countEl = document.getElementById('pendingCount');
    var kmEl = document.getElementById('totalKm');
    
    if (countEl) countEl.textContent = customers.length;
    
    if (!container) return;
    
    if (customers.length === 0) {
      container.innerHTML = '<div class="empty-state">Chưa có đơn hàng nào hôm nay</div>';
      if (kmEl) kmEl.textContent = '0';
      return;
    }

    var totalKm = 0;
    var html = '';
    
    customers.forEach(function(c) {
      var d = calcDistance(
        state.currentLat || state.distributorLat,
        state.currentLng || state.distributorLng,
        parseFloat(c.lat), parseFloat(c.lng)
      );
      totalKm += d;
      
      html += '<div class="delivery-card">' +
        '<div class="name">' + (c.name || 'Khách hàng') + '</div>' +
        '<div class="info">📞 ' + (c.phone || 'Không có SDT') + ' | 📍 ' + d.toFixed(1) + ' km</div>' +
        '<div class="actions">' +
          '<a href="https://www.google.com/maps/dir/?api=1&destination=' + c.lat + ',' + c.lng + '" target="_blank" class="btn btn-secondary btn-sm">🗺️ Chỉ đường</a>' +
          '<button onclick="window.location.href=\'/sale?customerId=' + c.id + '\'" class="btn btn-primary btn-sm">📦 Tạo đơn</button>' +
        '</div>' +
      '</div>';
    });
    
    container.innerHTML = html;
    if (kmEl) kmEl.textContent = totalKm.toFixed(1);
  }

  // Get current location
  window.getCurrentLocation = function() {
    if (!navigator.geolocation) {
      alert('GPS không được hỗ trợ');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      function(pos) {
        state.currentLat = pos.coords.latitude;
        state.currentLng = pos.coords.longitude;
        
        if (state.map) {
          state.map.setView([state.currentLat, state.currentLng], 14);
          
          if (state.userMarker) state.map.removeLayer(state.userMarker);
          state.userMarker = L.marker([state.currentLat, state.currentLng], {
            icon: L.divIcon({
              className: 'user-marker',
              html: '<div style="background:#ef4444;width:16px;height:16px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>',
              iconSize: [16, 16],
              iconAnchor: [8, 8]
            })
          }).addTo(state.map).bindPopup('📍 Vị trí của bạn');
        }
        
        updateUI();
        alert('Đã cập nhật vị trí!');
      },
      function(err) {
        alert('Không lấy được GPS: ' + err.message);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Optimize route
  window.optimizeRoute = function() {
    if (customers.length === 0) return;
    
    var originLat = state.currentLat || state.distributorLat;
    var originLng = state.currentLng || state.distributorLng;
    
    // Simple sort by distance
    customers.sort(function(a, b) {
      var da = calcDistance(originLat, originLng, parseFloat(a.lat), parseFloat(a.lng));
      var db = calcDistance(originLat, originLng, parseFloat(b.lat), parseFloat(b.lng));
      return da - db;
    });
    
    updateUI();
    alert('Đã sắp xếp theo khoảng cách gần nhất!');
  };

  // Settings modal
  window.showSettings = function() {
    var modal = document.getElementById('settingsModal');
    var costEl = document.getElementById('deliveryCostPerKm');
    var latEl = document.getElementById('distributorLat');
    var lngEl = document.getElementById('distributorLng');
    
    if (costEl) costEl.value = state.deliveryCostPerKm;
    if (latEl) latEl.value = state.distributorLat;
    if (lngEl) lngEl.value = state.distributorLng;
    
    if (modal) modal.style.display = 'flex';
  };

  window.hideSettings = function() {
    var modal = document.getElementById('settingsModal');
    if (modal) modal.style.display = 'none';
  };

  window.saveSettings = async function() {
    var costEl = document.getElementById('deliveryCostPerKm');
    var latEl = document.getElementById('distributorLat');
    var lngEl = document.getElementById('distributorLng');
    
    state.deliveryCostPerKm = parseFloat(costEl.value) || 3000;
    state.distributorLat = parseFloat(latEl.value) || 10.7679;
    state.distributorLng = parseFloat(lngEl.value) || 106.6893;
    
    try {
      await fetch('/api/settings/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          delivery_cost_per_km: state.deliveryCostPerKm,
          distributor_lat: state.distributorLat,
          distributor_lng: state.distributorLng
        })
      });
      hideSettings();
      updateUI();
      alert('Đã lưu!');
    } catch(e) {
      alert('Lỗi lưu cấu hình');
    }
  };

  // Init
  function init() {
    initMap();
  }

  // Wait for DOM and Leaflet
  function waitForIt() {
    if (document.getElementById('map') && typeof L !== 'undefined') {
      init();
    } else {
      setTimeout(waitForIt, 100);
    }
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForIt);
  } else {
    waitForIt();
  }
})();
