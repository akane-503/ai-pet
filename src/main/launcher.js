'use strict';
// 打开当前角色对应的 agent 工具：桌面应用（已开则不重复开，只置前）、CLI（每次开新终端）、网页
const { spawn, execFile } = require('child_process');
const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const winsnap = require('./winsnap');

const HOME = process.env.USERPROFILE || '';
const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };

// 每个角色的默认启动方式；用户可在设置里覆盖（config.launch[characterId]）
function defaults() {
  const localApps = path.join(HOME, 'AppData', 'Local', 'Programs');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const zcodeTarget = [path.join(programFiles, 'ZCode', 'ZCode.exe'), path.join(localApps, 'ZCode', 'ZCode.exe')].find(exists) || path.join(programFiles, 'ZCode', 'ZCode.exe');
  const dshTarget = [path.join(localApps, 'DSH Desktop', 'DSH Desktop.exe'), path.join(programFiles, 'DSH Desktop', 'DSH Desktop.exe')].find(exists) || path.join(localApps, 'DSH Desktop', 'DSH Desktop.exe');
  return {
    deepseek: { kind: 'app', label: 'DSH Desktop', target: dshTarget, match: 'DeepSeek Harness|DSH Desktop', process: 'DSH Desktop.exe', fallbackUrl: 'https://chat.deepseek.com' },
    codex: { kind: 'store', label: 'Codex 桌面版', target: 'OpenAI.Codex_2p2nqsd0c76g0!App', match: '^(Codex|ChatGPT)(\\b|$)', process: 'ChatGPT.exe', script: path.join(HOME, 'bin', 'codex-open.ps1'), fallbackUrl: 'https://chatgpt.com/codex' },
    claude: { kind: 'wsl-cli', label: 'Claude Code (WSL)', distro: '', command: 'claude', cwd: '~' },
    zcode: { kind: 'app', label: 'ZCode', target: zcodeTarget, match: '^ZCode', process: 'ZCode.exe' },
    gemini: { kind: 'url', label: 'Gemini 网页', target: 'https://gemini.google.com' },
    qwen: { kind: 'url', label: '千问网页', target: 'https://chat.qwen.ai' },
    kimi: { kind: 'url', label: 'Kimi 网页', target: 'https://www.kimi.com' },
    grok: { kind: 'url', label: 'Grok 网页', target: 'https://grok.com' },
    seed: { kind: 'url', label: '豆包网页', target: 'https://www.doubao.com' },
  };
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

const { execFileSync } = require('child_process');
function processRunning(name) {
  if (!name) return false;
  try { const out = execFileSync('tasklist.exe', ['/fi', `imagename eq ${name}`, '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }); return /^"/.test(out.trim()); } catch (_) { return false; }
}
// 返回 { window? , process? }；都没有则 null
function isRunning(spec) {
  let win = null;
  if (spec.match || spec.process) { try { win = winsnap.findWindow(spec.match || '.', spec.process); } catch (_) { /* */ } }
  if (win) return { window: win };
  if (spec.process && processRunning(spec.process)) return { process: spec.process };
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
    // 只有进程没有窗口：有专用启动脚本就交给脚本判定/修复，否则视为已开
    if (!(spec.script && exists(spec.script))) return { ok: true, message: `${spec.label} 已经开着啦`, already: true };
  }
  try {
    switch (spec.kind) {
      case 'app':
        if (!exists(spec.target)) { if (spec.fallbackUrl) { await shell.openExternal(spec.fallbackUrl); return { ok: true, message: '本地没装，打开网页版' }; } return { ok: false, message: '找不到 ' + spec.target }; }
        await run(spec.target, spec.args || [], { cwd: path.dirname(spec.target) });
        return { ok: true, message: '正在打开 ' + spec.label };
      case 'store':
        // 有用户自己的可靠启动脚本（处理 Codex 黑屏竞态）就优先用
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

module.exports = { launch, resolve, defaults, isRunning };
