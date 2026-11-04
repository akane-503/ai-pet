# 架构与所有权（ARCHITECTURE）

> 项目：ai-pet · 基线：`main` · 集成：`team/integration`
> 模块边界决定写集，写集决定并行度。**改模块边界 = 改所有权 = 要 ADR。**

## 1. 模块表

| 模块 | 路径 glob | 职责 | 拥有者（任务/角色） | 依赖模块 |
|---|---|---|---|---|
| m-main | `src/main/*.js`, `src/main/*.ps1` | Electron 主进程、窗口、转接、配置、通知、技能部署 |  | m-providers, m-shared |
| m-providers | `src/main/providers/**` | 各 provider 用量采集与统一注册 |  | m-main（http）、m-shared |
| m-renderer | `src/renderer/**` | 桌宠/面板/设置/转接的 HTML/CSS/JS |  | m-shared |
| m-shared | `src/shared/**` | geometry / launch / transfer-flow / usage 纯函数 |  | 无 |
| m-scripts | `scripts/**` | 测试、打包、发布、调试脚本 |  | 全部 |
| m-skills | `skills/**` | 随安装包部署的 handoff / takeover 技能 |  | 无 |
| m-launcher | `start.cmd` | 启动入口 |  | m-main |
| m-docs | `README.md`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md` | 文档与发布说明 |  | 无 |

> 同步登记到 `.team/OWNERSHIP.json`。任务可写多个模块：`--module m-main,m-scripts`。

**热点文件：** `src/main/main.js`（约 112 KB，主进程总入口）。任何改它的任务都会和同区域任务串行；
能拆到独立模块（providers/renderer/shared）的改动，优先拆出去。

## 2. 接口契约

| 契约 | 文件 | 版本 | 提供方 | 消费方 | 兼容策略 |
|---|---|---|---|---|---|
| provider 注册 | `src/main/providers/index.js` | v1 | m-providers | m-main | 只增 provider，不改既有字段 |
| 主进程 ↔ 渲染层 | `src/main/preload.js` + IPC 通道 | v1 | m-main | m-renderer | 只增通道；破坏性变更走 v2 |
| 纯函数 | `src/shared/*.js` | v1 | m-shared | m-main / m-renderer | 只增参数（带默认值） |

规则：契约拥有者定签名；消费者只改自己一侧；破坏性变更走 CR（structural）+ adapter。

## 3. 数据流

```text
Electron main（src/main）
  ├─ providers/* 采集用量（http → 远端 API / 本地会话）
  ├─ config / handoff / notify / launcher（本地文件、Windows API）
  └─ preload / IPC
        ↕
renderer（src/renderer：pet / panel / settings / transfer）
        ↕
shared（geometry / launch / transfer-flow / usage）
```

## 4. 共享 / 保护文件

| 文件 | 为什么共享 | 谁改 | 任务怎么申请 |
|---|---|---|---|
| `package.json` / `package-lock.json` | 依赖与脚本 | 集成者 | CR 或短租约 |
| `.npmrc` | npm 配置 | 集成者 | 禁止任务直接改 |
| `build/**` | 安装器配置 | 集成者 | CR |
| `assets/**` | 角色图/GIF（约 15 MB 二进制） | 集成者 | CR；不要顺手改 |
| `AGENTS.md` / `.team/**` | 协作控制面 | 管理层 | 执行者禁止改 |
| `node_modules/**` | 通过 `linkDirs` 共享 | 控制面 | **任务工作树内禁止安装/升级依赖** |

## 5. 工作树与分支

| 用途 | 路径 | 分支 |
|---|---|---|
| 主检出（控制面） | 仓库根 | `main` |
| 集成 | `D:\01_Projects\Active\ai-pet.team-worktrees\integration` | `team/integration` |
| 任务 | `D:\01_Projects\Active\ai-pet.team-worktrees\T-00x` | `task/T-00x` |
| 产品负责人 | `D:\01_Projects\Active\ai-pet.team-worktrees\product-<slug>` | `product/<slug>` |

- 产品会话的 header cwd 仍是仓库根（侧栏归 ai-pet），但**生效工作目录**已用 `dsh-session-drag` 切到各自的 `product-<slug>` 工作树；文件改动只落在该工作树，不再共享主检出。
- 产品 slug：`install` / `interaction` / `quota` / `transfer` / `notifications` / `settings`。
- 主检出只保留控制面与 WIP 参考，产品会话不要直接改主检出；跨产品共享 `main.js`/`config.js` 时按租约串行，合并由 manager 走 `team/integration`。
- 切换前的 WIP：`scratch/ai-pet-wip-20261104-201407/` + 分支 `wip/product-sessions-20261104`。

- `node_modules` 由 `.team/config.json` 的 `linkDirs` 链进任务工作树；测试可直接跑，无需重装。
- 任务分支只改业务代码；集成分支只由 `integrate` 写；主检出只由管理层提交 `.team/` 规格。

## 6. 测试与门禁

- 全量：`npm test`（5 个 `scripts/test-*.js`，当前 171 个用例，约 4 秒）。
- 任务级建议用窄命令，例如 `node --test scripts/test-behavior.js`；集成级用 `npm test`。
- 测试会 `require('electron')`（经 `src/main/http.js`），所以依赖必须可见；`linkDirs` 已解决。
- UI/桌宠行为需要人工看：这类任务 `submit --needs-human`，`accept --human-ok`。

## 7. 既有流程

- `HANDOFF*.md` 是 AI 桌宠应用生成的交接产物（`.gitignore` 忽略），不是协作控制面；状态以 `.team/BULLETIN.md` 为准。
- 远端 `origin` 是 GitHub；project-team 不自动 push，验收后由人决定推送。
- `.claude/` 是本地工具配置，忽略。

## 8. 决策索引（ADR）

| ADR | 标题 | 状态 | 影响模块 |
|---|---|---|---|
|  |  |  |  |

## 9. 演进原则（最小改动）

1. 先加新文件/新模块，再改公共文件。
2. 接口只增不改；破坏性变更走 v2 + adapter。
3. 单任务写集尽量小；跨模块改动拆成多个任务。
4. 结构变更必须有过渡层、回滚点、ADR。
5. 重排只碰受影响任务，其余分支/租约/状态不动。
