# 渲染层与共享模块可拆改进点盘点（T-002）

- 日期：2026-11-03
- 模块：m-docs（只读审计，不改源码）
- 基线：`ed93222`（分支 `task/T-002`）
- 审计范围：`src/renderer/**`（11 个文件）、`src/shared/**`（4 个文件）、`scripts/test-*.js`（5 个文件）
- 方法：逐文件通读 + 交叉比对 + 跑 `npm test` 取基线；结论只写可复核的文件:行，不写推测。

## 0. 结论先行

1. **渲染层没有真正的并行空间**：`pet.js` / `panel.js` / `settings.js` 三个文件被"格式化函数 + 额度渲染 + 角色映射"同时穿透，任何重构任务都会碰到同一批文件。要并行，必须先把可独立的新模块**新增**出来，接入阶段再串行。
2. **有 1 个真实行为分叉**（`panel.js` 的 relay 判定少传快照），不是纯风格问题，建议单独小任务先修。
3. **重复代码集中在 5 个工具函数**（`fmtMoney` / `fmtLeft` / `esc` / `shortName` / `amountStyle`），四份拷贝，且已经出现实现差异。
4. **测试层最大的风险是"源码文本正则当 UI 断言"**（`test-data.js` 多处），这类断言让渲染层重构必然误报，应优先转成契约测试。

## 1. 现状地图

| 文件 | 行数 | 实际职责 | 边界问题 |
|---|---|---|---|
| `src/renderer/pet.js` | 499 | 角色/立绘几何、透明像素命中、气泡分页、指针与拖拽、右键菜单锚点、音效、通知、交接 UI | 6 类职责塞在一个 IIFE，无导出，无法单测 |
| `src/renderer/settings.js` | 492 | 9 个 tab 的渲染 + 配置补丁计算 + 持久化 + 环境扫描 + 技能部署 | 6 个以上模块级可变状态隐式共享；纯逻辑（`configDiff`）混在 DOM 代码里 |
| `src/renderer/onboarding.js` | 145 | 两步向导 | 唯一可 `require` 的渲染模块（双导出），是测试的正面样板 |
| `src/renderer/transfer.js` | 89 | 转接菜单三视图、工作区探测、窗口高度上报 | 压缩风格（一行 4~6 条语句、89 行 0 空行），改动易踩 |
| `src/renderer/panel.js` | 64 | 面板额度行 + 外观设置 | 与 pet.js/settings.js 三套额度渲染并存 |
| `src/renderer/*.css` | 4 个 | pet / settings / transfer + panel 内联 | `panel.html` 自带 `<style>`，其余外链，风格不统一 |
| `src/shared/geometry.js` | 47 | 窗口尺寸、位置约束、工作区/任务栏 | 有单测，边界清晰，不需要动 |
| `src/shared/usage.js` | 17 | `isRelay` / `relayMetric` | 有单测，但调用方传参不一致（见 P1-1） |
| `src/shared/transfer-flow.js` | 38 | 转接菜单状态机 + 锚点布局 | 有单测，边界清晰 |
| `src/shared/launch.js` | 20 | 启动方式判定、WSL 列表解析 | 有单测，边界清晰 |
| `scripts/test-data.js` | 2435 / 182KB | 主进程与数据层的主力测试 | 共享大文件；含渲染层源码文本断言 |
| `scripts/test-behavior.js` | 255 | 行为与小工具测试 | — |
| `scripts/test-geometry.js` | 53 | 共享几何 | — |
| `scripts/test-release.js` | 60 | 发布清单与凭据扫描 | — |
| `scripts/test-skills.js` | ~150 | 技能部署 | — |

## 2. 问题清单

### P1 行为分叉 / 真实缺陷

**P1-1 `panel.js` 的 relay 判定少传快照，与另外两处不一致**

- `src/renderer/pet.js:202`：`window.PetUsage.isRelay(p, s)`（双参）
- `src/renderer/settings.js:194`：`window.PetUsage.isRelay(p, s)`（双参）
- `src/renderer/panel.js:26`：`window.PetUsage.isRelay(p)`（**单参**）

`src/shared/usage.js:4-6` 里 `s.relay === true` 也是 relay 判定条件之一。`panel.js` 不传 `s`，这条条件永远不生效；当提供方类型不在 `newapi` / `openai` / `gemini` 白名单内、但快照自带 `relay: true` 时，面板会走"窗口/余额"分支，而气泡和设置页会走"中转站余额"分支——同一个数据源在三处显示不一致。这是三处重复渲染（P1-2）已经产生的实际后果。

**P1-2 额度行渲染有三套实现，规则已经漂移**

- `src/renderer/pet.js:189-226`（`buildPages`）
- `src/renderer/panel.js:22-37`（`render` 内的 rows 循环）
- `src/renderer/settings.js:184-202`（`renderProviderStatus`）

已可见的不一致：
- 余额分支判空：`pet.js:205` 用 `!== null && !== undefined`，`panel.js:30` 同，但 `settings.js:196` 用 `!= null`（宽松比较）。
- 数字格式化：`settings.js:193` 用自己的 `fmt`（固定两位），`pet.js:36` 的 `fmtMoney`（≥1000 取整）；同一余额在气泡和设置页会显示成不同字符串。
- 赠送余额：`pet.js:217` 单独成一页，`settings.js:196` 拼进余额行，`panel.js` 完全不显示。
- 失败文案：`pet.js:200` 截断 24 字，`panel.js:25` 截断 22 字，`settings.js:192` 不截断。

**P1-3 峰谷时段口径硬编码在渲染层**

`src/renderer/pet.js:40-50`：`peakPage()` / `peakInfo()` 把工作日高峰写成 `540-720`（9:00-12:00）与 `840-1080`（14:00-18:00），且只有周日/周六特判。这个业务口径属于数据层，现在放在渲染层意味着改时段必须改前端并重新走界面验收；也没有任何单测能覆盖它（`peakInfo` 无导出）。

### P2 重复与耦合

**P2-1 五个格式化函数四份拷贝**

| 函数 | 位置 |
|---|---|
| `fmtMoney` | `pet.js:36`、`panel.js:4` |
| `fmtLeft` | `pet.js:37`、`panel.js:5` |
| `esc` | `panel.js:6`、`settings.js:4`、`transfer.js:3` |
| `shortName` | `pet.js:187` |
| `amountStyle` | `pet.js:186` |

注意 `panel.js:5` 的 `fmtLeft` 没有 `Number.isFinite` 保护（`pet.js:37` 有），`panel.js` 只在 `w.resetsAt` 存在时调用所以现在不出错，但这是"拷贝后各自演化"的典型信号。

**P2-2 `configDiff` / `persistSettings` 埋在 DOM 代码里**

`src/renderer/settings.js:7-17` 的 `configDiff` 是纯函数（深比较 + 删除项补 `null`），但它依赖模块级 `baseline`/`cfg` 闭包，只能通过 `settings.js:18-26` 的 `persistSettings` 间接测；而 `settings.js` 是 IIFE 且依赖 `window.pet.invoke`，无法 `require`。目前对这段逻辑**零测试**，而它直接决定"保存时写入哪些字段"。

**P2-3 台词词库内嵌在渲染层**

`src/renderer/pet.js:22-34`：`QUIPS_COMMON`、`QUIPS`（10 个角色约 90 句）、`PEAK_TEXT` 三张表写在渲染文件头部，占 ~13 行超长行。同一功能另有 `src/main/quips.js`（用户付费生成台词，`data.quips` 在 `pet.js:231` 合并）。两套来源混在客户端合并，改词库必须动渲染文件。

**P2-4 角色→提供方类型映射硬编码**

`src/renderer/pet.js:54`：`typesFor = { deepseek: [...], codex: [...], claude: [...], zcode: [...], gemini: [...] }`。而 `src/main/config.js:47-54` 里每个 provider 已带 `character` 字段。映射表只覆盖 5 个角色，`qwen`/`kimi`/`grok`/`seed` 只能靠 `pet.js:56` 的兜底分支命中，两套真源并存。

### P3 可维护性

- **P3-1** `pet.js` 一个 IIFE 承担：角色与立绘（`60-100`）、命中与几何（`105-149`、`307-349`）、气泡与分页（`152-303`）、指针/拖拽/右键（`350-396`）、音效（`398-404`）、交接 UI（`430-489`）、空闲循环（`490-494`）。
- **P3-2** `settings.js` 的模块级状态：`cfg`/`baseline`/`meta`/`data`/`environment`（`5`）、`skillsState`（`111`）、`presets`（`344`）、`launchDefaults`（`358`），跨 tab 隐式共享，任一 tab 渲染都可能改到别人依赖的状态。
- **P3-3** `transfer.js` 压缩风格：每行 4~6 条语句、无空行（对照 `pet.js` 的正常风格），89 行里塞了 3 个视图 + 2 个异步探测 + 事件绑定。
- **P3-4** `src/renderer/panel.html:19-20`：`.info .v.err` 与 `.info .v.stale` 在相邻两行各定义一次；第一条的 `display:block; overflow:hidden; text-overflow:ellipsis` 被第二条覆盖掉一半（只保留 `color`/`font-weight`），实际生效的是合并结果，删任一条都会改行为。
- **P3-5** `settings.html` 有 13 处内联 `style=`；`panel.html:5-42` 整块内联 `<style>`，其余三个页面外链 CSS，改主题要改两套。

### P4 测试

- **P4-1** 渲染层几乎没有单元测试入口：只有 `onboarding.js:142-144` 做了双导出，可被 `test-data.js:206` `require`。`pet.js`/`panel.js`/`settings.js`/`transfer.js` 全部是自执行 IIFE 且直接读 `document`，无法在 `node --test` 下加载。
- **P4-2** "源码文本正则"当 UI 断言：
  - `test-data.js:1369-1375`：断言 `transfer.html` 里存在 `<details id="more">…DS 总结后接手`。
  - `test-data.js:2331-2344`：断言 `main.js` 里存在 `flow.fit(dialog.anchor,area,width,requested)`、`transfer.js` 里存在 `'#intro').hidden=!intro` 等**实现片段**。
  这类断言在行为不变、仅调整写法时必然变红，是渲染层重构（R-05/R-06）的直接阻碍。
- **P4-3** `test-data.js` 2435 行 / 182KB，是主进程、数据层、渲染层共用的大文件。任何任务只要碰它就没法并行，应把渲染相关断言迁出到独立文件。
- **P4-4** `npm test` 有环境噪声：本次运行的输出里出现 3 行 `fatal: not a git repository` 和 1 次 `git diff` 用法提示（来源未定位，退出码仍为 0）。噪声会让"红/绿"判断变钝，值得单独查。

## 3. 候选任务

> 写集用任务书同款 glob 语法。验收命令除 `npm test` 外，凡是新增测试文件都先按 `node --test scripts/test-xxx.js` 单独跑——因为 `package.json` 的 `test` 脚本是**保护文件**（包清单），按协议 §4.4 归集成者，任务不得自行改。

### R-01 新增纯格式化模块 `src/shared/format.js`（只新增，不接入）

- 模块：`m-shared`
- 优先级：2
- 写集：`src/shared/format.js`、`scripts/test-format.js`
- 内容：迁入 `fmtMoney` / `fmtLeft` / `esc` / `shortName` / `amountStyle` 五个纯函数，用 UMD 与 `geometry.js` 一致的包装（同时支持 `module.exports` 与 `root.PetFormat`）。
- 验收：`node --test scripts/test-format.js`（覆盖 `null`/`undefined`/`NaN`/负数/≥1000 取整/货币符号/`<>&"` 转义）+ `npm test`
- 风险：低。**只新增不接入**，现有渲染零改动；风险在下游接入任务（R-01b）时要保持 `panel.js:5` 无 `isFinite` 保护的旧行为或明确升级，需人工确认面板倒计时不变。
- 备注：`panel.js:5` 与 `pet.js:37` 的差异要写进测试注释，避免接入时把 bug 一起"统一"掉。

### R-02 新增额度行视图模型 `src/shared/quota-view.js`（只新增，不接入）

- 模块：`m-shared`
- 优先级：2
- 写集：`src/shared/quota-view.js`、`scripts/test-quota-view.js`
- 内容：输入 `(provider, snapshot, ledger, {warnPercent})`，输出 `{kind: 'error'|'balance'|'relay'|'window'|'extra', label, valueText, subText, tone}`；把 `pet.js:189-226` 的分支规则、截断长度、赠送/令牌额度页拆成纯函数。顺带把 `isRelay` 的判定收敛到这里（不传快照的调用方也会走同一条规则）。
- 验收：`node --test scripts/test-quota-view.js`（覆盖 P1-2 列出的 4 处漂移点各一例）+ `npm test`
- 风险：中。规则以 `pet.js` 为准会让面板/设置的行为变化（余额格式化、赠送额度行），必须逐条在测试里钉死，并由 manager 决定"以气泡为准还是以设置页为准"。
- 依赖：无（纯新增）；接入任务需另开。

### R-03 修 `panel.js` 的 relay 判定分叉（小改，先做）

- 模块：`m-renderer`
- 优先级：1（真实行为分叉，且改动面极小）
- 写集：`src/renderer/panel.js`
- 内容：`panel.js:26` 改为 `window.PetUsage.isRelay(p, s)`，与 `pet.js:202`、`settings.js:194` 对齐。
- 验收：`npm test` + 人工（在面板打开一个 `type: 'custom'` 且快照带 `relay: true` 的中转站，确认显示"余额/账户余额"而不是窗口百分比）
- 风险：低-中。命中该分支的用户会看到面板从"窗口百分比"变成"中转站余额行"，属**修正**但属可见变化，需人工验收，`submit --needs-human`。
- 备注：只有这个分支能证明差异，普通 newapi/gemini 提供方本来就命中 `isRelay`，改前改后一致。

### R-04 台词与峰谷数据外置

- 模块：`m-renderer`
- 优先级：3
- 写集：`src/shared/character-data.js`、`src/renderer/pet.js`
- 内容：把 `pet.js:22-34` 的 `QUIPS_COMMON` / `QUIPS` / `PEAK_TEXT` 与 `peakPage`/`peakInfo` 用的时段常量迁到 `src/shared/character-data.js`；`peakInfo` 改为纯函数 `peakOf(date)` 便于测试。
- 验收：`node --test scripts/test-character-data.js`（工作日 9:00/11:59/12:00/13:59/14:00/17:59/18:00、周六周日）+ `npm test` + 人工（连点气泡确认台词与表情包仍在）
- 风险：中。`pet.js:34` 的 `PEAK_TEXT` 只有 `default/liang/strong` 三个键，`peakPage` 有 `ap.peakMode === 'off'` 早退；迁移时键名或顺序错会导致 UI 静默改字，必须人工逐个模式看一遍。
- 冲突：与 R-05、R-01b 同触碰 `pet.js`，必须串行。

### R-05 拆分 `pet.js`

- 模块：`m-renderer`
- 优先级：3
- 写集：`src/renderer/pet.js`、`src/renderer/pet-bubble.js`、`src/renderer/pet-pointer.js`、`src/renderer/pet-handoff.js`、`src/renderer/pet.html`
- 内容：按 §P3-1 切成四个文件，用一个显式的 `PetApp` 对象（`{state, render, say, showNotice, handoff}`）传参，避免又造一层隐式全局。
- 验收：`npm test` + **人工全量回归**：气泡翻页、表情包 1.2s 回额度页、鼠标穿透、左键拖拽、右键菜单锚点在 `left` 翻转后仍贴边、双击启动、交接四步与取消/复制、音量开关。
- 风险：高。无 DOM 单测兜底（P4-1），一切靠肉眼；`pet.html` 的 `<script>` 顺序改了就会白屏。建议 `submit --needs-human`，并在 PR 里附录屏或逐项勾选。
- 冲突：与 R-01b、R-02b、R-04 同触碰 `pet.js`。

### R-06 拆分 `settings.js` + `configDiff` 抽共享

- 模块：`m-renderer`
- 优先级：3
- 写集：`src/shared/config-patch.js`、`src/renderer/settings.js`、`src/renderer/settings-tabs/*.js`、`src/renderer/settings.html`
- 内容：`configDiff`（`settings.js:7-17`）抽到 `src/shared/config-patch.js` 并加单测；9 个 tab 渲染按 `settings.html:24-147` 的分段拆到独立文件，用显式 `ctx = {cfg, meta, data, invoke, renderAll}` 传参，消除 P3-2 的隐式状态。
- 验收：`node --test scripts/test-config-patch.js`（深比较、数组整体替换、删除键补 `null`、`{}` 判定）+ `npm test` + 人工（逐个 tab 打开、改一项后"有未保存的更改"、保存后回落、向导首启）
- 风险：中-高。`settings.js:491` 的初始化顺序（先挂向导再扫描）是有意为之（注释在 `472`），拆分时极易打乱；`settings.html:170-173` 的四个 `<script>` 顺序也必须同步。
- 冲突：与 R-01b、R-02b 同触碰 `settings.js`；与 R-07 同触碰 `settings.html`。

### R-07 清理 CSS 重复与内联样式

- 模块：`m-renderer`
- 优先级：4
- 写集：`src/renderer/panel.html`、`src/renderer/settings.html`、`src/renderer/settings.css`
- 内容：删 `panel.html:19-20` 的重复规则（保留合并后的等价声明）；`settings.html` 的 13 处内联 `style=` 收进 `settings.css`；`panel.html:5-42` 的内联 `<style>` 视情况外链为 `panel.css`（需同步 CSP 与 `panel.html`）。
- 验收：`npm test` + 人工截图比对（面板、设置页 9 个 tab 在 100%/150% 缩放下的间距与颜色）
- 风险：中。纯视觉，**没有自动化能兜住**；`panel.html` 的 `color-mix()` 与 `accent-color` 依赖 Electron 44，改外链时别顺手换写法。建议单独一波，不与逻辑改动混。
- 冲突：与 R-06 同触碰 `settings.html`（可让 R-06 先落地）。

### R-08 测试层：契约测试与 git 噪声隔离

- 模块：`m-tests`
- 优先级：2
- 写集：`scripts/test-data.js`、`scripts/test-transfer-ui.js`（新增）
- 内容：
  1. 把 `test-data.js:1369-1375`、`2331-2344` 的源码文本断言换成"行为/契约"断言（如 `flow.targets` 已剔来源工具、`fit` 保持锚点、`transfer.html` 必须含 `id="session-search"` 这类真正的 DOM 契约），失败信息指向用户可见行为。
  2. 定位 `npm test` 里 `fatal: not a git repository` 的来源（3 次）并隔离到临时目录或 stub，让输出干净。
- 验收：`npm test`（171 条全绿且输出无 git 报错）
- 风险：中。`test-data.js` 是 182KB 共享文件，改动会与主进程任务（T-001 之后的任务）撞写集，需 manager 排期；不要顺手重排整个文件。
- 冲突：只碰 `scripts/`，与 R-01/R-02 的新增测试文件不重叠，可与第 0 波并行。

## 4. 建议并行组

写集互斥检查后，只有"新增文件"能并行；接入阶段必须串行。

**第 0 波（3 路并行，互不重叠）**

| 通道 | 任务 | 写集 | 说明 |
|---|---|---|---|
| W1 | R-01 | `src/shared/format.js`、`scripts/test-format.js` | 纯新增，不接入 |
| W2 | R-02 | `src/shared/quota-view.js`、`scripts/test-quota-view.js` | 纯新增，不接入 |
| W3 | R-08 | `scripts/test-data.js`、`scripts/test-transfer-ui.js` | 只碰 `scripts/`；与 W1/W2 的新文件不重叠 |

**第 1 波（串行，均为小改或单文件）**

`R-03`（`panel.js` 一处）→ `R-07`（`panel.html`/`settings.html`，纯视觉）→ `R-04`（`pet.js` + 新数据文件）

**第 2 波（串行接入，写集互相穿透）**

`R-01b`（把四个 renderer 切到 `PetFormat`）→ `R-02b`（把三处额度渲染切到 `QuotaView`）→ `R-05`（拆 `pet.js`）→ `R-06`（拆 `settings.js`）

顺序理由：先格式化后视图模型，接入时 diff 面最小；`R-05`/`R-06` 是纯搬移，放在行为改动之后，避免"边改行为边搬文件"。

**不建议并行的组合**

- `R-05` × `R-06`：都会改 `pet.html` / `settings.html` 的脚本顺序与全局对象，同时上会互相踩。
- `R-04` × `R-05`：同一文件的同一段代码。
- `R-07` × `R-06`：`settings.html` 重叠。

## 5. 明确不建议做的事

1. **不引入打包器 / 框架**。四个页面都是 `script-src 'self'` 的裸 `<script>`，没有构建步骤；引入 Vite/Rollup 会连带改 `package.json`、`build.files`、`scripts/pack.js`，属于结构性 CR，收益与风险不成比例。
2. **不在任务工作树里装 `jsdom`/`playwright`**。协议 §4.7 明令禁止在任务工作树安装依赖；且 `node_modules` 是共享链接。渲染层测试只能走"抽纯函数 + 现有 UMD 双导出"的路子。
3. **不重写 `test-data.js`**。它承载 171 条里的绝大多数主进程断言，整体搬迁的收益是整洁，成本是所有并行任务都要重排。
4. **不动 `src/shared/geometry.js` / `transfer-flow.js` / `launch.js` / `usage.js` 的接口**。这四个文件已有单测、边界清晰，是本项目里少见的"已验收模块"；`R-02` 只在 `quota-view.js` 里**调用** `isRelay`，不改它的签名。

## 6. 验收对照

| 任务书要求 | 本文件对应 |
|---|---|
| `docs/audit-renderer-2026-11-03.md` 存在 | 本文件 |
| 至少 5 个候选任务 | 8 个（R-01 ~ R-08） |
| 每个候选有模块/写集/验收/风险 | 每节均含四段 |
| `npm test` 通过 | 见下 |

`npm test` 基线（本任务工作树，改动前）：

```
ℹ tests 171
ℹ pass 171
ℹ fail 0
ℹ duration_ms 3484.5
EXIT=0
```

（输出中另有 3 行 `fatal: not a git repository` 与 1 段 `git diff` 用法提示，不影响退出码，已记为 P4-4 / R-08 第 2 项。）

**人工验收**：本任务是文档盘点，本身不需要点界面。下游 R-03、R-05、R-06、R-07 都需要人工验收，届时各自 `submit --needs-human`。
