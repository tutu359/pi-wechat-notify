import { describe, expect, it } from 'vitest'
import { isAuthorizedWeChatSender } from '../src/security.js'

describe('微信发送者身份校验', () => {
  it('only accepts the user ID bound by QR login', () => {
    expect(isAuthorizedWeChatSender('bound-user', 'bound-user')).toBe(true)
    expect(isAuthorizedWeChatSender('other-user', 'bound-user')).toBe(false)
    expect(isAuthorizedWeChatSender(undefined, 'bound-user')).toBe(false)
    expect(isAuthorizedWeChatSender('', '')).toBe(false)
  })
})
