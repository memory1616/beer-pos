/**
 * B18 — Regex nhận diện kỳ thưởng theo tháng/năm trong ghi chú thưởng doanh số.
 *
 * Bảo đảm pattern "tháng M/YYYY" không bị khớp nhầm sang tháng khác
 * (ví dụ "tháng 11/2026" KHÔNG phải tháng 1) và không khớp khi năm khác.
 */
function makeRx(year) {
  return new RegExp('tháng\\s+(\\d{1,2})/(' + year + ')(?!\\d)');
}

describe('B18 — pattern thưởng theo tháng/năm', () => {
  const cases = [
    ['Tra thuong san luong tháng 7/2026 - khach A', 2026, 7, true, 'Tháng 7/2026'],
    ['Tra thuong san luong tháng 11/2026 - khach A', 2026, 1, false, 'Tháng 11/2026 KHÔNG phải tháng 1'],
    ['Tra thuong san luong tháng 1/2026 - khach A', 2026, 1, true, 'Tháng 1/2026 LÀ tháng 1'],
    ['Tra thuong san luong tháng 12/2026 - khach A', 2026, 12, true, 'Tháng 12/2026'],
    ['Tra thuong san luong tháng 1/2026 - khach A', 2027, 1, false, 'Năm khác'],
    ['Thuong doanh so tháng 8/2026 - 20L', 2026, 8, true, 'Pattern thưởng doanh số'],
    ['Tra thuong san luong tháng 11/2026', 2026, 11, true, 'Tháng 11/2026 là tháng 11'],
    ['Tra thuong san luong tháng 1/20260/2026', 2026, 1, false, 'Followed by another digit (fake boundary)'],
  ];

  test.each(cases)('%s (year=%i, month=%i) -> match=%s', (note, year, targetMonth, shouldMatch) => {
    const rx = makeRx(year);
    const m = note.match(rx);
    const matched = m ? parseInt(m[1], 10) === targetMonth : false;
    expect(!!matched).toBe(!!shouldMatch);
  });
});
