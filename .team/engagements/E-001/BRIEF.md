# 外包接包 Brief · E-001

> 状态：accepted · 发包：cursor → 接包：codex
> 生成：2026-11-05T01:49:42.856Z

## 你是谁

你是**接包方**（codex）。只在声明的写集内改动；完成后按「交回」一节交付。
不要改 `.team/` 控制面；不要扩大范围；疑问写入交付说明，由发包 Manager 进 DECISIONS。

## 范围

- 标题：dogfood docs note
- 关联任务：T-010
- 写集：`docs/team-dogfood.md`
- 工作树/切片：`D:\01_Projects\Active\ai-pet.team-worktrees\T-010`
- 验收命令：`node -e process.exit(0)`

## 状态机（脉络）

```text
draft → out → in-progress → delivered → accepted
                          ↘ rejected → out | cancelled
```

你当前应从 `out` 进入 `in-progress`（`engage start`），做完后 `engage deliver`。

## 交回（inbound）

在**发包方控制面**（产品仓根）执行：

```bash
node .team/tools/team.mjs engage start --id E-001 --by codex
# ... 在写集内提交 ...
node .team/tools/team.mjs engage deliver --id E-001 --head <sha> --note "做了什么"
# 发包 Manager：
node .team/tools/team.mjs engage accept --id E-001 --integrate
```

# 接包方宿主适配（codex）

在接包方机器/会话执行：

```powershell
node D:/01_Projects/Active/project-team-pm/adapters/_install.mjs --host codex --repo <本产品仓> --skill
```

然后用本 brief 作为接包会话的第一条消息；cwd 优先用任务 worktree（若有）。

## 血缘

- 外包包文件：`.team/engagements/E-001/`
- 公告栏「外包 / 血缘」节；真相在 `board.json.engagements`。
