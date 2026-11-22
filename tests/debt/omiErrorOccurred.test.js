/**
 * OMICALL — LỖI "error_occurred" & CHẨN ĐOÁN KÊNH ZALO
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh (2026-11-22):
 *  4 tin nhắn công nợ bị OmiCall từ chối với `error_occurred` (HTTP 200,
 *  status_code -9999). Điều tra thực tế trên server cho thấy:
 *   - API key vẫn hợp lệ (POST /api/auth?apiKey=... trả access_token).
 *   - Cùng một conv gửi lại lúc sau → thành công → lỗi là TẠM THỜI
 *     (phiên Zalo bị gián đoạn), không phải lỗi cấu hình.
 *   - `channel_id` RỖNG (do fetchChannelId nuốt im lặng mọi lỗi) khiến
 *     body `{conv_id, channel_id:'', text}` bị OmiCall từ chối bằng
 *     `error_occurred` — lỗi chung, rất khó chẩn đoán.
 *
 * Các sửa đổi phải có trong test:
 *  1. fetchChannelId() có CACHE channel_id trong RAM.
 *  2. fetchChannelId() GHI LOG lỗi thay vì nuốt im lặng.
 *  3. KHÔNG gửi biến thể body có channel_id rỗng.
 *  4. Khi gặp `error_occurred` → thử lại với token MỚI + channel_id MỚI.
 *  5. Trả kèm `hint` cho admin khi lỗi là tạm thời.
 */
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', '..', 'src', 'services', 'OmiCallService.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

describe('OmiCallService — channel_id cache', () => {
  test('có cache channelIdCache trong RAM', () => {
    expect(src).toMatch(/const\s+channelIdCache\s*=\s*new Map\(\)/);
  });

  test('cache channel_id có TTL', () => {
    expect(src).toMatch(/CHANNEL_ID_TTL_MS\s*=/);
  });

  test('fetchChannelId dùng cache trước khi gọi API', () => {
    expect(src).toMatch(/channelIdCache\.get\(cacheKey\)/);
    expect(src).toMatch(/channelIdCache\.set\(cacheKey/);
  });
});

describe('OmiCallService — log chẩn đoán thay vì nuốt lỗi', () => {
  test('fetchChannelId ghi log khi không lấy được channel_id', () => {
    expect(src).toMatch(/logger\.error\('\[OMICALL\] Không lấy được channel_id/);
  });

  test('fetchChannelId không còn catch (_) im lặng', () => {
    // Không được nuốt lỗi trong fetchChannelId
    const fn = src.slice(src.indexOf('async function fetchChannelId'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).not.toMatch(/catch\s*\(\s*_\s*\)\s*\{\s*\/\*\s*thử host tiếp theo/);
  });

  test('gửi tin bị từ chối → ghi log chẩn đoán', () => {
    expect(src).toMatch(/logger\.error\('\[OMICALL\] Gửi tin bị từ chối'/);
  });
});

describe('OmiCallService — không gửi channel_id rỗng', () => {
  test('lọc biến thể body conv_id+channel_id+text khi channel_id rỗng', () => {
    expect(src).toMatch(/sendableBodies\s*=\s*channelId/);
    expect(src).toMatch(/bodies\.filter\(\(bv\)\s*=>\s*bv\.label\s*!==\s*'conv_id\+channel_id\+text'\)/);
  });

  test('vòng lặp gửi dùng sendableBodies', () => {
    expect(src).toMatch(/for \(const bv of sendableBodies\)/);
  });
});

describe('OmiCallService — retry khi lỗi tạm thời error_occurred', () => {
  test('nhận diện error_occurred và thử lại', () => {
    expect(src).toMatch(/error_occurred\/i\.test\(String\(msg\)\)/);
  });

  test('retry dùng token mới + channel_id mới (xóa cache)', () => {
    expect(src).toMatch(/clearTokenCache\(\)/);
    expect(src).toMatch(/channelIdCache\.clear\(\)/);
  });

  test('retry chỉ 1 lần (có _retried guard)', () => {
    expect(src).toMatch(/!opts\._retried/);
  });
});

describe('OmiCallService — hint cho admin', () => {
  test('trả hint khi lỗi là tạm thời', () => {
    expect(src).toMatch(/hint:/);
    expect(src).toMatch(/Lỗi tạm thời từ phía OmiCall/);
  });

  test('trả hint khi thiếu channel_id', () => {
    expect(src).toMatch(/Không lấy được channel_id/);
  });
});
