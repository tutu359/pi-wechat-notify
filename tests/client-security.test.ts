// ============================================================================
// 测试: 微信客户端只能接收扫码凭证绑定用户的消息
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiGetUpdates: vi.fn(),
  loadContextTokens: vi.fn(),
  saveContextTokensThrottled: vi.fn(),
  loadCursor: vi.fn(),
  saveCursor: vi.fn(),
  loadSeenIds: vi.fn(),
  saveSeenIds: vi.fn(),
}))

vi.mock('../src/api.js', () => ({
  getUpdates: mocks.apiGetUpdates,
  getConfig: vi.fn(),
  sendMessage: vi.fn(),
  sendTyping: vi.fn(),
  getUploadUrl: vi.fn(),
  uploadToCdn: vi.fn(),
  sendMediaMessage: vi.fn(),
  isSessionExpired: vi.fn(() => false),
}))

vi.mock('../src/auth.js', () => ({
  loadContextTokens: mocks.loadContextTokens,
  saveContextTokensThrottled: mocks.saveContextTokensThrottled,
  flushContextTokens: vi.fn().mockResolvedValue(undefined),
  loadCursor: mocks.loadCursor,
  saveCursor: mocks.saveCursor,
  loadSeenIds: mocks.loadSeenIds,
  saveSeenIds: mocks.saveSeenIds,
}))

import { WeixinClient } from '../src/client.js'

const credentials = {
  token: 'token',
  baseUrl: 'https://example.test',
  accountId: 'bot',
  userId: 'bound-user',
}

function rawMessage(messageId: string, fromUserId: string) {
  return {
    message_type: 1,
    message_id: messageId,
    from_user_id: fromUserId,
    to_user_id: 'bot',
    context_token: `context-${messageId}`,
    create_time_ms: Date.now(),
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  }
}

describe('WeixinClient sender authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadContextTokens.mockResolvedValue({ lastUserId: null, tokens: {} })
    mocks.loadCursor.mockResolvedValue('')
    mocks.loadSeenIds.mockResolvedValue(new Set<string>())
    mocks.saveCursor.mockResolvedValue(undefined)
    mocks.saveSeenIds.mockResolvedValue(undefined)
  })

  it('drops an unbound sender before caching context or producing a message', async () => {
    mocks.apiGetUpdates.mockResolvedValue({
      get_updates_buf: 'cursor-1',
      msgs: [rawMessage('attacker-message', 'other-user')],
    })
    const client = await WeixinClient.create(credentials)

    await expect(client.getUpdates()).resolves.toEqual([])
    expect(client.lastActiveUserId).toBeNull()
    expect(client.getKnownUsers()).toEqual([])
    expect(mocks.saveContextTokensThrottled).not.toHaveBeenCalled()
    expect(mocks.saveSeenIds).not.toHaveBeenCalled()
  })

  it('accepts the user bound to the QR-login credential', async () => {
    mocks.apiGetUpdates.mockResolvedValue({
      get_updates_buf: 'cursor-1',
      msgs: [rawMessage('owner-message', 'bound-user')],
    })
    const client = await WeixinClient.create(credentials)

    const messages = await client.getUpdates()

    expect(messages).toHaveLength(1)
    expect(messages[0].userId).toBe('bound-user')
    expect(client.lastActiveUserId).toBe('bound-user')
    expect(client.getKnownUsers()).toEqual(['bound-user'])
    expect(mocks.saveContextTokensThrottled).toHaveBeenCalledWith({
      lastUserId: 'bound-user',
      tokens: { 'bound-user': 'context-owner-message' },
    })
  })

  it('restores only context belonging to the currently bound user', async () => {
    mocks.loadContextTokens.mockResolvedValue({
      lastUserId: 'other-user',
      tokens: {
        'bound-user': 'owner-context',
        'other-user': 'stale-context',
      },
    })

    const client = await WeixinClient.create(credentials)

    expect(client.lastActiveUserId).toBeNull()
    expect(client.getKnownUsers()).toEqual(['bound-user'])
  })
})
