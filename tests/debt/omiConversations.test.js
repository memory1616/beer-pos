/**
 * OMICALL — LIỆT KÊ HỘI THOẠI / NHÓM ZALO
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi test:
 *  - listConversations() hỗ trợ 2 chiều sort (asc/desc) qua opts.sortDir
 *  - listConversationsBoth() gom CẢ 2 chiều → không bỏ sót nhóm Zalo vừa tạo
 *
 * ⚠️ Bối cảnh:
 *  OmiCall `search_v4` chỉ trả về khoảng ~337 hội thoại đầu tiên, sắp xếp theo
 *  `last_message_time`. Nhóm Zalo vừa tạo (chưa có tin nhắn nào) có
 *  last_message_time rất nhỏ → xếp CUỐI danh sách → KHÔNG xuất hiện trong
 *  danh sách mặc định. Gọi thêm chiều sort GIẢM DẦN sẽ đưa nhóm mới lên đầu.
 */
process.env.NODE_ENV = 'test';

const OmiCallService = require('../../src/services/OmiCallService');
const real = jest.requireActual('../../src/services/OmiCallService');

describe('OmiCallService.listConversations — chiều sắp xếp', () => {
  test('hàm listConversationsBoth được export', () => {
    expect(typeof OmiCallService.listConversationsBoth).toBe('function');
  });

  test('có hỗ trợ opts.sortDir = "desc" (mới nhất trước)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'src', 'services', 'OmiCallService.js'),
      'utf8'
    );
    // sort dựng theo sortDir
    expect(src).toMatch(/sortDir\s*===\s*'desc'/);
    expect(src).toMatch(/is_asc:\s*sortDir\s*!==\s*'desc'/);
  });

  test('mặc định sort TĂNG dần (tương thích hành vi cũ)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'src', 'services', 'OmiCallService.js'),
      'utf8'
    );
    expect(src).toMatch(/const sortDir = opts\.sortDir === 'desc' \? 'desc' : 'asc'/);
  });
});

describe('OmiCallService.listConversationsBoth — gom 2 chiều sort', () => {
  test('gộp 2 chiều và loại trùng theo convId', async () => {
    const spy = jest.spyOn(real, 'listConversations').mockImplementation(async (opts) => {
      if (opts.sortDir === 'desc') {
        return {
          success: true,
          conversations: [
            { convId: 'NEW_GROUP', name: 'Ốc 68 - QL 22B', convSubType: 'group' },
            { convId: 'OLD_A', name: 'Trùng', convSubType: 'group' },
          ],
        };
      }
      return {
        success: true,
        conversations: [
          { convId: 'OLD_A', name: 'Trùng', convSubType: 'group' },
          { convId: 'OLD_B', name: 'Cũ', convSubType: 'group' },
        ],
      };
    });

    const res = await real.listConversationsBoth({});
    expect(res.success).toBe(true);
    const ids = res.conversations.map((c) => c.convId);
    // NEW_GROUP phải có (nhóm mới tạo)
    expect(ids).toContain('NEW_GROUP');
    // OLD_A chỉ xuất hiện 1 lần (loại trùng)
    expect(ids.filter((i) => i === 'OLD_A')).toHaveLength(1);
    expect(ids).toHaveLength(3);

    spy.mockRestore();
  });

  test('có keyword → chỉ gọi 1 lần (không gom 2 chiều)', async () => {
    const spy = jest.spyOn(real, 'listConversations').mockResolvedValue({
      success: true,
      conversations: [{ convId: 'X', name: 'abc', convSubType: 'group' }],
    });

    const res = await real.listConversationsBoth({ keyword: 'abc' });
    expect(res.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  test('cả 2 chiều fail → trả error', async () => {
    const spy = jest.spyOn(real, 'listConversations').mockResolvedValue({
      success: false,
      error: 'Không tìm được endpoint',
    });

    const res = await real.listConversationsBoth({});
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();

    spy.mockRestore();
  });
});
