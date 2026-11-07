/**
 * Smoke test cho module Quản lý Tài xế & Lương (044)
 * Chạy: node scripts/test-driver-staff.js
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const path = require('path');
const db = require('../database');
const DriverStaffService = require('../src/services/DriverStaffService');

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? ' → ' + JSON.stringify(extra) : ''));
  }
}

console.log('\n=== 1. Migration 044 ===');
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'driver_%'")
  .all()
  .map((t) => t.name);
ok('driver_staff tồn tại', tables.includes('driver_staff'), tables);
ok('driver_monthly_salary tồn tại', tables.includes('driver_monthly_salary'), tables);

console.log('\n=== 2. Tạo tài xế + tài khoản đăng nhập ===');
const uname = 'test_drv_' + Date.now().toString().slice(-6);
const created = DriverStaffService.create({
  username: uname,
  password: 'Passw0rd!2026',
  fullName: 'Nguyễn Test Tài Xế',
  phone: '0900111222',
  monthlySalary: 5000000,
});
ok('tạo tài xế thành công', created.success, created);
ok('tài khoản đăng nhập được tạo', created.accountCreated === true, created);

const userRow = db.prepare('SELECT id, role, active FROM app_users WHERE username = ?').get(uname);
ok('app_users có role=DRIVER', userRow && userRow.role === 'DRIVER', userRow);
ok('app_users active=1', userRow && userRow.active === 1, userRow);

const profile = DriverStaffService.getByUsername(uname);
ok('hồ sơ tài xế tồn tại', !!profile, profile);
ok('lương cố định lưu đúng', profile && profile.monthly_salary === 5000000, profile);
ok('app_user_id liên kết đúng', profile && profile.app_user_id === userRow.id, profile);

console.log('\n=== 3. Không trả password_hash ===');
const listed = DriverStaffService.getAll();
const found = listed.find((d) => d.username === uname);
ok('danh sách không có password_hash', found && !('password_hash' in found), Object.keys(found || {}));

console.log('\n=== 4. Trùng username bị chặn ===');
const dup = DriverStaffService.create({ username: uname, password: 'Passw0rd!2026' });
ok('trùng username → lỗi', dup.success === false, dup);

console.log('\n=== 5. Lương tháng ===');
const year = new Date().getFullYear();
const month = new Date().getMonth() + 1;

const draft = DriverStaffService.getMonthlySalary(profile.id, year, month);
ok('chưa có bản ghi → trả draft theo lương cố định', draft.isDraft === true && draft.base_salary === 5000000, draft);

const set = DriverStaffService.setMonthlySalary(profile.id, year, month, {
  baseSalary: 5000000,
  bonus: 1000000,
  deduction: 200000,
  note: 'Thưởng tháng tốt',
});
ok('thiết lập lương thành công', set.success, set);

const rec = DriverStaffService.getMonthlySalary(profile.id, year, month);
ok('total = base + bonus - deduction', rec.total === 5800000, rec);
ok('bản ghi đã lưu (không còn draft)', !rec.isDraft, rec);
ok('trạng thái mặc định = pending', rec.status === 'pending', rec);

const updated = DriverStaffService.setMonthlySalary(profile.id, year, month, { bonus: 1500000 });
ok('cập nhật lại giữ base', updated.success, updated);
const rec2 = DriverStaffService.getMonthlySalary(profile.id, year, month);
ok('total cập nhật = 6300000', rec2.total === 6300000, rec2);
ok('cập nhật một phần giữ deduction', rec2.deduction === 200000, rec2);
ok('cập nhật một phần giữ bonus cũ khi không truyền', rec2.bonus === 1500000, rec2);

console.log('\n=== 6. Đánh dấu đã trả ===');
const paid = DriverStaffService.markSalaryPaid(profile.id, year, month, true);
ok('đánh dấu đã trả', paid.success && paid.status === 'paid', paid);
const rec3 = DriverStaffService.getMonthlySalary(profile.id, year, month);
ok('status = paid', rec3.status === 'paid', rec3);
ok('paid_at được ghi', !!rec3.paid_at, rec3);

console.log('\n=== 7. Tổng hợp tháng ===');
const summary = DriverStaffService.getMonthlySalarySummary(year, month);
const row = summary.find((s) => s.driverId === profile.id);
ok('summary có tài xế', !!row, row);
ok('summary.total khớp', row && row.total === 6300000, row);
ok('summary có username', row && row.username === uname, row);

console.log('\n=== 8. Lịch sử lương ===');
const history = DriverStaffService.getSalaryHistory(profile.id);
ok('lịch sử có 1 bản ghi', history.length === 1, history);

console.log('\n=== 9. Khoá tài xế → khoá tài khoản + xoá session ===');
const removed = DriverStaffService.remove(profile.id);
ok('khoá thành công', removed.success, removed);
const afterRemove = DriverStaffService.getById(profile.id);
ok('driver_staff.active = 0', afterRemove.active === 0, afterRemove);
const userAfter = db.prepare('SELECT active FROM app_users WHERE username = ?').get(uname);
ok('app_users.active = 0', userAfter.active === 0, userAfter);

console.log('\n=== 10. Cập nhật hồ sơ đồng bộ app_users ===');
const p2 = DriverStaffService.create({
  username: uname + 'b',
  password: 'Passw0rd!2026',
  fullName: 'Tên Mới',
  phone: '0900999888',
  monthlySalary: 4000000,
});
ok('tạo tài xế thứ 2', p2.success, p2);
const upd = DriverStaffService.update(p2.id, { fullName: 'Tên Đã Sửa', monthlySalary: 6000000 });
ok('update hồ sơ thành công', upd.success, upd);
const userAfterUpd = db.prepare('SELECT full_name FROM app_users WHERE username = ?').get(uname + 'b');
ok('app_users.full_name đồng bộ', userAfterUpd.full_name === 'Tên Đã Sửa', userAfterUpd);
const prof2 = DriverStaffService.getById(p2.id);
ok('monthly_salary cập nhật', prof2.monthly_salary === 6000000, prof2);

console.log('\n=== 11. Đổi mật khẩu ===');
const pw = DriverStaffService.update(p2.id, { password: 'NewPassw0rd!2026' });
ok('đổi mật khẩu thành công', pw.success, pw);
const { verifyPassword } = require('../src/utils/password');
const row2 = db.prepare('SELECT password_hash FROM app_users WHERE username = ?').get(uname + 'b');
ok('mật khẩu mới verify đúng', verifyPassword('NewPassw0rd!2026', row2.password_hash));
ok('mật khẩu cũ không còn đúng', !verifyPassword('Passw0rd!2026', row2.password_hash));

console.log('\n=== CLEANUP ===');
db.prepare('DELETE FROM driver_monthly_salary WHERE driver_id IN (SELECT id FROM driver_staff WHERE username LIKE ?)')
  .run(uname + '%');
db.prepare('DELETE FROM driver_staff WHERE username LIKE ?').run(uname + '%');
db.prepare('DELETE FROM app_users WHERE username LIKE ?').run(uname + '%');
console.log('  Đã dọn dữ liệu test');

console.log(`\n=== KẾT QUẢ: ${pass} pass / ${fail} fail ===\n`);
process.exit(fail > 0 ? 1 : 0);
