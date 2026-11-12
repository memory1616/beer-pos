/**
 * Jest global teardown — dọn các file DB test tạm trong thư mục tạm.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async () => {
  const dir = path.join(os.tmpdir(), 'beer-tests');
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    // Bỏ qua — không ảnh hưởng kết quả test
  }
};
