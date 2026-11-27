/**
 * Point-in-time: so lieu KM san luong tren modal hoa don phai dung
 * voi thoi diem cua chinh don do.
 */
process.env.TZ = 'Asia/Ho_Chi_Minh';

const db = require('../database');
const { PromotionService } = require('../src/services');

const CUST = 990501;
const GOLD = 990502;
const BLACK = 990503;

function setup() {
  db.prepare(
    "INSERT OR REPLACE INTO customers (id, name, created_at, promotion_enabled, reward_enabled, new_shop_enabled) VALUES (?, 'PT Customer', '2020-01-01 00:00:00', 1, 1, 1)"
  ).run(CUST);
  db.prepare(
    "INSERT OR IGNORE INTO products (id, name, slug, type, archived, stock, cost_price) VALUES (?, 'Bia Vang PT', 'bia-vang-pt', 'keg', 0, 1000, 1000)"
  ).run(GOLD);
  db.prepare(
    "INSERT OR IGNORE INTO products (id, name, slug, type, archived, stock, cost_price) VALUES (?, 'Bia Den PT', 'bia-den-pt', 'keg', 0, 1000, 1000)"
  ).run(BLACK);
}

function cleanup() {
  db.prepare('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id = ?)').run(CUST);
  db.prepare('DELETE FROM sales WHERE customer_id = ?').run(CUST);
  db.prepare('DELETE FROM customer_monthly_stats WHERE customer_id = ?').run(CUST);
  db.prepare('DELETE FROM reward_history WHERE customer_id = ?').run(CUST);
  db.prepare('DELETE FROM pending_rewards WHERE customer_id = ?').run(CUST);
  db.prepare('DELETE FROM customers WHERE id = ?').run(CUST);
}

function makeSale(dateStr, timeStr, yellow, black) {
  const res = db.prepare(
    "INSERT INTO sales (customer_id, date, sale_time, total, profit, type, archived) VALUES (?, ?, ?, 0, 0, 'sale', 0)"
  ).run(CUST, dateStr, timeStr);
  const saleId = res.lastInsertRowid;
  if (yellow > 0) {
    db.prepare(
      "INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit) VALUES (?, ?, 'bia-vang-pt', ?, 100, 100, 0)"
    ).run(saleId, GOLD, yellow);
  }
  if (black > 0) {
    db.prepare(
      "INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit) VALUES (?, ?, 'bia-den-pt', ?, 100, 100, 0)"
    ).run(saleId, BLACK, black);
  }
  return saleId;
}

beforeAll(() => { cleanup(); setup(); });
afterAll(() => { cleanup(); });

describe('getVolumePromoSnapshotForSale - point-in-time', () => {
  test('tich luys tinh theo don truoc do, khong tinh don sau do', () => {
    cleanup();
    setup();

    const month = '2026-11';
    const s1 = makeSale(`${month}-05`, '09:00:00', 100, 0);
    const s2 = makeSale(`${month}-10`, '09:00:00', 200, 0);

    const snap = PromotionService.getVolumePromoSnapshotForSale(s1);
    expect(snap).not.toBeNull();
    expect(snap.monthlyReward).not.toBeNull();
    // Chi tinh don truoc s1 -> 100L (khong ke 200L cua don sau)
    expect(snap.monthlyReward.yellowVolume).toBe(100);
    expect(snap.monthlyReward.blackVolume).toBe(0);
    expect(snap.monthlyReward.totalVolume).toBe(100);

    // Don thu 2: tich luys = 100 (truoc) + 200 (cua chinh no) = 300
    const snap2 = PromotionService.getVolumePromoSnapshotForSale(s2);
    expect(snap2.monthlyReward.yellowVolume).toBe(300);
    expect(snap2.monthlyReward.totalVolume).toBe(300);
  });

  test('mo lai don cu van hien dung so lieu luc tao (khong bi so lieu hien tai)', () => {
    cleanup();
    setup();

    const month = '2026-11';
    const s1 = makeSale(`${month}-05`, '09:00:00', 100, 0);
    // Don sau do lam tang san luong len 500L
    makeSale(`${month}-20`, '09:00:00', 400, 0);

    const snap = PromotionService.getVolumePromoSnapshotForSale(s1);
    expect(snap.monthlyReward.totalVolume).toBe(100);
    expect(snap.monthlyReward.yellowReward).toBe(0);
  });

  test('don trong cung thoi diem: don cung id duoc tinh, don lon id hon thi khong', () => {
    cleanup();
    setup();

    const month = '2026-11';
    const s1 = makeSale(`${month}-05`, '09:00:00', 100, 0);
    const s2 = makeSale(`${month}-05`, '09:00:00', 200, 0);

    const snap1 = PromotionService.getVolumePromoSnapshotForSale(s1);
    expect(snap1.monthlyReward.totalVolume).toBe(100);

    const snap2 = PromotionService.getVolumePromoSnapshotForSale(s2);
    expect(snap2.monthlyReward.totalVolume).toBe(300);
  });

  test('bao cao thuong dung thang duoc thuong (thang truoc) cho don MONTHLY_BONUS', () => {
    cleanup();
    setup();

    // San luong thang 10: 500L vang -> 40L thuong
    makeSale('2026-10-10', '09:00:00', 500, 0);

    // Don thuong nam thang 11
    const rewardSale = db.prepare(
      "INSERT INTO sales (customer_id, date, sale_time, total, profit, type, archived, promo_type, reward_liters_used) VALUES (?, '2026-11-02', '08:00:00', 0, 0, 'sale', 0, 'MONTHLY_BONUS', 40)"
    ).run(CUST);
    const rid = rewardSale.lastInsertRowid;

    const snap = PromotionService.getVolumePromoSnapshotForSale(rid);
    expect(snap.isRewardSale).toBe(true);
    // Thang hien thi = thang duoc thuong = 10/2026
    expect(snap.month).toBe(10);
    expect(snap.year).toBe(2026);
    // So lieu tich luys = ca thang 10 (trong thuong, khong cutoff)
    expect(snap.monthlyReward.totalVolume).toBe(500);
    expect(snap.monthlyReward.yellowReward).toBe(40);
  });

  test('getSaleTimestamp xu ly du lieu cu va moi', () => {
    const svc = PromotionService;
    expect(svc.getSaleTimestamp({ date: '2026-03-08 01:42:44', sale_time: null }))
      .toBe('2026-03-08 01:42:44');
    expect(svc.getSaleTimestamp({ date: '2026-08-08', sale_time: '19:23:54' }))
      .toBe('2026-08-08 19:23:54');
    expect(svc.getSaleTimestamp({ date: '2026-08-08', sale_time: '19:23' }))
      .toBe('2026-08-08 19:23:00');
    expect(svc.getSaleTimestamp({ date: '2026-08-08', sale_time: null }))
      .toBe('2026-08-08 00:00:00');
  });

  test('calculateMonthlyRewardAt khong cutoff = toan thang (dung cho bao cao)', () => {
    cleanup();
    setup();

    makeSale('2026-11-05', '09:00:00', 100, 0);
    makeSale('2026-11-20', '09:00:00', 400, 0);

    const r = PromotionService.calculateMonthlyRewardAt(CUST, { year: 2026, month: 11 });
    expect(r.totalVolume).toBe(500);
  });

  test('calculateMonthlyReward van hoat dong nhu truoc (backward compat)', () => {
    cleanup();
    setup();

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    makeSale(`${y}-${m}-05`, '09:00:00', 320, 0);

    const r = PromotionService.calculateMonthlyReward(CUST);
    expect(r.totalVolume).toBe(320);
    expect(r.yellowReward).toBe(20);
  });
});
