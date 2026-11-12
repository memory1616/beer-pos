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
 *   Dùng PROXY của chính server: /map-tiles/{z}/{x}/{y}.jpg?layer=xxx
 *   Server tải tile (có cache LRU, fallback nhiều nguồn) rồi trả lại.
 *   - Không cần API key
 *   - Không bị chặn Referer / CORS
 *   - Không cần mở CSP ra ngoài
 *   - Hỗ trợ Google Maps (đường / vệ tinh) + Esri Dark + OSM
 */
(function (global) {
  'use strict';

  var PROXY = '/map-tiles/{z}/{x}/{y}.jpg';
  var OSM_DIRECT = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  // Các lớp bản đồ hỗ trợ (khớp với LAYERS trong routes/mapTiles.js)
  var LAYERS = [
    { id: 'google', label: 'Google', icon: '🗺️' },
    { id: 'satellite', label: 'Vệ tinh', icon: '🛰️' },
    { id: 'dark', label: 'Tối', icon: '🌙' },
  ];

  function proxyUrl(layer) {
    return PROXY + '?layer=' + encodeURIComponent(layer || 'google');
  }

  /**
   * Thêm lớp bản đồ vào map (mặc định Google).
   * @param {L.Map} map
   * @param {Object} opts { layer, maxZoom }
   * @returns {{base: L.TileLayer, setLayer: Function}}
   */
  function addTiles(map, opts) {
    opts = opts || {};
    var maxZoom = opts.maxZoom || 19;
    var current = opts.layer || 'google';

    var base = L.tileLayer(proxyUrl(current), {
      attribution: '© Google Maps · Esri · OpenStreetMap',
      maxZoom: maxZoom,
      crossOrigin: false,
    }).addTo(map);

    // Fallback cuối cùng: nếu proxy lỗi → thử OSM trực tiếp
    var fellBack = false;
    var onError = function () {
      if (fellBack) return;
      fellBack = true;
      try { map.removeLayer(base); } catch (_) {}
      L.tileLayer(OSM_DIRECT, {
        attribution: '© OpenStreetMap contributors',
        maxZoom: maxZoom,
      }).addTo(map);
    };
    base.on('tileerror', onError);

    function setLayer(layerId) {
      if (!layerId || layerId === current) return;
      current = layerId;
      base.setUrl(proxyUrl(current));
      // Ép Leaflet tải lại tile (đổi URL là đủ, nhưng gọi redraw cho chắc)
      base.redraw();
    }

    return { base: base, setLayer: setLayer, getLayer: function () { return current; } };
  }

  /**
   * Thêm lớp bản đồ tối (backward-compat với code cũ).
   * @param {L.Map} map
   */
  function addDarkTiles(map, opts) {
    opts = opts || {};
    if (!opts.layer) opts.layer = 'dark';
    return addTiles(map, opts);
  }

  /**
   * Gắn nút chuyển lớp bản đồ vào container của Leaflet control.
   * @param {L.Map} map
   * @param {HTMLElement} container
   * @param {Object} opts { layer, position }
   */
  function addLayerSwitcher(map, container, opts) {
    opts = opts || {};
    var layerId = opts.layer || 'google';
    var tiles = opts.tiles || addTiles(map, { layer: layerId });
    var position = opts.position || 'topright';

    var group = L.control({ position: position });
    group.onAdd = function () {
      var div = L.DomUtil.create('div', 'drv-map-layers');
      L.DomEvent.disableClickPropagation(div);
      LAYERS.forEach(function (l) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'drv-map-layer-btn' + (l.id === layerId ? ' is-active' : '');
        btn.title = l.label;
        btn.setAttribute('aria-label', l.label);
        btn.innerHTML = '<span class="drv-map-layer-ico">' + l.icon + '</span>';
        btn.addEventListener('click', function () {
          tiles.setLayer(l.id);
          layerId = l.id;
          var all = div.querySelectorAll('.drv-map-layer-btn');
          for (var i = 0; i < all.length; i++) all[i].classList.remove('is-active');
          btn.classList.add('is-active');
        });
        div.appendChild(btn);
      });
      return div;
    };
    group.addTo(map);
    return { control: group, tiles: tiles };
  }

  global.MapTiles = {
    addTiles: addTiles,
    addDarkTiles: addDarkTiles,
    addLayerSwitcher: addLayerSwitcher,
    LAYERS: LAYERS,
    PROXY: PROXY,
    OSM_DIRECT: OSM_DIRECT,
  };
})(window);
