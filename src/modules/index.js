/**
 * Beer POS - Modules Index
 * Feature #13: Tách Sales/Keg/Inventory thành 3 module rõ ràng
 *
 * Cấu trúc module:
 * - sales/     - Sales module (đơn hàng)
 * - keg/       - Keg module (vỏ bình, ledger)
 * - inventory/ - Inventory module (tồn kho)
 */

const sales = require('./sales');
const keg = require('./keg');
const inventory = require('./inventory');

module.exports = {
  sales,
  keg,
  inventory
};
