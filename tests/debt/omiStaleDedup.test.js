/**
 * OMICALL — LOẠI CONV CHẾT + GỘP TRÙNG TÊN + TỰ ĐỘNG VÁ LINK
 * ─────────────────────────────────────────────────────────────────────────────
 * Kịch bản thật (2026-11-26):
 *  Nhóm "A Công - Gò Chai" có 2 conversation cùng tên:
 *    - 6afe6dda8135c67cd3313d5a → conv.status='inactive' (agent đã rời nhóm) → CHẾT
 *    - 6afe6913fca59218a5d6629d → conv sống, đã gửi tin OK
 *  → Nút "Tải nhóm" phải chỉ trả conv SỐNG, và link DB phải tự vá.
 */
process.env.NODE_ENV = 'test';

const OmiCallService = require('../../src/services/OmiCallService');
const real = jest.requireActual('../../src/services/OmiCallService');

function makeConv(convId, name, opts = {}) {
  const conv = {
    _id: convId,
    conv_type: 'zalo_personal',
    conv_sub_type: 'group',
    name,
    status: opts.status === undefined ? null : opts.status,
    channel_id: 'chan_1',
    conv_id: '999',
    created_date: opts.created || 1000,
    last_updated_date: opts.lastUpdated || 2000,
    chat_session: { joined_agents: opts.joined === undefined ? ['agent_1'] : opts.joined },
    last_message_info: { send_time: opts.sendTime || 2000 },
  };
  if (opts.lastMessageType) {
    conv.last_message = { type: opts.lastMessageType, message_id: opts.messageId || null };
  }
  const raw = {
    id: convId,
    type: 'zalo_personal',
    channel_id: conv.channel_id,
    has_member: opts.hasMember === undefined ? true : opts.hasMember,
    member_ids: ['agent_1'],
    conv,
  };
  return Object.assign(
    {
      convId,
      convNumber: conv.conv_id,
      channelId: conv.channel_id,
      name,
      convType: conv.conv_type,
      convSubType: conv.conv_sub_type,
      type: raw.type,
      raw,
    },
    OmiCallService.classifyConversationState({ convId, name, raw })
  );
}

const DEAD = '6afe6dda8135c67cd3313d5a';
const LIVE = '6afe6913fca59218a5d6629d';
const NAME = 'A Công - Gò Chai';

describe('pickLiveConversations — loại conv chết + gộp trùng tên', () => {
  test('loại bỏ conv đã chết', () => {
    const dead = makeConv(DEAD, NAME, { status: 'inactive', lastMessageType: 'activity' });
    const live = makeConv(LIVE, NAME, { lastMessageType: 'chat', messageId: 'm1' });
    const r = OmiCallService.pickLiveConversations([dead, live]);
    expect(r.list.map((c) => c.convId)).toEqual([LIVE]);
    expect(r.staleCount).toBe(1);
  });

  test('hai conv cùng tên → giữ conv hoạt động gần nhất', () => {
    const older = makeConv('OLD', NAME, { lastMessageType: 'chat', messageId: 'm1', sendTime: 100 });
    const newer = makeConv('NEW', NAME, { lastMessageType: 'chat', messageId: 'm2', sendTime: 9999 });
    const r = OmiCallService.pickLiveConversations([older, newer]);
    expect(r.list).toHaveLength(1);
    expect(r.list[0].convId).toBe('NEW');
  });

  test('tên khác nhau → giữ cả hai', () => {
    const a = makeConv('A', 'Nhóm A', { lastMessageType: 'chat', messageId: 'm1' });
    const b = makeConv('B', 'Nhóm B', { lastMessageType: 'chat', messageId: 'm2' });
    const r = OmiCallService.pickLiveConversations([a, b]);
    expect(r.list).toHaveLength(2);
  });

  test('sắp xếp nhóm hoạt động gần nhất lên đầu', () => {
    const old = makeConv('OLD', 'Nhóm A', { lastMessageType: 'chat', messageId: 'm1', sendTime: 100 });
    const neu = makeConv('NEW', 'Nhóm B', { lastMessageType: 'chat', messageId: 'm2', sendTime: 9999 });
    const r = OmiCallService.pickLiveConversations([old, neu]);
    expect(r.list[0].convId).toBe('NEW');
  });
});

describe('listConversationsBoth — trả về nhóm MỚI nhất', () => {
  afterEach(() => jest.restoreAllMocks());

  test('conv chết bị loại khỏi danh sách trả về', async () => {
    const spy = jest.spyOn(real, 'listConversations').mockResolvedValue({
      success: true,
      conversations: [
        makeConv(DEAD, NAME, { status: 'inactive', lastMessageType: 'activity' }),
        makeConv(LIVE, NAME, { lastMessageType: 'chat', messageId: 'm1', sendTime: 9999 }),
      ],
    });
    const res = await real.listConversationsBoth({});
    expect(res.success).toBe(true);
    expect(res.conversations.map((c) => c.convId)).toEqual([LIVE]);
    spy.mockRestore();
  });

  test('có keyword → cũng loại conv chết', async () => {
    const spy = jest.spyOn(real, 'listConversations').mockResolvedValue({
      success: true,
      conversations: [
        makeConv(DEAD, NAME, { status: 'inactive', lastMessageType: 'activity' }),
        makeConv(LIVE, NAME, { lastMessageType: 'chat', messageId: 'm1' }),
      ],
    });
    const res = await real.listConversationsBoth({ keyword: NAME });
    expect(res.success).toBe(true);
    expect(res.conversations.map((c) => c.convId)).toEqual([LIVE]);
    spy.mockRestore();
  });
});

describe('resolveLiveConvId — tìm conv sống thay thế conv chết', () => {
  afterEach(() => jest.restoreAllMocks());

  test('conv chết → trả về conv sống cùng tên', async () => {
    const spy = jest.spyOn(real, 'listConversations').mockResolvedValue({
      success: true,
      conversations: [
        makeConv(DEAD, NAME, { status: 'inactive', lastMessageType: 'activity' }),
        makeConv(LIVE, NAME, { lastMessageType: 'chat', messageId: 'm1', sendTime: 9999 }),
      ],
    });
    const r = await real.resolveLiveConvId({ convId: DEAD, groupName: NAME });
    expect(r.changed).toBe(true);
    expect(r.convId).toBe(LIVE);
    spy.mockRestore();
  });

  test('conv đang sống → giữ nguyên, không đổi', async () => {
    const spy = jest.spyOn(real, 'listConversations').mockResolvedValue({
      success: true,
      conversations: [
        makeConv(DEAD, NAME, { status: 'inactive', lastMessageType: 'activity' }),
        makeConv(LIVE, NAME, { lastMessageType: 'chat', messageId: 'm1', sendTime: 9999 }),
      ],
    });
    const r = await real.resolveLiveConvId({ convId: LIVE, groupName: NAME });
    expect(r.changed).toBe(false);
    expect(r.convId).toBe(LIVE);
    spy.mockRestore();
  });

  test('thiếu tên nhóm → không đổi (fail-safe)', async () => {
    const r = await real.resolveLiveConvId({ convId: DEAD, groupName: '' });
    expect(r.changed).toBe(false);
    expect(r.convId).toBe(DEAD);
    expect(r.reason).toBeTruthy();
  });
});
