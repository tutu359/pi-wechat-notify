// ============================================================================
// TUI 命令处理（/wechat login | logout | status）
// ============================================================================

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import {
  clearCredentials,
  clearContextTokens,
  clearTransportState,
  getCredentialsPath,
  getQrCode,
  loadCredentials,
  pollQrStatus,
  saveCredentials,
} from './auth.js'
import { renderQrCode } from './utils.js'
import { daemonReload } from './daemon-client.js'
import { QR_POLL_INTERVAL_MS, QR_MAX_REFRESH } from './constants.js'

type Ctx = ExtensionContext | ExtensionCommandContext

export interface WechatSessionState {
  displayName: string
  targetUserId: string | null
}

export interface CommandDeps {
  pi: ExtensionAPI
  getCtx: () => Ctx | null
  setCtx: (ctx: Ctx) => void
  isLoggedIn: () => boolean
  setLoggedIn: (v: boolean) => void
  getState: () => WechatSessionState | null
  setState: (s: WechatSessionState | null) => void
  notify: (message: string, level: 'info' | 'warning' | 'error') => void
  registerTools: () => void
  daemonShutdown: () => Promise<void>
  probeDaemon: () => Promise<{ status: { userId: string | null; accountId: string | null; running: boolean; expired: boolean; pid: number | null; port: number | null } } | null>
  formatError: (err: unknown) => string
}

// --- 登录 ---

async function cmdLogin(args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setCtx(ctx)
  const force = args.split(/\s+/).includes('--force')

  if (!force) {
    const creds = await loadCredentials()
    if (creds) {
      // 已有凭证：确保 daemon 可用并注册工具
      deps.setLoggedIn(true)
      deps.setState({ displayName: deps.getState()?.displayName ?? '(unknown)', targetUserId: creds.userId })
      deps.registerTools()
      try {
        await daemonReload()
        deps.notify('微信凭证已存在，daemon 已连接 ✅（--force 可重新扫码）', 'info')
      } catch (err) {
        deps.notify(`daemon 连接失败: ${deps.formatError(err)}`, 'error')
      }
      return
    }
  }

  if (force) {
    await Promise.all([clearContextTokens(), clearTransportState()])
  }

  let currentBaseUrl: string | undefined
  try {
    const qr = await getQrCode(currentBaseUrl)
    const qrText = await renderQrCode(qr.url)
    deps.notify(`请用微信扫码登录：\n\n${qrText}\n\n二维码链接：${qr.url}`, 'info')

    let lastStatus: string | null = null
    let refreshCount = 0

    while (true) {
      await new Promise(r => setTimeout(r, QR_POLL_INTERVAL_MS))
      const result = await pollQrStatus(qr.token, currentBaseUrl)

      if (result.redirectHost) {
        currentBaseUrl = `https://${result.redirectHost}`
      }
      if (result.status === lastStatus) continue
      lastStatus = result.status

      if (result.status === 'scaned') { deps.notify('已扫码，请在手机上确认登录', 'info'); continue }

      if (result.status === 'confirmed' && result.credentials) {
        await saveCredentials(result.credentials)
        deps.setLoggedIn(true)
        deps.setState({ displayName: deps.getState()?.displayName ?? '(unknown)', targetUserId: result.credentials.userId })
        deps.registerTools()
        try {
          await daemonReload()
        } catch {
          // daemon 首次拉起由下次发送时 ensureDaemon 兜底
        }
        deps.notify('微信登录成功 ✅ 通知通道已就绪', 'info')
        return
      }

      if (result.status === 'expired') {
        refreshCount++
        if (refreshCount >= QR_MAX_REFRESH) {
          deps.notify('二维码多次过期，请重新执行 /wechat login', 'error')
          return
        }
        deps.notify(`二维码已过期，正在刷新 (${refreshCount}/${QR_MAX_REFRESH})...`, 'info')
        const newQr = await getQrCode(currentBaseUrl)
        qr.token = newQr.token
        const newQrText = await renderQrCode(newQr.url)
        deps.notify(`请重新扫码：\n\n${newQrText}\n\n二维码链接：${newQr.url}`, 'info')
        lastStatus = null
      }

      if (result.status === 'scaned_but_redirect') continue
    }
  } catch (error) {
    deps.notify(`微信登录失败: ${deps.formatError(error)}`, 'error')
  }
}

// --- 登出 ---

async function cmdLogout(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setCtx(ctx)
  try { await deps.daemonShutdown() } catch { /* daemon 可能本来就没活着 */ }
  await Promise.all([
    clearCredentials(),
    clearContextTokens(),
    clearTransportState(),
  ])
  deps.setLoggedIn(false)
  deps.setState(null)
  deps.notify(`已清除微信凭证并关停 daemon: ${getCredentialsPath()}`, 'info')
}

// --- 状态 ---

async function cmdStatus(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setCtx(ctx)
  const creds = await loadCredentials()
  const probed = await deps.probeDaemon()
  const state = deps.getState()
  const lines = [
    `凭证状态: ${creds ? '✅ 已登录' : '❌ 未登录（/wechat login 扫码）'}`,
    `daemon: ${probed ? `✅ 运行中 (PID ${probed.status.pid}, 端口 ${probed.status.port ?? '-'})` : '⏸ 未运行（发送时自动拉起）'}`,
    probed ? `daemon 轮询: ${probed.status.running ? '正常' : probed.status.expired ? '❌ session 过期，请重新 login' : '未运行'}` : '',
    probed ? `绑定账号: ${probed.status.accountId ?? '-'} (${probed.status.userId ?? '-'})` : '',
    `本会话前缀: ${state ? `【${state.displayName}】` : '-（未连接）'}`,
    `凭证路径: ${getCredentialsPath()}`,
  ].filter(Boolean)
  deps.notify(lines.join('\n'), 'info')
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand('wechat', {
    description: '微信通知：login | logout | status',
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/)
      const restArgs = rest.join(' ')
      const help = [
        '/wechat login          扫码登录（已有凭证则重连 daemon）',
        '/wechat login --force  强制重新扫码',
        '/wechat logout         清除凭证并关停 daemon',
        '/wechat status         查看状态',
      ].join('\n')
      switch (sub) {
        case 'login': return cmdLogin(restArgs, ctx, deps)
        case 'logout': return cmdLogout(restArgs, ctx, deps)
        case 'status': return cmdStatus(restArgs, ctx, deps)
        default: deps.notify(`未知子命令: ${sub || '(无)'}\n\n${help}`, 'warning')
      }
    },
  })
}
