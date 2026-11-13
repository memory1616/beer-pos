/**
 * Audit Log Middleware — Ghi nhật ký tự động (A3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount sau `requireAuth` (cần `req.user` để biết ai thao tác).
 *
 * Nguyên tắc:
 *  1. CHỈ ghi route MUTATION (POST / PUT / PATCH / DELETE) — đọc (GET) không
 *     tạo giá trị và làm bảng phình to vô ích.
 *  2. Tự suy ra `entity` từ path: /api/sales → 'sale', /api/customers → 'customer'…
 *  3. Tự suy ra `action` từ method + entity: POST /api/sales → 'sale_created'.
 *  4. Route đã ghi log THỦ CÔNG (login, logout, session revoke…) sẽ bị bỏ qua
 *     qua `req.auditLogged` → không ghi trùng.
 *  5. FAIL-OPEN: lỗi audit không được làm hỏng request chính.
 *  6. BỎ QUA các endpoint nhạy cảm / không cần audit.
 */

const AuditLogService = require('../src/services/AuditLogService');

// ── Path KHÔNG audit ────────────────────────────────────────────────────────
// (đã ghi thủ công, hoặc nhạy cảm, hoặc nội bộ)
const SKIP_PATHS = [
  '/api/audit-log',        // chính nhật ký
  '/api/sessions',         // đã ghi thủ công trong route
  '/auth',                 // đã ghi thủ công trong route login
  '/api/auth',             // /api/auth/me — kiểm tra phiên, không audit
  '/api/discover',         // ping LAN scan
  '/api/backup',           // backup tự động, ghi riêng
  '/api/report-notify',    // có log riêng trong report_notifications
  '/api/sync',             // đồng bộ cloud, tần suất rất cao
  '/api/logs',             // đọc log
];

// ── Map path prefix → entity ────────────────────────────────────────────────
// Thứ tự QUAN TRỌNG: prefix dài/specific phải đứng TRƯỚC prefix ngắn hơn
// (vd '/api/driver/sales' phải trước '/api/driver'), vì resolveEntity() dừng
// ở match ĐẦU TIÊN.
const ENTITY_MAP = [
  // ── Driver Portal (namespace riêng, đứng trước '/api/driver') ──────────
  ['/api/driver/sales', 'sale'],
  ['/api/driver/sale', 'sale'],
  ['/api/driver/customers', 'customer'],
  ['/api/driver/deliveries', 'delivery'],
  ['/api/driver/delivery', 'delivery'],
  ['/api/driver/payments', 'payment'],
  ['/api/driver/keg-receipts', 'keg_receipt'],
  ['/api/driver/replacement', 'replacement'],
  ['/api/driver/promotions', 'promotion'],
  ['/api/driver/debts', 'debt'],

  // ── Admin API ───────────────────────────────────────────────────────────
  ['/api/sales', 'sale'],
  ['/api/customers', 'customer'],
  ['/api/products', 'product'],
  ['/api/expenses', 'expense'],
  ['/api/purchases', 'purchase'],
  ['/api/payments', 'payment'],
  ['/api/stock', 'stock'],
  ['/api/kegs', 'keg'],
  ['/api/segments', 'segment'],
  ['/api/promotions', 'promotion'],
  ['/api/users', 'user'],
  ['/api/admin', 'admin'],
  ['/api/driver', 'driver'],
  ['/api/settings', 'settings'],
  ['/api/reports', 'report'],
];

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Suy ra entity từ path. */
function resolveEntity(pathname) {
  for (const [prefix, entity] of ENTITY_MAP) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return entity;
  }
  return null;
}

/**
 * Suy ra entityId từ path.
 *
 * Ví dụ: '/api/sales/55' → '55'
 *
 * Cách làm: lấy prefix đã match (vd '/api/sales' → 2 phần tử), phần tử
 * đứng ngay sau đó trong path chính là id.
 * Lưu ý: phần tử đó PHẢI khớp với entity (tránh lấy nhầm segment khác).
 */
function resolveEntityId(pathname, entity) {
  if (!entity) return null;
  const parts = pathname.split('/').filter(Boolean);
  for (const [prefix] of ENTITY_MAP) {
    if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue;
    const prefixLen = prefix.split('/').filter(Boolean).length;
    const candidate = parts[prefixLen];
    if (candidate && !candidate.includes('.')) return candidate;
    return null;
  }
  return null;
}

/**
 * Suy ra action từ method + entity.
 * POST   → <entity>_created
 * PUT/PATCH → <entity>_updated
 * DELETE → <entity>_deleted
 */
function resolveAction(method, entity) {
  if (!entity) return null;
  if (method === 'POST') return `${entity}_created`;
  if (method === 'PUT' || method === 'PATCH') return `${entity}_updated`;
  if (method === 'DELETE') return `${entity}_deleted`;
  return null;
}

/**
 * Middleware audit tự động.
 * Đặt SAU requireAuth để có `req.user`.
 */
function auditLogger(req, res, next) {
  if (!MUTATION_METHODS.has(req.method)) return next();

  const pathname = (req.originalUrl || req.path || '').split('?')[0];

  // Bỏ qua path đã ghi thủ công
  if (SKIP_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return next();
  }

  const entity = resolveEntity(pathname);
  if (!entity) return next();

  const action = resolveAction(req.method, entity);

  // Suy ra entityId từ path: /api/sales/123 → '123'
  const entityId = resolveEntityId(pathname, entity);

  res.on('finish', () => {
    try {
      // Chỉ ghi khi request thành công (2xx) hoặc thất bại có chủ đích (4xx)
      // → 5xx là lỗi hệ thống, đã có error log riêng.
      const isFail = res.statusCode >= 400;
      const isServerError = res.statusCode >= 500;
      if (isServerError) return;

      // Route đã ghi log thủ công → không ghi trùng
      if (req.auditLogged) return;

      const user = req.user || {};

      AuditLogService.record({
        action: action || `${entity}_${req.method.toLowerCase()}`,
        actorUsername: user.username || null,
        actorRole: user.role || null,
        entity,
        entityId,
        description: `${req.method} ${pathname}`,
        status: isFail ? 'failed' : 'success',
        req,
      });
    } catch (_) {
      // FAIL-OPEN — bỏ qua lỗi audit
    }
  });

  next();
}

module.exports = auditLogger;
module.exports.resolveEntity = resolveEntity;
module.exports.resolveEntityId = resolveEntityId;
module.exports.resolveAction = resolveAction;
module.exports.SKIP_PATHS = SKIP_PATHS;
