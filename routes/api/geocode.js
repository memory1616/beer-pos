/**
 * API Reverse Geocode — /api/geocode/reverse
 * ─────────────────────────────────────────────────────────────────────────────
 * Cho phép tra địa chỉ từ tọa độ GPS (server-side proxy + cache).
 * Xem logic chi tiết trong `src/services/GeocodeService.js`.
 *
 * ROUTES:
 *   GET  /api/geocode/reverse?lat=..&lng=..   → tra địa chỉ (tài xế + admin)
 *   POST /api/geocode/reverse-body {lat,lng}  → như trên (body)
 *   POST /api/geocode/backfill {ids|all}       → backfill hàng loạt (ADMIN)
 */
const express = require('express');
const router = express.Router();
const logger = require('../../src/utils/logger');
const GeocodeService = require('../../src/services/GeocodeService');
const { ROLE_ADMIN } = require('../../middleware/permissions');

/** Chỉ ADMIN được chạy thao tác backfill hàng loạt */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  if (req.user.role !== ROLE_ADMIN) {
    return res.status(403).json({
      error: 'Chỉ quản trị viên mới được thực hiện thao tác này',
      code: 'ADMIN_ONLY',
    });
  }
  next();
}

/** Rate-limit theo IP — 60 req/phút */
function rateLimit(req, res, next) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  if (!GeocodeService.rateLimitCheck(ip)) {
    return res.status(429).json({
      error: 'Quá nhiều yêu cầu tra địa chỉ. Vui lòng thử lại sau 1 phút.',
      code: 'GEOCODE_RATE_LIMIT',
    });
  }
  next();
}

function parseCoords(lat, lng) {
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
  if (!GeocodeService.isInServiceArea(latNum, lngNum)) return null;
  return { lat: latNum, lng: lngNum };
}

/**
 * GET /api/geocode/reverse?lat=11.321&lng=106.108
 */
router.get('/reverse', rateLimit, async (req, res) => {
  const coords = parseCoords(req.query.lat, req.query.lng);
  if (!coords) {
    return res.status(400).json({
      error: 'Tọa độ không hợp lệ hoặc nằm ngoài phạm vi phục vụ',
      code: 'GEOCODE_INVALID_COORDS',
    });
  }

  try {
    const result = await GeocodeService.reverseGeocode(coords.lat, coords.lng);
    return res.json({
      success: true,
      address: result.address,
      displayName: result.displayName,
      source: result.source,
      cached: result.cached,
    });
  } catch (err) {
    logger.warn('[geocode] khong tra duoc dia chi', {
      lat: coords.lat,
      lng: coords.lng,
      error: err.message,
    });
    return res.status(502).json({
      error: 'Không tra được địa chỉ từ tọa độ này',
      code: 'GEOCODE_FAILED',
    });
  }
});

/**
 * POST /api/geocode/reverse-body { lat, lng }
 */
router.post('/reverse-body', rateLimit, async (req, res) => {
  const coords = parseCoords(req.body?.lat, req.body?.lng);
  if (!coords) {
    return res.status(400).json({
      error: 'Tọa độ không hợp lệ hoặc nằm ngoài phạm vi phục vụ',
      code: 'GEOCODE_INVALID_COORDS',
    });
  }
  try {
    const result = await GeocodeService.reverseGeocode(coords.lat, coords.lng);
    return res.json({
      success: true,
      address: result.address,
      displayName: result.displayName,
      source: result.source,
      cached: result.cached,
    });
  } catch (err) {
    logger.warn('[geocode] khong tra duoc dia chi', {
      lat: coords.lat,
      lng: coords.lng,
      error: err.message,
    });
    return res.status(502).json({
      error: 'Không tra được địa chỉ từ tọa độ này',
      code: 'GEOCODE_FAILED',
    });
  }
});

/**
 * POST /api/geocode/backfill { ids: [1,2] } | { all: true }
 * → Tra & ghi địa chỉ cho khách đã có GPS nhưng chưa có địa chỉ.
 */
router.post('/backfill', requireAdmin, async (req, res) => {
  try {
    const db = require('../../database');
    const result = await GeocodeService.backfillAddresses(db, {
      ids: req.body?.ids,
      all: req.body?.all === true,
      delayMs: req.body?.delayMs,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[geocode] backfill error', { error: err.message });
    return res.status(400).json({ error: err.message });
  }
});

module.exports = router;
