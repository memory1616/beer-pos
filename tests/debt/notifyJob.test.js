/**
 * HÀNG ĐỢI THÔNG BÁO CÔNG NỢ (durable queue) — unit + integration test
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi test:
 *  - Migration 069: bảng `debt_notification_jobs` + unique index 1:1.
 *  - CustomerGroupService:
 *      • 1 khách ↔ 1 nhóm; 1 group id ↔ 1 khách
 *      • Không lưu group id rỗng; khách không tồn tại
 *      • Đổi group id hợp lệ; gỡ liên kết; bật/tắt
 *  - NotificationJobService:
 *      • enqueueJob tạo job 'queued' / 'no_group'
 *      • Idempotency (transaction_id + event_type + group_id)
 *      • lease / markSent / markFailed / retry / cancel
 *      • recoverStaleJobs (worker restart)
 *      • backoff exponential
 *  - NotificationWorker:
 *      • Job queued được xử lý; job sent không gửi lại
 *      • Lỗi tạm thời → retry; lỗi vĩnh viễn → failed
 *      • Timeout → unknown (KHÔNG retry mù)
 *      • 2 worker không xử lý cùng 1 job
 *      • Snapshot group id giữ nguyên khi retry
 *  - Tích hợp thanh toán:
 *      • Thanh toán tạo đúng 1 job; payment không có nhóm vẫn thành công
 *      • Lỗi provider KHÔNG làm hỏng payment
 */
process.env.NODE_ENV = 'test';

const db = require('../../database');
const NotificationJobService = require('../../src/services/notify/NotificationJobService');
const CustomerGroupService = require('../../src/services/notify/CustomerGroupService');
const NotificationWorkerModule = require('../../src/services/notify/NotificationWorker');
const NotificationWorker = NotificationWorkerModule.NotificationWorker;
const ProviderFactory = require('../../src/services/notify/provider');
const { MockZaloAdapter, SCENARIOS } = require('../../src/services/notify/provider/MockZaloAdapter');
const DebtPaymentService = require('../../src/services/debt/DebtPaymentService');
const DebtLedgerService = require('../../src/services/debt/DebtLedgerService');
const { TRANSACTION_TYPES, SOURCES } = require('../../src/services/debt/constants');

jest.setTimeout(30000);

// ── Helpers ──────────────────────────────────────────────────────────────────
let seq = 0;
const createdCustomers = [];
const createdGroups = [];
const createdJobs = [];

function makeCustomer(nameSuffix) {
  seq += 1;
  const name = `__NOTIFYJOB_TEST_${nameSuffix}_${Date.now()}_${seq}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name);
  createdCustomers.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function makeGroup(customerId, groupId) {
  const info = db
    .prepare(
      `INSERT INTO debt_customer_groups (customer_id, platform, group_id, group_name, status)
       VALUES (?, 'zalo_personal', ?, ?, 'active')`
    )
    .run(customerId, groupId, `Group ${groupId}`);
  createdGroups.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function readSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

const savedSettings = {};
function snapshotSettings() {
  [
    'debt_notify_provider',
    'debt_notify_enabled',
    'debt_notify_worker_enabled',
    'debt_notify_retry_max_attempts',
    'debt_notify_retry_base_delay_ms',
  ].forEach((k) => {
    savedSettings[k] = readSetting(k);
  });
}

function restoreSettings() {
  Object.keys(savedSettings).forEach((k) => {
    const v = savedSettings[k];
    if (v === null || v === undefined) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(k);
    } else {
      setSetting(k, v);
    }
  });
}

/** Ghi nợ cho khách để có số dư dương. */
function seedDebt(customerId, amount) {
  return DebtLedgerService.recordTransaction({
    customerId,
    transactionType: TRANSACTION_TYPES.MANUAL_DEBT,
    amount,
    direction: DebtLedgerService.DIRECTION.INCREASE,
    source: SOURCES.MANUAL_UI,
    description: '__test__',
  });
}

function jobsOf(customerId) {
  return db
    .prepare('SELECT * FROM debt_notification_jobs WHERE customer_id = ? ORDER BY id ASC')
    .all(customerId);
}

function cleanup() {
  createdJobs.forEach((id) => {
    try {
      db.prepare('DELETE FROM debt_notification_jobs WHERE id = ?').run(id);
    } catch (e) {
      /* ignore */
    }
  });
  createdGroups.forEach((id) => {
    try {
      db.prepare('DELETE FROM debt_customer_groups WHERE id = ?').run(id);
    } catch (e) {
      /* ignore */
    }
  });
  createdCustomers.forEach((id) => {
    try {
      db.prepare('DELETE FROM debt_transactions WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM debt_notifications WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM debt_notification_jobs WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    } catch (e) {
      /* ignore */
    }
  });
  createdCustomers.length = 0;
  createdGroups.length = 0;
  createdJobs.length = 0;
}

// ── Setup / teardown ─────────────────────────────────────────────────────────
beforeAll(() => {
  snapshotSettings();
  // Provider MOCK → không gọi mạng, tin KHÔNG gửi vào Zalo thật.
  setSetting('debt_notify_provider', 'mock');
  setSetting('debt_notify_enabled', '1');
  ProviderFactory.resetProviders();
});

afterAll(() => {
  cleanup();
  restoreSettings();
  ProviderFactory.resetProviders();
});

afterEach(() => {
  ProviderFactory.resetProviders();
  setSetting('debt_notify_provider', 'mock');
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Migration 069
// ═══════════════════════════════════════════════════════════════════════════
describe('Migration 069 — hàng đợi thông báo', () => {
  it('tạo bảng debt_notification_jobs', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='debt_notification_jobs'")
      .get();
    expect(row).toBeTruthy();
  });

  it('có unique index idempotency_key', () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='debt_notification_jobs'")
      .all()
      .map((r) => r.name);
    const cols = db.prepare('PRAGMA index_list(debt_notification_jobs)').all();
    const uniq = cols.find((c) => c.name === 'sqlite_autoindex_debt_notification_jobs_1');
    expect(uniq).toBeTruthy();
    expect(idx.length).toBeGreaterThan(0);
  });

  it('seed settings cho provider/worker/retry', () => {
    expect(readSetting('debt_notify_provider')).toBeTruthy();
    expect(readSetting('debt_notify_retry_max_attempts')).toBeTruthy();
    expect(readSetting('debt_notify_worker_enabled')).toBeTruthy();
  });

  it('ràng buộc 1:1 đã được tạo (unique platform+customer_id)', () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_debt_groups_platform_customer'")
      .get();
    expect(idx).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CustomerGroupService — ràng buộc 1 khách ↔ 1 nhóm
// ═══════════════════════════════════════════════════════════════════════════
describe('CustomerGroupService — liên kết 1 khách ↔ 1 nhóm', () => {
  it('liên kết nhóm thành công', () => {
    const custId = makeCustomer('link');
    const res = CustomerGroupService.upsert({
      customerId: custId,
      groupId: 'GRP_LINK_1',
      groupName: 'Công nợ Quán A',
    });
    expect(res.success).toBe(true);
    expect(res.data.group_id).toBe('GRP_LINK_1');
    expect(res.data.customer_id).toBe(custId);
  });

  it('một khách KHÔNG thể liên kết 2 nhóm khác nhau', () => {
    const custId = makeCustomer('two-groups');
    const first = CustomerGroupService.upsert({ customerId: custId, groupId: 'GRP_TWO_1' });
    expect(first.success).toBe(true);

    const second = CustomerGroupService.upsert({ customerId: custId, groupId: 'GRP_TWO_2' });
    expect(second.success).toBe(false);
    expect(second.code).toBe('CUSTOMER_ALREADY_HAS_GROUP');

    // DB chỉ có 1 dòng active cho khách này
    const rows = db
      .prepare(
        `SELECT * FROM debt_customer_groups
          WHERE customer_id = ? AND platform = 'zalo_personal' AND status = 'active'`
      )
      .all(custId);
    expect(rows.length).toBe(1);
  });

  it('một Group ID KHÔNG thể thuộc 2 khách hàng', () => {
    const c1 = makeCustomer('grp-owner-1');
    const c2 = makeCustomer('grp-owner-2');
    expect(CustomerGroupService.upsert({ customerId: c1, groupId: 'GRP_SHARED' }).success).toBe(true);

    const res = CustomerGroupService.upsert({ customerId: c2, groupId: 'GRP_SHARED' });
    expect(res.success).toBe(false);
    expect(res.code).toBe('GROUP_ID_TAKEN');
  });

  it('không lưu Group ID rỗng', () => {
    const custId = makeCustomer('empty-gid');
    const res = CustomerGroupService.upsert({ customerId: custId, groupId: '   ' });
    expect(res.success).toBe(false);
    expect(res.code).toBe('EMPTY_GROUP_ID');
  });

  it('không liên kết khách hàng không tồn tại', () => {
    const res = CustomerGroupService.upsert({ customerId: 99999999, groupId: 'GRP_NOCUST' });
    expect(res.success).toBe(false);
    expect(res.code).toBe('CUSTOMER_NOT_FOUND');
  });

  it('đổi Group ID hợp lệ cho cùng 1 khách', () => {
    const custId = makeCustomer('change-gid');
    expect(CustomerGroupService.upsert({ customerId: custId, groupId: 'GRP_OLD' }).success).toBe(true);
    const res = CustomerGroupService.upsert({
      customerId: custId,
      groupId: 'GRP_NEW',
      groupName: 'Tên mới',
      allowChange: true,
    });
    expect(res.success).toBe(true);
    expect(res.data.group_id).toBe('GRP_NEW');
    expect(res.data.group_name).toBe('Tên mới');

    const active = db
      .prepare(
        `SELECT * FROM debt_customer_groups
          WHERE customer_id = ? AND platform='zalo_personal' AND status='active'`
      )
      .all(custId);
    expect(active.length).toBe(1);
  });

  it('ngắt liên kết → chuyển inactive, KHÔNG mất lịch sử thông báo', () => {
    const custId = makeCustomer('unlink');
    const gid = makeGroup(custId, 'GRP_UNLINK');
    // Ghi 1 dòng lịch sử thông báo
    db.prepare(
      `INSERT INTO debt_notifications (customer_id, customer_name, channel, group_id, event_type,
                                       amount, status, source)
       VALUES (?, '__NOTIFYJOB_TEST__', 'omicall_zalo_personal', 'GRP_UNLINK', 'payment', 1, 'sent', 'TEST')`
    ).run(custId);

    const res = CustomerGroupService.unlink(gid);
    expect(res.success).toBe(true);

    const row = db.prepare('SELECT * FROM debt_customer_groups WHERE id = ?').get(gid);
    expect(row.status).toBe('inactive');

    const hist = db
      .prepare('SELECT COUNT(*) AS c FROM debt_notifications WHERE customer_id = ?')
      .get(custId);
    expect(hist.c).toBe(1);
  });

  it('bật/tắt trạng thái liên kết', () => {
    const custId = makeCustomer('toggle');
    const gid = makeGroup(custId, 'GRP_TOGGLE');

    expect(CustomerGroupService.setStatus(gid, 'inactive').success).toBe(true);
    expect(db.prepare('SELECT status FROM debt_customer_groups WHERE id = ?').get(gid).status).toBe(
      'inactive'
    );

    expect(CustomerGroupService.setStatus(gid, 'active').success).toBe(true);
    expect(db.prepare('SELECT status FROM debt_customer_groups WHERE id = ?').get(gid).status).toBe(
      'active'
    );
  });

  it('checkConflicts phát hiện trùng', () => {
    const c1 = makeCustomer('chk-1');
    const c2 = makeCustomer('chk-2');
    CustomerGroupService.upsert({ customerId: c1, groupId: 'GRP_CHK' });

    const res = CustomerGroupService.checkConflicts({ customerId: c2, groupId: 'GRP_CHK' });
    expect(res.duplicateGroup).toBe(true);
    expect(res.groupOwner.customer_id).toBe(c1);
  });

  // ⚠️ Regression: nếu cho phép platform tùy ý, người dùng tạo được dòng
  //    'zalo' mà mọi truy vấn theo platform chuẩn ('zalo_personal') đều
  //    không thấy → mapping "mất hút", vi phạm quy tắc 1 khách = 1 nhóm.
  it('từ chối platform không hợp lệ (không tạo mapping "mất hút")', () => {
    const custId = makeCustomer('bad-platform');
    const res = CustomerGroupService.upsert({
      customerId: custId,
      groupId: 'GRP_BAD_PLATFORM',
      platform: 'telegram',
    });
    expect(res.success).toBe(false);
    expect(res.code).toBe('UNSUPPORTED_PLATFORM');

    // Không có dòng nào được tạo với platform lạ
    const rows = db
      .prepare('SELECT * FROM debt_customer_groups WHERE customer_id = ?')
      .all(custId);
    expect(rows.length).toBe(0);
  });

  it('chấp nhận platform chuẩn + các bí danh → quy về zalo_personal', () => {
    const custId = makeCustomer('alias-platform');
    const res = CustomerGroupService.upsert({
      customerId: custId,
      groupId: 'GRP_ALIAS',
      platform: 'zalo',
    });
    expect(res.success).toBe(true);
    expect(res.data.platform).toBe('zalo_personal');

    // Và tìm thấy được bằng platform chuẩn
    expect(CustomerGroupService.findByCustomer(custId, 'zalo_personal')).toBeTruthy();
  });

  it('từ chối Zalo OA (module này chỉ dùng nhóm Zalo cá nhân)', () => {
    const custId = makeCustomer('oa-platform');
    const res = CustomerGroupService.upsert({
      customerId: custId,
      groupId: 'GRP_OA',
      platform: 'zalo_oa',
    });
    expect(res.success).toBe(false);
    expect(res.code).toBe('UNSUPPORTED_PLATFORM');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. NotificationJobService — tạo job & idempotency
// ═══════════════════════════════════════════════════════════════════════════
describe('NotificationJobService — enqueue & idempotency', () => {
  it('khách có nhóm → job queued, snapshot group id + nội dung', () => {
    const custId = makeCustomer('queued');
    makeGroup(custId, 'GRP_QUEUE');

    const res = NotificationJobService.enqueueJob({
      customerId: custId,
      customerName: 'Test Queued',
      transactionId: 900001,
      content: 'Nội dung test',
      amount: 10000,
      balanceBefore: 50000,
      balanceAfter: 40000,
    });
    expect(res.success).toBe(true);
    expect(res.status).toBe('queued');
    expect(res.groupId).toBe('GRP_QUEUE');
    createdJobs.push(res.jobId);

    const job = db
      .prepare('SELECT * FROM debt_notification_jobs WHERE id = ?')
      .get(res.jobId);
    expect(job.group_id).toBe('GRP_QUEUE');
    expect(job.content_snapshot).toBe('Nội dung test');
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(0);
  });

  it('khách KHÔNG có nhóm → job no_group (KHÔNG phải lỗi)', () => {
    const custId = makeCustomer('nogroup');
    const res = NotificationJobService.enqueueJob({
      customerId: custId,
      transactionId: 900002,
      amount: 10000,
    });
    expect(res.success).toBe(true);
    expect(res.status).toBe('no_group');
    expect(res.groupId).toBeNull();
    createdJobs.push(res.jobId);

    const job = db
      .prepare('SELECT * FROM debt_notification_jobs WHERE id = ?')
      .get(res.jobId);
    expect(job.group_id).toBeNull();
    expect(job.last_error).toMatch(/Chưa liên kết nhóm Zalo/);
  });

  it('idempotency: cùng transaction_id + group_id → KHÔNG tạo job thứ 2', () => {
    const custId = makeCustomer('idem');
    makeGroup(custId, 'GRP_IDEM');

    const first = NotificationJobService.enqueueJob({
      customerId: custId,
      transactionId: 900003,
      content: 'x',
    });
    const second = NotificationJobService.enqueueJob({
      customerId: custId,
      transactionId: 900003,
      content: 'x',
    });
    createdJobs.push(first.jobId);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.jobId).toBe(first.jobId);

    const count = db
      .prepare('SELECT COUNT(*) AS c FROM debt_notification_jobs WHERE customer_id = ?')
      .get(custId);
    expect(count.c).toBe(1);
  });

  it('idempotency key = transaction + event_type + group_id', () => {
    const key = NotificationJobService.buildIdempotencyKey({
      transactionId: 123,
      eventType: 'payment',
      groupId: 'GRP_A',
    });
    expect(key).toBe('payment:tx:123:grp:GRP_A');

    const key2 = NotificationJobService.buildIdempotencyKey({
      transactionId: 123,
      eventType: 'manual_debt',
      groupId: 'GRP_A',
    });
    expect(key2).not.toBe(key);
  });

  it('findCustomerGroup trả null khi khách chưa liên kết', () => {
    const custId = makeCustomer('find-none');
    const g = NotificationJobService.findCustomerGroup(custId);
    expect(g.groupId).toBeNull();
    expect(g.ambiguous).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. NotificationJobService — lease / retry / recovery
// ═══════════════════════════════════════════════════════════════════════════
describe('NotificationJobService — lease, retry, recovery', () => {
  function enqueueFor(customerId, groupId, txId) {
    const res = NotificationJobService.enqueueJob({
      customerId,
      transactionId: txId,
      content: 'test',
      provider: 'mock',
    });
    createdJobs.push(res.jobId);
    return res.jobId;
  }

  it('leaseJobs đánh dấu processing + tăng attempts', () => {
    const custId = makeCustomer('lease');
    makeGroup(custId, 'GRP_LEASE');
    const jobId = enqueueFor(custId, 'GRP_LEASE', 910001);

    const leased = NotificationJobService.leaseJobs({ limit: 10, workerId: 'w1' });
    const mine = leased.filter((j) => j.id === jobId);
    expect(mine.length).toBe(1);
    expect(mine[0].status).toBe('processing');
    expect(mine[0].attempts).toBe(1);
    expect(mine[0].locked_until).toBeTruthy();
  });

  it('leaseJobs KHÔNG cho 2 worker lấy cùng 1 job', () => {
    const custId = makeCustomer('lease2');
    makeGroup(custId, 'GRP_LEASE2');
    const jobId = enqueueFor(custId, 'GRP_LEASE2', 910002);

    const first = NotificationJobService.leaseJobs({ limit: 50, workerId: 'wA' });
    const second = NotificationJobService.leaseJobs({ limit: 50, workerId: 'wB' });

    expect(first.filter((j) => j.id === jobId).length).toBe(1);
    expect(second.filter((j) => j.id === jobId).length).toBe(0);
  });

  it('markSent chuyển job sang sent', () => {
    const custId = makeCustomer('sent');
    makeGroup(custId, 'GRP_SENT');
    const jobId = enqueueFor(custId, 'GRP_SENT', 910003);

    NotificationJobService.leaseJobs({ limit: 50, workerId: 'w1' });
    NotificationJobService.markSent(jobId, {
      providerMessageId: 'mock_1',
      deliveryStatus: 'accepted',
    });

    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('sent');
    expect(job.provider_message_id).toBe('mock_1');
    expect(job.delivery_status).toBe('accepted');
    expect(job.sent_at).toBeTruthy();
    expect(job.locked_until).toBeNull();
  });

  it('lỗi tạm thời → status retry + next_retry_at tương lai', () => {
    const custId = makeCustomer('retry');
    makeGroup(custId, 'GRP_RETRY');
    const jobId = enqueueFor(custId, 'GRP_RETRY', 910004);

    NotificationJobService.leaseJobs({ limit: 50, workerId: 'w1' });
    NotificationJobService.markFailed(
      jobId,
      { errorCode: 'TEMPORARY_ERROR', errorMessage: 'lỗi tạm thời', retryable: true },
      1
    );

    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('retry');
    expect(job.next_retry_at).toBeTruthy();
    expect(new Date(job.next_retry_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('lỗi vĩnh viễn → status failed, KHÔNG retry', () => {
    const custId = makeCustomer('failed');
    makeGroup(custId, 'GRP_FAILED');
    const jobId = enqueueFor(custId, 'GRP_FAILED', 910005);

    NotificationJobService.leaseJobs({ limit: 50, workerId: 'w1' });
    NotificationJobService.markFailed(
      jobId,
      { errorCode: 'PERMISSION_DENIED', errorMessage: 'không có quyền', retryable: false },
      1
    );

    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('failed');
    expect(job.next_retry_at).toBeNull();
  });

  it('hết số lần retry → failed', () => {
    const custId = makeCustomer('exhausted');
    makeGroup(custId, 'GRP_EXH');
    const jobId = enqueueFor(custId, 'GRP_EXH', 910006);

    NotificationJobService.leaseJobs({ limit: 50, workerId: 'w1' });
    NotificationJobService.markFailed(
      jobId,
      { errorCode: 'TEMPORARY_ERROR', errorMessage: 'x', retryable: true },
      NotificationJobService.maxAttempts()
    );

    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('failed');
  });

  it('timeout → unknown, KHÔNG retry mù', () => {
    const custId = makeCustomer('unknown');
    makeGroup(custId, 'GRP_UNKNOWN');
    const jobId = enqueueFor(custId, 'GRP_UNKNOWN', 910007);

    NotificationJobService.leaseJobs({ limit: 50, workerId: 'w1' });
    NotificationJobService.markFailed(
      jobId,
      { errorCode: 'TIMEOUT', errorMessage: 'timeout', deliveryStatus: 'unknown' },
      1
    );

    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('unknown');
    expect(job.next_retry_at).toBeNull();
  });

  it('retryJob KHÔNG cho gửi lại job đã sent', () => {
    const custId = makeCustomer('resent');
    makeGroup(custId, 'GRP_RESENT');
    const jobId = enqueueFor(custId, 'GRP_RESENT', 910008);

    NotificationJobService.leaseJobs({ limit: 50, workerId: 'w1' });
    NotificationJobService.markSent(jobId, { providerMessageId: 'm1' });

    const res = NotificationJobService.retryJob(jobId);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/không thể gửi lại/i);
  });

  it('retryJob job unknown cần force', () => {
    const custId = makeCustomer('unknown-retry');
    makeGroup(custId, 'GRP_UR');
    const jobId = enqueueFor(custId, 'GRP_UR', 910009);

    NotificationJobService.leaseJobs({ limit: 50, workerId: 'w1' });
    NotificationJobService.markFailed(
      jobId,
      { errorCode: 'TIMEOUT', errorMessage: 'timeout', deliveryStatus: 'unknown' },
      1
    );

    const noForce = NotificationJobService.retryJob(jobId);
    expect(noForce.success).toBe(false);
    expect(noForce.code).toBe('REQUIRES_VERIFICATION');

    const forced = NotificationJobService.retryJob(jobId, { force: true });
    expect(forced.success).toBe(true);
    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(0);
  });

  it('recoverStaleJobs đưa job processing quá hạn về queued (worker restart)', () => {
    const custId = makeCustomer('stale');
    makeGroup(custId, 'GRP_STALE');
    const jobId = enqueueFor(custId, 'GRP_STALE', 910010);

    // Giả lập worker chết giữa chừng: status=processing, lease đã hết hạn.
    db.prepare(
      `UPDATE debt_notification_jobs
          SET status = 'processing', locked_until = '2000-01-01T00:00:00.000Z', locked_by = 'dead'
        WHERE id = ?`
    ).run(jobId);

    const recovered = NotificationJobService.recoverStaleJobs();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('queued');
    expect(job.locked_until).toBeNull();
  });

  it('cancelJob huỷ job chưa gửi', () => {
    const custId = makeCustomer('cancel');
    makeGroup(custId, 'GRP_CANCEL');
    const jobId = enqueueFor(custId, 'GRP_CANCEL', 910011);

    const res = NotificationJobService.cancelJob(jobId, 'test');
    expect(res.success).toBe(true);
    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('cancelled');
  });

  it('backoff exponential: 1m, 5m, 15m, 60m, 180m', () => {
    const base = 60000;
    expect(NotificationJobService.backoffDelayMs(1)).toBe(base * 1);
    expect(NotificationJobService.backoffDelayMs(2)).toBe(base * 5);
    expect(NotificationJobService.backoffDelayMs(3)).toBe(base * 15);
    expect(NotificationJobService.backoffDelayMs(4)).toBe(base * 60);
    expect(NotificationJobService.backoffDelayMs(5)).toBe(base * 180);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. NotificationWorker — xử lý job qua provider MOCK
// ═══════════════════════════════════════════════════════════════════════════
describe('NotificationWorker — xử lý job', () => {
  function makeWorker(opts = {}) {
    return new NotificationWorker({
      workerId: opts.workerId || 'test-worker',
      intervalMs: 60000,
      batchSize: 20,
      ...opts,
    });
  }

  it('job queued được xử lý → sent + ghi lịch sử', async () => {
    const custId = makeCustomer('w-sent');
    makeGroup(custId, 'GRP_W_SENT');
    const res = NotificationJobService.enqueueJob({
      customerId: custId,
      transactionId: 920001,
      content: 'Tin nhắn test',
      provider: 'mock',
    });
    createdJobs.push(res.jobId);

    const worker = makeWorker();
    const summary = await worker.runOnce();
    expect(summary.processed).toBeGreaterThanOrEqual(1);
    expect(summary.sent).toBeGreaterThanOrEqual(1);

    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(res.jobId);
    expect(job.status).toBe('sent');
    expect(job.provider_message_id).toMatch(/^mock_/);

    const hist = db
      .prepare('SELECT * FROM debt_notifications WHERE job_id = ?')
      .get(res.jobId);
    expect(hist).toBeTruthy();
    expect(hist.status).toBe('sent');
  });

  it('job sent KHÔNG được gửi lại', async () => {
    const custId = makeCustomer('w-nodupe');
    makeGroup(custId, 'GRP_W_NODUPE');
    const res = NotificationJobService.enqueueJob({
      customerId: custId,
      transactionId: 920002,
      content: 'x',
      provider: 'mock',
    });
    createdJobs.push(res.jobId);

    const worker = makeWorker();
    await worker.runOnce();

    const provider = ProviderFactory.getProvider('mock');
    const before = provider.sentCount;

    // Vòng thứ 2 không còn job queued → không gửi lại
    await worker.runOnce();
    expect(provider.sentCount).toBe(before);
  });

  it('lỗi tạm thời → retry', async () => {
    const custId = makeCustomer('w-retry');
    makeGroup(custId, 'GRP_W_RETRY');
    const res = NotificationJobService.enqueueJob({
      customerId: custId,
      transactionId: 920003,
      content: 'x',
      provider: 'mock',
    });
    createdJobs.push(res.jobId);

    const provider = ProviderFactory.getProvider('mock');
    provider.setScenario(SCENARIOS.TEMPORARY);

    const worker = makeWorker();
    const summary = await worker.runOnce();
    expect(summary.retried).toBeGreaterThanOrEqual(1);

    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(res.jobId);
    expect(job.status).toBe('retry');
    provider.setScenario(SCENARIOS.SUCCESS);
  });

  it('lỗi vĩnh viễn → failed', async () => {
    const custId = makeCustomer('w-failed');
    makeGroup(custId, 'GRP_W_FAILED');
    const res = NotificationJobService.enqueueJob({
      customerId: custId,
      transactionId: 920004,
      content: 'x',
      provider: 'mock',
    });
    createdJobs.push(res.jobId);

    const provider = ProviderFactory.getProvider('mock');
    provider.setScenario(SCENARIOS.PERMANENT);

    const worker = makeWorker();
    const summary = await worker.runOnce();
    expect(summary.failed).toBeGreaterThanOrEqual(1);

    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(res.jobId);
    expect(job.status).toBe('failed');
    provider.setScenario(SCENARIOS.SUCCESS);
  });

  it('timeout → unknown (KHÔNG retry mù)', async () => {
    const custId = makeCustomer('w-unknown');
    makeGroup(custId, 'GRP_W_UNKNOWN');
    const res = NotificationJobService.enqueueJob({
      customerId: custId,
      transactionId: 920005,
      content: 'x',
      provider: 'mock',
    });
    createdJobs.push(res.jobId);

    const provider = ProviderFactory.getProvider('mock');
    provider.setScenario(SCENARIOS.TIMEOUT);

    const worker = makeWorker();
    const summary = await worker.runOnce();
    expect(summary.unknown).toBeGreaterThanOrEqual(1);

    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(res.jobId);
    expect(job.status).toBe('unknown');
    expect(job.next_retry_at).toBeNull();
    provider.setScenario(SCENARIOS.SUCCESS);
  });

  it('2 worker KHÔNG xử lý cùng 1 job', async () => {
    const custId = makeCustomer('w-two');
    makeGroup(custId, 'GRP_W_TWO');
    const res = NotificationJobService.enqueueJob({
      customerId: custId,
      transactionId: 920006,
      content: 'x',
      provider: 'mock',
    });
    createdJobs.push(res.jobId);

    const w1 = makeWorker({ workerId: 'w-1' });
    const w2 = makeWorker({ workerId: 'w-2' });

    const [s1, s2] = await Promise.all([w1.runOnce(), w2.runOnce()]);
    const total = (s1.sent || 0) + (s2.sent || 0);
    // Job chỉ được gửi đúng 1 lần
    expect(total).toBeLessThanOrEqual(1);

    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(res.jobId);
    expect(job.status).toBe('sent');
    expect(job.attempts).toBe(1);
  });

  it('group id snapshot giữ nguyên khi retry (khách đổi nhóm sau khi tạo job)', async () => {
    const custId = makeCustomer('w-snapshot');
    makeGroup(custId, 'GRP_W_SNAPSHOT');
    const res = NotificationJobService.enqueueJob({
      customerId: custId,
      transactionId: 920007,
      content: 'nội dung gốc',
      provider: 'mock',
    });
    createdJobs.push(res.jobId);

    // Khách đổi nhóm sau khi job đã tạo
    db.prepare(
      `UPDATE debt_customer_groups
          SET group_id = 'GRP_W_CHANGED', status = 'inactive'
        WHERE customer_id = ?`
    ).run(custId);

    const provider = ProviderFactory.getProvider('mock');
    provider.setScenario(SCENARIOS.TEMPORARY);
    const worker = makeWorker();
    await worker.runOnce();

    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(res.jobId);
    expect(job.group_id).toBe('GRP_W_SNAPSHOT');
    expect(job.content_snapshot).toBe('nội dung gốc');
    provider.setScenario(SCENARIOS.SUCCESS);
  });

  it('job no_group KHÔNG được gửi', async () => {
    const custId = makeCustomer('w-nogroup');
    const res = NotificationJobService.enqueueJob({
      customerId: custId,
      transactionId: 920008,
      content: 'x',
      provider: 'mock',
    });
    createdJobs.push(res.jobId);

    const provider = ProviderFactory.getProvider('mock');
    const before = provider.sentCount;

    const worker = makeWorker();
    await worker.runOnce();

    expect(provider.sentCount).toBe(before);
    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(res.jobId);
    expect(job.status).toBe('no_group');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Tích hợp thanh toán (transactional outbox)
// ═══════════════════════════════════════════════════════════════════════════
describe('Tích hợp thanh toán — transactional outbox', () => {
  const adminUser = { username: 'admin', role: 'ADMIN' };

  it('thanh toán thủ công tạo ĐÚNG 1 job (ghi trong cùng transaction)', () => {
    const custId = makeCustomer('pay');
    makeGroup(custId, 'GRP_PAY');
    seedDebt(custId, 100000);

    const res = DebtPaymentService.recordPayment({
      customerId: custId,
      amount: 30000,
      user: adminUser,
      source: SOURCES.MANUAL_UI,
    });
    expect(res.success).toBe(true);

    const jobs = jobsOf(custId);
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe('queued');
    expect(jobs[0].group_id).toBe('GRP_PAY');
    expect(jobs[0].transaction_id).toBe(res.transactionId);
    expect(jobs[0].amount).toBe(30000);
    expect(jobs[0].content_snapshot).toContain('Đã nhận');
  });

  it('thanh toán KHÔNG tạo job trùng khi gọi lại (idempotency)', () => {
    const custId = makeCustomer('pay-idem');
    makeGroup(custId, 'GRP_PAY_IDEM');
    seedDebt(custId, 100000);

    const key = `test-idem-${Date.now()}`;
    const r1 = DebtPaymentService.recordPayment({
      customerId: custId,
      amount: 20000,
      user: adminUser,
      idempotencyKey: key,
    });
    const r2 = DebtPaymentService.recordPayment({
      customerId: custId,
      amount: 20000,
      user: adminUser,
      idempotencyKey: key,
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    const jobs = jobsOf(custId);
    expect(jobs.length).toBe(1);
  });

  it('thanh toán thành công khi khách CHƯA có nhóm → job no_group, payment vẫn thành công', () => {
    const custId = makeCustomer('pay-nogroup');
    seedDebt(custId, 100000);

    const res = DebtPaymentService.recordPayment({
      customerId: custId,
      amount: 15000,
      user: adminUser,
    });
    expect(res.success).toBe(true);
    expect(res.transactionId).toBeTruthy();

    const jobs = jobsOf(custId);
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe('no_group');
    expect(jobs[0].group_id).toBeNull();
  });

  it('lỗi provider KHÔNG làm rollback payment đã commit', async () => {
    const custId = makeCustomer('pay-provider-fail');
    makeGroup(custId, 'GRP_PAY_FAIL');
    seedDebt(custId, 100000);

    const res = DebtPaymentService.recordPayment({
      customerId: custId,
      amount: 25000,
      user: adminUser,
    });
    expect(res.success).toBe(true);

    // Provider lỗi vĩnh viễn
    const provider = ProviderFactory.getProvider('mock');
    provider.setScenario(SCENARIOS.PERMANENT);

    const worker = new NotificationWorker({ workerId: 'w-pay', intervalMs: 60000, batchSize: 20 });
    await worker.runOnce();

    // Payment VẪN còn trong sổ cái
    const tx = db
      .prepare('SELECT * FROM debt_transactions WHERE id = ?')
      .get(res.transactionId);
    expect(tx).toBeTruthy();
    expect(tx.amount).toBe(25000);
    expect(DebtLedgerService.computeBalance(custId)).toBe(75000);

    // Job chuyển failed (không phải retry mù)
    const job = jobsOf(custId)[0];
    expect(job.status).toBe('failed');

    provider.setScenario(SCENARIOS.SUCCESS);
  });

  it('retry KHÔNG làm thay đổi dữ liệu thanh toán', () => {
    const custId = makeCustomer('pay-retry-safe');
    makeGroup(custId, 'GRP_PAY_RETRY');
    seedDebt(custId, 100000);

    const res = DebtPaymentService.recordPayment({
      customerId: custId,
      amount: 10000,
      user: adminUser,
    });
    expect(res.success).toBe(true);

    const balanceBefore = DebtLedgerService.computeBalance(custId);
    const txCountBefore = db
      .prepare('SELECT COUNT(*) AS c FROM debt_transactions WHERE customer_id = ?')
      .get(custId).c;

    const job = jobsOf(custId)[0];
    NotificationJobService.retryJob(job.id);

    expect(DebtLedgerService.computeBalance(custId)).toBe(balanceBefore);
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM debt_transactions WHERE customer_id = ?').get(custId).c
    ).toBe(txCountBefore);
  });

  it('nội dung job là SNAPSHOT — không dựng lại từ số dư mới', () => {
    const custId = makeCustomer('snapshot');
    makeGroup(custId, 'GRP_SNAP');
    seedDebt(custId, 100000);

    DebtPaymentService.recordPayment({
      customerId: custId,
      amount: 40000,
      user: adminUser,
    });

    const job = jobsOf(custId)[0];
    expect(job.content_snapshot).toContain('100.000đ'); // số dư TRƯỚC
    expect(job.balance_before).toBe(100000);
    expect(job.balance_after).toBe(60000);

    // Thanh toán thêm → số dư đổi, snapshot job cũ KHÔNG đổi
    DebtPaymentService.recordPayment({
      customerId: custId,
      amount: 10000,
      user: adminUser,
    });

    const jobAfter = db
      .prepare('SELECT * FROM debt_notification_jobs WHERE id = ?')
      .get(job.id);
    expect(jobAfter.content_snapshot).toBe(job.content_snapshot);
    expect(jobAfter.balance_after).toBe(60000);
  });
});
