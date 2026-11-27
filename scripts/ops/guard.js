/**
 * Shim: giữ đường dẫn `scripts/ops/guard.js` cho các script cũ.
 *
 * Module THẬT nằm ở `src/utils/dbWriteGuard.js` (vì thư mục `scripts/`
 * bị loại khỏi deploy — xem deploy/deploy_local.ps1 → $excludeDirs).
 */
module.exports = require('../../src/utils/dbWriteGuard');
