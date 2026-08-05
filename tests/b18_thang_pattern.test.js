// Test B18 với nhiều năm
function makeRx(year) {
  return new RegExp("tháng\\s+(\\d{1,2})/(" + year + ")(?!\\d)");
}

const cases = [
  // [note, year, targetMonth, shouldMatch, description]
  ['Tra thuong san luong tháng 7/2026 - khach A', 2026, 7, true,  'Thang 7/2026'],
  ['Tra thuong san luong tháng 11/2026 - khach A', 2026, 1, false, 'Thang 11/2026 KHONG phai thang 1'],
  ['Tra thuong san luong tháng 1/2026 - khach A', 2026, 1, true,  'Thang 1/2026 LA thang 1'],
  ['Tra thuong san luong tháng 12/2026 - khach A', 2026, 12, true,  'Thang 12/2026'],
  ['Tra thuong san luong tháng 1/2026 - khach A', 2027, 1, false, 'Year khac'],
  ['Thuong doanh so tháng 8/2026 - 20L', 2026, 8, true,  'Pattern thuong doanh so'],
  ['Tra thuong san luong tháng 11/2026', 2026, 11, true,  'Thang 11/2026 la thang 11'],
  ['Tra thuong san luong tháng 1/20260/2026', 2026, 1, false, 'Followed by another digit (fake boundary)'],
];

let passed = 0, failed = 0;
for (const [note, year, targetMonth, shouldMatch, desc] of cases) {
  const rx = makeRx(year);
  const m = note.match(rx);
  const matched = m ? (parseInt(m[1], 10) === targetMonth) : false;
  const ok = !!matched === !!shouldMatch;
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + desc);
  if (ok) passed++; else failed++;
}

console.log('\n=== RESULT: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
