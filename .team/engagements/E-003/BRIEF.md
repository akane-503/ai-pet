# 外包接包 Brief · E-003

> 状态：cancelled · 发包：cursor → 接包：dsh
> 生成：2026-11-05T09:10:44.042Z

## 你是谁

你是**接包方**（dsh）。只在声明的写集内改动；完成后按「交回」一节交付。
不要改 `.team/` 控制面；不要扩大范围；疑问写入交付说明，由发包 Manager 进 DECISIONS。

## 范围

- 标题：dsh-smoke
- 关联任务：（切片/无任务）
- 写集：`docs/**`
- 工作树/切片：`（尚未 dispatch；接包方可在约定切片目录工作）`
- 验收命令：`npm test`

## 状态机（脉络）

```text
draft → out → in-progress → delivered → accepted
                          ↘ rejected → out | cancelled
```

你当前应从 `out` 进入 `in-progress`（`engage start`），做完后 `engage deliver`。

## 交回（inbound）

在**发包方控制面**（产品仓根）执行：

```bash
node .team/tools/team.mjs engage start --id E-003 --by dsh
# ... 在写集内提交 ...
node .team/tools/team.mjs engage deliver --id E-003 --head <sha> --note "做了什么"
# 发包 Manager：
node .team/tools/team.mjs engage accept --id E-003 --integrate
```

# 接包方宿主适配（dsh）

在接包方机器/会话执行：

```powershell
node D:/01_Projects/Active/project-team-pm/adapters/_install.mjs --host dsh --repo <本产品仓> --skill
```

然后用本 brief 作为接包会话的第一条消息；cwd 优先用任务 worktree（若有）。

## 血缘

- 外包包文件：`.team/engagements/E-003/`
- 公告栏「外包 / 血缘」节；真相在 `board.json.engagements`。
