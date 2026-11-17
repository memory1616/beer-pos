/**
 * Chạy đối soát SỔ CÔNG NỢ chính thức (DebtReconciliationService) — dry-run.
 */
process.env.DISABLE_BACKGROUND_JOBS = '1';

const DebtReconciliationService = require('../../src/services/debt/DebtReconciliationService');

const report = DebtReconciliationService.run({ apply: false, actor: 'system' });

console.log('\n=== ĐỐI SOÁT SỔ CÔNG NỢ ===');
console.table(report.summary);
console.log('Lỗi phát hiện:');
if (!report.issues.length) console.log('  (không có)');
for (const issue of report.issues) {
  console.log(`  [${issue.severity}] ${issue.type} — ${issue.message}`);
}

process.exit(report.summary.critical > 0 ? 1 : 0);
