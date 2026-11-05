# 公告栏（BULLETIN）

> 项目：ai-pet · 唯一交接渠道 · 由 `team` CLI 维护，勿手改
> 协议见 [PROTOCOL.md](PROTOCOL.md)；状态真相在 `.team/local/board.json`；生成于 2026-11-05T08:46:49.154Z

## 待认领

| 任务 | 认领者（会话） | 状态 | 证据 | 阻塞 / 下一步 | 更新 |
|---|---|---|---|---|---|
| T-020 docs: Cursor session map for ai-pet | `【Exec·T-020】Cursor 会话地图` | 待认领 | — | 等执行会话 claim | 11-05 16:44 |
| T-021 docs: control-plane pointer | `【Exec·T-021】控制面指针` | 待认领 | — | 等执行会话 claim | 11-05 16:45 |

## 已完成

| 任务 | 认领者（会话） | 状态 | 证据 | 阻塞 / 下一步 | 更新 |
|---|---|---|---|---|---|
| T-001 主进程与 Provider 可拆改进点盘点 | `b6371fc3` | 已完成 | `8531530` · 通过 · 1 文件 | — | 11-03 23:47 |
| T-002 渲染层与共享模块可拆改进点盘点 | `a52d7431` | 已完成 | `40d965e` · 通过 · 1 文件 | — | 11-03 23:47 |
| T-010 dogfood control-plane note | — | 已完成 | `69375df` · 通过 · 1 文件 | — | 11-05 09:49 |
| T-011 dogfood lineage finalize | — | 已完成 | `8f77544` · 通过 · 1 文件 | — | 11-05 09:56 |

## 公告 / 通知

- 11-05 16:21 [manager] Cursor 分会话：Manager=根检出；Executor=T-020/T-021 worktree（docs 写集）；可选 Integration=team/integration。开场见 .team/CURSOR_SESSIONS.md 与 cursor-prompts/。
- 11-05 16:46 [manager] 命名会话：见 SESSION_MAP.md / .team/cursor-sessions/。窗口标题【Manager】【Exec·T-020】【Exec·T-021】【Integration】。

## 外包 / 血缘（engagements）

| 包 | 方向 | 状态 | 范围 | 卡点 / 下一步 | 更新 |
|---|---|---|---|---|---|
| E-001 dogfood docs note | cursor→codex | accepted | T-010 | — | 11-05 09:49 |
| E-002 lineage finalize | cursor→claude-code | accepted | T-011 | — | 11-05 09:56 |

---

> 规则：只由 CLI 写；证据必须可复核；一行一任务；不删行。
