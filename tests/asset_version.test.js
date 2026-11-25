/**
 * Test cache-busting dựa trên content-hash per-file.
 *
 * Mục tiêu: client chỉ cần RELOAD (F5) là thấy giao diện mới.
 * Không được yêu cầu Ctrl+F5 / hard refresh / xoá cache thủ công.
 *
 * Nguyên nhân lịch sử:
 *  - version = git hash (APP_VERSION) → chỉ đổi khi commit
 *  - version = BUILD_ID             → chỉ đổi khi restart PM2
 *  → deploy file mà chưa commit (hoặc không restart) → URL giữ nguyên
 *    → browser giữ CSS/JS cũ trong HTTP cache → phải Ctrl+F5.
 *
 * Giải pháp: version = hash(mtime + size) của chính file đó.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const ecoSrc = fs.readFileSync(path.join(ROOT, 'ecosystem.config.js'), 'utf8');

describe('assetVersion — content-hash per-file', () => {
  // Nạp lại module để test độc lập (tránh cache của require)
  const loadModule = () => {
    jest.resetModules();
    return require(path.join(ROOT, 'src', 'utils', 'assetVersion'));
  };

  test('trả hash ổn định cho cùng 1 file (không đổi URL mỗi request)', () => {
    const { assetVersion } = loadModule();
    const a = assetVersion('/css/unified.css');
    const b = assetVersion('/css/unified.css');
    expect(a).toBeTruthy();
    expect(b).toBe(a);
  });

  test('file khác nhau → hash khác nhau', () => {
    const { assetVersion } = loadModule();
    const css = assetVersion('/css/unified.css');
    const js = assetVersion('/js/sales.js');
    expect(css).not.toBe(js);
  });

  test('file không tồn tại → trả chuỗi rỗng (không redirect về hỏng)', () => {
    const { assetVersion } = loadModule();
    expect(assetVersion('/css/khong-ton-tai-abc.css')).toBe('');
  });

  test('chặn path traversal (không lộ file ngoài public/)', () => {
    const { assetVersion } = loadModule();
    expect(assetVersion('/../server.js')).toBe('');
    expect(assetVersion('/css/../../server.js')).toBe('');
  });

  test('hash ĐỔI khi nội dung file đổi → URL mới → browser tải bản mới', () => {
    const { assetVersion } = loadModule();
    const before = assetVersion('/css/unified.css');

    // Sửa file → mtime + size đổi → hash phải khác
    const p = path.join(ROOT, 'public', 'css', 'unified.css');
    const original = fs.readFileSync(p);
    try {
      fs.appendFileSync(p, '\n/* cache-bust test */\n');
      // Vượt TTL để stat lại (TTL 1s)
      const realNow = Date.now;
      Date.now = () => realNow() + 5000;
      try {
        const after = assetVersion('/css/unified.css');
        expect(after).not.toBe(before);
      } finally {
        Date.now = realNow;
      }
    } finally {
      fs.writeFileSync(p, original);
    }
  });

  test('invalidateAssetCache() buộc tính lại ngay', () => {
    const { assetVersion, invalidateAssetCache } = loadModule();
    const before = assetVersion('/css/tokens.css');
    invalidateAssetCache();
    expect(assetVersion('/css/tokens.css')).toBe(before); // vẫn ổn định
  });
});

describe('server.js dùng content-hash cho cache-busting', () => {
  test('import assetVersion', () => {
    expect(serverSrc).toContain("require('./src/utils/assetVersion')");
  });

  test('inject ?v= trong HTML dùng assetVersion() (không dùng git hash / BUILD_ID)', () => {
    const idx = serverSrc.indexOf('cleanPath}?v=');
    expect(idx).toBeGreaterThan(-1);
    const block = serverSrc.slice(idx - 200, idx + 200);
    expect(block).toContain('assetVersion(cleanPath)');
    expect(block).not.toContain('BUILD_ID');
  });

  test('redirect asset sai version dùng assetVersion()', () => {
    const idx = serverSrc.indexOf('const current = assetVersion(p);');
    expect(idx).toBeGreaterThan(-1);
    const block = serverSrc.slice(idx, idx + 300);
    expect(block).toContain('?v=${current}');
    expect(block).not.toContain('BUILD_ID');
  });

  test('KHÔNG còn dùng APP_VERSION làm version cho asset', () => {
    // APP_VERSION vẫn được export cho window.APP_VERSION (app context)
    // nhưng KHÔNG được dùng làm cache-busting param.
    expect(serverSrc).not.toMatch(/\?v=\$\{APP_VERSION\}/);
  });
});

describe('ecosystem.config.js khai báo BUILD_ID', () => {
  test('env có BUILD_ID (nếu thiếu, pm2 restart ecosystem sẽ ghi đè env từ shell)', () => {
    expect(ecoSrc).toMatch(/BUILD_ID:/);
  });

  test('BUILD_ID đọc từ process.env, có fallback timestamp', () => {
    expect(ecoSrc).toMatch(/BUILD_ID:\s*\(process\.env\.BUILD_ID/);
    expect(ecoSrc).toMatch(/String\(Date\.now\(\)\)/);
  });
});
