/**
 * CANH BAO DOANH SO — LOAI KHACH MO QUAN TRONG KY DANH GIA (2026-11-23)
 * -----------------------------------------------------------------------------
 * BUG DA GAP:
 *  Dashboard hien "Canh bao doanh so N" danh cho khach MO QUAN trong thang.
 *  Vi du production (23/11/2026): 4 khach mo quan trong thang 11
 *  (ID 57, 58, 61, 63) deu bi canh bao "thieu hut 300 binh" vi thang
 *  truoc (10/2026) ho chua co don nao.
 *
 *  Day la canh bao SAI — khach moi chua co co hoi mua trong ky danh gia.
 *
 * FIX:
 *  `PreOrderSQL.newShopExcludeFilter(alias, periodStart)` — dieu kien SQL
 *  loai khach co `created_at >= ngay dau ky danh gia` (khach mo quan trong
 *  hoac sau ky danh gia).
 *
 * CAH KIEM CHUNG:
 *  W1. Helper SQL dung cau truc dung.
 *  W2. Khach cu (created_at truoc ky) VAN duoc canh bao.
 *  W3. Khach moi trong ky danh gia -> KHONG canh bao.
 *  W4. Khach moi sau ky danh gia -> KHONG canh bao.
 *  W5. Khach co `exclude_expected = 1` -> van duoc loai (giu nguyen hanh vi).
 *  W6. Query kpiAlerts cua dashboard loai dung khach quan moi.
 */
process.env.NODE_ENV = 'test';

const db = require('../database');
const PreOrderSQL = require('../src/services/PreOrderSQL');

jest.setTimeout(30000);

const PERIOD_START = '2026-10-01';

function createCustomer(name, createdAt) {
  const r = db
    .prepare(
      `INSERT INTO customers (name, phone, deposit, keg_balance, created_at, archived)
       VALUES (?, ?, 0, 0, ?, 0)`
    )
    .run(name, '09' + Math.floor(10000000 + Math.random() * 89999999), createdAt);
  return r.lastInsertRowid;
}

function cleanup(ids) {
  for (const id of ids) {
    db.prepare('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id = ?)').run(id);
    db.prepare('DELETE FROM sales WHERE customer_id = ?').run(id);
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  }
}

// ── W1: hinh thuc cu dieu kien SQL ──────────────────────────────────────────

describe('PreOrderSQL.newShopExcludeFilter', () => {
  test('W1a: co so sanh created_at voi tham so ngay', () => {
    const f = PreOrderSQL.newShopExcludeFilter('c', PERIOD_START);
    expect(f).toContain('c.created_at');
    expect(f).toContain('date(?)');
  });

  test('W1b: khong alias -> khong co prefix bang', () => {
    const f = PreOrderSQL.newShopExcludeFilter('', PERIOD_START);
    expect(f).not.toContain('c.');
    expect(f).toContain('created_at');
  });

  test('W1c: khach khong co created_at van duoc canh bao (NULL -> giu)', () => {
    const f = PreOrderSQL.newShopExcludeFilter('c', PERIOD_START);
    expect(f).toContain('created_at IS NULL');
  });
});

// ── W2/W3/W4: tinh huong du lieu that ───────────────────────────────────────

describe('canh bao doanh so — loai khach mo quan', () => {
  const ids = [];

  afterAll(() => cleanup(ids));

  /** Chạy query kpiAlerts (giai lap y het routes/dashboard.js). */
  function runKpiAlerts(periodStart, periodEnd, monthlyExpected = 300) {
    return db
      .prepare(
        `SELECT c.id, c.name,
            COALESCE(mc.prev_month_qty, 0) as prev_month_qty,
            ROUND(?) - COALESCE(mc.prev_month_qty, 0) as shortfall
          FROM customers c
          LEFT JOIN (
            SELECT s.customer_id, SUM(si.quantity) as prev_month_qty
            FROM sales s
            JOIN sale_items si ON si.sale_id = s.id
            WHERE s.type = 'sale' AND s.archived = 0 AND date(s.date) >= ? AND date(s.date) <= ?
            GROUP BY s.customer_id
          ) mc ON mc.customer_id = c.id
          WHERE c.archived = 0
            AND (c.exclude_expected IS NULL OR c.exclude_expected = 0)
            AND ${PreOrderSQL.newShopExcludeFilter('c', periodStart)}
            AND ROUND(?) - COALESCE(mc.prev_month_qty, 0) > 0
          ORDER BY shortfall DESC
          LIMIT 10`
      )
      .all(monthlyExpected, periodStart, periodEnd, periodStart, monthlyExpected)
      .map((r) => r.id);
  }

  /**
   * Giong y het query tren NHUNG chi xet cac khach test vua tao
   * (tranh bi anh huong cua LIMIT 10 va du lieu khach that trong DB test).
   */
  function runKpiAlertsForTestCustomers(periodStart, periodEnd, ids, monthlyExpected = 300) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db
      .prepare(
        `SELECT c.id,
            ROUND(?) - COALESCE(mc.prev_month_qty, 0) as shortfall
          FROM customers c
          LEFT JOIN (
            SELECT s.customer_id, SUM(si.quantity) as prev_month_qty
            FROM sales s
            JOIN sale_items si ON si.sale_id = s.id
            WHERE s.type = 'sale' AND s.archived = 0 AND date(s.date) >= ? AND date(s.date) <= ?
            GROUP BY s.customer_id
          ) mc ON mc.customer_id = c.id
          WHERE c.id IN (${placeholders})
            AND c.archived = 0
            AND (c.exclude_expected IS NULL OR c.exclude_expected = 0)
            AND ${PreOrderSQL.newShopExcludeFilter('c', periodStart)}
            AND ROUND(?) - COALESCE(mc.prev_month_qty, 0) > 0`
      )
      .all(monthlyExpected, periodStart, periodEnd, ...ids, periodStart, monthlyExpected)
      .map((r) => r.id);
  }

  test('W2: khach cu (created_at truoc ky danh gia) VAN duoc canh bao', () => {
    const id = createCustomer('TEST KHACH CU', '2026-05-01 08:00:00');
    ids.push(id);
    const alerted = runKpiAlertsForTestCustomers(PERIOD_START, '2026-10-31', [id]);
    expect(alerted).toContain(id);
  });

  test('W3: khach MO QUAN trong ky danh gia -> KHONG canh bao', () => {
    const id = createCustomer('TEST KHACH MO QUAN TRONG KY', '2026-10-05 08:00:00');
    ids.push(id);
    const alerted = runKpiAlertsForTestCustomers(PERIOD_START, '2026-10-31', [id]);
    expect(alerted).not.toContain(id);
  });

  test('W4: khach mo quan SAU ky danh gia -> KHONG canh bao', () => {
    const id = createCustomer('TEST KHACH MO QUAN SAU KY', '2026-11-01 08:00:00');
    ids.push(id);
    const alerted = runKpiAlertsForTestCustomers(PERIOD_START, '2026-10-31', [id]);
    expect(alerted).not.toContain(id);
  });

  test('W5: khach exclude_expected = 1 van duoc loai', () => {
    const id = createCustomer('TEST KHACH EXCLUDE', '2026-05-01 08:00:00');
    ids.push(id);
    db.prepare('UPDATE customers SET exclude_expected = 1 WHERE id = ?').run(id);
    const alerted = runKpiAlertsForTestCustomers(PERIOD_START, '2026-10-31', [id]);
    expect(alerted).not.toContain(id);
  });

  test('W6: query that voi LIMIT 10 van chay dung (khong loi SQL)', () => {
    // Bao dam cau truc query moi (co placeholder `?` cho filter) hop le.
    expect(() => runKpiAlerts(PERIOD_START, '2026-10-31')).not.toThrow();
  });
});

// ── W6: routes/dashboard.js da dung helper ──────────────────────────────────

describe('routes/dashboard.js — ap dung filter quan moi', () => {  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'dashboard.js'), 'utf8');

  test('W6a: import newShopExcludeFilter', () => {
    expect(src).toContain("require('../src/services/PreOrderSQL')");
  });

  test('W6b: kpiAlerts dung filter', () => {
    expect(src).toContain("newShopExcludeFilter('c', prevMonthStart)");
  });

  test('W6c: customerAlerts (lau khong dat hang) cung dung filter', () => {
    expect(src).toContain("newShopExcludeFilter('', monthStartStr)");
  });

  test('W7d: routes/api/customers.js ap dung filter cho endpoint alerts', () => {
    const src2 = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api', 'customers.js'), 'utf8');
    expect(src2).toContain("PreOrderSQL.newShopExcludeFilter('c', monthStartStr)");
  });
});
