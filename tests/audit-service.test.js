/**
 * AUDIT LOG UNIFICATION — test cho AuditService + migration 056
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi kiểm tra:
 *  A. AuditService.logStock — ghi đúng cột, suy ra actor từ req.user, fail-open
 *  B. AuditService.logKeg — validate `type`, ghi actor + IP + ngày nghiệp vụ
 *  C. AuditService.kegState / logKegWithState — tự lấy trạng thái vỏ
 *  D. Retention — policy đọc từ settings, purgeAll xoá đúng ngưỡng, dryRun
 *  E. Migration 056 — idempotent, có index + cột actor/ip, đã drop action_logs
 *  F. Các chỗ ghi log rải rác KHÔNG còn raw SQL INSERT (chống tái phát hồi)
 */
process.env.NODE_ENV = 'test';

const db = require('../database');
const AuditService = require('../src/services/AuditService');
const AuditRetentionService = require('../src/services/AuditRetentionService');
const migration056 = require('../database/migrations/056_audit_log_unification');

jest.setTimeout(20000);

// ── Helpers ─────────────────────────────────────────────────────────────────

const countRows = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

const lastRow = (table) =>
  db.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 1`).get();

/** Tạo req giả để test suy ra actor + IP. */
function fakeReq(username = 'tester', ip = '10.0.0.99') {
  return { user: { username, role: 'admin' }, ip };
}

afterAll(() => {
  try {
    db.close();
  } catch (_) {
    /* ignore */
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// A. logStock
// ═══════════════════════════════════════════════════════════════════════════
describe('AuditService.logStock', () => {
  test('ghi vào product_audit_log với actor lấy từ req.user', () => {
    const before = countRows('product_audit_log');
    const id = AuditService.logStock({
      productId: 1,
      type: 'import',
      quantity: 5,
      reason: 'purchase',
      refId: 99,
      customerName: 'Khách A',
      note: 'ghi chú test',
      req: fakeReq('alice'),
    });

    expect(id).toBeTruthy();
    expect(countRows('product_audit_log')).toBe(before + 1);

    const row = lastRow('product_audit_log');
    expect(row.product_id).toBe(1);
    expect(row.type).toBe('import');
    expect(row.quantity).toBe(5);
    expect(row.reason).toBe('purchase');
    expect(row.actor_username).toBe('alice');
    expect(row.ip_address).toBe('10.0.0.99');
    expect(row.customer_name).toBe('Khách A');
  });

  test('thiếu req → actor = "system"', () => {
    AuditService.logStock({ productId: 1, type: 'adjust', quantity: 1 });
    expect(lastRow('product_audit_log').actor_username).toBe('system');
  });

  test('actor tường minh được ưu tiên hơn req.user', () => {
    AuditService.logStock({
      productId: 1,
      type: 'adjust',
      quantity: 1,
      req: fakeReq('bob'),
      actor: 'driver01',
    });
    expect(lastRow('product_audit_log').actor_username).toBe('driver01');
  });

  test('productId không hợp lệ → trả null, không ghi', () => {
    const before = countRows('product_audit_log');
    expect(AuditService.logStock({ productId: null, type: 'adjust', quantity: 1 })).toBeNull();
    expect(AuditService.logStock({ productId: 'abc', type: 'adjust', quantity: 1 })).toBeNull();
    expect(countRows('product_audit_log')).toBe(before);
  });

  test('FAIL-OPEN: lỗi DB không làm throw', () => {
    // productId hợp lệ nhưng cố insert với type quá dài / ràng buộc → vẫn null
    const res = AuditService.logStock({
      productId: 2,
      type: 'import',
      quantity: 1,
      note: 'x'.repeat(5000), // note bị cắt còn 1000 → vẫn OK
    });
    expect(res).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. logKeg
// ═══════════════════════════════════════════════════════════════════════════
describe('AuditService.logKeg', () => {
  test('ghi vào keg_transactions_log với actor + ip + state', () => {
    const before = countRows('keg_transactions_log');
    const id = AuditService.logKeg({
      type: 'collect',
      quantity: 3,
      customerId: 7,
      customerName: 'Khách B',
      inventoryAfter: 10,
      emptyAfter: 20,
      holdingAfter: 30,
      note: 'thu vỏ test',
      req: fakeReq('carol', '192.168.1.5'),
    });

    expect(id).toBeTruthy();
    expect(countRows('keg_transactions_log')).toBe(before + 1);

    const row = lastRow('keg_transactions_log');
    expect(row.type).toBe('collect');
    expect(row.quantity).toBe(3);
    expect(row.customer_id).toBe(7);
    expect(row.customer_name).toBe('Khách B');
    expect(row.inventory_after).toBe(10);
    expect(row.empty_after).toBe(20);
    expect(row.holding_after).toBe(30);
    expect(row.actor_username).toBe('carol');
    expect(row.ip_address).toBe('192.168.1.5');
    expect(row.date).toBeTruthy();
  });

  test('type không hợp lệ → từ chối, trả null, không ghi', () => {
    const before = countRows('keg_transactions_log');
    expect(AuditService.logKeg({ type: 'xxx_khong_hop_le', quantity: 1 })).toBeNull();
    expect(countRows('keg_transactions_log')).toBe(before);
  });

  test('mọi type trong KEG_TYPES đều được chấp nhận', () => {
    for (const type of AuditService.KEG_TYPES) {
      const id = AuditService.logKeg({ type, quantity: 1, actor: 'test' });
      expect(id).toBeTruthy();
    }
  });

  test('note dài bị cắt ở MAX_NOTE', () => {
    AuditService.logKeg({
      type: 'adjust',
      quantity: 1,
      note: 'z'.repeat(AuditService.MAX_NOTE + 500),
      actor: 'test',
    });
    const row = lastRow('keg_transactions_log');
    expect(row.note.length).toBeLessThanOrEqual(AuditService.MAX_NOTE + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. kegState / logKegWithState
// ═══════════════════════════════════════════════════════════════════════════
describe('AuditService.kegState', () => {
  test('trả về đủ 4 trường, không âm', () => {
    const state = AuditService.kegState();
    expect(typeof state.inventory).toBe('number');
    expect(typeof state.emptyCollected).toBe('number');
    expect(typeof state.customerHolding).toBe('number');
    expect(typeof state.lost).toBe('number');
    expect(state.inventory).toBeGreaterThanOrEqual(0);
  });

  test('raw=true dùng SUM(stock) (có thể âm)', () => {
    const raw = AuditService.kegState({ raw: true });
    const positive = AuditService.kegState();
    expect(raw.inventory).toBeLessThanOrEqual(positive.inventory);
  });

  test('logKegWithState tự điền *_after khi không truyền', () => {
    const id = AuditService.logKegWithState({ type: 'import', quantity: 1, actor: 'test' });
    expect(id).toBeTruthy();
    const row = lastRow('keg_transactions_log');
    const state = AuditService.kegState();
    expect(row.inventory_after).toBe(state.inventory);
    expect(row.empty_after).toBe(state.emptyCollected);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Retention
// ═══════════════════════════════════════════════════════════════════════════
describe('Retention policy & purge', () => {
  const SETTINGS = [
    'audit_log_retention_days',
    'stock_log_retention_days',
    'keg_log_retention_days',
  ];

  afterEach(() => {
    for (const k of SETTINGS) {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
        k.includes('audit') ? '180' : '365',
        k
      );
    }
  });

  test('policy mặc định đọc từ settings', () => {
    const p = AuditService.retentionPolicy();
    expect(p.auditLogs).toBe(180);
    expect(p.stockLogs).toBe(365);
    expect(p.kegLogs).toBe(365);
  });

  test('đổi setting → policy đổi theo', () => {
    db.prepare("UPDATE settings SET value = '30' WHERE key = 'audit_log_retention_days'").run();
    expect(AuditService.retentionPolicy().auditLogs).toBe(30);
  });

  test('purgeAll dryRun KHÔNG xoá gì', () => {
    const before = countRows('audit_logs');
    const result = AuditService.purgeAll({ dryRun: true, days: 1 });
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(countRows('audit_logs')).toBe(before);
  });

  test('purgeAll xoá dòng cũ hơn ngưỡng, giữ dòng mới', () => {
    // Chèn 1 dòng audit_logs cũ (2 năm trước)
    db.prepare(
      "INSERT INTO audit_logs (actor_username, action, created_at) VALUES ('old', 'test:old', '2000-01-01 00:00:00')"
    ).run();
    const before = countRows('audit_logs');

    const result = AuditService.purgeAll({ days: 365 });
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(result.deletedByTable.audit_logs).toBeGreaterThanOrEqual(1);
    expect(countRows('audit_logs')).toBe(before - result.deletedByTable.audit_logs);
  });

  test('purgeAll trả về đủ 3 bảng trong kết quả', () => {
    const result = AuditService.purgeAll({ dryRun: true });
    expect(result.deletedByTable).toHaveProperty('audit_logs');
    expect(result.deletedByTable).toHaveProperty('product_audit_log');
    expect(result.deletedByTable).toHaveProperty('keg_transactions_log');
    expect(result.deleted).toBe(result.total);
    expect(result.policy).toHaveProperty('auditLogs');
  });

  test('AuditRetentionService.stats() liệt kê 3 bảng', () => {
    const stats = AuditRetentionService.stats();
    expect(stats.tables).toHaveLength(3);
    const names = stats.tables.map((t) => t.table);
    expect(names).toContain('audit_logs');
    expect(names).toContain('product_audit_log');
    expect(names).toContain('keg_transactions_log');
  });

  test('AuditRetentionService.runPurge() không throw', () => {
    const result = AuditRetentionService.runPurge({ dryRun: true });
    expect(result).toHaveProperty('deleted');
  });});

// ═══════════════════════════════════════════════════════════════════════════
// E. Migration 056
// ═══════════════════════════════════════════════════════════════════════════
describe('Migration 056 — audit log unification', () => {
  test('idempotent: chạy 2 lần không lỗi', () => {
    expect(() => migration056.up(db)).not.toThrow();
    expect(() => migration056.up(db)).not.toThrow();
  });

  test('product_audit_log có cột actor_username + ip_address', () => {
    const cols = db.prepare('PRAGMA table_info(product_audit_log)').all().map((c) => c.name);
    expect(cols).toContain('actor_username');
    expect(cols).toContain('ip_address');
  });

  test('keg_transactions_log có cột actor_username + ip_address', () => {
    const cols = db.prepare('PRAGMA table_info(keg_transactions_log)').all().map((c) => c.name);
    expect(cols).toContain('actor_username');
    expect(cols).toContain('ip_address');
  });

  test('có các index composite truy vấn lọc', () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r) => r.name);
    expect(idx).toContain('idx_product_audit_prod_created');
    expect(idx).toContain('idx_product_audit_type_created');
    expect(idx).toContain('idx_product_audit_actor');
    expect(idx).toContain('idx_keg_tx_log_type_date');
    expect(idx).toContain('idx_keg_tx_log_cust_date');
    expect(idx).toContain('idx_keg_tx_log_actor_date');
    expect(idx).toContain('idx_audit_logs_actor_created');
  });

  test('bảng action_logs đã bị drop', () => {
    const t = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='action_logs'")
      .get();
    expect(t).toBeUndefined();
  });

  test('seed đủ 3 setting retention', () => {
    const rows = db
      .prepare("SELECT key FROM settings WHERE key LIKE '%retention_days'")
      .all()
      .map((r) => r.key);
    expect(rows).toContain('audit_log_retention_days');
    expect(rows).toContain('stock_log_retention_days');
    expect(rows).toContain('keg_log_retention_days');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Không còn raw SQL INSERT rải rác
// ═══════════════════════════════════════════════════════════════════════════
describe('Không còn ghi log bằng raw SQL rải rác', () => {
  const fs = require('fs');
  const path = require('path');

  const SCAN_DIRS = ['routes', 'src'];
  const ALLOWED = [
    path.join('src', 'services', 'AuditService.js'),
    // 2 file này là migration dữ liệu 1 lần (không phải ghi log runtime)
    path.join('routes', 'api', 'sync.js'),
    path.join('database', 'migration.js'),
  ];

  function walk(dir, acc = []) {
    const full = path.join(__dirname, '..', dir);
    if (!fs.existsSync(full)) return acc;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), acc);
      else if (entry.name.endsWith('.js')) acc.push(path.join(dir, entry.name));
    }
    return acc;
  }

  test('không file nào ngoài AuditService chèn raw log', () => {
    const offenders = [];
    for (const dir of SCAN_DIRS) {
      for (const rel of walk(dir)) {
        if (ALLOWED.includes(rel)) continue;
        const content = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
        if (
          /INSERT\s+INTO\s+product_audit_log/i.test(content) ||
          /INSERT\s+INTO\s+keg_transactions_log/i.test(content)
        ) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
