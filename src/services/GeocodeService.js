/**
 * GeocodeService — Tra địa chỉ từ tọa độ GPS (reverse geocoding)
 * ─────────────────────────────────────────────────────────────────────────────
 * MỤC TIÊU:
 *   Khi khách hàng ĐÃ CÓ tọa độ GPS nhưng CHƯA CÓ địa chỉ → tự động tra
 *   địa chỉ để tài xế/nhân viên không phải gõ tay, và để "Chỉ đường" hoạt
 *   động dựa trên địa chỉ chứ không chỉ tọa độ.
 *
 * VÌ SAO LÀM SERVER-SIDE (không gọi Nominatim trực tiếp từ trình duyệt)?
 *   1. Nominatim yêu cầu User-Agent hợp lệ + giới hạn ~1 req/giây/IP →
 *      gọi từ nhiều máy khách sẽ bị 429 rất nhanh.
 *   2. Cache tập trung → mỗi tọa độ chỉ gọi ra ngoài 1 lần cho toàn hệ thống.
 *   3. Có dedupe (request cùng tọa độ đang chờ → dùng chung promise).
 *   4. Rate-limit + hàng đợi → không spam dịch vụ bên thứ ba.
 *
 * NGUỒN DỮ LIỆU (theo thứ tự ưu tiên):
 *   1. Nominatim (OpenStreetMap) — chi tiết tốt ở Việt Nam, miễn phí.
 *   2. Esri World Geocoding — dự phòng.
 *
 * PHẠM VI:
 *   Chỉ phục vụ vùng Tây Ninh + lân cận để không bị lạm dụng làm proxy mở.
 */
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════════════════════════════
// HẠNG MỨC & PHẠM VI
// ═══════════════════════════════════════════════════════════════════════════
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 60;
const rateBuckets = new Map();

// Bounding box vùng phục vụ (Tây Ninh + vùng lân cận)
const BBOX = { minLat: 10.4, maxLat: 12.2, minLng: 104.8, maxLng: 107.4 };

function isInServiceArea(lat, lng) {
  return (
    lat >= BBOX.minLat && lat <= BBOX.maxLat &&
    lng >= BBOX.minLng && lng <= BBOX.maxLng
  );
}

function rateLimitCheck(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.start > RATE_WINDOW_MS) {
    b = { start: now, count: 0 };
    rateBuckets.set(ip, b);
  }
  b.count += 1;
  if (rateBuckets.size > 500) {
    for (const [k, v] of rateBuckets) {
      if (now - v.start > RATE_WINDOW_MS) rateBuckets.delete(k);
    }
  }
  return b.count <= RATE_MAX;
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE (LRU trong bộ nhớ) — TTL 30 ngày, key = tọa độ làm tròn 5 chữ số (~1.1m)
// ═══════════════════════════════════════════════════════════════════════════
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_MAX = 2000;
const cache = new Map();

function cacheKey(lat, lng) {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key); // LRU: đưa lên đầu
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, at: Date.now() });
}

// ═══════════════════════════════════════════════════════════════════════════
// REQUEST ĐANG CHỜ (dedupe)
// ═══════════════════════════════════════════════════════════════════════════
const inflight = new Map();

// ═══════════════════════════════════════════════════════════════════════════
// GỌI DỊCH VỤ NGOÀI
// ═══════════════════════════════════════════════════════════════════════════
const UA = 'BeerPOS/2.2 (Bia Tuoi Tay Ninh POS; admin@biatuoitayninh.store)';

function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'vi,en',
      Accept: 'application/json',
    },
    signal: controller.signal,
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .finally(() => clearTimeout(timer));
}

/**
 * Chuẩn hóa chuỗi địa chỉ kiểu Việt Nam.
 * Nominatim trả: "Số 12, Đường Lê Lợi, Phường 2, Thị xã Trảng Bàng, Tây Ninh, Việt Nam"
 * → giữ tối đa 4 cấp đầu, bỏ "Việt Nam".
 */
function normalizeAddress(address) {
  if (!address) return null;
  const parts = String(address)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^việt nam$/i.test(p) && !/^vietnam$/i.test(p));
  if (!parts.length) return null;
  const cleaned = parts.slice(0, 4);
  return cleaned.join(', ') || null;
}

/** Nominatim — OpenStreetMap */
function viaNominatim(lat, lng) {
  const url =
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}` +
    `&format=jsonv2&zoom=18&addressdetails=1&accept-language=vi`;
  return fetchJson(url).then((data) => {
    if (!data || data.error) throw new Error(data?.error || 'Nominatim: no result');
    const a = data.address || {};
    const parts = [];
    const house = [a.house_number, a.road].filter(Boolean).join(' ');
    if (house) parts.push(house);
    for (const key of ['suburb', 'neighbourhood', 'hamlet', 'village', 'ward', 'town', 'city', 'county', 'state']) {
      const v = a[key];
      if (v && !parts.includes(v)) parts.push(v);
    }
    const composed = parts.length ? parts.join(', ') : data.display_name;
    const address = normalizeAddress(composed) || normalizeAddress(data.display_name);
    if (!address) throw new Error('Nominatim: empty address');
    return {
      address,
      displayName: data.display_name || address,
      source: 'nominatim',
      country: a.country || null,
      city: a.city || a.town || a.village || a.county || null,
    };
  });
}

/** Esri World Geocoding — dự phòng */
function viaEsri(lat, lng) {
  const url =
    `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode` +
    `?location=${lng},${lat}&f=json&outSR=4326`;
  return fetchJson(url).then((data) => {
    const a = (data && data.address) || {};

    // Ưu tiên `Match_addr` (đầy đủ nhất, vd: "Đường Tỉnh Lộ 786, Long Chữ,
    // Tây Ninh, 80518") → bỏ mã bưu chính + quốc gia.
    let parts = [];
    if (a.Match_addr) {
      parts = String(a.Match_addr)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .filter((p) => !/^\d{4,6}$/.test(p)) // mã bưu chính
        .filter((p) => !/^vn$/i.test(p));
    }

    // Bổ sung nếu Match_addr thiếu (ví dụ không có số nhà).
    for (const key of ['Address', 'Neighborhood', 'City', 'SubadminCity', 'Region']) {
      const v = a[key];
      if (v && !parts.includes(v)) parts.push(v);
    }

    const address = normalizeAddress(parts.join(', '));
    if (!address) throw new Error('Esri: empty address');
    return {
      address,
      displayName: parts.join(', '),
      source: 'esri',
      city: a.City || a.SubadminCity || null,
      region: a.Region || null,
    };
  });
}

/**
 * Tra địa chỉ từ tọa độ (có cache + dedupe + fallback)
 *
 * THỨ TỰ NGUỒN: Nominatim TRƯỚC, Esri SAU (fallback).
 * KHÔNG dùng `Promise.any` vì nó "đua" → nguồn trả nhanh hơn thắng, dù chất
 * lượng kém hơn. Nominatim có dữ liệu địa danh Việt Nam chi tiết hơn
 * ("Xã Long Chữ, Tây Ninh") nên luôn ưu tiên.
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{address:string, displayName:string, source:string, cached:boolean}>}
 */
async function reverseGeocode(lat, lng) {
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    throw new Error('Tọa độ không hợp lệ');
  }
  if (!isInServiceArea(latNum, lngNum)) {
    throw new Error('Tọa độ nằm ngoài phạm vi phục vụ');
  }

  const key = cacheKey(latNum, lngNum);

  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  // Request cùng tọa độ đang chờ → dùng chung promise
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    try {
      const result = await viaNominatim(latNum, lngNum);
      cacheSet(key, result);
      return { ...result, cached: false };
    } catch (nomErr) {
      // Nominatim lỗi/timeout → thử Esri
      try {
        const result = await viaEsri(latNum, lngNum);
        cacheSet(key, result);
        return { ...result, cached: false, fallbackFrom: nomErr.message };
      } catch (esriErr) {
        throw new Error(`${nomErr.message} | ${esriErr.message}`);
      }
    }
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, task);
  return task;
}

/**
 * Bảo đảm khách hàng có địa chỉ: nếu đã có lat/lng nhưng thiếu địa chỉ → tra & ghi.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {number} customerId
 * @param {{lat?:number,lng?:number}} [opts]
 * @returns {Promise<{filled:boolean, address?:string, source?:string}>}
 */
async function ensureCustomerAddress(db, customerId, opts = {}) {
  try {
    const row = db
      .prepare('SELECT id, lat, lng, address FROM customers WHERE id = ?')
      .get(customerId);
    if (!row) return { filled: false };

    // Đã có địa chỉ → không đụng tới (không ghi đè địa chỉ người dùng nhập).
    if (row.address && String(row.address).trim()) return { filled: false, address: row.address };

    const lat = opts.lat !== undefined ? parseFloat(opts.lat) : parseFloat(row.lat);
    const lng = opts.lng !== undefined ? parseFloat(opts.lng) : parseFloat(row.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { filled: false };

    const result = await reverseGeocode(lat, lng);
    const changed = db
      .prepare(
        `UPDATE customers SET address = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND (address IS NULL OR TRIM(address) = '')`
      )
      .run(result.address, customerId).changes;

    if (changed) {
      logger.info('[GEOCODE] da dien dia chi tu GPS', {
        customerId,
        lat,
        lng,
        source: result.source,
      });
    }
    return { filled: !!changed, address: result.address, source: result.source };
  } catch (err) {
    logger.warn('[GEOCODE] khong dien duoc dia chi', {
      customerId,
      error: err.message,
    });
    return { filled: false, error: err.message };
  }
}

/**
 * Backfill hàng loạt: các khách ĐÃ CÓ GPS nhưng CHƯA CÓ địa chỉ.
 * Xử lý tuần tự + nghỉ giữa các lần gọi (tôn trọng giới hạn 1 req/s của Nominatim).
 *
 * @param {object} db
 * @param {{ids?:number[], all?:boolean, delayMs?:number}} opts
 */
async function backfillAddresses(db, opts = {}) {
  const ids = Array.isArray(opts.ids) ? opts.ids.map(Number).filter(Number.isFinite) : null;
  const all = !!opts.all;

  let rows;
  if (ids && ids.length) {
    const marks = ids.map(() => '?').join(',');
    rows = db
      .prepare(
        `SELECT id, lat, lng FROM customers
          WHERE id IN (${marks})
            AND lat IS NOT NULL AND lng IS NOT NULL
            AND (address IS NULL OR TRIM(address) = '')
            AND archived = 0 AND deleted = 0`
      )
      .all(...ids);
  } else if (all) {
    rows = db
      .prepare(
        `SELECT id, lat, lng FROM customers
          WHERE lat IS NOT NULL AND lng IS NOT NULL
            AND (address IS NULL OR TRIM(address) = '')
            AND archived = 0 AND deleted = 0`
      )
      .all();
  } else {
    throw new Error('Cần truyền ids[] hoặc all=true');
  }

  const results = [];
  let updated = 0;
  const delayMs = opts.delayMs !== undefined ? opts.delayMs : 1100;

  for (const row of rows) {
    try {
      const r = await reverseGeocode(parseFloat(row.lat), parseFloat(row.lng));
      const changed = db
        .prepare(
          `UPDATE customers SET address = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND (address IS NULL OR TRIM(address) = '')`
        )
        .run(r.address, row.id).changes;
      if (changed) updated += 1;
      results.push({ id: row.id, address: r.address, source: r.source, updated: !!changed });
    } catch (err) {
      results.push({ id: row.id, error: err.message });
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { total: rows.length, updated, results };
}

module.exports = {
  reverseGeocode,
  ensureCustomerAddress,
  backfillAddresses,
  normalizeAddress,
  isInServiceArea,
  rateLimitCheck,
  // nội bộ (test)
  _cache: cache,
  _inflight: inflight,
};
