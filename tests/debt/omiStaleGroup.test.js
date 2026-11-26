/**
 * OMICALL — NHÓM ZALO "ĐÃ CHẾT" vs NHÓM "ĐANG SỐNG"
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh (2026-11-26):
 *  Khi agent RỜI nhóm Zalo rồi VÀO LẠI, OmiCall tạo một conversation MỚI (id
 *  khác) cho cùng một nhóm, còn conversation CŨ vẫn nằm trong danh sách và
 *  TRÙNG TÊN. Nếu không phân biệt, admin bấm nhầm conv đã chết → liên kết sai
 *  → mọi tin công nợ fail với "error_occurred".
 *
 *  Signals đã kiểm chứng trực tiếp trên server OmiCall production:
 *   - conv.status === 'inactive'                → nhóm đã kết thúc (đã rời nhóm)
 *   - conv.last_message.type === 'activity'      → tin cuối chỉ là sự kiện
 *                                                  agent vào nhóm, chưa có tin nhắn
 *   - conv.chat_session.joined_agents = []       → không còn nhân viên nào
 */
process.env.NODE_ENV = 'test';

const OmiCallService = require('../../src/services/OmiCallService');

/** Tạo payload conv giống hệt cấu trúc OmiCall trả về. */
function makeConv(opts = {}) {
  const conv = {
    _id: opts.convId || 'conv_1',
    conv_type: 'zalo_personal',
    conv_sub_type: 'group',
    name: opts.name || 'A Công - Gò Chai',
    status: opts.status === undefined ? null : opts.status,
    channel_id: 'chan_1',
    conv_id: '12345',
    created_date: opts.created || 1000,
    last_updated_date: opts.lastUpdated || 2000,
    chat_session: {
      joined_agents: opts.joined === undefined ? ['agent_1'] : opts.joined,
    },
    last_message_info: { send_time: opts.sendTime || 2000 },
  };
  if (opts.lastMessageType) {
    conv.last_message = { type: opts.lastMessageType, message_id: opts.messageId || null };
  }
  const raw = {
    id: conv._id,
    type: 'zalo_personal',
    channel_id: conv.channel_id,
    has_member: opts.hasMember === undefined ? true : opts.hasMember,
    member_ids: ['agent_1'],
    conv,
  };
  return {
    convId: conv._id,
    convNumber: conv.conv_id,
    channelId: conv.channel_id,
    name: conv.name,
    convType: conv.conv_type,
    convSubType: conv.conv_sub_type,
    type: raw.type,
    raw,
  };
}

describe('classifyConversationState — phân loại conv sống / conv chết', () => {
  test('conv bình thường (có tin nhắn chat) → sống', () => {
    const c = makeConv({ lastMessageType: 'chat', messageId: 'm1' });
    const r = OmiCallService.classifyConversationState(c);
    expect(r.isAlive).toBe(true);
    expect(r.isStale).toBe(false);
    expect(r.staleReason).toBe('');
  });

  test('conv.status = inactive → CHẾT (đã rời nhóm)', () => {
    const c = makeConv({ status: 'inactive', lastMessageType: 'chat', messageId: 'm1' });
    const r = OmiCallService.classifyConversationState(c);
    expect(r.isStale).toBe(true);
    expect(r.isAlive).toBe(false);
    expect(r.staleReason).toMatch(/ket thuc/);
  });

  test('tin cuối là activity (member_joined) + không có message_id → CHẾT', () => {
    const c = makeConv({ lastMessageType: 'activity', messageId: null });
    const r = OmiCallService.classifyConversationState(c);
    expect(r.isStale).toBe(true);
    expect(r.staleReason).toMatch(/hoat dong/);
  });

  test('joined_agents rỗng → CHẾT', () => {
    const c = makeConv({ joined: [] });
    const r = OmiCallService.classifyConversationState(c);
    expect(r.isStale).toBe(true);
    expect(r.staleReason).toMatch(/nhan vien/);
  });

  test('nhóm chưa gán agent (has_member=false) → KHÔNG coi là chết', () => {
    const c = makeConv({ hasMember: false, joined: null });
    const r = OmiCallService.classifyConversationState(c);
    expect(r.isStale).toBe(false);
    expect(r.needsAgent).toBe(true);
  });

  test('conv sống có lastActivityAt để sắp xếp', () => {
    const c = makeConv({ sendTime: 999999 });
    const r = OmiCallService.classifyConversationState(c);
    expect(r.lastActivityAt).toBe(999999);
  });
});
