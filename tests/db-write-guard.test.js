/**
 * GUARD CHỐNG GHI NHẦM VÀO DB VẬN HÀNH (2026-11-27)
 * ─────────────────────────────────────────────────────────────────────────────
 * VẤN ĐỀ: khi test app, script trong `scripts/ops/` require thẳng `../database`
 * → nếu KHÔNG set `DB_PATH` → chạm vào `database.sqlite` THẬT → số liệu
 * vận hành bị thay đổi (đơn giả, công nợ, vỏ bình, khuyến mãi...).
 *
 * NGUYÊN TẮC: "KHÔNG được đụng đến dữ liệu chính."
 *
 * Kiểm tra:
 *  - Script GHI không có DB_PATH, không cờ → BỊ CHẶN (fail-closed).
 *  - Script GHI có `DB_PATH` trỏ bản sao → ĐƯỢC CHẠY.
 *  - `NODE_ENV=production` → CHẶN TUYỆT ĐỐI, cờ `--allow-prod-write` cũng vô dụng.
 *  - Cờ `--allow-prod-write` + quản lý → được vượt khoá (có log audit).
 *  - Script CHỈ ĐỌC → không chặn (đọc không làm hỏng dữ liệu).
 */

process.env.NODE_ENV = 'test';

const path = require('path');
const guard = require('../src/utils/dbWriteGuard');

describe('A. checkWriteAllowed — ma trận quyền ghi', () => {
  test('NODE_ENV=test → luôn được phép (test dùng DB bản sao)', () => {
    const res = guard.checkWriteAllowed({ env: { NODE_ENV: 'test' }, argv: [] });
    expect(res.allowed).toBe(true);
  });

  test('NODE_ENV=production → CHẶN, cờ --allow-prod-write cũng vô dụng', () => {
    const res = guard.checkWriteAllowed({
      env: { NODE_ENV: 'production' },
      argv: ['node', 'x.js', '--allow-prod-write'],
    });
    expect(res.allowed).toBe(false);
    expect(res.isProd).toBe(true);
    expect(res.reason).toMatch(/production/i);
  });

  test('Không DB_PATH + không cờ → CHẶN (mặc định mở DB vận hành)', () => {
    const res = guard.checkWriteAllowed({ env: {}, argv: [] });
    expect(res.allowed).toBe(false);
    expect(res.isProd).toBe(true);
    expect(res.reason).toMatch(/DB_PATH/);
  });

  test('DB_PATH trỏ bản sao → ĐƯỢC CHẠY', () => {
    const res = guard.checkWriteAllowed({
      env: { DB_PATH: path.join(require('os').tmpdir(), 'beer-tests', 'copy.sqlite') },
      argv: [],
    });
    expect(res.allowed).toBe(true);
    expect(res.isProd).toBe(false);
  });

  test('DB_PATH trỏ CHÍNH DB vận hành + không cờ → CHẶN', () => {
    const res = guard.checkWriteAllowed({
      env: { DB_PATH: guard.PROD_DB_PATH },
      argv: [],
    });
    expect(res.allowed).toBe(false);
    expect(res.isProd).toBe(true);
  });

  test('DB_PATH trỏ CHÍNH DB vận hành + cờ --allow-prod-write → ĐƯỢC (có audit)', () => {
    const res = guard.checkWriteAllowed({
      env: { DB_PATH: guard.PROD_DB_PATH },
      argv: ['node', 'x.js', '--allow-prod-write'],
    });
    expect(res.allowed).toBe(true);
    expect(res.forced).toBe(true);
    expect(res.isProd).toBe(true);
  });

  test('Không DB_PATH + cờ --allow-prod-write → ĐƯỢC (có audit)', () => {
    const res = guard.checkWriteAllowed({
      env: {},
      argv: ['node', 'x.js', '--allow-prod-write'],
    });
    expect(res.allowed).toBe(true);
    expect(res.forced).toBe(true);
  });
});

describe('B. requireSafeDb — hành vi throw', () => {
  test('GHI, không DB_PATH, không cờ → THROW với mã DB_WRITE_GUARD_BLOCKED', () => {
    expect(() =>
      guard.requireSafeDb({
        context: 'test script',
        allowWrite: true,
        env: {},
        argv: [],
      })
    ).toThrow(/BỊ CHẶN/);

    try {
      guard.requireSafeDb({ context: 'test script', allowWrite: true, env: {}, argv: [] });
    } catch (e) {
      expect(e.code).toBe('DB_WRITE_GUARD_BLOCKED');
    }
  });

  test('CHỈ ĐỌC (allowWrite: false) → KHÔNG throw dù không DB_PATH', () => {
    expect(() =>
      guard.requireSafeDb({
        context: 'read only',
        allowWrite: false,
        env: {},
        argv: [],
      })
    ).not.toThrow();
  });

  test('GHI, NODE_ENV=production → THROW', () => {
    expect(() =>
      guard.requireSafeDb({
        context: 'prod script',
        allowWrite: true,
        env: { NODE_ENV: 'production' },
        argv: ['--allow-prod-write'],
      })
    ).toThrow(/production/i);
  });

  test('GHI, DB_PATH bản sao → KHÔNG throw', () => {
    expect(() =>
      guard.requireSafeDb({
        context: 'safe script',
        allowWrite: true,
        env: { DB_PATH: path.join(require('os').tmpdir(), 'beer-tests', 'copy.sqlite') },
        argv: [],
      })
    ).not.toThrow();
  });

  test('Thông báo lỗi có hướng dẫn cách chạy an toàn', () => {
    try {
      guard.requireSafeDb({ context: 'ctx', allowWrite: true, env: {}, argv: [] });
      throw new Error('phải throw');
    } catch (e) {
      expect(e.message).toMatch(/DB_PATH/);
      expect(e.message).toMatch(/allow-prod-write/);
      expect(e.message).toMatch(/\[ctx\]/);
    }
  });
});

describe('C. assertDatabaseWritable — không làm app fail', () => {
  test('production → cho phép (app vận hành dùng DB thật)', () => {
    const res = guard.assertDatabaseWritable(guard.PROD_DB_PATH, {
      env: { NODE_ENV: 'production' },
    });
    expect(res.allowed).toBe(true);
  });

  test('test → cho phép (DB bản sao)', () => {
    const res = guard.assertDatabaseWritable('/tmp/x.sqlite', { env: { NODE_ENV: 'test' } });
    expect(res.allowed).toBe(true);
  });

  test('dev không DB_PATH → CẢNH BÁO nhưng không chặn', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = guard.assertDatabaseWritable(guard.PROD_DB_PATH, { env: {} });
    expect(res.allowed).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('dev có DB_PATH → cho phép, không cảnh báo', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    guard.assertDatabaseWritable('/tmp/x.sqlite', { env: { DB_PATH: '/tmp/x.sqlite' } });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('D. Script scripts/ops/ đã được gia cố', () => {
  const fs = require('fs');
  const opsDir = path.join(__dirname, '..', 'scripts', 'ops');

  const GUARDED = [
    'backfill-newshop-immediate-gift.js',
    'backfill-delivery-recon-lock.js',
    'backfill-delivery-expected-kegs.js',
    'sync_devices.js',
    'fix_device_customer.js',
    'inspect-promo-snapshot.js',
    'inspect-promo-snapshot2.js',
    'check-neg-stock.js',
    'check-order-1145.js',
    'verify-newshop-fix.js',
    'check-archived-audit.js',
    'check-reward-history.js',
    'check-delivery-recon-lock.js',
    'check_devices.js',
  ];

  test.each(GUARDED)('%s có gọi requireSafeDb TRƯỚC khi require database', (file) => {
    const full = path.join(opsDir, file);
    expect(fs.existsSync(full)).toBe(true);
    const src = fs.readFileSync(full, 'utf8');

    const guardIdx = src.indexOf('requireSafeDb');
    const dbIdx = src.search(/require\(\s*(?:['"](?:\.\.\/)+database['"]|path\.join\([^)]*database)/);

    expect(guardIdx).toBeGreaterThan(-1);
    expect(dbIdx).toBeGreaterThan(-1);
    // Guard PHẢI đứng trước require database
    expect(guardIdx).toBeLessThan(dbIdx);
  });

  test('guard.js tồn tại và export đúng API', () => {
    const g = require('../src/utils/dbWriteGuard');
    expect(typeof g.requireSafeDb).toBe('function');
    expect(typeof g.checkWriteAllowed).toBe('function');
    expect(typeof g.assertDatabaseWritable).toBe('function');
    expect(typeof g.copyProdDb).toBe('function');
    expect(g.ALLOW_PROD_FLAG).toBe('--allow-prod-write');
  });

  test('shim scripts/ops/guard.js trỏ đúng module thật', () => {
    const shim = require('../scripts/ops/guard');
    expect(shim).toBe(require('../src/utils/dbWriteGuard'));
  });

  test('module guard nằm trong src/utils (được deploy) — không phụ thuộc scripts/', () => {
    const fs = require('fs');
    const real = path.join(__dirname, '..', 'src', 'utils', 'dbWriteGuard.js');
    expect(fs.existsSync(real)).toBe(true);

    // database.js KHÔNG được require từ scripts/ (thư mục bị exclude khi deploy)
    const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'database.js'), 'utf8');
    expect(dbSrc).toContain("require('./src/utils/dbWriteGuard')");
    expect(dbSrc).not.toContain("require('./scripts/ops/guard')");
  });
});
