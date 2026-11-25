/**
 * B7 — Quy tắc "THÁNG MỞ QUÁN" (đơn giản hoá 2026-11-22)
 * ─────────────────────────────────────────────────────────────────────────────
 * QUY TẮC CŨ (đã bỏ):
 *   Khách tạo ngày 1-8  → bắt đầu từ ngày tạo
 *   Khách tạo ngày 9+   → bắt đầu từ ngày 1 tháng sau
 *
 * QUY TẮC MỚI:
 *   "Quán mới" = THÁNG MỞ quán = tháng có `created_at`.
 *   KHÔNG cần biết mở ngày nào trong tháng.
 *   Ngày bắt đầu = ngày 01 của tháng mở quán.
 */
process.env.TZ = 'Asia/Ho_Chi_Minh';

function getPromotionStartDate(customer) {
  if (!customer || !customer.created_at) return null;
  const created = new Date(customer.created_at);
  const y = created.getFullYear();
  const m = String(created.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/** Tháng mở quán (year, month) của khách. */
function getOpenMonth(customer) {
  if (!customer || !customer.created_at) return null;
  const created = new Date(customer.created_at);
  return {
    year: created.getFullYear(),
    month: created.getMonth() + 1
  };
}

/** Khách có đang ở THÁNG MỞ QUÁN không (target month = tháng hiện tại). */
function isOpenMonth(customer, targetMonth, targetYear) {
  const open = getOpenMonth(customer);
  if (!open) return false;
  return open.month === targetMonth && open.year === targetYear;
}

describe('B7 — ngày bắt đầu KM quán mới (THÁNG MỞ QUÁN)', () => {
  const cases = [
    ['2026-08-31 00:00', '2026-08-01', 'Ngày 31 tháng 8 -> start = 1/8 (tháng mở)'],
    ['2026-12-31 00:00', '2026-12-01', 'Ngày 31 tháng 12 -> start = 1/12'],
    ['2026-07-31 00:00', '2026-07-01', 'Ngày 31 tháng 7 -> start = 1/7'],
    ['2026-04-30 00:00', '2026-04-01', 'Ngày 30 tháng 4 -> start = 1/4'],
    ['2026-06-09 00:00', '2026-06-01', 'Ngày 9 tháng 6 -> start = 1/6 (KHÔNG còn lùi sang 7)'],
    ['2026-07-01 00:00', '2026-07-01', 'Ngày 1 tháng 7 -> start = 1/7'],
    ['2026-07-08 00:00', '2026-07-01', 'Ngày 8 tháng 7 -> start = 1/7'],
    ['2026-07-09 00:00', '2026-07-01', 'Ngày 9 tháng 7 -> start = 1/7'],
    ['2026-07-25 00:00', '2026-07-01', 'Ngày 25 tháng 7 -> start = 1/7'],
  ];

  test.each(cases)('created=%s -> %s (%s)', (created, expected) => {
    expect(getPromotionStartDate({ created_at: created })).toBe(expected);
  });

  test('không có created_at -> null', () => {
    expect(getPromotionStartDate({})).toBeNull();
    expect(getPromotionStartDate(null)).toBeNull();
  });
});

describe('B7 — tháng mở quán (không phụ thuộc ngày nào)', () => {
  test('mọi ngày trong cùng tháng → cùng tháng mở', () => {
    const days = [1, 5, 8, 9, 15, 20, 28, 30, 31];
    days.forEach((d) => {
      const c = { created_at: `2026-07-${String(d).padStart(2, '0')} 10:00` };
      expect(getOpenMonth(c)).toEqual({ year: 2026, month: 7 });
      expect(isOpenMonth(c, 7, 2026)).toBe(true);
    });
  });

  test('tháng sau → không phải tháng mở', () => {
    const c = { created_at: '2026-07-25 10:00' };
    expect(isOpenMonth(c, 8, 2026)).toBe(false);
    expect(isOpenMonth(c, 7, 2026)).toBe(true);
  });

  test('tháng trước → không phải tháng mở', () => {
    const c = { created_at: '2026-07-01 10:00' };
    expect(isOpenMonth(c, 6, 2026)).toBe(false);
  });

  test('cùng tháng nhưng khác năm → không phải tháng mở', () => {
    const c = { created_at: '2026-07-15 10:00' };
    expect(isOpenMonth(c, 7, 2027)).toBe(false);
  });

  test('không có created_at → không phải tháng mở', () => {
    expect(isOpenMonth({}, 7, 2026)).toBe(false);
    expect(isOpenMonth(null, 7, 2026)).toBe(false);
  });
});
