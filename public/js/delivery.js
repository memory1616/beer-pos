// BeerPOS Delivery Page — extracted from inline script
// PERFORMANCE: Separated from HTML, loaded only when delivery page is visited
(function() {
  var data = window.__DELIVERY_DATA__ || {};
  var customers = data.customers || [];
  var defaultSettings = {
    deliveryCostPerKm: data.settings && data.settings.delivery_cost_per_km || 3000,
    deliveryBaseCost: data.settings && data.settings.delivery_base_cost || 0,
    distributorLat: data.settings && data.settings.distributor_lat || 10.8231,
    distributorLng: data.settings && data.settings.distributor_lng || 106.6297
  };
  var distributorName = data.distributorName || 'Bia Tuoi';

  var currentLat = null;
  var currentLng = null;
  var map, userMarker, routeLine;
  var routePolylines = [];

  var nameEl = document.getElementById('distributorName');
  if (nameEl) nameEl.textContent = distributorName;

  var costPerKmEl = document.getElementById('deliveryCostPerKm');
  var baseCostEl = document.getElementById('deliveryBaseCost');
  var distLatEl = document.getElementById('distributorLat');
  var distLngEl = document.getElementById('distributorLng');
  if (costPerKmEl) costPerKmEl.value = defaultSettings.deliveryCostPerKm;
  if (baseCostEl) baseCostEl.value = defaultSettings.deliveryBaseCost;
  if (distLatEl) distLatEl.value = defaultSettings.distributorLat;
  if (distLngEl) distLngEl.value = defaultSettings.distributorLng;

  var SESSION_CACHE_KEY = 'delivery_route_cache_v1';
  var _routeCache = {};
  try { var stored = JSON.parse(sessionStorage.getItem(SESSION_CACHE_KEY) || '{}'); for (var k in stored) _routeCache[k] = stored[k]; } catch(_){}

  function _saveRouteCache() { try { sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(_routeCache)); } catch(_){} }
  function _getCacheKey(lat1, lng1, lat2, lng2) { return lat1.toFixed(5) + ',' + lng1.toFixed(5) + '-' + lat2.toFixed(5) + ',' + lng2.toFixed(5); }
  function _getCache(lat1, lng1, lat2, lng2) { return _routeCache[_getCacheKey(lat1, lng1, lat2, lng2)] || null; }
  function _setCache(lat1, lng1, lat2, lng2, val) { _routeCache[_getCacheKey(lat1, lng1, lat2, lng2)] = val; _saveRouteCache(); }

  function decodePolyline(encoded) {
    var poly = []; var index = 0; var lat = 0; var lng = 0;
    while (index < encoded.length) {
      var b, shift = 0, result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : result >> 1;
      shift = 0; result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : result >> 1;
      poly.push([lat / 1e5, lng / 1e5]);
    }
    return poly;
  }

  function clearRouteLines() { routePolylines.forEach(function(p) { map.removeLayer(p); }); routePolylines = []; }

  function calculateDistance(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  var _queue = [], _queueRunning = false;
  var QUEUE_DELAY_MS = 600;

  function _enqueueRouteTask(task) {
    return new Promise(function(resolve, reject) {
      _queue.push({ task: task, resolve: resolve, reject: reject });
      if (!_queueRunning) _processQueue();
    });
  }

  async function _processQueue() {
    if (_queue.length === 0) { _queueRunning = false; return; }
    _queueRunning = true;
    while (_queue.length > 0) {
      var item = _queue.shift();
      try { item.resolve(await _fetchRouteWithRetry(item.task.originLat, item.task.originLng, item.task.destLat, item.task.destLng)); }
      catch(e) { item.reject(e); }
      if (_queue.length > 0) await new Promise(function(r) { setTimeout(r, QUEUE_DELAY_MS); });
    }
    _queueRunning = false;
  }

  async function _fetchRouteWithRetry(originLat, originLng, destLat, destLng, attempt) {
    attempt = attempt || 0;
    try {
      var res = await fetch('/api/routing/route?originLat=' + originLat + '&originLng=' + originLng + '&destLat=' + destLat + '&destLng=' + destLng);
      if (res.status === 429 && attempt < 2) { await new Promise(function(r) { setTimeout(r, (attempt+1)*1000); }); return _fetchRouteWithRetry(originLat, originLng, destLat, destLng, attempt+1); }
      if (!res.ok) throw new Error('API error ' + res.status);
      var json = await res.json();
      _setCache(originLat, originLng, destLat, destLng, json);
      return json;
    } catch(e) {
      return { distance_km: calculateDistance(originLat, originLng, destLat, destLng), duration_min: 0, polyline: null };
    }
  }

  function getRealRoute(originLat, originLng, destLat, destLng) {
    var cached = _getCache(originLat, originLng, destLat, destLng);
    if (cached) return Promise.resolve(cached);
    return _enqueueRouteTask({ originLat: originLat, originLng: originLng, destLat: destLat, destLng: destLng });
  }

  function calculateCost(distance) { return Math.round(defaultSettings.deliveryBaseCost + (distance * defaultSettings.deliveryCostPerKm)); }

  function renderCustomerCards() {
    var container = document.getElementById('customersList');
    if (!container) return;
    container.innerHTML = '';
    for (var i = 0; i < customers.length; i++) {
      var c = customers[i];
      if (!c.lat || !c.lng) continue;
      var card = document.createElement('div');
      card.className = 'delivery-card card card--list-item';
      card.dataset.lat = c.lat;
      card.dataset.lng = c.lng;
      card.dataset.name = (c.name || '').replace(/"/g, '&quot;');
      card.innerHTML =
        '<div class="flex justify-between items-start gap-3">' +
          '<div class="min-w-0 flex-1"><div class="font-bold text-main truncate">' + (c.name || '') + '</div><div class="text-sm text-muted">' + (c.phone || '') + '</div></div>' +
          '<div class="text-right shrink-0"><div class="text-sm text-muted">Khoảng cách: <span class="distance font-bold text-info">-</span> km</div><div class="delivery-fee mt-0.5"><div class="money text-money"><span class="value text-sm font-bold tabular-nums">-</span><span class="unit">đ</span></div></div></div>' +
        '</div>' +
        '<div class="flex gap-2 mt-2">' +
          '<a href="https://www.google.com/maps/dir/?api=1&destination=' + c.lat + ',' + c.lng + '" target="_blank" class="flex-1 text-center btn btn-secondary btn-sm">D Chỉ đường</a>' +
          '<button onclick="startDelivery(' + c.lat + ', ' + c.lng + ', ' + (c.id || 0) + ')" class="flex-1 btn btn-warning btn-sm">🚀 Giao hàng</button>' +
        '</div>';
      container.appendChild(card);
    }
  }

  var _distDebounceTimer = null;
  function updateDistances() { clearTimeout(_distDebounceTimer); _distDebounceTimer = setTimeout(_doUpdateDistances, 500); }
  window.updateDistances = updateDistances;

  async function _doUpdateDistances() {
    var originLat = currentLat || defaultSettings.distributorLat;
    var originLng = currentLng || defaultSettings.distributorLng;
    var totalDistance = 0, totalFee = 0;
    var cards = document.querySelectorAll('.delivery-card');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var d = parseFloat(card.dataset.realDistance) || 0;
      var cost = d > 0 ? calculateCost(d) : 0;
      var distEl = card.querySelector('.distance');
      var feeEl = card.querySelector('.delivery-fee');
      if (distEl) distEl.textContent = d > 0 ? d.toFixed(1) : '-';
      if (feeEl) feeEl.innerHTML = d > 0 ? cost.toLocaleString('vi-VN') + ' đ' : '-';
      if (d > 0) { totalDistance += d; totalFee += cost; }
    }
    var tdEl = document.getElementById('totalDistance');
    var tfEl = document.getElementById('totalDeliveryFee');
    if (tdEl) tdEl.textContent = totalDistance.toFixed(1);
    if (tfEl) tfEl.innerHTML = '<span class="value font-bold tabular-nums">' + totalFee.toLocaleString('vi-VN') + '</span><span class="unit">đ</span>';
  }

  async function optimizeRoute() {
    var originLat = currentLat || defaultSettings.distributorLat;
    var originLng = currentLng || defaultSettings.distributorLng;
    var cards = document.querySelectorAll('.delivery-card');
    if (cards.length === 0) return;
    var btn = document.querySelector('[onclick="optimizeRoute()"]');
    if (btn) { btn.innerHTML = '⏳ Đang tính...'; btn.disabled = true; }
    try {
      var withDistances = [];
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var lat = parseFloat(card.dataset.lat), lng = parseFloat(card.dataset.lng);
        var route = await getRealRoute(originLat, originLng, lat, lng);
        card.dataset.realDistance = route.distance_km;
        card.dataset.duration = route.duration_min;
        card.dataset.polyline = route.polyline || '';
        withDistances.push({ card: card, distance: route.distance_km, lat: lat, lng: lng });
      }
      withDistances.sort(function(a, b) { return a.distance - b.distance; });
      var container = document.getElementById('customersList');
      for (var j = 0; j < withDistances.length; j++) { container.appendChild(withDistances[j].card); }
      clearRouteLines();
      var totalDist = withDistances.reduce(function(s, d) { return s + d.distance; }, 0);
      alert('Đã tối ưu lộ trình! Tổng khoảng cách: ' + totalDist.toFixed(1) + ' km');
      await updateDistances();
    } catch(e) { alert('Lỗi tối ưu: ' + e.message); }
    finally { if (btn) { btn.innerHTML = '⚡ Tối ưu lộ trình'; btn.disabled = false; } }
  }
  window.optimizeRoute = optimizeRoute;

  if (typeof L !== 'undefined') {
    map = L.map('map').setView([defaultSettings.distributorLat, defaultSettings.distributorLng], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
    for (var k = 0; k < customers.length; k++) {
      var c2 = customers[k];
      if (c2.lat && c2.lng) L.marker([c2.lat, c2.lng]).addTo(map).bindPopup('<b>' + (c2.name||'') + '</b><br>' + (c2.phone||''));
    }
  }

  renderCustomerCards();
  updateDistances();

  window.getCurrentLocation = function() {
    if (!navigator.geolocation) { alert('Trình duyệt không hỗ trợ GPS'); return; }
    navigator.geolocation.getCurrentPosition(
      function(position) {
        currentLat = position.coords.latitude;
        currentLng = position.coords.longitude;
        if (userMarker) map.removeLayer(userMarker);
        if (routeLine) map.removeLayer(routeLine);
        userMarker = L.marker([currentLat, currentLng], { icon: L.divIcon({ className: 'bg-primary rounded-full w-4 h-4 border-2 border-muted', iconSize: [16,16] }) }).addTo(map).bindPopup('📍 Vị trí của bạn').openPopup();
        map.setView([currentLat, currentLng], 14);
        updateDistances();
      },
      function(error) { alert('Không lấy được vị trí: ' + error.message); },
      { enableHighAccuracy: true }
    );
  };

  window.startDelivery = async function(lat, lng, customerId) {
    var originLat = currentLat || defaultSettings.distributorLat;
    var originLng = currentLng || defaultSettings.distributorLng;
    var card = null;
    var cards = document.querySelectorAll('.delivery-card');
    for (var i = 0; i < cards.length; i++) {
      if (parseFloat(cards[i].dataset.lat) === lat && parseFloat(cards[i].dataset.lng) === lng) { card = cards[i]; break; }
    }
    var distance = 0, duration = 0, polyline = '';
    if (card && card.dataset.realDistance) {
      distance = parseFloat(card.dataset.realDistance);
      duration = parseInt(card.dataset.duration) || 0;
      polyline = card.dataset.polyline || '';
    } else {
      var route = await getRealRoute(originLat, originLng, lat, lng);
      distance = route.distance_km; duration = route.duration_min; polyline = route.polyline || '';
    }
    var cost = calculateCost(distance);
    var timeStr = duration > 0 ? '\nThời gian: ' + duration + ' phút' : '';
    if (confirm('Xác nhận giao hàng cho khách?' + timeStr + '\n\nKhoảng cách: ' + distance.toFixed(1) + ' km\nPhí vận chuyển: ' + cost.toLocaleString('vi-VN') + ' đ')) {
      var url = '/sale?customerId=' + customerId + '&deliveryCost=' + cost + '&distance=' + distance.toFixed(1);
      if (duration > 0) url += '&duration=' + duration;
      if (polyline) url += '&polyline=' + encodeURIComponent(polyline);
      window.location.href = url;
    }
  };

  window.showSettings = function() {
    var m = document.getElementById('settingsModal');
    if (m) { m.classList.remove('hidden'); m.classList.add('flex'); }
  };
  window.hideSettings = function() {
    var m = document.getElementById('settingsModal');
    if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
  };

  window.getDistributorLocation = function() {
    if (!navigator.geolocation) { alert('Trình duyệt không hỗ trợ GPS'); return; }
    navigator.geolocation.getCurrentPosition(
      function(position) {
        var latEl = document.getElementById('distributorLat');
        var lngEl = document.getElementById('distributorLng');
        if (latEl) latEl.value = position.coords.latitude.toFixed(6);
        if (lngEl) lngEl.value = position.coords.longitude.toFixed(6);
      },
      function(error) { alert('Không lấy được vị trí: ' + error.message); }
    );
  };

  window.saveSettings = async function() {
    var settings = {
      delivery_cost_per_km: (document.getElementById('deliveryCostPerKm') || {value:''}).value,
      delivery_base_cost: (document.getElementById('deliveryBaseCost') || {value:''}).value,
      distributor_lat: (document.getElementById('distributorLat') || {value:''}).value,
      distributor_lng: (document.getElementById('distributorLng') || {value:''}).value
    };
    try {
      var res = await fetch('/api/settings/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
      if (res.ok) {
        defaultSettings.deliveryCostPerKm = parseFloat(settings.delivery_cost_per_km) || 3000;
        defaultSettings.deliveryBaseCost = parseFloat(settings.delivery_base_cost) || 0;
        defaultSettings.distributorLat = parseFloat(settings.distributor_lat) || 10.8231;
        defaultSettings.distributorLng = parseFloat(settings.distributor_lng) || 106.6297;
        hideSettings();
        updateDistances();
        alert('Đã lưu cấu hình!');
      } else { alert('Lỗi lưu cấu hình'); }
    } catch(err) { alert('Lỗi: ' + err.message); }
  };
})();
