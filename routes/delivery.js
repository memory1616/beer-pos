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
<body class="bg-gray-100 text-gray-800 min-h-screen pb-24">
  <header class="sticky top-0 bg-white/90 backdrop-blur border-b shadow-sm z-50 pb-safe">
    <div class="flex items-center justify-between px-4 py-3">
      <div class="flex items-center gap-2">
        <a href="/" class="text-gray-600">←</a>
        <span class="font-bold">${DISTRIBUTOR_NAME}</span>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="showSettings()" class="text-gray-600 p-2">⚙️</button>
        <span class="text-sm text-gray-500">Giao hàng</span>
      </div>
    </div>
    <div class="px-4 pb-2">
      <div class="flex items-center justify-between text-sm">
        <span class="text-gray-500">Khoảng cách: <span id="totalDistance" class="font-bold text-blue-600">0</span> km</span>
        <span class="text-gray-500">Phí vận chuyển: <span id="totalDeliveryFee" class="font-bold text-amber-600">0</span> ₫</span>
      </div>
      <p class="text-xs text-gray-400 mt-1">📦 Xuất phát từ <strong>kho</strong> (bấm ⚙️ để cài). Bấm <strong>📍 Vị trí hiện tại</strong> nếu muốn tính từ xe/điện thoại.</p>
    </div>
  </header>

  <main class="p-4 pt-14 pb-24 max-w-md mx-auto relative z-0">
    <div class="delivery-map-wrap">
      <div id="map"></div>
    </div>

    <div class="flex gap-2 mb-4">
      <button onclick="getCurrentLocation()" class="flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-lg flex items-center justify-center gap-2">
        📍 Vị trí hiện tại
      </button>
      <button onclick="optimizeRoute()" class="flex-1 bg-purple-500 hover:bg-purple-600 text-white py-2 px-4 rounded-lg flex items-center justify-center gap-2">
        ⚡ Tối ưu lộ trình
      </button>
    </div>

    <div id="customersList" class="space-y-2">
      ${customers.map(c => `
        <div class="delivery-card bg-white rounded-lg shadow p-3" data-lat="${c.lat}" data-lng="${c.lng}" data-name="${c.name}">
          <div class="flex justify-between items-start">
            <div>
              <div class="font-bold">${c.name}</div>
              <div class="text-sm text-gray-500">${c.phone || ''}</div>
            </div>
            <div class="text-right">
              <div class="text-sm text-gray-500">Khoảng cách: <span class="distance font-bold text-blue-600">-</span> km</div>
              <div class="text-sm font-bold text-amber-600 delivery-fee">-</div>
            </div>
          </div>
          <div class="flex gap-2 mt-2">
            <a href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}"
               target="_blank"
               class="flex-1 text-center bg-blue-100 text-blue-700 py-2 rounded-lg text-sm">📍 Chỉ đường</a>
            <button onclick="startDelivery(${c.lat}, ${c.lng}, ${c.id})"
                    class="flex-1 bg-amber-500 text-white py-2 rounded-lg text-sm">
              🚀 Giao hàng
            </button>
          </div>
        </div>
      `).join('')}
    </div>
  </main>

  <!-- Settings Modal -->
  <div id="settingsModal" class="fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center p-4" style="z-index:10000">
    <div class="bg-white rounded-lg p-6 max-w-sm w-full settings-modal-inner relative" style="z-index:10001">
      <h2 class="text-xl font-bold mb-4">⚙️ Cấu hình vận chuyển</h2>

      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Phí/km (VNĐ)</label>
          <input type="number" id="deliveryCostPerKm" value="${settingsObj.delivery_cost_per_km || 3000}"
                 class="w-full border rounded-lg px-3 py-2" min="0" step="100">
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Phí cơ bản (VNĐ)</label>
          <input type="number" id="deliveryBaseCost" value="${settingsObj.delivery_base_cost || 0}"
                 class="w-full border rounded-lg px-3 py-2" min="0">
        </div>

        <div class="border-t pt-4">
          <label class="block text-sm font-medium text-gray-700 mb-1">📍 Vị trí kho/xưởng</label>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-xs text-gray-500">Vĩ độ</label>
              <input type="number" id="distributorLat" value="${settingsObj.distributor_lat || 10.8231}"
                     class="w-full border rounded-lg px-3 py-2" step="0.0001">
            </div>
            <div>
              <label class="text-xs text-gray-500">Kinh độ</label>
              <input type="number" id="distributorLng" value="${settingsObj.distributor_lng || 106.6297}"
                     class="w-full border rounded-lg px-3 py-2" step="0.0001">
            </div>
          </div>
          <button onclick="getDistributorLocation()" class="mt-2 text-sm text-blue-600">📍 Lấy vị trí hiện tại</button>
        </div>
      </div>

      <div class="flex gap-2 mt-6">
        <button onclick="hideSettings()" class="flex-1 bg-gray-300 text-gray-800 py-3 rounded-lg">Hủy</button>
        <button onclick="saveSettings()" class="flex-1 bg-blue-600 text-white py-3 rounded-lg">Lưu</button>
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
    const defaultSettings = {
      deliveryCostPerKm: ${settingsObj.delivery_cost_per_km || 3000},
      deliveryBaseCost: ${settingsObj.delivery_base_cost || 0},
      distributorLat: ${settingsObj.distributor_lat || 10.8231},
      distributorLng: ${settingsObj.distributor_lng || 106.6297}
    };

    let currentLat = null;
    let currentLng = null;
    let map, userMarker, routeLine;

    // Calculate distance using Haversine formula
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

    // Calculate delivery cost
    function calculateCost(distance) {
      return Math.round(defaultSettings.deliveryBaseCost + (distance * defaultSettings.deliveryCostPerKm));
    }

    // Optimize route using nearest neighbor algorithm
    function optimizeRoute() {
      const originLat = currentLat || defaultSettings.distributorLat;
      const originLng = currentLng || defaultSettings.distributorLng;
      
      // Get all customer cards
      const cards = Array.from(document.querySelectorAll('.delivery-card'));
      
      if (cards.length === 0) return;
      
      // Calculate distance from origin to each customer
      const withDistances = cards.map(card => {
        const lat = parseFloat(card.dataset.lat);
        const lng = parseFloat(card.dataset.lng);
        const distance = calculateDistance(originLat, originLng, lat, lng);
        return { card, distance, lat, lng };
      });
      
      // Nearest neighbor algorithm - sort by distance
      withDistances.sort((a, b) => a.distance - b.distance);
      
      // Reorder cards in DOM
      const container = document.getElementById('customersList');
      withDistances.forEach(item => {
        container.appendChild(item.card);
      });
      
      // Update map markers order
      map.eachLayer(layer => {
        if (layer instanceof L.Marker && !layer._icon?.classList.contains('user-marker')) {
          map.removeLayer(layer);
        }
      });
      
      // Add markers in optimized order
      withDistances.forEach((item, index) => {
        const customer = customers.find(c => c.lat === item.lat && c.lng === item.lng);
        if (customer) {
          const marker = L.marker([customer.lat, customer.lng]).addTo(map)
            .bindPopup('<b>' + (index + 1) + '. ' + customer.name + '</b><br>' + (customer.phone || '') + '<br>Cách: ' + item.distance.toFixed(1) + ' km');
          
          // Add route lines
          const prevLat = index === 0 ? originLat : withDistances[index - 1].lat;
          const prevLng = index === 0 ? originLng : withDistances[index - 1].lng;
          
          L.polyline([[prevLat, prevLng], [customer.lat, customer.lng]], {
            color: '#8b5cf6',
            weight: 3,
            opacity: 0.7
          }).addTo(map);
        }
      });
      
      // Recalculate distances
      updateDistances();
      
      alert('Đã tối ưu lộ trình! Tổng khoảng cách: ' + withDistances.reduce((sum, d) => sum + d.distance, 0).toFixed(1) + ' km');
    }

    // Update all distances and costs
    function updateDistances() {
      const originLat = currentLat || defaultSettings.distributorLat;
      const originLng = currentLng || defaultSettings.distributorLng;

      let totalDistance = 0;
      let totalFee = 0;

      document.querySelectorAll('.delivery-card').forEach(card => {
        const lat = parseFloat(card.dataset.lat);
        const lng = parseFloat(card.dataset.lng);
        const distance = calculateDistance(originLat, originLng, lat, lng);
        const cost = calculateCost(distance);

        card.querySelector('.distance').textContent = distance.toFixed(1);
        card.querySelector('.delivery-fee').textContent = cost.toLocaleString('vi-VN') + ' ₫';

        totalDistance += distance;
        totalFee += cost;
      });

      document.getElementById('totalDistance').textContent = totalDistance.toFixed(1);
      document.getElementById('totalDeliveryFee').textContent = totalFee.toLocaleString('vi-VN');
    }

    // Initialize map
    const mapCenter = [${settingsObj.distributor_lat || 10.8231}, ${settingsObj.distributor_lng || 106.6297}];
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
              className: 'bg-blue-500 rounded-full w-4 h-4 border-2 border-white',
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
    function startDelivery(lat, lng, customerId) {
      const distance = currentLat ?
        calculateDistance(currentLat, currentLng, lat, lng) :
        calculateDistance(defaultSettings.distributorLat, defaultSettings.distributorLng, lat, lng);
      const cost = calculateCost(distance);

      if (confirm('Xác nhận giao hàng cho khách?\\n\\nKhoảng cách: ' + distance.toFixed(1) + ' km\\nPhí vận chuyển: ' + cost.toLocaleString('vi-VN') + ' VNĐ')) {
        // Navigate to sale page with customer info
        window.location.href = '/sale?customerId=' + customerId + '&deliveryCost=' + cost + '&distance=' + distance.toFixed(1);
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
  <\/script>
</body>
</html>
  `);
  } catch (err) {
    logger.error('GET /delivery page failed', { message: err.message, stack: err.stack });
    next(err);
  }
});

module.exports = router;
