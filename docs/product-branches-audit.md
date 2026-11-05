# product/* 侧分支差异盘点

> 生成：2026-11-06 · 基于 main@`5352159`（清板收拢 + task docs 回流之后）
> 方法：`git rev-list --count` / `git log main..<branch>` / `git diff --stat <merge-base>..<branch>` / `merge-base --is-ancestor`
> 性质：只读盘点，未改动任何 product 分支。

## 总览

| 分支 | tip | 领先 main | 落后 main | 状态 |
|---|---|---|---|---|
| `product/quota` | `f4d889b`（11-05 01:34） | 40 | 23 | **最大汇合点**，含 transfer/settings/install/interaction 全部工作 |
| `product/notifications` | `a3806c5`（11-04 23:43） | 40 | 23 | 与 quota 互差：独有 1 个修复 + 1 个 team/integration merge |
| `product/transfer` | `cddd860`（11-04 21:44） | 20 | 24 | 已 ⊂ product/quota |
| `product/settings` | `b78439d`（11-04 20:50） | 4 | 24 | 已 ⊂ product/quota |
| `product/install` | `6d0c0bd`（11-04 21:07） | 5 | 24 | 已 ⊂ product/quota |
| `product/interaction` | `c078eb9`（11-03） | 0 | 24 | **已 ⊂ main，纯残留，分支可直接删** |

## 关键发现

1. **main 自 11-03 后没有动过任何产品代码**（`git diff c078eb9..main -- src/ build/ skills/ package.json` 为空，24 个提交全是 team 控制面 chore）。→ product 分支合回 main **在产品代码层面无冲突风险**。
2. **product/quota 是事实上的集成分支**：`merge-base --is-ancestor` 验证，transfer/settings/install/interaction 的 tip 全部包含在 `f4d889b` 内。
3. **notifications ↔ quota 各有少量独有提交**：
   - quota 独有：`7103d59` feat(provider): Codex 数据源可单独指定 auth.json 支持多账号；`f4d889b` docs(changelog): 262 用例。
   - notifications 独有：`1f84188` fix(notice): 气泡通知不再溢出（长文截断+缩字号）；`a3806c5` 对 team/integration 的 merge。
4. **真实待集成增量很小**：全部产品工作 ≈ quota 与 notifications 的并集，约 **59 文件 / +4287 −425**（quota 视角），核心功能提交约 15 个（见下）。
5. 附带发现：T-001/T-002 的审计文档（`docs/audit-main-2026-11-03.md`、`docs/audit-renderer-2026-11-03.md`）此前也只活在侧分支，已于本日随 task 分支回流 main。

## 核心功能提交（非 merge，按主题）

**安装 / 发布（1.3.3）**
- `6d0c0bd` chore(release): 1.3.3
- `fb611e6` feat(update): 应用内检查新版本（只提示、不自动安装）
- `a3604aa` fix(onboarding): 向导翻页不丢已填内容，部署失败不再静默关闭
- `b4c00a2` build(release): 元数据校验、发布目录收敛、安装包自动化验收
- `6245c8d` fix(release): 缺 latest.yml 自动补生成，拦住漏打 koffi 的构建
- `f94f149` fix(installer): 卸载时清理开机自启快捷方式

**转接 transfer**
- `cddd860` feat(transfer): 来源可确认/可更换、大会话接手修复、失败可回看重试、同工具指针接手

**额度 quota**
- `73bc6d2` feat(quota): 统一气泡/面板/设置三处额度行，修面板中转站判定
- `1aca30b` fix(peak): DeepSeek 峰谷按北京时间与法定节假日计算
- `7f9b19f` fix(quota): 额度按工具归属，新数据源测试前补默认路径
- `7103d59` feat(provider): Codex 多账号（独立 auth.json）

**通知 notifications**
- `fcf6f20` feat(notify): 按来源静音、仅在活跃时弹、送额度稍后提醒
- `5478d85` fix(notify): 送额度/出路提醒退避分级，不再静默吞掉
- `b713422` refactor(notify): 投递策略抽纯函数补测试；新闻源粒度开关；未读摘要
- `aaaa4bd` fix(notify): 免打扰时段可注入时间可单测；坏区间不误静音
- `e630a09` feat(notifications): 消息中心只看未读与清空已读
- `1f84188` fix(notice): 气泡通知不再溢出

**设置 settings**
- `7c2b3af` fix(settings): 技能更新判定、工具目录收敛、「启动与刷新」页
- `e79aa9b` fix(settings): 链接目录安全与向导技能勾选
- `05f0a2c` refactor(config): 老配置迁移收敛到可单测的 migrateConfig
- `b78439d` test(smoke): 设置页「启动与刷新」运行时验收

**共享层**
- 新增 `src/shared/quota-view.js`（+168 行，额度视图统一）
- `src/shared/transfer-flow.js` 扩展（+33 行）

## 建议集成顺序（待批准，未执行）

1. `product/notifications` 合入 `product/quota`（或直接两条先后合入 main），得到唯一产品 tip。
2. main merge 产品 tip → 全部 1.3.3 产品工作回流；跑 `npm test`（回归用例 262）。
3. 评估 `team/integration`（领先 main 49，含 dogfood 记录与历史 merge）是回流还是归档。
4. 删 `product/interaction` 分支（⊂ main）；产品分支合并后逐条删除。
5. 移除对应 worktree（`ai-pet.team-worktrees/*`）。

## 当前 worktree 残留

`integration`、`product-install`、`product-interaction`、`product-notifications`、`product-quota`、`product-settings`、`product-transfer` 共 7 个；已完成的 6 个 task worktree（T-001~T-021）已于 2026-11-06 移除。
