# pi-wechat-notify

<p align="center">
  <strong>微信通知广播站 for pi</strong><br>
  多个 pi 会话共享的常驻微信通知通道（单向）
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D20.3-339933" alt="Node">
</p>

---

## 这是什么

一个 [pi](https://github.com/earendil-works/pi-coding-agent) 扩展：让 AI 会话把通知（文本 / 文件 / 图片）推送到你的微信。

```
微信 ilink bot ⇄ 常驻 daemon ⇄ 本地 HTTP ⇄ 多个 pi 会话
```

- **单向**：pi → 微信。你回复 bot 的消息会被消费丢弃，不会进入任何会话
- **多会话**：daemon 常驻进程独占微信连接，所有 pi 会话共享，各会话通知带自己的名字前缀
- **零命令使用**：登录过一次后，任何新会话自动具备发送能力

## 快速开始

```bash
# 1. 安装（本地路径方式）
pi install /path/to/pi-wechat-notify

# 2. 扫码登录（唯一需要手动做一次的事）
/wechat login
```

之后在任何 pi 会话里，AI 都可以使用：

| 工具 | 说明 |
|---|---|
| `send_text_to_wechat` | 发送文本通知；超过 1000 字自动转为 `.md` 文件发送 |
| `send_file_to_wechat` | 发送项目目录内的文件（50MB 上限） |
| `send_image_to_wechat` | 发送项目目录内的图片（可预览） |

所有通知自动带会话前缀：优先 pi Session name，兜底「目录名 + PID」，如：

```
【我的爬虫】任务跑完了，成功 42 条 ✅
【TestCC #12345】typecheck 通过
```

## 命令

| 命令 | 作用 |
|---|---|
| `/wechat login` | 扫码登录（已有凭证则重连 daemon；`--force` 重新扫码） |
| `/wechat logout` | 清除凭证并关停 daemon |
| `/wechat status` | 查看 daemon / 登录 / 前缀状态 |

## 架构

```
~/.pi/agent/wechat-notify/     状态目录（凭证、游标、token）
pi-wechat-daemon               常驻进程：独占微信连接，拉取入站消息并丢弃，
  daemon/index.ts              提供 127.0.0.1:7866 本地 HTTP 发送接口
src/daemon-client.ts           扩展侧桥接：探活、惰性拉起 daemon、发送转发
src/index.ts                   扩展入口：session_start 按凭证注册工具、自动前缀
```

- daemon 由扩展按需自动拉起（detached），会话退出不影响它
- 机器重启后不会自启，等下一个会话发送时自动再拉
- 入站消息被 daemon 拉取后丢弃（推进游标，服务器不留积压）

## 与上游的差异

fork 自 [shenjiecode/pi-wechat-assistant](https://github.com/shenjiecode/pi-wechat-assistant)（v0.3.1），从双向会话桥接重构为单向通知广播站：删除了消息队列、远程命令、自动回复等双向机制，新增常驻 daemon 与多会话共享。

## 开发

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest
```

## License

MIT
