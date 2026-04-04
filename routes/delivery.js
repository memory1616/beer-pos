const express = require('express');
const router = express.Router();
const db = require('../database');
const logger = require('../src/utils/logger');

const DISTRIBUTOR_NAME = 'Bia Tuoi Gia Huy';

// GET /delivery
router.get('/', (req, res, next) => {
  try {
  const customers = db.prepare(
    'SELECT * FROM customers WHERE archived = 0 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY name'
  ).all();

  // Safe defaults in case DB returns empty
  const numSettings = {
    delivery_cost_per_km: 3000,
    delivery_base_cost: 0,
    distributor_lat: 10.8231,
    distributor_lng: 106.6297,
  };
  const settings = db.prepare('SELECT * FROM settings').all();
  if (settings.length > 0) {
    const settingsObj = {};
    settings.forEach(s => settingsObj[s.key] = s.value);
    const p = parseFloat(settingsObj.delivery_cost_per_km);     if (!isNaN(p)) numSettings.delivery_cost_per_km = p;
    const b = parseFloat(settingsObj.delivery_base_cost);       if (!isNaN(b)) numSettings.delivery_base_cost = b;
    const la = parseFloat(settingsObj.distributor_lat);         if (!isNaN(la)) numSettings.distributor_lat = la;
    const lo = parseFloat(settingsObj.distributor_lng);        if (!isNaN(lo)) numSettings.distributor_lng = lo;
  }

  const hasGoogleApi = !!(process.env.GOOGLE_MAPS_API_KEY);

  // Build customers HTML rows
  const customerRows = customers.map(c => {
    const lat = c.lat == null ? '' : c.lat;
    const lng = c.lng == null ? '' : c.lng;
    const name = c.name == null ? '' : c.name.replace(/"/g, '&quot;');
    const phone = (c.phone || '').replace(/"/g, '&quot;');
    return [
      '<div class="delivery-card card p-3" data-lat="' + lat + '" data-lng="' + lng + '" data-name="' + name + '">',
        '<div class="flex justify-between items-start">',
          '<div><div class="font-bold text-main">' + name + '</div><div class="text-sm text-muted">' + phone + '</div></div>',
          '<div class="text-right"><div class="text-sm text-muted">Khoảng cách: <span class="distance font-bold text-info">-</span> km</div><div class="delivery-fee"><div class="money text-money"><span class="value text-sm font-bold tabular-nums">-</span><span class="unit">d</span></div></div></div>',
        '</div>',
        '<div class="flex gap-2 mt-2">',
          '<a href="https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng + '" target="_blank" class="flex-1 text-center btn btn-secondary btn-sm">D Chỉ đường</a>',
          '<button onclick="startDelivery(' + lat + ', ' + lng + ', ' + (c.id || 0) + ')" class="flex-1 btn btn-warning btn-sm">🚀 Giao hàng</button>',
        '</div>',
      '</div>'
    ].join('');
  }).join('\n');

  const customersJson = JSON.stringify(customers);
  const costPerKm = numSettings.delivery_cost_per_km || 0;
  const baseCost = numSettings.delivery_base_cost || 0;
  const distLat = numSettings.distributor_lat || 0;
  const distLng = numSettings.distributor_lng || 0;

  // Build the <script> block as a plain string (no backticks)
  const scriptBlock = [
    'const customers = ' + customersJson + ';',
    'const hasGoogleApi = ' + hasGoogleApi + ';',
    'const defaultSettings = {',
    '  deliveryCostPerKm: ' + costPerKm + ',',
    '  deliveryBaseCost: ' + baseCost + ',',
    '  distributorLat: ' + distLat + ',',
    '  distributorLng: ' + distLng,
    '};',
    '',
    'let currentLat = null;',
    'let currentLng = null;',
    'let map, userMarker, routeLine;',
    'let routePolylines = [];',
    '',
    'function decodePolyline(encoded) {',
    '  const poly = []; let index = 0; let lat = 0; let lng = 0;',
    '  while (index < encoded.length) {',
    '    let b, shift = 0, result = 0;',
    '    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);',
    '    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;',
    '    lat += dlat;',
    '    shift = 0; result = 0;',
    '    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);',
    '    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;',
    '    lng += dlng;',
    '    poly.push([lat / 1e5, lng / 1e5]);',
    '  }',
    '  return poly;',
    '}',
    '',
    'function clearRouteLines() { routePolylines.forEach(p => map.removeLayer(p)); routePolylines = []; }',
    '',
    'function calculateDistance(lat1, lng1, lat2, lng2) {',
    '  const R = 6371;',
    '  const dLat = (lat2 - lat1) * Math.PI / 180;',
    '  const dLng = (lng2 - lng1) * Math.PI / 180;',
    '  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +',
    '    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);',
    '  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));',
    '}',
    '',
    'const SESSION_CACHE_KEY = "delivery_route_cache_v1";',
    'const _routeCache = JSON.parse(sessionStorage.getItem(SESSION_CACHE_KEY) || "{}");',
    'function _saveRouteCache() { try { sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(_routeCache)); } catch(e){} }',
    '',
    'function _getCache(lat1, lng1, lat2, lng2) {',
    '  const k = lat1.toFixed(5) + "," + lng1.toFixed(5) + "-" + lat2.toFixed(5) + "," + lng2.toFixed(5);',
    '  return _routeCache[k] || null;',
    '}',
    'function _setCache(lat1, lng1, lat2, lng2, data) {',
    '  const k = lat1.toFixed(5) + "," + lng1.toFixed(5) + "-" + lat2.toFixed(5) + "," + lng2.toFixed(5);',
    '  _routeCache[k] = data; _saveRouteCache();',
    '}',
    '',
    'let _queue = []; let _queueRunning = false; const QUEUE_DELAY_MS = 600;',
    'function _enqueueRouteTask(task) {',
    '  return new Promise((resolve, reject) => { _queue.push({ task, resolve, reject }); if (!_queueRunning) _processQueue(); });',
    '}',
    'async function _processQueue() {',
    '  if (_queue.length === 0) { _queueRunning = false; return; }',
    '  _queueRunning = true;',
    '  while (_queue.length > 0) {',
    '    const { task, resolve, reject } = _queue.shift();',
    '    try { resolve(await _fetchRouteWithRetry(task.originLat, task.originLng, task.destLat, task.destLng)); }',
    '    catch(e) { reject(e); }',
    '    if (_queue.length > 0) await new Promise(r => setTimeout(r, QUEUE_DELAY_MS));',
    '  }',
    '  _queueRunning = false;',
    '}',
    'async function _fetchRouteWithRetry(originLat, originLng, destLat, destLng, attempt) {',
    '  attempt = attempt || 0;',
    '  try {',
    '    const res = await fetch("/api/routing/route?originLat=" + originLat + "&originLng=" + originLng + "&destLat=" + destLat + "&destLng=" + destLng);',
    '    if (res.status === 429 && attempt < 2) { await new Promise(r => setTimeout(r, (attempt+1)*1000)); return _fetchRouteWithRetry(originLat, originLng, destLat, destLng, attempt+1); }',
    '    if (!res.ok) throw new Error("API error " + res.status);',
    '    const data = await res.json();',
    '    _setCache(originLat, originLng, destLat, destLng, data);',
    '    return data;',
    '  } catch(e) {',
    '    return { distance_km: calculateDistance(originLat, originLng, destLat, destLng), duration_min: 0, polyline: null };',
    '  }',
    '}',
    '',
    'async function getRealRoute(originLat, originLng, destLat, destLng) {',
    '  const cached = _getCache(originLat, originLng, destLat, destLng);',
    '  if (cached) return cached;',
    '  return _enqueueRouteTask({ originLat, originLng, destLat, destLng });',
    '}',
    '',
    'function calculateCost(distance) { return Math.round(defaultSettings.deliveryBaseCost + (distance * defaultSettings.deliveryCostPerKm)); }',
    '',
    'let _distDebounceTimer = null;',
    'async function updateDistances() { clearTimeout(_distDebounceTimer); _distDebounceTimer = setTimeout(_doUpdateDistances, 500); }',
    '',
    'async function _doUpdateDistances() {',
    '  const originLat = currentLat || defaultSettings.distributorLat;',
    '  const originLng = currentLng || defaultSettings.distributorLng;',
    '  let totalDistance = 0, totalDuration = 0, totalFee = 0;',
    '  const cards = Array.from(document.querySelectorAll(".delivery-card"));',
    '  for (const card of cards) {',
    '    const lat = parseFloat(card.dataset.lat);',
    '    const lng = parseFloat(card.dataset.lng);',
    '    if (card.dataset.realDistance) {',
    '      const d = parseFloat(card.dataset.realDistance);',
    '      const dur = parseInt(card.dataset.duration) || Math.round(d / 30 * 60);',
    '      const cost = calculateCost(d);',
    '      card.querySelector(".distance").textContent = d.toFixed(1);',
    '      card.querySelector(".delivery-fee").innerHTML = cost.toLocaleString("vi-VN") + " d";',
    '      totalDistance += d; totalDuration += dur; totalFee += cost;',
    '    } else {',
    '      card.querySelector(".distance").textContent = "...";',
    '      card.querySelector(".delivery-fee").textContent = "...";',
    '      try {',
    '        const route = await getRealRoute(originLat, originLng, lat, lng);',
    '        card.dataset.realDistance = route.distance_km;',
    '        card.dataset.duration = route.duration_min;',
    '        card.dataset.polyline = route.polyline || "";',
    '        const d = route.distance_km, dur = route.duration_min, cost = calculateCost(d);',
    '        card.querySelector(".distance").textContent = d.toFixed(1);',
    '        card.querySelector(".delivery-fee").innerHTML = cost.toLocaleString("vi-VN") + " d";',
    '        totalDistance += d; totalDuration += dur; totalFee += cost;',
    '      } catch(e) {',
    '        const d = calculateDistance(originLat, originLng, lat, lng);',
    '        const cost = calculateCost(d);',
    '        card.querySelector(".distance").textContent = d.toFixed(1);',
    '        card.querySelector(".delivery-fee").innerHTML = cost.toLocaleString("vi-VN") + " d";',
    '        totalDistance += d; totalFee += cost;',
    '      }',
    '    }',
    '  }',
    '  document.getElementById("totalDistance").textContent = totalDistance.toFixed(1);',
    '  document.getElementById("totalDeliveryFee").innerHTML = totalFee.toLocaleString("vi-VN") + " d";',
    '}',
    '',
    'async function optimizeRoute() {',
    '  const originLat = currentLat || defaultSettings.distributorLat;',
    '  const originLng = currentLng || defaultSettings.distributorLng;',
    '  const cards = Array.from(document.querySelectorAll(".delivery-card"));',
    '  if (cards.length === 0) return;',
    '  const btn = document.querySelector("button[onclick=\\"optimizeRoute()\\"]");',
    '  const origText = btn.innerHTML;',
    '  btn.innerHTML = "⏳ Dang tinh..."; btn.disabled = true;',
    '  try {',
    '    const withDistances = [];',
    '    for (const card of cards) {',
    '      const lat = parseFloat(card.dataset.lat), lng = parseFloat(card.dataset.lng);',
    '      const route = await getRealRoute(originLat, originLng, lat, lng);',
    '      card.dataset.realDistance = route.distance_km;',
    '      card.dataset.duration = route.duration_min;',
    '      card.dataset.polyline = route.polyline || "";',
    '      withDistances.push({ card, distance: route.distance_km, lat, lng, name: card.dataset.name });',
    '    }',
    '    withDistances.sort((a, b) => a.distance - b.distance);',
    '    const container = document.getElementById("customersList");',
    '    withDistances.forEach(item => container.appendChild(item.card));',
    '    clearRouteLines();',
    '    map.eachLayer(layer => { if (layer instanceof L.Marker && !layer._icon || !layer._icon) map.removeLayer(layer); });',
    '    for (let index = 0; index < withDistances.length; index++) {',
    '      const item = withDistances[index];',
    '      const customer = customers.find(c => c.lat == item.lat && c.lng == item.lng);',
    '      if (customer) {',
    '        const marker = L.marker([customer.lat, customer.lng]).addTo(map)',
    '          .bindPopup("<b>" + (index+1) + ". " + customer.name + "</b><br>" + (customer.phone||"") + "<br>Cach: " + item.distance.toFixed(1) + " km");',
    '        const prevLat = index===0 ? originLat : withDistances[index-1].lat;',
    '        const prevLng = index===0 ? originLng : withDistances[index-1].lng;',
    '        const route = await getRealRoute(prevLat, prevLng, customer.lat, customer.lng);',
    '        let latLngs;',
    '        try {',
    '          const geojson = JSON.parse(route.polyline || "null");',
    '          if (geojson && geojson.coordinates) latLngs = geojson.coordinates.map(([lng, lat]) => [lat, lng]);',
    '          else latLngs = decodePolyline(route.polyline || "");',
    '        } catch { latLngs = [[prevLat, prevLng],[customer.lat, customer.lng]]; }',
    '        const line = L.polyline(latLngs, { color: "#8b5cf6", weight: 4, opacity: 0.8 }).addTo(map);',
    '        routePolylines.push(line);',
    '      }',
    '    }',
    '    await updateDistances();',
    '    const totalDist = withDistances.reduce((sum, d) => sum + d.distance, 0);',
    '    alert("Da toi uu lo trinh! Tong khoang cach: " + totalDist.toFixed(1) + " km");',
    '  } catch(e) { alert("Loi toi uu: " + e.message); }',
    '  finally { btn.innerHTML = origText; btn.disabled = false; }',
    '}',
    '',
    'const mapCenter = [' + distLat + ', ' + distLng + '];',
    'map = L.map("map").setView(mapCenter, 12);',
    'L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);',
    '',
    'customers.forEach(c => { if (c.lat && c.lng) L.marker([c.lat, c.lng]).addTo(map).bindPopup("<b>" + c.name + "</b><br>" + (c.phone||"")); });',
    '',
    'function getCurrentLocation() {',
    '  if (!navigator.geolocation) { alert("Trinh duyet khong ho tro GPS"); return; }',
    '  navigator.geolocation.getCurrentPosition(',
    '    (position) => {',
    '      currentLat = position.coords.latitude; currentLng = position.coords.longitude;',
    '      if (userMarker) map.removeLayer(userMarker);',
    '      if (routeLine) map.removeLayer(routeLine);',
    '      userMarker = L.marker([currentLat, currentLng], { icon: L.divIcon({ className: "bg-primary rounded-full w-4 h-4 border-2 border-muted", iconSize: [16,16] }) }).addTo(map).bindPopup("📍 Vi tri cua ban").openPopup();',
    '      map.setView([currentLat, currentLng], 14);',
    '      updateDistances();',
    '    },',
    '    (error) => { alert("Khong lay duoc vi tri: " + error.message); },',
    '    { enableHighAccuracy: true }',
    '  );',
    '}',
    '',
    'async function startDelivery(lat, lng, customerId) {',
    '  let distance = 0, duration = 0, polyline = "";',
    '  const originLat = currentLat || defaultSettings.distributorLat;',
    '  const originLng = currentLng || defaultSettings.distributorLng;',
    '  const card = document.querySelector(".delivery-card[data-lat=" + lat + "][data-lng=" + lng + "]");',
    '  if (card && card.dataset.realDistance) {',
    '    distance = parseFloat(card.dataset.realDistance);',
    '    duration = parseInt(card.dataset.duration) || 0;',
    '    polyline = card.dataset.polyline || "";',
    '  } else {',
    '    const route = await getRealRoute(originLat, originLng, lat, lng);',
    '    distance = route.distance_km; duration = route.duration_min; polyline = route.polyline || "";',
    '  }',
    '  const cost = calculateCost(distance);',
    '  const timeStr = duration > 0 ? "\\nThoi gian: " + duration + " phut" : "";',
    '  if (confirm("Xac nhan giao hang cho khach?" + timeStr + "\\n\\nKhoang cach: " + distance.toFixed(1) + " km\\nPhi van chuyen: " + cost.toLocaleString("vi-VN") + " d")) {',
    '    let url = "/sale?customerId=" + customerId + "&deliveryCost=" + cost + "&distance=" + distance.toFixed(1);',
    '    if (duration > 0) url += "&duration=" + duration;',
    '    if (polyline) url += "&polyline=" + encodeURIComponent(polyline);',
    '    window.location.href = url;',
    '  }',
    '}',
    '',
    'function showSettings() { document.getElementById("settingsModal").classList.remove("hidden"); document.getElementById("settingsModal").classList.add("flex"); }',
    'function hideSettings() { document.getElementById("settingsModal").classList.add("hidden"); document.getElementById("settingsModal").classList.remove("flex"); }',
    '',
    'function getDistributorLocation() {',
    '  if (!navigator.geolocation) { alert("Trinh duyet khong ho tro GPS"); return; }',
    '  navigator.geolocation.getCurrentPosition(',
    '    (position) => {',
    '      document.getElementById("distributorLat").value = position.coords.latitude.toFixed(6);',
    '      document.getElementById("distributorLng").value = position.coords.longitude.toFixed(6);',
    '    },',
    '    (error) => { alert("Khong lay duoc vi tri: " + error.message); }',
    '  );',
    '}',
    '',
    'async function saveSettings() {',
    '  const settings = {',
    '    delivery_cost_per_km: document.getElementById("deliveryCostPerKm").value,',
    '    delivery_base_cost: document.getElementById("deliveryBaseCost").value,',
    '    distributor_lat: document.getElementById("distributorLat").value,',
    '    distributor_lng: document.getElementById("distributorLng").value',
    '  };',
    '  try {',
    '    const res = await fetch("/api/settings/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });',
    '    if (res.ok) {',
    '      defaultSettings.deliveryCostPerKm = parseFloat(settings.delivery_cost_per_km);',
    '      defaultSettings.deliveryBaseCost = parseFloat(settings.delivery_base_cost);',
    '      defaultSettings.distributorLat = parseFloat(settings.distributor_lat);',
    '      defaultSettings.distributorLng = parseFloat(settings.distributor_lng);',
    '      hideSettings(); updateDistances(); alert("Da luu cau hinh!");',
    '    } else { alert("Loi luu cau hinh"); }',
    '  } catch(err) { alert("Loi: " + err.message); }',
    '}',
    '',
    'updateDistances();',
  ].join('\n');

  // Build full HTML with string concatenation (no backticks in HTML content)
  const html =
    '<!DOCTYPE html>\n' +
    '<html lang="vi">\n' +
    '<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">\n' +
    '<title>Giao hàng</title>\n' +
    '<link rel="manifest" href="/manifest.json">\n' +
    '<meta name="theme-color" content="#f59e0b">\n' +
    '<meta name="mobile-web-app-capable" content="yes">\n' +
    '<link rel="apple-touch-icon" href="/icon-192.png">\n' +
    '<link rel="icon" type="image/png" href="/icon-192.png">\n' +
    '<link rel="stylesheet" href="/css/tailwind.css">\n' +
    '<link rel="stylesheet" href="/css/unified.css">\n' +
    '<script src="/js/dark-mode.js"></' + 'script>\n' +
    '<link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css" />\n' +
    '<script src="https://unpkg.com/leaflet/dist/leaflet.js"></' + 'script>\n' +
    '<style>\n' +
    '.pb-safe { padding-bottom: env(safe-area-inset-bottom, 20px); }\n' +
    '.bottomnav { max-width: 500px; margin: auto; }\n' +
    '.delivery-map-wrap { position: relative; z-index: 0; isolation: isolate; overflow: hidden; border-radius: 12px; margin-bottom: 1rem; }\n' +
    '.delivery-map-wrap #map { height: 50vh; margin-bottom: 0; }\n' +
    '.delivery-map-wrap .leaflet-container { z-index: 0 !important; }\n' +
    '.delivery-card { transition: all 0.2s; cursor: pointer; }\n' +
    '.delivery-card:active { transform: scale(0.98); }\n' +
    '#settingsModal { z-index: 10000 !important; }\n' +
    '.settings-modal-inner { max-height: 85vh; overflow-y: auto; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); }\n' +
    '</style>\n' +
    '</head>\n' +
    '<body class="bg-bg text-main min-h-screen pb-24">\n' +
    '<header class="sticky top-0 bg-card/90 backdrop-blur border-b border-muted shadow-sm z-50 pb-safe">\n' +
    '<div class="flex items-center justify-between px-4 py-3">\n' +
    '<div class="flex items-center gap-2">\n' +
    '<a href="/" class="text-muted">←</a>\n' +
    '<span class="font-bold text-main">' + DISTRIBUTOR_NAME + '</span>\n' +
    '</div>\n' +
    '<div class="flex items-center gap-2">\n' +
    '<button onclick="showSettings()" class="text-muted p-2">⚙️</button>\n' +
    '<span class="text-sm text-muted">Giao hàng</span>\n' +
    '</div>\n' +
    '</div>\n' +
    '<div class="px-4 pb-2">\n' +
    '<div class="flex items-center justify-between text-sm">\n' +
    '<span class="text-muted">Khoảng cách: <span id="totalDistance" class="font-bold text-info">0</span> km</span>\n' +
    '<span class="text-muted">Phí vận chuyển: <span id="totalDeliveryFee" class="money text-money"><span class="value font-bold tabular-nums">0</span><span class="unit">đ</span></span></span>\n' +
    '</div>\n' +
    '<p class="text-xs text-muted mt-1">📦 Xuất phát từ <strong>kho</strong> (bấm ⚙️ để cài). Bấm <strong>📍 Vị trí hiện tại</strong> nếu muốn tính từ xe/điện thoại.</p>\n' +
    '</div>\n' +
    '</header>\n' +
    '\n' +
    '<main class="p-4 pt-14 pb-24 max-w-md mx-auto relative z-0">\n' +
    '<div class="delivery-map-wrap">\n' +
    '<div id="map"></div>\n' +
    '</div>\n' +
    '\n' +
    '<div class="flex gap-2 mb-4">\n' +
    '<button onclick="getCurrentLocation()" class="flex-1 btn btn-primary flex items-center justify-center gap-2">📍 Vị trí hiện tại</button>\n' +
    '<button onclick="optimizeRoute()" class="flex-1 btn btn-secondary">⚡ Tối ưu lộ trình</button>\n' +
    '</div>\n' +
    '\n' +
    '<div id="customersList" class="space-y-2">\n' +
    customerRows + '\n' +
    '</div>\n' +
    '</main>\n' +
    '\n' +
    '<!-- Settings Modal -->\n' +
    '<div id="settingsModal" class="fixed inset-0 bg-overlay hidden items-center justify-center p-4" style="z-index:10000">\n' +
    '<div class="card p-6 max-w-sm w-full settings-modal-inner relative" style="z-index:10001">\n' +
    '<h2 class="text-xl font-bold mb-4">⚙️ Cấu hình vận chuyển</h2>\n' +
    '<div class="space-y-4">\n' +
    '<div>\n' +
    '<label class="block text-sm font-medium text-main mb-1">Phí/km (đ)</label>\n' +
    '<input type="number" id="deliveryCostPerKm" value="' + (numSettings.delivery_cost_per_km || 0) + '" class="w-full border border-muted rounded-lg px-3 py-2" min="0" step="100">\n' +
    '</div>\n' +
    '<div>\n' +
    '<label class="block text-sm font-medium text-main mb-1">Phí cơ bản (đ)</label>\n' +
    '<input type="number" id="deliveryBaseCost" value="' + (numSettings.delivery_base_cost || 0) + '" class="w-full border border-muted rounded-lg px-3 py-2" min="0">\n' +
    '</div>\n' +
    '<div class="border-t border-muted pt-4">\n' +
    '<label class="block text-sm font-medium text-main mb-1">📍 Vị trí kho/xưởng</label>\n' +
    '<div class="grid grid-cols-2 gap-2">\n' +
    '<div><label class="text-xs text-muted">Vĩ độ</label><input type="number" id="distributorLat" value="' + (numSettings.distributor_lat || 0) + '" class="w-full border border-muted rounded-lg px-3 py-2" step="0.0001"></div>\n' +
    '<div><label class="text-xs text-muted">Kinh độ</label><input type="number" id="distributorLng" value="' + (numSettings.distributor_lng || 0) + '" class="w-full border border-muted rounded-lg px-3 py-2" step="0.0001"></div>\n' +
    '</div>\n' +
    '<button onclick="getDistributorLocation()" class="mt-2 text-sm text-info">📍 Lấy vị trí hiện tại</button>\n' +
    '</div>\n' +
    '</div>\n' +
    '<div class="flex gap-2 mt-6">\n' +
    '<button onclick="hideSettings()" class="flex-1 btn btn-ghost">Hủy</button>\n' +
    '<button onclick="saveSettings()" class="flex-1 btn btn-primary">Lưu</button>\n' +
    '</div>\n' +
    '</div>\n' +
    '</div>\n' +
    '\n' +
    '<nav class="bottomnav pb-safe">\n' +
    '<a href="/"><span class="icon">🏠</span><span>Home</span></a>\n' +
    '<a href="/delivery" class="active"><span class="icon">🚚</span><span>Giao</span></a>\n' +
    '<a href="/sale"><span class="icon">🍺</span><span>Bán</span></a>\n' +
    '<a href="/customers"><span class="icon">👤</span><span>KH</span></a>\n' +
    '<a href="/devices"><span class="icon">📦</span><span>TB</span></a>\n' +
    '</nav>\n' +
    '\n' +
    '<script>\n' +
    scriptBlock + '\n' +
    '</script>\n' +
    '</body>\n' +
    '</html>\n';

  res.type('html').send(html);
  } catch (err) {
    logger.error('GET /delivery page failed', { message: err.message, stack: err.stack });
    next(err);
  }
});

module.exports = router;
