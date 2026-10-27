# AI 桌宠

## A / B 两种安装包

在 [最新版本下载页](https://github.com/akane-503/ai-pet/releases/latest) 下载：`setup-A.exe` 为完整交接版，`setup-B.exe` 为额度纯享版；`setup.exe` 与 A 版相同，供原版用户升级。

运行 `npm run dist:editions` 生成 `dist/editions/setup-A.exe` 和 `setup-B.exe`，附 SHA256 和使用说明。

- A：完整交接版，沿用原版安装标识和配置，可选安装 handoff/takeover 技能。
- B：额度纯享试用版，无交接或工具启动菜单，不部署交接技能、不生成付费台词；保留额度、角色、提醒和摸头。
- 两版的程序名、快捷方式、开机自启和配置目录独立，可以同时安装。安装包不含个人配置和凭据，无需另装 Node.js。

B 首次打开引导选择来源、填写信息、测试连接；只有读到有效余额或用量窗口后才能启用，真实余额 0 也可通过。可以稍后设置，下次启动仍会提示。中转站余额应填个人设置中的系统访问令牌＋用户 ID，不是模型 API Key。

建议朋友先试 B：确认引导、刷新值与后台对照、重启保留配置、A/B 同装互不覆盖。有问题反馈来源、错误文字和版本，不发送 Key 或凭据文件。

Windows 桌面额度桌宠。它会跟着你正在用的 AI 工具换角色，并显示对应的余额或用量；额度重置、送额度、模型上新时会提醒你。

## 安装

两种方式：

- **安装包（推荐）**：运行 `AI桌宠-Setup-<版本>.exe`，选安装目录、可选填 DeepSeek Key、勾选是否把 handoff / takeover 技能部署到本机已装的 AI 工具；装完自动建桌面/开始菜单快捷方式，可在「设置 → 应用」里卸载。
  静默安装：`AI桌宠-Setup-<版本>.exe /S /D=<目录> /KEY=<DeepSeek Key> /NOSKILLS`（`/D=` 必须放最后）。
  构建安装包：`npm run dist`，产物在 `dist\installer\`（国内网络先设 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`）。每次修改完成需重建安装包；成功后自动更新固定入口 `setup.exe` 和 SHA256 文件，同时保留带版本号的安装包。
- **源码包**：需要 Windows 10/11 和 Node.js 22.12+，解压后双击 `start.cmd`，第一次启动会自动安装依赖。

## 运行

- 需要 Windows 10/11 和 Node.js 22.12+。
- 解压 Release 里的源码包，双击 `start.cmd`。第一次启动会自动安装依赖。
- 首次运行会打开设置页。数据源默认全部关闭，填自己的凭据，或用「扫描本机」自动填入。包里不含任何账号或密钥。
- 配置保存在 `%APPDATA%\AI 桌宠`，里面可能有密钥，不要外传。
- 运行 `scripts/install-shortcuts.ps1` 可创建快捷方式，加 `-Autostart` 开机自启。

## 交接与技能

右键「交接给别的 AI」，选择来源会话和目标工具，即可开始转接。会话扫描在独立进程进行，避免阻塞桌宠动画。桌宠读取来源工具的本地对话记录、整理成简短 `HANDOFF.md`，再按目标能力预填指令或保留到剪贴板。目标端 AI 如果装了 `skills/` 里的两个技能会更顺：

交接默认保留当前任务摘要、关键约束、验证状态、下一步，以及原始对话定位信息；需要追溯时再按关键词读取历史，不把全部历史原话重复塞进接手上下文。覆盖旧稿前保留备份。

可读来源：Claude Code、Codex、DSH、WorkBuddy、ZCode、Cursor。Cursor 读的是 `%APPDATA%\Cursor\User\globalStorage\state.vscdb` 里的 composer 与气泡；Plan / 后台任务注入的 user 消息会被过滤，用户原话只取完整气泡（老会话缺气泡时不拿截断的预览顶替）。

往返交接按工具恢复原会话：Codex 桌面版使用原线程链接并预填增量指令，等待确认发送；Claude Code（Windows/WSL）使用 `claude --resume <会话ID>`；Codex CLI 使用 `codex resume <会话ID>`。CLI 恢复后沿用交接指令发送流程。其他工具没有确认的恢复入口时仍打开新会话，不套用通用 `/resume`。

接手指令只有一行：`/takeover <任务名>`（Codex、ZCode 用 `$takeover`）。读哪个文件由 `skills/takeover` 按任务名在项目根找（先看文件名和标题，再取最新的 `HANDOFF*.md`），所以指令里不再塞路径；目标工具没装这个技能时才退回一句「接手交接文件：<路径>」。

DSH 桌面版没有会话级入口：启动参数只有 `--dsh-desktop-workspace=<目录>`，`dsh web` 没有会话参数，应用只注册了 `dsh-recovery:` 和 `dsh-profile-selector:` 两个协议，前端也不按 URL 记会话。所以往返到 DSH 时，桌宠打开该项目、用 UI Automation 把增量指令填进输入框（DSH 会新建或复用一个空白会话），要回到原会话得自己在侧栏点一下。DSH 自己的命令行走一次性续接（`dsh --profile headless --session-id <会话ID> "<任务>"`），桌宠面向的是桌面版，没有接入这条。

- `skills/handoff/SKILL.md` —— 让来源 AI 自己写交接（读不到对话记录时退回这条路）；
- `skills/takeover/SKILL.md` —— 让接手的 AI 先核对代码锚点再继续。

把对应目录拷到目标工具的技能目录即可（Claude Code：`~/.claude/skills/`，DSH：`~/.dsh/skills/`，Codex：`~/.codex/skills/`，Cursor：`~/.cursor/skills/`）。没装也能用，接手指令会提示读取交接文件。

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

Cursor 是多模型 IDE，不固定成某一个娘：桌宠会只读 `%APPDATA%\Cursor\User\globalStorage\state.vscdb` 里当前会话的模型，Claude / GPT / Gemini / Grok / Kimi / GLM / 千问 / DeepSeek / 豆包各自显示对应的模型娘。模型选 Auto（或 Cursor 自家的 Composer / Muse，没有对应立绘）时回落 Claude 娘，面板上会写明「Cursor · Auto」。

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
| Gemini CLI | 官方 OAuth：Pro / Flash 额度剩余；走中转站：真实余额或接口支持的今日用量，不用累计值代替（自动读 `~/.gemini/.env`） |
| 智谱 GLM Coding Plan | 5 小时额度 |
| Claude 订阅 | 5 小时 / 7 天用量（读 Claude Code 登录凭据） |
| Cursor | 本月用量（读本机 Cursor 登录，接口非官方） |
| Kimi 桌面版 | 本地 Kimi Work 上下文用量、模型、会员等级及限流记录；不代表套餐剩余额度 |
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
