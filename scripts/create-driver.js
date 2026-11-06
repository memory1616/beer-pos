#!/usr/bin/env node
/**
 * scripts/create-driver.js — Quản lý tài khoản tài xế (Driver Portal)
 * ─────────────────────────────────────────────────────────────────────────────
 * Dùng:
 *   node scripts/create-driver.js list
 *   node scripts/create-driver.js create <username> <password> [tên đầy đủ] [SĐT]
 *   node scripts/create-driver.js reset-password <username> <password>
 *   node scripts/create-driver.js disable <username>
 *   node scripts/create-driver.js enable <username>
 *   node scripts/create-driver.js info <username>
 *
 * Mật khẩu luôn được hash bằng scrypt — KHÔNG lưu plaintext.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const UserService = require('../src/services/UserService');
const { ROLE_ADMIN, ROLE_DRIVER } = require('../src/services/UserService');

function printUsage() {
  console.log(`
=== Quản lý tài khoản tài xế (Driver Portal) ===

  node scripts/create-driver.js list
  node scripts/create-driver.js create <username> <password> [fullName] [phone]
  node scripts/create-driver.js reset-password <username> <password>
  node scripts/create-driver.js disable <username>
  node scripts/create-driver.js enable <username>
  node scripts/create-driver.js info <username>

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

function cmdCreate(args) {
  const [username, password, fullName, phone] = args;
  if (!username || !password) {
    console.error('Thieu tham so. Cu phap: create <username> <password> [fullName] [phone]');
    process.exit(1);
  }

  const result = UserService.create({
    username,
    password,
    role: ROLE_DRIVER,
    fullName: fullName || null,
    phone: phone || null,
  });

  if (!result.success) {
    console.error('LOI:', result.error);
    process.exit(1);
  }
  console.log(`\nDa tao tai khoan tai xet "${username}" (ID ${result.id}).`);
  console.log('  Dang nhap tai: https://giaohang.biatuoitayninh.store/auth/driver\n');
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

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'list': cmdList(); break;
    case 'create': cmdCreate(args); break;
    case 'reset-password': cmdResetPassword(args); break;
    case 'disable': cmdToggle(args, false); break;
    case 'enable': cmdToggle(args, true); break;
    case 'info': cmdInfo(args); break;
    default: printUsage();
  }
}

main();
process.exit(0);
