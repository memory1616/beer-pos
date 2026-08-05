// Set timezone trước khi tạo Date
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

const cases = [
  ['2026-08-31 00:00', '2026-09-01', 'Ngay 31 thang 8 -> start = 1/9'],
  ['2026-12-31 00:00', '2027-01-01', 'Ngay 31 thang 12 -> start = 1/1 nam sau (rollover)'],
  ['2026-07-31 00:00', '2026-08-01', 'Ngay 31 thang 7 -> start = 1/8'],
  ['2026-04-30 00:00', '2026-05-01', 'Ngay 30 thang 4 -> start = 1/5'],
  ['2026-06-09 00:00', '2026-07-01', 'Ngay 9 thang 6 -> start = 1/7'],
  ['2026-07-01 00:00', '2026-07-01', 'Ngay 1 thang 7 (day <= 8) -> start = 1/7'],
  ['2026-07-08 00:00', '2026-07-08', 'Ngay 8 thang 7 (day <= 8) -> start = 8/7'],
  ['2026-07-09 00:00', '2026-08-01', 'Ngay 9 thang 7 -> start = 1/8'],
];

let passed = 0, failed = 0;

for (const [created, expected, desc] of cases) {
  const result = getPromotionStartDate({ created_at: created });
  const ok = result === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${desc} | created=${created} got=${result} expected=${expected}`);
  if (ok) passed++; else failed++;
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
