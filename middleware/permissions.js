/**
 * RBAC & Data Sanitization Middleware — Driver Portal
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu: bảo vệ dữ liệu tài chính ở TẦNG BACKEND.
 *
 * Nguyên tắc:
 *  1. Mọi request của DRIVER đều bị kiểm tra server-side (không chỉ ẩn UI).
 *  2. DRIVER bị chặn khỏi toàn bộ API admin/báo cáo tài chính.
 *  3. Response cho DRIVER được sanitize — gỡ mọi field giá vốn / lợi nhuận /
 *     doanh thu tổng / biên lợi nhuận, kể cả field lạ/nested.
 *  4. DRIVER chỉ thấy dữ liệu thuộc phạm vi được phép (scope theo username).
 *
 * KHÔNG cần đổi schema DB để dùng middleware này.
 */

const db = require('../database');
const logger = require('../src/utils/logger');

// ── Roles ───────────────────────────────────────────────────────────────────
const ROLE_ADMIN = 'ADMIN';
const ROLE_DRIVER = 'DRIVER';

// ── Permission catalogue ───────────────────────────────────────────────────
// Dùng để tài liệu hóa + kiểm tra trong test. Middleware thực thi bằng
// whitelist path (bên dưới) vì nhanh và không phụ thuộc DB.
const PERMISSIONS = {
  DRIVER: [
    'SALE_VIEW',
    'SALE_CREATE',
    'SALE_UPDATE',
    'DELIVERY_VIEW',
    'DELIVERY_CREATE',
    'DELIVERY_UPDATE',
    'CUSTOMER_VIEW',
    'CUSTOMER_CREATE',
    'PRODUCT_VIEW',
    'INVENTORY_VIEW',
    'ORDER_HISTORY_VIEW',
  ],
  ADMIN: ['*'], // toàn quyền
};

const DRIVER_DENIED_PERMISSIONS = [
  'COST_VIEW',
  'PROFIT_VIEW',
  'REVENUE_REPORT_VIEW',
  'FINANCIAL_REPORT_VIEW',
  'ADMIN_VIEW',
  'USER_MANAGEMENT',
  'SYSTEM_SETTINGS',
  'SUPPLIER_VIEW',
  'DATABASE_BACKUP',
  'INVENTORY_COST_VIEW',
];

// ── Paths bị chặn hoàn toàn cho DRIVER ─────────────────────────────────────
//
// Thiết kế: DRIVER dùng DUY NHẤT namespace `/api/driver/*` (đã có middleware
// requireDriver riêng). Mọi API admin chung bị chặn ở backend để không thể
// lấy dữ liệu ngoài phạm vi quyền (kể cả khi gọi bằng Postman/DevTools).
const DRIVER_ALLOWED_API_PREFIXES = [
  '/api/driver',      // namespace chính của Driver Portal
  '/api/auth/me',     // kiểm tra phiên đăng nhập
  '/api/ping',        // health check
  '/api/discover',    // LAN discovery
];

const DRIVER_DENIED_PATH_PREFIXES = [
  // Báo cáo & phân tích tài chính
  '/api/analytics',
  '/api/report',
  '/report',
  '/api/state',        // full state chứa cost_price
  '/api/expenses',
  '/api/purchases',
  '/api/backup',
  '/api/settings',
  '/api/devices',
  '/api/sales-staff',
  '/api/segments',
  '/api/batch',
  '/api/sync',
  '/api/routing',      // tính chi phí giao hàng/km
  '/api/session',
  '/api/admin',       // quản lý tài khoản tài xế (chỉ ADMIN)
  // Nghiệp vụ bán hàng / kho / giá — driver dùng bản /api/driver/* (đã scope)
  '/api/sales',
  '/api/orders',
  '/api/customers',
  '/api/products',
  '/api/payments',
  '/api/debts',
  '/api/kegs',
  '/api/stock',
  '/api/promotions',
];

// Write paths bị chặn cho DRIVER (ngoài những path được allow riêng).
const DRIVER_DENIED_METHODS_ON = {};

// ── Field bị loại bỏ khỏi response cho DRIVER ───────────────────────────────
const FORBIDDEN_FIELDS = new Set([
  'profit',
  'totalProfit',
  'total_profit',
  'grossProfit',
  'gross_profit',
  'netProfit',
  'net_profit',
  'cost_price',
  'costPrice',
  'cost',
  'totalCost',
  'total_cost',
  'purchase_price',
  'margin',
  'marginPercent',
  'margin_percent',
  'profitMargin',
  'profit_margin',
  'grossMargin',
  'netMargin',
  'totalRevenue',
  'total_revenue',
  'revenue',
  'returned_profit',
  'returnedProfit',
]);

// Field chứa số liệu tài chính tổng hợp (dưới dạng mảng report).
const FORBIDDEN_ARRAY_KEYS = new Set([
  'profitByProduct',
  'profitByCustomer',
  'profit_by_product',
  'profit_by_customer',
  'profitByMonth',
  'revenueByProduct',
  'revenue_by_product',
]);

// ── Helper: sanitize object đệ quy ────────────────────────────────────────
function sanitizeObject(input, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(input)) {
    return input.map((v) => sanitizeObject(v, depth + 1));
  }
  if (input && typeof input === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (FORBIDDEN_FIELDS.has(key)) continue;
      if (FORBIDDEN_ARRAY_KEYS.has(key)) continue;
      out[key] = sanitizeObject(value, depth + 1);
    }
    return out;
  }
  return input;
}

/**
 * Middleware gắn response sanitizer cho role DRIVER.
 * Wrap res.json để lọc mọi field tài chính trước khi gửi về client.
 */
function attachSanitizer(req, res, next) {
  if (req.user?.role !== ROLE_DRIVER) return next();

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const sanitized = sanitizeObject(body);
    return originalJson(sanitized);
  };
  return next();
}

// ── Resolve role từ session ────────────────────────────────────────────────
function getSessionRole(req) {
  const session = req.user;
  if (!session) return null;
  return session.role || ROLE_ADMIN;
}

// ── Optional auth: resolve session nếu có, KHÔNG chặn request ──────────────
/**
 * Đọc token từ cookie / Authorization header và gắn req.user nếu session hợp lệ.
 * KHÔNG trả 401 — để giữ nguyên hành vi hiện tại của các API công khai
 * (landing page, LAN device sync /api/sync/*) và để admin không bị ảnh hưởng.
 *
 * Mục đích: apiGuard chỉ cần biết "request này có phải của DRIVER không".
 */
function optionalAuth(req, res, next) {
  const adminCookieToken = req.cookies?.session_token;
  const driverCookieToken = req.cookies?.driver_session_token;
  const headerToken = req.headers.authorization?.replace('Bearer ', '');
  // Thứ tự ưu tiên giống requireAuth: header > driver cookie > admin cookie.
  // Nếu không, cookie admin sẽ "đè" session driver → resolve sai role.
  const token = headerToken || driverCookieToken || adminCookieToken;

  if (token) {
    try {
      const { getSession } = require('./auth');
      const session = getSession(token);
      if (session) req.user = session;
    } catch (_) {}
  }
  next();
}

// ── Guard: chặn API không dành cho DRIVER ───────────────────────────────────
/**
 * Phải mount SAU optionalAuth và TRƯỚC các route handler.
 * - ADMIN / request không đăng nhập → đi qua (giữ nguyên hành vi hiện tại).
 * - DRIVER → chỉ được dùng namespace /api/driver/*.
 */
function apiGuard(req, res, next) {
  const role = getSessionRole(req);
  if (role !== ROLE_DRIVER) return next(); // ADMIN (hoặc không có role) → qua

  const path = req.path; // ví dụ /api/sales/123
  const method = req.method.toUpperCase();

  // 1. Chỉ cho phép namespace API dành riêng cho driver
  const isAllowed = DRIVER_ALLOWED_API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix + '/')
  );
  if (!isAllowed) {
    return res.status(403).json({
      error: 'Tài khoản tài xế không có quyền truy cập chức năng này',
      code: 'DRIVER_FORBIDDEN',
      path,
    });
  }

  // 2. Chặn path bị cấm (phòng thủ nhiều lớp)
  for (const prefix of DRIVER_DENIED_PATH_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + '/')) {
      return res.status(403).json({
        error: 'Tài khoản tài xế không có quyền truy cập chức năng này',
        code: 'DRIVER_FORBIDDEN',
        path,
      });
    }
  }

  // 3. Namespace /api/driver chỉ được dùng với các method an toàn đã khai báo
  //    (driver.js / driverSale.js tự kiểm tra requireDriver + scope theo username).
  //    DELETE bị chặn trừ khi là xoá đơn / phiếu của CHÍNH tài xế:
  //      /api/driver/sales/:id  và  /api/driver/sale/:id
  //      /api/driver/keg-receipts/:id  (KegReceiptService scope theo driver_username)
  if (path.startsWith('/api/driver') && method === 'DELETE') {
    const isOwnSaleDelete =
      /^\/api\/driver\/sales\/\d+$/.test(path) || /^\/api\/driver\/sale\/\d+$/.test(path);
    const isOwnKegReceiptDelete = /^\/api\/driver\/keg-receipts\/\d+$/.test(path);
    if (!isOwnSaleDelete && !isOwnKegReceiptDelete) {
      return res.status(403).json({
        error: 'Thao tác không được phép',
        code: 'DRIVER_FORBIDDEN',
        path,
      });
    }
  }

  return next();
}

// ── Guard: chặn page HTML quản trị ─────────────────────────────────────────
/**
 * Chặn driver truy cập các trang quản trị.
 * Mount ở nhánh view routes (áp dụng khi req.user.role === DRIVER).
 */
const ADMIN_ONLY_PAGES = [
  '/dashboard',
  '/stock',
  '/purchases',
  '/promo-settings',
  '/qr-settings',
  '/backup',
  '/expenses',
  '/report',
  '/analytics',
  '/products',
  '/devices',
  '/sales-staff',
  '/customer/:id',
  '/customers',
  '/delivery',
  '/kegs',
  '/walkin-kegs',
];

function adminPageGuard(req, res, next) {
  if (getSessionRole(req) !== ROLE_DRIVER) return next();

  // API đã được apiGuard xử lý riêng — không đụng vào
  if (req.path.startsWith('/api')) return next();

  // Driver chỉ được vào các trang của Driver Portal
  // '/auth/driver' + '/auth/driver/logout' PHẢI được cho phép — nếu không,
  // tài xế đã đăng nhập (còn cookie) mà mở lại form đăng nhập sẽ bị 403.
  const allowed = ['/', '/login', '/logout', '/driver', '/auth/driver', '/auth/driver/logout'];
  if (allowed.includes(req.path) || req.path.startsWith('/driver')) {
    return next();
  }

  // Trang quản trị → 403 (không redirect, tránh vòng lặp giữa 2 subdomain)
  return res.status(403).send(
    '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Không có quyền truy cập</title>' +
    '<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8eb;' +
    'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;' +
    'text-align:center;padding:24px}.c{max-width:420px}h1{font-size:20px;margin:0 0 12px}' +
    'p{color:#9aa3ad;line-height:1.6;font-size:14px}</style></head><body><div class="c">' +
    '<h1>403 — Không có quyền truy cập</h1>' +
    '<p>Tài khoản tài xế không được phép mở chức năng quản trị. ' +
    'Vui lòng dùng Driver Portal tại giaohang.biatuoitayninh.store.</p>' +
    '<p><a href="/driver" style="color:#4ade80">→ Về Driver Portal</a></p>' +
    '</div></body></html>'
  );
}

// ── Scope: giới hạn dữ liệu theo tài xế ───────────────────────────────────
/**
 * Áp dụng cho các route handler dùng chung với admin.
 * Driver chỉ được xem sales mình tạo (driver_username = req.user.username).
 * Trả về điều kiện SQL để ghép vào WHERE.
 */
function salesScopeClause(req, alias = 's') {
  if (getSessionRole(req) !== ROLE_DRIVER) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.driver_username = ?`, params: [req.user.username] };
}

/**
 * Kiểm tra driver có quyền truy cập sale này không.
 */
function canAccessSale(req, sale) {
  if (getSessionRole(req) !== ROLE_DRIVER) return true;
  if (!sale) return false;
  return sale.driver_username === req.user.username;
}

module.exports = {
  ROLE_ADMIN,
  ROLE_DRIVER,
  PERMISSIONS,
  DRIVER_DENIED_PERMISSIONS,
  DRIVER_DENIED_PATH_PREFIXES,
  DRIVER_ALLOWED_API_PREFIXES,
  FORBIDDEN_FIELDS,
  sanitizeObject,
  attachSanitizer,
  optionalAuth,
  apiGuard,
  adminPageGuard,
  salesScopeClause,
  canAccessSale,
  getSessionRole,
  logger,
  db,
};
