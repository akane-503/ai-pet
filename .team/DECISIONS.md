# 决策记录与审批（DECISIONS）

> 项目：ai-pet · 更新：2026-11-04
> 本文件是**决策真相**。执行会话不能直接拿全局/不可逆操作去问用户，必须先在这里等裁决。

## 决策者

- **唯一决策者**：manager（当前是「接管 ai-pet 项目管理」会话；没有 manager 时由主会话代管）。
- 用户只在**范围/预算**或 manager 明确无法判断时升级；执行会话不得绕过 manager 直接弹用户选项。
- 决策必须落到本文件：背景、选项、建议、影响、决定、理由、决策者、时间。

## 必须先决策的动作

1. 安装 / 卸载 / 静默安装 / 改注册表 / 改系统设置。
2. `taskkill`、关闭或重启 AI 桌宠/DSH 进程，批量结束会话。
3. 删除/覆盖用户数据、配置、凭据、工作树、分支。
4. `git reset --hard`、`push --force`、改写已发布历史。
5. 跨产品契约/架构变更、保护文件（package.json、lockfile、schema、入口注册）。
6. 其他不可逆或会影响用户当前正在使用的实例的操作。

## 执行会话规则

1. **停手**：不要先做，也不要直接 `ask_user_question` 让用户选。
2. 在本文件「待裁决」写一条：任务、背景、选项、建议、影响、需要谁批。
3. 等 manager 写「决定」后再动；紧急阻塞标 `等人`。
4. 裁决后把决定引用到任务/公告栏；不得静默改选项。

## 决策记录

### D-001 安装包真装验收

- 请求：`verify:install` / `verify:install:features` 会先 `taskkill` 6 个 AI 桌宠进程（约 2 个正在运行的实例），再静默安装、写注册表、卸载。
- 选项：
  1. 做：结束实例，跑完整安装/卸载验收（3–5 分钟）。
  2. 先别动：只跑产物自检 + 解包版 smoke；不写注册表、不杀进程。
- 决定：**选项 2，先别动**。
- 理由：不打断用户当前桌宠实例；安装/注册表属于全局破坏性操作，留到用户确认的维护窗口。
- 决策者：manager/主会话；时间：2026-11-04 21:17。
- 执行结果（2026-11-04 21:37）：
  - 在 `product-install` 工作树构建 1.3.3 安装包：`dist/installer/AI-Pet-Setup-1.3.3.exe`（112.6 MB）。
  - `node scripts/verify-installer.js` **通过**：安装包/固定入口 sha256/latest.yml/koffi/解包版 smoke 共 5 步，11 项 smoke 检查全过，退出码 0。
  - 未 `taskkill`、未静默安装、未写注册表；运行中的桌宠实例未受影响。
  - 构建坑：工作树 `node_modules` 是链接，electron-builder 会漏收 koffi；临时复制真实 `node_modules` 构建后已恢复链接，工作树 `git status` 干净。
- 后续：完整静默安装另开 D-002，必须由用户确认维护窗口后再做。

### D-005 跨工具 PM 独立仓 + main WIP 归档（用户拍板落地）

- 背景：用户确认 P1=B、P2=AB、P3=通用适配（Codex/Claude Code/Zcode）、P4/P5 授权合理默认。
- 决定：
  1. 控制面独立仓 `D:/01_Projects/Active/project-team-pm`；ai-pet 仍是产品试验场，CHARTER 只写桌宠并显式非目标「不做通用 PM」。
  2. main 脏树归档到本地分支 `wip/main-20261105`（不 push）；产品继续认 `team/integration`。
  3. Manager 加深 DECISIONS + 可选 managerd 队列；不自动决策。
- 决策者：用户拍板 + worker 落地；时间：2026-11-05。
- 执行结果：独立仓骨架可跑；本仓 CHARTER/LAYERS 已更新；未改业务代码路径指向（后续细修）。
