# 层关系澄清（控制面 ≠ 桌宠产品）

> 2026-11-05。对齐早期愿景：「能用在所有 AI 工具上的项目管理系统」。  
> 完整论述见 Project store：`docs/cross-tool-pm-vision.md`。

## 两套东西，不要混 CHARTER

| | 跨工具项目管理（控制面） | ai-pet 桌宠（本仓业务） |
|---|---|---|
| 问题 | 多 Agent 如何协作改**同一代码仓** | 额度/用量、角色、工具间 handoff/takeover、安装与设置 |
| 载体 | `.team/` + **project-team-pm** skill/CLI | `src/**`、`scripts/**`、`skills/handoff*` |
| 真相分支 | 控制面规格见 `CONTROL_PLANE.md` | 产品集成：`team/integration`（D-002） |

- **经理会话**管控制面流程（拆派、仲裁、验收、CR、DECISIONS）。  
- **产品会话**（`product/*` / 工作树 `product-*`）改桌宠功能；doctor 视其为合法非任务树（P6）。  
- 产品「转接」≠ 控制面「多会话写仓」。

## 控制面仓路径（已改指）

见 `.team/CONTROL_PLANE.md` 与 `config.json` → `controlPlane`。  
独立仓：`D:/01_Projects/Active/project-team-pm`。  
main WIP 归档：`wip/main-20261105`；产品认 `team/integration`。

## Manager 开场

除 PROTOCOL / CHARTER / ARCHITECTURE / STATUS / LAYERS，读 `CONTROL_PLANE.md`；用户说「管理系统 / 跨工具 / 项目管理」→ 控制面愿景，勿自动转成桌宠实现。