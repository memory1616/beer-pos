/**
 * Leaflet tile layer dùng chung — Driver Portal + Admin Giao hàng
 * ─────────────────────────────────────────────────────────────────────────────
 * VÌ SAO KHÔNG DÙNG CARTO?
 *   CARTO Basemaps (dark_all) từ 2026 đã yêu cầu API key.
 *   Không có key → server trả về ảnh PNG chữ "API KEY REQUIRED" (HTTP 200!)
 *   → bản đồ hiện đầy ô "API KEY REQUIRED", nhìn như lỗi hình ảnh.
 *
 * GIẢI PHÁP:
 *   Dùng Esri World Dark Gray Canvas (base + reference) — miễn phí, không cần key,
 *   giữ đúng tông dark theme của giao diện.
 *
 *   - Base     : nền (đường, địa hình tối)
 *   - Reference: lớp phủ trong suốt chứa Nhãn đường/tên địa điểm (chữ sáng)
 *
 * Nếu Esri lỗi → tự động fallback sang OpenStreetMap tile chuẩn.
 */
(function (global) {
  'use strict';

  var ESRI_BASE =
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
  var ESRI_REF =
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';
  var OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  /**
   * Thêm lớp bản đồ tối vào map.
   * @param {L.Map} map
   * @returns {{base: L.TileLayer, ref: L.TileLayer|null}}
   */
  function addDarkTiles(map, opts) {
    opts = opts || {};
    var maxZoom = opts.maxZoom || 19;

    var base = L.tileLayer(ESRI_BASE, {
      attribution: 'Tiles © Esri — Esri, DeLorme, NAVTEQ',
      maxZoom: maxZoom,
      crossOrigin: true,
    }).addTo(map);

    // Lớp nhãn (nếu lỗi thì bỏ qua, bản đồ vẫn dùng được)
    var ref = null;
    try {
      ref = L.tileLayer(ESRI_REF, {
        maxZoom: maxZoom,
        crossOrigin: true,
        opacity: 1,
      }).addTo(map);
    } catch (_) {
      ref = null;
    }

    // Fallback: nếu base không tải được → dùng OSM
    var fellBack = false;
    var onError = function () {
      if (fellBack) return;
      fellBack = true;
      try { map.removeLayer(base); } catch (_) {}
      if (ref) { try { map.removeLayer(ref); } catch (_) {} }
      L.tileLayer(OSM, {
        attribution: '© OpenStreetMap contributors',
        maxZoom: maxZoom,
      }).addTo(map);
    };

    base.on('tileerror', onError);
    if (ref) ref.on('tileerror', onError);

    return { base: base, ref: ref };
  }

  global.MapTiles = { addDarkTiles: addDarkTiles, ESRI_BASE: ESRI_BASE, OSM: OSM };
})(window);
