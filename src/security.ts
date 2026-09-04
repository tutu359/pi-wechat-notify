// ============================================================================
// 微信桥接安全边界
// ============================================================================

/** 仅接受扫码凭证所绑定的微信用户。空用户 ID 一律不放行。 */
export function isAuthorizedWeChatSender(
  senderId: string | undefined,
  credentialUserId: string,
): boolean {
  return credentialUserId.length > 0 && senderId === credentialUserId
}
