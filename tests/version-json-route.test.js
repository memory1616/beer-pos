/**
 * Route /version.json — phục vụ ĐỘNG (dynamic)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh (2026-11-15):
 *  `deploy.sh` từng ghi đè `public/version.json` (file ĐANG được git track)
 *  mỗi lần deploy → working tree trên server luôn "dirty" → `git pull --ff-only`
 *  bị chặn với lỗi "Cannot fast-forward your working tree".
 *
 *  Nay server tự sinh `build`/`date` lúc runtime (xem server.js), file trên đĩa
 *  là nguồn chuẩn cho `version` + `changelog`.
 *
 * Test này kiểm tra:
 *   1. Route /version.json được đăng ký TRƯỚC `express.static` (để thắng static).
 *   2. Route có set header no-cache.
 *   3. `deploy.sh` KHÔNG còn ghi đè file version.json trên đĩa.
 *   4. Workflow deploy trỏ đúng thư mục app thật trên server.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const deploySrc = fs.readFileSync(path.join(ROOT, 'deploy', 'deploy.sh'), 'utf8');
const workflowSrc = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');

describe('/version.json dynamic route', () => {
  test('route được đăng ký trước express.static', () => {
    const routeIdx = serverSrc.indexOf("app.get('/version.json'");
    const staticIdx = serverSrc.indexOf('express.static(path.join');

    expect(routeIdx).toBeGreaterThan(-1);
    expect(staticIdx).toBeGreaterThan(-1);
    expect(routeIdx).toBeLessThan(staticIdx);
  });

  test('route set header no-cache + đọc version từ file trên đĩa', () => {
    const routeIdx = serverSrc.indexOf("app.get('/version.json'");
    const routeBlock = serverSrc.slice(routeIdx, routeIdx + 1600);

    expect(routeBlock).toContain('no-store, no-cache, must-revalidate');
    expect(routeBlock).toContain("'public', 'version.json'");
    // build/date phải do server sinh runtime, KHÔNG đọc từ file
    expect(routeBlock).toContain('meta.build = BUILD_ID');
    expect(routeBlock).toContain('meta.date =');
  });

  test('BUILD_ID được tính lúc khởi động', () => {
    expect(serverSrc).toMatch(/const BUILD_ID\s*=\s*process\.env\.BUILD_ID\s*\|\|/);
  });
});

describe('deploy.sh không sửa file version.json trên đĩa', () => {
  test('không còn khối node -e ghi đè public/version.json', () => {
    // Tìm chỗ ghi file: fs.writeFileSync trên version.json
    expect(deploySrc).not.toMatch(/writeFileSync[\s\S]{0,200}version\.json/);
  });

  test('không còn chạy node -e bump version.json', () => {
    expect(deploySrc).not.toMatch(/j\.build\s*=\s*build/);
  });

  test('vẫn export BUILD_ID cho PM2', () => {
    expect(deploySrc).toMatch(/export BUILD_ID/);
  });

  test('reset sạch public/version.json trước khi git reset --hard', () => {
    expect(deploySrc).toContain('git checkout -- public/version.json');
  });

  test('cấu hình safe.directory để git không chặn do ownership', () => {
    expect(deploySrc).toContain('safe.directory');
  });
});

describe('GitHub Actions deploy trỏ đúng thư mục app', () => {
  test('không còn hardcode /root/beer-pos', () => {
    expect(workflowSrc).not.toContain('bash /root/beer-pos/deploy/deploy.sh');
    expect(workflowSrc).not.toContain('cd /root/beer-pos');
  });

  test('dùng VPS_APP_PATH với fallback /var/www/beer-pos', () => {
    expect(workflowSrc).toContain('VPS_APP_PATH');
    expect(workflowSrc).toContain('/var/www/beer-pos');
  });
});
