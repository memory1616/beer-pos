/**
 * Public API — Danh mục khu vực kinh doanh (đọc)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount tại /api/regions — dùng cho:
 *  - Dropdown "Khu vực khách hàng" trong form tạo/sửa khách hàng.
 *  - Bộ lọc khách hàng theo khu vực.
 *  - Driver Portal: xem khu vực được giao (chỉ tài xế phụ trách).
 *
 * CHỈ ĐỌC — mọi thao tác gán/thay đổi nằm ở /api/admin/regions (ADMIN).
 */

const express = require('express');
const router = express.Router();
const logger = require('../../src/utils/logger');
const RegionService = require('../../src/services/RegionService');

// GET /api/regions — danh mục khu vực đang active
router.get('/', (req, res) => {
  try {
    const regions = RegionService.listRegions().map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
    }));
    res.json({ success: true, regions });
  } catch (err) {
    logger.error('[api/regions] list error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh mục khu vực' });
  }
});

// GET /api/regions/my — khu vực mà tài xế hiện tại phụ trách (Driver Portal)
router.get('/my', (req, res) => {
  try {
    const username = req.user?.username;
    if (!username) {
      return res.json({ success: true, regions: [] });
    }
    const rows = require('../../database')
      .prepare(
        `SELECT r.id, r.name, r.code, a.assigned_at
         FROM region_driver_assignments a
         JOIN business_regions r ON r.id = a.region_id
         WHERE a.active = 1 AND a.driver_username = ?
         ORDER BY r.sort_order, r.name`
      )
      .all(String(username).toLowerCase());
    res.json({ success: true, regions: rows });
  } catch (err) {
    logger.error('[api/regions] my error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải khu vực phụ trách' });
  }
});

// GET /api/regions/suggest?lat=&lng=&address= — gợi ý khu vực (KHÔNG ghi đè lựa chọn)
router.get('/suggest', (req, res) => {
  try {
    const suggestion = RegionService.suggestRegion({
      lat: req.query.lat ? parseFloat(req.query.lat) : undefined,
      lng: req.query.lng ? parseFloat(req.query.lng) : undefined,
      address: req.query.address || '',
    });
    res.json({ success: true, suggestion });
  } catch (err) {
    logger.error('[api/regions] suggest error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi gợi ý khu vực' });
  }
});

module.exports = router;
