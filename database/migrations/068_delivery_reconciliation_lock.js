/**
 * Migration: Đối soát phiếu giao hàng 1 lần + khoá số liệu đã xác nhận (068)
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH (2026-11-23):
 *  Yêu cầu nghiệp vụ:
 *   1. "Mỗi hóa đơn giao hàng chỉ được đối soát một lần."
 *   2. "Không cho sửa số liệu đã xác nhận nếu không có quyền quản lý."
 *
 *  Hiện trạng:
 *   - `delivery_records` KHÔNG có cờ đánh dấu "đã đối soát" → tài xế có
 *     thể bấm "Xác nhận" lại nhiều lần trên cùng 1 phiếu (đã DELIVERED),
 *     mỗi lần ghi đè số lít giao / số vỏ thu → số liệu đã xác nhận bị
 *     sửa vô lý, và có thể ghi bút toán công nợ TRÙNG.
 *   - Không có ranh giới phân quyền khoá số liệu → tài xế (role DRIVER)
 *     vẫn sửa được số liệu của phiếu đã xác nhận.
 *
 * GIẢI PHÁP:
 *  1. Thêm cột `reconciled_at` (TEXT) — thời điểm đối soát lần đầu.
 *     Non-NULL ⇒ phiếu ĐÃ ĐỐI SOÁT → không được đối soát/ghi lại lần 2.
 *  2. Thêm cột `reconciled_by` (TEXT) — username người đối soát (audit).
 *  3. Thêm cột `confirmed_by` (TEXT) — username đã xác nhận số liệu (audit).
 *
 * ADDITIVE — chỉ thêm cột (NULL mặc định → đọc được nhờ fallback).
 * Rollback: chỉ gỡ cột, không đụng dữ liệu kinh doanh.
 */

const migration = {
  id: 68,
  name: 'delivery_reconciliation_lock',

  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(delivery_records)').all().map((c) => c.name);

    // ── 1. reconciled_at — thời điểm đối soát phiếu giao (1 lần duy nhất) ──
    //    NULL ⇒ chưa đối soát. Non-NULL ⇒ đã đối soát → KHÔNG ghi lại.
    if (!cols.includes('reconciled_at')) {
      db.exec(`ALTER TABLE delivery_records ADD COLUMN reconciled_at TEXT`);
    }

    // ── 2. reconciled_by — username người thực hiện đối soát ─────────────
    if (!cols.includes('reconciled_by')) {
      db.exec(`ALTER TABLE delivery_records ADD COLUMN reconciled_by TEXT`);
    }

    // ── 3. confirmed_by — username đã xác nhận số liệu giao (audit) ──────
    if (!cols.includes('confirmed_by')) {
      db.exec(`ALTER TABLE delivery_records ADD COLUMN confirmed_by TEXT`);
    }

    // Index tra cứu nhanh các phiếu đã đối soát (báo cáo đối soát).
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_delivery_records_reconciled ON delivery_records(reconciled_at)`
    );
  },

  down: (db) => {
    const dropIfExists = (table, col) => {
      try {
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
      } catch (_) {
        /* rollback best-effort */
      }
    };

    dropIfExists('delivery_records', 'confirmed_by');
    dropIfExists('delivery_records', 'reconciled_by');
    dropIfExists('delivery_records', 'reconciled_at');

    try {
      db.exec('DROP INDEX IF EXISTS idx_delivery_records_reconciled');
    } catch (_) {
      /* ignore */
    }
  },
};

module.exports = migration;
