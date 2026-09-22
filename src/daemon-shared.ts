// ============================================================================
// daemon 共享常量与类型 — daemon 进程与扩展两侧唯一事实来源
// ============================================================================

import * as path from 'node:path'
import { getStateDir } from './auth.js'

/** daemon 默认监听端口（仅 127.0.0.1） */
export const DAEMON_PORT = 7866

/** daemon.json 路径（端口 + token + pid） */
export const DAEMON_FILE = path.join(getStateDir(), 'daemon.json')

export interface DaemonInfo {
  port: number
  token: string
  pid: number
  startedAt: string
}

/** 路由表 — daemon switch 与扩展 daemonRequest 共用，避免两侧字符串漂移 */
export const DaemonRoutes = {
  status: '/status',
  sendText: '/send-text',
  sendFile: '/send-file',
  sendImage: '/send-image',
  reload: '/reload',
  shutdown: '/shutdown',
} as const
