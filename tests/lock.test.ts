import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// 锁文件路径写死在 auth.ts 的 STATE_DIR，测试用子进程方式隔离成本高；
// 这里直接对「锁语义」这一契约做最小验证：同 sessionId 可续期，
// 不同 sessionId 且持有者进程存活时必须拒绝。
// 通过 HOME 重定向构造独立状态目录，避免污染真实状态。

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'pi-wechat-lock-'))
process.env.HOME = tmpHome

const STATE_DIR = path.join(tmpHome, '.pi', 'agent', 'wechat-notify')
const LOCK_FILE = path.join(STATE_DIR, 'session.lock')

describe('session 锁语义（daemon 单实例保证）', () => {
  let acquireLock: (sessionId: string) => Promise<{ success: boolean; message: string }>
  let releaseLock: (sessionId: string) => Promise<void>

  beforeEach(async () => {
    const mod = await import('../src/auth.js')
    acquireLock = mod.acquireLock
    releaseLock = mod.releaseLock
    rmSync(STATE_DIR, { recursive: true, force: true })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(STATE_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(STATE_DIR, { recursive: true, force: true })
  })

  it('首次获取成功', async () => {
    expect((await acquireLock('daemon-1-a')).success).toBe(true)
  })

  it('同一 sessionId 可重复获取（续期）', async () => {
    await acquireLock('daemon-1-a')
    expect((await acquireLock('daemon-1-a')).success).toBe(true)
  })

  it('不同 sessionId 且持有者进程存活时必须拒绝', async () => {
    // 用当前进程 pid 伪造「活着的持有者」
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, sessionId: 'daemon-1-a', timestamp: Date.now() }))
    const result = await acquireLock('daemon-2-b')
    expect(result.success).toBe(false)
    expect(result.message).toContain('占用')
  })

  it('持有者进程已死时可抢占', async () => {
    // pid 1 之外的死 pid：用一个几乎不可能存在的 pid
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: 999999, sessionId: 'daemon-1-a', timestamp: Date.now() }))
    expect((await acquireLock('daemon-2-b')).success).toBe(true)
  })

  it('释放后再获取成功', async () => {
    await acquireLock('daemon-1-a')
    await releaseLock('daemon-1-a')
    expect(existsSync(LOCK_FILE)).toBe(false)
    expect((await acquireLock('daemon-3-c')).success).toBe(true)
  })

  it('非持有者无法释放他人的锁', async () => {
    await acquireLock('daemon-1-a')
    await releaseLock('daemon-2-b')
    expect(existsSync(LOCK_FILE)).toBe(true)
  })
})
