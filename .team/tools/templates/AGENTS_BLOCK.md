<!-- project-team:begin -->
## 项目团队协议（project-team）

本项目用 `.team/` 管理多会话协作。任何会话开工前先读 `.team/BULLETIN.md` 和 `.team/PROTOCOL.md`。

**硬规则：**

1. 管理层不写业务代码；执行者只写任务书写集（`write`）内的文件。
2. 不改 `.team/` 控制面；不改别人的任务；不删公告栏行。
3. 状态、证据、交接只认 `{{CLI}}` 和公告栏，不认对话记忆。
4. 先 `claim` 再干活；写集冲突未裁决前不得继续写重叠路径。
5. 需要人工验收的项标 `needsHuman`，`accept` 必须 `--human-ok`，不许自勾完成。
6. 范围/优先级/结构变更走 CR；执行者不得自行扩大写集。
7. 依赖目录若是共享链接（`node_modules`/`.venv`），禁止在任务工作树里安装/升级依赖；改依赖走 CR 或集成者。

**常用：**

```text
{{CLI}} status
{{CLI}} bulletin
{{CLI}} task add --title "..." --module <模块> --write "<glob>" --verify "<命令>"
{{CLI}} dispatch --id T-001
{{CLI}} claim --id T-001 --token <token>
{{CLI}} submit --id T-001 --token <token>
{{CLI}} integrate --id T-001
{{CLI}} accept --id T-001
```

派子会话时：`subagent` 的 `cwd` 用任务工作树，prompt 用 `.team/local/sessions/T-001.md` 的全文。
在任务工作树里执行时，用会话简报里的**控制面绝对路径**调用 CLI；工作树里的 `.team/tools/team.mjs` 可能落后于控制面。
<!-- project-team:end -->
