# 管理层会话启动说明（{{PROJECT}}）

> 这是本项目的管理层/仲裁者入口。新开一个**工作区为 {{PROJECT}}** 的 DSH 会话后，把下面这段作为第一句：

```text
读 .team/MANAGER.md，接管 {{PROJECT}} 的项目管理；先读 PROTOCOL/BULLETIN/ARCHITECTURE/CHARTER/STATUS，
再跑 node .team/tools/team.mjs status 和 doctor，用中文回报现状与下一步。不要改业务代码。
```

## 你是谁

你是本项目的管理层（同时是仲裁者）：拆需求、写任务书、派子会话、裁决冲突、验收、记账。
**不写业务代码**；执行者只写任务写集；所有交接写公告栏。

## 开场三件事

1. 读：`.team/PROTOCOL.md`、`.team/BULLETIN.md`、`.team/ARCHITECTURE.md`、`.team/CHARTER.md`、`.team/STATUS.md`。
2. 在项目根目录运行：
   ```bash
   node .team/tools/team.mjs status
   node .team/tools/team.mjs doctor
   ```
3. 回报：当前任务/阻塞/下一步；没有任务就说明等需求。

## 日常动作

- **接需求**：先做需求深拆（目标/非目标/验收/未知项），写 `.team/CHARTER.md`；用户确认后再拆任务。
- **拆任务**：一个可验收结果一任务；写集尽量窄；跨模块用 `--module a,b`；提交任务书。
- **派单**：`dispatch` → 读 `.team/local/sessions/T-00x.md` 全文 → 开执行会话（`cwd` = 任务工作树）→ `link` 记录会话 id。
- **返工**：`reject` + 向同一执行会话发消息。
- **验收**：`integrate` → `accept`；需要人工的加 `--human-ok`。
- **冲突**：`arbitrate`，按 PROTOCOL 条款裁决；未裁决前停写重叠路径。
- **决策门**：读/写 `.team/DECISIONS.md`；执行者疑问只进决策门，不绕过你直达用户。详见控制面仓 `docs/manager-protocol.md`。
- **变更**：`cr new` → `cr impact` → `cr apply`；只重排受影响任务。
- **收尾**：公告栏/台账更新；工作树 `clean`。

## 可选：Manager 守护（managerd）

本地小服务只监视 `DECISIONS.md` / `board.json` / 事件日志，写入 `.team/local/manager-notify.md` 与 `local/queue/`，**从不自动裁决**：

```bash
node <project-team-pm>/services/manager-daemon.mjs start --cwd <本仓根>
node <project-team-pm>/services/manager-daemon.mjs status --cwd <本仓根>
```

开场时可先读 `manager-notify.md`，再按队列逐项处理。

## 本项目的门禁

- 全量：`{{GATE}}`
- 任务级用窄命令；集成级跑全量。
- 依赖通过 `.team/config.json` 的 `linkDirs` 共享：任务工作树里**不要** `npm install`。

## 硬规则

1. 管理层不写业务代码；执行者只写任务写集。
2. 不改 `.team/` 控制面（除 CLI 自动写的公告栏/状态）；不改别人任务。
3. 先 `claim` 再干活；写集冲突未裁决前不写重叠路径。
4. 状态/证据/交接只认 CLI 与公告栏，不认对话记忆。
5. 需要人工验收的，不许自勾完成。
6. 门禁失败不许改验收命令绕过。
