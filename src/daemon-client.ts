// ============================================================================
// DaemonBridge — 扩展侧与 pi-wechat-daemon 的本地 HTTP 客户端
//
// 职责：
//   1. 读取 daemon.json（共享定义见 daemon-shared.ts）
//   2. 探活 /status；不健康时自动拉起 daemon（node --import tsx daemon/index.ts）
//   3. send-text / send-file / send-image 转发
// ============================================================================

import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { debugLog } from './logger.js'
import { DAEMON_PORT, DAEMON_FILE, DaemonRoutes, type DaemonInfo } from './daemon-shared.js'

const SPAWN_WAIT_ROUNDS = 25
const SPAWN_WAIT_INTERVAL_MS = 200

export interface DaemonStatus {
  running: boolean
  expired: boolean
  userId: string | null
  accountId: string | null
  pid: number | null
  port: number | null
}

export class DaemonSendError extends Error {}

/** 扩展所在包根（daemon/index.ts 相对路径基于此） */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function readDaemonInfo(): Promise<DaemonInfo | null> {
  try {
    const raw = await fs.readFile(DAEMON_FILE, 'utf-8')
    const info = JSON.parse(raw) as DaemonInfo
    return info?.port && info?.token ? info : null
  } catch {
    return null
  }
}

// --- HTTP ---

async function daemonRequest<T>(
  info: DaemonInfo,
  route: string,
  body?: unknown,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${info.token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const data = (await response.json()) as { ok?: boolean; error?: string } & T
    if (!response.ok || data.ok === false) {
      throw new DaemonSendError(`daemon ${route} 失败: ${data.error ?? response.status}`)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

// --- 探活与拉起 ---

export async function probeDaemon(): Promise<{ info: DaemonInfo; status: DaemonStatus } | null> {
  const info = await readDaemonInfo()
  if (!info) return null
  try {
    const status = await daemonRequest<{
      running: boolean
      expired: boolean
      userId: string | null
      accountId: string | null
      pid: number
    }>(info, DaemonRoutes.status, undefined, 3_000)
    return {
      info,
      status: {
        running: status.running,
        expired: status.expired,
        userId: status.userId,
        accountId: status.accountId,
        pid: status.pid,
        port: info.port,
      },
    }
  } catch {
    return null
  }
}

/** 确保 daemon 存活并已登录；需要时自动拉起。失败抛 DaemonSendError。 */
export async function ensureDaemon(): Promise<DaemonInfo> {
  let probed = await probeDaemon()
  if (probed) return probed.info

  // 拉起 daemon（detached，随 pi 退出继续常驻）
  debugLog('[daemon-client] daemon 不可达，尝试拉起...')
  const daemonEntry = path.join(PKG_ROOT, 'daemon', 'index.ts')
  const child = spawn(process.execPath, ['--import', 'tsx', daemonEntry], {
    cwd: PKG_ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PI_WECHAT_DAEMON_PORT: String(DAEMON_PORT) },
  })
  child.unref()

  for (let i = 0; i < SPAWN_WAIT_ROUNDS; i++) {
    await new Promise(r => setTimeout(r, SPAWN_WAIT_INTERVAL_MS))
    probed = await probeDaemon()
    if (probed) return probed.info
  }
  throw new DaemonSendError(
    `daemon 拉起失败（等待 ${Math.round((SPAWN_WAIT_ROUNDS * SPAWN_WAIT_INTERVAL_MS) / 1000)}s 无响应）。请检查凭证与日志。`,
  )
}

// --- 出站接口（失败自动重发一次，再失败才抛错） ---

async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    debugLog(`[daemon-client] 发送失败，重试一次: ${formatErr(err)}`)
    return await fn()
  }
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function daemonSendText(userId: string, text: string): Promise<void> {
  await withOneRetry(async () => {
    const info = await ensureDaemon()
    await daemonRequest(info, DaemonRoutes.sendText, { userId, text }, 30_000)
  })
}

export async function daemonSendFile(userId: string, filePath: string, fileName?: string): Promise<void> {
  await withOneRetry(async () => {
    const info = await ensureDaemon()
    await daemonRequest(info, DaemonRoutes.sendFile, { userId, filePath, fileName }, 60_000)
  })
}

export async function daemonSendImage(userId: string, imagePath: string): Promise<void> {
  await withOneRetry(async () => {
    const info = await ensureDaemon()
    await daemonRequest(info, DaemonRoutes.sendImage, { userId, imagePath }, 60_000)
  })
}

export async function daemonReload(): Promise<void> {
  const info = await ensureDaemon()
  await daemonRequest(info, DaemonRoutes.reload)
}

export async function daemonShutdown(): Promise<void> {
  const probed = await probeDaemon()
  if (probed) await daemonRequest(probed.info, DaemonRoutes.shutdown)
}
