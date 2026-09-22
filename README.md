# dsh-keep-awake

<div align="center">

**DeepSeek Harness 防休眠插件（界面跟随 DSH 全局语言）**

任意 agent / subagent / 后台任务运行时阻止系统休眠 · 全部空闲后按宽限期自动释放 · 手动保持唤醒 · 可选阻止屏幕关闭 · Windows / macOS / Linux · 设置持久化 · 多语言 Web 设置页

[![version](https://img.shields.io/badge/version-0.2.1-4176E6)](https://github.com/Sictiy/dsh-keep-awake)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.en.md) | **中文**

</div>

<div align="center">

![设置页截图](screenshot.png)

</div>

## 功能总览

| 功能 | 位置 | 说明 |
|---|---|---|
| 实时状态 | 设置页「防休眠」 | 状态徽章（保持唤醒中 / 宽限中 Ns / 待机 / 已停用 / 助手异常）、运行中 agent 数、后台任务数、辅助进程平台 + PID |
| 活动判定 | — | 运行中的 agent（主 agent / subagent / workflow 子代理）+ 运行中的后台任务（`run_in_background` 命令 / 后台 subagent 任务） |
| 宽限期 | 设置页可配 | 全部活动结束后 15s–5m（默认 60s）自动释放防休眠 |
| 手动保持 | 设置页 | 无视活动状态强制保持唤醒，点击取消 |
| 阻止屏幕关闭 | 设置页可选 | 默认只防系统休眠、允许熄屏；勾选后屏幕也保持 |
| 多语言 | 全局 | 跟随 DSH 全局语言（zh/en），未显式设置时跟随浏览器/系统，切换即时生效（含侧边栏标签） |

## 工作原理

每 5 秒轮询 + 事件即时重扫（`agent/status`、`subagent/start|end`、当前 `JobEvents` 生命周期事件）：

- **运行中的 agent**：`agents.list()` 中 `status === 'running'` 的 agent（覆盖主 agent、subagent、workflow 子代理）
- **后台任务**：`jobs.list()` + `jobs.list(agent.id)` 中 `running`/`stopping` 的任务（旧版 Jobs API 自动兼容）（覆盖 `run_in_background` 命令与后台 subagent 任务）

检测到活动时通过 Node 子进程启动一个平台辅助进程（树级终止，进程退出即释放休眠标志）：

| 平台 | 机制 |
|---|---|
| Windows | PowerShell `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)`（勾选“同时阻止屏幕关闭”时加 `ES_DISPLAY_REQUIRED`） |
| macOS | `caffeinate [-d] -i -s` |
| Linux | `systemd-inhibit --what=idle --mode=block sleep 1e8` |

## 设置

持久化在 profile 的 `settings.yaml`（namespace `keep-awake`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `graceMs` | `60000` | 全部活动结束后的宽限期（15s–5m） |
| `preventDisplaySleep` | `false` | 同时阻止屏幕关闭 |
| `manualHold` | `false` | 手动保持唤醒 |

## 多语言

界面使用框架 `locale` 服务（namespace `keep-awake`，zh/en 字典）：未显式设置语言时自动跟随浏览器/系统语言；在 DSH 语言设置中切换后即时生效（设置页正文与侧边栏标签均跟随）。

## HTTP 路由（Harness 鉴权）

路由走 Harness `connection.fetch` 的 `/api` 鉴权边界，因此会复用 browser token/Cookie 与 trusted-host 校验，可用于 Tailscale Serve 等可信反向代理场景。

- `GET /api/dsh-keep-awake/state` — 当前状态（活动计数、探测健康、助手进程、配置）
- `PUT /api/dsh-keep-awake/config` — 更新配置，body `{ "section": {...} }`

## 安装

```sh
# 在 profile 目录内（如 ~/.dsh/profiles/web）
pnpm add "dsh-keep-awake@<来源>"   # npm / github:bearice/dsh-keep-awake / link:<本地路径>
# 并把 "dsh-keep-awake" 加入 package.json 的 dsh.profile.bundles
pnpm install
# 重启 profile
```

## 开发

- 本地开发建议以 `link:` 方式挂入 profile（见上方安装步骤）
- `npm run check`：语法检查；`npm test`：运行核心回归测试
- 包结构：`lib/index.js`（Host）、`lib/client.js`（Web 设置页）、`cordis.patch.yml`（挂载行）


## 可靠性修复（0.2.1）

- 显式依赖 `agents` / `jobs`，不再依赖 profile 装配顺序碰巧正确。
- 配置更新按 patch 合并，不再因修改一个选项重置其余选项。
- 适配当前 Harness `JobEvents` / `jobs.list(sessionId)` API，并保留旧 Jobs API 回退。
- 活动探测失败时 fail-closed：保持唤醒，而不是把未知状态误判为空闲。
- Windows helper 检查 `SetThreadExecutionState` 返回值并用 READY 握手确认锁真正生效。
- helper 异常退出后指数退避自动重启；工作期间切换“阻止屏幕关闭”立即重建锁。
