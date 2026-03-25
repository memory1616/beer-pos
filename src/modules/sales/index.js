/**
 * Beer POS - Sales Module Index
 * Feature #13: Tách Sales/Keg/Inventory thành 3 module rõ ràng
 *
 * Sales Module chịu trách nhiệm:
 * - Tạo/cập nhật/xóa đơn hàng (sales + sale_items)
 * - Tính total/profit cho đơn hàng
 * - Gọi Keg Module để cập nhật vỏ bình
 * - Gọi Inventory Module để cập nhật tồn kho
 */
const salesService = require('./service');

module.exports = {
  ...salesService
};
