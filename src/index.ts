// ============================================================================
// pi-wechat-assistant — 微信通知广播站（单向：pi 会话 → 微信）
//
// 设计定稿（方案 C-lite）：
//   - 常驻 daemon 独占微信连接；扩展通过本地 HTTP 与它交互（见 daemon-client.ts）
//   - 有本地凭证的会话在 session_start 自动注册发送工具，零命令可用
//   - 所有出站通知自动带会话前缀：【Session name】或【目录名 #PID】
//   - 入站微信消息由 daemon 拉取后丢弃，不进入任何会话
// ============================================================================

import { existsSync, statSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Type } from '@sinclair/typebox'
// @ts-ignore — @earendil-works is the current package, but the older package still carries TS declarations used for compatibility here
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { loadCredentials } from './auth.js'
import { debugLog, isDebugEnabled } from './logger.js'
import { registerCommands } from './commands.js'
import {
  daemonSendText,
  daemonSendFile,
  daemonSendImage,
  daemonShutdown,
  probeDaemon,
  DaemonSendError,
} from './daemon-client.js'
import { ok, fail, formatError } from './utils.js'
import {
  sessionDisplayName,
  withPrefix,
  maybeConvertToTextFile,
  isPathInCwd,
  MAX_FILE_BYTES,
  TEXT_TO_FILE_THRESHOLD,
} from './notify.js'

type Ctx = ExtensionContext | ExtensionCommandContext

// ============================================================================
// 会话级状态
// ============================================================================

interface WechatSessionState {
  /** 前缀显示名（Session name 优先，兜底目录名+PID） */
  displayName: string
  /** 发送目标：绑定的微信用户（即 daemon 登录账号自己） */
  targetUserId: string | null
}

export default function wechatAssistant(pi: ExtensionAPI) {
  let latestCtx: Ctx | null = null
  let state: WechatSessionState | null = null
  let loggedIn = false

  function notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (latestCtx?.hasUI) {
      latestCtx.ui.notify(message, level)
      if (!isDebugEnabled()) return
    }
    const printer = level === 'error' ? console.error : console.log
    printer(`[wechat-assistant/${level}] ${message}`)
  }

  function updateStatusBar(): void {
    if (!latestCtx?.hasUI) return
    if (!loggedIn) { latestCtx.ui.setStatus('wechat', ''); return }
    const hasDaemon = state?.targetUserId != null
    latestCtx.ui.setStatus('wechat', hasDaemon ? '[微信 ✅ 通知可用]' : '[微信 ⏸ 连接中]')
  }

  // ============================================================================
  // 工具注册（有凭证才注册）
  // ============================================================================

  function registerTools(): void {
    const requireTarget = (): { userId: string; cwd: string } | null => {
      const cwd = latestCtx?.cwd ?? process.cwd()
      if (!state?.targetUserId) return null
      return { userId: state.targetUserId, cwd }
    }

    // --- 纯文本通知（超阈值自动转 md 文件） ---

    pi.registerTool({
      name: 'send_text_to_wechat',
      label: 'Send Text to WeChat',
      description: '发送简短文本通知到微信。超长内容（>1000字）会自动转为 .md 文件发送。',
      promptSnippet: '发送文本通知到微信',
      promptGuidelines: [
        '通知类内容（结论、提醒、任务完成）可主动推送到微信。',
        '长文档请先写入项目内文件，再用 send_file_to_wechat 发送。',
        '发送失败不要重试超过 1 次。',
      ],
      parameters: Type.Object({
        text: Type.String({ description: '要发送的文本内容' }),
      }),
      async execute(_toolCallId, params) {
        const target = requireTarget()
        if (!target) return fail('微信未连接，请先在 TUI 执行 /wechat login')
        try {
          const filePath = await maybeConvertToTextFile(params.text, TEXT_TO_FILE_THRESHOLD, path.join(target.cwd, 'tmp'))
          if (filePath) {
            // 长文本转文件：文件内容同样带会话前缀，保持消息来源可辨
            const prefixed = withPrefix(state!.displayName, params.text)
            await fs.writeFile(filePath, prefixed, 'utf-8')
            await daemonSendFile(target.userId, filePath, path.basename(filePath))
            return ok(`✅ 内容较长 (${params.text.length} 字)，已转为文件「${path.basename(filePath)}」发送到微信`)
          }
          await daemonSendText(target.userId, withPrefix(state!.displayName, params.text))
          return ok('✅ 已发送到微信')
        } catch (err) {
          debugLog(`send_text_to_wechat 失败: ${formatError(err)}`)
          return fail(`发送失败: ${formatError(err)}`)
        }
      },
    })

    // --- 文件通知 ---

    pi.registerTool({
      name: 'send_file_to_wechat',
      label: 'Send File to WeChat',
      description: '发送项目目录中的文件到微信。用于将 AI 产出的代码、报告等文件直接发给微信用户。',
      promptSnippet: '发送项目目录中的文件到微信',
      promptGuidelines: [
        '当用户要求产出文件时，先写入项目文件再用 send_file_to_wechat 发送。',
        '只能发送项目工作目录内的文件（安全限制）。',
        '发送失败不要重试超过 1 次。',
      ],
      parameters: Type.Object({
        filePath: Type.String({ description: '要发送的文件路径（项目目录内的绝对路径或相对路径）' }),
        fileName: Type.Optional(Type.String({ description: '在微信中显示的文件名（可选，默认使用原文件名）' })),
      }),
      async execute(_toolCallId, params) {
        const target = requireTarget()
        if (!target) return fail('微信未连接，请先在 TUI 执行 /wechat login')

        const resolvedPath = path.isAbsolute(params.filePath)
          ? params.filePath
          : path.join(target.cwd, params.filePath)
        if (!isPathInCwd(resolvedPath, target.cwd)) {
          return fail(`安全限制：只能发送项目目录内的文件。\n路径: ${resolvedPath}\n项目: ${path.resolve(target.cwd)}`)
        }
        if (!existsSync(resolvedPath)) return fail(`文件不存在: ${resolvedPath}`)

        const size = statSync(resolvedPath).size
        if (size > MAX_FILE_BYTES) {
          return fail(`文件过大 (${(size / 1024 / 1024).toFixed(1)}MB)，上限 50MB`)
        }

        try {
          await daemonSendFile(target.userId, resolvedPath, params.fileName)
          const name = params.fileName ?? path.basename(resolvedPath)
          return ok(`✅ 文件「${name}」(${(size / 1024).toFixed(1)} KB) 已发送到微信`)
        } catch (err) {
          debugLog(`send_file_to_wechat 失败: ${formatError(err)}`)
          return fail(`发送失败: ${formatError(err)}`)
        }
      },
    })

    // --- 图片通知 ---

    pi.registerTool({
      name: 'send_image_to_wechat',
      label: 'Send Image to WeChat',
      description: '发送项目目录中的图片到微信（可预览）。用于将 AI 生成的图表、截图等直接发给微信用户。',
      promptSnippet: '发送项目目录中的图片到微信（可预览）',
      promptGuidelines: [
        '当用户要求生成图表/截图/图片时，先生成图片文件再用 send_image_to_wechat 发送。',
        '只能发送项目工作目录内的图片（安全限制）。',
        '发送失败不要重试超过 1 次。',
      ],
      parameters: Type.Object({
        imagePath: Type.String({ description: '要发送的图片路径（项目目录内的绝对路径或相对路径，支持 png/jpg/gif/webp）' }),
      }),
      async execute(_toolCallId, params) {
        const target = requireTarget()
        if (!target) return fail('微信未连接，请先在 TUI 执行 /wechat login')

        const resolvedPath = path.isAbsolute(params.imagePath)
          ? params.imagePath
          : path.join(target.cwd, params.imagePath)
        if (!isPathInCwd(resolvedPath, target.cwd)) {
          return fail(`安全限制：只能发送项目目录内的图片。\n路径: ${resolvedPath}\n项目: ${path.resolve(target.cwd)}`)
        }
        if (!existsSync(resolvedPath)) return fail(`图片不存在: ${resolvedPath}`)

        const size = statSync(resolvedPath).size
        if (size > MAX_FILE_BYTES) {
          return fail(`图片过大 (${(size / 1024 / 1024).toFixed(1)}MB)，上限 50MB`)
        }

        try {
          await daemonSendImage(target.userId, resolvedPath)
          return ok(`✅ 图片 (${(size / 1024).toFixed(1)} KB) 已发送到微信`)
        } catch (err) {
          debugLog(`send_image_to_wechat 失败: ${formatError(err)}`)
          return fail(`发送失败: ${formatError(err)}`)
        }
      },
    })
  }

  // ============================================================================
  // 事件
  // ============================================================================

  pi.on('session_start', async (_event, ctx) => {
    latestCtx = ctx

    const creds = await loadCredentials()
    if (!creds) {
      loggedIn = false
      state = null
      updateStatusBar()
      return
    }

    loggedIn = true
    const sessionName = safeSessionName(ctx)
    state = {
      displayName: sessionDisplayName(sessionName, ctx.cwd),
      // 发送目标：绑定的微信账号（daemon 登录的 bot 对应的绑定用户）
      targetUserId: creds.userId,
    }
    registerTools()
    updateStatusBar()
    debugLog(`[wechat] 会话已连接通知通道: prefix=${state.displayName}`)
  })

  pi.on('session_shutdown', async () => {
    // 只断本会话，daemon 常驻
    state = null
    updateStatusBar()
  })

  // ============================================================================
  // TUI 命令
  // ============================================================================

  registerCommands(pi, {
    pi,
    getCtx: () => latestCtx,
    setCtx: (ctx) => { latestCtx = ctx },
    isLoggedIn: () => loggedIn,
    getState: () => state,
    setState: (s) => { state = s },
    setLoggedIn: (v) => { loggedIn = v; updateStatusBar() },
    notify,
    registerTools,
    daemonShutdown,
    probeDaemon,
    formatError,
  })
}

// ============================================================================
// 辅助
// ============================================================================

function safeSessionName(ctx: Ctx): string | null {
  try {
    // SAFETY: pi 的 ExtensionContext 实现总是带 sessionManager（docs/session-format.md）;
    // 此处用可选探测以兼容旧版本运行时，任何缺失/异常都回退到 null。
    const sm = (ctx as unknown as { sessionManager?: { getSessionName?: () => string | null } }).sessionManager
    return sm?.getSessionName?.() ?? null
  } catch {
    return null
  }
}

export { DaemonSendError }
