/**
 * Migration: Gạch nợ thông minh — nhận diện khách theo số tài khoản & tên (067)
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH (2026-11-23):
 *  Khách hàng chuyển khoản theo SỐ TÀI KHOẢN (nhận từ QR ngân hàng → nhập
 *  số tài khoản → hệ thống không có mã KH trong nội dung). Nội dung thực tế:
 *
 *    "NHAN TU 1988888779779 TRACE 104688 ND BUI TRUONG VAN chuyen tien"
 *    "NHAN TU 0671004149757 TRACE 836311 ND MBVCB.17123650534... KH0001.CT..."
 *
 *  Hệ thống cũ CHỈ tìm mã `KHxxxx` → không thấy → giao dịch rơi vào trạng
 *  thái `manual` → nhân viên phải gán khách TAY. Sai sót, chậm, tốn công.
 *
 * GIẢI PHÁP:
 *  1. LƯU SỐ TÀI KHOẢN NGÂN HÀNG của khách (`customers.bank_account`).
 *  2. TRÍCH số tài khoản + tên người gửi từ nội dung CK
 *     (`NHAN TU <số TK> ... ND <TÊN>`).
 *  3. KHỚP THÔNG MINH theo thứ tự độ tin cậy:
 *       1. Mã `KHxxxx` trong nội dung        (chắc chắn 100%)
 *       2. Số tài khoản người gửi khớp KH  (chắc chắn ~99%)
 *       3. Tên người gửi khớp KH           (khá chắc ~85%)
 *       4. Số tiền khớp đúng nợ của 1 KH  (suy đoán — cần xác nhận)
 *
 *  Mỗi lần khớp đều ghi lại `match_method` + `match_confidence` để nhân viên
 *  kiểm tra được, và CÓ THỂ TỪ CHỐI khớp yếu (confidence < ngưỡng) → đưa
 *  vào hàng chờ xử lý tay.
 *
 * ADDITIVE — chỉ thêm cột (NULL mặc định → đọc được nhờ fallback).
 * Rollback: chỉ gỡ cột, không đụng dữ liệu kinh doanh.
 */

const migration = {
  id: 67,
  name: 'sepay_smart_matching',

  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
    const txCols = db.prepare('PRAGMA table_info(sepay_transactions)').all().map((c) => c.name);

    // ── 1. customers.bank_account — số tài khoản NHẬN tiền của khách ──────
    //    VD: "1988888779779" (khớp với "NHAN TU 1988888779779" trong nội dung CK).
    if (!cols.includes('bank_account')) {
      db.exec(`ALTER TABLE customers ADD COLUMN bank_account TEXT`);
    }

    // ── 1b. customers.bank_account_name — tên chủ tài khoản (tùy chọn) ─────
    //    Dùng để tăng độ tin cậy khi khớp theo tên.
    if (!cols.includes('bank_account_name')) {
      db.exec(`ALTER TABLE customers ADD COLUMN bank_account_name TEXT`);
    }

    // Index tra cứu nhanh theo số tài khoản (không unique — số TK có thể
    // được dùng bởi nhiều khách cùng quầy, VD "1988888779779" là ví).
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_customers_bank_account ON customers(bank_account)`
    );

    // ── 2. sepay_transactions — thông tin người gửi + cách khớp ───────────
    const addTxColumn = (name, ddl) => {
      if (txCols.includes(name)) return;
      db.exec(`ALTER TABLE sepay_transactions ADD COLUMN ${name} ${ddl}`);
    };

    // Số tài khoản người gửi (trích từ nội dung "NHAN TU <số TK>")
    addTxColumn('sender_account', 'TEXT');
    // Tên người gửi (trích từ "ND <TÊN>")
    addTxColumn('sender_name', 'TEXT');
    // Cách đã khớp khách: debt_code | bank_account | name | amount | manual
    addTxColumn('match_method', 'TEXT');
    // Độ tin cậy 0..1 của cách khớp
    addTxColumn('match_confidence', 'REAL');
    // Danh sách ứng viên khớp (JSON) khi không khớp chắc chắn
    addTxColumn('match_candidates', 'TEXT');

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sepay_tx_sender_account ON sepay_transactions(sender_account)`
    );

    // ── 3. Cấu hình ngưỡng khớp thông minh ────────────────────────────────
    //    Lưu trong bảng `settings` (key-value) để admin chỉnh được.
    const insertSetting = db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    // Ngưỡng tin cậy tối thiểu để gạch nợ TỰ ĐỘNG (0..1).
    // 0.90 = chỉ khớp "chắc chắn" (mã KH / số tài khoản) mới tự gạch.
    insertSetting.run('sepay_smart_min_confidence', '0.9');
    // Bật/tắt gạch nợ thông minh.
    insertSetting.run('sepay_smart_match_enabled', '1');
    // Cho phép khớp theo TÊN khi không có số tài khoản khớp.
    insertSetting.run('sepay_smart_match_by_name', '1');
    // Cho phép khớp theo SỐ TIỀN (suy đoán) — mặc định TẮT (rủi ro cao).
    insertSetting.run('sepay_smart_match_by_amount', '0');
  },

  down: (db) => {
    const dropIfExists = (table, col) => {
      try {
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
      } catch (_) {
        /* rollback best-effort */
      }
    };

    dropIfExists('sepay_transactions', 'match_candidates');
    dropIfExists('sepay_transactions', 'match_confidence');
    dropIfExists('sepay_transactions', 'match_method');
    dropIfExists('sepay_transactions', 'sender_name');
    dropIfExists('sepay_transactions', 'sender_account');

    dropIfExists('customers', 'bank_account_name');
    dropIfExists('customers', 'bank_account');

    try {
      db.exec('DROP INDEX IF EXISTS idx_customers_bank_account');
      db.exec('DROP INDEX IF EXISTS idx_sepay_tx_sender_account');
    } catch (_) {
      /* ignore */
    }

    try {
      db.prepare('DELETE FROM settings WHERE key = ?').run('sepay_smart_min_confidence');
      db.prepare('DELETE FROM settings WHERE key = ?').run('sepay_smart_match_enabled');
      db.prepare('DELETE FROM settings WHERE key = ?').run('sepay_smart_match_by_name');
      db.prepare('DELETE FROM settings WHERE key = ?').run('sepay_smart_match_by_amount');
    } catch (_) {
      /* ignore */
    }
  },
};

module.exports = migration;
