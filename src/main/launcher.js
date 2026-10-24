'use strict';
// 打开当前角色对应的 agent 工具：桌面应用（已开则不重复开，只置前）、CLI（每次开新终端）、网页
const { spawn, execFile } = require('child_process');
const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const winsnap = require('./winsnap');
const { toWslPath } = require('./handoff');

const HOME = process.env.USERPROFILE || '';
const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };

// 内置角色的桌面版：本机搜得到 exe 就开应用，否则开网页
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const APPS = {
  deepseek: { name: 'DSH Desktop', process: 'DSH Desktop.exe', title: 'DeepSeek Harness|DSH Desktop', url: 'https://chat.deepseek.com', web: 'DeepSeek' },
  zcode: { name: 'ZCode', process: 'ZCode.exe', title: '^ZCode', url: 'https://chat.z.ai', web: 'Z.ai' },
  gemini: { name: 'Gemini 桌面版', process: 'Gemini.exe', title: '^(Google\\s+)?Gemini(\\b|$)', paths: [path.join(LOCAL, 'Google', 'Gemini', 'Gemini.exe')], url: 'https://gemini.google.com', web: 'Gemini' },
  qwen: { name: '千问', label: '^(千问|通义千问|通义)$', url: 'https://www.qianwen.com', web: '千问' },
  kimi: { name: 'Kimi', label: '^Kimi(智能助手)?$', url: 'https://www.kimi.com', web: 'Kimi' },
  grok: { name: 'Grok', url: 'https://grok.com', web: 'Grok' }, // xAI 没有官方 Windows 客户端
  seed: { name: '豆包', process: 'Doubao.exe', label: '^豆包$', url: 'https://www.doubao.com', web: '豆包' },
};

const CLAUDE_APP = { name: 'Claude 桌面版', process: 'Claude.exe', title: '^Claude$', url: 'https://claude.ai', web: 'Claude' };

// Claude：Claude Code 数据在 WSL 里 → WSL 终端；Windows 装了 CLI → 本机终端；否则桌面版 / 网页
function claudeSpec(dirs) {
  const wslDir = dirs.find((d) => /^\\\\wsl(\.localhost|\$)\\/i.test(d) && exists(d));
  if (wslDir) return { kind: 'wsl-cli', label: 'Claude Code (WSL)', distro: wslDir.split('\\')[3] || '', command: 'claude', cwd: '~' };
  return claudeWinSpec() || agentSpec(CLAUDE_APP);
}
// Windows 本机装的 Claude Code CLI（和 WSL 版可以并存）
function claudeWinSpec() {
  const cli = [path.join(HOME, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')].find(exists);
  return cli ? { kind: 'cli', label: 'Claude Code (Windows)', command: 'claude' } : null;
}
// VS Code 系编辑器：把文件夹当参数就能打开工作区（已开着也会转给现有实例）
// DSH / ZCode 使用显式开关；WorkBuddy 与编辑器接受目录参数。
const FOLDER_APPS = /^(code|cursor|windsurf|kiro|trae( cn)?|qoder( ide)?|codebuddy|workbuddy|zcode|dsh desktop)\.exe$/i;

// 每个角色的默认启动方式；用户可在设置里覆盖（config.launch[characterId]）
function defaults() {
  return {
    ...Object.fromEntries(Object.entries(APPS).map(([id, a]) => [id, agentSpec(a)])),
    codex: { kind: 'store', label: 'GPT / Codex 桌面版', target: 'OpenAI.Codex_2p2nqsd0c76g0!App', match: '^(Codex|ChatGPT)(\\b|$)', process: 'ChatGPT.exe', fallbackUrl: 'https://chatgpt.com/codex' },
    claude: claudeSpec(require('./activity').detectClaudeDirs({})),
    gemini: geminiSpec(),
  };
}
// Gemini：装了 Gemini CLI（npm 全局）就开终端，否则桌面版 / 网页
function geminiSpec() {
  return exists(path.join(process.env.APPDATA || '', 'npm', 'gemini.cmd')) ? { kind: 'cli', label: 'Gemini CLI', command: 'gemini' } : agentSpec(APPS.gemini);
}

const exeNames = (a) => String(a.process || '').split('|').map((x) => x.trim()).filter(Boolean);
const labelKey = (a) => a.label ? '@' + a.label : '';
const found = {}; // exe 小写名 / '@显示名正则' -> 搜到的完整路径
const tried = new Set(); // 本次运行已搜过的名字，搜不到也不重复跑
let pending = Promise.resolve(found); // 正在跑的搜索，后来的调用等它结束

// 一次 PowerShell 找 exe：正在运行的进程 > 卸载注册表 > App Paths > 开始菜单/桌面快捷方式 > 各盘两层目录
const FIND_PS = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$names=@(__NAMES__); $labels=@(__LABELS__); $hits=@{}
function Clean($p){ ($p -replace ',-?\\d+$','').Trim().Trim('"') }
function Add($p){ if(!$p){return}; $p=Clean $p; $n=[IO.Path]::GetFileName($p).ToLower()
  if($names -contains $n -and !$hits[$n] -and (Test-Path -LiteralPath $p)){ $hits[$n]=$p } }
function AddLabel($name,$p){ if(!$name -or !$p){return}; $p=Clean $p; if($p -notmatch '\\.exe$' -or !(Test-Path -LiteralPath $p)){return}
  foreach($l in $labels){ if(!$hits['@'+$l] -and $name -match $l){ $hits['@'+$l]=$p } } }
Get-Process -EA 0 | % { Add $_.Path }
$u='Software\\Microsoft\\Windows\\CurrentVersion'
Get-ItemProperty "HKCU:\\$u\\Uninstall\\*","HKLM:\\$u\\Uninstall\\*","HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*" -EA 0 | % {
  Add $_.DisplayIcon; AddLabel $_.DisplayName $_.DisplayIcon; $l=$_.InstallLocation; if($l){ foreach($n in $names){ Add (Join-Path $l.Trim('"') $n) } } }
Get-ItemProperty "HKCU:\\$u\\App Paths\\*","HKLM:\\$u\\App Paths\\*" -EA 0 | % { Add $_.'(default)' }
$sh=New-Object -ComObject WScript.Shell
Get-ChildItem "$env:APPDATA\\Microsoft\\Windows\\Start Menu","$env:ProgramData\\Microsoft\\Windows\\Start Menu","$env:USERPROFILE\\Desktop","$env:PUBLIC\\Desktop" -Recurse -Filter *.lnk -EA 0 | % { $t=$sh.CreateShortcut($_.FullName).TargetPath; Add $t; AddLabel $_.BaseName $t }
foreach($n in $names){ if(!$hits[$n]){ foreach($d in (Get-PSDrive -PSProvider FileSystem).Root){ Resolve-Path "$d*\\$n","$d*\\*\\$n" -EA 0 | % { Add $_.Path } } } }
$hits | ConvertTo-Json -Compress`;

// 后台搜一次，结果进 found；agentSpec 同步读缓存
function discover(agents = []) {
  const all = [...agents, ...Object.values(APPS), CLAUDE_APP];
  const fresh = (xs) => [...new Set(xs)].filter((n) => n && !tried.has(n));
  const names = fresh(all.flatMap(exeNames).map((x) => x.toLowerCase()));
  const labels = fresh(all.map((a) => a.label || ''));
  [...names, ...labels].forEach((n) => tried.add(n));
  if ((!names.length && !labels.length) || process.platform !== 'win32') return pending;
  const q = (xs) => xs.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  const script = FIND_PS.replace('__NAMES__', () => q(names)).replace('__LABELS__', () => q(labels)); // 函数形式：正则里的 $' 不能被当替换模式
  return (pending = pending.then(() => new Promise((done) => {
    execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 60000 }, (_e, out) => {
      try { Object.assign(found, JSON.parse(String(out).trim() || '{}')); } catch (_) { /* 搜不到就保持网页回退 */ }
      done(found);
    });
  })));
}

// 自定义 agent 的默认启动：显式 target > 搜到的 exe > 常见安装目录里的同名 exe > 网址
function agentSpec(a) {
  const exes = exeNames(a);
  const dirs = [path.join(HOME, 'AppData', 'Local', 'Programs'), process.env.ProgramFiles || 'C:\\Program Files'];
  const target = a.target || exes.map((exe) => found[exe.toLowerCase()]).find(exists) || [found[labelKey(a)]].find(exists) || (a.paths || []).find(exists)
    || exes.flatMap((exe) => dirs.map((d) => path.join(d, exe.replace(/\.exe$/i, ''), exe))).find(exists);
  if (target) return { kind: 'app', label: a.name, target, process: path.basename(target), match: a.title || '', fallbackUrl: a.url || null };
  return a.url ? { kind: 'url', label: (a.web || a.name) + ' 网页', target: a.url, webFallback: true } : null;
}

// 菜单只列本机可确认的入口；不执行命令探测，避免弹终端或阻塞主进程。
function menuAvailable(spec) {
  if (!spec) return false;
  if (spec.kind === 'app') return exists(spec.target);
  if (spec.kind === 'url') return !!spec.target && !spec.webFallback;
  if (spec.kind !== 'cli') return true; // Store / WSL 使用各自已配置的入口。
  const command = String(spec.command || '').trim();
  if (!command) return false;
  if (path.isAbsolute(command)) return exists(command);
  // 自定义脚本/复合命令不能靠文件名判断，保留；普通 CLI 按 PATH 和常用安装目录检查。
  if (!/^[\w.-]+$/.test(command)) return true;
  const dirs = [path.join(process.env.APPDATA || '', 'npm'), path.join(HOME, '.local', 'bin'), ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
  const extensions = path.extname(command) ? [''] : ['', '.exe', '.cmd', '.bat', '.com'];
  return dirs.some(dir => extensions.some(ext => exists(path.join(dir.replace(/^"|"$/g, ''), command + ext))));
}

function resolve(characterId, userLaunch) {
  const d = defaults()[characterId];
  const u = userLaunch && userLaunch[characterId];
  if (u && u.kind) {
    const spec = { ...(u.kind === d?.kind ? d : {}), ...u };
    if (u.kind === 'url' && u.target) spec.webFallback = false;
    // 旧设置曾用角色名填启动标签；工具菜单只显示入口名，保留其他自定义名称。
    if (characterId === 'gemini' && /^哈基米\s*[·・]\s*Gemini$/i.test(spec.label || '')) {
      spec.label = /cli$/.test(spec.kind) ? 'Gemini CLI' : spec.kind === 'url' ? 'Gemini 网页' : 'Gemini 桌面版';
    }
    if (u.target && u.target !== (d || {}).target) {
      if (!u.process) spec.process = u.kind === 'app' ? path.basename(u.target) : null;
      if (!u.script) spec.script = null;
      if (!u.fallbackUrl) spec.fallbackUrl = null;
    }
    return spec;
  }
  return d || null;
}

// 只把真正可唤起的主窗口视为已打开；残留后台进程不能阻止系统入口重新激活应用。
function isRunning(spec) {
  let win = null;
  if (spec.match || spec.process) { try { win = winsnap.findWindow(spec.match || '.', spec.process); } catch (_) { /* */ } }
  if (win) return { window: win };
  return null;
}

// bringToFront 带 Alt 解锁：一键交接时桌宠不在前台，普通 SetForegroundWindow 会被系统拦下
function focus(hwnd) { try { winsnap.bringToFront(hwnd); } catch (_) { /* */ } }

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// 工作区 cwd（Windows 路径）能用就用：CLI 在该目录开终端，VS Code 系编辑器打开该文件夹，其他工具忽略
const CODEX_STORE_ID = /^OpenAI\.Codex_[^!]+!App$/i;
function codexDesktopEntry(spec) {
  if (!spec || spec.kind !== 'store' || !CODEX_STORE_ID.test(spec.target || '')) return '';
  const entry = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return exists(entry) ? entry : '';
}
function codexDraftUrl(spec, cwd, prompt = '') {
  if (!spec || spec.kind !== 'store' || !CODEX_STORE_ID.test(spec.target || '')) return '';
  if (!cwd || !path.isAbsolute(cwd)) return '';
  return 'codex://threads/new?path=' + encodeURIComponent(cwd) + (prompt ? '&prompt=' + encodeURIComponent(prompt) : '');
}
function supportsWorkspace(spec) {
  return !!spec && (spec.kind === 'cli' || spec.kind === 'wsl-cli' || !!codexDraftUrl(spec, HOME) || (spec.kind === 'app' && FOLDER_APPS.test(path.basename(spec.target || ''))));
}
function workspaceDirectory(value) {
  try { return path.isAbsolute(value) && fs.statSync(value).isDirectory(); } catch (_) { return false; }
}

// 返回 { ok, message }
async function launch(characterId, userLaunch, { cwd = '', prompt = '', session = null } = {}) {
  const spec = resolve(characterId, userLaunch);
  if (!spec) return { ok: false, message: '这个角色还没配置启动方式' };
  const resume = session && require('./handoff-return').UUID.test(session.id || '') && session.tool === characterId;
  if ((spec.kind === 'cli' || spec.kind === 'wsl-cli') && !String(spec.command || '').trim()) return { ok: false, message: '请在设置中填写启动命令' };
  const configured = cwd || spec.cwd || '';
  const nativeDirectory = configured && !(spec.kind === 'wsl-cli' && !/^(?:[a-z]:[\\/]|\\\\)/i.test(configured));
  if (nativeDirectory && supportsWorkspace(spec) && !workspaceDirectory(configured)) return { ok: false, message: '工作目录不存在或不是文件夹，请在设置中重新选择' };
  const ws = nativeDirectory && supportsWorkspace(spec) ? configured : '';
  const running = isRunning(spec);
  if (running && !resume && !ws && (spec.kind === 'app' || spec.kind === 'store')) {
    if (running.window) { focus(running.window.hwnd); return { ok: true, message: `${spec.label} 已经开着啦`, already: true }; }
  }
  try {
    switch (spec.kind) {
      case 'app':
        if (!exists(spec.target)) { if (spec.fallbackUrl) { await shell.openExternal(spec.fallbackUrl); return { ok: true, message: '本地没装，打开网页版' }; } return { ok: false, message: '找不到 ' + spec.target }; }
        const exe = path.basename(spec.target).toLowerCase();
        const workspaceArg = exe === 'dsh desktop.exe' ? '--dsh-desktop-workspace=' + ws : exe === 'zcode.exe' ? '--open-workspace=' + ws : ws;
        await run(spec.target, ws ? [...(spec.args || []), workspaceArg] : (spec.args || []), { cwd: path.dirname(spec.target) });
        return { ok: true, message: '正在打开 ' + spec.label, workspaceRequested: !!ws };
      case 'store':
        if (resume && characterId === 'codex' && CODEX_STORE_ID.test(spec.target || '')) {
          await shell.openExternal('codex://threads/' + encodeURIComponent(session.id) + (prompt ? '?prompt=' + encodeURIComponent(prompt) : ''));
          return { ok: true, message: prompt ? '已请求返回 Codex 原会话并预填补充指令' : '已请求返回 Codex 原会话', sessionRestored: true, draftPrepared: !!prompt };
        }
        if (ws && codexDraftUrl(spec, ws) && (prompt || !codexDesktopEntry(spec))) {
          await shell.openExternal(codexDraftUrl(spec, ws, prompt));
          return { ok: true, message: prompt ? '已请求 Codex 打开项目并预填接手指令' : '已请求 Codex 打开工作区', workspaceRequested: true, draftPrepared: !!prompt };
        }
        if (ws && codexDesktopEntry(spec)) {
          // 官方 CLI 的 app [PATH] 会打开桌面工作区；参数直接传递，不拼接 shell。
          await new Promise((resolve, reject) => execFile(process.execPath, [codexDesktopEntry(spec), 'app', ws], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024 }, (err) => err ? reject(new Error('Codex 工作区未能打开，请手动选择项目后粘贴指令')) : resolve()));
          return { ok: true, message: '已请求 Codex 打开工作区', workspaceRequested: true };
        }
        // 仅使用用户明确配置的脚本，默认走 Windows 注册的桌面入口。
        if (spec.script && exists(spec.script)) await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', spec.script, '-NoKill'], { windowsHide: true });
        else await run('explorer.exe', ['shell:AppsFolder\\' + spec.target]);
        return { ok: true, message: '正在打开 ' + spec.label };
      case 'wsl-cli': {
        const distro = spec.distro || '';
        const cmd = require('./handoff-return').cliResume(characterId, spec, session) || spec.command;
        const cwd = ws ? toWslPath(ws) : (spec.cwd || '~');
        const wt = path.join(HOME, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'wt.exe');
        // 登录 shell 里跑，保证 PATH（nvm/.local/bin）和 settings.json 生效
        const bash = [...(distro ? ['-d', distro] : []), '--cd', cwd, '--', 'bash', '-lic', `${cmd}; exec bash`];
        if (exists(wt)) await run(wt, ['-w', 'new', 'wsl.exe', ...bash]);
        else await run('cmd.exe', ['/c', 'start', '""', 'wsl.exe', ...bash]);
        return { ok: true, message: '正在打开 ' + spec.label };
      }
      case 'cli': {
        const wt = path.join(HOME, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'wt.exe');
        const line = require('./handoff-return').cliResume(characterId, spec, session) || spec.command || '';
        if (exists(wt)) await run(wt, ['-w', 'new', ...(ws ? ['-d', ws] : []), 'cmd.exe', '/k', line]);
        else await run('cmd.exe', ['/c', 'start', '""', ...(ws ? ['/d', ws] : []), 'cmd.exe', '/k', line]);
        return { ok: true, message: '正在打开 ' + spec.label };
      }
      case 'url':
        await shell.openExternal(spec.target);
        return { ok: true, message: '正在打开 ' + spec.label };
      default:
        return { ok: false, message: '未知启动类型 ' + spec.kind };
    }
  } catch (e) { return { ok: false, message: e.message }; }
}

module.exports = { launch, resolve, defaults, isRunning, agentSpec, discover, claudeSpec, claudeWinSpec, supportsWorkspace, codexDraftUrl, menuAvailable, FIND_PS };
