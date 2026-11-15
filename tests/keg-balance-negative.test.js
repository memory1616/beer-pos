/**
 * KEG BALANCE — Số vỏ rỗng CHO PHÉP ÂM
 * ─────────────────────────────────────────────────────────────────────────────
 * Nghiệp vụ (yêu cầu 2026-11-15):
 *
 *   Tôi có 500 vỏ rỗng trong kho. Tôi đi lấy 1000 vỏ BIA ĐẦY về từ nhà máy
 *   → dùng 500 vỏ rỗng để đổi, còn 500 vỏ đã lấy về nhưng CHƯA ĐƯỢC ĐỔI
 *   (tạm ứng trước nhà máy) → số vỏ rỗng = 500 - 1000 = **-500**.
 *
 *   Số âm được BÙ về 0 khi khách trả vỏ rỗng (mỗi vỏ +1).
 *
 * Kiểm tra:
 *   A. KegBalanceService — đọc/ghi/cộng số âm đúng
 *   B. Không còn chỗ nào CẮT CHẶN ở 0 (Math.max(0, ...) trên empty_collected)
 *   C. Tổng vỏ bình được BẢO TOÀN khi lấy vỏ đầy về (kho +1000, rỗng -1000)
 *   D. Giao diện hiển thị số âm (dashboard + màn Quản lý vỏ)
 */
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');

const db = require('../database');
const KegBalanceService = require('../src/services/KegBalanceService');

jest.setTimeout(20000);

const ROOT = path.join(__dirname, '..');

/** Đọc số vỏ rỗng trực tiếp từ DB (không qua service) để kiểm chứng độc lập. */
const readRaw = () => db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get().empty_collected;

let savedEmpty = 0;

beforeAll(() => {
  savedEmpty = readRaw();
});

afterAll(() => {
  // Khôi phục số liệu gốc
  try {
    db.prepare('UPDATE keg_stats SET empty_collected = ? WHERE id = 1').run(savedEmpty);
  } catch (_) {
    /* ignore */
  }
  try {
    db.close();
  } catch (_) {
    /* ignore */
  }
});

beforeEach(() => {
  KegBalanceService.setEmptyCollected(500);
});

// ═══════════════════════════════════════════════════════════════════════════
// A. KegBalanceService
// ═══════════════════════════════════════════════════════════════════════════
describe('KegBalanceService — số vỏ rỗng âm', () => {
  test('setEmptyCollected() ghi được số ÂM', () => {
    KegBalanceService.setEmptyCollected(-500);
    expect(readRaw()).toBe(-500);
    expect(KegBalanceService.getEmptyCollected()).toBe(-500);
  });

  test('setEmptyCollected() làm tròn về số nguyên', () => {
    KegBalanceService.setEmptyCollected(-500.7);
    expect(readRaw()).toBe(-501);
  });

  test('setEmptyCollected() với giá trị rác → 0 (không phải NaN)', () => {
    KegBalanceService.setEmptyCollected('abc');
    expect(readRaw()).toBe(0);
  });

  test('addEmptyCollected() cộng dần về 0 từ số âm (bù nợ nhà máy)', () => {
    KegBalanceService.setEmptyCollected(-500);
    // Thu vỏ rỗng từ khách 1 lần → +500
    KegBalanceService.addEmptyCollected(500);
    expect(readRaw()).toBe(0);
  });

  test('addEmptyCollected() bù từng phần: -500 → +100 = -400', () => {
    KegBalanceService.setEmptyCollected(-500);
    KegBalanceService.addEmptyCollected(100);
    expect(readRaw()).toBe(-400);
  });

  test('peekEmptyCollected() KHÔNG ghi DB (chỉ tính trước)', () => {
    const result = KegBalanceService.peekEmptyCollected(-1000);
    expect(result).toBe(-500); // 500 - 1000 = -500
    expect(readRaw()).toBe(500); // DB không đổi
  });

  test('kịch bản thực tế: 500 rỗng → lấy 1000 vỏ đầy về → -500', () => {
    // Kho đầy +1000 (vỏ lấy về)
    const inventoryBefore = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get().total;

    // Nhập hàng: 1000 vỏ đầy về = 1000 vỏ rỗng đi kèm (đi đổi)
    const newEmpty = KegBalanceService.peekEmptyCollected(-1000);
    expect(newEmpty).toBe(-500);
    KegBalanceService.setEmptyCollected(newEmpty);

    expect(readRaw()).toBe(-500);
    expect(inventoryBefore).toBeGreaterThanOrEqual(0);
  });

  test('bù dần: khách trả 200 vỏ rỗng → -500 → -300', () => {
    KegBalanceService.setEmptyCollected(-500);
    KegBalanceService.addEmptyCollected(200);
    expect(readRaw()).toBe(-300);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Không còn cắt chặn ở 0
// ═══════════════════════════════════════════════════════════════════════════
describe('Không còn chỗ nào cắt chặn số vỏ rỗng ở 0', () => {
  const files = [
    'routes/api/kegs.js',
    'routes/api/purchases.js',
    'routes/api/stock.js',
    'routes/api/sales.js',
    'routes/api/customers.js',
    'src/services/DeliveryService.js',
    'src/services/KegReceiptService.js',
    'src/services/saleDelete.js',
  ];

  test.each(files)('%s không clamp số vỏ rỗng ở 0', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // Số vỏ rỗng KHÔNG được clamp: không có biểu thức dạng
    //   newEmpty = Math.max(0, ...)   hoặc   Math.max(0, currentEmpty ...)
    const offenders = src
      .split('\n')
      .filter((l) => /Math\.max\(\s*0\s*,/.test(l))
      .filter((l) => /newEmpty|emptyCollected\s*=|currentEmpty|empty_collected/i.test(l))
      .filter((l) => !/Math\.min\(/.test(l)); // Math.min bên trong là hợp lệ
    expect(offenders).toEqual([]);
  });

  test('routes/api/kegs.js: updateEmptyCollected() không cắt ở 0', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes/api/kegs.js'), 'utf8');
    const fn = src.slice(src.indexOf('function updateEmptyCollected('), src.indexOf('function getActualInventory('));
    expect(fn).not.toContain('Math.max(0');
    expect(fn).toContain('KegBalanceService.setEmptyCollected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Tổng vỏ bình bảo toàn
// ═══════════════════════════════════════════════════════════════════════════
describe('Tổng vỏ bình bảo toàn', () => {
  test('lấy 1000 vỏ đầy về (kho +1000) và rỗng -1000 → tổng không đổi', () => {
    KegBalanceService.setEmptyCollected(500);

    const invBefore = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get().total;
    const emptyBefore = KegBalanceService.getEmptyCollected();
    const totalBefore = invBefore + emptyBefore;

    // Vỏ đầy về: kho +1000
    const kegProduct = db.prepare("SELECT id FROM products WHERE type = 'keg' LIMIT 1").get();
    expect(kegProduct).toBeTruthy();
    db.prepare('UPDATE products SET stock = stock + 1000 WHERE id = ?').run(kegProduct.id);

    // Vỏ rỗng đi kèm: -1000
    KegBalanceService.addEmptyCollected(-1000);

    const invAfter = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get().total;
    const emptyAfter = KegBalanceService.getEmptyCollected();
    const totalAfter = invAfter + emptyAfter;

    expect(emptyAfter).toBe(-500);
    expect(totalAfter).toBe(totalBefore); // bảo toàn

    // Rollback
    db.prepare('UPDATE products SET stock = stock - 1000 WHERE id = ?').run(kegProduct.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Giao diện hiển thị số âm
// ═══════════════════════════════════════════════════════════════════════════
describe('Giao diện hiển thị số vỏ rỗng âm', () => {
  test('dashboard: có xử lý số âm (tô đỏ + tooltip)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/dashboard.js'), 'utf8');
    const seg = src.slice(src.indexOf('kegEmptyCollected'), src.indexOf('kegEmptyCollected') + 1500);
    expect(seg).toContain('emptyCollected < 0');
    expect(seg).toContain('tạm ứng');
  });

  test('views/kegs.html: ô nhập điều chỉnh cho phép số âm', () => {
    const src = fs.readFileSync(path.join(ROOT, 'views/kegs.html'), 'utf8');
    const inputLine = src.split('\n').find((l) => l.includes('id="adjustQty"'));
    expect(inputLine).toBeTruthy();
    expect(inputLine).not.toContain('min="0"');
    expect(inputLine).toContain('step="1"');
  });

  test('views/kegs.html: submitAdjust() không chặn số âm', () => {
    const src = fs.readFileSync(path.join(ROOT, 'views/kegs.html'), 'utf8');
    const fn = src.slice(src.indexOf('function submitAdjust('), src.indexOf('// ========== INIT'));
    expect(fn).not.toMatch(/qty\s*<\s*0/);
  });

  test('views/kegs.html: hiển thị nhãn "Tạm ứng trước nhà máy" khi âm', () => {
    const src = fs.readFileSync(path.join(ROOT, 'views/kegs.html'), 'utf8');
    expect(src).toContain('Tạm ứng trước nhà máy');
  });
});
