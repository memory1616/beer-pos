/**
 * Leaflet tile layer dùng chung — Driver Portal + Admin Giao hàng
 * ─────────────────────────────────────────────────────────────────────────────
 * VÌ SAO KHÔNG DÙNG CARTO / OSM / ESRI TRỰC TIẾP?
 *   - CARTO Basemaps (dark_all): từ 2026 yêu cầu API key.
 *     Không có key → server trả PNG chữ "API KEY REQUIRED" (HTTP 200!)
 *     → bản đồ hiện đầy ô "API KEY REQUIRED", nhìn như lỗi hình ảnh.
 *   - OSM: chặn request có Referer của website ("x-blocked: Access denied").
 *   - Esri World Dark Gray: đôi lúc trả 503 {"error":"Offline"} cho IP khách.
 *
 * GIẢI PHÁP:
 *   Dùng PROXY của chính server: /map-tiles/{z}/{x}/{y}.jpg
 *   Server tải tile (có cache LRU, fallback nhiều nguồn) rồi trả lại.
 *   - Không cần API key
 *   - Không bị chặn Referer / CORS
 *   - Không cần mở CSP ra ngoài
 *   - Giữ được tông dark theme của giao diện
 */
(function (global) {
  'use strict';

  var PROXY = '/map-tiles/{z}/{x}/{y}.jpg';
  var OSM_DIRECT = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  /**
   * Thêm lớp bản đồ tối vào map.
   * @param {L.Map} map
   * @returns {{base: L.TileLayer, ref: L.TileLayer|null}}
   */
  function addDarkTiles(map, opts) {
    opts = opts || {};
    var maxZoom = opts.maxZoom || 19;

    var base = L.tileLayer(PROXY, {
      attribution: 'Bản đồ © Esri / OpenStreetMap',
      maxZoom: maxZoom,
      crossOrigin: false,
    }).addTo(map);

    // Lớp nhãn đường (lấy chung proxy, nguồn Esri Reference)
    var ref = null;
    try {
      ref = L.tileLayer(PROXY, {
        maxZoom: maxZoom,
        crossOrigin: false,
        opacity: 1,
        className: 'drv-map-labels',
      }).addTo(map);
    } catch (_) {
      ref = null;
    }

    // Fallback cuối cùng: nếu proxy lỗi → thử OSM trực tiếp
    var fellBack = false;
    var onError = function () {
      if (fellBack) return;
      fellBack = true;
      try { map.removeLayer(base); } catch (_) {}
      if (ref) { try { map.removeLayer(ref); } catch (_) {} }
      L.tileLayer(OSM_DIRECT, {
        attribution: '© OpenStreetMap contributors',
        maxZoom: maxZoom,
      }).addTo(map);
    };

    base.on('tileerror', onError);
    if (ref) ref.on('tileerror', onError);

    return { base: base, ref: ref };
  }

  global.MapTiles = { addDarkTiles: addDarkTiles, PROXY: PROXY, OSM_DIRECT: OSM_DIRECT };
})(window);
