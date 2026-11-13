/**
 * Migration: Audit Log (050)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Hệ thống không có dấu vết ai đã làm gì. Khi có khiếu nại ("tôi không
 *  xoá đơn đó", "số liệu báo cáo sai", "ai đổi giá?") → không có cách nào
 *  trả lời ngoài việc đoán.
 *
 *  Migration này tạo:
 *  1. Bảng `audit_logs` — nhật ký thao tác (idempotent).
 *  2. Index theo thời gian, actor, entity.
 *
 * ADDITIVE — KHÔNG sửa/xoá dữ liệu kinh doanh hiện có.
 * Rollback: chỉ gỡ bảng `audit_logs`.
 */

const migration = {
  id: 50,
  name: 'audit_log',
  up: (db) => {
    // ── 1. audit_logs ────────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_username TEXT,
        actor_role TEXT,
        action TEXT NOT NULL,
        entity TEXT,
        entity_id TEXT,
        description TEXT,
        changes TEXT,
        ip_address TEXT,
        user_agent TEXT,
        status TEXT NOT NULL DEFAULT 'success',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Truy vấn chính: xem nhật ký theo thời gian (mới nhất trước)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created
      ON audit_logs(created_at DESC)
    `);
    // Lọc theo người thực hiện
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
      ON audit_logs(actor_username)
    `);
    // Lọc theo loại thao tác
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_action
      ON audit_logs(action)
    `);
    // Lọc theo đối tượng bị tác động (sale:123, customer:45…)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
      ON audit_logs(entity, entity_id)
    `);
  },
};

module.exports = migration;
