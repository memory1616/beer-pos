// Shared logger for routes — re-export from utils
// Usage: const logger = require('../../src/utils/logger');
// Or simply use a thin shim to avoid module resolution issues
let logger;
try {
  logger = require('../src/utils/logger');
} catch (e) {
  // Fallback if logger not available
  logger = {
    info: console.log,
    error: console.error,
    warn: console.warn,
    debug: console.log,
    http: console.log,
  };
}
module.exports = logger;
