const express = require('express');
const router = express.Router();
const db = require('../database');
const logger = require('../src/utils/logger');

const DISTRIBUTOR_NAME = 'Bia Tươi Gia Huy';

// GET /delivery
router.get('/', (req, res, next) => {
  try {
  const customers = db.prepare(`
    SELECT * FROM customers WHERE archived = 0 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY name
  `).all();

  const settings = db.prepare('SELECT * FROM settings').all();
  const settingsObj = {};
  settings.forEach(s => settingsObj[s.key] = s.value);

  // Check if Google API key is configured
  const hasGoogleApi = process.env.GOOGLE_MAPS_API_KEY ? true : false;

  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Giao hàng</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#f59e0b">
  <meta name="mobile-web-app-capable" content="yes">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="icon" type="image/png" href="/icon-192.png">
  <link rel="stylesheet" href="/css/tailwind.css">
  <link rel="stylesheet" href="/css/unified.css">
  <script src="/js/dark-mode.js"><\/script>
  <link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet/dist/leaflet.js"><\/script>
  <style>
    .pb-safe { padding-bottom: env(safe-area-inset-bottom, 20px); }
    .bottomnav { max-width: 500px; margin: auto; }
    /* Gói bản đồ trong stacking context riêng — Leaflet dùng z-index 400–1000 bên trong */
    .delivery-map-wrap {
      position: relative;
      z-index: 0;
      isolation: isolate;
      overflow: hidden;
      border-radius: 12px;
      margin-bottom: 1rem;
    }
    .delivery-map-wrap #map {
      height: 50vh;
      margin-bottom: 0;
    }
    .delivery-map-wrap .leaflet-container { z-index: 0 !important; }
    .delivery-card { transition: all 0.2s; }
    .delivery-card:active { transform: scale(0.98); }
    /* Modal cài đặt phải cao hơn mọi lớp Leaflet + thanh dưới */
    #settingsModal { z-index: 10000 !important; }
    .settings-modal-inner {
      max-height: 85vh;
      overflow-y: auto;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
    }
  </style>
</head>
<body class="bg-bg text-main min-h-screen pb-24">
  <header class="sticky top-0 bg-card/90 backdrop-blur border-b border-muted shadow-sm z-50 pb-safe">
    <div class="flex items-center justify-between px-4 py-3">
      <div class="flex items-center gap-2">
        <a href="/" class="text-muted">←</a>
        <span class="font-bold text-main">${DISTRIBUTOR_NAME}</span>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="showSettings()" class="text-muted p-2">⚙️</button>
        <span class="text-sm text-muted">Giao hàng</span>
      </div>
    </div>
    <div class="px-4 pb-2">
      <div class="flex items-center justify-between text-sm">
        <span class="text-muted">Khoảng cách: <span id="totalDistance" class="font-bold text-info">0</span> km</span>
        <span class="text-muted">Phí vận chuyển: <span id="totalDeliveryFee" class="font-bold text-money">0 đ</span></span>
      </div>
      <p class="text-xs text-muted mt-1">📦 Xuất phát từ <strong>kho</strong> (bấm ⚙️ để cài). Bấm <strong>📍 Vị trí hiện tại</strong> nếu muốn tính từ xe/điện thoại.</p>
    </div>
  </header>

  <main class="p-4 pt-14 pb-24 max-w-md mx-auto relative z-0">
    <div class="delivery-map-wrap">
      <div id="map"></div>
    </div>

    <div class="flex gap-2 mb-4">
      <button onclick="getCurrentLocation()" class="flex-1 btn btn-primary flex items-center justify-center gap-2">
        📍 Vị trí hiện tại
      </button>
      <button onclick="optimizeRoute()" class="flex-1 btn btn-secondary">
        ⚡ Tối ưu lộ trình
      </button>
    </div>

    <div id="customersList" class="space-y-2">
      ${customers.map(c => `
        <div class="delivery-card card p-3" data-lat="${c.lat}" data-lng="${c.lng}" data-name="${c.name}">
          <div class="flex justify-between items-start">
            <div>
              <div class="font-bold text-main">${c.name}</div>
              <div class="text-sm text-muted">${c.phone || ''}</div>
            </div>
            <div class="text-right">
              <div class="text-sm text-muted">Khoảng cách: <span class="distance font-bold text-info">-</span> km</div>
              <div class="text-sm font-bold text-money delivery-fee">-</div>
            </div>
          </div>
          <div class="flex gap-2 mt-2">
            <a href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}"
               target="_blank"
               class="flex-1 text-center btn btn-secondary btn-sm">📍 Chỉ đường</a>
            <button onclick="startDelivery(${c.lat}, ${c.lng}, ${c.id})"
                    class="flex-1 btn btn-warning btn-sm">
              🚀 Giao hàng
            </button>
          </div>
        </div>
      `).join('')}
    </div>
  </main>

  <!-- Settings Modal -->
  <div id="settingsModal" class="fixed inset-0 bg-overlay hidden items-center justify-center p-4" style="z-index:10000">
    <div class="card p-6 max-w-sm w-full settings-modal-inner relative" style="z-index:10001">
      <h2 class="text-xl font-bold mb-4">⚙️ Cấu hình vận chuyển</h2>

      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-main mb-1">Phí/km (đ)</label>
          <input type="number" id="deliveryCostPerKm" value="${settingsObj.delivery_cost_per_km || 3000}"
                 class="w-full border border-muted rounded-lg px-3 py-2" min="0" step="100">
        </div>

        <div>
          <label class="block text-sm font-medium text-main mb-1">Phí cơ bản (đ)</label>
          <input type="number" id="deliveryBaseCost" value="${settingsObj.delivery_base_cost || 0}"
                 class="w-full border border-muted rounded-lg px-3 py-2" min="0">
        </div>

        <div class="border-t border-muted pt-4">
          <label class="block text-sm font-medium text-main mb-1">📍 Vị trí kho/xưởng</label>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-xs text-muted">Vĩ độ</label>
              <input type="number" id="distributorLat" value="${settingsObj.distributor_lat || 10.8231}"
                     class="w-full border border-muted rounded-lg px-3 py-2" step="0.0001">
            </div>
            <div>
              <label class="text-xs text-muted">Kinh độ</label>
              <input type="number" id="distributorLng" value="${settingsObj.distributor_lng || 106.6297}"
                     class="w-full border border-muted rounded-lg px-3 py-2" step="0.0001">
            </div>
          </div>
          <button onclick="getDistributorLocation()" class="mt-2 text-sm text-info">📍 Lấy vị trí hiện tại</button>
        </div>
      </div>

      <div class="flex gap-2 mt-6">
        <button onclick="hideSettings()" class="flex-1 btn btn-ghost">Hủy</button>
        <button onclick="saveSettings()" class="flex-1 btn btn-primary">Lưu</button>
      </div>
    </div>
  </div>

  <nav class="bottomnav pb-safe">
    <a href="/">
      <span class="icon">🏠</span>
      <span>Home</span>
    </a>
    <a href="/delivery" class="active">
      <span class="icon">🚚</span>
      <span>Giao</span>
    </a>
    <a href="/sale">
      <span class="icon">🍺</span>
      <span>Bán</span>
    </a>
    <a href="/customers">
      <span class="icon">👤</span>
      <span>KH</span>
    </a>
    <a href="/devices">
      <span class="icon">📦</span>
      <span>TB</span>
    </a>
  </nav>

  <script>
    const customers = ${JSON.stringify(customers)};
    const hasGoogleApi = ${hasGoogleApi};
    const defaultSettings = {
      deliveryCostPerKm: parseFloat('${settingsObj.delivery_cost_per_km || 3000}'),
      deliveryBaseCost: parseFloat('${settingsObj.delivery_base_cost || 0}'),
      distributorLat: parseFloat('${settingsObj.distributor_lat || 10.8231}'),
      distributorLng: parseFloat('${settingsObj.distributor_lng || 106.6297}')
    };

    let currentLat = null;
    let currentLng = null;
    let map, userMarker, routeLine;
    let routePolylines = [];

    // Decode Google Maps encoded polyline
    function decodePolyline(encoded) {
      const poly = [];
      let index = 0;
      let lat = 0;
      let lng = 0;

      while (index < encoded.length) {
        let b;
        let shift = 0;
        let result = 0;
        
        do {
          b = encoded.charCodeAt(index++) - 63;
          result |= (b & 0x1f) << shift;
          shift += 5;
        } while (b >= 0x20);
        
        const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
        lat += dlat;

        shift = 0;
        result = 0;
        
        do {
          b = encoded.charCodeAt(index++) - 63;
          result |= (b & 0x1f) << shift;
          shift += 5;
        } while (b >= 0x20);
        
        const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
        lng += dlng;

        poly.push([lat / 1e5, lng / 1e5]);
      }

      return poly;
    }

    // Clear existing polylines
    function clearRouteLines() {
      routePolylines.forEach(p => map.removeLayer(p));
      routePolylines = [];
    }

    // Calculate distance using Haversine formula (fallback)
    function calculateDistance(lat1, lng1, lat2, lng2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLng/2) * Math.sin(dLng/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return R * c;
    }

    // ─── Rate-limited request queue for routing API ─────────────────────────────────
    const SESSION_CACHE_KEY = 'delivery_route_cache_v1';
    const _routeCache = JSON.parse(sessionStorage.getItem(SESSION_CACHE_KEY) || '{}');
    function _saveRouteCache() { try { sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(_routeCache)); } catch(e){} }

    function _getCache(lat1, lng1, lat2, lng2) {
      const k = `${Number(lat1).toFixed(5)},${Number(lng1).toFixed(5)}-${Number(lat2).toFixed(5)},${Number(lng2).toFixed(5)}`;
      return _routeCache[k] || null;
    }
    function _setCache(lat1, lng1, lat2, lng2, data) {
      const k = `${Number(lat1).toFixed(5)},${Number(lng1).toFixed(5)}-${Number(lat2).toFixed(5)},${Number(lng2).toFixed(5)}`;
      _routeCache[k] = data;
      _saveRouteCache();
    }

    // Queue state
    let _queue = [];
    let _queueRunning = false;
    const QUEUE_DELAY_MS = 600;   // at most ~1 request/sec (OSRM limit)

    function _enqueueRouteTask(task) {
      return new Promise((resolve, reject) => {
        _queue.push({ task, resolve, reject });
        if (!_queueRunning) _processQueue();
      });
    }

    async function _processQueue() {
      if (_queue.length === 0) { _queueRunning = false; return; }
      _queueRunning = true;
      while (_queue.length > 0) {
        const { task, resolve, reject } = _queue.shift();
        try {
          const result = await _fetchRouteWithRetry(task.originLat, task.originLng, task.destLat, task.destLng);
          resolve(result);
        } catch(e) {
          reject(e);
        }
        if (_queue.length > 0) await _sleep(QUEUE_DELAY_MS);
      }
      _queueRunning = false;
    }

    function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async function _fetchRouteWithRetry(originLat, originLng, destLat, destLng, attempt = 0) {
      const MAX_ATTEMPTS = 2;
      try {
        const res = await fetch('/api/routing/route?originLat=' + originLat + '&originLng=' + originLng + '&destLat=' + destLat + '&destLng=' + destLng);
        if (res.status === 429) {
          if (attempt < MAX_ATTEMPTS) {
            const waitMs = (attempt + 1) * 1000; // 1s, 2s
            console.warn('OSRM rate-limited (429), retrying in', waitMs, 'ms…');
            await _sleep(waitMs);
            return _fetchRouteWithRetry(originLat, originLng, destLat, destLng, attempt + 1);
          }
          throw new Error('429 Too Many Requests');
        }
        if (!res.ok) throw new Error('API error ' + res.status);
        const data = await res.json();
        _setCache(originLat, originLng, destLat, destLng, data);
        return data;
      } catch(e) {
        // Fallback: use straight-line Haversine distance
        const dist = calculateDistance(originLat, originLng, destLat, destLng);
        return { distance_km: dist, duration_min: 0, polyline: null };
      }
    }

    // Get real driving distance — now rate-limited & cached
    async function getRealRoute(originLat, originLng, destLat, destLng) {
      const cached = _getCache(originLat, originLng, destLat, destLng);
      if (cached) return cached;
      return _enqueueRouteTask({ originLat, originLng, destLat, destLng });
    }

    // Calculate delivery cost
    function calculateCost(distance) {
      return Math.round(defaultSettings.deliveryBaseCost + (distance * defaultSettings.deliveryCostPerKm));
    }

    // ─── Debounced updateDistances ─────────────────────────────────────────────────
    let _distDebounceTimer = null;
    async function updateDistances() {
      clearTimeout(_distDebounceTimer);
      _distDebounceTimer = setTimeout(() => _doUpdateDistances(), 500);
    }

    async function _doUpdateDistances() {
      const originLat = currentLat || defaultSettings.distributorLat;
      const originLng = currentLng || defaultSettings.distributorLng;

      let totalDistance = 0;
      let totalDuration = 0;
      let totalFee = 0;
      let updated = 0;
      const cards = Array.from(document.querySelectorAll('.delivery-card'));

      for (const card of cards) {
        const lat = parseFloat(card.dataset.lat);
        const lng = parseFloat(card.dataset.lng);

        if (card.dataset.realDistance) {
          const distance = parseFloat(card.dataset.realDistance);
          const duration = parseInt(card.dataset.duration) || Math.round(distance / 30 * 60);
          const cost = calculateCost(distance);
          card.querySelector('.distance').textContent = distance.toFixed(1);
          card.querySelector('.delivery-fee').textContent = cost.toLocaleString('vi-VN') + ' đ';
          totalDistance += distance;
          totalDuration += duration;
          totalFee += cost;
          updated++;
        } else {
          card.querySelector('.distance').textContent = '...';
          card.querySelector('.delivery-fee').textContent = '...';

          try {
            const route = await getRealRoute(originLat, originLng, lat, lng);
            card.dataset.realDistance = route.distance_km;
            card.dataset.duration = route.duration_min;
            card.dataset.polyline = route.polyline || '';

            const distance = route.distance_km;
            const duration = route.duration_min;
            const cost = calculateCost(distance);
            card.querySelector('.distance').textContent = distance.toFixed(1);
            card.querySelector('.delivery-fee').textContent = cost.toLocaleString('vi-VN') + ' đ';
            totalDistance += distance;
            totalDuration += duration;
            totalFee += cost;
          } catch (e) {
            console.warn('Distance calc failed for', card.dataset.name, e.message);
            const distance = calculateDistance(originLat, originLng, lat, lng);
            const cost = calculateCost(distance);
            card.querySelector('.distance').textContent = distance.toFixed(1);
            card.querySelector('.delivery-fee').textContent = cost.toLocaleString('vi-VN') + ' đ';
            totalDistance += distance;
            totalFee += cost;
          }
          updated++;
        }
      }

      document.getElementById('totalDistance').textContent = totalDistance.toFixed(1);

      let durationDisplay = document.getElementById('totalDuration');
      if (!durationDisplay) {
        durationDisplay = document.createElement('span');
        durationDisplay.id = 'totalDuration';
        document.querySelector('#totalDistance').parentElement.appendChild(durationDisplay);
      }
      durationDisplay.textContent = ' | ' + Math.round(totalDuration) + ' ph';

      document.getElementById('totalDeliveryFee').textContent = totalFee.toLocaleString('vi-VN') + ' đ';
    }

    // Optimize route using nearest neighbor algorithm (with real driving distance when API available)
    async function optimizeRoute() {
      const originLat = currentLat || defaultSettings.distributorLat;
      const originLng = currentLng || defaultSettings.distributorLng;

      // Get all customer cards
      const cards = Array.from(document.querySelectorAll('.delivery-card'));
      
      if (cards.length === 0) return;
      
      // Show loading
      const btn = document.querySelector('button[onclick="optimizeRoute()"]');
      const origText = btn.innerHTML;
      btn.innerHTML = '⏳ Đang tính...';
      btn.disabled = true;

      try {
        // Get real driving distances from API or use straight-line
        const withDistances = [];
        
        for (const card of cards) {
          const lat = parseFloat(card.dataset.lat);
          const lng = parseFloat(card.dataset.lng);
          const name = card.dataset.name;
          
          const route = await getRealRoute(originLat, originLng, lat, lng);
          const distance = route.distance_km;
          card.dataset.realDistance = route.distance_km;
          card.dataset.duration = route.duration_min;
          card.dataset.polyline = route.polyline || '';

          withDistances.push({ card, distance, lat, lng, name });
        }
        
        // Nearest neighbor algorithm - sort by distance
        withDistances.sort((a, b) => a.distance - b.distance);
        
        // Reorder cards in DOM
        const container = document.getElementById('customersList');
        withDistances.forEach(item => {
          container.appendChild(item.card);
        });
        
        // Clear existing polylines
        routePolylines.forEach(p => map.removeLayer(p));
        routePolylines = [];
        
        // Update map markers order and draw route
        map.eachLayer(layer => {
          if (layer instanceof L.Marker && !layer._icon?.classList.contains('user-marker')) {
            map.removeLayer(layer);
          }
        });
        
        // Add markers in optimized order
        for (let index = 0; index < withDistances.length; index++) {
          const item = withDistances[index];
          const customer = customers.find(c => c.lat === item.lat && c.lng === item.lng);
          if (customer) {
            const marker = L.marker([customer.lat, customer.lng]).addTo(map)
              .bindPopup('<b>' + (index + 1) + '. ' + customer.name + '</b><br>' + (customer.phone || '') + '<br>Cách: ' + item.distance.toFixed(1) + ' km');
            
            // Draw route line from previous point
            const prevLat = index === 0 ? originLat : withDistances[index - 1].lat;
            const prevLng = index === 0 ? originLng : withDistances[index - 1].lng;
            
            let routeLine;

            // Fetch real route between consecutive points
            const route = await getRealRoute(prevLat, prevLng, customer.lat, customer.lng);
            if (route.polyline) {
              try {
                // OSRM returns GeoJSON (parsed JSON string), Google returns encoded polyline
                let latLngs;
                try {
                  const geojson = JSON.parse(route.polyline);
                  latLngs = geojson.coordinates.map(([lng, lat]) => [lat, lng]);
                } catch {
                  // Google encoded polyline fallback
                  const decoded = decodePolyline(route.polyline);
                  latLngs = decoded;
                }
                routeLine = L.polyline(latLngs, {
                  color: '#8b5cf6',
                  weight: 4,
                  opacity: 0.8
                }).addTo(map);
                routePolylines.push(routeLine);
              } catch (e) {
                routeLine = L.polyline([[prevLat, prevLng], [customer.lat, customer.lng]], {
                  color: '#8b5cf6',
                  weight: 3,
                  opacity: 0.7
                }).addTo(map);
                routePolylines.push(routeLine);
              }
            } else {
              // Straight line fallback
              routeLine = L.polyline([[prevLat, prevLng], [customer.lat, customer.lng]], {
                color: '#8b5cf6',
                weight: 3,
                opacity: 0.7
              }).addTo(map);
              routePolylines.push(routeLine);
            }
          }
        }
        
        // Recalculate distances
        await updateDistances();
        
        const totalDist = withDistances.reduce((sum, d) => sum + d.distance, 0);
        alert('Đã tối ưu lộ trình! (đường đi thực tế)\\nTổng khoảng cách: ' + totalDist.toFixed(1) + ' km');
      } catch (e) {
        console.error('Route optimization error:', e);
        alert('Lỗi tối ưu lộ trình: ' + e.message);
      } finally {
        btn.innerHTML = origText;
        btn.disabled = false;
      }
    }

    // Initialize map
    const mapCenter = [parseFloat('${settingsObj.distributor_lat || 10.8231}'), parseFloat('${settingsObj.distributor_lng || 106.6297}')];
    map = L.map('map').setView(mapCenter, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);

    // Add customer markers
    customers.forEach(c => {
      if (c.lat && c.lng) {
        L.marker([c.lat, c.lng]).addTo(map)
          .bindPopup('<b>' + c.name + '</b><br>' + (c.phone || ''));
      }
    });

    // Get current location
    function getCurrentLocation() {
      if (!navigator.geolocation) {
        alert('Trình duyệt không hỗ trợ GPS');
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          currentLat = position.coords.latitude;
          currentLng = position.coords.longitude;

          if (userMarker) map.removeLayer(userMarker);
          if (routeLine) map.removeLayer(routeLine);

          userMarker = L.marker([currentLat, currentLng], {
            icon: L.divIcon({
              className: 'bg-primary rounded-full w-4 h-4 border-2 border-muted',
              iconSize: [16, 16]
            })
          }).addTo(map).bindPopup('📍 Vị trí của bạn').openPopup();

          map.setView([currentLat, currentLng], 14);
          updateDistances();
        },
        (error) => {
          alert('Không lấy được vị trí: ' + error.message);
        },
        { enableHighAccuracy: true }
      );
    }

    // Start delivery to customer
    async function startDelivery(lat, lng, customerId) {
      // Get real distance from cached data or calculate
      let distance = 0;
      let duration = 0;
      let polyline = '';
      
      const originLat = currentLat || defaultSettings.distributorLat;
      const originLng = currentLng || defaultSettings.distributorLng;
      
      // Check if we have cached real distance
      const card = document.querySelector(".delivery-card[data-lat=" + lat + "][data-lng=" + lng + "]");
      if (card && card.dataset.realDistance) {
        distance = parseFloat(card.dataset.realDistance);
        duration = parseInt(card.dataset.duration) || 0;
        polyline = card.dataset.polyline || '';
      } else {
        // Fetch real driving distance
        const route = await getRealRoute(originLat, originLng, lat, lng);
        distance = route.distance_km;
        duration = route.duration_min;
        polyline = route.polyline || '';
      }
      
      const cost = calculateCost(distance);
      const timeStr = duration > 0 ? '\\nThời gian: ' + duration + ' phút' : '';
      
      if (confirm('Xác nhận giao hàng cho khách?' + timeStr + '\\n\\nKhoảng cách: ' + distance.toFixed(1) + ' km\\nPhí vận chuyển: ' + cost.toLocaleString('vi-VN') + ' đ')) {
        // Navigate to sale page with customer info
        let url = '/sale?customerId=' + customerId + '&deliveryCost=' + cost + '&distance=' + distance.toFixed(1);
        if (duration > 0) url += '&duration=' + duration;
        if (polyline) url += '&polyline=' + encodeURIComponent(polyline);
        window.location.href = url;
      }
    }

    // Settings functions
    function showSettings() {
      document.getElementById('settingsModal').classList.remove('hidden');
      document.getElementById('settingsModal').classList.add('flex');
    }

    function hideSettings() {
      document.getElementById('settingsModal').classList.add('hidden');
      document.getElementById('settingsModal').classList.remove('flex');
    }

    function getDistributorLocation() {
      if (!navigator.geolocation) {
        alert('Trình duyệt không hỗ trợ GPS');
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          document.getElementById('distributorLat').value = position.coords.latitude.toFixed(6);
          document.getElementById('distributorLng').value = position.coords.longitude.toFixed(6);
        },
        (error) => {
          alert('Không lấy được vị trí: ' + error.message);
        }
      );
    }

    async function saveSettings() {
      const settings = {
        delivery_cost_per_km: document.getElementById('deliveryCostPerKm').value,
        delivery_base_cost: document.getElementById('deliveryBaseCost').value,
        distributor_lat: document.getElementById('distributorLat').value,
        distributor_lng: document.getElementById('distributorLng').value
      };

      try {
        const res = await fetch('/api/settings/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });

        if (res.ok) {
          defaultSettings.deliveryCostPerKm = parseFloat(settings.delivery_cost_per_km);
          defaultSettings.deliveryBaseCost = parseFloat(settings.delivery_base_cost);
          defaultSettings.distributorLat = parseFloat(settings.distributor_lat);
          defaultSettings.distributorLng = parseFloat(settings.distributor_lng);

          hideSettings();
          updateDistances();
          alert('Đã lưu cấu hình!');
        } else {
          alert('Lỗi lưu cấu hình');
        }
      } catch (err) {
        alert('Lỗi: ' + err.message);
      }
    }

    // Luôn tính khoảng cách từ kho (⚙️) khi vào trang — không bắt buộc GPS
    updateDistances();
    // GPS: chỉ khi bấm "Vị trí hiện tại" để dùng vị trí xe/điện thoại làm điểm xuất phát
  </script>
</body>
</html>
  `);
  } catch (err) {
    logger.error('GET /delivery page failed', { message: err.message, stack: err.stack });
    next(err);
  }
});

module.exports = router;
