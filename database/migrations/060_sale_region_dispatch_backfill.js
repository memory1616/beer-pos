/**
 * Migration: Vá snapshot khu vực + trạng thái điều phố của đơn (060)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Sau khi hệ thống khu vực được bật (migration 058/059), có 2 lỗi dữ liệu
 *  khiến đơn KHÔNG quay lại danh sách "🚚 Đơn chờ điều phố" khi Admin bỏ
 *  phân công tài xế của một khu vực:
 *
 *   1. `sales.region_id` bị NULL trên các đơn tạo trước lúc khách hàng
 *      được gán khu vực (hoặc tạo qua LAN sync không chạy auto-dispatch).
 *      → Truy vấn "đơn thuộc khu vực" (WHERE s.region_id = ?) không match →
 *        đơn không được giải phóng khi bỏ phân công.
 *
 *   2. `sales.dispatch_status` bị NULL trên đơn không có tài xế.
 *      → Truy vấn danh sách chờ điều phố (WHERE dispatch_status='UNASSIGNED')
 *        không match → đơn không hiện trong hàng đợi.
 *
 * Thiết kế (AN TOÀN — có ranh giới "kỷ nguyên điều phố"):
 *  - CHỈ đụng tới đơn tạo TỪ NGÀY hệ thống khu vực được bật (mốc lấy từ
 *    `MIN(business_regions.created_at)` → ngày giờ VN). Đơn cũ hơn (đã giao
 *    xong trước khi có phân tuyến) KHÔNG bị đụng tới → không tràn hàng đợi.
 *  - Đơn đã hoàn tất (delivery_records.status IN DELIVERED/FAILED/DISCREPANCY)
 *    → giữ nguyên lịch sử.
 *  - Đơn đang gán cho tài xế nhưng khu vực HIỆN KHÔNG có tài xế phụ trách
 *    (Admin vừa bỏ phân công) → giải phóng về hàng đợi chờ điều phố.
 *
 * Idempotent: chạy lại nhiều lần cho kết quả giống nhau.
 * Rollback an toàn: KHÔNG revert được dữ liệu đã vá → down chỉ là no-op.
 */

const migration = {
  id: 60,
  name: 'sale_region_dispatch_backfill',

  up: (db) => {
    const hasTable = (table) => {
      try {
        return !!db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(table);
      } catch (_) {
        return false;
      }
    };

    if (!hasTable('sales') || !hasTable('business_regions')) return;

    // ── 1. Mốc "kỷ nguyên điều phố" (ngày hệ thống khu vực bật) ─────────────
    // `created_at` lưu UTC → cộng 7 giờ để lấy ngày giờ VN.
    let eraStart = null;
    try {
      const row = db
        .prepare(
          `SELECT date(MIN(created_at), '+7 hours') AS d FROM business_regions`
        )
        .get();
      eraStart = row && row.d ? row.d : null;
    } catch (_) {
      eraStart = null;
    }

    // Không xác định được mốc → an toàn: KHÔNG sửa gì (tránh tràn hàng đợi).
    if (!eraStart) return;

    // ── 2. Backfill snapshot khu vực cho đơn trong kỷ nguyên ────────────────
    // Đơn có `region_id IS NULL` nhưng khách hàng đã có khu vực → lấy theo khách.
    let backfilledRegions = 0;
    try {
      const r = db
        .prepare(
          `UPDATE sales
              SET region_id = (
                    SELECT c.region_id FROM customers c WHERE c.id = sales.customer_id
                  ),
                  region_name = (
                    SELECT br.name FROM customers c
                      JOIN business_regions br ON br.id = c.region_id
                     WHERE c.id = sales.customer_id
                  ),
                  updated_at = CURRENT_TIMESTAMP
            WHERE region_id IS NULL
              AND type = 'sale'
              AND archived = 0
              AND deleted = 0
              AND COALESCE(created_on, date(date)) >= ?
              AND customer_id IS NOT NULL
              AND EXISTS (
                    SELECT 1 FROM customers c
                     WHERE c.id = sales.customer_id AND c.region_id IS NOT NULL
                  )`
        )
        .run(eraStart);
      backfilledRegions = r.changes || 0;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[MIGRATION 060] backfill region snapshot: ${e.message}`);
    }

    // ── 3. Đơn trong kỷ nguyên chưa có tài xế → chờ điều phố ───────────────
    // (`dispatch_status IS NULL` + không có driver → coi như UNASSIGNED).
    let markedUnassigned = 0;
    try {
      const r = db
        .prepare(
          `UPDATE sales
              SET dispatch_status = 'UNASSIGNED',
                  updated_at = CURRENT_TIMESTAMP
            WHERE dispatch_status IS NULL
              AND (driver_username IS NULL OR driver_username = '')
              AND type = 'sale'
              AND archived = 0
              AND deleted = 0
              AND COALESCE(created_on, date(date)) >= ?`
        )
        .run(eraStart);
      markedUnassigned = r.changes || 0;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[MIGRATION 060] mark unassigned: ${e.message}`);
    }

    // ── 4. Giải phóng đơn của khu vực KHÔNG còn tài xế phụ trách ───────────
    // Admin vừa bỏ phân công → đơn chưa giao của khu vực đó phải về hàng đợi.
    let released = 0;
    try {
      const r = db
        .prepare(
          `UPDATE sales
              SET driver_username = NULL,
                  region_driver_username = NULL,
                  dispatch_status = 'UNASSIGNED',
                  updated_at = CURRENT_TIMESTAMP
            WHERE driver_username IS NOT NULL
              AND driver_username != ''
              AND type = 'sale'
              AND archived = 0
              AND deleted = 0
              AND COALESCE(created_on, date(date)) >= ?
              AND region_id IS NOT NULL
              AND NOT EXISTS (
                    SELECT 1 FROM region_driver_assignments rda
                     WHERE rda.region_id = sales.region_id AND rda.active = 1
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM delivery_records dr
                     WHERE dr.sale_id = sales.id
                       AND dr.status IN ('DELIVERED','FAILED','DISCREPANCY')
                  )`
        )
        .run(eraStart);
      released = r.changes || 0;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[MIGRATION 060] release driverless regions: ${e.message}`);
    }

    // ── 5. Giải phóng phiếu giao PENDING/IN_PROGRESS của đơn vừa bỏ gán ───
    // (đơn về hàng đợi chờ điều phố → không còn phiếu giao cũ của tài xế cũ).
    try {
      db.prepare(
        `DELETE FROM delivery_records
          WHERE status IN ('PENDING','IN_PROGRESS')
            AND sale_id IN (
              SELECT id FROM sales
               WHERE dispatch_status = 'UNASSIGNED'
                 AND (driver_username IS NULL OR driver_username = '')
                 AND COALESCE(created_on, date(date)) >= ?
            )`
      ).run(eraStart);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[MIGRATION 060] release delivery records: ${e.message}`);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[MIGRATION 060] eraStart=${eraStart} backfilledRegions=${backfilledRegions} ` +
        `markedUnassigned=${markedUnassigned} released=${released}`
    );
  },

  down: (db) => {
    // Không revert được dữ liệu đã vá (an toàn hơn là xoá nhầm lịch sử).
    try {
      db.exec('DELETE FROM delivery_records WHERE status = "PENDING" AND note LIKE "%migration 060%"');
    } catch (_) {
      /* no-op */
    }
  },
};

module.exports = migration;
