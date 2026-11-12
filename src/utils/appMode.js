/**
 * App Mode Detection — xác định ứng dụng nào được phục vụ cho request.
 * ─────────────────────────────────────────────────────────────────────────────
 * Tách riêng khỏi server.js để:
 *  - Test được logic ưu tiên Host header (quan trọng cho Driver Portal).
 *  - server.js và test dùng CHUNG một nguồn sự thật.
 *
 * Quy tắc ưu tiên:
 *  1. HOST header trỏ tới subdomain driver (giaohang.*) → 'driver'
 *     (ưu tiên cao nhất — nginx có thể set X-App-Mode sai khi dùng chung
 *      server_block, còn Host luôn đúng theo domain người dùng gõ).
 *  2. Header X-App-Mode do nginx set (fallback cho domain khác).
 *  3. Host header (fallback khi không có header).
 */

const ADMIN_DOMAIN = process.env.ADMIN_DOMAIN || 'admin.biatuoitayninh.store';
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || 'biatuoitayninh.store';
const DRIVER_DOMAIN = process.env.DRIVER_DOMAIN || 'giaohang.biatuoitayninh.store';

/**
 * @param {object} req - Express request (chỉ cần req.headers)
 * @returns {'admin'|'public'|'driver'}
 */
function getAppMode(req) {
  const headers = (req && req.headers) || {};
  const host = (headers.host || '').split(':')[0].toLowerCase();

  // ── 1. Driver subdomain — kiểm TRƯỚC admin để tránh nhầm ──
  if (
    host === DRIVER_DOMAIN ||
    host === 'driver.localhost' ||
    host.startsWith('giaohang.')
  ) return 'driver';

  // ── 2. Header do nginx set ──
  const mode = headers['x-app-mode'];
  if (mode === 'driver') return 'driver';
  if (mode === 'admin') return 'admin';
  if (mode === 'public') return 'public';

  // ── 3. Fallback theo Host ──
  if (
    host === ADMIN_DOMAIN ||
    host.endsWith('.admin.' + PUBLIC_DOMAIN.replace('www.', '')) ||
    host === 'admin.localhost' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.startsWith('admin.')
  ) return 'admin';

  return 'public';
}

module.exports = {
  getAppMode,
  ADMIN_DOMAIN,
  PUBLIC_DOMAIN,
  DRIVER_DOMAIN,
};
