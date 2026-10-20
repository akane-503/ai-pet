'use strict';
// 打开当前角色对应的 agent 工具：桌面应用（已开则不重复开，只置前）、CLI（每次开新终端）、网页
const { spawn, execFile } = require('child_process');
const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const winsnap = require('./winsnap');

const HOME = process.env.USERPROFILE || '';
const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };

// 内置角色的桌面版：本机搜得到 exe 就开应用，否则开网页
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const APPS = {
  deepseek: { name: 'DSH Desktop', process: 'DSH Desktop.exe', title: 'DeepSeek Harness|DSH Desktop', url: 'https://chat.deepseek.com', web: 'DeepSeek' },
  zcode: { name: 'ZCode', process: 'ZCode.exe', title: '^ZCode', url: 'https://chat.z.ai', web: 'Z.ai' },
  gemini: { name: 'Gemini 桌面版', process: 'Gemini.exe', title: '^(Google\\s+)?Gemini(\\b|$)', paths: [path.join(LOCAL, 'Google', 'Gemini', 'Gemini.exe')], url: 'https://gemini.google.com', web: 'Gemini' },
  qwen: { name: '千问', process: 'Qwen.exe', url: 'https://chat.qwen.ai', web: '千问' },
  kimi: { name: 'Kimi', process: 'Kimi.exe', url: 'https://www.kimi.com', web: 'Kimi' },
  grok: { name: 'Grok', process: 'Grok.exe', url: 'https://grok.com', web: 'Grok' },
  seed: { name: '豆包', process: 'Doubao.exe', url: 'https://www.doubao.com', web: '豆包' },
};

const CLAUDE_APP = { name: 'Claude 桌面版', process: 'Claude.exe', title: '^Claude$', url: 'https://claude.ai', web: 'Claude' };

// Claude：Claude Code 数据在 WSL 里 → WSL 终端；Windows 装了 CLI → 本机终端；否则桌面版 / 网页
function claudeSpec(dirs) {
  const wslDir = dirs.find((d) => /^\\\\wsl(\.localhost|\$)\\/i.test(d) && exists(d));
  if (wslDir) return { kind: 'wsl-cli', label: 'Claude Code (WSL)', distro: wslDir.split('\\')[3] || '', command: 'claude', cwd: '~' };
  const cli = [path.join(HOME, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')].find(exists);
  if (cli) return { kind: 'cli', label: 'Claude Code', command: 'claude' };
  return agentSpec(CLAUDE_APP);
}

// 每个角色的默认启动方式；用户可在设置里覆盖（config.launch[characterId]）
function defaults() {
  return {
    ...Object.fromEntries(Object.entries(APPS).map(([id, a]) => [id, agentSpec(a)])),
    codex: { kind: 'store', label: 'GPT / Codex 桌面版', target: 'OpenAI.Codex_2p2nqsd0c76g0!App', match: '^(Codex|ChatGPT)(\\b|$)', process: 'ChatGPT.exe', fallbackUrl: 'https://chatgpt.com/codex' },
    claude: claudeSpec(require('./activity').detectClaudeDirs({})),
  };
}

const exeNames = (a) => String(a.process || '').split('|').map((x) => x.trim()).filter(Boolean);
const found = {}; // exe 小写名 -> 搜到的完整路径
const tried = new Set(); // 本次运行已搜过的名字，搜不到也不重复跑
let pending = Promise.resolve(found); // 正在跑的搜索，后来的调用等它结束

// 一次 PowerShell 找 exe：正在运行的进程 > 卸载注册表 > App Paths > 开始菜单/桌面快捷方式 > 各盘两层目录
const FIND_PS = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$names=@(__NAMES__); $hits=@{}
function Add($p){ if(!$p){return}; $p=($p -replace ',-?\\d+$','').Trim().Trim('"'); $n=[IO.Path]::GetFileName($p).ToLower()
  if($names -contains $n -and !$hits[$n] -and (Test-Path -LiteralPath $p)){ $hits[$n]=$p } }
Get-Process -EA 0 | % { Add $_.Path }
$u='Software\\Microsoft\\Windows\\CurrentVersion'
Get-ItemProperty "HKCU:\\$u\\Uninstall\\*","HKLM:\\$u\\Uninstall\\*","HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*" -EA 0 | % {
  Add $_.DisplayIcon; $l=$_.InstallLocation; if($l){ foreach($n in $names){ Add (Join-Path $l.Trim('"') $n) } } }
Get-ItemProperty "HKCU:\\$u\\App Paths\\*","HKLM:\\$u\\App Paths\\*" -EA 0 | % { Add $_.'(default)' }
$sh=New-Object -ComObject WScript.Shell
Get-ChildItem "$env:APPDATA\\Microsoft\\Windows\\Start Menu","$env:ProgramData\\Microsoft\\Windows\\Start Menu","$env:USERPROFILE\\Desktop","$env:PUBLIC\\Desktop" -Recurse -Filter *.lnk -EA 0 | % { Add $sh.CreateShortcut($_.FullName).TargetPath }
foreach($n in $names){ if(!$hits[$n]){ foreach($d in (Get-PSDrive -PSProvider FileSystem).Root){ Resolve-Path "$d*\\$n","$d*\\*\\$n" -EA 0 | % { Add $_.Path } } } }
$hits | ConvertTo-Json -Compress`;

// 后台搜一次，结果进 found；agentSpec 同步读缓存
function discover(agents = []) {
  const names = [...new Set([...agents, ...Object.values(APPS), CLAUDE_APP].flatMap(exeNames).map((x) => x.toLowerCase()))].filter((n) => !tried.has(n));
  names.forEach((n) => tried.add(n));
  if (!names.length || process.platform !== 'win32') return pending;
  const script = FIND_PS.replace('__NAMES__', names.map((n) => `'${n.replace(/'/g, "''")}'`).join(','));
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
  const target = a.target || exes.map((exe) => found[exe.toLowerCase()]).find(exists) || (a.paths || []).find(exists)
    || exes.flatMap((exe) => dirs.map((d) => path.join(d, exe.replace(/\.exe$/i, ''), exe))).find(exists);
  if (target) return { kind: 'app', label: a.name, target, process: path.basename(target), match: a.title || '', fallbackUrl: a.url || null };
  return a.url ? { kind: 'url', label: (a.web || a.name) + ' 网页', target: a.url } : null;
}

function resolve(characterId, userLaunch) {
  const d = defaults()[characterId];
  const u = userLaunch && userLaunch[characterId];
  if (u && u.kind) {
    const spec = { ...d, ...u };
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

function focus(hwnd) { try { winsnap.focusWindow(hwnd); } catch (_) { /* */ } }

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// 返回 { ok, message }
async function launch(characterId, userLaunch) {
  const spec = resolve(characterId, userLaunch);
  if (!spec) return { ok: false, message: '这个角色还没配置启动方式' };
  const running = isRunning(spec);
  if (running && (spec.kind === 'app' || spec.kind === 'store')) {
    if (running.window) { focus(running.window.hwnd); return { ok: true, message: `${spec.label} 已经开着啦`, already: true }; }
  }
  try {
    switch (spec.kind) {
      case 'app':
        if (!exists(spec.target)) { if (spec.fallbackUrl) { await shell.openExternal(spec.fallbackUrl); return { ok: true, message: '本地没装，打开网页版' }; } return { ok: false, message: '找不到 ' + spec.target }; }
        await run(spec.target, spec.args || [], { cwd: path.dirname(spec.target) });
        return { ok: true, message: '正在打开 ' + spec.label };
      case 'store':
        // 仅使用用户明确配置的脚本，默认走 Windows 注册的桌面入口。
        if (spec.script && exists(spec.script)) await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', spec.script, '-NoKill'], { windowsHide: true });
        else await run('explorer.exe', ['shell:AppsFolder\\' + spec.target]);
        return { ok: true, message: '正在打开 ' + spec.label };
      case 'wsl-cli': {
        const distro = spec.distro || '';
        const cmd = spec.command || 'claude';
        const cwd = spec.cwd || '~';
        const wt = path.join(HOME, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'wt.exe');
        // 登录 shell 里跑，保证 PATH（nvm/.local/bin）和 settings.json 生效
        const bash = [...(distro ? ['-d', distro] : []), '--cd', cwd, '--', 'bash', '-lic', `${cmd}; exec bash`];
        if (exists(wt)) await run(wt, ['-w', 'new', 'wsl.exe', ...bash]);
        else await run('cmd.exe', ['/c', 'start', '""', 'wsl.exe', ...bash]);
        return { ok: true, message: '正在打开 ' + spec.label };
      }
      case 'cli': {
        const wt = path.join(HOME, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'wt.exe');
        const line = spec.command || '';
        if (exists(wt)) await run(wt, ['-w', 'new', 'cmd.exe', '/k', line]);
        else await run('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', line]);
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

module.exports = { launch, resolve, defaults, isRunning, agentSpec, discover, claudeSpec, FIND_PS };
