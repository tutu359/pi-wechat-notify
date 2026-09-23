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

  // 探活失败：清理陈旧/失配状态与僵尸 daemon，避免「每次发送都拉一个新 daemon、
  // 新 daemon 又覆盖 daemon.json」的钝化循环。
  await recoverStaleState()

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

  let exitInfo: { code: number | null; signal: string | null } | null = null
  child.once('exit', (code, signal) => { exitInfo = { code, signal } })

  for (let i = 0; i < SPAWN_WAIT_ROUNDS; i++) {
    await new Promise(r => setTimeout(r, SPAWN_WAIT_INTERVAL_MS))
    probed = await probeDaemon()
    if (probed) return probed.info
    if (exitInfo) {
      const { code, signal } = exitInfo as { code: number | null; signal: string | null }
      throw new DaemonSendError(
        `daemon 启动即退出 (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})。` +
        '常见原因：无本地凭证、端口被其他进程占用。请先执行 /wechat status 检查。',
      )
    }
  }
  throw new DaemonSendError(
    `daemon 拉起失败（等待 ${Math.round((SPAWN_WAIT_ROUNDS * SPAWN_WAIT_INTERVAL_MS) / 1000)}s 无响应）。请检查凭证与日志。`,
  )
}

// --- 陈旧状态恢复 ---

async function removeDaemonFile(): Promise<void> {
  try { await fs.unlink(DAEMON_FILE) } catch { /* ignore */ }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 找出命令行里带本扩展 daemon 入口的进程（含已被覆盖状态、我们已无法控制的实例） */
async function findDaemonPids(): Promise<number[]> {
  const { execFile } = await import('node:child_process')
  return new Promise(resolve => {
    execFile('ps', ['-ax', '-o', 'pid=,command='], (err, stdout) => {
      if (err || !stdout) { resolve([]); return }
      const marker = path.join(PKG_ROOT, 'daemon')
      const pids = stdout.split('\n')
        .filter(line => line.includes(marker) && line.includes('index.ts'))
        .map(line => Number(line.trim().split(/\s+/)[0]))
        .filter(pid => Number.isFinite(pid) && pid > 0 && pid !== process.pid)
      resolve(pids)
    })
  })
}

/**
 * 探活失败时清理现场：
 *   - daemon.json 指向已死进程 → 删掉该文件
 *   - 仍有 daemon 进程活着（可能是 token 被覆盖后我们无法再对话的僵尸实例）→ 先终止它
 */
async function recoverStaleState(): Promise<void> {
  const info = await readDaemonInfo()
  if (info && !isProcessAlive(info.pid)) {
    debugLog(`[daemon-client] 清理失效 daemon.json (pid ${info.pid} 已退出)`)
    await removeDaemonFile()
  }

  const pids = await findDaemonPids()
  if (pids.length > 0) {
    debugLog(`[daemon-client] 发现失联 daemon 进程，终止: ${pids.join(', ')}`)
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ }
    }
    // 给它们一点时间释放端口
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 200))
      if (pids.every(pid => !isProcessAlive(pid))) break
    }
    // 僵尸实例退出时也会清自己的 daemon.json；重新确认一次
    const after = await readDaemonInfo()
    if (after && !isProcessAlive(after.pid)) await removeDaemonFile()
  }
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
