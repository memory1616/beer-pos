/**
 * TỰ ĐỘNG GÁN AGENT VÀO NHÓM ZALO KHI LIÊN KẾT
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh (2026-11-26):
 *  - Nhóm Zalo liên kết trong Sổ công nợ nhưng agent chưa có quyền → mọi tin
 *    thông báo công nợ bị OmiCall từ chối với `error_occurred`.
 *  - Trước đây admin phải tự vào web app OmiCall để gán tay → rất dễ quên.
 *  - Fix: khi `POST /api/debt-ledger/groups` → tự gán agent vào nhóm.
 *
 * Điểm kỹ thuật quan trọng (đã kiểm chứng trực tiếp với server OmiCall):
 *  - `POST /conversation/add_member` (body `{type, conv, contact_ids}`) trả 200
 *    + `payload: true` nhưng **KHÔNG đổi** trạng thái nhóm → vô dụng.
 *  - `POST /conversation/add_member_from_list` với
 *    `{ id, assign_agent_option: { ids: [contact_id], agent_groups: [],
 *      priority_agent_of_contact: null, allocate_type: 'SPECIFIC' } }`
 *    mới thực sự gán agent (has_member false→true, joined_agents null→[id]).
 *  - `POST /conversation/redistribute_from_list` với `redistribute_type:'remove'`
 *    thì **GỠ agent** khỏi nhóm → phải tránh.
 */
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const db = require('../../database');

jest.setTimeout(25000);

const OMI_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'services', 'OmiCallService.js'),
  'utf8'
);
const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'routes', 'api', 'debtLedger.js'),
  'utf8'
);

// ── App test ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const username = req.headers['x-test-user'];
  if (username) {
    req.user = {
      username: String(username),
      role: req.headers['x-test-role'] || 'ADMIN',
    };
  }
  next();
});
app.use('/api/debt-ledger', require('../../routes/api/debtLedger'));

const ADMIN = { 'x-test-user': 'admin', 'x-test-role': 'ADMIN' };

// ── Mock OmiCallService ─────────────────────────────────────────────────────
// Dùng spyOn (không jest.mock factory) vì route gọi `OmiCallService.assignAgentToGroup(...)`
// theo thuộc tính → spy ở runtime có hiệu lực.
const OmiCallService = require('../../src/services/OmiCallService');
const assignMock = jest.fn();

beforeAll(() => {
  jest.spyOn(OmiCallService, 'assignAgentToGroup').mockImplementation((...args) => assignMock(...args));
});

afterAll(() => {
  jest.restoreAllMocks();
});

let seq = 0;
function makeCustomer() {
  seq += 1;
  const name = `Test KH AutoAgent ${seq}`;
  const r = db
    .prepare('INSERT INTO customers (name, phone, address) VALUES (?, ?, ?)')
    .run(name, `09${String(seq).padStart(8, '0')}`, 'Test');
  return r.lastInsertRowid;
}

beforeEach(() => {
  assignMock.mockReset();
  assignMock.mockResolvedValue({ assigned: true });
});

afterEach(() => {
  db.prepare("DELETE FROM debt_customer_groups WHERE group_id LIKE 'g_auto_%'").run();
  db.prepare("DELETE FROM customers WHERE name LIKE 'Test KH AutoAgent %'").run();
});

// ═══════════════════════════════════════════════════════════════════════════
describe('OmiCallService — route gán agent ĐÚNG', () => {
  test('dùng add_member_from_list, KHÔNG dùng add_member', () => {
    expect(OMI_SRC).toMatch(/conversation\/add_member_from_list/);
    // Đảm bảo KHÔNG còn gọi add_member (nó không thay đổi trạng thái nhóm)
    const fn = OMI_SRC.slice(OMI_SRC.indexOf('async function ensureAgentInGroup'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).not.toMatch(/conversation\/add_member\?/);
  });

  test('body gồm assign_agent_option.ids + allocate_type SPECIFIC', () => {
    expect(OMI_SRC).toMatch(/assign_agent_option:\s*\{/);
    expect(OMI_SRC).toMatch(/ids:\s*\[contactId\]/);
    expect(OMI_SRC).toMatch(/allocate_type:\s*'SPECIFIC'/);
  });

  test('TUYỆT ĐỐI KHÔNG dùng redistribute_type remove (gỡ agent)', () => {
    const fn = OMI_SRC.slice(OMI_SRC.indexOf('async function ensureAgentInGroup'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).not.toMatch(/redistribute_from_list/);
    expect(body).not.toMatch(/redistribute_type:\s*'remove'/);
  });
  test('export hàm assignAgentToGroup', () => {
    expect(OMI_SRC).toMatch(/async function assignAgentToGroup/);
    expect(OMI_SRC).toMatch(/assignAgentToGroup,/);
  });

  test('có bước 2: join session qua omi_v2/conversation/join', () => {
    expect(OMI_SRC).toMatch(/omi_v2\/conversation\/join/);
    expect(OMI_SRC).toMatch(/type:\s*'omni_conv'/);
    expect(OMI_SRC).toMatch(/kind:\s*'zalo_personal'/);
    expect(OMI_SRC).toMatch(/isEnableSession:\s*true/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/debt-ledger/groups — tự động gán agent', () => {
  test('liên kết nhóm → gọi assignAgentToGroup với groupId', async () => {
    const cid = makeCustomer();
    const gid = `g_auto_${seq}`;

    const res = await request(app)
      .post('/api/debt-ledger/groups')
      .set(ADMIN)
      .send({ customerId: cid, groupId: gid, groupName: 'Nhóm test' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(assignMock).toHaveBeenCalledWith(gid);
    expect(res.body.data.agentAssigned).toBe(true);
  });

  test('gán thất bại → vẫn liên kết được (fail-open), báo agentAssigned=false', async () => {
    assignMock.mockResolvedValue({ assigned: false, reason: 'OmiCall không xác nhận' });
    const cid = makeCustomer();
    const gid = `g_auto_fail_${seq}`;

    const res = await request(app)
      .post('/api/debt-ledger/groups')
      .set(ADMIN)
      .send({ customerId: cid, groupId: gid });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.agentAssigned).toBe(false);
    expect(res.body.data.agentAssignNote).toMatch(/không xác nhận/i);

    const row = db.prepare('SELECT * FROM debt_customer_groups WHERE group_id = ?').get(gid);
    expect(row).toBeTruthy();
    expect(row.customer_id).toBe(cid);
  });

  test('assignAgentToGroup ném lỗi → vẫn liên kết được (fail-open)', async () => {
    assignMock.mockRejectedValue(new Error('mạng lỗi'));
    const cid = makeCustomer();
    const gid = `g_auto_throw_${seq}`;

    const res = await request(app)
      .post('/api/debt-ledger/groups')
      .set(ADMIN)
      .send({ customerId: cid, groupId: gid });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.agentAssigned).toBe(false);

    const row = db.prepare('SELECT * FROM debt_customer_groups WHERE group_id = ?').get(gid);
    expect(row).toBeTruthy();
  });

  test('liên kết lại nhóm đã có → vẫn gán agent (idempotent)', async () => {
    const cid = makeCustomer();
    const gid = `g_auto_re_${seq}`;

    await request(app)
      .post('/api/debt-ledger/groups')
      .set(ADMIN)
      .send({ customerId: cid, groupId: gid });
    await request(app)
      .post('/api/debt-ledger/groups')
      .set(ADMIN)
      .send({ customerId: cid, groupId: gid });

    expect(assignMock).toHaveBeenCalledTimes(2);
    expect(assignMock).toHaveBeenLastCalledWith(gid);
  });

  test('route gọi OmiCallService.assignAgentToGroup', () => {
    expect(ROUTE_SRC).toMatch(/OmiCallService\.assignAgentToGroup/);
  });
});
