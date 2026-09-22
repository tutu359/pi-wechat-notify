// ============================================================================
// 通知前缀与长文本转文件策略（纯函数，便于测试）
// ============================================================================

import * as path from 'node:path'
import { realpathSync } from 'node:fs'

/** 长文本转文件的字数阈值 */
export const TEXT_TO_FILE_THRESHOLD = 1_000

/** 文件大小上限（发送文件/图片共用） */
export const MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * 会话显示名：优先 pi Session name，否则兜底「目录名+PID」。
 */
export function sessionDisplayName(sessionName: string | null | undefined, cwd: string): string {
  const trimmed = sessionName?.trim()
  if (trimmed) return trimmed
  const dir = path.basename(path.resolve(cwd)) || 'unknown'
  return `${dir} #${process.pid}`
}

/**
 * 给通知内容加前缀：【名字】内容
 * 内容为空时只返回前缀本身；前缀关闭时原样返回。
 */
export function withPrefix(name: string, text: string, enabled = true): string {
  if (!enabled) return text
  return `【${name}】${text}`
}

/**
 * 短文本直接发送；超过阈值时写入临时 md 文件，返回文件路径。
 * 返回 null 表示不需要转文件，直接发文本即可。
 */
export async function maybeConvertToTextFile(
  text: string,
  threshold: number,
  tmpDir: string,
): Promise<string | null> {
  if (text.length <= threshold) return null
  const { writeFile, mkdir } = await import('node:fs/promises')
  await mkdir(tmpDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = path.join(tmpDir, `wechat-notify-${stamp}.md`)
  await writeFile(filePath, text, 'utf-8')
  return filePath
}

/** 确保路径在工作目录内（安全沙箱，realpath 防符号链接绕过） */
export function isPathInCwd(targetPath: string, cwd: string): boolean {
  try {
    const resolved = realpathSync(targetPath)
    const resolvedCwd = realpathSync(cwd)
    return resolved.startsWith(resolvedCwd + path.sep) || resolved === resolvedCwd
  } catch {
    return false
  }
}
