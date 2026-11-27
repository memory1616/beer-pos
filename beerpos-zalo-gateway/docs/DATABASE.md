# DATABASE — BeerPOS Zalo Gateway

> Giai đoạn 2. Database riêng: `data/gateway.sqlite`.
> **Tuyệt đối không** dùng chung với `D:\Beer\database.sqlite`.

---

## 1. Nguyên tắc

| # | Nguyên tắc |
|---|---|
| DB1 | Database riêng, file riêng, WAL mode |
| DB2 | Migration có version, `up`/`down`, idempotent, chạy tường minh (`npm run migrate`) |
| DB3 | Không xoá vật lý mapping → soft delete (`is_active = 0`), giữ lịch sử |
| DB4 | UNIQUE ở tầng DB cho 1 khách ↔ 1 nhóm + idempotency |
| DB5 | Snapshot `group_id` + `message_content` tại thời điểm tạo job |
| DB6 | Không lưu secret trong `gateway_settings` |
| DB7 | Audit mỗi thao tác quan trọng, không ghi secret |

---

## 2. ERD

```
┌─────────────────────────┐
│   gateway_settings      │  (key/value, không nhạy cảm)
└─────────────────────────┘

┌─────────────────────────┐
│    gateway_account      │  (1 tài khoản — id luôn = 1)
└─────────────────────────┘

┌─────────────────────────┐         ┌──────────────────────────┐
│     gateway_groups      │         │      gateway_jobs        │
│─────────────────────────│         │──────────────────────────│
│ id            PK        │◄──┐     │ id              PK        │
│ customer_id   UNIQUE    │   │     │ idempotency_key UNIQUE   │
│ group_id      UNIQUE    │   │     │ payment_id               │
│ customer_name           │   │     │ customer_id      IDX     │
│ group_name              │   └─────┤ customer_name            │
│ note                    │  (snapshot│ group_id     (snapshot) │
│ is_active   IDX         │  group_id│ message_content(snapshot)│
│ created_at              │         │ provider                │
│ updated_at              │         │ status         IDX      │
└─────────────────────────┘         │ attempts / max_attempts │
                                    │ next_retry_at   IDX      │
                                    │ locked_at / locked_until │
                                    │ last_error                │
                                    │ provider_response         │
                                    │ created_at       IDX      │
                                    │ updated_at / processed_at │
                                    └────────────┬─────────────┘
                                                 │ 1:N
                                                 ▼
                                    ┌──────────────────────────┐
                                    │   gateway_messages       │
                                    │──────────────────────────│
                                    │ id          PK          │
                                    │ job_id      IDX  (FK)    │
                                    │ provider                 │
                                    │ request_payload          │
                                    │ response_payload         │
                                    │ status                   │
                                    │ error_message            │
                                    │ started_at / completed_at│
                                    │ created_at               │
                                    └──────────────────────────┘

┌─────────────────────────┐
│  gateway_audit_logs     │  (action, entity_type, entity_id, details)
└─────────────────────────┘
```

---

## 3. Bảng chi tiết

### 3.1 `gateway_settings`

```sql
CREATE TABLE gateway_settings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Dùng cho: `provider`, `worker_enabled`, `worker_interval_ms`, `retry_max_attempts`,
`retry_delays_ms`, `title`, `account_display_name`.

> ⚠️ **KHÔNG** lưu API key, token, cookie, mật khẩu Zalo ở đây.

### 3.2 `gateway_account`

```sql
CREATE TABLE gateway_account (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  provider        TEXT NOT NULL DEFAULT 'mock',
  display_name    TEXT NOT NULL DEFAULT 'Tài khoản Zalo chính',
  status          TEXT NOT NULL DEFAULT 'not_configured',
  connection_mode TEXT NOT NULL DEFAULT 'mock',
  last_checked_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

| Cột `status` | Nghĩa |
|---|---|
| `not_configured` | Chưa cấu hình nhà cung cấp Zalo được cấp quyền |
| `connected` | Provider sẵn sàng |
| `degraded` | Có lỗi nhưng vẫn hoạt động |
| `error` | Lỗi nghiêm trọng |
| `disabled` | Tắt thủ công |

| Cột `connection_mode` | Nghĩa |
|---|---|
| `mock` | Mô phỏng — KHÔNG gửi thật |
| `authorized` | Nhà cung cấp được cấp quyền |

### 3.3 `gateway_groups`

```sql
CREATE TABLE gateway_groups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   TEXT    NOT NULL,
  customer_name TEXT,
  group_id      TEXT    NOT NULL,
  group_name    TEXT,
  note          TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_gateway_groups_customer  ON gateway_groups(customer_id);
CREATE UNIQUE INDEX idx_gateway_groups_group     ON gateway_groups(group_id);
CREATE        INDEX idx_gateway_groups_active    ON gateway_groups(is_active);
CREATE        INDEX idx_gateway_groups_search    ON gateway_groups(customer_name);
```

**Quy tắc:**

| # | Quy tắc | Cơ chế |
|---|---|---|
| 1 | 1 Customer ID → 1 Group ID active | `UNIQUE(customer_id)` |
| 2 | 1 Group ID → 1 Customer ID | `UNIQUE(group_id)` |
| 3 | Không cho trùng Group ID | UNIQUE + kiểm tra tầng service → lỗi rõ ràng |
| 4 | Không cho Group ID rỗng | Validate + CHECK |
| 5 | Xoá mapping **không** xoá lịch sử | Soft delete (`is_active = 0`) |
| 6 | Khách bị ngừng hoạt động → không gửi tin mới | `is_active = 0` → lookup bỏ qua |
| 7 | Không tự tạo nhóm Zalo | Không có API tạo nhóm |
| 8 | Không đồng bộ hội thoại Zalo | Không có API sync |

> `customer_id` là **TEXT** (không ép INTEGER) → linh hoạt, khớp với `customerId` string của BeerPOS.

### 3.4 `gateway_jobs`

```sql
CREATE TABLE gateway_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key   TEXT    NOT NULL UNIQUE,
  payment_id        TEXT,
  customer_id       TEXT    NOT NULL,
  customer_name     TEXT,
  group_id          TEXT    NOT NULL,      -- SNAPSHOT
  group_name        TEXT,                  -- SNAPSHOT
  message_content   TEXT    NOT NULL,      -- SNAPSHOT
  provider          TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'queued',
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 4,
  next_retry_at     TEXT,
  locked_at         TEXT,
  locked_until      TEXT,
  locked_by         TEXT,
  last_error        TEXT,
  provider_response TEXT,
  created_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at      TEXT
);

CREATE INDEX idx_gateway_jobs_status      ON gateway_jobs(status);
CREATE INDEX idx_gateway_jobs_retry       ON gateway_jobs(next_retry_at);
CREATE INDEX idx_gateway_jobs_payment    ON gateway_jobs(payment_id);
CREATE INDEX idx_gateway_jobs_customer    ON gateway_jobs(customer_id);
CREATE INDEX idx_gateway_jobs_created     ON gateway_jobs(created_at);
CREATE INDEX idx_gateway_jobs_locked      ON gateway_jobs(locked_until);
```

**Trạng thái `status`:**

| Status | Nghĩa | Retry tự động? |
|---|---|---|
| `queued` | Đang chờ | — |
| `processing` | Worker đang giữ lease | Không (đợi lease hết hạn) |
| `sent` | Provider **đã chấp nhận** | ❌ Không (tránh trùng) |
| `retry` | Lỗi tạm thời, chờ thử lại | ✅ Theo backoff |
| `failed` | Lỗi vĩnh viễn / hết lần thử | ❌ |
| `unknown` | Không xác định kết quả | ❌ **KHÔNG retry mù** |
| `no_group` | Chưa có Group ID | ❌ |
| `cancelled` | Bị hủy thủ công | ❌ |

> ⚠️ `sent` **KHÔNG** đồng nghĩa `delivered`. Provider không có API đối soát → chỉ `accepted`.

### 3.5 `gateway_messages`

```sql
CREATE TABLE gateway_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL,
  provider         TEXT    NOT NULL,
  request_payload  TEXT,
  response_payload TEXT,
  status           TEXT    NOT NULL,
  error_message    TEXT,
  started_at       TEXT,
  completed_at     TEXT,
  created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES gateway_jobs(id) ON DELETE CASCADE
);

CREATE INDEX idx_gateway_messages_job    ON gateway_messages(job_id);
CREATE INDEX idx_gateway_messages_status ON gateway_messages(status);
CREATE INDEX idx_gateway_messages_created ON gateway_messages(created_at);
```

> **Mỗi lần thử gửi = 1 dòng.** Job retry 3 lần → 3 dòng (thấy đúng lịch sử thử).
> `request_payload` / `response_payload` lưu JSON — **phải lọc bỏ secret** trước khi lưu.

### 3.6 `gateway_audit_logs`

```sql
CREATE TABLE gateway_audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_gateway_audit_action  ON gateway_audit_logs(action);
CREATE INDEX idx_gateway_audit_created ON gateway_audit_logs(created_at);
```

**Action được ghi log:**

`GROUP_CREATE` · `GROUP_UPDATE` · `GROUP_DEACTIVATE` · `GROUP_DELETE` ·
`GROUP_IMPORT` · `SETTING_UPDATE` · `ACCOUNT_UPDATE` · `PROVIDER_CHANGE` ·
`JOB_RETRY` · `JOB_CANCEL` · `API_KEY_ROTATE`

> ⚠️ `details` **KHÔNG** chứa API key, token, cookie.

---

## 4. Migration

### 4.1 Quy ước

| Hạng mục | Quy ước |
|---|---|
| Vị trí | `src/database/migrations/001_init.js` … |
| Format | `module.exports = { version: 1, name: 'init', up(db), down(db) }` |
| Bảng theo dõi | `schema_migrations (version INTEGER PK, name TEXT, applied_at TEXT)` |
| Chạy | Tường minh: `npm run migrate` — **KHÔNG** tự chạy lúc require |
| Idempotent | `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` |
| Down | Chỉ gỡ bảng/index do migration đó tạo |
| Rollback | `npm run migrate:down` gỡ migration cuối |

### 4.2 Migration 001 — `init`

Tạo 6 bảng + index + seed:

```sql
INSERT OR IGNORE INTO gateway_account (id, provider, display_name, status, connection_mode)
VALUES (1, 'mock', 'Tài khoản Zalo chính', 'not_configured', 'mock');

INSERT OR IGNORE INTO gateway_settings (key, value) VALUES
  ('provider', 'mock'),
  ('worker_enabled', '1'),
  ('worker_interval_ms', '2000'),
  ('retry_max_attempts', '4'),
  ('retry_delays_ms', '10000,30000,120000,300000'),
  ('max_message_length', '2000'),
  ('title', 'Cập nhật công nợ');
```

---

## 5. Hiệu năng

| Hạng mục | Thiết kế |
|---|---|
| WAL mode | `PRAGMA journal_mode = WAL` → đọc không chặn ghi |
| Busy timeout | `PRAGMA busy_timeout = 5000` → tránh `SQLITE_BUSY` |
| Foreign keys | `PRAGMA foreign_keys = ON` |
| N+1 | `GET /api/groups` dùng 1 query + filter trong JS (không loop query) |
| Pagination | `page` + `limit` (max 200), trả `total` |
| Index | Đã liệt kê ở từng bảng |
| Transaction | Import CSV: 1 transaction, **rollback toàn bộ** nếu lỗi hệ thống |
| Provider call | **KHÔNG** giữ transaction DB mở |

---

## 6. Backup

```bash
npm run backup           # → data/backups/gateway-<timestamp>.sqlite
```

Dùng `db.backup()` của better-sqlite3 (backup online, an toàn khi đang ghi).

**Không** copy thẳng file `.sqlite` khi process đang chạy (WAL chưa checkpoint).

---

## 7. Dữ liệu mẫu (seed)

```bash
npm run seed
```

| customerId | customerName | groupId | groupName | note |
|---|---|---|---|---|
| `KH001` | Quán A | `GROUP001` | Nhóm Quán A | *(dữ liệu thử nghiệm)* |
| `KH002` | Quán B | `GROUP002` | Nhóm Quán B | *(dữ liệu thử nghiệm)* |
| `KH003` | Quán C | `GROUP003` | Nhóm Quán C | *(dữ liệu thử nghiệm)* |

> Mọi bản ghi seed đều có `note` chứa `dữ liệu thử nghiệm` để nhận biết & dọn dễ.
