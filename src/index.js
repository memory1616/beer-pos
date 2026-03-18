/**
 * Beer POS - Main Index
 * Export all modules for easy importing
 */

const calc = require('./services/calc');
const storage = require('./services/storage');
const validation = require('./services/validation');
const date = require('./services/date');
const format = require('./utils/format');
const types = require('./types/models');

module.exports = {
  calc,
  storage,
  validation,
  date,
  format,
  types
};
