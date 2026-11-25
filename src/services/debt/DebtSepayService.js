/**
 * DebtSepayService — Gạch nợ công nợ tự động từ giao dịch Sepay
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu:
 *  1. Nhận giao dịch từ Sepay (webhook real-time + polling đối soát API).
 *  2. LƯU MỌI giao dịch vào `sepay_transactions` (kể cả chưa gạch nợ) →
 *     không bỏ sót, làm căn cứ đối soát.
 *  3. Tự khớp khách hàng theo `debt_code` nhúng trong nội dung chuyển khoản.
 *  4. Gạch nợ:
 *     - Trả đúng   → ghi PAYMENT (giảm công nợ), phân bổ FIFO vào các đơn.
 *     - Trả thiếu  → ghi PAYMENT số tiền thực nhận (FIFO), phần còn nợ giữ nguyên.
 *     - Trả DƯ     → ghi PAYMENT đúng số nợ + ghi CREDIT (tiền khách nợ lại,
 *                     số dư âm). Khách dùng tiền dư để trừ nợ sau.
 *     - Không khớp được khách → giữ `manual`, nhân viên xử lý tay trên UI.
 *
 * Nguyên tắc bất di bất dịch (giống phần còn lại của module Sổ công nợ):
 *  - Ledger là APPEND-ONLY → mọi thao tác đều tạo bút toán MỚI, không sửa bút toán cũ.
 *  - Idempotent: `sepay_transactions.sepay_id` UNIQUE → webhook retry không gạch 2 lần.
 *  - Mọi thao tác ghi bút toán đều qua `DebtLedgerService.recordTransaction()`
 *    (có transaction + audit log + đồng bộ mirror `customers.debt`).
 *  - KHÔNG tự động ghi bút toán khi chưa xác định được khách hàng.
 */

const crypto = require('crypto');
const db = require('../../../database');
const logger = require('../../utils/logger');
const DebtLedgerService = require('./DebtLedgerService');
const DebtAuditService = require('./DebtAuditService');
const DebtNotifyService = require('./DebtNotifyService');
const { TRANSACTION_TYPES, SOURCES, REFERENCE_TYPES } = require('./constants');

// ── Trạng thái giao dịch Sepay ───────────────────────────────────────────────
const TX_STATUS = {
  PENDING: 'pending', // Mới nhận, chưa xử lý
  MATCHED: 'matched', // Đã khớp khách + đã gạch nợ
  MANUAL: 'manual', // Chưa khớp được khách → cần xử lý tay
  IGNORED: 'ignored', // Đã bỏ qua (tiền ra, giao dịch hệ thống)
};

const SEPAY_API_BASE = 'https://userapi.sepay.vn/v2';

// ── Helpers ──────────────────────────────────────────────────────────────────

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function getSettings() {
  try {
    const row = db.prepare('SELECT * FROM sepay_settings WHERE id = 1').get();
    if (!row) {
      db.prepare('INSERT OR IGNORE INTO sepay_settings (id, auto_settle) VALUES (1, 1)').run();
      return {
        apiToken: null,
        webhookSecret: null,
        bankAccounts: [],
        paymentCodePrefix: 'DH',
        autoSettle: true,
        autoPollEnabled: true,
        autoPollIntervalMin: 5,
        autoPollLookbackDays: 3,
      };
    }
    let accounts = [];
    try {
      accounts = row.bank_accounts ? JSON.parse(row.bank_accounts) : [];
    } catch (_) {
      accounts = [];
    }
    return {
      apiToken: row.api_token || null,
      webhookSecret: row.webhook_secret || null,
      bankAccounts: Array.isArray(accounts) ? accounts : [],
      paymentCodePrefix: row.payment_code_prefix || 'DH',
      autoSettle: row.auto_settle !== 0,
      // Tự động đối soát định kỳ qua API Sepay (dự phòng cho webhook).
      // Bật mặc định để hệ thống TỰ gạch nợ dù webhook lỗi/chưa cấu hình.
      autoPollEnabled: row.auto_poll_enabled !== 0,
      autoPollIntervalMin: Number(row.auto_poll_interval_min || 5),
      autoPollLookbackDays: Number(row.auto_poll_lookback_days || 3),
    };
  } catch (e) {
    logger.error('[SEPAY] getSettings error', { error: e.message });
    return {
      apiToken: null,
      webhookSecret: null,
      bankAccounts: [],
      paymentCodePrefix: 'DH',
      autoSettle: false,
      autoPollEnabled: false,
      autoPollIntervalMin: 5,
      autoPollLookbackDays: 3,
    };
  }
}

function saveSettings(patch = {}) {
  try {
    db.prepare('INSERT OR IGNORE INTO sepay_settings (id, auto_settle) VALUES (1, 1)').run();
    const current = db.prepare('SELECT * FROM sepay_settings WHERE id = 1').get() || {};
    const next = {
      api_token:
        patch.apiToken !== undefined ? patch.apiToken : current.api_token || null,
      webhook_secret:
        patch.webhookSecret !== undefined
          ? patch.webhookSecret
          : current.webhook_secret || null,
      bank_accounts:
        patch.bankAccounts !== undefined
          ? JSON.stringify(patch.bankAccounts || [])
          : current.bank_accounts || null,
      payment_code_prefix:
        patch.paymentCodePrefix !== undefined
          ? patch.paymentCodePrefix
          : current.payment_code_prefix || 'DH',
      auto_settle:
        patch.autoSettle !== undefined
          ? (patch.autoSettle ? 1 : 0)
          : current.auto_settle ?? 1,
      auto_poll_enabled:
        patch.autoPollEnabled !== undefined
          ? (patch.autoPollEnabled ? 1 : 0)
          : current.auto_poll_enabled ?? 1,
      auto_poll_interval_min:
        patch.autoPollIntervalMin !== undefined
          ? Math.max(1, Math.min(1440, parseInt(patch.autoPollIntervalMin, 10) || 5))
          : current.auto_poll_interval_min ?? 5,
      auto_poll_lookback_days:
        patch.autoPollLookbackDays !== undefined
          ? Math.max(1, Math.min(30, parseInt(patch.autoPollLookbackDays, 10) || 3))
          : current.auto_poll_lookback_days ?? 3,
    };
    db.prepare(
      `UPDATE sepay_settings
          SET api_token = ?, webhook_secret = ?, bank_accounts = ?,
              payment_code_prefix = ?, auto_settle = ?,
              auto_poll_enabled = ?, auto_poll_interval_min = ?,
              auto_poll_lookback_days = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`
    ).run(
      next.api_token,
      next.webhook_secret,
      next.bank_accounts,
      next.payment_code_prefix,
      next.auto_settle,
      next.auto_poll_enabled,
      next.auto_poll_interval_min,
      next.auto_poll_lookback_days
    );
    return { success: true };
  } catch (e) {
    logger.error('[SEPAY] saveSettings error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Bỏ khoảng trắng + bỏ dấu tiếng Việt + uppercase để so khớp mã ổn định.
 * VD: "kh 0001" → "KH0001"
 */
function normalizeCode(raw) {
  if (!raw) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Chuẩn hóa GIỮ dấu phân tách (dấu gạch ngang, chấm, gạch dưới) — dùng để
 * trích mã khách mà KHÔNG bị dính số từ phần ngày/giờ phía sau.
 *
 * ⚠️ Vì sao cần?
 *  Nội dung chuyển khoản thực tế của ngân hàng có dạng:
 *    "ND 1121 KH0006-211126-18:37:58 6325ASCB02XFGAPD"
 *  Nếu bỏ hết ký tự phân tách → "…KH00062111263758…" → regex `KH\d{3,8}` greedy
 *  sẽ nuốt 8 chữ số → "KH00062111" (SAI, khách thật là KH0006).
 *  Giữ dấu phân tách → "KH0006" tách riêng → match chính xác.
 */
function normalizeWithSeparators(raw) {
  if (!raw) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    // Giữ A-Z, 0-9 và các dấu phân tách: - . _ / : space
    .replace(/[^A-Z0-9\-._/:\s]/g, ' ');
}

/**
 * Trích mã khách KHxxxx từ chuỗi đã chuẩn hóa (giữ dấu phân tách).
 *
 * Chiến lược khớp (theo thứ tự ưu tiên):
 *  1. `KH` + đúng 4 chữ số, đứng riêng (sau khi bỏ dấu phân tách vẫn là
 *     ranh giới token) → mã chuẩn do hệ thống sinh (KH0001…KH9999).
 *  2. `KH` + 3..8 chữ số → fallback cho mã dài hơn (KH12345).
 *
 * ⚠️ Không dùng regex greedy `KH\d{3,8}` trên chuỗi đã bỏ dấu phân tách —
 *    sẽ nuốt số từ phần ngày giờ phía sau.
 */
function matchDebtCodeIn(normalized) {
  if (!normalized) return '';

  // 1) Ưu tiên mã 4 chữ số có ranh giới rõ ràng (không bị số khác dính vào).
  //    Đồng thời chấp nhận cả trường hợp KH0006-211126 (dấu gạch ngang phía sau).
  const m4 = normalized.match(/(?:^|[^A-Z0-9])KH(\d{4})(?![0-9])/);
  if (m4) return 'KH' + m4[1];

  // 2) Fallback: mã KH + 3..8 chữ số (mã dài hơn 4 chữ số).
  const mLong = normalized.match(/(?:^|[^A-Z0-9])KH(\d{3,8})(?![0-9])/);
  if (mLong) return 'KH' + mLong[1];

  return '';
}

/**
 * Trích mã khách (`debt_code`) ra từ nội dung / mã / mô tả giao dịch.
 *
 * Mã khách dạng `KH` + 4 chữ số (VD: KH0007).
 * Ngoài ra hỗ trợ tiền tố mã thanh toán do Sepay cấu hình (`code` field),
 * ví dụ prefix "DH" → "DH0007".
 */
function extractDebtCode(payload) {
  const candidates = [
    payload.debt_code,
    payload.code,
    payload.content,
    payload.description,
    payload.transaction_content,
  ];

  // 1) Mã `debt_code` dạng KHxxxx (ưu tiên cao nhất)
  //    Dùng chuẩn hóa GIỮ dấu phân tách để không bị nuốt số từ phần ngày giờ.
  for (const c of candidates) {
    if (!c) continue;
    const code = matchDebtCodeIn(normalizeWithSeparators(c));
    if (code) return code;
  }

  // 2) Mã dạng prefix + số (theo cấu hình Sepay), VD prefix "DH" → DH0007
  const settings = getSettings();
  const prefix = (settings.paymentCodePrefix || 'DH').toUpperCase();
  if (prefix && prefix !== 'KH') {
    for (const c of candidates) {
      if (!c) continue;
      const norm = normalizeWithSeparators(c);
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Ưu tiên prefix + đúng 4 chữ số
      const m4 = norm.match(new RegExp('(?:^|[^A-Z0-9])' + escaped + '(\\d{4})(?![0-9])'));
      if (m4) return escaped + m4[1];
      const m = norm.match(new RegExp('(?:^|[^A-Z0-9])' + escaped + '(\\d{3,8})(?![0-9])'));
      if (m) return escaped + m[1];
    }
  }

  return '';
}

/** Tìm khách hàng theo mã `debt_code` (không phân biệt hoa/thường). */
function findCustomerByDebtCode(code) {
  const norm = normalizeCode(code);
  if (!norm) return null;
  try {
    return (
      db
        .prepare(
          'SELECT id, name, phone, debt, debt_code FROM customers WHERE debt_code = ?'
        )
        .get(norm) ||
      db
        .prepare(
          'SELECT id, name, phone, debt, debt_code FROM customers WHERE UPPER(debt_code) = ?'
        )
        .get(norm) ||
      null
    );
  } catch (e) {
    logger.error('[SEPAY] findCustomerByDebtCode error', { error: e.message });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GẠCH NỢ THÔNG MINH — nhận diện khách KHÔNG CẦN mã QR
// ─────────────────────────────────────────────────────────────────────────────
// Khách thường chuyển theo SỐ TÀI KHOẢN (nhận số TK từ QR ngân hàng rồi
// nhập tay) → nội dung CK KHÔNG chứa mã KH. Nội dung thực tế:
//
//   "NHAN TU 1988888779779 TRACE 104688 ND BUI TRUONG VAN chuyen tien"
//   "NHAN TU 0671004149757 TRACE 836311 ND MBVCB.17123650534 ... KH0001..."
//
// Ta trích 2 thông tin từ nội dung:
//   • SỐ TÀI KHOẢN người gửi  (sau "NHAN TU" / "TU" / "FROM")
//   • TÊN người gửi          (sau "ND" / "TU" + tên)
//
// rồi khớp khách theo thứ tự độ tin cậy giảm dần.
// ═══════════════════════════════════════════════════════════════════════════

/** Chuẩn hóa số tài khoản: chỉ giữ chữ số, bỏ khoảng trắng/gạch. */
function normalizeAccount(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '');
}

/**
 * Trích số tài khoản người gửi từ nội dung chuyển khoản.
 *
 * Nhận diện các mẫu thực tế của ngân hàng VN:
 *   • "NHAN TU 1988888779779 ..."        (SePay / VietQR)
 *   • "TU 1988888779779 ..."             (viết tắt)
 *   • "FROM 1988888779779 ..."
 *   • "MBVCB.17123650534..."             (mã ngân hàng đứng trước)
 *
 * ⚠️ Số tài khoản ngân hàng VN thường 10..14 chữ số. Ta loại các số quá
 *    ngắn (≤4) vì dễ trùng với số tiền / mã giao dịch.
 *
 * @returns {string} số tài khoản đã chuẩn hóa (rỗng nếu không tìm thấy)
 */
function extractSenderAccount(payload) {
  const raw = [
    payload.content,
    payload.description,
    payload.transaction_content,
    payload.transfer_content,
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();

  if (!raw) return '';

  // 1) Rõ ràng nhất: "NHAN TU <số>" / "TU <số>" / "FROM <số>"
  const labeled = raw.match(/(?:NHAN\s+TU|TU|FROM|CHUYEN\s+TU)\s+([0-9][0-9\s.-]{7,20}[0-9])/);
  if (labeled) {
    const acc = normalizeAccount(labeled[1]);
    if (acc.length >= 8 && acc.length <= 20) return acc;
  }

  // 2) Ngân hàng ghi mã ngân hàng + số TK liền nhau: "MBVCB.17123650534..."
  const bankCode = raw.match(/\b[A-Z]{4,6}\.([0-9]{9,16})\b/);
  if (bankCode) return normalizeAccount(bankCode[1]);

  // 3) Dự phòng: số dài 10..14 chữ số đứng riêng trong nội dung.
  //    Chỉ lấy số đầu tiên tìm thấy (thường là số TK).
  const loose = raw.match(/(?:^|[^0-9])([0-9]{10,14})(?![0-9])/);
  if (loose) return loose[1];

  return '';
}

/**
 * Chuẩn hóa tên người gửi để so khớp: bỏ dấu, bỏ khoảng trắng thừa,
 * uppercase.
 */
function normalizeName(raw) {
  if (!raw) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Trích tÊN người gửi từ nội dung chuyển khoản.
 *
 * Mẫu thực tế:
 *   • "NHAN TU 1988888779779 TRACE 104688 ND BUI TRUONG VAN chuyen tien"
 *   • "ND NGUYEN VAN A"
 *   • "TU NGUYEN VAN A"
 *
 * ⚠️ Phần sau "ND"/"TU" có thể chứa mã ngân hàng, mã giao dịch, mã KH...
 *    → ta cắt tại các từ khoá đặc trưng và giới hạn độ dài.
 *
 * @returns {string} tên đã chuẩn hóa (rỗng nếu không tìm thấy)
 */
function extractSenderName(payload) {
  const raw = [
    payload.content,
    payload.description,
    payload.transaction_content,
    payload.transfer_content,
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();

  if (!raw) return '';

  // Các từ khoá báo hiệu phần sau KHÔNG phải tên.
  const STOP_WORDS = [
    'CHUYEN',
    'TIEN',
    'THANH',
    'TOAN',
    'TRACE',
    'MBVCB',
    'VIETCOMBANK',
    'TECHCOMBANK',
    'BIDV',
    'AGRIBANK',
    'MBBANK',
    'ACB',
    'VPBANK',
    'SHB',
    'TPBANK',
    'CTI',
    'VIB',
    'MSB',
    'OCB',
    'SCB',
    'KH',
    'DH',
    'GHI',
    'NO',
    'STK',
    'TK',
    'SO',
    'HD',
    'GD',
    'REF',
    'FWD',
  ];

  // Ưu tiên "ND <tên>" — mẫu phổ biến nhất.
  const patterns = [
    /\bND\s+([A-ZÀ-Ỹ]{2,}(?:\s+[A-ZÀ-Ỹ]{2,}){0,5})/,
    /\bTU\s+([A-ZÀ-Ỹ]{2,}(?:\s+[A-ZÀ-Ỹ]{2,}){0,5})/,
    /\bFROM\s+([A-ZÀ-Ỹ]{2,}(?:\s+[A-ZÀ-Ỹ]{2,}){0,5})/,
  ];

  for (const re of patterns) {
    const m = raw.match(re);
    if (!m) continue;

    let name = m[1].trim();

    // Cắt tại từ khoá dừng đầu tiên.
    for (const w of STOP_WORDS) {
      const idx = name.indexOf(' ' + w);
      if (idx > 0) {
        name = name.slice(0, idx);
        break;
      }
      if (name.startsWith(w + ' ')) {
        name = '';
        break;
      }
    }

    name = name.trim();

    // Loại bỏ mã ngân hàng đứng đầu (VD "MBVCB", "VCB", "TECHCOMBANK") —
    // đây không phải tên người gửi.
    const BANK_TOKENS = [
      'MBVCB',
      'VIETCOMBANK',
      'TECHCOMBANK',
      'BIDV',
      'AGRIBANK',
      'MBBANK',
      'ACB',
      'VPBANK',
      'SHB',
      'TPBANK',
      'CTI',
      'VIB',
      'MSB',
      'OCB',
      'SCB',
      'VCB',
      'TCB',
      'EBA',
      'VCCB',
      'VTC',
      'BVB',
      'LPB',
      'PGB',
      'STB',
      'CBB',
      'KLB',
      'MBS',
      'SEA',
      'VAB',
      'VRB',
      'ACB',
      'CITI',
      'HSBC',
      'DAB',
    ];
    for (const t of BANK_TOKENS) {
      if (name === t) return ''; // chỉ có mã ngân hàng → không phải tên
    }

    if (name.length >= 3 && name.length <= 60) return normalizeName(name);
  }

  return '';
}

/**
 * Tìm khách hàng theo SỐ TÀI KHOẢN ngân hàng đã đăng ký.
 *
 * @returns {object|null} khách hàng (hoặc null)
 */
function findCustomerByBankAccount(account) {
  const acc = normalizeAccount(account);
  if (!acc) return null;
  try {
    return (
      db
        .prepare(
          `SELECT id, name, phone, debt, debt_code, bank_account, bank_account_name
             FROM customers
            WHERE REPLACE(REPLACE(REPLACE(COALESCE(bank_account,''),' ',''),'-',''),'.','') = ?
            LIMIT 1`
        )
        .get(acc) || null
    );
  } catch (e) {
    logger.error('[SEPAY] findCustomerByBankAccount error', { error: e.message });
    return null;
  }
}

/**
 * Tìm khách theo TÊN người gửi (so khớp "chứa" — tên người gửi có thể
 * chỉ là một phần của tên khai trong hệ thống).
 *
 * ⚠️ Trả về mảng ứng viên để caller đánh giá mức độ khớp.
 *
 * @returns {Array<{customer:object, score:number}>}
 */
function findCustomersByName(name, limit = 5) {
  const norm = normalizeName(name);
  if (!norm || norm.length < 3) return [];

  // Chỉ lấy khách còn hoạt động, có nợ > 0 hoặc từng giao dịch (để có ngữ cảnh).
  const rows = db
    .prepare(
      `SELECT id, name, phone, debt, debt_code, bank_account, bank_account_name
         FROM customers
        WHERE COALESCE(deleted, 0) = 0 AND COALESCE(archived, 0) = 0
        LIMIT 5000`
    )
    .all();

  const results = [];
  for (const row of rows) {
    const custNorm = normalizeName(row.name);
    if (!custNorm) continue;

    let score = 0;
    // 1) Khớp với TÊN CHỦ TÀI KHOẢN đã đăng ký (mạnh nhất) — đây là tên
    //    thật của người gửi, do nhân viên nhập tay.
    const holderNorm = normalizeName(row.bank_account_name);
    if (holderNorm) {
      if (holderNorm === norm) score = Math.max(score, 0.92);
      else if (holderNorm.includes(norm) || norm.includes(holderNorm)) {
        score = Math.max(score, 0.85);
      }
    }

    if (custNorm === norm) {
      score = Math.max(score, 0.9); // trùng tuyệt đối
    } else if (custNorm.includes(norm) || norm.includes(custNorm)) {
      score = Math.max(score, 0.75); // trùng một phần (VD "BUI TRUONG VAN" ⊂ "BUI TRUONG VAN QN")
    } else {
      // So khớp theo tập TỪ: càng nhiều từ chung càng tin cậy.
      const custWords = custNorm.split(' ').filter((w) => w.length >= 2);
      const sentWords = norm.split(' ').filter((w) => w.length >= 2);
      if (custWords.length && sentWords.length) {
        const common = sentWords.filter((w) => custWords.includes(w)).length;
        const ratio = common / Math.max(custWords.length, sentWords.length);
        if (ratio >= 0.99) score = Math.max(score, 0.8);
        else if (ratio >= 0.6) score = Math.max(score, 0.6);
      }
    }

    if (score > 0) {
      results.push({ customer: row, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Tìm khách theo SỐ TIỀN giao dịch khớp đúng số nợ đang chờ trả.
 * (Suy đoán — chỉ dùng khi được bật & có đúng 1 ứng viên.)
 *
 * @returns {Array<{customer:object, score:number}>}
 */
function findCustomersByAmount(amount) {
  const value = roundMoney(amount);
  if (!(value > 0)) return [];

  try {
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.phone, c.debt, c.debt_code, c.bank_account, c.bank_account_name
           FROM customers c
          WHERE COALESCE(c.deleted, 0) = 0 AND COALESCE(c.archived, 0) = 0 AND c.debt >= ?
          LIMIT 500`
      )
      .all(value);

    return rows.map((customer) => ({ customer, score: 0.5 }));
  } catch (e) {
    logger.error('[SEPAY] findCustomersByAmount error', { error: e.message });
    return [];
  }
}

/**
 * Gạch nợ THÔNG MINH — dự đoán khách hàng từ giao dịch Sepay.
 *
 * Thứ tự chiến lược (độ tin cậy giảm dần):
 *   1. Mã `KHxxxx` trong nội dung                → 1.00
 *   2. Số tài khoản người gửi khớp KH đã đăng ký → 0.95
 *   3. Tên người gửi trùng/khớp gần đúng KH      → 0.90 (tối đa)
 *   4. Số tiền khớp đúng nợ của KH (suy đoán)    → 0.50
 *
 * Nếu có NHIỀU ứng viên cùng điểm → KHÔNG tự quyết, trả về danh sách để
 * nhân viên chọn (giao dịch vẫn vào hàng chờ `manual`).
 *
 * @param {object} tx - row của `sepay_transactions`
 * @returns {{customer:object|null, method:string, confidence:number, candidates:Array}}
 */
function smartMatchCustomer(tx) {
  const settings = {
    enabled: getSetting('sepay_smart_match_enabled', '1') !== '0',
    byName: getSetting('sepay_smart_match_by_name', '1') !== '0',
    byAmount: getSetting('sepay_smart_match_by_amount', '0') !== '0',
    minConfidence: parseFloat(getSetting('sepay_smart_min_confidence', '0.9')) || 0.9,
  };

  const empty = { customer: null, method: '', confidence: 0, candidates: [] };

  if (!settings.enabled) return empty;

  // ── Chiến lược 1: mã KH ────────────────────────────────────────────────
  if (tx.debt_code) {
    const byCode = findCustomerByDebtCode(tx.debt_code);
    if (byCode) {
      return {
        customer: byCode,
        method: 'debt_code',
        confidence: 1.0,
        candidates: [],
      };
    }
  }

  // ── Chiến lược 2: số tài khoản người gửi ───────────────────────────────
  const senderAccount =
    normalizeAccount(tx.sender_account) || extractSenderAccount(tx);
  if (senderAccount) {
    const byAccount = findCustomerByBankAccount(senderAccount);
    if (byAccount) {
      return {
        customer: byAccount,
        method: 'bank_account',
        confidence: 0.95,
        candidates: [],
      };
    }
  }

  // ── Chiến lược 3: tên người gửi ───────────────────────────────────────
  if (settings.byName) {
    const senderName = normalizeName(tx.sender_name) || extractSenderName(tx);
    if (senderName) {
      const byName = findCustomersByName(senderName, 5);

      // Chỉ nhận ứng viên ĐỦ TIN CẬY (điểm >= ngưỡng).
      const confident = byName.filter((r) => r.score >= settings.minConfidence);

      if (confident.length === 1) {
        return {
          customer: confident[0].customer,
          method: 'name',
          confidence: confident[0].score,
          candidates: [],
        };
      }

      if (confident.length > 1) {
        // Nhiều ứng viên cùng điểm cao → không tự quyết.
        return {
          customer: null,
          method: 'name_ambiguous',
          confidence: confident[0].score,
          candidates: confident.map((r) => ({
            id: r.customer.id,
            name: r.customer.name,
            score: r.score,
          })),
        };
      }

      // Có ứng viên nhưng điểm thấp (mơ hồ) → ghi ra để nhân viên xem xét.
      if (byName.length > 0) {
        return {
          customer: null,
          method: 'name_weak',
          confidence: byName[0].score,
          candidates: byName.map((r) => ({
            id: r.customer.id,
            name: r.customer.name,
            score: r.score,
          })),
        };
      }
    }
  }

  // ── Chiến lược 4: số tiền (suy đoán) ─────────────────────────────────
  if (settings.byAmount) {
    const amount = roundMoney(tx.transfer_amount);
    const byAmount = findCustomersByAmount(amount);
    if (byAmount.length === 1 && 0.5 >= settings.minConfidence) {
      return {
        customer: byAmount[0].customer,
        method: 'amount',
        confidence: 0.5,
        candidates: [],
      };
    }
    if (byAmount.length > 1) {
      return {
        customer: null,
        method: 'amount_ambiguous',
        confidence: 0.5,
        candidates: byAmount.map((r) => ({
          id: r.customer.id,
          name: r.customer.name,
          score: r.score,
        })),
      };
    }
  }

  return empty;
}

/** Sinh mã khách mới (KHxxxx) — không trùng mã đã có. */
function generateDebtCode() {
  try {
    const row = db
      .prepare(
        `SELECT debt_code FROM customers
          WHERE debt_code IS NOT NULL AND debt_code LIKE 'KH%'
          ORDER BY debt_code DESC LIMIT 1`
      )
      .get();
    let seq = 0;
    if (row && row.debt_code) {
      const n = parseInt(String(row.debt_code).replace(/\D/g, ''), 10);
      if (!Number.isNaN(n)) seq = n;
    }
    seq += 1;
    let candidate = 'KH' + String(seq).padStart(4, '0');
    let guard = 0;
    while (
      db.prepare('SELECT 1 FROM customers WHERE debt_code = ?').get(candidate) &&
      guard < 100
    ) {
      seq += 1;
      candidate = 'KH' + String(seq).padStart(4, '0');
      guard += 1;
    }
    return candidate;
  } catch (e) {
    logger.error('[SEPAY] generateDebtCode error', { error: e.message });
    return null;
  }
}

/**
 * Gán mã `debt_code` cho 1 khách (nếu chưa có).
 * @returns {string|null} mã sau khi gán
 */
function ensureCustomerDebtCode(customerId) {
  const custId = parseInt(customerId, 10);
  if (!custId || Number.isNaN(custId)) return null;
  try {
    const cust = db
      .prepare('SELECT id, debt_code FROM customers WHERE id = ?')
      .get(custId);
    if (!cust) return null;
    if (cust.debt_code) return cust.debt_code;

    const code = generateDebtCode();
    if (!code) return null;
    db.prepare(
      'UPDATE customers SET debt_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(code, custId);
    return code;
  } catch (e) {
    logger.error('[SEPAY] ensureCustomerDebtCode error', { error: e.message });
    return null;
  }
}

/** Đặt lại mã `debt_code` cho khách (nhân viên sửa tay). */
function setCustomerDebtCode(customerId, code) {
  const custId = parseInt(customerId, 10);
  if (!custId || Number.isNaN(custId)) {
    return { success: false, error: 'customerId không hợp lệ' };
  }
  const norm = normalizeCode(code);
  if (!norm) return { success: false, error: 'Mã khách không được để trống' };
  if (!/^[A-Z0-9]{3,12}$/.test(norm)) {
    return { success: false, error: 'Mã khách chỉ gồm chữ in hoa và số (3–12 ký tự)' };
  }
  try {
    const dup = db
      .prepare('SELECT id FROM customers WHERE debt_code = ? AND id != ?')
      .get(norm, custId);
    if (dup) {
      return { success: false, error: `Mã "${norm}" đã được khách #${dup.id} sử dụng` };
    }
    db.prepare(
      'UPDATE customers SET debt_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(norm, custId);
    return { success: true, debtCode: norm };
  } catch (e) {
    logger.error('[SEPAY] setCustomerDebtCode error', { error: e.message });
    return { success: false, error: e.message };
  }
}

// ── Xác thực webhook ─────────────────────────────────────────────────────────

/**
 * Xác thực chữ ký HMAC-SHA256 của SePay.
 *
 * Theo tài liệu SePay (https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc):
 *   - Header `X-SePay-Signature` có dạng `sha256={hex_hash}`
 *   - Header `X-SePay-Timestamp` = Unix timestamp (giây) lúc ký
 *   - Chuỗi được ký: `{timestamp}.{raw_body}`  (DẤU CHẤM nối, KHÔNG phải body)
 *   - Hash: HMAC-SHA256 với Secret Key → hex
 *
 * ⚠️ Phải dùng RAW BODY (bytes gốc). Nếu middleware đã parse JSON rồi
 *    stringify lại thì chữ ký lệch (thứ tự khóa, escape Unicode, whitespace).
 *
 * @param {Buffer|string} rawBody - raw body
 * @param {string} signature - giá trị header `X-SePay-Signature`
 * @param {string} secret - Secret Key
 * @param {number} [timestamp] - giá trị header `X-SePay-Timestamp` (Unix giây)
 * @param {object} [opts] { maxAgeSec } - cửa sổ chống replay (mặc định 300s)
 */
function verifyWebhookSignature(rawBody, signature, secret, timestamp, opts = {}) {
  if (!secret) return { valid: false, reason: 'NO_SECRET' };
  if (!signature) return { valid: false, reason: 'NO_SIGNATURE' };

  const maxAgeSec = opts.maxAgeSec === undefined ? 300 : opts.maxAgeSec;

  // ── Chống replay: timestamp lệch quá cửa sổ cho phép → từ chối ──────────
  // Bỏ qua nếu SePay không gửi timestamp (mode tương thích cũ).
  const ts = Number(timestamp);
  if (Number.isFinite(ts) && ts > 0 && maxAgeSec > 0) {
    const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (skew > maxAgeSec) {
      return { valid: false, reason: 'TIMESTAMP_EXPIRED', skew };
    }
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');

  // SePay gửi `sha256={hex}` — hỗ trợ thêm bản hex trần để tương thích.
  const raw = String(signature).trim();
  const hex = raw.startsWith('sha256=') ? raw.slice('sha256='.length) : raw;

  // ── Chuỗi ký ───────────────────────────────────────────────────────────
  //  • Có timestamp (cách chuẩn của SePay): `{timestamp}.{raw_body}`
  //  • Không có timestamp (tương thích): chỉ `{raw_body}`
  const hasTimestamp = Number.isFinite(ts) && ts > 0;
  const expected = hasTimestamp
    ? crypto
        .createHmac('sha256', secret)
        .update(`${ts}.`)
        .update(body)
        .digest('hex')
    : crypto.createHmac('sha256', secret).update(body).digest('hex');

  const a = Buffer.from(hex);
  const b = Buffer.from(expected);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    return { valid: true, method: hasTimestamp ? 'hmac-sha256' : 'hmac-legacy' };
  }

  return { valid: false, reason: 'INVALID_SIGNATURE' };
}

// ── Ghi nhận giao dịch ───────────────────────────────────────────────────────

/**
 * Lưu 1 giao dịch Sepay vào DB (idempotent theo `sepay_id`).
 * @returns {{success:boolean, transactionId?:number, duplicate?:boolean}}
 */
function storeTransaction(payload) {
  const sepayId = String(payload.id || payload.sepay_id || '').trim();
  if (!sepayId) return { success: false, error: 'Thiếu id giao dịch Sepay' };

  const amount = roundMoney(payload.transfer_amount || payload.transferAmount || 0);
  const transferType = String(
    payload.transfer_type || payload.transferType || 'in'
  ).toLowerCase();

  try {
    const existing = db
      .prepare('SELECT * FROM sepay_transactions WHERE sepay_id = ?')
      .get(sepayId);
    if (existing) {
      return { success: true, transactionId: existing.id, duplicate: true };
    }

    const debtCode = extractDebtCode(payload);
    // Gạch nợ thông minh: trích số TK + tên người gửi ngay khi lưu để
    // hệ thống có thể nhận diện khách NGAY CẢ KHI không có mã QR.
    const senderAccount = extractSenderAccount(payload);
    const senderName = extractSenderName(payload);

    const info = db
      .prepare(
        `INSERT INTO sepay_transactions
           (sepay_id, gateway, account_number, sub_account, code, content, description,
            transfer_type, transfer_amount, accumulated, reference_code, transaction_date,
            debt_code, status, raw_payload, sender_account, sender_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sepayId,
        payload.gateway || null,
        payload.account_number || payload.accountNumber || null,
        payload.sub_account || payload.subAccount || null,
        payload.code || null,
        payload.content || payload.transaction_content || null,
        payload.description || null,
        transferType,
        amount,
        roundMoney(payload.accumulated || 0),
        payload.reference_code || payload.referenceCode || null,
        payload.transaction_date || payload.transactionDate || null,
        debtCode || null,
        TX_STATUS.PENDING,
        JSON.stringify(payload),
        senderAccount || null,
        senderName || null
      );

    return { success: true, transactionId: info.lastInsertRowid };
  } catch (e) {
    logger.error('[SEPAY] storeTransaction error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Xử lý 1 giao dịch đã lưu: khớp khách + gạch nợ.
 *
 * @param {number} txId - id trong `sepay_transactions`
 * @param {object} [opts] { user, force }
 */
function processTransaction(txId, opts = {}) {
  const { user = null, force = false } = opts;

  const tx = db.prepare('SELECT * FROM sepay_transactions WHERE id = ?').get(txId);
  if (!tx) return { success: false, error: 'Không tìm thấy giao dịch' };

  // Đã xử lý rồi → không làm gì (idempotent)
  if (tx.status === TX_STATUS.MATCHED && !force) {
    return {
      success: true,
      skipped: true,
      reason: 'ALREADY_PROCESSED',
      transactionId: tx.id,
    };
  }

  // Tiền RA → không gạch nợ
  if (tx.transfer_type !== 'in') {
    db.prepare(
      `UPDATE sepay_transactions
          SET status = ?, processed_at = CURRENT_TIMESTAMP, note = ?
        WHERE id = ?`
    ).run(TX_STATUS.IGNORED, 'Giao dịch tiền ra — không gạch nợ', tx.id);
    return { success: true, skipped: true, reason: 'OUT_TRANSFER', transactionId: tx.id };
  }

  const amount = roundMoney(tx.transfer_amount);
  if (!(amount > 0)) {
    db.prepare(
      `UPDATE sepay_transactions
          SET status = ?, processed_at = CURRENT_TIMESTAMP, note = ?
        WHERE id = ?`
    ).run(TX_STATUS.IGNORED, 'Số tiền = 0', tx.id);
    return { success: true, skipped: true, reason: 'ZERO_AMOUNT', transactionId: tx.id };
  }

  // ── 1. Khớp khách hàng ────────────────────────────────────────────────
  let customer = null;
  let matchMethod = '';
  let matchConfidence = 0;
  let matchCandidates = [];

  if (tx.customer_id) {
    customer = db
      .prepare('SELECT id, name, phone, debt, debt_code FROM customers WHERE id = ?')
      .get(tx.customer_id);
    matchMethod = customer ? 'manual' : '';
  }

  if (!customer && tx.debt_code) {
    customer = findCustomerByDebtCode(tx.debt_code);
    if (customer) {
      matchMethod = 'debt_code';
      matchConfidence = 1.0;
    }
  }

  // ── 1b. GẠCH NỢ THÔNG MINH ───────────────────────────────────────────
  //    Khách chuyển theo SỐ TÀI KHOẢN (không quét mã QR) → nội dung không
  //    có mã KH. Hệ thống tự nhận diện qua số TK người gửi / tên người gửi.
  if (!customer) {
    const smart = smartMatchCustomer(tx);
    matchMethod = smart.method || matchMethod;
    matchConfidence = smart.confidence;
    matchCandidates = smart.candidates || [];

    if (smart.customer) {
      customer = smart.customer;
    } else if (matchCandidates.length > 0) {
      // Nhiều ứng viên → ghi lại để nhân viên chọn nhanh trong UI.
      db.prepare(
        `UPDATE sepay_transactions
            SET match_method = ?, match_confidence = ?, match_candidates = ?,
                processed_at = CURRENT_TIMESTAMP, note = ?
          WHERE id = ?`
      ).run(
        matchMethod,
        matchConfidence,
        JSON.stringify(matchCandidates),
        `Nhiều khách hàng có thể khớp (${matchCandidates
          .map((c) => c.name)
          .join(', ')}) — cần nhân viên chọn`,
        tx.id
      );
      return {
        success: false,
        code: 'AMBIGUOUS_CUSTOMER',
        error: 'Nhiều khách hàng có thể khớp — cần nhân viên chọn',
        transactionId: tx.id,
        candidates: matchCandidates,
      };
    }
  }

  if (!customer) {
    db.prepare(
      `UPDATE sepay_transactions
          SET status = ?, processed_at = CURRENT_TIMESTAMP, note = ?,
              match_method = ?, match_confidence = ?
        WHERE id = ?`
    ).run(
      TX_STATUS.MANUAL,
      tx.debt_code
        ? `Không tìm thấy khách với mã "${tx.debt_code}" — cần nhân viên xử lý`
        : 'Không tìm thấy mã khách trong nội dung chuyển khoản — cần nhân viên xử lý',
      matchMethod || null,
      matchConfidence || null,
      tx.id
    );
    return {
      success: false,
      code: 'NO_CUSTOMER_MATCH',
      error: 'Chưa khớp được khách hàng',
      transactionId: tx.id,
    };
  }

  // ── 2. Gạch nợ ────────────────────────────────────────────────────────
  const balanceBefore = DebtLedgerService.computeBalance(customer.id);
  const settings = getSettings();

  if (!settings.autoSettle && !force) {
    db.prepare(
      `UPDATE sepay_transactions
          SET status = ?, customer_id = ?, processed_at = CURRENT_TIMESTAMP,
              note = ?
        WHERE id = ?`
    ).run(
      TX_STATUS.MANUAL,
      customer.id,
      'Chế độ tự động gạch nợ đang TẮT',
      tx.id
    );
    return {
      success: true,
      skipped: true,
      reason: 'AUTO_SETTLE_DISABLED',
      transactionId: tx.id,
      customerId: customer.id,
    };
  }

  // Số nợ hiện tại (có thể âm = khách đang nợ lại hệ thống)
  const owed = balanceBefore > 0 ? balanceBefore : 0;

  // Phần được gạch = min(số tiền nhận, số nợ)
  const applied = roundMoney(Math.min(amount, owed));
  // Phần dư = số tiền nhận - phần gạch (tiền khách nợ lại)
  const credit = roundMoney(Math.max(0, amount - applied));

  // ⚠️ THÔNG TIN HIỂN THỊ (KHÔNG tạo bút toán riêng):
  // Sổ công nợ dùng SỐ DƯ RÒNG → balance = tổng nợ - tổng đã trả.
  // Nếu khách đang nợ lại (số dư âm) thì toàn bộ số tiền nhận đều quy về
  // CREDIT (số dư âm thêm). `deficitOffset` = phần tiền nhận dùng để bù
  // khoản nợ lại (chỉ để hiển thị cho nhân viên, KHÔNG ghi bút toán vì
  // ledger đã trừ đúng số tiền nhận rồi).
  const deficitOffset = balanceBefore < 0 ? roundMoney(Math.min(amount, -balanceBefore)) : 0;

  let paymentResult = null;
  let creditResult = null;

  if (applied > 0) {
    paymentResult = DebtLedgerService.recordTransaction({
      customerId: customer.id,
      transactionType: TRANSACTION_TYPES.PAYMENT,
      amount: applied,
      direction: DebtLedgerService.DIRECTION.DECREASE,
      referenceType: REFERENCE_TYPES.MANUAL,
      referenceId: tx.sepay_id,
      description: `Thanh toán qua Sepay (${tx.transaction_date || ''})`.trim(),
      createdBy: (user && user.username) || 'sepay',
      source: SOURCES.SYSTEM,
      idempotencyKey: `sepay:${tx.sepay_id}:payment`,
      allowNegativeBalance: true,
      businessDate: sepayBusinessDate(tx.transaction_date),
    });

    if (!paymentResult.success) {
      logger.error('[SEPAY] record payment failed', {
        txId: tx.id,
        error: paymentResult.error,
      });
      db.prepare(
        `UPDATE sepay_transactions
            SET status = ?, customer_id = ?, processed_at = CURRENT_TIMESTAMP, note = ?
          WHERE id = ?`
      ).run(TX_STATUS.MANUAL, customer.id, `Lỗi ghi bút toán: ${paymentResult.error}`, tx.id);
      return {
        success: false,
        error: paymentResult.error,
        transactionId: tx.id,
      };
    }

    // Phân bổ FIFO vào bảng chiếu `order_debts`
    allocateToOrders(customer.id, applied);
  }

  if (credit > 0) {
    // Tiền khách nợ lại → bút toán CREDIT giảm công nợ (số dư âm).
    // `keepNegativeBalance: true` → giữ số dư âm thật trong ledger + mirror.
    creditResult = DebtLedgerService.recordTransaction({
      customerId: customer.id,
      transactionType: TRANSACTION_TYPES.CREDIT,
      amount: credit,
      direction: DebtLedgerService.DIRECTION.DECREASE,
      referenceType: REFERENCE_TYPES.MANUAL,
      referenceId: tx.sepay_id,
      description: `Tiền khách chuyển DƯ qua Sepay (${credit.toLocaleString('vi-VN')}đ)`,
      createdBy: (user && user.username) || 'sepay',
      source: SOURCES.SYSTEM,
      idempotencyKey: `sepay:${tx.sepay_id}:credit`,
      allowNegativeBalance: true,
      keepNegativeBalance: true,
      businessDate: sepayBusinessDate(tx.transaction_date),
    });

    if (!creditResult.success) {
      logger.error('[SEPAY] record credit failed', {
        txId: tx.id,
        error: creditResult.error,
      });
    }
  }

  const balanceAfter = DebtLedgerService.computeBalance(customer.id);

  // ── 3. Cập nhật giao dịch Sepay ───────────────────────────────────────
  const noteParts = [];
  if (applied > 0) noteParts.push(`Gạch nợ ${applied.toLocaleString('vi-VN')}đ`);
  if (credit > 0) noteParts.push(`Khách nợ lại ${credit.toLocaleString('vi-VN')}đ`);
  if (deficitOffset > 0 && applied === 0) {
    noteParts.push(`Bù nợ lại ${deficitOffset.toLocaleString('vi-VN')}đ`);
  }
  if (applied === 0 && credit === 0) noteParts.push('Không có công nợ để gạch');

  db.prepare(
    `UPDATE sepay_transactions
        SET status = ?, customer_id = ?, applied_amount = ?, credit_amount = ?,
            debt_transaction_id = ?, processed_at = CURRENT_TIMESTAMP, note = ?,
            match_method = ?, match_confidence = ?, match_candidates = NULL
      WHERE id = ?`
  ).run(
    TX_STATUS.MATCHED,
    customer.id,
    applied,
    credit,
    paymentResult ? paymentResult.transactionId : null,
    noteParts.join(' · '),
    matchMethod || null,
    matchConfidence || null,
    tx.id
  );

  DebtAuditService.record({
    transactionId: paymentResult ? paymentResult.transactionId : null,
    action: DebtAuditService.AUDIT_ACTIONS.CREATE,
    actorId: (user && user.username) || 'sepay',
    beforeData: { balance: balanceBefore, sepayId: tx.sepay_id },
    afterData: {
      balance: balanceAfter,
      applied,
      credit,
      deficitOffset,
      customerId: customer.id,
      sepayId: tx.sepay_id,
    },
  });

  logger.info('[SEPAY] Settlement done', {
    txId: tx.id,
    customerId: customer.id,
    amount,
    applied,
    credit,
    deficitOffset,
    balanceAfter,
  });

  // ── 3b. Gửi tin nhắn Zalo thông báo công nợ (KHÔNG chặn nghiệp vụ) ────
  //    Fire-and-forget: lỗi OmiCall không được làm hỏng giao dịch đã gạch.
  DebtNotifyService.notifyPaymentAsync({
    customerId: customer.id,
    customerName: customer.name,
    amount,
    applied,
    credit,
    balanceBefore,
    balanceAfter,
    source: 'SEPAY',
    transactionId: paymentResult ? paymentResult.transactionId : null,
  });

  return {
    success: true,
    transactionId: tx.id,
    customerId: customer.id,
    customerName: customer.name,
    amount,
    applied,
    credit,
    deficitOffset,
    balanceBefore,
    balanceAfter,
    debtTransactionId: paymentResult ? paymentResult.transactionId : null,
    matchMethod: matchMethod || null,
    matchConfidence: matchConfidence || null,
  };
}

/**
 * Ngày nghiệp vụ của giao dịch Sepay (YYYY-MM-DD).
 * Sepay gửi `transactionDate` = "YYYY-MM-DD HH:mm:ss" (giờ VN).
 */
function sepayBusinessDate(transactionDate) {
  if (!transactionDate) return null;
  const m = String(transactionDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * Phân bổ tiền trả vào các đơn chưa thanh toán (FIFO — đơn cũ trước).
 * Đồng bộ với `order_debts` + `sales.payment_status`.
 */
function allocateToOrders(customerId, amount) {
  let remaining = roundMoney(amount);
  try {
    const unpaidOrders = db
      .prepare(
        `SELECT * FROM order_debts
          WHERE customer_id = ? AND status != 'paid' AND status != 'cancelled'
          ORDER BY created_at ASC, id ASC`
      )
      .all(customerId);

    for (const od of unpaidOrders) {
      if (remaining <= 0) break;
      const toApply = Math.min(remaining, od.remaining_amount || 0);
      if (toApply <= 0) continue;
      const newPaid = (od.paid_amount || 0) + toApply;
      const newRemaining = Math.max(0, od.original_amount - newPaid);
      const status = newRemaining <= 0 ? 'paid' : 'partial';
      db.prepare(
        `UPDATE order_debts
            SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(newPaid, newRemaining, status, od.id);
      if (od.sale_id) {
        db.prepare('UPDATE sales SET payment_status = ? WHERE id = ?').run(status, od.sale_id);
      }
      remaining = roundMoney(remaining - toApply);
    }
  } catch (e) {
    logger.error('[SEPAY] allocateToOrders error', { error: e.message });
  }
}

// ── Webhook ──────────────────────────────────────────────────────────────────

/**
 * Xử lý payload webhook từ Sepay.
 *
 * @param {object} payload - body đã parse JSON
 * @param {object} [opts] { user }
 */
function handleWebhook(payload, opts = {}) {
  if (!payload || !payload.id) {
    return { success: false, error: 'Payload không hợp lệ' };
  }

  const stored = storeTransaction(payload);
  if (!stored.success) {
    return { success: false, error: stored.error };
  }

  if (stored.duplicate) {
    logger.info('[SEPAY] Webhook trùng (bỏ qua)', { sepayId: payload.id });
    return { success: true, duplicate: true, transactionId: stored.transactionId };
  }

  const processed = processTransaction(stored.transactionId, { user: opts.user });
  return { success: true, transactionId: stored.transactionId, settlement: processed };
}

// ── Đối soát qua API ─────────────────────────────────────────────────────────

/**
 * Gọi API SePay v2 lấy danh sách giao dịch (dùng cho đối soát bù webhook).
 *
 * API v2: GET https://userapi.sepay.vn/v2/transactions
 *   - Auth: `Authorization: Bearer <API_TOKEN>`
 *   - Response: `{ status, data: [...], meta: { pagination: {...} } }`
 *   - Field trong `data` dùng SNAKE_CASE (`transaction_content`, `amount_in`, ...),
 *     khác với payload webhook (camelCase) → cần chuẩn hoá.
 *   - Rate limit: 3 request/giây → trả 429 nếu vượt.
 *
 * @param {object} [opts] { from, to, page, perPage, sinceId }
 * @returns {Promise<{success:boolean, transactions?:Array, error?:string}>}
 */
async function fetchTransactions(opts = {}) {
  const settings = getSettings();
  if (!settings.apiToken) {
    return { success: false, error: 'Chưa cấu hình Sepay API token' };
  }

  const url = new URL(`${SEPAY_API_BASE}/transactions`);
  if (opts.from) url.searchParams.set('transaction_date_from', opts.from);
  if (opts.to) url.searchParams.set('transaction_date_to', opts.to);
  if (opts.sinceId) url.searchParams.set('since_id', opts.sinceId);
  url.searchParams.set('per_page', String(Math.min(100, opts.perPage || 100)));
  url.searchParams.set('page', String(opts.page || 1));
  // Sắp xếp tăng dần để `since_id` bắt đúng những giao dịch mới
  url.searchParams.set('transaction_date_sort', 'asc');

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiToken}`,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('[SEPAY] fetchTransactions HTTP error', {
        status: res.status,
        body: text.slice(0, 300),
      });
      if (res.status === 401) {
        return { success: false, error: 'API token không hợp lệ hoặc đã bị vô hiệu' };
      }
      if (res.status === 429) {
        return {
          success: false,
          error: 'Sepay giới hạn tốc độ (tối đa 3 request/giây) — thử lại sau',
        };
      }
      return { success: false, error: `Lỗi API Sepay (HTTP ${res.status})` };
    }

    const json = await res.json();

    // API v2 luôn dùng key `data`; key `transactions` là của v1 (giữ để tương thích).
    const list = Array.isArray(json.data)
      ? json.data
      : Array.isArray(json.transactions)
        ? json.transactions
        : [];

    const normalized = list.map(normalizeApiTransaction);
    const pagination = (json.meta && json.meta.pagination) || {};

    return {
      success: true,
      transactions: normalized,
      pagination: {
        total: pagination.total || 0,
        currentPage: pagination.current_page || 1,
        lastPage: pagination.last_page || 1,
        hasMore: !!pagination.has_more,
      },
      raw: json,
    };
  } catch (e) {
    logger.error('[SEPAY] fetchTransactions error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Chuẩn hoá giao dịch từ API v2 (snake_case) về format nội bộ (camelCase),
 * để `storeTransaction` xử lý giống hệt payload webhook.
 */
function normalizeApiTransaction(t = {}) {
  const transferType = String(t.transfer_type || 'in').toLowerCase();
  // API v2 tách amount_in / amount_out; webhook dùng transferAmount + transferType.
  const amount = t.transfer_amount !== undefined && t.transfer_amount !== null
    ? t.transfer_amount
    : transferType === 'out'
      ? (t.amount_out || 0)
      : (t.amount_in || 0);

  return {
    id: t.id,
    gateway: t.bank_brand_name || t.gateway || null,
    accountNumber: t.account_number || null,
    subAccount: t.va || t.sub_account || null,
    code: t.code || null,
    content: t.transaction_content || t.content || null,
    description: t.description || null,
    transferType,
    transferAmount: amount,
    accumulated: t.accumulated || 0,
    referenceCode: t.reference_number || t.reference_code || null,
    transactionDate: t.transaction_date || t.transactionDate || null,
    // `webhook_success`: 1 = đã gửi webhook thành công, 0 = thất bại/chưa gửi.
    webhookSuccess: t.webhook_success === undefined ? null : t.webhook_success,
  };
}

/**
 * Đối soát: lấy giao dịch từ API Sepay trong khoảng thời gian, lưu những
 * giao dịch chưa có trong DB, rồi gạch nợ những giao dịch mới.
 *
 * @param {object} [opts] { from, to, user }
 */
async function reconcile(opts = {}) {
  const now = new Date();
  const to = opts.to || formatSepayDate(now);
  const from =
    opts.from || formatSepayDate(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));

  const fetched = await fetchTransactions({ from, to, perPage: 100 });
  if (!fetched.success) return fetched;

  let added = 0;
  let duplicates = 0;
  let settled = 0;
  let failed = 0;
  let total = 0;
  const results = [];
  const all = [];

  // Đọc HẾT các trang (per_page tối đa 100). Rate limit SePay = 3 req/giây
  // → nghỉ 350ms giữa các lần gọi để không bị 429.
  let page = 1;
  let hasMore = true;
  const MAX_PAGES = 20; // chặn runaway
  while (hasMore && page <= MAX_PAGES) {
    const fetched = await fetchTransactions({ from, to, perPage: 100, page });
    if (!fetched.success) {
      if (all.length === 0) return fetched;
      break; // đã lấy được phần nào → vẫn xử lý phần đó
    }
    const list = fetched.transactions || [];
    total += list.length;
    all.push(...list);
    hasMore = !!(fetched.pagination && fetched.pagination.hasMore) && list.length > 0;
    page += 1;
    if (hasMore) await sleep(350);
  }

  for (const t of all) {
    const stored = storeTransaction(t);
    if (!stored.success) {
      failed += 1;
      continue;
    }
    if (stored.duplicate) {
      duplicates += 1;
      continue;
    }
    added += 1;
    const res = processTransaction(stored.transactionId, { user: opts.user });
    if (res.success && !res.skipped) settled += 1;
    else if (!res.success) failed += 1;
    results.push(res);
  }

  logger.info('[SEPAY] Reconcile done', { from, to, added, duplicates, settled, failed });

  return {
    success: true,
    from,
    to,
    total,
    added,
    duplicates,
    settled,
    failed,
    results,
  };
}

// ── Tự động đối soát định kỳ (auto-poll) ───────────────────────────────────

const AUTO_POLL_LAST_RUN_KEY = 'sepay_auto_poll_last_run';
const AUTO_POLL_LOCK_KEY = 'sepay_auto_poll_lock';

/**
 * Đối soát TỰ ĐỘNG theo lịch — chạy bởi cron trong `server.js`.
 *
 * Mục đích: bảo đảm hệ thống LUÔN tự gạch nợ khi khách chuyển tiền, kể cả khi:
 *   - Webhook SePay chưa cấu hình / cấu hình sai / SePay gửi lỗi.
 *   - Server mất mạng, khởi động lại giữa chừng.
 *
 * Webhook vẫn là đường chính (real-time ~ vài giây). Auto-poll là lưới an toàn
 * (bù trễ tối đa `autoPollIntervalMin` phút).
 *
 * Idempotent: dựa trên `sepay_transactions.sepay_id` UNIQUE → chạy lại không
 * gạch nợ 2 lần.
 *
 * @param {object} [opts] { force }
 * @returns {Promise<object>}
 */
async function autoReconcile(opts = {}) {
  const settings = getSettings();

  // Chưa cấu hình API token → không làm gì (tránh spam log mỗi lần cron chạy).
  if (!settings.apiToken) {
    return { success: false, skipped: true, reason: 'NO_API_TOKEN' };
  }
  if (!settings.autoPollEnabled && !opts.force) {
    return { success: false, skipped: true, reason: 'AUTO_POLL_DISABLED' };
  }

  // Khoá chống chạy song song (cron trùng nhau khi server chậm).
  const lockAt = Number(getSetting(AUTO_POLL_LOCK_KEY, '0')) || 0;
  if (!opts.force && Date.now() - lockAt < 120000) {
    return { success: false, skipped: true, reason: 'LOCKED' };
  }
  setSetting(AUTO_POLL_LOCK_KEY, String(Date.now()));

  try {
    const now = new Date();
    const to = formatSepayDate(now);

    // Lần đầu chạy → lùi `autoPollLookbackDays` ngày để không bỏ sót giao
    // dịch xảy ra lúc server đang tắt. Các lần sau → lùi 30 phút (đệm).
    const lastRun = getSetting(AUTO_POLL_LAST_RUN_KEY, '');
    const lookbackMs = lastRun
      ? 30 * 60 * 1000
      : Math.max(1, settings.autoPollLookbackDays) * 24 * 60 * 60 * 1000;
    const from = formatSepayDate(new Date(now.getTime() - lookbackMs));

    const result = await reconcile({ from, to });

    if (!result.success) {
      logger.warn('[SEPAY] auto-poll failed', { error: result.error });
      return result;
    }

    setSetting(AUTO_POLL_LAST_RUN_KEY, now.toISOString());

    // ── Cảnh báo thông báo Zalo bị mất (CHỈ GHI LOG, KHÔNG GỬI) ─────────
    //    Thông báo gửi bất đồng bộ (fire-and-forget) → nếu tiến trình bị kết
    //    thúc sớm (script CLI, restart server) thì tin nhắn mất im lặng.
    //
    //    ⚠️ NGUYÊN TẮC: KHÔNG BAO GIỜ tự động gửi tin vào nhóm Zalo của
    //    khách. Hệ thống chỉ GHI NHẬN số lượng bị thiếu để nhân viên vào
    //    tab "Thông báo" kiểm tra & bấm "Gửi lại" thủ công.
    try {
      const missing = DebtNotifyService.listMissingNotifications({ lookbackDays: 7 });
      if (missing.scanned > 0) {
        logger.warn('[SEPAY] Có giao dịch đã gạch nợ nhưng chưa gửi tin Zalo', {
          count: missing.scanned,
          hint: 'Vào Sổ công nợ → tab Thông báo → bấm "Tin chưa gửi" để gửi lại',
        });
      }
    } catch (e) {
      logger.error('[SEPAY] auto-poll check missing notifications error', {
        error: e.message,
      });
    }

    if (result.added > 0 || result.settled > 0) {
      logger.info('[SEPAY] auto-poll settled', {
        from,
        to,
        added: result.added,
        settled: result.settled,
        failed: result.failed,
      });
    }

    return { ...result, auto: true };
  } catch (e) {
    logger.error('[SEPAY] autoReconcile error', { error: e.message });
    return { success: false, error: e.message };
  } finally {
    setSetting(AUTO_POLL_LOCK_KEY, '0');
  }
}

/** Đọc/ghi setting dạng key-value (bảng `settings`). */
function getSetting(key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value !== undefined && row.value !== null ? row.value : fallback;
  } catch (_) {
    return fallback;
  }
}

function setSetting(key, value) {
  try {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value === null || value === undefined ? '' : String(value));
    return true;
  } catch (e) {
    logger.error('[SEPAY] setSetting error', { key, error: e.message });
    return false;
  }
}

/** Chờ (ms) — dùng để giữ nhịp rate limit của SePay (3 req/giây). */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSepayDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// ── Truy vấn ─────────────────────────────────────────────────────────────────

/** Danh sách giao dịch Sepay (mới nhất trước). */
function listTransactions(filters = {}) {
  const limit = Math.min(500, Math.max(1, parseInt(filters.limit) || 100));
  const offset = Math.max(0, parseInt(filters.offset) || 0);
  const params = [];
  let where = '1=1';

  if (filters.status) {
    where += ' AND t.status = ?';
    params.push(filters.status);
  }
  if (filters.customerId) {
    where += ' AND t.customer_id = ?';
    params.push(parseInt(filters.customerId, 10));
  }
  if (filters.from) {
    where += ' AND t.transaction_date >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    where += ' AND t.transaction_date <= ?';
    params.push(filters.to);
  }

  const rows = db
    .prepare(
      `SELECT t.*, c.name AS customer_name, c.phone AS customer_phone
         FROM sepay_transactions t
         LEFT JOIN customers c ON c.id = t.customer_id
        WHERE ${where}
        ORDER BY t.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM sepay_transactions t WHERE ${where}`)
    .get(...params);

  return {
    total: total ? total.c : 0,
    items: rows.map((r) => ({
      id: r.id,
      sepayId: r.sepay_id,
      gateway: r.gateway,
      accountNumber: r.account_number,
      code: r.code,
      content: r.content,
      description: r.description,
      transferType: r.transfer_type,
      amount: roundMoney(r.transfer_amount),
      accumulated: roundMoney(r.accumulated || 0),
      referenceCode: r.reference_code,
      transactionDate: r.transaction_date,
      customerId: r.customer_id,
      customerName: r.customer_name,
      debtCode: r.debt_code,
      status: r.status,
      appliedAmount: roundMoney(r.applied_amount || 0),
      creditAmount: roundMoney(r.credit_amount || 0),
      // ── Gạch nợ thông minh ────────────────────────────────────────────
      senderAccount: r.sender_account || null,
      senderName: r.sender_name || null,
      matchMethod: r.match_method || null,
      matchConfidence:
        r.match_confidence === null || r.match_confidence === undefined
          ? null
          : Number(r.match_confidence),
      matchCandidates: (() => {
        if (!r.match_candidates) return [];
        try {
          const parsed = JSON.parse(r.match_candidates);
          return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
          return [];
        }
      })(),
      note: r.note,
      createdAt: r.created_at,
      processedAt: r.processed_at,
    })),
  };
}

/** Thống kê nhanh cho UI. */
function getSummary() {
  try {
    const row = db
      .prepare(
        `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'manual'  THEN 1 ELSE 0 END), 0) AS manual,
            COALESCE(SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END), 0) AS matched,
            COALESCE(SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END), 0) AS ignored,
            COALESCE(SUM(CASE WHEN status = 'matched' THEN applied_amount ELSE 0 END), 0) AS applied,
            COALESCE(SUM(CASE WHEN status = 'matched' THEN credit_amount ELSE 0 END), 0) AS credit
          FROM sepay_transactions`
      )
      .get();

    const settings = getSettings();
    return {
      total: row.total,
      pending: row.pending,
      manual: row.manual,
      matched: row.matched,
      ignored: row.ignored,
      applied: roundMoney(row.applied),
      credit: roundMoney(row.credit),
      configured: !!settings.apiToken,
      autoSettle: settings.autoSettle,
    };
  } catch (e) {
    logger.error('[SEPAY] getSummary error', { error: e.message });
    return {
      total: 0,
      pending: 0,
      manual: 0,
      matched: 0,
      ignored: 0,
      applied: 0,
      credit: 0,
    };
  }
}

/** Nhân viên gán khách cho 1 giao dịch chờ xử lý → gạch nợ ngay. */
function assignCustomerAndSettle(txId, customerId, opts = {}) {
  const id = parseInt(txId, 10);
  const custId = parseInt(customerId, 10);
  if (!id || Number.isNaN(id)) {
    return { success: false, error: 'transactionId không hợp lệ' };
  }
  if (!custId || Number.isNaN(custId)) {
    return { success: false, error: 'customerId không hợp lệ' };
  }
  try {
    const tx = db.prepare('SELECT * FROM sepay_transactions WHERE id = ?').get(id);
    if (!tx) return { success: false, error: 'Không tìm thấy giao dịch' };
    if (tx.status === TX_STATUS.MATCHED) {
      return { success: false, error: 'Giao dịch đã được gạch nợ rồi' };
    }
    db.prepare('UPDATE sepay_transactions SET customer_id = ? WHERE id = ?').run(custId, id);
  } catch (e) {
    logger.error('[SEPAY] assignCustomer error', { error: e.message });
    return { success: false, error: e.message };
  }
  return processTransaction(id, { user: opts.user, force: true });
}

/** Bỏ qua 1 giao dịch (VD: tiền của hệ thống, giao dịch nhầm). */
function ignoreTransaction(txId, note) {
  const id = parseInt(txId, 10);
  if (!id || Number.isNaN(id)) {
    return { success: false, error: 'transactionId không hợp lệ' };
  }
  try {
    db.prepare(
      `UPDATE sepay_transactions
          SET status = ?, processed_at = CURRENT_TIMESTAMP, note = ?
        WHERE id = ?`
    ).run(TX_STATUS.IGNORED, note || 'Bỏ qua bởi nhân viên', id);
    return { success: true };
  } catch (e) {
    logger.error('[SEPAY] ignoreTransaction error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Nội dung chuyển khoản có nhúng mã khách để Sepay/ngân hàng đọc được.
 * @param {number} customerId
 * @param {string} [extra] nội dung gốc
 */
function buildTransferContent(customerId, extra) {
  const code = ensureCustomerDebtCode(customerId);
  const base = extra ? String(extra) : '';
  if (!code) return base;
  return base ? `${base} ${code}` : code;
}

/**
 * Sửa `debt_code` cho các giao dịch Sepay đã lưu SAI do regex greedy.
 *
 * ⚠️ Lỗi lịch sử:
 *  Bản cũ bỏ hết ký tự phân tách rồi match `KH\d{3,8}` (greedy) → với nội dung
 *  "…KH0006-211126-18:37:58…" mã bị nuốt thành "KH00062111" (sai).
 *
 * Hàm này:
 *  1. Trích lại mã ĐÚNG từ `content` (giữ dấu phân tách + ưu tiên 4 chữ số).
 *  2. Chỉ ghi khi mã mới khác mã cũ.
 *  3. Nếu giao dịch đã gạch nợ (customer_id khác null) → KHÔNG đụng vào,
 *     chỉ cập nhật trường `debt_code` cho đúng để hiển thị/đối soát.
 *
 * @returns {{scanned:number, fixed:number, details:Array}}
 */
function repairDebtCodes() {
  const result = { scanned: 0, fixed: 0, details: [] };
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT id, content, description, code, debt_code, customer_id, status
           FROM sepay_transactions
          WHERE debt_code IS NOT NULL`
      )
      .all();
  } catch (e) {
    logger.error('[SEPAY] repairDebtCodes scan error', { error: e.message });
    return result;
  }

  const update = db.prepare('UPDATE sepay_transactions SET debt_code = ? WHERE id = ?');

  for (const row of rows) {
    result.scanned += 1;
    const fixed = matchDebtCodeIn(normalizeWithSeparators(row.content || ''))
      || matchDebtCodeIn(normalizeWithSeparators(row.description || ''))
      || matchDebtCodeIn(normalizeWithSeparators(row.code || ''));
    if (!fixed || fixed === row.debt_code) continue;

    try {
      update.run(fixed, row.id);
      result.fixed += 1;
      result.details.push({
        id: row.id,
        old: row.debt_code,
        new: fixed,
        matchedCustomer: !!row.customer_id,
      });
    } catch (e) {
      logger.error('[SEPAY] repairDebtCodes update error', {
        id: row.id,
        error: e.message,
      });
    }
  }

  if (result.fixed > 0) {
    logger.info('[SEPAY] repairDebtCodes fixed', {
      scanned: result.scanned,
      fixed: result.fixed,
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// QUẢN LÝ SỐ TÀI KHOẢN NGÂN HÀNG CỦA KHÁCH
// ─────────────────────────────────────────────────────────────────────────────
// Cho phép đăng ký số tài khoản (VD "1988888779779") cho 1 khách → hệ thống
// tự nhận diện giao dịch gửi từ số TK đó, KHÔNG CẦN quét mã QR.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lưu số tài khoản ngân hàng cho khách.
 *
 * @param {number} customerId
 * @param {string} accountNumber - số tài khoản (VD "1988888779779")
 * @param {string} [accountHolder] - tên chủ tài khoản (VD "BUI TRUONG VAN")
 * @returns {{success:boolean, error?:string, accountNumber?:string}}
 */
function setCustomerBankAccount(customerId, accountNumber, accountHolder) {
  const custId = parseInt(customerId, 10);
  if (!custId || Number.isNaN(custId)) {
    return { success: false, error: 'customerId không hợp lệ' };
  }

  const acc = normalizeAccount(accountNumber);
  if (!acc || acc.length < 6 || acc.length > 20) {
    return {
      success: false,
      error: 'Số tài khoản không hợp lệ (cần 6-20 chữ số)',
    };
  }

  try {
    const cust = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(custId);
    if (!cust) return { success: false, error: 'Không tìm thấy khách hàng' };

    // Cảnh báo nếu số TK đã thuộc khách khác.
    const owner = db
      .prepare(
        `SELECT id, name FROM customers
          WHERE REPLACE(REPLACE(REPLACE(COALESCE(bank_account,''),' ',''),'-',''),'.','') = ?
            AND id <> ?`
      )
      .get(acc, custId);

    if (owner) {
      return {
        success: false,
        error: `Số tài khoản đang thuộc khách "${owner.name}" (ID ${owner.id})`,
      };
    }

    const holder = accountHolder ? String(accountHolder).trim() : null;

    db.prepare(
      `UPDATE customers
          SET bank_account = ?, bank_account_name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(acc, holder, custId);

    logger.info('[SEPAY] setCustomerBankAccount', { customerId: custId, account: acc });

    return { success: true, accountNumber: acc, accountHolder: holder };
  } catch (e) {
    logger.error('[SEPAY] setCustomerBankAccount error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Xoá số tài khoản ngân hàng của khách.
 * @returns {{success:boolean, error?:string}}
 */
function clearCustomerBankAccount(customerId) {
  const custId = parseInt(customerId, 10);
  if (!custId || Number.isNaN(custId)) {
    return { success: false, error: 'customerId không hợp lệ' };
  }
  try {
    db.prepare(
      `UPDATE customers
          SET bank_account = NULL, bank_account_name = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(custId);
    return { success: true };
  } catch (e) {
    logger.error('[SEPAY] clearCustomerBankAccount error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Danh sách khách đã đăng ký số tài khoản (kèm số giao dịch đã khớp).
 */
function listCustomerBankAccounts() {
  try {
    return db
      .prepare(
        `SELECT c.id, c.name, c.phone, c.debt, c.debt_code,
                c.bank_account, c.bank_account_name,
                (SELECT COUNT(*) FROM sepay_transactions t
                  WHERE t.customer_id = c.id AND t.sender_account IS NOT NULL
                    AND t.sender_account <> '') AS matched_by_account
           FROM customers c
          WHERE c.bank_account IS NOT NULL AND TRIM(c.bank_account) <> ''
            AND COALESCE(c.deleted, 0) = 0
          ORDER BY c.name COLLATE NOCASE`
      )
      .all();
  } catch (e) {
    logger.error('[SEPAY] listCustomerBankAccounts error', { error: e.message });
    return [];
  }
}

/**
 * Đối soát LẠI toàn bộ giao dịch đang `manual`/`pending` bằng gạch nợ thông minh.
 *
 * Dùng khi vừa đăng ký số tài khoản cho khách → các giao dịch cũ đang chờ
 * sẽ được khớp & gạch nợ ngay.
 *
 * @returns {Promise<{scanned:number, settled:number, failed:number, details:Array}>}
 */
async function resmartMatchPending(opts = {}) {
  const result = { scanned: 0, settled: 0, failed: 0, details: [] };

  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT id FROM sepay_transactions
          WHERE status IN ('manual', 'pending')
            AND transfer_type = 'in'
            AND COALESCE(applied_amount, 0) = 0
          ORDER BY id`
      )
      .all();
  } catch (e) {
    logger.error('[SEPAY] resmartMatchPending scan error', { error: e.message });
    return result;
  }

  for (const row of rows) {
    result.scanned += 1;
    try {
      const tx = db.prepare('SELECT * FROM sepay_transactions WHERE id = ?').get(row.id);

      // Bổ sung sender_account/sender_name nếu giao dịch cũ chưa có.
      if (!tx.sender_account || !tx.sender_name) {
        const acc = extractSenderAccount(tx);
        const nm = extractSenderName(tx);
        if (acc || nm) {
          db.prepare(
            'UPDATE sepay_transactions SET sender_account = ?, sender_name = ? WHERE id = ?'
          ).run(acc || tx.sender_account, nm || tx.sender_name, tx.id);
          tx.sender_account = acc || tx.sender_account;
          tx.sender_name = nm || tx.sender_name;
        }
      }

      const out = processTransaction(tx.id, { user: opts.user, force: true });
      if (out.success) {
        result.settled += 1;
        result.details.push({
          id: tx.id,
          customerId: out.customerId,
          method: out.matchMethod || null,
          ok: true,
        });
      } else {
        result.failed += 1;
        result.details.push({
          id: tx.id,
          code: out.code || null,
          ok: false,
        });
      }
    } catch (e) {
      result.failed += 1;
      logger.error('[SEPAY] resmartMatchPending item error', {
        id: row.id,
        error: e.message,
      });
    }
  }

  logger.info('[SEPAY] resmartMatchPending done', {
    scanned: result.scanned,
    settled: result.settled,
    failed: result.failed,
  });

  return result;
}

module.exports = {
  TX_STATUS,
  SEPAY_API_BASE,
  getSettings,
  saveSettings,
  normalizeCode,
  normalizeWithSeparators,
  matchDebtCodeIn,
  extractDebtCode,
  repairDebtCodes,
  findCustomerByDebtCode,
  generateDebtCode,
  ensureCustomerDebtCode,
  setCustomerDebtCode,
  // ── Gạch nợ thông minh ──────────────────────────────────────────────
  normalizeAccount,
  normalizeName,
  getSetting,
  setSetting,
  extractSenderAccount,
  extractSenderName,
  findCustomerByBankAccount,
  findCustomersByName,
  findCustomersByAmount,
  smartMatchCustomer,
  setCustomerBankAccount,
  clearCustomerBankAccount,
  listCustomerBankAccounts,
  resmartMatchPending,
  verifyWebhookSignature,
  storeTransaction,
  processTransaction,
  handleWebhook,
  fetchTransactions,
  normalizeApiTransaction,
  reconcile,
  autoReconcile,
  listTransactions,
  getSummary,
  assignCustomerAndSettle,
  ignoreTransaction,
  buildTransferContent,
  sepayBusinessDate,
};
