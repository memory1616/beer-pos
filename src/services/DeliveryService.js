/**
 * DeliveryService — Nghiệp vụ giao hàng cho Driver Portal
 * ─────────────────────────────────────────────────────────────────────────────
 * Nguyên tắc:
 *  - KHÔNG nhân bản nghiệp vụ bán hàng. Mọi đơn giao đều gắn với `sales.id`
 *    (đơn đã tạo qua logic Sale chuẩn của hệ thống).
 *  - Mọi thay đổi trạng thái đều ghi vào `delivery_events` kèm tài khoản tài xế.
 *  - Cập nhật số vỏ keg dùng lại đúng logic của hệ thống (keg_stats + customer).
 *  - KHÔNG đụng vào cột `profit` / `cost_price`.
 */

// Trạng thái đơn giao hàng
const DELIVERY_STATUS = {
  PENDING: 'PENDING',           // Chờ giao
  IN_PROGRESS: 'IN_PROGRESS',   // Đang giao
  DELIVERED: 'DELIVERED',       // Đã giao
  FAILED: 'FAILED',             // Giao thất bại
  DISCREPANCY: 'DISCREPANCY',   // Chờ xử lý sai lệch
};

const STATUS_LABELS = {
  PENDING: 'Chờ giao',
  IN_PROGRESS: 'Đang giao',
  DELIVERED: 'Đã giao',
  FAILED: 'Giao thất bại',
  DISCREPANCY: 'Chờ xử lý sai lệch',
};

// Chuyển trạng thái hợp lệ
const ALLOWED_TRANSITIONS = {
  PENDING: ['IN_PROGRESS', 'DELIVERED', 'FAILED'],
  IN_PROGRESS: ['DELIVERED', 'FAILED', 'PENDING'],
  DELIVERED: ['DISCREPANCY'],
  FAILED: ['PENDING', 'IN_PROGRESS', 'DISCREPANCY'],
  DISCREPANCY: ['IN_PROGRESS', 'DELIVERED'],
};

const db = require('../../database');
const logger = require('../../src/utils/logger');

class DeliveryService {
  /**
   * Lấy danh sách đơn cần giao cho 1 tài xế trong ngày.
   * Nguồn: các `sales` đã tạo (type='sale') chưa có delivery_record
   * hoặc đã có nhưng chưa hoàn tất.
   */
  static listForDriver(driverUsername, opts = {}) {
    const date = opts.date || db.getVietnamDateStr();
    const limit = Math.min(500, parseInt(opts.limit) || 200);

    const rows = db
      .prepare(
        `
        SELECT
          s.id AS sale_id,
          s.date,
          s.sale_time,
          s.total,
          s.deliver_kegs,
          s.return_kegs,
          s.customer_id,
          s.promo_free_liters,
          s.promo_type,
          s.payment_status,
          s.driver_username,
          c.name AS customer_name,
          c.phone AS customer_phone,
          c.address AS customer_address,
          c.lat,
          c.lng,
          c.keg_balance,
          dr.id AS delivery_id,
          dr.status AS delivery_status,
          dr.delivered_liters,
          dr.missing_liters,
          dr.excess_liters,
          dr.damaged_liters,
          dr.collected_kegs,
          dr.expected_kegs,
          dr.note AS delivery_note,
          dr.failure_reason
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        LEFT JOIN delivery_records dr
               ON dr.sale_id = s.id AND dr.driver_username = ?
        WHERE s.type = 'sale'
          AND s.archived = 0
          AND s.deleted = 0
          AND c.archived = 0
          AND DATE(s.date) = ?
          AND (
                dr.id IS NULL
             OR dr.status NOT IN ('DELIVERED')
          )
        ORDER BY dr.status IS NOT NULL, dr.status = 'IN_PROGRESS' DESC,
                 COALESCE(c.name, 'Khách lẻ'), s.id DESC
        LIMIT ?
      `
      )
      .all(driverUsername, date, limit);

    return rows;
  }

  /**
   * Lấy danh sách đơn ĐÃ giao của tài xế (lịch sử).
   */
  static listHistory(driverUsername, opts = {}) {
    const limit = Math.min(500, parseInt(opts.limit) || 100);
    const date = opts.date || null;
    const status = opts.status || null;

    let sql = `
      SELECT dr.*, c.name AS customer_name, c.phone AS customer_phone,
             c.address AS customer_address, s.total AS sale_total
      FROM delivery_records dr
      LEFT JOIN customers c ON c.id = dr.customer_id
      LEFT JOIN sales s ON s.id = dr.sale_id
      WHERE dr.driver_username = ?`;
    const params = [driverUsername];

    if (date) {
      sql += ` AND DATE(dr.scheduled_date) = ?`;
      params.push(date);
    }
    if (status) {
      sql += ` AND dr.status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY dr.id DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params);
  }

  /**
   * Lấy chi tiết 1 đơn giao (kèm items chi tiết và lịch sử sự kiện).
   */
  static getById(deliveryId, driverUsername) {
    const record = db
      .prepare(
        `
        SELECT dr.*, c.name AS customer_name, c.phone AS customer_phone,
               c.address AS customer_address, c.lat, c.lng,
               s.total AS sale_total, s.date AS sale_date
        FROM delivery_records dr
        LEFT JOIN customers c ON c.id = dr.customer_id
        LEFT JOIN sales s ON s.id = dr.sale_id
        WHERE dr.id = ? AND dr.driver_username = ?
      `
      )
      .get(deliveryId, driverUsername);

    if (!record) return null;

    const items = db
      .prepare('SELECT * FROM delivery_record_items WHERE delivery_id = ? ORDER BY id')
      .all(deliveryId);

    const events = db
      .prepare('SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY id DESC')
      .all(deliveryId);

    return { ...record, items, events };
  }

  /**
   * Tạo (hoặc lấy) delivery record cho 1 đơn bán.
   * Nếu record đã tồn tại → trả về record cũ (idempotent, tránh nhân đôi).
   */
  static ensureRecord(saleId, driverUsername) {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) return { success: false, error: 'Không tìm thấy đơn hàng' };

    const existing = db
      .prepare('SELECT * FROM delivery_records WHERE sale_id = ? AND driver_username = ?')
      .get(saleId, driverUsername);
    if (existing) return { success: true, delivery: existing, created: false };

    // Lấy danh sách sản phẩm cần giao từ sale_items
    const items = db
      .prepare(
        `SELECT si.product_id, si.quantity, si.price, si.reward_quantity, si.reward_source,
                p.name AS product_name, p.type AS product_type
         FROM sale_items si
         LEFT JOIN products p ON p.id = si.product_id
         WHERE si.sale_id = ?`
      )
      .all(saleId);

    const expectedKegs = items
      .filter((i) => i.product_type !== 'pet')
      .reduce((sum, i) => sum + (i.quantity || 0), 0);

    try {
      const result = db
        .prepare(
          `INSERT INTO delivery_records
             (sale_id, customer_id, driver_username, status, scheduled_date,
              expected_kegs, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        )
        .run(
          saleId,
          sale.customer_id || null,
          driverUsername,
          DELIVERY_STATUS.PENDING,
          sale.date || db.getVietnamDateStr(),
          expectedKegs
        );

      const deliveryId = result.lastInsertRowid;

      // Ghi chi tiết sản phẩm
      const insertItem = db.prepare(
        `INSERT INTO delivery_record_items
           (delivery_id, product_id, product_name, expected_quantity,
            delivered_quantity, is_reward, note)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      );
      for (const item of items) {
        const isReward = (item.reward_quantity || 0) > 0 || item.reward_source === 'MONTHLY_BONUS';
        insertItem.run(
          deliveryId,
          item.product_id,
          item.product_name || '',
          item.quantity || 0,
          isReward ? 1 : 0,
          isReward ? 'Hàng thưởng' : null
        );
      }

      DeliveryService.logEvent(deliveryId, 'CREATED', null, DELIVERY_STATUS.PENDING, driverUsername, {
        saleId,
      });

      const record = db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(deliveryId);
      return { success: true, delivery: record, created: true };
    } catch (e) {
      logger.error('[DeliveryService] ensureRecord error', { error: e.message, saleId });
      return { success: false, error: e.message };
    }
  }

  /**
   * Cập nhật trạng thái đơn giao.
   */
  static updateStatus(deliveryId, toStatus, driverUsername, opts = {}) {
    const record = db
      .prepare('SELECT * FROM delivery_records WHERE id = ? AND driver_username = ?')
      .get(deliveryId, driverUsername);
    if (!record) return { success: false, error: 'Không tìm thấy đơn giao' };

    if (!Object.values(DELIVERY_STATUS).includes(toStatus)) {
      return { success: false, error: 'Trạng thái không hợp lệ' };
    }

    const allowed = ALLOWED_TRANSITIONS[record.status] || [];
    if (record.status !== toStatus && !allowed.includes(toStatus)) {
      return {
        success: false,
        error: `Không thể chuyển từ "${STATUS_LABELS[record.status]}" sang "${STATUS_LABELS[toStatus]}"`,
      };
    }

    const now = db.getVietnamDateStr() + ' ' + db.getVietnamTimeStr();
    const startedAt = toStatus === DELIVERY_STATUS.IN_PROGRESS ? now : record.started_at;
    const completedAt =
      toStatus === DELIVERY_STATUS.DELIVERED || toStatus === DELIVERY_STATUS.FAILED
        ? now
        : record.completed_at;

    try {
      db.prepare(
        `UPDATE delivery_records
         SET status = ?, started_at = ?, completed_at = ?,
             note = COALESCE(?, note), failure_reason = COALESCE(?, failure_reason),
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        toStatus,
        startedAt,
        completedAt,
        opts.note ?? null,
        toStatus === DELIVERY_STATUS.FAILED ? opts.failureReason || null : null,
        deliveryId
      );

      // Đồng bộ trạng thái giao hàng trên bảng sales (để admin theo dõi)
      try {
        db.prepare('UPDATE sales SET delivery_status = ? WHERE id = ?').run(toStatus, record.sale_id);
      } catch (_) {}

      DeliveryService.logEvent(deliveryId, 'STATUS_CHANGED', record.status, toStatus, driverUsername, {
        note: opts.note || null,
        failureReason: opts.failureReason || null,
      });

      const updated = db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(deliveryId);
      return { success: true, delivery: updated };
    } catch (e) {
      logger.error('[DeliveryService] updateStatus error', { error: e.message });
      return { success: false, error: e.message };
    }
  }

  /**
   * Xác nhận số lượng giao thực tế (từng sản phẩm) + số vỏ thu hồi.
   * Tính missing/excess/damaged tự động so với expected.
   */
  static confirmDelivery(deliveryId, driverUsername, payload = {}) {
    const record = db
      .prepare('SELECT * FROM delivery_records WHERE id = ? AND driver_username = ?')
      .get(deliveryId, driverUsername);
    if (!record) return { success: false, error: 'Không tìm thấy đơn giao' };

    const items = payload.items || [];
    const collectedKegs = payload.collectedKegs !== undefined ? parseInt(payload.collectedKegs) : 0;
    const note = payload.note || null;

    try {
      const tx = db.transaction(() => {
        let totalDelivered = 0;
        let totalMissing = 0;
        let totalExcess = 0;
        let totalDamaged = 0;

        for (const input of items) {
          const item = db
            .prepare('SELECT * FROM delivery_record_items WHERE id = ? AND delivery_id = ?')
            .get(input.itemId, deliveryId);
          if (!item) continue;

          const expected = item.expected_quantity || 0;
          const delivered = Number(input.deliveredQuantity ?? expected) || 0;
          const damaged = Number(input.damagedQuantity || 0) || 0;
          const excess = Number(input.excessQuantity || 0) || 0;

          // Missing = expected - delivered (không âm). Nếu delivered > expected → tính excess.
          let missing = expected - delivered;
          if (missing < 0) {
            excess += -missing;
            missing = 0;
          }

          db.prepare(
            `UPDATE delivery_record_items
             SET delivered_quantity = ?, missing_quantity = ?, excess_quantity = ?,
                 damaged_quantity = ?, note = COALESCE(?, note)
             WHERE id = ?`
          ).run(delivered, missing, excess, damaged, input.note || null, item.id);

          totalDelivered += delivered;
          totalMissing += missing;
          totalExcess += excess;
          totalDamaged += damaged;
        }

        // Thiếu/thừa/hư hỏng → trạng thái DISCREPANCY nếu có sai lệch
        let nextStatus = record.status;
        if (totalMissing > 0 || totalExcess > 0 || totalDamaged > 0) {
          nextStatus = DELIVERY_STATUS.DISCREPANCY;
        } else if (record.status === DELIVERY_STATUS.IN_PROGRESS || record.status === DELIVERY_STATUS.PENDING) {
          nextStatus = DELIVERY_STATUS.DELIVERED;
        }

        db.prepare(
          `UPDATE delivery_records
           SET delivered_liters = ?, missing_liters = ?, excess_liters = ?, damaged_liters = ?,
               collected_kegs = ?, status = ?, completed_at = ?,
               note = COALESCE(?, note), updated_at = datetime('now')
           WHERE id = ?`
        ).run(
          totalDelivered,
          totalMissing,
          totalExcess,
          totalDamaged,
          collectedKegs,
          nextStatus,
          nextStatus === DELIVERY_STATUS.DELIVERED ? db.getVietnamDateStr() + ' ' + db.getVietnamTimeStr() : null,
          note,
          deliveryId
        );

        try {
          db.prepare('UPDATE sales SET delivery_status = ? WHERE id = ?').run(nextStatus, record.sale_id);
        } catch (_) {}

        DeliveryService.logEvent(
          deliveryId,
          'CONFIRMED',
          record.status,
          nextStatus,
          driverUsername,
          {
            delivered: totalDelivered,
            missing: totalMissing,
            excess: totalExcess,
            damaged: totalDamaged,
            collectedKegs,
          }
        );

        return {
          totalDelivered,
          totalMissing,
          totalExcess,
          totalDamaged,
          collectedKegs,
          nextStatus,
        };
      });

      const summary = tx();
      const updated = db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(deliveryId);
      return { success: true, delivery: updated, summary };
    } catch (e) {
      logger.error('[DeliveryService] confirmDelivery error', { error: e.message });
      return { success: false, error: e.message };
    }
  }

  /**
   * Ghi nhận sai lệch (thiếu / thừa / hư hỏng) — dùng khi giao xong nhưng có vấn đề.
   */
  static recordDiscrepancy(deliveryId, driverUsername, payload = {}) {
    const record = db
      .prepare('SELECT * FROM delivery_records WHERE id = ? AND driver_username = ?')
        .get(deliveryId, driverUsername);
    if (!record) return { success: false, error: 'Không tìm thấy đơn giao' };

    const missing = Number(payload.missingLiters || 0) || 0;
    const excess = Number(payload.excessLiters || 0) || 0;
    const damaged = Number(payload.damagedLiters || 0) || 0;

    try {
      db.prepare(
        `UPDATE delivery_records
         SET missing_liters = ?, excess_liters = ?, damaged_liters = ?,
             status = ?, note = COALESCE(?, note), updated_at = datetime('now')
         WHERE id = ?`
      ).run(missing, excess, damaged, DELIVERY_STATUS.DISCREPANCY, payload.note || null, deliveryId);

      try {
        db.prepare('UPDATE sales SET delivery_status = ? WHERE id = ?').run(
          DELIVERY_STATUS.DISCREPANCY,
          record.sale_id
        );
      } catch (_) {}

      DeliveryService.logEvent(
        deliveryId,
        'DISCREPANCY',
        record.status,
        DELIVERY_STATUS.DISCREPANCY,
        driverUsername,
        { missing, excess, damaged }
      );

      const updated = db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(deliveryId);
      return { success: true, delivery: updated };
    } catch (e) {
      logger.error('[DeliveryService] recordDiscrepancy error', { error: e.message });
      return { success: false, error: e.message };
    }
  }

  /**
   * Cập nhật số vỏ keg đã thu hồi trên đơn.
   * Dùng lại cơ chế cập nhật vỏ của hệ thống (keg_stats + customer balance).
   */
  static updateCollectedKegs(deliveryId, driverUsername, collectedKegs) {
    const record = db
      .prepare('SELECT * FROM delivery_records WHERE id = ? AND driver_username = ?')
      .get(deliveryId, driverUsername);
    if (!record) return { success: false, error: 'Không tìm thấy đơn giao' };

    const collected = parseInt(collectedKegs) || 0;
    if (collected < 0) return { success: false, error: 'Số vỏ thu không hợp lệ' };

    try {
      const tx = db.transaction(() => {
        const prev = record.collected_kegs || 0;
        const delta = collected - prev;

        db.prepare(
          `UPDATE delivery_records SET collected_kegs = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(collected, deliveryId);

        // Cập nhật số vỏ trả lại trên đơn bán + keg_stats (giống logic routes/api/sales.js)
        if (record.sale_id && record.customer_id && delta !== 0) {
          const sale = db
            .prepare('SELECT deliver_kegs, return_kegs FROM sales WHERE id = ?')
            .get(record.sale_id);
          if (sale) {
            const newReturned = (sale.return_kegs || 0) + delta;
            db.prepare('UPDATE sales SET return_kegs = ? WHERE id = ?').run(newReturned, record.sale_id);
          }

          const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(record.customer_id);
          if (customer) {
            const newBalance = Math.max(0, (customer.keg_balance || 0) - delta);
            db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(newBalance, record.customer_id);
          }

          const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
          const newEmpty = Math.max(0, (stats?.empty_collected || 0) + delta);
          db.prepare(
            "UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1"
          ).run(newEmpty);

          const totalHolding = db
            .prepare('SELECT COALESCE(SUM(keg_balance), 0) as total FROM customers')
            .get();
          db.prepare(
            "UPDATE keg_stats SET customer_holding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1"
          ).run(totalHolding.total);

          db.prepare(
            `INSERT INTO keg_transactions_log
               (type, quantity, customer_id, customer_name, inventory_after, empty_after, holding_after, note)
             VALUES ('collect', ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            delta,
            record.customer_id,
            record.customer_name || '',
            stats?.empty_collected || 0,
            newEmpty,
            totalHolding.total,
            `Thu vỏ qua đơn giao #${deliveryId}`
          );
        }

        DeliveryService.logEvent(deliveryId, 'KEGS_UPDATED', record.status, record.status, driverUsername, {
          collectedKegs: collected,
          delta,
        });
      });

      tx();
      const updated = db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(deliveryId);
      return { success: true, delivery: updated };
    } catch (e) {
      logger.error('[DeliveryService] updateCollectedKegs error', { error: e.message });
      return { success: false, error: e.message };
    }
  }

  /**
   * Dashboard tài xế — chỉ số vận hành, KHÔNG có doanh thu/lợi nhuận.
   */
  static getDashboard(driverUsername, opts = {}) {
    const date = opts.date || db.getVietnamDateStr();

    const counts = db
      .prepare(
        `
        SELECT
          COUNT(*) AS total_orders,
          SUM(CASE WHEN dr.status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
          SUM(CASE WHEN dr.status IN ('PENDING', 'IN_PROGRESS') THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN dr.status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN dr.status = 'DISCREPANCY' THEN 1 ELSE 0 END) AS discrepancy,
          COALESCE(SUM(dr.delivered_liters), 0) AS delivered_liters,
          COALESCE(SUM(dr.missing_liters), 0) AS missing_liters,
          COALESCE(SUM(dr.collected_kegs), 0) AS collected_kegs
        FROM delivery_records dr
        WHERE dr.driver_username = ? AND DATE(dr.scheduled_date) = ?
      `
      )
      .get(driverUsername, date);

    // Đơn bán trực tiếp (không qua giao hàng) của tài xế hôm nay
    const walkin = db
      .prepare(
        `
        SELECT COUNT(*) AS cnt, COALESCE(SUM(s.total), 0) AS total_amount
        FROM sales s
        WHERE s.driver_username = ?
          AND DATE(s.date) = ?
          AND s.type = 'sale'
          AND s.archived = 0
          AND (s.customer_id IS NULL OR s.customer_id = 0)
      `
      )
      .get(driverUsername, date);

    // Tổng lít cần giao (từ sale_items của các đơn chưa giao)
    const expected = db
      .prepare(
        `
        SELECT COALESCE(SUM(si.quantity), 0) AS liters
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN products p ON p.id = si.product_id
        LEFT JOIN delivery_records dr
               ON dr.sale_id = s.id AND dr.driver_username = ?
        WHERE DATE(s.date) = ?
          AND s.type = 'sale'
          AND s.archived = 0
          AND (dr.id IS NULL OR dr.status != 'DELIVERED')
          AND (p.type IS NULL OR p.type != 'pet')
      `
      )
      .get(driverUsername, date);

    // Danh sách khách cần ghé
    const stops = db
      .prepare(
        `
        SELECT c.id, c.name, c.phone, c.address,
               COUNT(DISTINCT s.id) AS order_count
        FROM sales s
        JOIN customers c ON c.id = s.customer_id
        LEFT JOIN delivery_records dr
               ON dr.sale_id = s.id AND dr.driver_username = ?
        WHERE DATE(s.date) = ?
          AND s.type = 'sale' AND s.archived = 0
          AND c.archived = 0
          AND (dr.id IS NULL OR dr.status != 'DELIVERED')
        GROUP BY c.id
        ORDER BY order_count DESC, c.name
      `
      )
      .all(driverUsername, date);

    return {
      date,
      orders: {
        total: counts.total_orders || 0,
        delivered: counts.delivered || 0,
        pending: counts.pending || 0,
        failed: counts.failed || 0,
        discrepancy: counts.discrepancy || 0,
      },
      liters: {
        toDeliver: expected.liters || 0,
        delivered: counts.delivered_liters || 0,
        missing: counts.missing_liters || 0,
      },
      kegs: {
        collected: counts.collected_kegs || 0,
      },
      // KHÔNG có doanh thu / lợi nhuận ở đây — chỉ số vận hành
      walkinOrders: walkin.cnt || 0,
      stops: stops.length,
      stopList: stops,
    };
  }

  /**
   * Ghi log sự kiện giao hàng (audit trail).
   */
  static logEvent(deliveryId, eventType, fromStatus, toStatus, actorUsername, payload = null) {
    try {
      db.prepare(
        `INSERT INTO delivery_events
           (delivery_id, event_type, from_status, to_status, actor_username, payload, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        deliveryId,
        eventType,
        fromStatus || null,
        toStatus || null,
        actorUsername || null,
        payload ? JSON.stringify(payload) : null,
        payload && payload.note ? payload.note : null
      );
    } catch (e) {
      logger.error('[DeliveryService] logEvent error', { error: e.message });
    }
  }
}

module.exports = DeliveryService;
module.exports.DELIVERY_STATUS = DELIVERY_STATUS;
module.exports.STATUS_LABELS = STATUS_LABELS;
module.exports.ALLOWED_TRANSITIONS = ALLOWED_TRANSITIONS;
