/**
 * Webhook Sepay — nhận giao dịch ngân hàng và gạch nợ công nợ tự động
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount tại: POST /webhook/sepay
 *
 * ⚠️ PUBLIC — KHÔNG yêu cầu đăng nhập (Sepay gọi từ server bên ngoài).
 *   Bù lại: BẮT BUỘC xác thực chữ ký HMAC-SHA256 hoặc API key.
 *
 * Vì cần raw body để verify HMAC → route dùng `express.raw` với type mọi kiểu
 * và tự parse JSON/Form bên trong.
 *
 * Phản hồi (theo yêu cầu của Sepay):
 *   HTTP 200 + body ĐÚNG CHÍNH XÁC `{"success": true}` → Sepay coi thành công.
 */

const express = require('express');
const router = express.Router();

const logger = require('../src/utils/logger');
const DebtSepayService = require('../src/services/debt/DebtSepayService');

/** Parse body thủ công (JSON hoặc form-urlencoded). */
function parseBody(raw) {
  if (!raw || !raw.length) return {};
  const text = raw.toString('utf8');
  try {
    return JSON.parse(text);
  } catch (_) {
    try {
      const params = new URLSearchParams(text);
      const out = {};
      for (const [k, v] of params.entries()) out[k] = v;
      return out;
    } catch (_) {
      return {};
    }
  }
}

/**
 * Xác thực request:
 *  1. HMAC-SHA256 (header `X-Sepay-Signature`) với `webhook_secret`
 *  2. API key (header `Authorization: Bearer <api_token>` hoặc `X-Api-Key`)
 *  3. Nếu chưa cấu hình gì → TỪ CHỐI (tránh ghi bút toán từ request giả mạo)
 */
function authenticate(req, rawBody) {
  const settings = DebtSepayService.getSettings();

  if (!settings.webhookSecret && !settings.apiToken) {
    return {
      valid: false,
      status: 503,
      error: 'Chưa cấu hình Sepay (webhook secret / API token) — không nhận giao dịch',
    };
  }

  // 1) HMAC
  if (settings.webhookSecret) {
    const signature =
      req.get('X-Sepay-Signature') ||
      req.get('x-sepay-signature') ||
      req.get('X-Signature') ||
      null;
    if (signature) {
      const check = DebtSepayService.verifyWebhookSignature(
        rawBody,
        signature,
        settings.webhookSecret
      );
      if (check.valid) return { valid: true, method: 'hmac' };
      return { valid: false, status: 401, error: 'Chữ ký webhook không hợp lệ' };
    }
  }

  // 2) API key
  if (settings.apiToken) {
    const auth = req.get('Authorization') || '';
    const bearer = auth.replace(/^Bearer\s+/i, '').trim();
    if (bearer && bearer === settings.apiToken) {
      return { valid: true, method: 'api_key' };
    }
    const apiKeyHeader =
      req.get('X-Api-Key') || req.get('X-Sepay-Api-Key') || req.get('Apikey');
    if (apiKeyHeader && apiKeyHeader === settings.apiToken) {
      return { valid: true, method: 'api_key' };
    }
  }

  return {
    valid: false,
    status: 401,
    error: 'Thiếu hoặc sai thông tin xác thực webhook Sepay',
  };
}

router.post(
  '/',
  express.raw({ type: '*/*', limit: '2mb' }),
  (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const payload = parseBody(rawBody);

    const auth = authenticate(req, rawBody);
    if (!auth.valid) {
      logger.warn('[SEPAY_WEBHOOK] Rejected', {
        reason: auth.error,
        ip: req.ip,
        sepayId: payload && payload.id,
      });
      return res.status(auth.status || 401).json({ success: false, error: auth.error });
    }

    try {
      const result = DebtSepayService.handleWebhook(payload);

      if (!result.success) {
        logger.error('[SEPAY_WEBHOOK] handle failed', {
          error: result.error,
          sepayId: payload.id,
        });
        // Vẫn trả 200 nếu đã lưu được giao dịch (chỉ gạch nợ thất bại)
        if (result.transactionId) {
          return res.status(200).json({ success: true });
        }
        return res.status(400).json({ success: false, error: result.error });
      }

      logger.info('[SEPAY_WEBHOOK] Received', {
        sepayId: payload.id,
        amount: payload.transferAmount || payload.transfer_amount,
        duplicate: !!result.duplicate,
        settled: result.settlement && result.settlement.success,
      });

      // Báo realtime cho admin
      try {
        const io = req.app.get('io');
        const settlement = result.settlement;
        if (io && settlement && settlement.customerId) {
          io.to('admin').emit('debt:updated', {
            customerId: settlement.customerId,
            newDebt: settlement.balanceAfter,
            action: 'sepay_payment',
          });
          io.to('admin').emit('sepay:received', {
            sepayId: payload.id,
            amount: settlement.amount,
            applied: settlement.applied,
            credit: settlement.credit,
            customerId: settlement.customerId,
            customerName: settlement.customerName,
          });
        }
      } catch (_) {
        /* realtime không quan trọng */
      }

      // Sepay yêu cầu đúng body `{"success": true}`
      return res.status(200).json({ success: true });
    } catch (e) {
      logger.error('[SEPAY_WEBHOOK] Error', { error: e.message });
      return res.status(500).json({ success: false, error: e.message });
    }
  }
);

module.exports = router;
