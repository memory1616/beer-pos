/**
 * PushService — Web Push notification cho tài xế
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu: khi Admin tạo đơn hàng và gán cho tài xế, đẩy thông báo tới
 * điện thoại tài xế (màn hình khoá / app đóng) bằng Web Push API.
 *
 * Thiết kế:
 *  - Dùng thư viện `web-push` (VAPID) — không cần server push riêng.
 *  - VAPID keypair lưu trong bảng `settings` → sinh tự động lần đầu, không
 *    mất khi restart (nếu mất key thì mọi subscription cũ đều vô hiệu).
 *  - Subscription lưu bảng `push_subscriptions` (mỗi thiết bị 1 dòng).
 *  - Subscription chết (410/404) → tự đánh dấu `push_enabled = 0`.
 *  - FAIL-OPEN: lỗi push KHÔNG được làm hỏng luồng tạo đơn.
 *
 * ⚠️ QUAN TRỌNG: payload push KHÔNG được chứa dữ liệu tài chính
 * (tổng tiền / lợi nhuận / giá vốn) — tài xế không được thấy.
 */

const webpush = require('web-push');
const db = require('../../database');
const logger = require('../utils/logger');

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSetting(key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value !== null ? String(row.value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function setSetting(key, value) {
  try {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      key,
      String(value ?? '')
    );
  } catch (err) {
    logger.error('[PUSH] Failed to write setting', { key, error: err.message });
  }
}

// ── VAPID ────────────────────────────────────────────────────────────────────

let _configured = false;

/**
 * Bảo đảm có VAPID keypair hợp lệ + đã cấu hình cho thư viện web-push.
 * Keypair được sinh tự động lần đầu và lưu vào `settings`.
 *
 * @returns {{ok:boolean, publicKey:string, error?:string}}
 */
function ensureVapid() {
  if (_configured) {
    return { ok: true, publicKey: getSetting('push_vapid_public_key') };
  }

  let publicKey = getSetting('push_vapid_public_key');
  let privateKey = getSetting('push_vapid_private_key');

  // Chưa có key → sinh cặp mới và lưu lại
  if (!publicKey || !privateKey) {
    try {
      const keys = webpush.generateVAPIDKeys();
      publicKey = keys.publicKey;
      privateKey = keys.privateKey;
      setSetting('push_vapid_public_key', publicKey);
      setSetting('push_vapid_private_key', privateKey);
      logger.info('[PUSH] Generated new VAPID keypair');
    } catch (err) {
      logger.error('[PUSH] Failed to generate VAPID keys', { error: err.message });
      return { ok: false, publicKey: '', error: err.message };
    }
  }

  const subject = getSetting('push_vapid_subject', 'mailto:admin@biatuoitayninh.store');
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    _configured = true;
    return { ok: true, publicKey };
  } catch (err) {
    logger.error('[PUSH] setVapidDetails failed', { error: err.message });
    return { ok: false, publicKey: '', error: err.message };
  }
}

/** Public key để client dùng khi subscribe (endpoint công khai, an toàn). */
function getPublicKey() {
  const res = ensureVapid();
  return res.ok ? res.publicKey : '';
}

/** Tính năng có bật không (admin bật qua settings `push_enabled`). */
function isEnabled() {
  return getSetting('push_enabled', '0') === '1';
}

// ── Subscription ─────────────────────────────────────────────────────────────

/**
 * Lưu (hoặc cập nhật) subscription của 1 thiết bị tài xế.
 *
 * @param {string} username - username tài xế
 * @param {object} subscription - { endpoint, keys: { p256dh, auth } }
 * @param {string} [userAgent]
 * @returns {{ok:boolean, error?:string}}
 */
function saveSubscription(username, subscription, userAgent = null) {
  if (!username) return { ok: false, error: 'Thiếu username' };
  if (!subscription || !subscription.endpoint) {
    return { ok: false, error: 'Subscription không hợp lệ (thiếu endpoint)' };
  }
  const keys = subscription.keys || {};
  if (!keys.p256dh || !keys.auth) {
    return { ok: false, error: 'Subscription không hợp lệ (thiếu keys)' };
  }

  try {
    db.prepare(
      `INSERT INTO push_subscriptions
         (username, endpoint, p256dh, auth, user_agent, push_enabled, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
       ON CONFLICT(endpoint) DO UPDATE SET
         username = excluded.username,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         push_enabled = 1,
         failure_count = 0,
         last_error = NULL,
         last_used_at = datetime('now')`
    ).run(username, subscription.endpoint, keys.p256dh, keys.auth, userAgent);
    logger.info('[PUSH] Saved subscription', { username });
    return { ok: true };
  } catch (err) {
    logger.error('[PUSH] Failed to save subscription', {
      username,
      error: err.message,
    });
    return { ok: false, error: err.message };
  }
}

/**
 * Xoá subscription theo endpoint.
 * @param {string} username
 * @param {string} endpoint
 */
function removeSubscription(username, endpoint) {
  try {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND username = ?').run(
      endpoint,
      username
    );
    return { ok: true };
  } catch (err) {
    logger.error('[PUSH] Failed to remove subscription', { error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Đánh dấu subscription chết (410 Gone / 404 Not Found).
 * @param {string} endpoint
 * @param {string} reason
 */
function markDead(endpoint, reason) {
  try {
    db.prepare(
      `UPDATE push_subscriptions
       SET push_enabled = 0, last_error = ?, failure_count = failure_count + 1
       WHERE endpoint = ?`
    ).run(String(reason || 'unknown').slice(0, 200), endpoint);
  } catch (err) {
    logger.error('[PUSH] Failed to mark subscription dead', { error: err.message });
  }
}

/**
 * Danh sách subscription đang hoạt động của 1 tài xế.
 * @param {string} username
 */
function listSubscriptions(username) {
  try {
    return db
      .prepare(
        `SELECT id, endpoint, user_agent, push_enabled, created_at, last_used_at
         FROM push_subscriptions
         WHERE username = ? AND push_enabled = 1
         ORDER BY last_used_at DESC`
      )
      .all(username);
  } catch (err) {
    logger.error('[PUSH] Failed to list subscriptions', { error: err.message });
    return [];
  }
}

/**
 * Thống kê trạng thái push theo tài xế (cho admin).
 * @returns {Array<{username:string, devices:number, last_used_at:string|null}>}
 */
function statsByDriver() {
  try {
    return db
      .prepare(
        `SELECT username,
                COUNT(*) AS devices,
                MAX(last_used_at) AS last_used_at
         FROM push_subscriptions
         WHERE push_enabled = 1
         GROUP BY username
         ORDER BY username`
      )
      .all();
  } catch (err) {
    logger.error('[PUSH] Failed to stats', { error: err.message });
    return [];
  }
}

// ── Gửi ──────────────────────────────────────────────────────────────────────

/**
 * Gửi 1 payload tới 1 subscription.
 * @param {object} row - row từ push_subscriptions
 * @param {object} payload
 * @returns {Promise<{ok:boolean, dead?:boolean, error?:string}>}
 */
function sendToSubscription(row, payload) {
  const subscription = {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth,
    },
  };

  return new Promise((resolve) => {
    webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 3600 })
      .then(() => {
        try {
          db.prepare(
            `UPDATE push_subscriptions SET last_used_at = datetime('now'), failure_count = 0
             WHERE id = ?`
          ).run(row.id);
        } catch (err) {
          logger.warn('[PUSH] Failed to update last_used_at', { error: err.message });
        }
        resolve({ ok: true });
      })
      .catch((err) => {
        const status = err && err.statusCode;
        // 404 / 410 → subscription đã chết → xoá hẳn
        if (status === 404 || status === 410) {
          markDead(row.endpoint, `HTTP ${status}`);
          resolve({ ok: false, dead: true, error: `HTTP ${status}` });
          return;
        }
        // 429 (quá tải) → tạm thời, KHÔNG đánh dấu chết
        try {
          db.prepare(
            `UPDATE push_subscriptions SET failure_count = failure_count + 1, last_error = ?
             WHERE id = ?`
          ).run(String(err.message || '').slice(0, 200), row.id);
        } catch (updateErr) {
          logger.warn('[PUSH] Failed to record failure', { error: updateErr.message });
        }
        resolve({ ok: false, error: err.message || 'Unknown push error' });
      });
  });
}

/**
 * Gửi thông báo tới TẤT CẢ thiết bị của 1 tài xế.
 *
 * @param {string} username - username tài xế nhận
 * @param {object} payload - { title, body, data, tag, requireInteraction }
 * @returns {Promise<{ok:boolean, sent:number, failed:number, error?:string}>}
 */
async function notifyDriver(username, payload) {
  if (!username) return { ok: false, sent: 0, failed: 0, error: 'Thiếu username' };

  const vapid = ensureVapid();
  if (!vapid.ok) {
    return { ok: false, sent: 0, failed: 0, error: vapid.error || 'VAPID chưa sẵn sàng' };
  }

  const rows = listSubscriptions(username);
  if (rows.length === 0) {
    return { ok: true, sent: 0, failed: 0, error: 'Tài xế chưa bật thông báo' };
  }

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const res = await sendToSubscription(row, payload);
    if (res.ok) {
      sent += 1;
    } else {
      failed += 1;
      if (res.error) errors.push(res.error);
    }
  }

  logger.info('[PUSH] notifyDriver', {
    username,
    sent,
    failed,
    devices: rows.length,
  });

  return {
    ok: failed === 0,
    sent,
    failed,
    error: errors.length ? errors.join('; ') : undefined,
  };
}

/**
 * Gửi thông báo "đơn giao mới" cho tài xế.
 *
 * ⚠️ Payload KHÔNG chứa tổng tiền / lợi nhuận (tài xế không được thấy).
 *
 * @param {object} params
 * @param {string} params.driverUsername
 * @param {number} params.saleId
 * @param {string} [params.customerName]
 * @param {string} [params.customerAddress]
 * @param {string} [params.customerPhone]
 * @param {number} [params.kegs] - số vỏ cần giao
 * @param {number} [params.liters] - số lít
 * @returns {Promise<object>}
 */
async function notifyNewOrder(params) {
  const {
    driverUsername,
    saleId,
    customerName,
    customerAddress,
    customerPhone,
    kegs = 0,
    liters = 0,
  } = params || {};

  const title = getSetting('push_title_template', '🔔 Đơn giao mới');

  const details = [];
  if (customerName) details.push(customerName);
  if (kegs > 0) details.push(`${kegs} vỏ`);
  if (liters > 0) details.push(`${liters} lít`);

  const body = details.length ? details.join(' · ') : 'Có đơn mới cần giao';

  const payload = {
    title,
    body,
    tag: `order-${saleId}`,
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
    data: {
      type: 'order:assigned',
      saleId,
      customerName: customerName || null,
      customerAddress: customerAddress || null,
      customerPhone: customerPhone || null,
      kegs,
      liters,
      url: '/driver/giao-hang',
    },
  };

  const result = await notifyDriver(driverUsername, payload);
  logNotification({
    saleId,
    driverUsername,
    title,
    body,
    payload: payload.data,
    status: result.sent > 0 ? 'sent' : 'failed',
    sentCount: result.sent,
    failedCount: result.failed,
    errorMessage: result.error,
  });

  return { ...result, payload };
}

/**
 * Ghi lịch sử gửi push.
 */
function logNotification({
  saleId,
  driverUsername,
  title,
  body,
  payload,
  status,
  sentCount = 0,
  failedCount = 0,
  errorMessage = null,
}) {
  try {
    db.prepare(
      `INSERT INTO push_notifications
         (sale_id, driver_username, title, body, data, status,
          sent_count, failed_count, error_message, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'sent' THEN datetime('now') ELSE NULL END)`
    ).run(
      saleId || null,
      driverUsername || null,
      title || null,
      body || null,
      payload ? JSON.stringify(payload) : null,
      status,
      sentCount,
      failedCount,
      errorMessage ? String(errorMessage).slice(0, 500) : null,
      status
    );
  } catch (err) {
    logger.error('[PUSH] Failed to write notification log', { error: err.message });
  }
}

/**
 * Lịch sử gửi push (admin xem).
 * @param {number} [limit]
 */
function getHistory(limit = 50) {
  try {
    return db
      .prepare(
        `SELECT id, sale_id, driver_username, title, body, status,
                sent_count, failed_count, error_message, created_at, sent_at
         FROM push_notifications
         ORDER BY id DESC LIMIT ?`
      )
      .all(Math.min(200, Math.max(1, parseInt(limit) || 50)));
  } catch (err) {
    logger.error('[PUSH] Failed to load history', { error: err.message });
    return [];
  }
}

module.exports = {
  ensureVapid,
  getPublicKey,
  isEnabled,
  saveSubscription,
  removeSubscription,
  listSubscriptions,
  statsByDriver,
  notifyDriver,
  notifyNewOrder,
  logNotification,
  getHistory,
};
