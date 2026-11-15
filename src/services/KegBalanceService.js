/**
 * Keg Balance Service — Quản lý số vỏ rỗng (CHO PHÉP ÂM)
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH NGHIỆP VỤ
 *
 *   Ô "Rỗng" trên dashboard = `keg_stats.empty_collected`.
 *   VỎ RỖNG là vỏ ĐÃ THU VỀ nhưng CHƯA NẠP LẠI được (chưa đổi/mua mới).
 *
 *   Trước đây số này BỊ CẮT CHẶN ở 0 (Math.max(0, ...)) → sai sổ sách.
 *
 *   Ví dụ đúng theo thực tế:
 *     • Tôi có 500 vỏ rỗng trong kho.
 *     • Tôi đi lấy 1000 vỏ BIA ĐẦY về → dùng 500 vỏ rỗng để đổi,
 *       còn 500 vỏ đã lấy về nhưng CHƯA ĐƯỢC ĐỔI (tạm ứng trước nhà máy).
 *     • → Số vỏ rỗng thực tế = 500 - 1000 = **-500** (đang NỢ nhà máy 500 vỏ).
 *
 *   Vì sao được phép âm:
 *     • Số âm = "vỏ tạm ứng" (đã lấy vỏ đầy về nhưng chưa thu được vỏ rỗng từ khách).
 *     • Khi khách trả vỏ rỗng (màn "Thu vỏ") → mỗi vỏ thu về BÙ 1 đơn vị
 *       vào số âm → số âm tiến dần về 0.
 *     • Khi mua/nhập vỏ mới → tăng lên (về 0 hoặc dương).
 *
 * QUY TẮC BÙ (theo quyết định nghiệp vụ):
 *   • Thu vỏ rỗng từ KHÁCH  → bù được vào số âm (mỗi vỏ +1).
 *   • Nhập/mua vỏ mới       → tăng số (về 0 hoặc dương).
 *   • Bán vỏ rỗng / điều chỉnh tay → KHÔNG chặn (theo yêu cầu).
 *
 * ⚠️ LƯU Ý: số âm KHÔNG có nghĩa "mất vỏ" — đó là `keg_stats.lost`
 *    (vỏ thất lạc, mất). Hai khái niệm khác nhau, không được trộn.
 */

const db = require('../../database');

/**
 * Đọc số vỏ rỗng hiện tại (có thể âm).
 */
function getEmptyCollected() {
  try {
    const row = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
    return row?.empty_collected ?? 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Ghi số vỏ rỗng (cho phép âm).
 *
 * @param {number} newValue  Giá trị mới (có thể âm)
 * @returns {number}         Giá trị đã ghi
 */
function setEmptyCollected(newValue) {
  const safeValue = Math.floor(Number(newValue) || 0);
  db.prepare(
    'UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
  ).run(safeValue);
  return safeValue;
}

/**
 * Cộng/thêm một DELTA vào số vỏ rỗng (cho phép kết quả âm).
 *
 * @param {number} delta  Số lượng cộng (dương = tăng, âm = giảm)
 * @returns {number}     Số vỏ rỗng sau cập nhật
 */
function addEmptyCollected(delta) {
  const amount = Math.floor(Number(delta) || 0);
  const next = getEmptyCollected() + amount;
  return setEmptyCollected(next);
}

/**
 * Tính số vỏ rỗng MỚI sau khi áp dụng delta — KHÔNG ghi DB.
 *
 * Dùng khi cần biết trước giá trị để ghi log (empty_after).
 *
 * @param {number} delta
 * @returns {number}
 */
function peekEmptyCollected(delta) {
  return getEmptyCollected() + Math.floor(Number(delta) || 0);
}

module.exports = {
  getEmptyCollected,
  setEmptyCollected,
  addEmptyCollected,
  peekEmptyCollected,
};
