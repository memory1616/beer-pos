/**
 * Cache-busting dựa trên NỘI DUNG THẬT của file (content hash).
 *
 * Vì sao không dùng git hash / BUILD_ID?
 * ─────────────────────────────────────────────────────────────
 *  - git hash (APP_VERSION): chỉ đổi khi commit. Deploy file mà chưa commit
 *    → URL ?v= giữ nguyên → browser giữ CSS/JS cũ → phải Ctrl+F5.
 *  - BUILD_ID: chỉ đổi khi restart PM2. Deploy không restart (lỗi, hoặc
 *    deploy partial) → URL ?v= giữ nguyên → vẫn phải Ctrl+F5.
 *
 * Hàm này giải quyết cả hai: version = hash(mtime + size) của chính file đó.
 *  - File thay đổi (deploy ghi file mới) → mtime/size đổi → hash đổi
 *    → URL mới → browser tải bản mới. KHÔNG cần commit, KHÔNG cần restart.
 *  - File không đổi → hash giữ nguyên → URL giữ nguyên → vẫn cache tốt.
 *
 * Chi phí: 1 lần stat() mỗi file mỗi request. Được cache trong Map và chỉ
 * stat lại khi quá HẠN (mặc định 5s) → gần như không tốn.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Thư mục gốc project (src/utils/ → src/ → project root)
const ROOT_DIR = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// Mỗi entry: { hash, mtimeMs, size, checkedAt }
const cache = new Map();

// Bao lâu thì stat lại file trên đĩa (ms). Deploy thường ghi file rồi
// restart PM2 ngay, nên 5s là quá đủ; 1s để phản hồi nhanh nhất khi deploy.
const TTL_MS = 1000;

/**
 * Trả về hash version của 1 file public.
 * @param {string} urlPath URL path bắt đầu bằng '/' (vd. '/css/unified.css')
 * @returns {string} hash ngắn, hoặc chuỗi rỗng nếu file không tồn tại
 */
function assetVersion(urlPath) {
  if (!urlPath || !urlPath.startsWith('/')) return '';

  // Chặn path traversal: chỉ cho phép file trong public/
  const rel = urlPath.replace(/^\/+/, '');
  const abs = path.resolve(PUBLIC_DIR, rel);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return '';

  const now = Date.now();
  const hit = cache.get(abs);
  if (hit && (now - hit.checkedAt) < TTL_MS) return hit.hash;

  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    cache.delete(abs);
    return '';
  }
  if (!st.isFile()) return '';

  // mtimeMs + size là đủ để phát hiện thay đổi nội dung; thêm hash md5 của
  // chuỗi đó cho URL ngắn gọn và khó đoán.
  const hash = crypto
    .createHash('sha1')
    .update(`${st.mtimeMs}:${st.size}`)
    .digest('hex')
    .slice(0, 10);

  cache.set(abs, { hash, mtimeMs: st.mtimeMs, size: st.size, checkedAt: now });
  return hash;
}

/** Xoá cache phiên bản (dùng sau khi deploy ghi file) */
function invalidateAssetCache() {
  cache.clear();
}

module.exports = { assetVersion, invalidateAssetCache };
