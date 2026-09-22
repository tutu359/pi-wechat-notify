import { describe, it, expect, afterAll } from 'vitest'
import { sessionDisplayName, withPrefix, maybeConvertToTextFile, isPathInCwd } from '../src/notify.js'
import * as fs from 'node:fs'
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
    expect(withPrefix('TestCC', 'hello')).toBe('【TestCC】\nhello')
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
    expect(fs.readFileSync(file!, 'utf-8')).toBe(long)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('isPathInCwd', () => {
  // realpath 校验要求路径真实存在，用临时目录构造真实场景
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wechat-sandbox-'))
  const cwd = path.join(base, 'proj')
  const outside = path.join(base, 'other')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'x')
  fs.writeFileSync(path.join(outside, 'b.txt'), 'x')

  it('目录内允许', () => {
    expect(isPathInCwd(path.join(cwd, 'a.txt'), cwd)).toBe(true)
    expect(isPathInCwd(cwd, cwd)).toBe(true)
  })
  it('目录外拒绝', () => {
    expect(isPathInCwd(path.join(outside, 'b.txt'), cwd)).toBe(false)
  })
  it('路径不存在拒绝（realpath 校验）', () => {
    expect(isPathInCwd(path.join(cwd, 'not-exist.txt'), cwd)).toBe(false)
  })
  it('符号链接逃逸拒绝', () => {
    const link = path.join(cwd, 'escape')
    try { fs.symlinkSync(outside, link) } catch { /* 权限不足则跳过 */ }
    if (fs.existsSync(link)) {
      expect(isPathInCwd(path.join(link, 'b.txt'), cwd)).toBe(false)
      fs.unlinkSync(link)
    }
  })

  afterAll(() => fs.rmSync(base, { recursive: true, force: true }))
})
