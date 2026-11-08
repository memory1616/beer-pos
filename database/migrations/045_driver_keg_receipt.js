/**
 * Migration: Driver Keg Receipt — Phiếu thu vỏ rỗng (045)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu:
 *  1. Bảng `driver_keg_receipts` — PHIẾU THU VỎ do tài xế lập khi thu vỏ
 *     rỗng ngoài chuyến giao (không giao hàng). Phiếu là căn cứ BÁO CÁO
 *     với khách hàng (in / chia sẻ ảnh).
 *  2. Không sửa/xóa dữ liệu kinh doanh hiện có — ADDITIVE thuần túy.
 *
 * Quy ước nghiệp vụ (khớp với luồng phiếu giao hiện có):
 *   • Thu N vỏ rỗng từ khách → `customers.keg_balance` TRỪ N
 *     và `keg_stats.empty_collected` CỘNG N (vỏ rỗng về kho chờ nạp lại).
 *   • `products.stock` (vỏ đầy trong kho) KHÔNG thay đổi.
 *   • Mỗi phiếu ghi đè lại số dư vỏ của khách TRƯỚC / SAU để đối chiếu.
 *
 * ADDITIVE — KHÔNG sửa/xóa dữ liệu kinh doanh hiện có.
 */

const migration = {
  id: 45,
  name: 'driver_keg_receipt',

  up: (db) => {
    // ── driver_keg_receipts ────────────────────────────────────────────────
    // 1 phiếu = 1 lần tài xế thu vỏ rỗng từ 1 khách hàng.
    db.exec(`
      CREATE TABLE IF NOT EXISTS driver_keg_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_no TEXT UNIQUE,
        customer_id INTEGER NOT NULL,
        customer_name TEXT,
        driver_username TEXT NOT NULL,
        kegs INTEGER NOT NULL DEFAULT 0,
        balance_before INTEGER NOT NULL DEFAULT 0,
        balance_after INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_drv_keg_receipts_driver ON driver_keg_receipts(driver_username)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_drv_keg_receipts_customer ON driver_keg_receipts(customer_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_drv_keg_receipts_created ON driver_keg_receipts(created_at)`);
  },

  // Rollback: chỉ xoá bảng phiếu — KHÔNG đụng customers / keg_stats / bảng kinh doanh.
  down: (db) => {
    db.exec(`DROP INDEX IF EXISTS idx_drv_keg_receipts_created`);
    db.exec(`DROP INDEX IF EXISTS idx_drv_keg_receipts_customer`);
    db.exec(`DROP INDEX IF EXISTS idx_drv_keg_receipts_driver`);
    db.exec(`DROP TABLE IF EXISTS driver_keg_receipts`);
  },
};

module.exports = migration;
