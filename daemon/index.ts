#!/usr/bin/env node
// ============================================================================
// pi-wechat-daemon — 常驻微信通知广播进程
//
// 定位（方案定稿）：单向通知广播站
//   - 独占微信 ilink bot 连接、游标、去重与文件锁
//   - 入站消息：长轮询拉取但丢弃（推进游标，服务器不留积压，日志留痕）
//   - 出站：send-text / send-file / send-image，多个 pi 会话共享
//   - 生命周期：由扩展按需拉起（detached）；logout 关停；机器重启后自动再拉
//
// 手动运行：node --import tsx daemon/index.ts
// ============================================================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { WeixinClient, SessionExpiredError } from '../src/client.js'
import { acquireLock, releaseLock, loadCredentials } from '../src/auth.js'
import { isAuthorizedWeChatSender } from '../src/security.js'
import { debugLog } from '../src/logger.js'
import { DAEMON_PORT, DAEMON_FILE, DaemonRoutes, type DaemonInfo } from '../src/daemon-shared.js'

const PORT = Number(process.env.PI_WECHAT_DAEMON_PORT ?? DAEMON_PORT)
const DAEMON_SESSION = 'daemon'

// --- 共享状态 ---

let client: WeixinClient | null = null
let expired = false       // 微信 session 过期，等待重新扫码
let polling = false       // 轮询循环是否存活

// --- daemon.json ---

async function writeDaemonInfo(): Promise<string> {
  const token = randomUUID()
  const info: DaemonInfo = { port: PORT, token, pid: process.pid, startedAt: new Date().toISOString() }
  await fs.writeFile(DAEMON_FILE, JSON.stringify(info, null, 2), { mode: 0o600 })
  return token
}

async function clearDaemonInfo(): Promise<void> {
  try { await fs.unlink(DAEMON_FILE) } catch { /* ignore */ }
}

// --- HTTP 帮助 ---

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return null
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T } catch { return null }
}

// --- 路由 ---

async function handle(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const route = `${req.method} ${url.pathname}`

  // 所有路由（含 /status）都要求 Bearer token：防止本机其他进程探测账号信息
  if ((req.headers.authorization ?? '') !== `Bearer ${token}`) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' })
    return
  }

  switch (route) {
    case `GET ${DaemonRoutes.status}`: {
      sendJson(res, 200, {
        ok: true,
        running: polling && !expired,
        expired,
        hasClient: !!client,
        userId: client?.userId ?? null,
        accountId: client?.accountId ?? null,
        pid: process.pid,
      })
      return
    }

    case `POST ${DaemonRoutes.sendText}`: {
      const body = await readBody<{ userId?: string; text?: string }>(req)
      if (!client || expired) { sendJson(res, 409, { ok: false, error: 'daemon 未登录微信' }); return }
      if (!body?.userId || !body.text) { sendJson(res, 400, { ok: false, error: 'userId/text required' }); return }
      try {
        await client.sendText(body.userId, body.text)
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err) })
      }
      return
    }

    case `POST ${DaemonRoutes.sendFile}`:
    case `POST ${DaemonRoutes.sendImage}`: {
      const body = await readBody<{ userId?: string; imagePath?: string }>(req)
      if (!client || expired) { sendJson(res, 409, { ok: false, error: 'daemon 未登录微信' }); return }
      if (!body?.userId || !body.imagePath) { sendJson(res, 400, { ok: false, error: 'userId/imagePath required' }); return }
      try {
        await client.sendImage(body.userId, body.imagePath)
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err) })
      }
      return
    }

    case `POST ${DaemonRoutes.reload}`: {
      // 登录成功/凭证更新后重建客户端
      const creds = await loadCredentials()
      if (!creds) { sendJson(res, 409, { ok: false, error: '无本地凭证' }); return }
      await disposeClient()
      client = await WeixinClient.create(creds)
      expired = false
      if (!polling) startPolling()
      sendJson(res, 200, { ok: true, userId: client.userId })
      return
    }

    case `POST ${DaemonRoutes.shutdown}`: {
      sendJson(res, 200, { ok: true })
      void shutdown()
      return
    }

    default:
      sendJson(res, 404, { ok: false, error: `unknown route: ${route}` })
  }
}

// --- 客户端与入站消费（拉取即丢弃） ---

async function disposeClient(): Promise<void> {
  if (client) await client.dispose().catch(() => {})
  client = null
}

function startPolling(): void {
  if (polling) return
  polling = true
  void pollLoop()
}

async function pollLoop(): Promise<void> {
  let retryDelay = 1_000
  while (polling && client && !expired) {
    const activeClient = client
    try {
      const messages = await activeClient.getUpdates()
      retryDelay = 1_000
      for (const m of messages) {
        // 拉取但丢弃：仅日志留痕；未授权来源静默跳过
        if (!isAuthorizedWeChatSender(m.raw.from_user_id, activeClient.userId)) continue
        debugLog(`[daemon] 收到来自 ${m.userId} 的消息（已丢弃）: ${(m.text ?? '').slice(0, 50)}`)
      }
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        debugLog('[daemon] 微信 Session 已过期，等待 /reload')
        expired = true
        polling = false
        await releaseLock(DAEMON_SESSION).catch(() => {})
        return
      }
      debugLog(`[daemon] 轮询失败: ${error}`)
      await new Promise(r => setTimeout(r, retryDelay))
      retryDelay = Math.min(retryDelay * 2, 10_000)
    }
  }
}

async function shutdown(): Promise<void> {
  polling = false
  await releaseLock(DAEMON_SESSION).catch(() => {})
  await disposeClient()
  await clearDaemonInfo()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

// --- 启动 ---

async function main(): Promise<void> {
  const creds = await loadCredentials()
  if (!creds) {
    console.error('[pi-wechat-daemon] 未找到微信凭证，请先在 pi 中执行 /wechat login')
    process.exit(2)
  }

  const lockResult = await acquireLock(DAEMON_SESSION)
  if (!lockResult.success) {
    console.error(`[pi-wechat-daemon] ${lockResult.message}`)
    process.exit(3)
  }

  const token = await writeDaemonInfo()

  client = await WeixinClient.create(creds)
  startPolling()

  const server = createServer((req, res) => {
    void handle(req, res, token).catch(err => {
      debugLog(`[daemon] 请求处理异常: ${err}`)
      try { sendJson(res, 500, { ok: false, error: String(err) }) } catch { /* ignore */ }
    })
  })
  server.listen(PORT, '127.0.0.1', () => {
    debugLog(`[pi-wechat-daemon] 已启动: http://127.0.0.1:${PORT} (userId=${client?.userId})`)
  })
}

void main().catch(err => {
  console.error(`[pi-wechat-daemon] 启动失败: ${err}`)
  process.exit(1)
})
