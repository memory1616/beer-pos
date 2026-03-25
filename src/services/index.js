/**
 * Beer POS - Services Index
 * Export all services
 */

const calc = require('./calc');
const storage = require('./storage');
const validation = require('./validation');
const date = require('./date');

module.exports = {
  calc,
  storage,
  validation,
  date
};
