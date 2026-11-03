# 主进程与 Provider 可拆改进点盘点（T-001）

- 项目：ai-pet · 基线 `de4ee94` · 审计日期 2026-11-03
- 范围：`src/main/main.js`、`src/main/providers/**`、`scripts/**`（只读）
- 方法：逐文件阅读 + 结构统计 + 现有测试与实现耦合点扫描；**未改任何源码**
- 关联：T-002 负责 `src/renderer/**`、`src/shared/**`、`scripts/test-*.js` 的渲染层视角；本文只从主进程/Provider 出发，二者重叠的 `scripts/test-*.js` 建议以本文 T-111/T-112 为基础去重（见 §7）
- 复核命令：`npm test`（本工作树实测 171 passed / 0 failed，Node v24.18.0，约 4.4s）

---

## 0. 结论摘要

1. **`main.js` 是唯一热点，也是并行度瓶颈。** 1596 行 / 112 KB（磁盘）/ 88 个顶层函数 / 54 个 IPC 通道（29 `ipcMain.on` + 25 `ipcMain.handle`）挤在一个文件里，至少承担 9 类互不相关的职责（启动迁移、角色解析、窗口吸附、托盘菜单、刷新调度、通知/礼物、一键交接、IPC 注册、生命周期）。
2. **测试与实现文本强耦合，重构即碎。** `scripts/test-data.js` 有 **17 处**直接 `readFileSync('src/main/main.js')`、**16 处** `source.slice(indexOf('function ...'), ...)`、**64 处** `vm.runInContext`。挪动 `main.js` 里任意一段函数，对应用例就静默失效或直接抛错。
3. **Provider 元数据三处重复且无契约。** `providers/index.js` 的 `TYPE_META`（字段/kind/默认角色）、`config.js` 的 `defaultConfig().providers`（默认值/路径）、`renderer/settings.js` 的字段渲染三方各写一份；`index.fetchSnapshot` 只做 try/catch，返回快照的 `kind/windows/fraction/lines` 没有统一校验。
4. **主进程里跑同步文件扫描。** `providers/codex.js` 同步读最多 4 个 400 KB 会话尾部，`providers/kimi.js` 同步遍历 LevelDB 全文找 JWT；两者都在 `refreshAll` 的 `Promise.all` 里，实际阻塞主进程（动画/菜单可感知）。
5. **推荐拆法**：先做 2 个低风险独立任务（启动抽取、Provider 契约）+ 1 个文档任务并行；再按「托盘 → 交接 → 窗口 → 刷新/通知 → 角色 → IPC」串行拆 `main.js`（同一文件不得并行）；测试基础设施（`node --test` 自动发现、`test-data.js` 按域拆分）作为第二阶段收尾，且必须走 CR 改 `package.json`。

---

## 1. 量化现状

| 对象 | 规模 | 备注 |
|---|---|---|
| `src/main/main.js` | 1596 行 / 112,559 字节 / 102,427 字符 | 88 个顶层函数；11 处 `setInterval`、13 处 `setTimeout` |
| IPC 通道 | 54（29 `ipcMain.on` + 25 `ipcMain.handle`） | 全部集中在 `main.js:1368-1557` |
| `src/main/providers/**` | 11 个文件 / 890 行 | 每个文件 1 个 `module.exports`；`index.js` 硬编码注册表 |
| `main.js` 中交接相关代码 | 约 500 行（`main.js:856-1331`） | `runHandoff` 单函数 226 行（1106-1331） |
| 测试 | 171 用例 / 5 个文件 | `test-data.js` 独占 136 用例、2436 行 / 174 KB |
| `main.js` 启动期 | `main.js:42-88` | 配置加载 + 4 段迁移/安装种子，全部同步 I/O，且在 `whenReady` 之前 |

启动期顺序（重构时必须保持）：`requestSingleInstanceLock`（37）→ `userData` 路径（34-35, 42）→ `JsonStore` 加载（43-45）→ 迁移/种子（47-87）→ `QUOTA_ONLY`（88）→ `whenReady` 装配（1564-1596）。

---

## 2. 问题与证据

### F1 `main.js` 职责过载（阻塞并行）

按行段划分的实际职责：

| 行段 | 职责 | 依赖 |
|---|---|---|
| 2-40 | 依赖装配、单实例锁、窗口策略 | electron |
| 42-88 | 配置/状态加载 + 迁移 + 安装种子（`install-key.txt`、`install-features.txt`） | fs、config |
| 91-152 | 角色表、`agents/allCharacters/charOf/mascotOf/characterImages` | cursor-model、agent-model |
| 154-166 | 约 20 个模块级可变全局（`petWin`、`drag`、`attach`、`pendingSettle`、`handoffJob`…） | — |
| 182-208 | 多屏工作区/任务栏 | geometry、winsnap |
| 229-262 | 台词生成（DeepSeek） | quips、http |
| 264-312 | 可见性/全屏遮挡/前台窗口轮询 | visibility、winsnap、activity |
| 315-413 | 数据推送、面板、通知、礼物提醒 | notify、gifts |
| 416-540 | 刷新调度、活动检测、重置点刷新 | providers、news |
| 543-761 | 窗口创建/吸附/动画/贴边跟随 | electron、winsnap、geometry |
| 764-853 | 托盘、右键菜单、启动目标 | launcher |
| 856-1103 | 会话扫描、来源探测、转接菜单、交接 UI 状态机 | handoff-api、session-worker |
| 1106-1331 | 一键交接流水线 `runHandoff` | launcher、handoff、handoff-api、desktopDraft |
| 1334-1366 | 外观设置、开机自启 | fs、powershell |
| 1368-1557 | IPC 注册（54 通道） | 以上全部 |
| 1559-1596 | 生命周期与 `whenReady` 装配 | 以上全部 |

**结论**：任何两个改 `main.js` 的任务都必然串行；`ARCHITECTURE.md:21` 已把该文件标为热点，但当前没有可执行的拆分路线。

### F2 测试按源码文本切片（重构即碎）

`scripts/test-data.js` 的典型写法：

```js
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
vm.runInContext(source.slice(source.indexOf('async function launchFor('), source.indexOf('function launchCurrent()')), ctx);
```

涉及的位置（`test-data.js` 行号）：17、27、103/105、121、193/197/201、341/351、558/563、908/923、941/956、1301/1303、1331/1341、1370、1378/1389、1612/1618、1734/1748、2175/2176、2211、2257、2297、2332。

其中 2211、2257、2332 是对源码**正则匹配**（断言某段字符串存在），属于实现细节锁定。

**影响**：任何抽取任务都必须同时迁移这些用例，否则 `npm test` 变红；这也是 `main.js` 至今没被拆分的主要原因。`test-data.js` 2436 行/136 用例的单文件结构放大了冲突面。

### F3 Provider 元数据/注册表三处重复

- `providers/index.js:2-13`：`impls` 硬编码 type → 模块。
- `providers/index.js:15-25`：`TYPE_META`（label、fields、kind、defaultCharacter）。
- `config.js:46-55`：`defaultConfig().providers`（id、type、默认值、默认路径）。
- `renderer/settings.js:163-175` 通过 `meta.types[p.type].fields` 渲染表单。

新增一个 provider 需要改 3 个文件（`index.js`、`config.js`，以及设置页的字段词典），漏一处就出现「设置页没有字段 / 默认配置缺项 / 注册表无实现」。同时 `TYPE_META.kind` 与各实现自己写的 `s.kind` 没有一致性校验（例：`deepseek.js:25` 设置 `balance`，`gemini.js` 在 relay 分支改成 `balance`、OAuth 分支 `window`）。

### F4 Provider 快照没有契约

`providers/index.js:27-37` 只做 `try/catch` 兜底，返回体由各实现自由拼装：

- `windows[]` 的必需字段（`key/label/usedPercent/resetsAt`）没有校验；
- `fraction` 有的实现算、有的不算（`zhipu.js:53` 取最差窗口，`kimi.js:106` 用上下文比例，`newapi.js` 不算）；
- `lines` 是给人看的文案，部分实现根本没有（`custom.js` 只在成功时拼，`claude-oauth.js:34` 每次重建）；
- 失败快照形状靠 `index.js` 的兜底兜住，但 `at/kind/currency` 等字段在异常路径上缺失。

**影响**：`main.js:424-462` 的刷新循环只能写防御性代码（`if (Array.isArray(s.models))`、`s.balance !== null && s.balance !== undefined`），新增 provider 时容易触发 `TypeError`。

### F5 主进程内同步文件扫描

- `providers/codex.js:41-88`：`fromSessionLogs` 同步遍历 `sessions/年/月/日/*.jsonl`，最多读 4 个文件、每个尾部 400 KB（62-68 行）。在 `refreshAll` 里同步执行。
- `providers/kimi.js:56-73`：`membershipLevel` 同步读取整个 LevelDB 目录的 `.log/.ldb` 文件找 refresh JWT。
- `main.js:424` 的 `Promise.all` 只等待 Promise，同步段仍占主线程；桌宠动画 16 ms 帧、右键菜单准备（`main.js:1420`）都在这条线程上。

现有可用模式：`main.js:869-875` 已用 `utilityProcess.fork('session-worker.js')` 把会话扫描移出主线程，可复用同一手法或加 mtime/TTL 缓存。

### F6 全局可变状态与隐式依赖

`main.js:154-166` 的模块级变量（`petWin/settingsWin/panelWin/tray/petBox/drag/attach/flipped/pendingSettle/currentCharacter/quitting/handoffJob/lastHandoffJob/foreground/recent`）被几乎每个函数直接读写。抽取任何一块都要注入 8-15 个依赖；这也是 F1 拆分的主要成本。建议抽取时统一用「工厂函数 + 依赖对象」而不是继续用模块全局。

### F7 定时器分散

`main.js` 有 11 处 `setInterval`/13 处 `setTimeout`，生命周期与关闭清理分散在窗口 `closed`、`finishJob`、`whenReady` 各处（例：`main.js:563-568` 的 `keepTop`、`729-761` 的 `attachTimer`、`1091-1101` 的 `watchReceived`、`1564-1596` 的 5 个定时器）。抽取模块时需要明确「谁创建、谁清理」，否则容易留下幽灵定时器。

### F8 脚本层：新增测试要改保护文件

`package.json:11` 的 `test` 是 5 个文件的显式列表；`scripts/release-files.js:4-7` 的 `FILES` 也是显式白名单。新增 `scripts/test-*.js` 必须同时改 `package.json` 与 `release-files.js`，而二者属于保护文件（`ARCHITECTURE.md:51-52`、`PROTOCOL.md:57`），执行者不能顺手改。

这直接压制了「抽一块、补一组测试」的节奏：任务只能把断言塞进现有 `test-data.js`（冲突面最大），或另建文件却进不了 `npm test`。

### F9 文档/契约缺口

`ARCHITECTURE.md:28` 声明了「provider 注册 v1」契约，但没有字段级定义；`TYPE_META.fields` 只是 UI 字段名，不是快照 schema。新增 provider 或改 `kind/fraction` 语义无据可依。

---

## 3. 候选任务

> 约定：优先级 P1 = 现在就该做（低风险/高收益）；P2 = 第二阶段；P3 = 收尾或机械整理。
> 验收命令统一用「窄命令 + `npm test`」；新增测试文件暂用 `node --test <file>` 直接跑，注册进 `npm test` 由 §3.10 统一处理。

### T-101 主进程启动与安装种子抽取（bootstrap）

- **模块**：m-main
- **目标**：把 `main.js:42-88` 的配置/状态加载、4 段迁移（`setupWizardDone`、Cursor 角色修正、Kimi 数据源补齐、`install-key.txt`/`install-features.txt` 并入）、`QUOTA_ONLY` 计算抽到 `src/main/bootstrap/`；`main.js` 只保留调用。
- **证据**：`main.js:42-88` 目前 47 行同步 I/O + 4 个独立 `try/catch`，且都在 `app.whenReady()` 之前。
- **写集**：`src/main/main.js`、`src/main/bootstrap/**`（新增）、`scripts/test-bootstrap.js`（新增）
- **验收**：`node --test scripts/test-bootstrap.js && npm test`；用例覆盖：新配置补默认、Cursor 空角色回落、已有 Kimi 不重复加、`install-key.txt` 非法 Key 被丢弃、`handoff=0` 时 `QUOTA_ONLY=true`。
- **风险**：启动顺序与单实例锁不能动；种子文件「读后即删」的语义必须保留（写坏会每次启动重复导入）；测试需 mock `app.getPath`/`fs`，不要让用例读到真实 `%APPDATA%`。
- **优先级**：P1
- **依赖**：无
- **人工验收**：需要——用一次全新安装（含 `/KEY=`、`/NOHANDOFF`）确认首启向导与 Key 导入，标 `needsHuman`。

### T-102 Provider 注册表与快照契约统一

- **模块**：m-providers
- **目标**：每个 provider 模块导出自己的 `meta`（label/fields/kind/defaultCharacter/defaults），`index.js` 由模块表派生 `impls` 与 `TYPE_META`；新增 `contract.js` 归一化/校验快照（`kind`、`windows[].{key,label,usedPercent}`、`fraction∈[0,1]`、`lines` 数组、失败快照统一形状），`fetchSnapshot` 外层统一套用。**`TYPE_META` 对外形状保持不变**（renderer 契约 v1）。
- **证据**：`providers/index.js:2-25`、`config.js:46-55`、`renderer/settings.js:163-175`（F3/F4）。
- **写集**：`src/main/providers/index.js`、`src/main/providers/*.js`（9 个实现 + util）、`src/main/providers/contract.js`（新增）、`scripts/test-providers.js`（新增）
- **验收**：`node --test scripts/test-providers.js && npm test`；断言：注册表与 `TYPE_META` 键集合一致、每个实现都有 `meta`、契约能拒绝缺 `windows[].key` 的快照、合法快照字段不被改写。
- **风险**：`settings.js` 依赖 `fields` 的具体名称，任何改名都是契约破坏（本任务不改 renderer）；`config.js` 默认值若搬进 provider 模块，会形成 `config → providers → http → electron` 的加载环，**建议默认值仍留在 `config.js`，本任务只搬「元数据」**；快照归一化不得改写业务字段（`usedTotal/credits/announcements`）。
- **优先级**：P1
- **依赖**：无
- **人工验收**：不需要（纯函数 + 现有 provider 测试覆盖）。

### T-103 Provider 本地扫描降阻塞

- **模块**：m-providers、m-scripts
- **目标**：把 `codex.fromSessionLogs`、`kimi.membershipLevel` 的同步全量读改为「TTL/mtime 缓存 + 异步读」或移入 worker；保持返回值语义不变（最近一条 `rate_limits`、最高 `iat` 的 refresh 会员等级）。
- **证据**：`providers/codex.js:41-88`（4×400 KB 同步读）、`providers/kimi.js:56-73`（LevelDB 全文）；`main.js:424` 同步段阻塞（F5）。
- **写集**：`src/main/providers/codex.js`、`src/main/providers/kimi.js`、`scripts/test-providers.js`（与 T-102 共用，需在 T-102 之后或合并）
- **验收**：`node --test scripts/test-providers.js && npm test`；基准用例：给同一 fixture 连续调用两次，第二次不重复读盘（可用注入的 `fs.readFileSync` 计数）。
- **风险**：会话日志格式/LevelDB 布局是外部事实，改动后「读不到」必须与「没有数据」可区分；不能引入 Electron API（provider 可能被 worker 复用）；与 T-102 写集重叠，**不得并行**。
- **优先级**：P2
- **依赖**：T-102
- **人工验收**：建议——真实 Codex/Kimi 账号下对比刷新前后数值一致，标 `needsHuman`。

### T-104 托盘与右键菜单抽取

- **模块**：m-main
- **目标**：`buildMenuTemplate`、`petMenuTemplate`、`updateTrayMenu`、`createTray`、`launchTargets` 抽到 `src/main/tray-menu.js`，注入 `config/state/QUOTA_ONLY/handoffJob/launcher/…`；`main.js` 只保留 `createTray()` 调用。
- **证据**：`main.js:764-853`；`test-data.js` 有 3 处 `vm` 切片直接跑 `petMenuTemplate`（105、197、1618 附近）。
- **写集**：`src/main/main.js`、`src/main/tray-menu.js`（新增）、`scripts/test-data.js`
- **验收**：`node --test scripts/test-data.js && npm test`；把 `petMenuTemplate` 的 3 组用例从源码切片改为 `require('../src/main/tray-menu')`。
- **风险**：菜单项顺序与「按 index 切片」逻辑（`main.js:804-811` 用 `all.slice(1,3)`、`all.slice(7,9)`）依赖数组位置，改动易错；`QUOTA_ONLY` 与 `handoffJob` 的动态项要保留；`launchTargets` 有 30 秒缓存（`main.js:827-836`），抽走后缓存生命周期要明确。
- **优先级**：P2（作为 main.js 拆分的试点，改动小、可验证）
- **依赖**：无（但会改 `scripts/test-data.js`，须与其他 main.js 任务串行）
- **人工验收**：建议——看一次托盘菜单与桌宠右键菜单，标 `needsHuman`（菜单项顺序/勾选状态）。

### T-105 一键交接编排抽取

- **模块**：m-main
- **目标**：把 `main.js:856-1331` 的会话缓存、来源探测、转接菜单、交接状态机、`runHandoff` 抽到 `src/main/handoff-runner.js` + `src/main/transfer-ipc.js`；`main.js` 只保留装配与 IPC 转发。
- **证据**：`runHandoff` 单函数 226 行（1106-1331）；`pushHandoff` 的标题/详情是两个 300+ 字符的嵌套三元（1022、1030）；`test-data.js` 约 10 处 vm 切片围绕这段代码。收益：`main.js` 减约 500 行（约 32%），并移除最脆的测试耦合。
- **写集**：`src/main/main.js`、`src/main/handoff-runner.js`（新增）、`src/main/transfer-ipc.js`（新增）、`scripts/test-data.js`
- **验收**：`node --test scripts/test-data.js && npm test`；现有交接用例（取消、失败不回退粘贴、摘要失败不退回旧流程、DSH 填草稿）全部保留并改为 `require` 新模块 + 注入 fake。
- **风险**：依赖 10+ 模块（launcher/handoff/handoff-api/handoff-return/handoff-estimate/desktopDraft/clipboard/winsnap/state/config），注入面大；`runHandoff` 里混着 UI 文案与业务分支，首次拆分建议**只搬不改逻辑**，文案一行不动；`watchReceived` 的 30 分钟定时器与 Esc 全局热键必须随模块迁移并补清理路径。
- **优先级**：P2（收益最大、风险最高，建议在 T-104 验证模式后做）
- **依赖**：T-104（试点模式）
- **人工验收**：需要——本机实际做一次 Claude→Codex 转接与一次直接接手，标 `needsHuman`。

### T-106 刷新、通知与礼物调度抽取

- **模块**：m-main
- **目标**：`refreshAll`（416-498）、`scheduleRefresh`、`checkActivity`、`checkQuotaResets`、`pushNotification`（375-397）、`checkGiftReminders`（402-413）抽到 `src/main/refresh.js` 与 `src/main/notification-center.js`，注入 `state/config/providers/notify/gifts/news/pushData/log`。
- **证据**：`refreshAll` 80 行内混合 provider 刷新、ledger 记账、通知差分、礼物扫描、RSS 检查、落盘；`test-data.js:341-357` 用源码切片跑 `refreshAll`。
- **写集**：`src/main/main.js`、`src/main/refresh.js`（新增）、`src/main/notification-center.js`（新增）、`scripts/test-data.js`、`scripts/test-behavior.js`
- **验收**：`node --test scripts/test-behavior.js scripts/test-data.js && npm test`；覆盖：并发刷新 guard、失败沿用旧快照并标 `stale`、删除已禁用 provider 的快照、礼物提醒去重。
- **风险**：`state.saveSoon()` 的调用时机与顺序影响落盘内容；通知去重（`main.js:376`）依赖通知数组顺序；`pushData` 触发 UI 更新，抽走后不能变成每次刷新多次推送。
- **优先级**：P2
- **依赖**：无（写集与 T-104/T-105 重叠于 `main.js`/`test-data.js`，串行）
- **人工验收**：建议——看一次「余额变化→气泡/消息记录」，标 `needsHuman`。

### T-107 窗口与吸附几何抽取

- **模块**：m-main、m-shared
- **目标**：纯几何（吸附候选、边缘判定、钳制）进 `src/shared/snap.js`；窗口生命周期、动画、贴边跟随进 `src/main/pet-window.js`；`main.js` 保留装配。
- **证据**：`main.js:543-761` 约 220 行；`shared/geometry.js` 已有 `workArea/clampPosition/windowSize`，但吸附候选（`computeSnap`，634-691）仍留在 `main.js` 里，无法单测。
- **写集**：`src/main/main.js`、`src/main/pet-window.js`（新增）、`src/shared/snap.js`（新增）、`scripts/test-geometry.js`、`scripts/test-data.js`
- **验收**：`node --test scripts/test-geometry.js && npm test`；把 `computeSnap` 的候选/阈值逻辑改为纯函数并用 fixture 覆盖（窗口吸附优先于屏幕边、屏幕边更近时反超、跨屏内边可吸）。
- **风险**：`pendingSettle` + 镜像翻转的两阶段落位（707-727、1370-1407）是状态机，抽错会「角色瞬移/挤出屏幕」；`screen`/`process.platform` 在测试里要可注入；**无法在 CI 证伪多屏/DPI 行为**。
- **优先级**：P2
- **依赖**：无（`main.js`/`test-data.js` 冲突，串行）
- **人工验收**：**必须**——多显示器 + 125%/150% 缩放 + 任务栏自动隐藏下拖拽吸附、贴边跟随、全屏遮挡，标 `needsHuman`。

### T-108 角色解析与立绘映射抽取

- **模块**：m-main
- **目标**：`CHARACTERS`、`agents/allCharacters/charOf/mascotOf/cursorInfo/characterImages/agentLaunch/launchCfg` 抽到 `src/main/characters.js`；`main.js` 只保留引用。
- **证据**：`main.js:91-152`；`test-data.js:1734-1762` 用源码切片测 `mascotOf`（Cursor/Gemini/WorkBuddy 回退规则）。
- **写集**：`src/main/main.js`、`src/main/characters.js`（新增）、`scripts/test-data.js`
- **验收**：`node --test scripts/test-data.js && npm test`；`mascotOf` 的 6 组用例改为直接 `require`。
- **风险**：`characterImages` 依赖 `ASSETS` 与自定义图片路径，`mascotOf` 依赖 `cursorModel/agentModel` 的实时读取；抽走后 `config.data.agents` 的读取时机要一致（当前是每次调用实时读）。
- **优先级**：P3
- **依赖**：无（串行）
- **人工验收**：建议——切换角色/自定义图看一次，标 `needsHuman`。

### T-109 IPC 通道分域注册

- **模块**：m-main
- **目标**：把 54 个通道按域拆到 `src/main/ipc/{pet,settings,providers,handoff,system}.js`，每个模块导出 `register(deps)`；`main.js` 只按顺序调用。
- **证据**：`main.js:1368-1557`（190 行连续注册）；`test-data.js:1301` 用「从 `context-menu` 到 `\n});`」的字符串切片取一段 IPC 代码做测试。
- **写集**：`src/main/main.js`、`src/main/ipc/**`（新增）、`scripts/test-data.js`
- **验收**：`node --test scripts/test-data.js && npm test`；新增静态清单用例：从 `preload.js` 收集通道名，与注册结果对账，防止漏注册/重复注册。
- **风险**：通道名与 `preload.js`、renderer 调用必须一致（契约 v1，只增不改）；部分 handler 依赖窗口单例（`settingsWin/petWin`）与 `QUOTA_ONLY`，注册时注入；`ipcMain.handle` 重复注册会抛错，拆分后需保证只注册一次。
- **优先级**：P3（机械但易错；先搬不改逻辑）
- **依赖**：T-105（`transfer:*` 通道随交接模块走）
- **人工验收**：不需要（静态清单 + 现有用例覆盖），但若动了设置页保存路径，建议手点一次。

### T-110 Provider 快照 schema 文档（v1）

- **模块**：m-docs
- **目标**：在 `docs/` 写 `providers-snapshot-v1.md`：字段表（`providerId/type/name/ok/at/kind/currency/balance/granted/toppedUp/windows[]/plan/credits/models/announcements/fraction/source/lines/extra`）、各 `kind` 的语义、失败快照、`windows[]` 字段、`units` 约定；作为 T-102 契约与后续新增 provider 的依据。
- **证据**：`ARCHITECTURE.md:28` 只有「provider 注册 v1」一行，没有字段级定义（F9）。
- **写集**：`docs/providers-snapshot-v1.md`（新增）
- **验收**：`npm test`；文档与 `providers/index.js`、`util.base()` 字段逐一对齐（人工复核）。
- **风险**：低；但必须从现有实现反推，不能写成「理想 schema」；与 renderer 的消费字段（`main.js:322-329` 的 payload）保持一致。
- **优先级**：P3（但建议最先做，T-102 直接引用）
- **依赖**：无，可与其他任务并行
- **人工验收**：不需要。

### T-111 测试基础设施：自动发现 + 发布白名单

- **模块**：m-scripts（**改保护文件，需 CR 或集成者执行**）
- **目标**：`package.json` 的 `test` 改为 `node --test "scripts/test-*.js"`（Node 24 用 glob 自动发现；**实测 `node --test scripts/` 会把目录当模块加载并报 `MODULE_NOT_FOUND`，不能用目录参数**），`release-files.js` 白名单改为目录扫描 + 排除规则；新增测试文件不再需要改两处清单。
- **证据**：`package.json:11`、`scripts/release-files.js:4-7`；保护文件规则 `ARCHITECTURE.md:51-52`、`PROTOCOL.md:57`。
- **写集**：`package.json`、`scripts/release-files.js`、`scripts/test-release.js`
- **验收**：`npm test && node --test "scripts/test-*.js"`（实测 171 passed）；断言：打包清单仍包含 `skills/`、`src/`、`assets/`，且不引入 `dist/node_modules`；`test-release.js` 的「白名单必须含某文件」用例改为「自动发现结果必须含某文件」。
- **风险**：`package.json` 是保护文件，执行者不得直接改；glob 必须加引号，否则 PowerShell 展开后行为不一致；`node --test "scripts/test-*.js"` 会执行全部 5 个文件（约 4.2s，确认无副作用：部分用例会 `require('electron')`，依赖 `linkDirs` 可见）；`filesForRelease` 的排除规则若过宽会漏掉新脚本或把 `test-data.js` 排除。
- **优先级**：P2，**建议由集成者做**（或 CR 批准后立项）
- **依赖**：无
- **人工验收**：不需要。

### T-112 `test-data.js` 按域拆分并去源码切片

- **模块**：m-scripts
- **目标**：把 2436 行/136 用例按「handoff / providers / refresh / menu / characters / misc」拆成独立文件；所有 `readFileSync(main.js)` + `source.slice` 的用例改为 `require` 对应模块（依赖 T-104~T-109 的抽取结果）。
- **证据**：`test-data.js` 17 处读 `main.js`、16 处 `source.slice`、64 处 `vm.runInContext`（F2）。
- **写集**：`scripts/test-data.js`、`scripts/test-main-*.js`（新增）、`scripts/test-providers.js`、`package.json`、`scripts/release-files.js`
- **验收**：`npm test`（用例总数不减少，171 → ≥171）；`grep -c "readFileSync.*main.js" scripts/test-*.js` 为 0。
- **风险**：与 T-111 相同（保护文件）；必须等 main.js 抽取链落地后再做，否则拆完仍是源码切片；共享 fixture 与 `vm` 上下文要一起搬，别复制两份。
- **优先级**：P3（收尾）
- **依赖**：T-104、T-105、T-106、T-107、T-108、T-109、T-111
- **人工验收**：不需要。

---

## 4. 建议并行组

**硬约束**：`PROTOCOL.md:56`「写集两两重叠的任务不得并行」。`main.js` 与 `scripts/test-data.js` 是全部候选里最重的两个共享写点，因此：

- **组 0（现在就能并行，4 个任务）**：T-101、T-102、T-110、T-111
  - T-101：`main.js` + `src/main/bootstrap/**`
  - T-102：`src/main/providers/**` + `scripts/test-providers.js`
  - T-110：`docs/providers-snapshot-v1.md`
  - T-111：`package.json` + `scripts/release-files.js` + `scripts/test-release.js`（保护文件，集成者/CR）
  - 四者写集互不重叠；T-111 若先合并，T-102 新增的测试会被自动发现，无需再改清单。
- **组 1（main.js 串行链，一次一个）**：T-104 → T-105 → T-106 → T-107 → T-108 → T-109
  - 全部改 `main.js` + `scripts/test-data.js`，**只能串行**；顺序按「改动小 → 模式已验证 → 收益大 → 风险高」排：先用托盘菜单（T-104）验证抽取模式，再做交接（T-105，收益最大），然后刷新/通知（T-106），窗口（T-107，需人工验收），最后角色（T-108）与 IPC（T-109）。
- **组 2（与组 1 并行，Provider 侧）**：T-103
  - 写集仅 `providers/codex.js`、`kimi.js`、`scripts/test-providers.js`，与 main.js 链不冲突；但需在 T-102 之后（同一 `test-providers.js` 与 `index.js`/`util` 相邻风险）。
- **组 3（收尾，全部依赖已合并）**：T-112
  - 依赖组 0 的 T-111 与组 1 全部完成。

**不建议**：在组 1 内部并行任何两个任务（会同时改 `main.js` 与 `test-data.js`，`submit` 的写集校验会互相打脸）；一次性重写 `main.js`（无法评审、无法回滚）；把 Electron 依赖塞进 provider 模块（破坏 m-providers → m-shared 的依赖方向）。

---

## 5. 保护文件 / CR 清单

| 文件 | 涉及的候选任务 | 处理 |
|---|---|---|
| `package.json` | T-111、T-112 | 保护文件：集成者执行或先 `cr new` |
| `scripts/release-files.js` | T-111、T-112 | 随 `package.json` 一起走 CR |
| `src/main/config.js` | （T-102 若搬默认值才涉及） | 建议**不搬**，避免 `config → providers` 加载环 |
| `.team/**` | 全部 | 执行者禁止改 |
| `node_modules/**` | 全部 | 任务工作树内禁止安装/升级 |

`ARCHITECTURE.md` 的模块表暂不需要改：本文所有候选都落在既有 `m-main`/`m-providers`/`m-shared`/`m-scripts`/`m-docs` 内；若 T-105 把 `transfer-ipc` 独立成新模块，按 `ARCHITECTURE.md:5`「改模块边界 = 改所有权 = 要 ADR」，需先补 ADR 再立项。

---

## 6. 需要人工验收的点（汇总）

1. T-101：全新安装（含 `/KEY=`、`/NOHANDOFF`）首启向导与 Key 导入。
2. T-103：真实 Codex/Kimi 账号下刷新前后数值一致。
3. T-104：托盘菜单 + 桌宠右键菜单的项序、勾选、动态交接项。
4. T-105：本机 Claude→Codex 转接一次 + 直接接手一次。
5. T-106：余额变化触发气泡/消息记录一次。
6. T-107：多显示器/缩放/任务栏/全屏遮挡下的吸附与贴边。
7. T-108：切换角色与自定义立绘。

以上任务 `submit --needs-human`，`accept` 必须 `--human-ok`。

---

## 7. 与 T-002 的分工（避免重复立项）

- 本任务（T-001）覆盖：`main.js`、`providers/**`、以及服务于它们的 `scripts/test-data.js`、`scripts/release-files.js`、`package.json` 测试清单。
- T-002 覆盖：`renderer/**`、`shared/**`、其余 `scripts/test-*.js` 的渲染层视角。
- 重叠提示：`scripts/test-data.js` 与测试基础设施两项（T-111、T-112）两边都会看到；建议以本文的写集与依赖为准，由 manager 在立项时合并为一个任务，不要按两份任务书各派一个执行者。

---

## 8. 未覆盖 / 不确定

- **未做运行时剖析**：没有在 Electron 里测帧率/主线程阻塞的具体毫秒数；F5 的阻塞判断来自同步读代码路径，未做 profiler 验证。
- **未审计 `handoff-api.js`（63 KB）**：它是交接模块内部的独立实现，体量已超出本任务「main.js + providers + scripts」范围；建议单独立项审计（候选：`docs/audit-handoff-2026-11-03.md`）。
- **`launcher.js`/`winsnap.js`/`session-reader.js` 只看了调用面**：未做逐行审计；它们已是独立模块，优先级低于本文候选。
- **测试耗时**：`npm test` 约 4.4s，其中 `test-release` 一项 1.3s（扫描全量文件）；拆分后可能变快或变慢，需在 T-111 验收时对比。
- **Windows 专属路径**：所有运行时建议以 Windows 10/11 为前提；WSL 相关（`handoff.toWslPath`、`wsl:distros`）未在本机验证。

---

## 9. 验收复核

```text
# 本任务（T-001）验收
npm test                                  # 171 passed / 0 failed（实测）
Test-Path docs/audit-main-2026-11-03.md   # PowerShell

# 候选任务落地后的建议窄命令
node --test scripts/test-bootstrap.js
node --test scripts/test-providers.js
node --test scripts/test-geometry.js
node --test scripts/test-data.js
```
