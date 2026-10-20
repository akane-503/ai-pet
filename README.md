# AI 桌宠

Windows 桌面额度桌宠。它会跟着你正在用的 AI 工具换角色，并显示对应的余额或用量；额度重置、送额度、模型上新时会提醒你。

## 运行

- 需要 Windows 10/11 和 Node.js 22.12+。
- 解压 Release 里的源码包，双击 `start.cmd`。第一次启动会自动安装依赖。
- 首次运行会打开设置页。数据源默认全部关闭，填自己的凭据，或用「扫描本机」自动填入。包里不含任何账号或密钥。
- 配置保存在 `%APPDATA%\AI 桌宠`，里面可能有密钥，不要外传。
- 运行 `scripts/install-shortcuts.ps1` 可创建快捷方式，加 `-Autostart` 开机自启。

## 操作

| 动作 | 效果 |
|---|---|
| 单击角色 | 弹出额度气泡并刷新 |
| 点气泡 | 翻页 |
| 拖拽 | 移动；靠近屏幕边或窗口时吸附 |
| 双击角色 | 打开对应的工具 |
| 右键 / 托盘 | 菜单 |
| 悬停右侧 ≡ | 快捷面板 |

## 角色识别

角色设为「自动」时，按以下顺序判断你在用哪个工具：前台窗口、最近打开过的工具、会话目录的最近写入。

内置识别：DeepSeek、GPT/Codex、Claude Code（含 WSL）、ZCode/GLM、Gemini、千问、Kimi、Grok、豆包。另外预置了 Trae、Cursor、WorkBuddy、元宝。

想加别的工具，在「设置 → 活跃检测 → 自定义 Agent」里添加：
- 填进程名或窗口标题正则用来识别；
- 选一个内置角色借用立绘，也可以指定自己的图片；
- 启动方式在「打开工具」里改。

## 数据源

| 类型 | 显示内容 |
|---|---|
| DeepSeek | 余额、今日已用 |
| Codex / ChatGPT | 5 小时 / 7 天用量（读 `~/.codex/auth.json`） |
| 中转站（new-api / one-api） | 余额，或今日已用 |
| 智谱 GLM Coding Plan | 5 小时额度 |
| Claude 订阅 | 5 小时 / 7 天用量（读 Claude Code 登录凭据） |
| Cursor | 本月用量（读本机 Cursor 登录，接口非官方） |
| 自定义 JSON 接口 | 填 URL 和字段路径，显示余额或已用百分比 |

Trae、WorkBuddy、元宝没有公开的额度接口，目前只做识别和启动。如果你知道接口，可以用「自定义 JSON 接口」接上。

## 开发

```
npm test       # 回归测试
npm run pack   # 生成轻量发布包
```

`src/main` 是主进程（窗口吸附、调度、通知、活跃检测），`src/main/providers` 是各数据源，`src/renderer` 是桌宠、面板和设置页。

## 许可

项目代码尚未选择开源许可。角色、GIF 和音效的再分发授权尚未核实。来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
