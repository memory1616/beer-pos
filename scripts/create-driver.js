#!/usr/bin/env node
/**
 * scripts/create-driver.js — Quản lý tài khoản tài xế (Driver Portal)
 * ─────────────────────────────────────────────────────────────────────────────
 * Dùng:
 *   node scripts/create-driver.js list
 *   node scripts/create-driver.js create <username> <password> [tên đầy đủ] [SĐT]
 *   node scripts/create-driver.js create-admin <username> <password> [tên đầy đủ] [SĐT]
 *   node scripts/create-driver.js reset-password <username> <password>
 *   node scripts/create-driver.js disable <username>
 *   node scripts/create-driver.js enable <username>
 *   node scripts/create-driver.js info <username>
 *
 *   ── Hồ sơ tài xế & lương ──
 *   node scripts/create-driver.js staff-list
 *   node scripts/create-driver.js staff-create <username> <password> [tên đầy đủ] [SĐT] [lương/tháng]
 *   node scripts/create-driver.js staff-salary <username> <YYYY> <MM> [lươngCơBản] [thưởng] [phạt]
 *   node scripts/create-driver.js staff-pay <username> <YYYY> <MM> [chưaTrả=1]
 *   node scripts/create-driver.js staff-info <username>
 *
 * Mật khẩu luôn được hash bằng scrypt — KHÔNG lưu plaintext.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const UserService = require('../src/services/UserService');
const { ROLE_ADMIN, ROLE_DRIVER } = require('../src/services/UserService');
const DriverStaffService = require('../src/services/DriverStaffService');

function printUsage() {
  console.log(`
=== Quản lý tài khoản tài xế (Driver Portal) ===

  node scripts/create-driver.js list
  node scripts/create-driver.js create <username> <password> [fullName] [phone]
  node scripts/create-driver.js create-admin <username> <password> [fullName] [phone]
  node scripts/create-driver.js reset-password <username> <password>
  node scripts/create-driver.js disable <username>
  node scripts/create-driver.js enable <username>
  node scripts/create-driver.js info <username>

  ── Hồ sơ tài xế & lương ──
  node scripts/create-driver.js staff-list
  node scripts/create-driver.js staff-create <username> <password> [fullName] [phone] [monthlySalary]
  node scripts/create-driver.js staff-salary <username> <YYYY> <MM> [baseSalary] [bonus] [deduction]
  node scripts/create-driver.js staff-pay <username> <YYYY> <MM> [unpaid=1]
  node scripts/create-driver.js staff-info <username>

Quyền:
  ADMIN  : toàn quyền (xem lợi nhuận, báo cáo tài chính, quản lý tài xế)
  DRIVER : bán hàng + giao hàng, KHÔNG xem giá vốn / lợi nhuận / báo cáo tài chính
`);
}

function cmdList() {
  const users = UserService.list();
  if (!users.length) {
    console.log('Chưa có tài khoản nào trong app_users.');
    return;
  }
  console.log('\nID   USERNAME        ROLE     ACTIVE  HO TEN');
  console.log('-'.repeat(60));
  users.forEach((u) => {
    console.log(
      String(u.id).padEnd(4) +
      String(u.username).padEnd(15) +
      String(u.role).padEnd(8) +
      String(u.active ? 'Co' : 'Khong').padEnd(8) +
      (u.full_name || '')
    );
  });
  console.log('');
}

function cmdCreate(args, role = ROLE_DRIVER) {
  const [username, password, fullName, phone] = args;
  if (!username || !password) {
    console.error('Thieu tham so. Cu phap: create <username> <password> [fullName] [phone]');
    process.exit(1);
  }

  const result = UserService.create({
    username,
    password,
    role,
    fullName: fullName || null,
    phone: phone || null,
  });

  if (!result.success) {
    console.error('LOI:', result.error);
    process.exit(1);
  }
  if (role === ROLE_ADMIN) {
    console.log(`\nDa tao tai khoan QUAN TRI "${username}" (ID ${result.id}).`);
    console.log('  Dang nhap tai: https://admin.biatuoitayninh.store/\n');
  } else {
    console.log(`\nDa tao tai khoan tai xet "${username}" (ID ${result.id}).`);
    console.log('  Dang nhap tai: https://giaohang.biatuoitayninh.store/auth/driver\n');
  }
}

function cmdResetPassword(args) {
  const [username, password] = args;
  if (!username || !password) {
    console.error('Thieu tham so. Cu phap: reset-password <username> <password>');
    process.exit(1);
  }
  const user = UserService.getByUsername(username);
  if (!user) {
    console.error(`Khong tim thay tai khoan "${username}".`);
    process.exit(1);
  }
  const result = UserService.changePassword(user.id, password, ROLE_ADMIN);
  if (!result.success) {
    console.error('LOI:', result.error);
    process.exit(1);
  }
  console.log(`\nDa doi mat khau cho "${username}".\n`);
}

function cmdToggle(args, active) {
  const [username] = args;
  if (!username) {
    console.error('Thieu ten dang nhap.');
    process.exit(1);
  }
  const user = UserService.getByUsername(username);
  if (!user) {
    console.error(`Khong tim thay tai khoan "${username}".`);
    process.exit(1);
  }
  const result = UserService.setActive(user.id, active);
  if (!result.success) {
    console.error('LOI:', result.error);
    process.exit(1);
  }
  console.log(`\nDa ${active ? 'mo khoa' : 'khoa'} tai khoan "${username}".\n`);
}

function cmdInfo(args) {
  const [username] = args;
  if (!username) {
    console.error('Thieu ten dang nhap.');
    process.exit(1);
  }
  const u = UserService.getByUsername(username);
  if (!u) {
    console.error(`Khong tim thay tai khoan "${username}".`);
    process.exit(1);
  }
  console.log('\n' + JSON.stringify(u, null, 2) + '\n');
}

function cmdStaffList() {
  const drivers = DriverStaffService.getAll({ includeInactive: true });
  if (!drivers.length) {
    console.log('Chưa có hồ sơ tài xế nào.');
    return;
  }
  console.log('\nID   USERNAME          HỌ TÊN                 LƯƠNG/THÁNG   ACTIVE');
  console.log('-'.repeat(78));
  drivers.forEach((d) => {
    console.log(
      String(d.id).padEnd(4) +
      String(d.username).padEnd(18) +
      String(d.full_name || '').padEnd(24) +
      String(Number(d.monthly_salary || 0).toLocaleString('vi-VN')).padEnd(15) +
      (d.active ? 'Co' : 'Khong')
    );
  });
  console.log('');
}

function cmdStaffCreate(args) {
  const [username, password, fullName, phone, monthlySalary] = args;
  if (!username || !password) {
    console.error('Thieu tham so. Cu phap: staff-create <username> <password> [fullName] [phone] [monthlySalary]');
    process.exit(1);
  }
  const result = DriverStaffService.create({
    username,
    password,
    fullName: fullName || null,
    phone: phone || null,
    monthlySalary: Number(monthlySalary) || 0,
  });
  if (!result.success) {
    console.error('LOI:', result.error);
    process.exit(1);
  }
  console.log(`\nDa tao ho so tai xet "${username}" (ID ${result.id}).`);
  console.log(`  Tai khoan dang nhap: ${result.accountCreated ? 'da tao moi' : 'da ton tai'}`);
  console.log('  Dang nhap tai: https://giaohang.biatuoitayninh.store/auth/driver\n');
}

function cmdStaffSalary(args) {
  const [username, year, month, baseSalary, bonus, deduction] = args;
  if (!username || !year || !month) {
    console.error('Thieu tham so. Cu phap: staff-salary <username> <YYYY> <MM> [baseSalary] [bonus] [deduction]');
    process.exit(1);
  }
  const driver = DriverStaffService.getByUsername(username);
  if (!driver) {
    console.error(`Khong tim thay ho so tai xet "${username}".`);
    process.exit(1);
  }
  const result = DriverStaffService.setMonthlySalary(
    driver.id,
    parseInt(year, 10),
    parseInt(month, 10),
    {
      baseSalary: baseSalary !== undefined ? Number(baseSalary) : undefined,
      bonus: bonus !== undefined ? Number(bonus) : undefined,
      deduction: deduction !== undefined ? Number(deduction) : undefined,
    }
  );
  if (!result.success) {
    console.error('LOI:', result.error);
    process.exit(1);
  }
  console.log(`\nDa luu luong thang ${month}/${year} cho "${username}".`);
  console.log(`  Tong luong: ${Number(result.total).toLocaleString('vi-VN')} đ\n`);
}

function cmdStaffPay(args) {
  const [username, year, month, unpaid] = args;
  if (!username || !year || !month) {
    console.error('Thieu tham so. Cu phap: staff-pay <username> <YYYY> <MM> [unpaid=1]');
    process.exit(1);
  }
  const driver = DriverStaffService.getByUsername(username);
  if (!driver) {
    console.error(`Khong tim thay ho so tai xet "${username}".`);
    process.exit(1);
  }
  const paid = unpaid !== '1';
  const result = DriverStaffService.markSalaryPaid(
    driver.id,
    parseInt(year, 10),
    parseInt(month, 10),
    paid
  );
  if (!result.success) {
    console.error('LOI:', result.error);
    process.exit(1);
  }
  console.log(`\nLuong thang ${month}/${year} cua "${username}" → ${result.status}\n`);
}

function cmdStaffInfo(args) {
  const [username] = args;
  if (!username) {
    console.error('Thieu ten dang nhap.');
    process.exit(1);
  }
  const driver = DriverStaffService.getByUsername(username);
  if (!driver) {
    console.error(`Khong tim thay ho so tai xet "${username}".`);
    process.exit(1);
  }
  console.log('\n' + JSON.stringify(driver, null, 2) + '\n');
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'list': cmdList(); break;
    case 'create': cmdCreate(args); break;
    case 'create-admin': cmdCreate(args, ROLE_ADMIN); break;
    case 'reset-password': cmdResetPassword(args); break;
    case 'disable': cmdToggle(args, false); break;
    case 'enable': cmdToggle(args, true); break;
    case 'info': cmdInfo(args); break;
    case 'staff-list': cmdStaffList(); break;
    case 'staff-create': cmdStaffCreate(args); break;
    case 'staff-salary': cmdStaffSalary(args); break;
    case 'staff-pay': cmdStaffPay(args); break;
    case 'staff-info': cmdStaffInfo(args); break;
    default: printUsage();
  }
}

main();
process.exit(0);
