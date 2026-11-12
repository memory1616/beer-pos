/**
 * Jest setup for Beer POS tests
 *
 * QUAN TRỌNG: mỗi test file chạy trên một BẢN SAO của database.sqlite.
 * Trước đây test require('../database') → ghi thẳng vào DB thật, khiến
 * dữ liệu test lẫn vào dữ liệu vận hành (đơn giả, công nợ, keg tx...).
 * Nay mỗi file có DB riêng trong thư mục tạm → DB thật không bị ảnh hưởng.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Set test environment
process.env.NODE_ENV = 'test';

// Tắt các cron job nền (backup 2AM...) trong test: cron giữ event loop sống
// khiến `jest` không tự thoát sau khi chạy xong.
process.env.DISABLE_BACKGROUND_JOBS = '1';

// Increase timeout for database tests
jest.setTimeout(10000);

const SRC_DB = path.join(__dirname, '..', 'database.sqlite');

try {
  if (fs.existsSync(SRC_DB)) {
    fs.mkdirSync(path.join(os.tmpdir(), 'beer-tests'), { recursive: true });
    const testDb = path.join(
      os.tmpdir(),
      'beer-tests',
      `test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`
    );
    fs.copyFileSync(SRC_DB, testDb);
    // Xóa các file WAL/SHM đi kèm (nếu có) để tránh đọc dữ liệu chưa checkpoint
    for (const suffix of ['-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }
    }
    process.env.DB_PATH = testDb;
  } else {
    // Không có DB nguồn → để database.js tự tạo DB mới
    delete process.env.DB_PATH;
  }
} catch (e) {
  // Không set DB_PATH → test sẽ dùng DB thật (không lý tưởng nhưng không crash)
  console.warn('[jest setup] Không tạo được DB test riêng:', e.message);
}
