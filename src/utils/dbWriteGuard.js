/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GUARD CHỐNG GHI NHẦM LÊN DB VẬN HÀNH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * VẤN ĐỀ (2026-11-27):
 *   Khi test app, các script trong `scripts/ops/` require thẳng `../database`
 *   → nếu KHÔNG set `DB_PATH` → chạm vào `database.sqlite` THẬT → số liệu
 *   vận hành bị thay đổi (đơn giả, công nợ, vỏ bình, KM...).
 *
 *   Nguyên tắc: "KHÔNG được đụng đến dữ liệu chính."
 *
 * CÁCH DÙNG:
 *   1. Trong `database.js` — gọi `guard.assertDatabaseWritable()` NGAY SAU khi
 *      mở DB (trước khi chạy migration). Chặn cả việc MIGRATION vô tình ghi
 *      vào DB thật.
 *
 *   2. Trong script `scripts/ops/*.js` — gọi
 *      `require('../../src/utils/dbWriteGuard').requireSafeDb({...})` ở đầu file.
 *      Script ĐỌC (inspect/check) → `allowWrite: false` (mặc định an toàn).
 *
 *   3. Muốn thao tác CỐ Ý trên DB thật → phải truyền cờ CLI rõ ràng:
 *        node scripts/ops/xxx.js --allow-prod-write
 *      (giữ audit trail: script log ra console là đã "vượt khoá").
 *
 * NGUYÊN TẮC AN TOÀN (fail-closed):
 *   - Không có `DB_PATH` + không có cờ cho phép → CHẶN.
 *   - `NODE_ENV=production` → CHẶN tuyệt đối, KHÔNG cờ nào vượt được.
 *   - `DB_PATH` trỏ vào DB thật (resolve bằng DB vận hành) → CHẶN trừ khi
 *     có cờ `--allow-prod-write`.
 *
 * @module src/utils/dbWriteGuard
 */

const path = require('path');
const fs = require('fs');

// ROOT = thư mục gốc project (src/utils → ../..)
const ROOT = path.join(__dirname, '..', '..');

/** Đường dẫn DB vận hành (tương đối tới root project). */
const PROD_DB_PATH = path.join(ROOT, 'database.sqlite');

/** Cờ CLI cho phép ghi lên DB vận hành (có audit trail). */
const ALLOW_PROD_FLAG = '--allow-prod-write';

/**
 * Kiểm tra tiến trình có được phép ghi lên DB này không.
 *
 * @param {object} [opts]
 * @param {string} [opts.dbPath] - Đường dẫn DB đang dùng (mặc định: `DB_PATH` env)
 * @param {string[]} [opts.argv] - process.argv (để dò cờ CLI)
 * @param {string} [opts.env] - process.env
 * @returns {{ allowed: boolean, reason: string, isProd: boolean, dbPath: string|null, forced: boolean }}
 */
function checkWriteAllowed(opts = {}) {
  const env = opts.env || process.env;
  const argv = opts.argv || process.argv || [];
  const dbPath = opts.dbPath || env.DB_PATH || null;

  const forced = argv.includes(ALLOW_PROD_FLAG);
  const isTest = env.NODE_ENV === 'test';

  // ── 1. Test → luôn OK (test dùng DB bản sao) ──────────────────────────
  if (isTest) {
    return {
      allowed: true,
      reason: 'NODE_ENV=test — chạy trên DB bản sao',
      isProd: false,
      dbPath,
      forced,
    };
  }

  // ── 2. Production → CHẶN tuyệt đối ───────────────────────────────────
  if (env.NODE_ENV === 'production') {
    return {
      allowed: false,
      reason:
        'NODE_ENV=production — cấm ghi vào DB vận hành. ' +
        'Dùng DB_PATH trỏ tới bản sao, hoặc chạy ngoài môi trường production.',
      isProd: true,
      dbPath,
      forced,
    };
  }

  // ── 3. Có DB_PATH → OK (bản sao / DB test) ────────────────────────────
  if (dbPath) {
    const resolved = path.resolve(dbPath);
    const prodResolved = path.resolve(PROD_DB_PATH);
    const pointsToProd = resolved === prodResolved;

    if (pointsToProd && !forced) {
      return {
        allowed: false,
        reason:
          `DB_PATH đang trỏ vào DB VẬN HÀNH (${resolved}) — ` +
          `không được ghi trực tiếp. Nếu chắc chắn muốn, thêm cờ ${ALLOW_PROD_FLAG}.`,
        isProd: true,
        dbPath: resolved,
        forced,
      };
    }

    return {
      allowed: true,
      reason: pointsToProd
        ? `DB_PATH trỏ DB vận hành + cờ ${ALLOW_PROD_FLAG} (đã ghi audit)`
        : `DB_PATH trỏ DB phụ (${resolved})`,
      isProd: pointsToProd,
      dbPath: resolved,
      forced,
    };
  }

  // ── 4. Không có DB_PATH → mặc định sẽ mở DB vận hành → CHẶN ──────────
  if (!forced) {
    return {
      allowed: false,
      reason:
        'Không có DB_PATH — lệnh này sẽ mở database.sqlite vận hành. ' +
        `Đặt DB_PATH=<đường dẫn bản sao> để chạy an toàn, hoặc thêm cờ ${ALLOW_PROD_FLAG}.`,
      isProd: true,
      dbPath: null,
      forced,
    };
  }

  return {
    allowed: true,
    reason: `Không có DB_PATH nhưng có cờ ${ALLOW_PROD_FLAG} (đã ghi audit)`,
    isProd: true,
    dbPath: path.resolve(PROD_DB_PATH),
    forced,
  };
}

/**
 * Chặn (throw) nếu không được phép ghi.
 *
 * @param {object} [opts]
 * @param {string} [opts.context] - Mô tả ngữ cảnh để hiển thị trong lỗi
 * @param {boolean} [opts.allowWrite] - false = chỉ đọc (mặc định: chỉ đọc)
 * @param {string[]} [opts.argv]
 * @param {string} [opts.env]
 * @throws {Error} nếu không được phép ghi
 */
function requireSafeDb(opts = {}) {
  const env = opts.env || process.env;
  const isTest = env.NODE_ENV === 'test';

  // ── Script CHỈ ĐỌC: cho phép mở DB thật (đọc không làm hỏng dữ liệu) ──
  if (opts.allowWrite === false && !isTest) {
    return {
      readOnly: true,
      ...checkWriteAllowed({ ...opts, argv: [] }),
    };
  }

  const check = checkWriteAllowed(opts);
  if (!check.allowed) {
    const ctx = opts.context ? `[${opts.context}] ` : '';
    const err = new Error(
      `${ctx}BỊ CHẶN — không được ghi vào DB vận hành.\n` +
      `  Lý do: ${check.reason}\n` +
      `  Cách an toàn:\n` +
      `    • Chạy trên bản sao:  set DB_PATH=<đường dẫn file .sqlite sao>\n` +
      `    • Chỉ đọc:           gọi requireSafeDb({ allowWrite: false })\n` +
      `    • Ghi có chủ đích:   thêm cờ ${ALLOW_PROD_FLAG} (sẽ ghi log audit)`
    );
    err.code = 'DB_WRITE_GUARD_BLOCKED';
    err.isProd = check.isProd;
    throw err;
  }

  if (check.forced) {
    console.warn(
      `[DB GUARD] ⚠️  ĐÃ VƯỢT KHOÁ GHI DB VẬN HÀNH (${ALLOW_PROD_FLAG}) — ` +
        `${opts.context || 'script'}: ${check.reason}`
    );
  }

  return { readOnly: false, ...check };
}

/**
 * Dùng trong `database.js`: chặn mở DB vận hành khi chạy migration.
 * Ở production, app VẪN phải chạy được (dùng DB vận hành) — nên hàm này
 * chỉ CẢNH BÁO khi phát hiện tình huống bất thường (VD: NODE_ENV=production
 * nhưng lại đang chạy script/migration ngoài dự kiến).
 *
 * @param {string} dbPath
 * @param {object} [opts]
 */
function assertDatabaseWritable(dbPath, opts = {}) {
  const env = opts.env || process.env;

  // App vận hành (server) dùng DB thật — KHÔNG chặn.
  if (env.NODE_ENV === 'production') return { allowed: true, reason: 'production server' };

  // Test → DB bản sao, OK.
  if (env.NODE_ENV === 'test') return { allowed: true, reason: 'test DB copy' };

  // Không có DB_PATH + không phải production → đang mở DB thật ở môi trường
  // dev/staging. Đây là tình huống RỦI RO cao (script/migration chạy ngoài ý muốn).
  // → CẢNH BÁO mạnh, KHÔNG chặn (để dev vẫn chạy app bình thường).
  if (!env.DB_PATH) {
    console.warn(
      '[DB GUARD] ⚠️  Đang mở DB vận hành (database.sqlite) mà KHÔNG có DB_PATH.\n' +
        '           Mọi script/migration ngoài ý muốn sẽ GHI vào dữ liệu thật.\n' +
        '           → Đặt DB_PATH=<bản sao> khi chạy script kiểm thử.'
    );
    return { allowed: true, reason: 'dev without DB_PATH — warned', warned: true };
  }

  return { allowed: true, reason: 'custom DB_PATH' };
}

/**
 * Tạo bản sao DB vận hành để chạy script an toàn.
 * Dùng cho các script `scripts/ops/*.js` cần đọc/ghi dữ liệu thật mà
 * KHÔNG muốn chạm vào DB gốc.
 *
 * @param {string} [targetPath]
 * @returns {string} đường dẫn bản sao
 */
function copyProdDb(targetPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = targetPath || path.join(ROOT, 'scripts', 'ops', '.tmp', `db-copy-${stamp}.sqlite`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(PROD_DB_PATH, dest);
  for (const suffix of ['-wal', '-shm']) {
    const f = dest + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
    }
  }
  return dest;
}

module.exports = {
  ROOT,
  PROD_DB_PATH,
  ALLOW_PROD_FLAG,
  checkWriteAllowed,
  requireSafeDb,
  assertDatabaseWritable,
  copyProdDb,
};
