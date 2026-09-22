import { describe, it, expect } from 'vitest'
import { sessionDisplayName, withPrefix, maybeConvertToTextFile, isPathInCwd } from '../src/notify.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

describe('sessionDisplayName', () => {
  it('优先使用 Session name', () => {
    expect(sessionDisplayName(' 我的爬虫 ', '/tmp/TestCC')).toBe('我的爬虫')
  })
  it('无 Session name 时回退到目录名+PID', () => {
    const name = sessionDisplayName(null, '/Users/x/TestCC')
    expect(name).toBe(`TestCC #${process.pid}`)
  })
  it('空白 Session name 也回退', () => {
    expect(sessionDisplayName('   ', '/a/b/my-proj')).toBe(`my-proj #${process.pid}`)
  })
})

describe('withPrefix', () => {
  it('加前缀', () => {
    expect(withPrefix('TestCC', 'hello')).toBe('【TestCC】hello')
  })
  it('可关闭前缀', () => {
    expect(withPrefix('TestCC', 'hello', false)).toBe('hello')
  })
})

describe('maybeConvertToTextFile', () => {
  const tmpDir = path.join(os.tmpdir(), `pi-wechat-test-${process.pid}`)

  it('短文本返回 null', async () => {
    expect(await maybeConvertToTextFile('hi', 1000, tmpDir)).toBeNull()
  })

  it('超阈值写文件', async () => {
    const long = 'x'.repeat(1001)
    const file = await maybeConvertToTextFile(long, 1000, tmpDir)
    expect(file).toBeTruthy()
    expect((await fs.readFile(file!, 'utf-8'))).toBe(long)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})

describe('isPathInCwd', () => {
  const cwd = '/Users/x/proj'
  it('目录内允许', () => {
    expect(isPathInCwd('/Users/x/proj/a/b.txt', cwd)).toBe(true)
    expect(isPathInCwd('/Users/x/proj', cwd)).toBe(true)
  })
  it('目录外拒绝', () => {
    expect(isPathInCwd('/Users/x/other/a.txt', cwd)).toBe(false)
    expect(isPathInCwd('/Users/x/proj-evil/a.txt', cwd)).toBe(false)
  })
  it('tmpdir 允许（长文本转存）', () => {
    expect(isPathInCwd(path.join(os.tmpdir(), 'x.md'), cwd)).toBe(true)
  })
})
