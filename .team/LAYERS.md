# 层关系澄清（控制面 ≠ 桌宠产品）

> 2026-11-05。对齐早期愿景：「能用在所有 AI 工具上的项目管理系统」。  
> 完整论述见 Project store：`docs/cross-tool-pm-vision.md`（Manager-multiAgent work）。

## 两套东西，不要混 CHARTER

| | 跨工具项目管理（控制面） | ai-pet 桌宠（本仓业务） |
|---|---|---|
| 问题 | 多 Agent 如何协作改**同一代码仓** | 额度/用量、角色、工具间 handoff/takeover、安装与设置 |
| 载体 | 本目录 `.team/` + `project-team` skill/CLI | `src/**`、`scripts/**`、`skills/handoff*` |
| 真相分支 | 控制面规格跟主检出/协议走 | 产品集成：`team/integration`（见 STATUS / D-002） |

- **经理会话**管的是控制面流程（拆派、仲裁、验收、CR）。  
- **产品会话**（`product/quota` 等）改的是桌宠功能。  
- 产品的「转接」≠ 控制面的「会话写仓」：主题相邻，机制不同。

## Manager 开场多读一句

除了 PROTOCOL / CHARTER / ARCHITECTURE / STATUS，扫一眼本文件：若用户说「管理系统 / 跨工具 / 项目管理」，指向控制面愿景，不要把需求自动转成桌宠实现。

## 控制面仓路径（2026-11-05 · P1=B）

- 独立仓：`D:/01_Projects/Active/project-team-pm`（CLI / skill / managerd / 宿主适配）。
- 本仓 `.team/` 仍是**运行时**控制面；技能源与适配以独立仓为准，后续细修接入指向。
- main WIP 已归档到本地分支 `wip/main-20261105`（不 push）；产品继续认 `team/integration`。

## 未决（不阻塞产品执行）

- 把文档/技能路径全面改指 `project-team-pm`（另任务）。
- integration 上未完成合并（若仍有）按 D-003 边界处理，本轮不碰。