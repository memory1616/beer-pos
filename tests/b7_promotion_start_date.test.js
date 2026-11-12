/**
 * B7 — Tính ngày bắt đầu chương trình khuyến mãi "quán mới" theo ngày tạo khách.
 *
 * Quy tắc: nếu khách được tạo từ ngày 1 → 8 tháng đó thì chương trình bắt đầu
 * ngay ngày tạo; nếu tạo từ ngày 9 trở đi thì bắt đầu từ ngày 1 của tháng sau.
 */
process.env.TZ = 'Asia/Ho_Chi_Minh';

function getPromotionStartDate(customer) {
  if (!customer || !customer.created_at) return null;

  const created = new Date(customer.created_at);
  const day = created.getDate();

  if (day <= 8) {
    const y = created.getFullYear();
    const m = String(created.getMonth() + 1).padStart(2, '0');
    const d = String(created.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  } else {
    const nextMonth = new Date(created.getFullYear(), created.getMonth() + 1, 1);
    const y = nextMonth.getFullYear();
    const m = String(nextMonth.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
  }
}

describe('B7 — ngày bắt đầu khuyến mãi quán mới', () => {
  const cases = [
    ['2026-08-31 00:00', '2026-09-01', 'Ngày 31 tháng 8 -> start = 1/9'],
    ['2026-12-31 00:00', '2027-01-01', 'Ngày 31 tháng 12 -> start = 1/1 năm sau (rollover)'],
    ['2026-07-31 00:00', '2026-08-01', 'Ngày 31 tháng 7 -> start = 1/8'],
    ['2026-04-30 00:00', '2026-05-01', 'Ngày 30 tháng 4 -> start = 1/5'],
    ['2026-06-09 00:00', '2026-07-01', 'Ngày 9 tháng 6 -> start = 1/7'],
    ['2026-07-01 00:00', '2026-07-01', 'Ngày 1 tháng 7 (day <= 8) -> start = 1/7'],
    ['2026-07-08 00:00', '2026-07-08', 'Ngày 8 tháng 7 (day <= 8) -> start = 8/7'],
    ['2026-07-09 00:00', '2026-08-01', 'Ngày 9 tháng 7 -> start = 1/8'],
  ];

  test.each(cases)('created=%s -> %s (%s)', (created, expected) => {
    expect(getPromotionStartDate({ created_at: created })).toBe(expected);
  });

  test('không có created_at -> null', () => {
    expect(getPromotionStartDate({})).toBeNull();
    expect(getPromotionStartDate(null)).toBeNull();
  });
});
