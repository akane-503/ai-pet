'use strict';
// 检测“当前在用哪个 agent”：看各家本地会话目录最近写入时间
const fs = require('fs');
const path = require('path');

function statMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; } }

function newestInDir(dir, { depth = 1, filter = null, limitDirs = 6 } = {}) {
  let best = 0;
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = [];
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth > 0) dirs.push(fp); }
      else if (!filter || filter(e.name)) best = Math.max(best, statMtime(fp));
    }
    if (depth > 0 && dirs.length) {
      const scored = dirs.map((d) => ({ d, m: statMtime(d) })).sort((a, b) => b.m - a.m).slice(0, limitDirs);
      for (const { d } of scored) best = Math.max(best, newestInDir(d, { depth: depth - 1, filter, limitDirs }));
    }
  } catch (_) { /* ignore */ }
  return best;
}

function codexActivity(codexDir) {
  const root = path.join(codexDir, 'sessions');
  let best = 0;
  try {
    const years = fs.readdirSync(root).filter((x) => /^\d{4}$/.test(x)).sort().slice(-1);
    for (const y of years) {
      const months = fs.readdirSync(path.join(root, y)).filter((x) => /^\d{2}$/.test(x)).sort().slice(-1);
      for (const m of months) {
        const days = fs.readdirSync(path.join(root, y, m)).filter((x) => /^\d{2}$/.test(x)).sort().slice(-2);
        for (const d of days) best = Math.max(best, newestInDir(path.join(root, y, m, d), { depth: 0, filter: (n) => n.endsWith('.jsonl') }));
      }
    }
  } catch (_) { /* */ }
  best = Math.max(best, statMtime(path.join(codexDir, 'history.jsonl')));
  return best;
}

function claudeActivity(claudeDir) {
  if (!claudeDir) return 0;
  return Math.max(newestInDir(path.join(claudeDir, 'projects'), { depth: 1, filter: (n) => n.endsWith('.jsonl'), limitDirs: 5 }), statMtime(path.join(claudeDir, 'history.jsonl')));
}

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } }

function detectClaudeDirs(cfg) {
  const out = [];
  if (cfg.claudeDir) out.push(cfg.claudeDir);
  const home = process.env.USERPROFILE || '';
  if (home) out.push(path.join(home, '.claude'));
  try {
    const cc = JSON.parse(readText(path.join(home, '.cc-switch', 'settings.json')));
    if (cc && cc.claudeConfigDir) out.push(cc.claudeConfigDir);
  } catch (_) { /* */ }
  return Array.from(new Set(out.filter(Boolean)));
}

function detect(cfg, providers) {
  const now = Date.now();
  const windowMs = (Number(cfg.windowMin) || 15) * 60000;
  const det = {};
  const codexP = providers.find((p) => p.type === 'codex' && p.enabled);
  const codexDir = (codexP && codexP.codexHome) || cfg.codexDir;
  if (codexDir) {
    const t = codexActivity(codexDir);
    // Codex 如果被路由到 DeepSeek（旧大肥鱼桥接），算 DeepSeek 活跃
    const key = codexRoute(cfg, providers);
    det[key] = Math.max(det[key] || 0, t);
  }
  let claudeT = 0;
  for (const d of detectClaudeDirs(cfg)) claudeT = Math.max(claudeT, claudeActivity(d));
  if (claudeT) {
    // Claude Code 当前接的是谁：看 settings.json 的 BASE_URL
    const key = claudeRoute(cfg);
    det[key] = Math.max(det[key] || 0, claudeT);
  }
  const zcodeDir = cfg.zcodeDir || path.join(process.env.USERPROFILE || '', '.zcode');
  if (zcodeDir) {
    let t = 0;
    for (const sub of [['cli', 'rollout'], ['v2', 'checkpoints'], ['workspace']]) t = Math.max(t, newestInDir(path.join(zcodeDir, ...sub), { depth: 2, limitDirs: 4 }));
    if (t) det.zcode = Math.max(det.zcode || 0, t);
  }
  if (cfg.geminiDir) { const t = newestInDir(path.join(cfg.geminiDir, 'tmp'), { depth: 2, limitDirs: 4 }); if (t) det.gemini = Math.max(det.gemini || 0, t); }
  if (cfg.qwenDir) { const t = newestInDir(path.join(cfg.qwenDir, 'projects'), { depth: 1, limitDirs: 4 }); if (t) det.qwen = Math.max(det.qwen || 0, t); }
  let active = null, at = 0;
  for (const [k, t] of Object.entries(det)) { if (t > at) { at = t; active = k; } }
  if (!active || now - at > windowMs) return { active: null, at, details: det };
  return { active, at, details: det };
}

// 窗口标题 → 角色。本地 agent 只认应用主窗口标题；网页类只认浏览器标签页标题以服务名开头的情况
const BROWSER_RE = /(Google Chrome|Microsoft​? Edge|Mozilla Firefox|Chromium|Opera|Vivaldi|Brave|哔哩哔哩|bilibili)/i;
// Claude Code 终端标题：空闲 "✳ Claude Code"，干活时 "◑ <任务摘要>"（开头是转圈符号）
const SPINNER_RE = /^[✳✶✷✸✹✺✻✼✽◐◑◒◓●○◉◌◍⏺⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏·]\s/;
const NATIVE_RULES = [
  [/DeepSeek Harness|^DSH Desktop/i, 'deepseek'],
  [/^ZCode(\s*[-–—|]|$)/i, 'zcode'],
  [/Claude Code/i, 'claude'],
  [/^(Codex|ChatGPT)(\s*[-–—|]|$)/i, 'codex'],
];
const WEB_RULES = [
  [/^Gemini\b/i, 'gemini'], [/^Kimi\b/i, 'kimi'], [/^(Qwen|千问|通义)/i, 'qwen'], [/^Grok\b/i, 'grok'], [/^(豆包|Doubao)/i, 'seed'],
  [/^(DeepSeek)\b/i, 'deepseek'], [/^(ChatGPT|Codex)\b/i, 'codex'], [/^Claude\b/i, 'claude'], [/^(智谱|GLM|Z\.ai|ZCode)\b/i, 'zcode'],
];
const WINDOW_RULES = [...NATIVE_RULES, ...WEB_RULES];
function characterForTitle(title) {
  if (!title) return null;
  const t = String(title).trim();
  if (BROWSER_RE.test(t)) { for (const [re, id] of WEB_RULES) if (re.test(t)) return id; return null; }
  for (const [re, id] of NATIVE_RULES) if (re.test(t)) return id;
  return null;
}
// 原生应用看进程名，标题可随会话变化；转圈标题只在终端中判定。
function characterForWindow(win) {
  if (!win) return null;
  const exe = String(win.processName || '').toLowerCase();
  const native = { 'chatgpt.exe': 'codex', 'codex.exe': 'codex', 'dsh desktop.exe': 'deepseek', 'zcode.exe': 'zcode', 'claude.exe': 'claude' };
  if (native[exe]) return native[exe];
  if (/^(chrome|msedge|firefox|brave|opera|vivaldi|chromium)\.exe$/.test(exe) || BROWSER_RE.test(win.title || '')) {
    for (const [re, id] of WEB_RULES) if (re.test(String(win.title || '').trim())) return id;
    return null;
  }
  const terminal = /^(windowsterminal|openconsole|conhost|mintty|wezterm-gui)\.exe$/.test(exe) || /CASCADIA|ConsoleWindowClass|mintty/i.test(win.cls || '');
  if (terminal && SPINNER_RE.test(String(win.title || '').trim())) return 'claude';
  return characterForTitle(win.title);
}
function codexRoute(cfg, providers = []) {
  const p = providers.find((x) => x.type === 'codex' && x.enabled);
  const dir = (p && p.codexHome) || cfg.codexDir;
  if (!dir) return 'codex';
  const mode = readText(path.join(dir, 'big-fish-pet', 'conversation-mode.txt')).trim();
  const match = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(readText(path.join(dir, 'config.toml')));
  const name = (match ? match[1] : '').toLowerCase();
  if (mode === 'deepseek' || name.includes('deepseek')) return 'deepseek';
  if (/zhipu|glm|zcode/.test(name)) return 'zcode';
  return 'codex';
}
function routeForWindow(win, cfg, providers = []) {
  const key = characterForWindow(win);
  // 网页的服务名就是角色，不能被本地 CLI 的路由配置覆盖。
  const browser = /^(chrome|msedge|firefox|brave|opera|vivaldi|chromium)\.exe$/i.test(win && win.processName || '') || BROWSER_RE.test(win && win.title || '');
  if (browser) return key;
  return key === 'claude' ? claudeRoute(cfg) : key === 'codex' ? codexRoute(cfg, providers) : key;
}
// Claude Code 实际接的是谁（看 settings.json 的 BASE_URL）
function claudeRoute(cfg) {
  const files = [...(cfg.claudeSettingsPath ? [cfg.claudeSettingsPath] : []), ...detectClaudeDirs(cfg).map((d) => path.join(d, 'settings.json'))];
  for (const file of files) {
    const st = readText(file);
    const m = /"ANTHROPIC_BASE_URL"\s*:\s*"([^"]+)"/.exec(st);
    if (m) { const u = m[1].toLowerCase(); if (u.includes('bigmodel') || u.includes('z.ai')) return 'zcode'; if (u.includes('deepseek')) return 'deepseek'; return 'claude'; }
  }
  return 'claude';
}
// 前台和用户最近的选择优先，防止后台日志/定时任务抢角色。
function selectCharacter({ appearance, foreground = {}, recent = {}, activity = {}, now = Date.now(), charOf = (k) => k }) {
  if (appearance.character && appearance.character !== 'auto') return { character: appearance.character, why: '手动指定' };
  if (foreground.character && now - foreground.at < 3000) return { character: foreground.character, why: `前台是 ${foreground.character}` };
  if (recent.character && now - recent.at < 10000) return { character: recent.character, why: `最近${recent.reason === 'launch' ? '打开' : '用过'} ${recent.character}` };
  const working = Object.entries(activity.details || {}).filter(([, t]) => now - t >= 0 && now - t < 90000).sort((a, b) => b[1] - a[1]);
  for (const [key] of working) { const character = charOf(key); if (character) return { character, why: `${key} 正在干活` }; }
  if (recent.character && now - recent.at < 10 * 60000) return { character: recent.character, why: `最近用过 ${recent.character}` };
  if (activity.active) { const character = charOf(activity.active); if (character) return { character, why: `最近活跃 ${activity.active}` }; }
  return { character: appearance.favorite || 'deepseek', why: '空闲，回落角色' };
}
module.exports = { detect, detectClaudeDirs, characterForTitle, characterForWindow, routeForWindow, codexRoute, claudeRoute, selectCharacter, WINDOW_RULES };
