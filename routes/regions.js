/**
 * Trang Admin — QUẢN LÝ KHU VỰC GIAO HÀNG
 * ─────────────────────────────────────────────────────────────────────────────
 * Cho phép:
 *  - Xem danh sách 9 khu vực kinh doanh + tài xế phụ trách + số khách hàng.
 *  - Gán / thay đổi / ngừng phân công tài xế cho khu vực.
 *  - Gán NHIỀU khu vực cho MỘT tài xế (checkbox multi-select).
 *  - Xem thống kê khách hàng / sản lượng theo khu vực.
 *  - Xem lịch sử phân công.
 *  - Điều phối đơn chờ (chưa có tài xế) + chuyển đơn giữa các tài xế.
 *
 * Phân quyền: chỉ ADMIN (backend kiểm tra ở /api/admin/regions/*).
 */

const express = require('express');
const router = express.Router();
const path = require('path');

// GET /regions — Trang quản lý khu vực giao hàng
router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../views/regions.html'));
});

module.exports = router;
