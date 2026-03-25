/**
 * Beer POS - Inventory Module Index
 * Feature #13: Tách Sales/Keg/Inventory thành 3 module rõ ràng
 */
const inventoryService = require('./service');

module.exports = {
  ...inventoryService
};
