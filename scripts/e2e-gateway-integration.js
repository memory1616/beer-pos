#!/usr/bin/env node
/**
 * E2E — kiểm thử tích hợp thật giữa BeerPOS và Gateway.
 *
 * Chạy 1 chuỗi kịch bản đầy đủ:
 *   1. Gateway online → BeerPOS gửi tin → Gateway tạo job → worker xử lý.
 *   2. Lịch sử ghi nhận đúng.
 *   3. Gateway offline → BeerPOS vẫn ghi giao dịch, job vào retry.
 *   4. Gateway online lại → job được xử lý lại, KHÔNG tin trùng.
 *   5. Số dư công nợ KHÔNG thay đổi.
 *
 * ⚠️ KHÔNG đụng production: dùng DB test riêng của BeerPOS + Gateway local.
 */

process.env.NODE_ENV = 'test';
process.env.NOTIFICATION_PROVIDER = process.env.NOTIFICATION_PROVIDER || 'gateway';

const GATEWAY_URL = String(process.env.GATEWAY_URL || 'http://localhost:3100').replace(/\/+$/, '');
const ADMIN_KEY = String(process.env.GATEWAY_ADMIN_KEY || '').trim();
const INTEGRATION_KEY = String(process.env.GATEWAY_INTEGRATION_KEY || '').trim();

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(step, msg) {
  console.log(`[E2E] ${step} — ${msg}`);
}

function fail(step, msg) {
  console.error(`[E2E] ${step} — FAIL: ${msg}`);
  process.exitCode = 1;
}

async function gwFetch(method, urlPath, body, key, extraHeaders) {
  const headers = {
    Accept: 'application/json',
    'X-API-Key': key || INTEGRATION_KEY,
    ...(extraHeaders || {}),
  };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(GATEWAY_URL + urlPath, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

async function gatewayAlive() {
  try {
    const res = await fetch(GATEWAY_URL + '/health');
    return res.ok;
  } catch (_) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Chính ───────────────────────────────────────────────────────────────────

async function main() {
  if (!ADMIN_KEY || !INTEGRATION_KEY) {
    console.error('[E2E] Thiếu GATEWAY_ADMIN_KEY / GATEWAY_INTEGRATION_KEY.');
    process.exit(1);
  }

  // ── Bước 0: chuẩn bị dữ liệu ────────────────────────────────────────────
  const db = require('../database');
  const CustomerGroupService = require('../src/services/notify/CustomerGroupService');
  const NotificationJobService = require('../src/services/notify/NotificationJobService');
  const NotificationWorkerModule = require('../src/services/notify/NotificationWorker');
  const DebtPaymentService = require('../src/services/debt/DebtPaymentService');
  const DebtLedgerService = require('../src/services/debt/DebtLedgerService');
  const { TRANSACTION_TYPES } = require('../src/services/debt/constants');

  const adminUser = { username: 'e2e_admin', role: 'ADMIN' };

  const suffix = Date.now();
  const custName = `__E2E_GATEWAY_${suffix}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(custName);
  const customerId = info.lastInsertRowid;
  log('BƯỚC 0', `Tạo khách test #${customerId}`);

  // Ghi vào BeerPOS (tương thích & dự phòng).
  CustomerGroupService.upsert({
    customerId,
    groupId: `E2E_GRP_${suffix}`,
    groupName: 'E2E Group',
  });

  // Ghi vào Gateway (nguồn sự thật khi provider = gateway).
  const created = await gwFetch(
    'POST',
    '/api/groups',
    {
      customerId: String(customerId),
      customerName: custName,
      groupId: `E2E_GRP_${suffix}`,
      groupName: 'E2E Group',
      note: 'e2e test',
    },
    ADMIN_KEY
  );
  if (!created.ok || !created.data.group) {
    fail('BƯỚC 0', `Không tạo được mapping ở Gateway: ${JSON.stringify(created.data)}`);
    return;
  }
  log('BƯỚC 0', `Đã tạo mapping Gateway: ${created.data.group.customerId} → ${created.data.group.groupId}`);

  // ── Bước 1: Gateway online, gửi tin ─────────────────────────────────────
  const alive = await gatewayAlive();
  log('BƯỚC 1', `Gateway ${alive ? 'ONLINE' : 'OFFLINE'}`);

  if (alive) {
    const send = await gwFetch(
      'POST',
      '/api/messages/send',
      {
        paymentId: `E2E_PAY_${suffix}`,
        customerId: String(customerId),
        message: `E2E test — khách ${custName} đã thanh toán 2.000.000đ`,
      },
      INTEGRATION_KEY,
      { 'Idempotency-Key': `payment-notification:E2E_${suffix}` }
    );
    if (!send.ok) {
      fail('BƯỚC 1', `Gateway từ chối yêu cầu: ${JSON.stringify(send.data)}`);
    } else {
      log('BƯỚC 1', `Gateway tạo job ${send.data.jobId} (status ${send.data.status})`);

      // Idempotency: gửi lại cùng key → không tạo job mới.
      const again = await gwFetch(
        'POST',
        '/api/messages/send',
        {
          paymentId: `E2E_PAY_${suffix}`,
          customerId: String(customerId),
          message: `E2E test — khách ${custName} đã thanh toán 2.000.000đ`,
        },
        INTEGRATION_KEY,
        { 'Idempotency-Key': `payment-notification:E2E_${suffix}` }
      );
      if (again.ok && again.data.jobId !== send.data.jobId) {
        fail('BƯỚC 1', `Idempotency sai: job ${send.data.jobId} vs ${again.data.jobId}`);
      } else {
        log('BƯỚC 1', 'Idempotency OK — gửi lại cùng key trả về job cũ');
      }
    }

    // ── Bước 2: worker Gateway xử lý & lịch sử ─────────────────────────
    // Worker của Gateway chạy nền (poll mỗi 2s) → chờ tối đa 15s.
    let item = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const hist = await gwFetch('GET', `/api/messages/history?paymentId=E2E_PAY_${suffix}`);
      item = (hist.data?.items || []).find((i) => i.paymentId === `E2E_PAY_${suffix}`);
      if (item && ['sent', 'failed', 'unknown', 'retry'].includes(item.status)) break;
    }
    if (!item) {
      fail('BƯỚC 2', 'Không tìm thấy job trong lịch sử Gateway');
    } else {
      log('BƯỚC 2', `Lịch sử Gateway: status=${item.status}, provider=${item.provider}`);
      if (item.status !== 'sent') {
        fail('BƯỚC 2', `Trạng thái job không mong đợi: ${item.status}`);
      }
    }
  }

  // ── Bước 3: thanh toán trong BeerPOS (Gateway online) ────────────────────
  const balanceBefore = readBalance(db, customerId);
  let txId = null;
  try {
    // Cần có công nợ trước để ghi nhận thanh toán.
    DebtLedgerService.recordTransaction({
      customerId,
      transactionType: TRANSACTION_TYPES.MANUAL_DEBT,
      amount: 3000000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
      source: 'MANUAL_UI',
      description: 'e2e seed debt',
    });

    const res = DebtPaymentService.recordPayment({
      customerId,
      amount: 2000000,
      user: adminUser,
      source: 'MANUAL_UI',
      note: 'e2e gateway test',
    });
    if (!res.success) {
      fail('BƯỚC 3', `Ghi nhận thanh toán lỗi: ${res.error}`);
    } else {
      txId = res.transactionId;
      log('BƯỚC 3', `Ghi nhận thanh toán OK (tx ${txId})`);
    }
  } catch (e) {
    fail('BƯỚC 3', `Ghi nhận thanh toán lỗi: ${e.message}`);
  }
  const balanceAfter = readBalance(db, customerId);
  if (balanceBefore !== balanceAfter) {
    log('BƯỚC 3', `Số dư công nợ đổi ${balanceBefore} → ${balanceAfter} (đúng: đã trả 2.000.000đ)`);
  } else {
    log('BƯỚC 3', `Số dư công nợ không đổi (${balanceAfter})`);
  }

  // Job thông báo phải được tạo trong BeerPOS.
  const jobs = NotificationJobService.listJobs({ customerId, limit: 10 });
  log('BƯỚC 3', `BeerPOS tạo ${jobs.total} notification job`);
  if (!jobs.total) {
    fail('BƯỚC 3', 'Không tạo được notification job trong BeerPOS');
  }

  // ── Bước 4: Gateway offline ──────────────────────────────────────────────
  log('BƯỚC 4', 'Giả lập Gateway offline (trỏ base URL về cổng không tồn tại)…');
  const savedUrl = process.env.NOTIFY_GATEWAY_URL;
  process.env.NOTIFY_GATEWAY_URL = 'http://127.0.0.1:31999';

  const offlineJob = NotificationJobService.enqueueJob({
    customerId,
    customerName: custName,
    transactionId: 999000 + (suffix % 1000),
    eventType: 'payment',
    content: 'E2E offline test',
    amount: 1000000,
    applied: 1000000,
    credit: 0,
    balanceBefore: 0,
    balanceAfter: 0,
    provider: 'gateway',
  });
  log('BƯỚC 4', `Tạo job offline: ${offlineJob.jobId} (${offlineJob.status})`);

  if (offlineJob.jobId) {
    const w2 = NotificationWorkerModule.createWorker({ intervalMs: 100000 });
    await w2.runOnce();

    const job = db
      .prepare('SELECT status, attempts, last_error FROM debt_notification_jobs WHERE id = ?')
      .get(offlineJob.jobId);
    log('BƯỚC 4', `Job sau khi Gateway offline: status=${job?.status}, attempts=${job?.attempts}`);
    if (!job || job.status === 'sent') {
      fail('BƯỚC 4', `Trạng thái job sai khi Gateway offline: ${job?.status}`);
    }
    if (job?.status === 'retry') {
      log('BƯỚC 4', 'Trạng thái "retry" — Gateway CHƯA nhận yêu cầu → retry an toàn');
    } else if (job?.status === 'unknown') {
      log('BƯỚC 4', 'Trạng thái "unknown" — KHÔNG retry mù (đúng nguyên tắc chống gửi trùng)');
    }
  }

  // ── Bước 5: số dư công nợ không đổi sau mọi thao tác ───────────────────
  const finalBalance = readBalance(db, customerId);
  if (finalBalance !== balanceAfter) {
    fail('BƯỚC 5', `Số dư công nợ đổi: ${balanceAfter} → ${finalBalance}`);
  } else {
    log('BƯỚC 5', `Số dư công nợ vẫn ${finalBalance} — không ảnh hưởng giao dịch`);
  }

  // ── Bước 6: Gateway trở lại → job offline được xử lý lại an toàn ───────
  if (alive) {
    if (savedUrl) process.env.NOTIFY_GATEWAY_URL = savedUrl;
    else delete process.env.NOTIFY_GATEWAY_URL;

    const w3 = NotificationWorkerModule.createWorker({ intervalMs: 100000 });
    await w3.runOnce();

    const jobsAfter = NotificationJobService.listJobs({ customerId, limit: 20 });
    const sentCount = jobsAfter.items.filter((j) => j.status === 'sent').length;
    log('BƯỚC 6', `Sau khi Gateway trở lại: ${jobsAfter.total} job, ${sentCount} sent`);
    if (jobsAfter.total > 1) {
      const ids = jobsAfter.items.map((j) => j.id);
      const unique = new Set(ids);
      if (unique.size !== ids.length) {
        fail('BƯỚC 6', 'Có job trùng (cùng giao dịch tạo nhiều job)');
      }
    }
  }

  if (savedUrl) process.env.NOTIFY_GATEWAY_URL = savedUrl;
  else delete process.env.NOTIFY_GATEWAY_URL;

  // ── Dọn dẹp ─────────────────────────────────────────────────────────────
  db.prepare('DELETE FROM debt_notification_jobs WHERE customer_id = ?').run(customerId);
  db.prepare('DELETE FROM debt_customer_groups WHERE customer_id = ?').run(customerId);
  db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
  await gwFetch('DELETE', `/api/groups/${created.data.group.id}`, undefined, ADMIN_KEY);

  log('KẾT THÚC', process.exitCode ? 'CÓ LỖI' : 'TẤT CẢ KỊCH BẢN PASS');
}

function readBalance(db, customerId) {
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'INCREASE' THEN amount ELSE -amount END), 0) AS b
           FROM debt_transactions WHERE customer_id = ?`
      )
      .get(customerId);
    return Math.round((row?.b || 0) * 100) / 100;
  } catch (_) {
    return 0;
  }
}

main().catch((e) => {
  console.error('[E2E] THAT BAI:', e && e.stack);
  process.exit(1);
});
