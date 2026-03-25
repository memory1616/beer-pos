/**
 * Beer POS - Keg Module Index
 * Feature #13: Tách Sales/Keg/Inventory thành 3 module rõ ràng
 *
 * Keg Module chịu trách nhiệm:
 * - Quản lý vỏ bình (keg)
 * - Ledger: ghi nhận mọi di chuyển vỏ
 * - Cập nhật customer keg_balance
 * - Đồng bộ keg_stats
 *
 * Pools:
 *   inventory  — kho đầy bia (products.stock WHERE type='keg')
 *   empty      — kho vỏ rỗng đã thu (keg_stats.empty_collected)
 *   customer   — khách đang giữ (customers.keg_balance)
 *   factory    — bên ngoài hệ thống (nhà máy, bán đi…)
 */
const ledger = require('./ledger');
const service = require('./service');

module.exports = {
  // Ledger functions (core)
  ...ledger,
  // Service functions (customer balance)
  ...service
};
