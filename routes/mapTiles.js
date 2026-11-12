const express = require('express');
const router = express.Router();
const logger = require('../src/utils/logger');

const DISTRIBUTOR_NAME = process.env.DISTRIBUTOR_NAME || 'Bia Tuoi Gia Huy';

// ═══════════════════════════════════════════════════════════════════════════
// PROXY BẢN ĐỒ — /map-tiles/:z/:x/:y.jpg
// ───────────────────────────────────────────────────────────────────────────
// VÌ SAO CẦN PROXY?
//   1. CARTO Basemaps → trả PNG chữ "API KEY REQUIRED" (HTTP 200) nếu không có key.
//   2. OSM chặn request có Referer của website ("x-blocked: Access denied").
//   3. Esri World Dark Gray → đôi lúc trả 503 {"error":"Offline"} cho IP khách.
//   4. Leaflet cần CORS + CSP cho từng domain → phải mở rộng CSP liên tục.
//
// GIẢI PHÁP:
//   Server proxy tải tile về và trả lại cho client.
//   - Không cần API key
//   - Không bị chặn Referer
//   - Không cần mở CSP ra ngoài
//   - Có cache LRU trong bộ nhớ để giảm tải ra ngoài
//
// LƯU Ý: đây là tile dùng cho BẢN ĐỒ NỘI BỘ (địa chỉ khách hàng của cửa hàng).
// ═══════════════════════════════════════════════════════════════════════════

// Nguồn tile: thử theo thứ tự, nguồn đầu tiên trả ảnh hợp lệ sẽ được dùng.
const TILE_SOURCES = [
  {
    name: 'esri-dark',
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
    referer: 'https://giaohang.biatuoitayninh.store/',
    attribution: 'Tiles © Esri',
  },
  {
    // Google Maps — bản đồ đường giao thông, tên đường rõ nhất
    name: 'google-road',
    url: (z, x, y) => `https://mt1.google.com/vt/lyrs=m&x=${x}&y=${y}&z=${z}`,
    referer: null,
    attribution: '© Google Maps',
  },
  {
    name: 'google-sat',
    url: (z, x, y) => `https://mt1.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}`,
    referer: null,
    attribution: '© Google Maps',
  },
  {
    name: 'osm',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    referer: null, // OSM chặn Referer website → không gửi Referer
    attribution: '© OpenStreetMap contributors',
  },
  {
    // Esri vệ tinh — fallback cho lớp satellite khi Google bị chặn
    name: 'esri-img',
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    referer: 'https://giaohang.biatuoitayninh.store/',
    attribution: 'Tiles © Esri',
  },
  {
    name: 'esri-topo',
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${z}/${y}/${x}`,
    referer: 'https://giaohang.biatuoitayninh.store/',
    attribution: 'Tiles © Esri',
  },
];

// Cache LRU trong bộ nhớ (giới hạn ~300 tile)
const TILE_CACHE = new Map();
const TILE_CACHE_MAX = 300;
const TILE_TTL_MS = 30 * 60 * 1000; // 30 phút

// Kiểm tra PNG/JPEG hợp lệ (loại ảnh lỗi "API KEY REQUIRED" của CARTO)
function looksLikeImage(buf) {
  if (!buf || buf.length < 100) return false;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  return false;
}

function cacheGet(key) {
  const hit = TILE_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TILE_TTL_MS) {
    TILE_CACHE.delete(key);
    return null;
  }
  TILE_CACHE.delete(key); // LRU: đưa lên đầu
  TILE_CACHE.set(key, hit);
  return hit;
}

function cacheSet(key, buf, type) {
  if (TILE_CACHE.size >= TILE_CACHE_MAX) {
    const oldest = TILE_CACHE.keys().next().value;
    if (oldest !== undefined) TILE_CACHE.delete(oldest);
  }
  TILE_CACHE.set(key, { buf, type, at: Date.now() });
}

// Tải 1 tile từ nguồn (timeout 8s)
function fetchTile(src, z, x, y) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  // OSM chặn Referer của website → chỉ gửi Referer cho Esri
  if (src.referer) headers['Referer'] = src.referer;

  return fetch(src.url(z, x, y), { headers, signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!looksLikeImage(buf)) throw new Error('not an image');
      return { buf, type: res.headers.get('content-type') || 'image/png' };
    })
    .finally(() => clearTimeout(timer));
}

// Các bộ nguồn theo lớp bản đồ (client chọn qua ?layer=)
const LAYERS = {
  // Google đường giao thông — tên đường rõ, phù hợp tìm địa chỉ khách
  google: ['google-road', 'esri-topo', 'osm'],
  // Google vệ tinh — nhìn tổng thể khu vực giao hàng
  satellite: ['google-sat', 'esri-img', 'osm'],
  // Bản đồ tối (Esri) — hợp với giao diện dark của app
  dark: ['esri-dark', 'esri-topo', 'osm'],
  // Bản đồ sáng — dễ đọc dưới ánh sáng mạnh
  light: ['google-road', 'esri-topo', 'osm'],
};

// Route: /map-tiles/:z/:x/:y.jpg  (?layer=google|satellite|dark|light)
router.get('/map-tiles/:z/:x/:y.jpg', async (req, res) => {
  const z = parseInt(req.params.z, 10);
  const x = parseInt(req.params.x, 10);
  const y = parseInt(req.params.y, 10);

  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return res.status(400).type('text/plain').send('Bad tile coordinates');
  }
  // Chặn số không hợp lệ (z 0..19, x/y theo 2^z)
  if (z < 0 || z > 19 || x < 0 || y < 0 || x >= Math.pow(2, z) || y >= Math.pow(2, z)) {
    return res.status(400).type('text/plain').send('Tile out of range');
  }

  const layerKey = String(req.query.layer || 'google').toLowerCase();
  const order = LAYERS[layerKey] || LAYERS.google;

  const key = `${layerKey}/${z}/${x}/${y}`;
  const cached = cacheGet(key);
  if (cached) {
    res.set('X-Tile-Cache', 'HIT');
    res.set('X-Tile-Layer', layerKey);
    res.set('Cache-Control', 'public, max-age=3600');
    return res.type(cached.type).send(cached.buf);
  }

  // Thử từng nguồn trong lớp cho tới khi có ảnh hợp lệ
  let lastErr = null;
  for (const name of order) {
    const src = TILE_SOURCES.find((s) => s.name === name);
    if (!src) continue;
    try {
      const { buf, type } = await fetchTile(src, z, x, y);
      cacheSet(key, buf, type);
      res.set('X-Tile-Cache', 'MISS');
      res.set('X-Tile-Layer', layerKey);
      res.set('Cache-Control', 'public, max-age=3600');
      return res.type(type).send(buf);
    } catch (e) {
      lastErr = e;
    }
  }

  logger.warn('[map-tiles] khong lay duoc tile', { z, x, y, layer: layerKey, error: lastErr && lastErr.message });
  return res.status(502).type('text/plain').send('Tile unavailable');
});

// Route: /map-tiles/attribution — trả attribution của các nguồn đang dùng
router.get('/map-tiles/attribution', (req, res) => {
  res.json({
    layers: Object.keys(LAYERS),
    sources: TILE_SOURCES.map((s) => ({ name: s.name, attribution: s.attribution })),
  });
});

module.exports = router;
