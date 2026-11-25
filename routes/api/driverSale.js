/**
 * Driver Portal — API PROXY cho module SALE (Admin)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu: cho tài xế chạy NGUYÊN module Sale của Admin
 * (`views/sales.html` + `public/js/sales.js`) mà KHÔNG sửa 1 dòng nghiệp vụ
 * và KHÔNG lộ dữ liệu tài chính.
 *
 * Cơ chế:
 *  - `public/js/sales.js` gọi các path Admin: /sale/data, /sale/history,
 *    /sale/:id, /api/products, /api/promotions/*, /api/settings/qr-*,
 *    /api/sales/*, /api/kegs/*.
 *  - Shim `public/js/driver/api-shim.js` rewrite URL → /api/driver/sale/*
 *  - Router này phục vụ đúng contract (shape) mà Admin trả về, nhưng dữ liệu
 *    được scope theo tài xế và đã gỡ mọi field giá vốn / lợi nhuận.
 *
 * Nguyên tắc bất biến:
 *  - KHÔNG viết lại logic tính tiền / thưởng / công nợ / kho.
 *  - Mọi mutation đều forward về `routes/api/sales.js` (nghiệp vụ gốc).
 *  - KHÔNG tạo bảng mới; dùng chung `database.sqlite` với Admin.
 *
 * LƯU Ý THỨ TỰ ROUTE: route có tham số động (/:id) PHẢI đặt CUỐI file,
 * nếu không sẽ nuốt các path tĩnh như /qr-config, /products.
 */

const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const { PromotionService } = require('../../src/services');
const { ROLE_DRIVER } = require('../../middleware/permissions');

// Router sales chuẩn — dùng lại để forward (tái sử dụng nghiệp vụ)
const salesRouter = require('./sales');
const settingsRouter = require('./settings');
const kegsRouter = require('./kegs');

// ── Middleware: bắt buộc role DRIVER ───────────────────────────────────────
function requireDriver(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  if (req.user.role !== ROLE_DRIVER) {
    return res.status(403).json({
      error: 'API này chỉ dành cho tài khoản tài xế',
      code: 'DRIVER_ONLY',
    });
  }
  next();
}

// ── Helper: forward request nội bộ sang router sales chuẩn ─────────────────
/**
 * Gọi lại handler gốc của routes/api/sales.js để dùng đúng logic nghiệp vụ
 * (promotion, tier bonus, công nợ, kho, keg balance).
 *
 * @param {object} req
 * @param {object} res
 * @param {string} subPath - path tương đối trong router sales (vd: '/', '/123')
 * @param {string} method
 * @param {function} onJson - callback (payload) sau khi handler gốc res.json
 * @param {object} bodyOverride - body thay thế
 */
function forwardToSales(req, res, subPath, method, onJson, bodyOverride) {
  const originalJson = res.json.bind(res);
  let intercepted = false;

  res.json = (body) => {
    if (!intercepted && onJson) {
      intercepted = true;
      try {
        onJson(body);
      } catch (e) {
        logger.error('[driver-sale] forward onJson error', { error: e.message });
      }
    }
    return originalJson(body);
  };

  const originalUrl = req.url;
  const originalMethod = req.method;
  const originalBody = req.body;
  req.url = subPath;
  req.method = method;
  if (bodyOverride !== undefined) req.body = bodyOverride;

  salesRouter(req, res, (err) => {
    req.url = originalUrl;
    req.method = originalMethod;
    req.body = originalBody;
    if (err) {
      logger.error('[driver-sale] forward error', { error: err.message });
      return res.status(500).json({ error: 'Lỗi xử lý yêu cầu: ' + err.message });
    }
    res.status(404).json({ error: 'Không tìm thấy endpoint' });
  });
}

/**
 * Forward sang router khác (settings / kegs) — giữ nguyên nghiệp vụ gốc.
 */
function forwardTo(routerRef, req, res, subPath, label) {
  const originalUrl = req.url;
  req.url = subPath;
  routerRef(req, res, (err) => {
    req.url = originalUrl;
    if (err) {
      logger.error(`[driver-sale] ${label} error`, { error: err.message });
      return res.status(500).json({ error: 'Lỗi xử lý yêu cầu: ' + err.message });
    }
    res.status(404).json({ error: 'Không tìm thấy endpoint' });
  });
}

// ── Helper: scope đơn của tài xế ───────────────────────────────────────────
// Đồng bộ với `/history` và `DeliveryService.listForDriver`:
//   - đơn do chính tài xế tạo
//   - đơn CHƯA gán tài xế nào (NULL / chuỗi rỗng) → tài xế có thể nhận & xem
// Đơn đã gán cho tài xế KHÁC → không lộ (đúng nguyên tắc bảo mật).
/**
 * Lấy đơn mà tài xế ĐƯỢC phép xem/xử lý.
 *
 * PHÂN QUYỀN THEO KHU VỰC:
 *  - Đơn gán cho chính tài xế → OK.
 *  - Đơn CHƯA gán ai → OK nếu khu vực đơn thuộc quyền phụ trách.
 *  - Đơn gán tài xế khác → KHÔNG thấy.
 *  - Tài xế chưa được gán khu vực nào → hành vi cũ (chỉ đơn của mình /
 *    đơn chưa gán ai) để không phá vỡ vận hành hiện tại.
 */
function getOwnSale(saleId, username) {
  const sale = db
    .prepare(
      `SELECT * FROM sales
       WHERE id = ?
         AND (driver_username = ? OR driver_username IS NULL OR driver_username = '')`
    )
    .get(saleId, username);
  if (!sale) return null;

  const RegionService = require('../../src/services/RegionService');
  const check = RegionService.canDriverAccessSale(sale, username, 'DRIVER');
  if (check.allowed) return sale;

  // Chưa áp dụng phân quyền khu vực → giữ hành vi cũ
  // ⚠️ Chỉ bypass lý do "ngoài phạm vi khu vực"; đơn gán tài xế KHÁC vẫn chặn.
  if (RegionService.canBypassRegionCheck(check.code, username)) return sale;

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/sale/data — payload giống hệt GET /sale/data của Admin
// Shape: { customers, products, priceMap }
// KHÔNG có cost_price. Giữ đủ field để POS Admin hoạt động nguyên vẹn.
//
// PHÂN QUYỀN THEO KHU VỰC: danh sách khách hàng bị scope theo các khu vực
// được phân công phụ trách. Tài xế KHÔNG được thấy khách hàng ngoài lãnh thổ.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/data', requireDriver, (req, res) => {
  try {
    const RegionService = require('../../src/services/RegionService');
    const regionIds = RegionService.getDriverRegionIds(req.user.username);
    const restricted = regionIds.length > 0;
    // Hệ thống đã phân công khu vực nhưng tài xế chưa được gán khu vực nào
    // → không thấy khách hàng nào (chờ Admin phân công).
    const noAccess =
      !restricted && !RegionService.driverHasNoRegionRestriction(req.user.username);

    // Khách hàng: đủ field cho POS + badge quán mới (created_at) + giao hàng
    let customerSql =
      `SELECT id, name, phone, deposit, keg_balance, created_at, debt, address,
              lat, lng, last_order_date, note, reward_tier, monthly_purchased_liters,
              promotion_enabled, new_shop_enabled, reward_enabled, region_id
       FROM customers WHERE archived = 0 AND deleted = 0`;
    const customerParams = [];
    if (restricted) {
      customerSql += ` AND region_id IN (${regionIds.map(() => '?').join(',')})`;
      customerParams.push(...regionIds);
    } else if (noAccess) {
      customerSql += ' AND 1 = 0';
    }
    customerSql += ' ORDER BY name';
    const customers = db.prepare(customerSql).all(...customerParams);

    // Sản phẩm: BỎ cost_price (bảo mật) — giữ đúng field Admin POS dùng
    const products = db
      .prepare(
        `SELECT id, slug, name, stock, sell_price, type, damaged_stock
         FROM products WHERE archived = 0 AND deleted = 0 ORDER BY name`
      )
      .all();

    // Bảng giá riêng theo khách (dùng để tính giá bán đúng)
    // → chỉ giữ giá của khách hàng TRONG phạm vi được xem (tránh lộ giá riêng
    //   của khách ngoài lãnh thổ tài xế).
    const visibleCustomerIds = new Set(customers.map((c) => c.id));
    const prices = db.prepare('SELECT customer_id, product_id, product_slug, price FROM prices').all();
    const priceMap = {};
    prices.forEach((p) => {
      if (!visibleCustomerIds.has(p.customer_id)) return;
      if (!priceMap[p.customer_id]) priceMap[p.customer_id] = {};
      priceMap[p.customer_id][p.product_id] = p.price;
      if (p.product_slug) {
        if (!priceMap[p.customer_id]._bySlug) priceMap[p.customer_id]._bySlug = {};
        priceMap[p.customer_id]._bySlug[p.product_slug] = p.price;
      }
    });

    res.json({ customers, products, priceMap });
  } catch (err) {
    logger.error('[driver-sale] data error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải dữ liệu bán hàng' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/sale/products — sản phẩm (không cost_price)
// Shape: array (giống GET /api/products của Admin)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/products', requireDriver, (req, res) => {
  try {
    const products = db
      .prepare(
        `SELECT id, slug, name, stock, sell_price, type, damaged_stock
         FROM products WHERE archived = 0 AND deleted = 0 ORDER BY name`
      )
      .all();
    res.json(products);
  } catch (err) {
    logger.error('[driver-sale] products error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách sản phẩm' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/sale/history — lịch sử bán hàng (scope theo tài xế)
// Shape: { sales, total, page, totalPages }  (giống GET /sale/history)
//
// ĐỒNG BỘ 2 TRANG (Bán hàng ↔ Giao hàng):
//   Trang GIAO HÀNG dùng scope: đơn của chính tài xế + đơn CHƯA gán tài xế.
//   Nếu "ĐƠN GẦN ĐÂY" chỉ lọc `driver_username = ?` thì 2 trang lệch nhau
//   (đơn Admin tạo chưa gán xuất hiện ở Giao hàng nhưng biến mất ở ĐƠN GẦN ĐÂY).
//   → Dùng CHUNG scope với DeliveryService.listForDriver cho cả 2 trang.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/history', requireDriver, (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 5);
    const offset = (page - 1) * limit;

    const year = req.query.year ? parseInt(req.query.year) : null;
    const month = req.query.month ? parseInt(req.query.month) : null;

    // Scope thống nhất với trang Giao hàng:
    //   - đơn do chính tài xế tạo
    //   - đơn Admin tạo mà CHƯA gán tài xế nào (NULL hoặc chuỗi rỗng)
    //   - đơn gắn cho tài khoản KHÔNG CÒN TỒN TẠI trong app_users
    //     (vd: tài khoản test đã bị xoá) → coi như CHƯA GÁN.
    //     Bug: đơn "mồ" → Admin thấy nhưng Driver KHÔNG thấy → lệch 2 trang.
    //   - bỏ qua đơn của khách đã ẩn/archived (giống DeliveryService.listForDriver)
    //
    // PHÂN QUYỀN THEO KHU VỰC:
    //   Khi tài xế ĐÃ được phân công khu vực → chỉ thấy đơn của chính mình
    //   HOẶC đơn thuộc khu vực phụ trách. Đơn chưa gán tài xế nhưng nằm ngoài
    //   lãnh thổ → KHÔNG lộ (nằm trong hàng đợi điều phối của Admin).
    const RegionService = require('../../src/services/RegionService');
    const regionIds = RegionService.getDriverRegionIds(req.user.username);
    const regionRestricted = regionIds.length > 0;

    let whereClause =
      `WHERE s.type IN ('sale', 'replacement', 'damage_return')
         AND s.archived = 0
         AND s.deleted = 0`;
    const params = [];

    if (regionRestricted) {
      const ph = regionIds.map(() => '?').join(',');
      whereClause +=
        ` AND (s.driver_username = ? OR s.region_id IN (${ph}))`;
      params.push(req.user.username, ...regionIds);
    } else if (!RegionService.driverHasNoRegionRestriction(req.user.username)) {
      // Hệ thống đã phân công khu vực nhưng tài xế này chưa được gán khu vực
      // nào → KHÔNG thấy đơn nào (chờ Admin phân công).
      whereClause += ' AND 1 = 0';
    } else {
      whereClause +=
        ` AND (s.driver_username = ? OR s.driver_username IS NULL OR s.driver_username = ''
              OR s.driver_username NOT IN (SELECT username FROM app_users WHERE role = 'DRIVER'))`;
      params.push(req.user.username);
    }

    whereClause += ` AND (c.id IS NULL OR c.archived = 0)`;

    if (year && month) {
      const yStr = String(year);
      const mStr = String(month).padStart(2, '0');
      whereClause += " AND strftime('%Y-%m', s.date) = ?";
      params.push(yStr + '-' + mStr);
    }

    const total = db
      .prepare(
        `SELECT COUNT(*) as count FROM sales s
         LEFT JOIN customers c ON s.customer_id = c.id
         ${whereClause}`
      )
      .get(...params).count;
    const totalPages = Math.ceil(total / limit);

    const sales = db
      .prepare(
        `SELECT s.id, s.date, s.sale_time, s.total, s.type, s.status,
                COALESCE(c.name, 'Khách lẻ') as customer_name,
                s.deliver_kegs, s.return_kegs,
                s.driver_username,
                s.payment_status,
                s.delivery_status
         FROM sales s
         LEFT JOIN customers c ON s.customer_id = c.id
         ${whereClause}
         ORDER BY datetime(s.date || ' ' || COALESCE(s.sale_time, '00:00:00')) DESC, s.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    const salesWithItems = sales.map((s) => {
      const items = db
        .prepare(
          `SELECT si.quantity, si.price, p.name as product_name, p.type
           FROM sale_items si
           JOIN products p ON p.id = si.product_id AND p.archived = 0
           WHERE si.sale_id = ?`
        )
        .all(s.id);
      return { ...s, items };
    });

    res.json({ sales: salesWithItems, total, page, totalPages });
  } catch (err) {
    logger.error('[driver-sale] history error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải lịch sử bán hàng' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MODULE KHUYẾN MÃI — proxy (dùng CHUNG PromotionService, không viết lại)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/driver/sale/promotions/settings
router.get('/promotions/settings', requireDriver, (req, res) => {
  try {
    const settings = PromotionService.getSystemPromotionSettings();
    res.json({ success: true, data: settings });
  } catch (err) {
    logger.error('[driver-sale] promo settings error', { error: err.message });
    res.status(500).json({ success: false, error: 'Lỗi khi tải cấu hình khuyến mãi' });
  }
});

// GET /api/driver/sale/promotions/new-shop/check/:customerId
router.get('/promotions/new-shop/check/:customerId', requireDriver, (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (!customerId) return res.status(400).json({ success: false, error: 'ID không hợp lệ' });

    const result = PromotionService.isNewShopEligible(customerId);
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('[driver-sale] new-shop check error', { error: err.message });
    res.status(500).json({ success: false, error: 'Lỗi khi kiểm tra quán mới' });
  }
});

// GET /api/driver/sale/promotions/new-shop/monthly-summary/:customerId
// Shape GIỐNG HỆT GET /api/promotions/new-shop/monthly-summary/:customerId của Admin
// → đảm bảo `public/js/sales.js` dùng lại được nguyên logic hiển thị Card "Thưởng quán mới".
router.get('/promotions/new-shop/monthly-summary/:customerId', requireDriver, (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (!customerId) return res.status(400).json({ success: false, error: 'ID không hợp lệ' });

    const customer = db
      .prepare('SELECT created_at, promotion_enabled, new_shop_enabled FROM customers WHERE id = ? AND archived = 0')
      .get(customerId);
    if (!customer || !customer.created_at) {
      return res.json({
        success: true,
        data: {
          eligible: false,
          reason: 'Không tìm thấy khách hàng',
          yellowVolume: 0,
          blackVolume: 0,
          yellowReward: 0,
          blackReward: 0,
          totalReward: 0,
        },
      });
    }

    // ── Cờ bật/tắt ở mức KHÁCH HÀNG ────────────────────────────────────
    // Khách bị admin tắt riêng "khuyến mãi quán mới" (new_shop_enabled)
    // hoặc tắt chung "tham gia CTKM" (promotion_enabled) → không hiển thị card.
    if (customer.promotion_enabled === 0) {
      return res.json({
        success: true,
        data: {
          eligible: false,
          reason: 'Khách đã tắt tham gia CTKM',
          yellowVolume: 0,
          blackVolume: 0,
          yellowReward: 0,
          blackReward: 0,
          totalReward: 0,
        },
      });
    }

    if (customer.new_shop_enabled === 0) {
      return res.json({
        success: true,
        data: {
          eligible: false,
          reason: 'Khách đã tắt khuyến mãi quán mới',
          yellowVolume: 0,
          blackVolume: 0,
          yellowReward: 0,
          blackReward: 0,
          totalReward: 0,
        },
      });
    }

    const created = new Date(customer.created_at);
    const openYear = created.getFullYear();
    const openMonth = created.getMonth() + 1;
    const now = new Date();
    const isOpenMonth = now.getFullYear() === openYear && now.getMonth() + 1 === openMonth;

    if (!isOpenMonth) {
      return res.json({
        success: true,
        data: {
          eligible: false,
          openYear,
          openMonth,
          reason: 'Không thuộc tháng mở quán',
          yellowVolume: 0,
          blackVolume: 0,
          yellowReward: 0,
          blackReward: 0,
          totalReward: 0,
        },
      });
    }

    const calc = PromotionService.calculateNewShopMonthlyReward(customerId, openYear, openMonth);
    res.json({
      success: true,
      data: {
        eligible: true,
        openYear,
        openMonth,
        yellowVolume: calc.yellowVolume,
        blackVolume: calc.blackVolume,
        yellowReward: calc.yellowReward,
        blackReward: calc.blackReward,
        totalReward: calc.totalReward,
      },
    });
  } catch (err) {
    logger.error('[driver-sale] new-shop monthly-summary error', { error: err.message });
    res.status(500).json({ success: false, error: 'Lỗi khi tải tổng hợp khuyến mãi quán mới' });
  }
});

// GET /api/driver/sale/promotions/customer/:customerId/overview
// Shape GIỐNG HỆT GET /api/promotions/customer/:customerId/overview của Admin
// → đảm bảo `public/js/sales.js` dùng lại được nguyên logic hiển thị badge.
router.get('/promotions/customer/:customerId/overview', requireDriver, (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (!customerId) return res.status(400).json({ success: false, error: 'ID không hợp lệ' });

    const customer = db
      .prepare(
        'SELECT id, name, promotion_enabled, new_shop_enabled, reward_enabled, created_at FROM customers WHERE id = ? AND archived = 0'
      )
      .get(customerId);
    if (!customer) return res.status(404).json({ success: false, error: 'Không tìm thấy khách hàng' });

    const settings = PromotionService.getSystemPromotionSettings();

    const customerNewShopEnabled = customer.new_shop_enabled !== null ? customer.new_shop_enabled : 1;
    const customerRewardEnabled = customer.reward_enabled !== null ? customer.reward_enabled : 1;

    const promoType = PromotionService.getCustomerPromotionType(customerId);
    const { isNewShopPromotion, isRewardEligible, reason } = promoType;

    let newShopInfo = null;
    if (isNewShopPromotion && customer.promotion_enabled !== 0 && customerNewShopEnabled) {
      newShopInfo = PromotionService.isNewShopEligible(customerId);
    }

    let rewardInfo = null;
    if (isRewardEligible && customer.promotion_enabled !== 0 && customerRewardEnabled) {
      rewardInfo = PromotionService.calculateMonthlyReward(customerId);
    }

    const promotionStartDate = PromotionService.getPromotionStartDate(customer);

    res.json({
      success: true,
      data: {
        customerId,
        customerName: customer.name,
        createdAt: customer.created_at,
        promotionEnabled: customer.promotion_enabled !== 0,
        newShopEnabled: customerNewShopEnabled,
        rewardEnabled: customerRewardEnabled,
        systemNewShopEnabled: settings.newShopEnabled,
        systemRewardEnabled: settings.rewardEnabled,
        isNewShopPromotion,
        isRewardEligible,
        promotionReason: reason,
        promotionStartDate: promotionStartDate,
        isInNewShopPeriod: isNewShopPromotion,
        canReceiveReward: isRewardEligible,
        isWithinPromotionPeriod: PromotionService.isWithinPromotionPeriod(),
        promotionEndDate: settings.endDate,
        newShop: newShopInfo,
        newShopSettings: {
          // QUY TẮC 2026-11-22: quán mới chỉ tặng bia vàng, tỉ lệ áp dụng cho TỔNG vàng+đen.
          goldBuy: settings.newShopGoldBuy,
          goldFree: settings.newShopGoldFree,
          blackBuy: settings.newShopGoldBuy,
          blackFree: 0,
        },
        rewardTiers: settings.rewardTiers,
        monthlyReward: rewardInfo,
      },
    });
  } catch (err) {
    logger.error('[driver-sale] promo overview error', { error: err.message });
    res.status(500).json({ success: false, error: 'Lỗi khi tải thông tin khuyến mãi' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MODULE QR — proxy sang routes/api/settings.js
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/driver/sale/qr-config
router.get('/qr-config', requireDriver, (req, res) => {
  forwardTo(settingsRouter, req, res, '/qr-config', 'qr-config');
});

// GET /api/driver/sale/qr-accounts/active
router.get('/qr-accounts/active', requireDriver, (req, res) => {
  forwardTo(settingsRouter, req, res, '/qr-accounts/active', 'qr-accounts');
});

// ═══════════════════════════════════════════════════════════════════════════
// MODULE VỎ (kegs) — proxy sang routes/api/kegs.js
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/driver/sale/kegs/deliver
router.post('/kegs/deliver', requireDriver, (req, res) => {
  forwardTo(kegsRouter, req, res, '/deliver', 'keg deliver');
});

// POST /api/driver/sale/kegs/collect
router.post('/kegs/collect', requireDriver, (req, res) => {
  forwardTo(kegsRouter, req, res, '/collect', 'keg collect');
});

// ═══════════════════════════════════════════════════════════════════════════
// MUTATIONS — forward sang routes/api/sales.js (nghiệp vụ gốc)
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/driver/sale — tạo đơn (forward POST /api/sales)
router.post('/', requireDriver, (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    // Driver không được dùng giảm giá nhân viên (staffId) — bỏ qua.
    delete body.staffId;

    // Gán tài xế NGAY TRONG body → route gốc INSERT một lần với
    // driver_username đúng (atomic, không có khoảng trống thời gian).
    // Nhờ vậy đơn lập tức hiện đồng thời ở "ĐƠN GẦN ĐÂY" và trang Giao hàng.
    body.driverUsername = req.user.username;

    forwardToSales(req, res, '/', 'POST', (payload) => {
      // Fallback: nếu route gốc chưa hỗ trợ driverUsername (deploy cũ),
      // vẫn gán bằng UPDATE để không mất dữ liệu.
      if (payload && payload.success && payload.id) {
        try {
          db.prepare(
            'UPDATE sales SET driver_username = ? WHERE id = ? AND (driver_username IS NULL OR driver_username = ?)'
          ).run(req.user.username, payload.id, req.user.username);
        } catch (e) {
          logger.error('[driver-sale] set driver_username error', { error: e.message });
        }
      }
    }, body);
  } catch (err) {
    logger.error('[driver-sale] create error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tạo đơn hàng: ' + err.message });
  }
});

// POST /api/driver/sale/update-kegs — cập nhật vỏ giao/thu
// Forward POST /api/sales/update-kegs (nghiệp vụ gốc).
router.post('/update-kegs', requireDriver, (req, res) => {
  try {
    const body = req.body || {};
    const saleId = parseInt(body.saleId);
    if (!saleId) return res.status(400).json({ error: 'Thiếu saleId' });

    const sale = getOwnSale(saleId, req.user.username);
    if (!sale) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    forwardToSales(req, res, '/update-kegs', 'POST', null, {
      saleId,
      customerId: sale.customer_id,
      deliver: parseInt(body.deliver) || 0,
      returned: parseInt(body.returned) || 0,
    });
  } catch (err) {
    logger.error('[driver-sale] update-kegs error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật vỏ: ' + err.message });
  }
});

// POST /api/driver/sale/replacement — đổi bia lỗi / tặng uống thử
// Forward POST /api/sales/replacement (nghiệp vụ gốc).
router.post('/replacement', requireDriver, (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    const quantity = parseInt(body.quantity) || 0;
    const productId = parseInt(body.product_id || body.productId) || 0;
    const isGift = !!body.gift;

    if (!productId || quantity <= 0) {
      return res.status(400).json({ error: 'Thiếu thông tin cần thiết' });
    }
    if (!isGift && !body.customer_id) {
      return res.status(400).json({ error: 'Vui lòng chọn khách hàng' });
    }

    forwardToSales(
      req,
      res,
      '/replacement',
      'POST',
      (payload) => {
        // Fallback: nếu route gốc chưa hỗ trợ driverUsername (deploy cũ),
        // tìm đơn vừa tạo và gán tài xế.
        if (payload && payload.success) {
          try {
            const row = db
              .prepare(
                `SELECT id FROM sales
                 WHERE type = 'replacement'
                   AND archived = 0
                   AND deleted = 0
                   AND (driver_username IS NULL OR driver_username = '')
                   AND (customer_id IS ? OR customer_id = ?)
                 ORDER BY id DESC LIMIT 1`
              )
              .get(
                body.customer_id ? parseInt(body.customer_id) : null,
                body.customer_id ? parseInt(body.customer_id) : null
              );
            if (row && row.id) {
              db.prepare('UPDATE sales SET driver_username = ? WHERE id = ?').run(
                req.user.username,
                row.id
              );
            }
          } catch (e) {
            logger.error('[driver-sale] replacement set driver_username error', { error: e.message });
          }
        }
      },
      {
        customer_id: body.customer_id ? parseInt(body.customer_id) : null,
        product_id: productId,
        quantity,
        reason: body.reason || 'Bia hư',
        gift: isGift,
        giftGuestName: body.giftGuestName || body.gift_guest_name || '',
        // Gán tài xế ngay lúc INSERT → đơn đổi lỗi hiện ở "ĐƠN GẦN ĐÂY"
        driverUsername: req.user.username,
      }
    );
  } catch (err) {
    logger.error('[driver-sale] replacement error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi đổi bia lỗi: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE CÓ THAM SỐ ĐỘNG — PHẢI ĐỂ CUỐI FILE
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/driver/sale/:id — chi tiết đơn (shape giống GET /sale/:id)
// Shape: { sale: { ...sale, items } } — BỎ cost_price / profit.
router.get('/:id', requireDriver, (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    if (!saleId) return res.status(400).json({ error: 'ID đơn hàng không hợp lệ' });

    const sale = getOwnSale(saleId, req.user.username);
    if (!sale) {
      // Đơn do Admin tạo (chưa gán tài xế) hoặc của tài xế khác → không lộ.
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    const customer = sale.customer_id
      ? db.prepare('SELECT id, name, keg_balance, debt_code FROM customers WHERE id = ?').get(sale.customer_id)
      : null;

    const items = db
      .prepare(
        `SELECT si.id, si.product_id, si.quantity, si.price, si.product_slug,
                si.paid_quantity, si.reward_quantity, si.reward_source,
                p.name as product_name, p.slug, p.type
         FROM sale_items si
         JOIN products p ON p.id = si.product_id
         WHERE si.sale_id = ?`
      )
      .all(saleId);

    // Loại bỏ field tài chính khỏi sale (profit / sales_id nội bộ)
    const { profit: _profit, sales_id: _salesId, ...safeSale } = sale;

    res.json({
      sale: {
        ...safeSale,
        customer_name: customer ? customer.name : 'Khách lẻ',
        customer_keg_balance: customer ? customer.keg_balance : 0,
        customer_debt_code: customer ? customer.debt_code : null,
        items,
      },
    });
  } catch (err) {
    logger.error('[driver-sale] detail error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải chi tiết đơn hàng' });
  }
});

// PUT /api/driver/sale/:id — sửa đơn của mình (forward PUT /api/sales/:id)
router.put('/:id', requireDriver, (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    if (!saleId) return res.status(400).json({ error: 'ID đơn hàng không hợp lệ' });

    const sale = getOwnSale(saleId, req.user.username);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

    const body = { ...(req.body || {}) };
    delete body.staffId;

    forwardToSales(req, res, `/${saleId}`, 'PUT', null, body);
  } catch (err) {
    logger.error('[driver-sale] update error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật đơn hàng: ' + err.message });
  }
});

// DELETE /api/driver/sale/:id — huỷ đơn của mình (forward DELETE /api/sales/:id)
router.delete('/:id', requireDriver, (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    if (!saleId) return res.status(400).json({ error: 'ID đơn hàng không hợp lệ' });

    const sale = getOwnSale(saleId, req.user.username);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

    forwardToSales(req, res, `/${saleId}`, 'DELETE', null);
  } catch (err) {
    logger.error('[driver-sale] delete error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi huỷ đơn hàng: ' + err.message });
  }
});

// PATCH /api/driver/sale/:id/payment-status — cập nhật trạng thái thanh toán
// Forward PATCH /api/sales/:id/payment-status (nghiệp vụ gốc).
router.patch('/:id/payment-status', requireDriver, (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    if (!saleId) return res.status(400).json({ error: 'ID đơn hàng không hợp lệ' });

    const sale = getOwnSale(saleId, req.user.username);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

    forwardToSales(req, res, `/${saleId}/payment-status`, 'PATCH', null, req.body || {});
  } catch (err) {
    logger.error('[driver-sale] payment-status error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật trạng thái thanh toán: ' + err.message });
  }
});

module.exports = router;
