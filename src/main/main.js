'use strict';
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, Notification, shell, nativeImage, powerMonitor, dialog, clipboard, globalShortcut, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const { JsonStore, defaultConfig, defaultState, deepMerge, AGENT_PRESETS } = require('./config');
const providers = require('./providers');
const notifyEngine = require('./notify');
const activity = require('./activity');
const importers = require('./importers');
const news = require('./news');
const winsnap = require('./winsnap');
const launcher = require('./launcher');
const quipsGen = require('./quips');
const handoff = require('./handoff');
const handoffReturn = require('./handoff-return');
const handoffEstimate = require('./handoff-estimate');
const handoffApi = require('./handoff-api');
const cursorModel = require('./cursor-model');
const http = require('./http');
const desktopDraft = require('./desktop-draft');
const geometry = require('../shared/geometry');
const EDITION = require('./edition');
const QUOTA_ONLY = EDITION.quotaOnly;

const ROOT = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'assets');
const IS_WIN = process.platform === 'win32';
const dataDirArg = process.argv.find((arg) => arg.startsWith('--data-dir='));
if (QUOTA_ONLY) { app.setName(EDITION.name); app.setPath('userData', path.join(app.getPath('appData'), EDITION.name)); }
if (dataDirArg) app.setPath('userData', path.resolve(dataDirArg.slice('--data-dir='.length)));

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if (IS_WIN) app.setAppUserModelId(app.isPackaged ? EDITION.id : process.execPath);

const userData = app.getPath('userData');
const config = new JsonStore(path.join(userData, 'config.json'), defaultConfig);
const state = new JsonStore(path.join(userData, 'state.json'), defaultState);
config.load(); state.load();
// Cursor 是多模型工具，没有单独的 cursor 立绘：旧配置里指向不存在的 cursor 角色，统一回落 Claude 娘；
// 真正的角色由 cursor-model 按当前模型决定（见 mascotOf）。
try {
  let fixed = false;
  for (const p of config.data.providers || []) {
    if (p && p.type === 'cursor' && (!p.character || p.character === 'cursor')) { p.character = 'claude'; fixed = true; }
  }
  if (fixed) config.save();
} catch (_) { /* 配置还没成形就不迁移 */ }
// Kimi 桌面版接入：旧配置没有 kimi 数据源，补默认项；本机已有 Kimi Work 数据就直接启用
try {
  const ps = config.data.providers || [];
  if (!ps.some((p) => p && p.type === 'kimi')) {
    const d = defaultConfig().providers.find((p) => p.type === 'kimi');
    const dir = d.agentDir || require('./providers/kimi').AGENT_DIR;
    d.enabled = fs.existsSync(dir);
    ps.push(d);
    config.save();
  }
} catch (_) { /* 配置还没成形就不迁移 */ }
// 安装器把填的 DeepSeek Key 留在 install-key.txt（NSIS 不好改 JSON），首次启动并入配置后删掉
try {
  const seed = path.join(userData, 'install-key.txt');
  const key = fs.readFileSync(seed, 'utf8').replace(/^\uFEFF/, '').trim();
  fs.unlinkSync(seed);
  // Key 只会是可见 ASCII；NSIS 按 ANSI 写中文会变乱码，进了请求头直接报 ByteString 错
  if (/^sk-[\x21-\x7e]+$/.test(key)) { Object.assign(config.data.quips, { apiKey: key, enabled: true }); config.save(); }
} catch (_) { /* 没有就是没填 */ }

// colors: [描边/主色, 正文, 提示]
const CHARACTERS = [
  { id: 'deepseek', name: '鲸鱼娘 · DeepSeek', keys: ['deepseek'], colors: ['#203170', '#536ba9', '#7b8cb3'] },
  { id: 'codex', name: '龙娘 · GPT / Codex', keys: ['codex', 'openai', 'gpt'], colors: ['#66547d', '#89739f', '#a294b4'] },
  { id: 'claude', name: 'Claude 娘', keys: ['claude', 'anthropic'], colors: ['#8a3d12', '#bc602f', '#b88a72'] },
  { id: 'zcode', name: 'Zcode 黑狐娘 · 智谱 GLM', keys: ['glm', 'zhipu', 'zcode'], colors: ['#363343', '#5a556a', '#8f899c'] },
  { id: 'gemini', name: '哈基米 · Gemini', keys: ['gemini'], colors: ['#6656ac', '#8670c6', '#a494bc'] },
  { id: 'qwen', name: '千问娘 · Qwen', keys: ['qwen', 'dashscope'], colors: ['#4f5e9d', '#7785b7', '#95a0bb'] },
  { id: 'kimi', name: 'Kimi 娘 · 月之暗面', keys: ['kimi', 'moonshot'], colors: ['#625974', '#91869f', '#a79aaf'] },
  { id: 'grok', name: 'Grok 娘 · xAI', keys: ['grok', 'xai'], colors: ['#6f4b35', '#957045', '#a28c74'] },
  { id: 'seed', name: '豆包（经典）', keys: ['doubao', 'seed', 'volc'], colors: ['#4a3732', '#795c52', '#a18a7d'] },
];
function agents() { return (config.data.agents || []).filter((a) => a && a.id && !CHARACTERS.some((c) => c.id === a.id)); }
function allCharacters() {
  return [...CHARACTERS, ...agents().map((a) => ({ id: a.id, name: a.name || a.id, keys: [a.id], look: a.look, colors: (CHARACTERS.find((c) => c.id === a.look) || CHARACTERS[0]).colors }))];
}
function agentLaunch() { return Object.fromEntries(agents().map((a) => [a.id, launcher.agentSpec(a)]).filter(([, v]) => v)); }
function launchCfg() { return { ...agentLaunch(), ...config.data.launch }; }
let recent = { character: null, at: 0, reason: '' };   // 最近一次“打开/聚焦”的 agent
let lastAgentWin = null; // 最近在前台的 AI 窗口，一键交接从它交出
let handoffJob = null;    // 进行中的一键交接
let lastHandoffJob = null;
let handoffSerial = 0;
let foreground = { character: null, at: 0 };           // 当前前台窗口对应的 agent
let knownAgentWins = null;                              // 上次看到的 agent 窗口 hwnd -> 角色
function charOf(key) {
  const p = enabledProviders().find((x) => x.type === key || (key === 'zcode' && x.type === 'zhipu'));
  if (p && p.character) return p.character;
  const c = allCharacters().find((x) => x.keys.includes(key) || x.id === key);
  return c ? c.id : null;
}
// Cursor 一个窗口里可能换着模型用：角色跟着 state.vscdb 里当前 composer 的模型走。
// 读不到模型（Auto / 旧版 / 没装）时回落到 Cursor 预置的 look（Claude）。
function cursorDbPath() {
  const p = (config.data.providers || []).find((x) => x.type === 'cursor' && x.dbPath);
  return p ? p.dbPath : undefined;
}
function cursorInfo() { return cursorModel.info(cursorDbPath()); }
function mascotOf(key) {
  if (key === 'cursor') {
    const info = cursorInfo();
    if (info && info.character) return info.character;
    const p = (config.data.providers || []).find((x) => x.type === 'cursor');
    if (p && p.character && p.character !== 'cursor' && allCharacters().some((c) => c.id === p.character)) return p.character;
    return 'claude';
  }
  return charOf(key) || key;
}
function characterImages() {
  const out = {};
  try { for (const f of fs.readdirSync(path.join(ASSETS, 'characters'))) { const m = /^([a-z0-9_-]+)\.(png|webp|gif)$/i.exec(f); if (m) out[m[1]] = path.join(ASSETS, 'characters', f).replace(/\\/g, '/'); } } catch (_) { /* */ }
  // 自定义 agent 没有立绘就借 look 角色的（含摸头动图）
  for (const a of agents()) {
    if (a.image && fs.existsSync(a.image)) out[a.id] = String(a.image).replace(/\\/g, '/');
    const lookImg = { '': out[a.look] || out[a.look + '-classic'], 'rub-': out[a.look === 'seed' ? 'nailong-seed' : 'rub-' + a.look], 'headpat-': out['headpat-' + a.look] };
    for (const [pre, src] of Object.entries(lookImg)) if (!out[pre + a.id] && src) out[pre + a.id] = src;
  }
  for (const [id, fp] of Object.entries((config.data.appearance && config.data.appearance.customImages) || {})) { if (fp && fs.existsSync(fp)) out[id] = String(fp).replace(/\\/g, '/'); }
  return out;
}

let petWin = null, settingsWin = null, panelWin = null, tray = null;
let petReady = false, pendingNotices = [];
let boxReceived = false;
let petBox = { x: 0, y: 0, w: 200, h: 240 };
let drag = null;
let attach = null; // { hwnd, dx, dy, mode }
let flipped = false; // 当前是否贴左镜像
let pendingSettle = null; // 等渲染层完成转身、上报新框后再落位
let lastActivity = { active: null, at: 0, details: {} };
let refreshTimer = null, activityTimer = null, attachTimer = null, animTimer = null;
let lastModelsCheck = 0, lastRssCheck = 0, refreshing = false;
let currentCharacter = null;
let quitting = false;

// ---------- 工具 ----------
function log(...a) {
  const line = [new Date().toISOString().slice(11, 19), ...a].join(' ');
  console.log(line);
  try {
    const f = path.join(userData, 'app.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, f + '.old'); // 只留当前 + 上一份，各 ≤1MB
    fs.appendFileSync(f, new Date().toISOString().slice(0, 10) + ' ' + line + '\n');
  } catch (_) { /* 日志写不进去不影响运行 */ }
}
function winSizeForScale(scale) { return geometry.windowSize(scale); }
let desktopAreas = new Map();
let areaMotion = null;
function areaFor(display) { return desktopAreas.get(display.id) || display.workArea; }
function updateScreenAreas() {
  const displays = screen.getAllDisplays();
  const nativeBars = winsnap.taskbars();
  const bars = nativeBars && nativeBars.map(bar => {
    const m = bar.monitor;
    const center = screen.screenToDipPoint({ x: Math.round((m.left + m.right) / 2), y: Math.round((m.top + m.bottom) / 2) });
    const d = screen.getDisplayNearestPoint(center), sf = d.scaleFactor;
    return { ...bar, displayId: d.id, rect: {
      left: d.bounds.x + (bar.rect.left - m.left) / sf, top: d.bounds.y + (bar.rect.top - m.top) / sf,
      right: d.bounds.x + (bar.rect.right - m.left) / sf, bottom: d.bounds.y + (bar.rect.bottom - m.top) / sf,
    } };
  });
  const next = new Map(displays.map(d => [d.id, geometry.workArea(d, bars)]));
  const changed = JSON.stringify([...next]) !== JSON.stringify([...desktopAreas]);
  desktopAreas = next;
  if (!changed || !petWin || !boxReceived || drag || attach || pendingSettle) return;
  const rect = petRect(), area = areaFor(displayFor(rect)), sn = config.data.layout.snapped || {};
  const p = geometry.clampPosition(rect, area);
  if (sn.h === 'left') p.x = area.x;
  if (sn.h === 'right') p.x = area.x + area.width - rect.width;
  if (sn.v === 'top') p.y = area.y;
  if (sn.v === 'bottom') p.y = area.y + area.height - rect.height;
  const x = Math.round(p.x - petBox.x), y = Math.round(p.y - petBox.y);
  animateTo(x, y, () => {
    Object.assign(config.data.layout, { x, y }); config.saveSoon();
  }, { desktopArea: true });
}
function enabledProviders() { return (config.data.providers || []).filter((p) => p && p.enabled); }
function providerById(id) { return (config.data.providers || []).find((p) => p.id === id); }

function characterSelection() { return activity.selectCharacter({ appearance: config.data.appearance, foreground, recent, activity: lastActivity, charOf: mascotOf }); }
function resolveCharacter() { return characterSelection().character; }
// 正在消耗额度的数据源：最近窗口期内活跃的 agent → provider（最近的在前），再加当前角色对应的
function activeProviderIds() {
  const now = Date.now(); const windowMs = 90000;
  const det = Object.entries((lastActivity && lastActivity.details) || {}).filter(([, t]) => now - t < windowMs).sort((a, b) => b[1] - a[1]);
  const ps = enabledProviders(); const out = [];
  const add = (p) => { if (p && !out.includes(p.id)) out.push(p.id); };
  const forChar = (c) => { if (c === 'deepseek') ps.filter((p) => p.type === 'deepseek').forEach(add); else if (c === 'codex') ps.filter((p) => p.type === 'codex').forEach(add); else if (c === 'zcode') ps.filter((p) => p.type === 'zhipu').forEach(add); else if (c === 'claude') ps.filter((p) => p.type === 'claude-oauth' || p.type === 'newapi' || p.type === 'openai').forEach(add); else if (c === 'gemini') ps.filter((p) => p.type === 'gemini').forEach(add); else ps.filter((p) => p.character === c).forEach(add); };
  // 当前角色对应的排最前，然后是最近打开的，再是窗口期内活跃的
  // Cursor 的额度属于 Cursor 本身，不跟模型娘绑定：正在用它就把它排最前
  if (foreground && foreground.tool === 'cursor') ps.filter((p) => p.type === 'cursor').forEach(add);
  const cur = currentCharacter || resolveCharacter();
  forChar(cur);
  for (const [k] of det) forChar(mascotOf(k));
  return out;
}
// ---------- 台词生成（DeepSeek API） ----------
let quipsBusy = false;
function codexHome() { const p = (config.data.providers || []).find((x) => x.type === 'codex' && x.codexHome); return (p && p.codexHome) || (config.data.activity || {}).codexDir; }
function quipsKey() { const q = config.data.quips || {}; if (q.apiKey) return q.apiKey; const ds = (config.data.providers || []).find((p) => p.type === 'deepseek' && p.apiKey); return ds ? ds.apiKey : ''; }
async function refreshQuips({ force = false } = {}) {
  if (QUOTA_ONLY) return { ok: false, message: 'B 版仅查询额度' };
  const q = config.data.quips || {};
  if (quipsBusy) return { ok: false, message: '正在生成中' };
  if (!q.enabled && !force) return { ok: false, message: '已关闭' };
  const key = quipsKey(); if (!key) return { ok: false, message: '没有可用的 DeepSeek API Key' };
  const st = state.data.quips || (state.data.quips = { updatedAt: 0, byCharacter: {}, lastError: null });
  const ids = CHARACTERS.map((c) => c.id);
  const due = force ? ids : quipsGen.dueCharacters(q, st, ids);
  if (!due.length) return { ok: true, message: '还没到时间' };
  quipsBusy = true; sendSettings('quips:progress', { text: '开始生成…' });
  try {
    const keep = Number(q.keep) || 80;
    const r = await quipsGen.generateAll({ ...q, apiKey: key }, due, st.byCharacter, (id, n, err) => { log('quips', id, n, err || ''); sendSettings('quips:progress', { text: `${id}: ${err ? '失败 ' + err : n + ' 句'}` }); });
    for (const [id, lines] of Object.entries(r.quips)) {
      const prev = (st.byCharacter[id] || []).filter((x) => !lines.includes(x));
      st.byCharacter[id] = [...lines, ...prev].slice(0, keep);
      (st.characterAt || (st.characterAt = {}))[id] = Date.now();
    }
    if (Object.keys(r.quips).length) st.updatedAt = Date.now();
    st.failed = [...new Set([...(st.failed || []).filter((id) => !due.includes(id)), ...Object.keys(r.errors)])];
    st.retryAfter = st.failed.length ? Date.now() + 30 * 60000 : 0;
    st.lastError = Object.keys(r.errors).length ? JSON.stringify(r.errors).slice(0, 300) : null;
    state.saveSoon(); pushData();
    const total = Object.values(r.quips).reduce((a, l) => a + l.length, 0);
    sendSettings('quips:progress', { text: `完成：新增 ${total} 句` + (st.lastError ? '，部分失败' : ''), done: true });
    return { ok: total > 0, message: total ? `新增 ${total} 句${st.failed.length ? '，失败角色稍后重试' : ''}` : '生成失败，保留已有台词，稍后重试', errors: r.errors };
  } catch (e) { st.lastError = e.message; state.saveSoon(); sendSettings('quips:progress', { text: '失败：' + e.message, done: true }); return { ok: false, message: e.message }; }
  finally { quipsBusy = false; }
}
function whyCharacter() { return characterSelection().why; }
// 每秒看前台窗口，进程身份不受会话标题变化影响。
function checkWindows() {
  try {
    const fg = winsnap.foregroundWindow();
    const fgc = activity.routeForWindow(fg, config.data.activity, config.data.providers, agents());
    if (fgc && fg.hwnd !== ownHwnd()) {
      const mascot = mascotOf(fgc);
      const info = fgc === 'cursor' ? cursorInfo() : null;
      const label = fgc === 'cursor' ? 'Cursor' + (info && info.ok ? ' · ' + (info.label || 'Auto') : '') : null;
      foreground = { character: mascot, at: Date.now(), tool: fgc, label };
      lastAgentWin = { hwnd: fg.hwnd, title: fg.title, tool: fgc, character: fgc, mascot };
      recent = { character: mascot, at: Date.now(), reason: 'focus', label };
    } else foreground = { character: null, at: 0 };
    const wins = winsnap.titledWindows();
    const agentWins = new Map();
    for (const w of wins) { const c = activity.routeForWindow(w, config.data.activity, config.data.providers, agents()); if (c && !w.iconic) agentWins.set(w.hwnd, mascotOf(c)); }
    if (knownAgentWins) {
      // 同一个终端/浏览器也可能切工具。Z 序中最前的新工具优先。
      for (const [h, c] of agentWins) if (knownAgentWins.get(h) !== c) { recent = { character: c, at: Date.now(), reason: 'launch' }; log('agent window appeared ->', c); break; }
    }
    knownAgentWins = agentWins;
    const ch = resolveCharacter();
    if (ch !== currentCharacter) pushData();
  } catch (e) { log('checkWindows error', e.message); }
}

// ---------- 渲染进程通信 ----------
function sendPet(ch, payload) { if (petWin && !petWin.isDestroyed()) petWin.webContents.send(ch, payload); }
function sendSettings(ch, payload) { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(ch, payload); }
function sendPanel(ch, payload) { if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send(ch, payload); }
function publicConfig() { return config.data; }
function pushData() {
  const character = resolveCharacter();
  if (character !== currentCharacter) { currentCharacter = character; updateTrayMenu(); }
  const payload = {
    snapshots: state.data.snapshots, ledgers: state.data.ledgers, config: publicConfig(), activity: lastActivity, character, quotaOnly: QUOTA_ONLY,
    characters: allCharacters(), characterImages: characterImages(), notifications: state.data.notifications.slice(0, 50), maxBalanceSeen: state.data.maxBalanceSeen,
    snapAvailable: winsnap.available(), refreshing, launchLabel: (launcher.resolve(character, launchCfg()) || {}).label || null,
    colors: (allCharacters().find((c) => c.id === character) || CHARACTERS[0]).colors, why: whyCharacter(), activeProviders: activeProviderIds(),
    quips: (state.data.quips && state.data.quips.byCharacter) || {},
  };
  sendPet('data', payload);
  sendSettings('data', payload);
  sendPanel('data', payload);
}

// 面板堆在角色头顶上方：底边贴着角色图片顶部，水平居中于角色；放不下就往下压（盖住角色也没关系，面板在上层）
function panelPlace(W, H) {
  const pb = petWin.getBounds(); const wa = screen.getDisplayMatching(pb).workArea;
  const petLeft = pb.x + petBox.x, petTop = pb.y + petBox.y, petW = petBox.w;
  let x = petLeft + petW / 2 - W / 2; x = Math.min(Math.max(x, wa.x), wa.x + wa.width - W);
  let y = petTop - H - 6; if (y < wa.y) y = wa.y;
  if (y + H > wa.y + wa.height) y = Math.max(wa.y, wa.y + wa.height - H);
  return { x: Math.round(x), y: Math.round(y) };
}
let panelShown = false, panelFallback = null;
function togglePanel() {
  if (panelWin && !panelWin.isDestroyed()) { closePanel(); return; }
  if (!petWin) return;
  const W = 296, H = 400;
  const { x, y } = panelPlace(W, H);
  panelShown = false;
  panelWin = new BrowserWindow({ width: W, height: H, x, y, transparent: true, frame: false, resizable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, parent: petWin,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false } });
  panelWin.setMenu(null); panelWin.setAlwaysOnTop(true, 'screen-saver', 1);
  panelWin.loadFile(path.join(ROOT, 'src', 'renderer', 'panel.html'));
  // 等渲染进程报了真实高度再显示，避免先出来再跳
  clearTimeout(panelFallback); panelFallback = setTimeout(() => showPanelAt(H), 800);
  panelWin.once('closed', () => clearTimeout(panelFallback));
  panelWin.on('blur', () => setTimeout(() => { if (panelWin && !panelWin.isDestroyed() && !panelWin.isFocused()) closePanel(); }, 120));
  panelWin.on('closed', () => { panelWin = null; sendPet('cmd', { name: 'menu-open', on: false }); });
  sendPet('cmd', { name: 'menu-open', on: true });
}
function showPanelAt(h) {
  if (!panelWin || panelWin.isDestroyed()) return;
  clearTimeout(panelFallback);
  const b = panelWin.getBounds();
  h = Math.max(80, Math.min(h, screen.getDisplayMatching(petWin.getBounds()).workArea.height - 12));
  const { x, y } = panelPlace(b.width, h);
  panelWin.setBounds({ x, y, width: b.width, height: Math.round(h) });
  if (!panelShown) { panelShown = true; panelWin.show(); panelWin.moveTop(); panelWin.focus(); }
}
function closePanel() { if (panelWin && !panelWin.isDestroyed()) panelWin.close(); panelWin = null; }

// ---------- 通知 ----------
function pushNotification(ev, providerId) {
  const dupe = state.data.notifications.find((x) => ev.eventKey ? x.providerId === providerId && x.eventKey === ev.eventKey : x.title === ev.title && x.body === ev.body && Date.now() - x.ts < 86400000);
  if (dupe) return null;
  const n = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), kind: ev.kind, title: ev.title, body: ev.body, eventKey: ev.eventKey || null, link: ev.link || null, providerId: providerId || null, read: false };
  state.data.notifications.unshift(n);
  state.data.notifications = state.data.notifications.slice(0, 300);
  state.saveSoon();
  const nc = config.data.notify;
  const quiet = notifyEngine.inQuietHours(nc.quietHours);
  if (nc.toast && !quiet && Notification.isSupported()) {
    try {
      const t = new Notification({ title: n.title, body: n.body, icon: path.join(ASSETS, 'app.ico'), silent: !nc.sound });
      t.on('click', () => { if (n.link) shell.openExternal(n.link); else openSettings('notifications'); });
      t.show();
    } catch (e) { log('toast failed', e.message); }
  }
  // 气泡已经念过的就算读过，消息记录里不再堆未读红点；只有免打扰时段错过的才留未读
  if (nc.bubble && !quiet) { n.read = true; if (petReady) sendPet('notify', n); else pendingNotices.push(n); }
  sendSettings('notification', n);
  updateTrayMenu();
  return n;
}

// ---------- 刷新 ----------
async function refreshAll({ force = false, reason = 'timer' } = {}) {
  if (refreshing) return;
  refreshing = true; pushData();
  const now = Date.now();
  const wantModels = force || (now - lastModelsCheck > (Number(config.data.refresh.newsIntervalMin) || 60) * 60000);
  if (wantModels) lastModelsCheck = now;
  try {
    const list = enabledProviders();
    const results = await Promise.all(list.map((p) => providers.fetchSnapshot(p, { wantModels })));
    for (let i = 0; i < list.length; i++) {
      const p = list[i]; const s = results[i];
      const prev = state.data.snapshots[p.id];
      if (s.ok) {
        // 余额类：记账 + 体型基准
        if (s.balance === null && Number.isFinite(s.usedTotal)) {
          // 只有累计用量（不限额令牌）：把 -用量 当作余额记账，得到今日已用
          state.data.ledgers[p.id] = notifyEngine.updateLedger(state.data.ledgers[p.id], -s.usedTotal, (s.currency || 'USD') + '#used');
        } else if (s.balance !== null && s.balance !== undefined) {
          state.data.ledgers[p.id] = notifyEngine.updateLedger(state.data.ledgers[p.id], s.balance, s.currency);
          const mx = state.data.maxBalanceSeen[p.id] || 0;
          if (s.balance > mx) state.data.maxBalanceSeen[p.id] = s.balance;
          const full = p.type === 'deepseek' ? (Number(config.data.appearance.fullAmountCNY) || 100) : Math.max(state.data.maxBalanceSeen[p.id] || 0, s.currency === 'USD' ? 20 : 100);
          s.fraction = Math.max(0, Math.min(1, s.balance / full));
        }
        for (const ev of notifyEngine.diffSnapshots(prev, s, p, config.data.notify)) pushNotification(ev, p.id);
        if (Array.isArray(s.models)) {
          for (const ev of notifyEngine.diffModels(state.data.models[p.id], s.models, p, config.data.notify)) pushNotification(ev, p.id);
          state.data.models[p.id] = s.models;
        }
        if (Array.isArray(s.announcements)) {
          const r = notifyEngine.diffAnnouncements(state.data.announcements[p.id], s.announcements, p, config.data.notify);
          for (const ev of r.events) pushNotification(ev, p.id);
          state.data.announcements[p.id] = r.ids;
        }
        // 保留最近一次成功数据；失败时沿用（标记 stale）
        s.todayUsage = state.data.ledgers[p.id] ? state.data.ledgers[p.id].todayUsage : null;
        state.data.snapshots[p.id] = { ...s, models: undefined, announcements: (s.announcements || []).slice(0, 5), stale: false };
      } else {
        const changedSource = p.type === 'gemini' && typeof s.relay === 'boolean' && s.relay !== !!prev?.relay;
        if (prev && prev.ok && !changedSource) state.data.snapshots[p.id] = { ...prev, stale: true, error: s.error, lastTry: now };
        else state.data.snapshots[p.id] = { ...s, stale: false };
        if (!prev || prev.error !== s.error) log('provider failed', p.id, s.error); // 同一错误每轮刷新只记一次
      }
    }
    // 清理已删除/禁用的
    for (const id of Object.keys(state.data.snapshots)) if (!list.find((p) => p.id === id)) delete state.data.snapshots[id];
    // RSS
    if (wantModels && (config.data.notify.rssFeeds || []).length) {
      const r = await news.checkFeeds(config.data.notify.rssFeeds, state.data.rssSeen, config.data.notify);
      state.data.rssSeen = r.seen;
      for (const ev of r.events) pushNotification(ev, null);
    }
    state.saveSoon();
  } catch (e) { log('refresh error', e); }
  refreshing = false;
  pushData();
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  const sec = Math.max(60, Number(config.data.refresh.intervalSec) || 300);
  refreshTimer = setInterval(() => refreshAll({ reason: 'timer' }), sec * 1000);
}

function checkActivity() {
  try {
    const a = activity.detect(config.data.activity, config.data.providers || [], agents());
    const changed = a.active !== lastActivity.active;
    lastActivity = a;
    if (a.active) { state.data.lastActive = a.active; state.data.lastActiveAt = a.at; }
    if (changed) log('activity ->', a.active);
    if (changed || resolveCharacter() !== currentCharacter) pushData();
  } catch (e) { log('activity error', e.message); }
}

// 重置点附近刷新一次，网络失败后每分钟重试，避免等满常规刷新间隔。
let resetRefreshAt = 0;
const checkedResets = new Set();
function checkQuotaResets() {
  if (refreshing || Date.now() - resetRefreshAt < 60000) return;
  const now = Date.now() / 1000;
  const due = [];
  for (const [id, s] of Object.entries(state.data.snapshots)) {
    if (!s.ok) continue;
    for (const w of s.windows || []) {
      const key = `${id}:${w.key}:${w.resetsAt}`;
      if (w.resetsAt && w.resetsAt <= now && !w.expired && !checkedResets.has(key)) due.push({ id, key, at: w.resetsAt, windowKey: w.key });
    }
  }
  if (!due.length) return;
  resetRefreshAt = Date.now();
  refreshAll({ reason: 'quota-reset' }).then(() => {
    for (const d of due) {
      const s = state.data.snapshots[d.id], w = s && (s.windows || []).find((x) => x.key === d.windowKey);
      if (s && !s.stale && w && (w.expired || w.resetsAt > d.at)) checkedResets.add(d.key);
    }
    if (checkedResets.size > 200) checkedResets.delete(checkedResets.values().next().value);
  });
}

// ---------- 窗口 ----------
function createPetWindow() {
  const { width, height } = winSizeForScale(config.data.appearance.scale);
  const lay = config.data.layout || {};
  let x = lay.x, y = lay.y;
  const prim = areaFor(screen.getPrimaryDisplay());
  if (typeof x !== 'number' || typeof y !== 'number') { x = prim.x + prim.width - width - 20; y = prim.y + prim.height - height; }
  flipped = typeof lay.flipped === 'boolean' ? lay.flipped : !!(lay.snapped && lay.snapped.h === 'left');
  petWin = new BrowserWindow({
    width, height, x: Math.round(x), y: Math.round(y),
    transparent: true, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: !!config.data.appearance.alwaysOnTop, show: false, focusable: true,
    title: 'AI 桌宠', icon: path.join(ASSETS, 'app.ico'), backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, spellcheck: false },
  });
  petWin.setMenu(null);
  if (config.data.appearance.alwaysOnTop) petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.setOpacity(Math.max(0.25, Math.min(1, Number(config.data.appearance.opacity) || 1)));
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  // 置顶会被人家的 topmost 窗口顶掉（切全屏、别的置顶工具），隔几秒补一次，切走焦点也补
  // 始终启动：运行中再打开「始终置顶」也生效，关着时回调里直接跳过
  const keepTop = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) return clearInterval(keepTop);
    if (!config.data.appearance.alwaysOnTop || !petWin.isVisible()) return;
    petWin.setAlwaysOnTop(true, 'screen-saver');
  }, 5000);
  petWin.on('closed', () => clearInterval(keepTop));
  petWin.on('blur', () => { if (petWin && !petWin.isDestroyed() && config.data.appearance.alwaysOnTop) petWin.setAlwaysOnTop(true, 'screen-saver'); });
  petWin.loadFile(path.join(ROOT, 'src', 'renderer', 'pet.html'), { hash: flipped ? 'left' : '' });
  petWin.once('ready-to-show', () => { petWin.show(); ensureOnScreen(); });
  petWin.webContents.on('console-message', (ev) => { const { level, message, lineNumber, sourceId } = ev; if (level !== 'info' && level !== 'debug' || process.env.AIPET_DEBUG) log('[renderer]', message, sourceId ? `(${path.basename(String(sourceId))}:${lineNumber})` : ''); });
  petWin.webContents.on('render-process-gone', (e, d) => log('renderer gone', d.reason));
  if (process.env.AIPET_DEBUG) setTimeout(async () => { try { const img = await petWin.webContents.capturePage(); fs.writeFileSync(path.join(ROOT, 'debug-pet.png'), img.toPNG()); log('debug capture saved', petWin.getBounds(), petBox); } catch (e) { log('capture failed', e.message); } }, 8000);
  petWin.on('closed', () => { petWin = null; });
  petWin.webContents.on('before-input-event', (e, input) => { if (input.key === 'F12' && input.type === 'keyDown') petWin.webContents.toggleDevTools(); });
}

function movePet(x, y) { if (!petWin) return; const { width, height } = winSizeForScale(config.data.appearance.scale); petWin.setBounds({ x: Math.round(x), y: Math.round(y), width, height }); }
function stopAnimation() { clearInterval(animTimer); animTimer = null; areaMotion = null; }
function displayFor(rect) { return screen.getDisplayNearestPoint({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }); }
function petRect() { const b = petWin.getBounds(); return { x: b.x + petBox.x, y: b.y + petBox.y, width: petBox.w, height: petBox.h }; }
function ensureOnScreen() {
  if (!petWin) return;
  const b = petWin.getBounds();
  const d = areaFor(displayFor(petRect()));
  if (areaMotion) {
    // Display-metrics events must not snap to the end halfway through a safe lift/drop.
    const target = { x: areaMotion.x + petBox.x, y: areaMotion.y + petBox.y, width: petBox.w, height: petBox.h };
    const safe = geometry.clampPosition(target, d);
    if (safe.x === target.x && safe.y === target.y) return;
    stopAnimation();
  }
  const x = Math.min(Math.max(b.x, d.x - petBox.x), d.x + d.width - petBox.x - petBox.w);
  const y = Math.min(Math.max(b.y, d.y - petBox.y), d.y + d.height - petBox.y - petBox.h);
  if (x !== b.x || y !== b.y) movePet(x, y);
}

function openSettings(tab) {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); if (tab) sendSettings('goto', tab); return; }
  settingsWin = new BrowserWindow({
    width: 960, height: 700, minWidth: 760, minHeight: 520, title: 'AI 桌宠 · 设置', icon: path.join(ASSETS, 'app.ico'), autoHideMenuBar: true, backgroundColor: '#f6f7fb',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(ROOT, 'src', 'renderer', 'settings.html'), { hash: tab || 'providers' });
  settingsWin.on('closed', () => { settingsWin = null; });
  settingsWin.webContents.on('before-input-event', (e, input) => { if (input.key === 'F12' && input.type === 'keyDown') settingsWin.webContents.toggleDevTools(); });
  settingsWin.webContents.once('did-finish-load', () => pushData());
}

// ---------- 吸附 ----------
function physToDip(r) {
  const a = screen.screenToDipPoint({ x: r.left, y: r.top });
  const b = screen.screenToDipPoint({ x: r.right, y: r.bottom });
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, right: b.x, bottom: b.y };
}
function ownHwnd() {
  try { const buf = petWin.getNativeWindowHandle(); return String(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0)); } catch (_) { return null; }
}
function otherWindows() {
  if (!config.data.appearance.snapWindows || !winsnap.available()) return [];
  const ex = [ownHwnd()];
  if (settingsWin && !settingsWin.isDestroyed() && !process.env.AIPET_DEBUG_SNAP) { try { const b = settingsWin.getNativeWindowHandle(); ex.push(String(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0))); } catch (_) { /* */ } }
  const list = winsnap.listWindows(ex.filter(Boolean));
  const displays = screen.getAllDisplays();
  return list.map((w) => ({ ...w, d: physToDip(w.rect) })).filter((w) => {
    // 忽略几乎铺满显示器的窗口（最大化/全屏），它们的边就是屏幕边
    return !displays.some((dsp) => { const b = dsp.bounds; return Math.abs(w.d.x - b.x) < 20 && Math.abs(w.d.y - b.y) < 20 && Math.abs(w.d.right - (b.x + b.width)) < 20 && Math.abs(w.d.bottom - (b.y + b.height)) < 20; });
  });
}

function computeSnap() {
  const b = petWin.getBounds();
  const pet = { x: b.x + petBox.x, y: b.y + petBox.y, w: petBox.w, h: petBox.h };
  pet.cx = pet.x + pet.w / 2; pet.cy = pet.y + pet.h / 2; pet.right = pet.x + pet.w; pet.bottom = pet.y + pet.h;
  const T = 40;
  let tx = pet.x, ty = pet.y, h = null, v = null, att = null;
  pet.width = pet.w; pet.height = pet.h;
  // 1) 窗口吸附（优先）
  let best = null;
  for (const w of otherWindows()) {
    const d = w.d;
    const hOverlap = pet.cx > d.x - 10 && pet.cx < d.right + 10;
    const vOverlap = pet.cy > d.y - 10 && pet.cy < d.bottom + 10;
    const cands = [];
    if (hOverlap) {
      cands.push({ dist: Math.abs(pet.bottom - d.y), apply: () => { ty = d.y - pet.h; v = 'bottom'; att = { hwnd: w.hwnd, mode: 'top', dx: pet.x - d.x, dy: -pet.h }; } });
      cands.push({ dist: Math.abs(pet.bottom - d.bottom), apply: () => { ty = d.bottom - pet.h; v = 'bottom'; att = { hwnd: w.hwnd, mode: 'bottom', dx: pet.x - d.x, dy: d.h - pet.h }; } });
    }
    if (vOverlap) {
      cands.push({ dist: Math.abs(pet.x - d.right), apply: () => { tx = d.right; h = 'left'; att = { hwnd: w.hwnd, mode: 'right', dx: d.w, dy: pet.y - d.y }; } });
      cands.push({ dist: Math.abs(pet.right - d.x), apply: () => { tx = d.x - pet.w; h = 'right'; att = { hwnd: w.hwnd, mode: 'left', dx: -pet.w, dy: pet.y - d.y }; } });
    }
    for (const c of cands) if (c.dist < T && (!best || c.dist < best.dist)) best = c;
  }
  // 屏幕边缘离得更近（或一样近）时优先贴屏幕边，免得被旁边窗口的边抢走差几个像素
  if (best && config.data.appearance.snapScreen) {
    const wa0 = areaFor(displayFor(pet));
    const edges = [pet.x - wa0.x, wa0.x + wa0.width - pet.right, pet.y - wa0.y, wa0.y + wa0.height - pet.bottom].map(Math.abs).filter((d) => d < T);
    if (edges.length && Math.min(...edges) <= best.dist) best = null;
  }
  if (best) {
    best.apply();
    // 贴着窗口顶/底时，若同时接近窗口左右边，也对齐一下
    if (att && (att.mode === 'top' || att.mode === 'bottom')) {
      const w = otherWindows().find((x) => x.hwnd === att.hwnd);
      if (w) {
        if (Math.abs(pet.x - w.d.x) < T) { tx = w.d.x; att.dx = 0; }
        else if (Math.abs(pet.right - w.d.right) < T) { tx = w.d.right - pet.w; att.dx = w.d.w - pet.w; }
      }
    }
  } else if (config.data.appearance.snapScreen) {
    // 2) 屏幕边缘：只在离边 T 以内（含拖出屏幕外）时吸附。按角色中心所在的显示器算，
    //    相邻显示器之间的内边也吸（离得近说明是有意放到交界处）
    const wa = areaFor(displayFor(pet));
    if (pet.x - wa.x < T) { tx = wa.x; h = 'left'; }
    else if (wa.x + wa.width - pet.right < T) { tx = wa.x + wa.width - pet.w; h = 'right'; }
    if (pet.y - wa.y < T) { ty = wa.y; v = 'top'; }
    else if (wa.y + wa.height - pet.bottom < T) { ty = wa.y + wa.height - pet.h; v = 'bottom'; }
  }
  // 3) 钳制到整个虚拟桌面（允许跨屏），但不能落到没有显示器的地方
  const wa = areaFor(displayFor({ x: tx, y: ty, width: pet.w, height: pet.h }));
  const safe = geometry.clampPosition({ x: tx, y: ty, width: pet.w, height: pet.h }, wa);
  tx = safe.x; ty = safe.y;
  if (process.env.AIPET_DEBUG_SCRIPT) log('snap', JSON.stringify({ pet: { x: pet.x, y: pet.y, w: pet.w, h: pet.h }, wa, tx, ty, h, v, att: !!att, disp: screen.getAllDisplays().map((d) => ({ b: d.bounds, wa: d.workArea, sf: d.scaleFactor })) }));
  // 返回角色图片应落到的屏幕位置；换算成窗口位置放在 finishSettle 里做（翻转后 petBox 会变，要等渲染层上报）
  // 没贴左右边时保持原来的朝向，不来回转身
  return { tx, ty, h, v, att, flip: h === 'left' ? true : h === 'right' ? false : flipped };
}

function animateTo(x, y, done, opts = {}) {
  stopAnimation();
  const b = petWin.getBounds();
  const sx = b.x, sy = b.y, t0 = Date.now(), dur = opts.desktopArea ? 360 : 240;
  if (Math.abs(sx - x) < 2 && Math.abs(sy - y) < 2) { movePet(x, y); done && done(); return; }
  if (opts.desktopArea) areaMotion = { x, y };
  animTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - t0) / dur);
    const e = opts.desktopArea ? t * t * (3 - 2 * t) : 1 - Math.pow(1 - t, 3); // 缓入缓出，不过冲
    movePet(sx + (x - sx) * e, sy + (y - sy) * e);
    if (t >= 1) { stopAnimation(); done && done(); }
  }, 16);
}

function settle() {
  if (!petWin) return;
  const r = computeSnap();
  attach = r.att;
  sendPet('snap', { h: r.h, v: r.v, flip: r.flip, attached: !!r.att, title: r.att ? (otherWindows().find((w) => w.hwnd === r.att.hwnd) || {}).title : null });
  // 以渲染层上报的实际朝向为准（petBox.flipped），避免两边状态错开
  const cur = typeof petBox.flipped === 'boolean' ? petBox.flipped : flipped;
  if (r.flip !== cur) {
    // 渲染层镜像后上报稳定边界（pet:box 里带 flipped），再挪窗口并滑到目标；超时兜底
    flipped = r.flip; pendingSettle = r;
    setTimeout(() => { if (pendingSettle === r) { pendingSettle = null; finishSettle(r); } }, 600);
    return;
  }
  finishSettle(r);
}
function finishSettle(r) {
  if (!petWin) return;
  const x = Math.round(r.tx - petBox.x), y = Math.round(r.ty - petBox.y);
  animateTo(x, y, () => { config.data.layout = { x, y, snapped: { h: r.h, v: r.v }, flipped: r.flip }; config.saveSoon(); });
  startAttachLoop();
}

function startAttachLoop() {
  clearInterval(attachTimer);
  if (!attach) return;
  let lastKey = '';
  attachTimer = setInterval(() => {
    if (!petWin || drag) return;
    const rect = winsnap.windowRect(attach.hwnd);
    if (!rect) {
      attach = null; clearInterval(attachTimer); stopAnimation(); pendingSettle = null;
      // 工具关闭/最小化时保留当前朝向，避免无 flip 的消息把角色翻到窗口另一侧、挤出屏幕。
      flipped = !!petBox.flipped;
      sendPet('snap', { h: null, v: null, flip: flipped, attached: false });
      ensureOnScreen();
      const b = petWin.getBounds();
      config.data.layout = { x: b.x, y: b.y, snapped: { h: null, v: null }, flipped };
      config.saveSoon();
      return;
    }
    const d = physToDip(rect);
    const key = `${d.x},${d.y},${d.w},${d.h}:${JSON.stringify([...desktopAreas])}`;
    if (key === lastKey) return;
    lastKey = key;
    let px, py;
    switch (attach.mode) {
      case 'top': px = d.x + attach.dx; py = d.y - petBox.h; break;
      case 'bottom': px = d.x + attach.dx; py = d.bottom - petBox.h; break;
      case 'right': px = d.right; py = d.y + attach.dy; break;
      default: px = d.x - petBox.w; py = d.y + attach.dy;
    }
    const safe = geometry.clampPosition({ x: px, y: py, width: petBox.w, height: petBox.h }, areaFor(displayFor({ x: px, y: py, width: petBox.w, height: petBox.h })));
    movePet(safe.x - petBox.x, safe.y - petBox.y);
  }, 50);
}

// ---------- 托盘 / 菜单 ----------
function buildMenuTemplate() {
  const ap = config.data.appearance;
  const unread = state.data.notifications.filter((n) => !n.read).length;
  const charItems = [{ label: '自动（跟随当前 agent）', type: 'radio', checked: ap.character === 'auto', click: () => setAppearance({ character: 'auto' }) },
    ...allCharacters().map((c) => ({ label: c.name, type: 'radio', checked: ap.character === c.id, click: () => setAppearance({ character: c.id }) }))];
  return [
    ...(!QUOTA_ONLY ? [
      { label: `🚀 打开 ${(launcher.resolve(currentCharacter || resolveCharacter(), launchCfg()) || {}).label || '对应工具'}`, click: () => launchCurrent() },
      { label: '🚀 打开其他…', submenu: launchTargets().map((t) => ({ label: t.spec.label, click: () => launchFor(t.id, t.spec) })) },
      { label: '🔁 交接给别的 AI', submenu: handoffMenu() },
    ] : []),
    { type: 'separator' },
    { label: '🔄 刷新额度', click: () => refreshAll({ force: true, reason: 'menu' }) },
    { label: '💬 显示气泡', click: () => sendPet('cmd', { name: 'bubble' }) },
    { label: '🎲 随便说句话', click: () => sendPet('cmd', { name: 'random' }) },
    { label: '✋ 摸摸头', click: () => sendPet('cmd', { name: 'headpat' }) },
    { label: `📨 消息记录${unread ? `（${unread} 条未读）` : ''}`, click: () => openSettings('notifications') },
    { type: 'separator' },
    { label: '🎭 角色', submenu: charItems },
    { label: '📐 大小', submenu: [0.7, 0.85, 1, 1.2, 1.5, 1.8, 2.2].map((s) => ({ label: `${Math.round(s * 100)}%`, type: 'radio', checked: Math.abs(ap.scale - s) < 0.01, click: () => setAppearance({ scale: s }) })) },
    { label: '🔊 音效', submenu: [['off', '关'], ['duck', '小黄鸭'], ['fx1', '音效1']].map(([v, l]) => ({ label: l, type: 'radio', checked: ap.sound === v, click: () => setAppearance({ sound: v }) })) },
    { label: '⚡ 峰谷文案', submenu: [['default', '默认'], ['liang', '梁文峰谷'], ['strong', '!?强强?!'], ['off', '关闭']].map(([v, l]) => ({ label: l, type: 'radio', checked: ap.peakMode === v, click: () => setAppearance({ peakMode: v }) })) },
    { type: 'separator' },
    { label: '启用气泡', type: 'checkbox', checked: !!ap.bubbleOn, click: (m) => setAppearance({ bubbleOn: m.checked }) },
    { label: '随机台词', type: 'checkbox', checked: !!ap.quipsOn, click: (m) => setAppearance({ quipsOn: m.checked }) },
    { label: '始终置顶', type: 'checkbox', checked: !!ap.alwaysOnTop, click: (m) => setAppearance({ alwaysOnTop: m.checked }) },
    { label: '吸附屏幕边缘', type: 'checkbox', checked: !!ap.snapScreen, click: (m) => setAppearance({ snapScreen: m.checked }) },
    { label: '吸附到窗口', type: 'checkbox', checked: !!ap.snapWindows, enabled: winsnap.available(), click: (m) => setAppearance({ snapWindows: m.checked }) },
    { label: '开机自启', type: 'checkbox', checked: !!config.data.autostart, click: (m) => setAutostart(m.checked) },
    { type: 'separator' },
    { label: '⚙️ 设置…', click: () => openSettings('providers') },
    { label: petWin && petWin.isVisible() ? '隐藏桌宠' : '显示桌宠', click: () => { if (!petWin) return; petWin.isVisible() ? petWin.hide() : petWin.show(); updateTrayMenu(); } },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ];
}
// 宠物右键只放快捷动作；外观 / 开关在右上角面板，完整列表留给托盘
function petMenuTemplate() {
  const all = buildMenuTemplate();
  if (QUOTA_ONLY) return all;
  const job = handoffJob || lastHandoffJob;
  return [
    ...(job && job.text ? [{ label: '📋 复制交接指令', click: () => handoffAction({ action: 'copy', id: job.id }) }, { label: '收起交接提示', click: () => handoffAction({ action: 'close', id: job.id }) }, ...(handoffJob ? [{ label: '⏹ 取消交接', click: () => handoffAction({ action: 'cancel', id: job.id }) }] : []), { type: 'separator' }] : []),
    ...all.slice(1, 3), // 打开其他 / 交接（「打开当前工具」双击桌宠就够了）
    { type: 'separator' },
    ...all.slice(7, 9), // 摸头 / 消息
    ...all.filter((m) => m.label === '⚙️ 设置…'),
    { label: '隐藏桌宠（托盘图标可唤回）', click: () => { if (petWin) { petWin.hide(); updateTrayMenu(); } } },
  ];
}
function updateTrayMenu() { if (tray) tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate())); }
function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'app.ico'));
    tray = new Tray(img);
    tray.setToolTip('AI 桌宠');
  tray.on('click', () => { if (petWin) { petWin.show(); sendPet('cmd', { name: 'bubble' }); } });
  tray.on('double-click', () => openSettings('providers'));
    updateTrayMenu();
  } catch (e) { log('tray failed', e.message); }
}

// 可启动的工具；Windows 本机的 Claude Code 和 WSL 版并存时单独列一项
// 每项都要去 PATH 里找可执行文件（约 40 ms），一次菜单会用好几回：配置没变就短时复用
function launchTargets() {
  const cfgKey = JSON.stringify(launchCfg());
  if (launchCache && launchCache.cfgKey === cfgKey && Date.now() - launchCache.at < 30000) return launchCache.list;
  const out = allCharacters().map((c) => ({ id: c.id, spec: launcher.resolve(c.id, launchCfg()) })).filter((t) => launcher.menuAvailable(t.spec));
  const win = launcher.claudeWinSpec(); const cl = out.find((t) => t.id === 'claude');
  if (win && cl && cl.spec.kind !== 'cli') out.splice(out.indexOf(cl) + 1, 0, { id: 'claude', spec: win });
  launchCache = { cfgKey, at: Date.now(), list: out };
  return out;
}
let launchCache = null;
async function launchFor(characterId, spec = null, opts = {}) {
  const r = await launcher.launch(characterId, spec ? { ...launchCfg(), [characterId]: spec } : launchCfg(), opts);
  if (r.ok) { recent = { character: characterId, at: Date.now(), reason: 'launch' }; pushData(); }
  log('launch', characterId, r);
  if (!opts.handoff) sendPet('cmd', { name: 'say', seconds: r.ok ? 1.2 : 3, restoreInfo: true, lines: [{ t: r.ok ? (r.already ? '已经开着啦~' : '出发！') : '打不开...', s: 'P', c: r.ok ? '' : '#e0433f' }, { t: r.message, s: 'C', w: true }] });
  return r;
}
// Cursor 也是可读来源（state.vscdb），但它的模型娘可能是 Claude，来源键必须保持 cursor
function handoffSourceKey(src) {
  if (!src) return null;
  if (src.tool === 'cursor') return 'cursor';
  return charOf(src.character) || src.character;
}
function handoffSourceName(src) {
  if (!src) return '这个来源';
  return src.tool === 'cursor' ? 'Cursor' : (charOf(src.character) || src.character || '这个来源');
}
// 同一工具开着多个会话时，让人自己选一个：默认仍是「最近更新的」，但选错不再是静默的
// 扫会话（WSL 下的 Claude 记录要几百 ms）放在后台进程：菜单只用现成结果，过期了先用旧的、后台再刷新
let sessionCache = null, sessionWorker = null, sessionPending = '';
function sessionsFor(src) {
  const kind = src && handoffApi.KINDS[handoffSourceKey(src)];
  if (!kind) return null;
  const key = `${kind}|${src.title}`;
  const hit = sessionCache && sessionCache.key === key ? sessionCache : null;
  if (!hit || Date.now() - hit.at > 20000) refreshSessions(kind, key, src.title);
  return hit;
}
function refreshSessions(kind, key, title) {
  if (sessionPending === key) return;
  sessionPending = key;
  try {
    if (!sessionWorker) {
      sessionWorker = utilityProcess.fork(path.join(__dirname, 'session-worker.js'));
      sessionWorker.on('message', (r) => { if (r.key === sessionPending) sessionPending = ''; sessionCache = { ...r, at: Date.now() }; });
      sessionWorker.on('exit', (code) => { sessionWorker = null; sessionPending = ''; if (code) log('session worker exit', code); });
    }
    sessionWorker.postMessage({ key, kind, dirs: transcriptDirs(kind), title });
  } catch (e) { sessionPending = ''; log('session scan failed', e.message); }
}
function sessionMenu(src, targets) {
  const c = sessionsFor(src);
  if (!c || c.list.length < 2) return [];
  const { kind, list, auto } = c;
  return [{
    // 原生菜单点一下整条就关，所以会话下面直接挂目标工具：选会话 → 选工具一路走完，不再关掉重弹
    label: `换个会话交接（默认${auto ? `《${auto}》` : '最近更新的'}）`,
    submenu: list.map((s) => ({
      label: `${s.current ? '● ' : ''}《${s.name}》${s.project ? ' · ' + s.project : ''}${s.fresh ? ' · ' + s.fresh : ''}`,
      submenu: targets({ kind, file: s.file, name: s.name }),
    })),
  }];
}
// 一键看「哪些工具现在读得到」：读得到的才会用 DeepSeek 整理，读不到的会退回让原 AI 自己写
function probeSources() {
  const rows = [['claude', 'Claude'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['workbuddy', 'WorkBuddy'], ['zcode', 'ZCode'], ['dsh', 'DSH']].map(([kind, label]) => {
    let s = null;
    try { s = handoffApi.recentSessions(kind, transcriptDirs(kind), 1)[0] || null; } catch (_) { /* 读不到 */ }
    if (!s) return { ok: false, label, text: '没找到记录' };
    return { ok: true, label, name: s.name, project: s.project || '', fresh: s.fresh || '', text: `${s.name}${s.project ? `（${s.project}）` : ''} · ${s.fresh || ''}`.trim() };
  });
  const ok = rows.filter((r) => r.ok).length;
  log('handoff probe', rows.map((r) => `${r.label}：${r.text}`).join(' | '));
  // 用右键菜单展示：系统字号、跟「来源会话」一个样式；气泡三行放不下，系统对话框又太像报错
  try {
    const template = [
      { label: `可读来源 ${ok}/${rows.length}`, enabled: false },
      { type: 'separator' },
      ...rows.map((r) => ({ label: `${r.ok ? '✓' : '✗'} ${r.label}：${r.text}`, enabled: false })),
    ];
    if (petWin) {
      // popup 的 x/y 是「相对窗口左上角」的偏移，不是屏幕坐标：
      // 先把目标位置夹进屏幕工作区，再减掉窗口原点，菜单才会稳稳贴在桌宠左边
      const b = petWin.getBounds();
      const wa = screen.getDisplayMatching(b).workArea;
      const ax = Math.max(wa.x + 8, Math.min(b.x - 340, wa.x + wa.width - 348));
      const ay = Math.max(wa.y + 8, Math.min(b.y + 60, wa.y + wa.height - 280));
      Menu.buildFromTemplate(template).popup({ window: petWin, x: ax - b.x, y: ay - b.y });
    }
  } catch (_) { /* 窗口还没建好 */ }
  return rows;
}
function currentHandoffSource() { return lastAgentWin && winsnap.titledWindows().some((w) => w.hwnd === lastAgentWin.hwnd) ? lastAgentWin : null; }
function handoffMenu(source) {
  if (handoffJob) return [
    { label: '查看交接进度', click: () => { lastSaid = ''; pushHandoff(); } },
    { label: '复制当前指令', enabled: !!handoffJob.text, click: () => handoffAction({ action: 'copy', id: handoffJob.id }) },
    { label: '⏹ 取消交接', click: () => handoffAction({ action: 'cancel', id: handoffJob.id }) },
  ];
  const last = handoff.latest();
  const src = source === undefined ? currentHandoffSource() : source;
  const readable = !!(src && handoffApi.KINDS[handoffSourceKey(src)]);
  const d = last && new Date(last.at);
  const tools = launchTargets();
  const targets = (pin) => tools.map((t) => ({ label: `交给 ${t.spec.label}`, enabled: !!(src || last), click: () => runHandoff(t.id, t.spec, src, pin) }));
  const when = d ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
  return [
    { label: src ? `从：${src.title.slice(0, 40)}${readable ? '' : '（读不到记录）'}` : '没找到正在用的 AI 窗口，只能接手最近的交接', enabled: false },
    ...sessionMenu(src, targets),
    { label: '检查可读来源…', click: () => probeSources() },
    { type: 'separator' },
    ...targets(null),
    { type: 'separator' },
    { label: last ? `最近：${path.basename(path.dirname(last.file))}（${when}）` : '还没有交接记录', enabled: false },
    { label: '打开交接文件', enabled: !!last, click: () => shell.openPath(last.file) },
  ];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, job, step = 1000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) { if (job.cancelled) return null; const v = fn(); if (v) return v; }
  return null;
}
// 复制并发到指定窗口；切不到前台就只留在剪贴板，绝不往别的窗口按键
async function pasteTo(hwnd, text, stopped = () => false) {
  if (stopped()) return false;
  await clipboard.writeText(text);
  if (stopped()) return false;
  if (!winsnap.bringToFront(hwnd)) return false;
  await sleep(400);
  if (stopped() || (winsnap.foregroundWindow() || {}).hwnd !== hwnd) return false;
  return winsnap.pasteKeys(true, hwnd, stopped);
}

// 进度用桌宠自己的聊天气泡显示：只说当前这一步，结束后说结论
let lastSaid = '';
function pushHandoff(j = handoffJob) {
  if (!j) return;
  let i = j.steps.findIndex((x) => x.s === 'run');
  if (i < 0) i = j.steps.findIndex((x) => x.s === 'fail');
  if (i < 0) i = j.steps.map((x) => x.s).lastIndexOf('ok');
  const cur = j.steps[i];
  // 标题进左上角小云朵，大气泡写“第几步”和细节；结束后写结论
  const failed = !!j.error || j.steps.some((x) => x.s === 'fail');
  const headings = [j.viaApi ? '读对话记录' : '请原 AI 写交接', j.viaApi ? 'DeepSeek 整理中' : '等 AI 整理好', '正在打开工具', j.cli ? '正在发送指令' : j.fillingDraft ? '正在填入指令' : '正在复制指令'];
  // 还没走成任何一步、又已经知道退回了老流程时，先说清楚原因
  const beforeAnyOk = !j.steps.some((x) => x.s === 'ok');
  const heading = j.received ? '新 AI 已接手' : j.done ? (j.cancelled ? '交接已停止' : failed ? '还差一步' : j.returning ? (j.cli ? '原会话继续中' : j.prefilled ? '在 Codex 确认发送' : '已请求返回原会话') : j.cli ? '接手指令已发送' : j.prefilled ? `在 ${j.prefillLabel || 'Codex'} 确认发送` : '到新对话粘贴') : (j.fallback && beforeAnyOk ? '退回原流程' : headings[Math.max(0, i)]);
  const shortProject = j.project && ([...j.project].length > 12 ? [...j.project].slice(0, 12).join('') + '…' : j.project);
  // 旧版被替换掉多少行、读的是哪个对话：都写进气泡，别让唯一真相源被悄悄重写
  const replaced = j.replaced ? `\n旧版 ${j.replaced} 行已备份` : '';
  const srcLine = j.sourceLabel ? `\n读的是 ${j.sourceLabel}${j.sourceStale ? '（可能不是你正开着的对话）' : ''}` : '';
  const fromLine = j.fromLatest ? `\n用的是最近一次交接：${j.fromLatest}` : '';
  const detail = j.received ? '指令已发出，气泡马上收起' : j.done ? (j.cancelled ? '已停止后续操作，指令仍可复制' : failed ? j.note || '指令已保留，可复制后手动继续' : j.cli ? `已发送给新终端，等待 AI 接手${replaced}${srcLine}${fromLine}` : `${shortProject ? `工作区：${shortProject}\n` : ''}${j.returning ? (j.prefilled ? '增量指令已预填，确认后发送' : '增量交接已复制，请在原会话粘贴发送') : j.prefilled ? '指令已预填，剪贴板也留了一份' : j.draftPresent ? '保留原草稿，指令在剪贴板' : 'Ctrl+V 粘贴，再回车发送'}${replaced}${srcLine}${fromLine}`) : j.manualSource ? '请在原 AI 对话粘贴并发送指令' : i === 1 ? `${j.sourceLabel ? `读的是 ${j.sourceLabel}${j.sourceStale ? '（可能不是你正开着的对话）' : ''}；` : ''}${cur && cur.d || '写好后会自动打开目标工具'}` : i === 2 ? (shortProject ? `工作区：${shortProject}` : '正在唤起目标工具') : (j.fallback && beforeAnyOk) ? `${j.fallback}，改让原 AI 写交接（会耗来源额度）` : '连按两下 Esc 可取消';
  const view = { id: j.id, target: j.target, heading, detail, project: j.project || '', step: Math.max(1, i + 1), steps: j.steps.map((x) => x.s), done: j.done, cancelled: j.cancelled, failed, manualSource: !!j.manualSource, canCopy: !!j.text,
    progress: j.done ? undefined : j.progress, autoCloseMs: j.received || (j.cli && j.sent) ? 4000 : j.watching ? 30 * 60000 : undefined };
  const said = JSON.stringify(view); if (said === lastSaid) return; lastSaid = said;
  sendPet('handoff', view);
}
function jobStep(job, i, s, note) {
  if (handoffJob !== job || job.cancelled) return;
  if (i !== null) job.steps[i].s = s;
  if (note !== undefined) job.note = note;
  log('handoff', i, s, note || '');
  pushHandoff();
}
function finishJob(job) {
  if (handoffJob !== job) return;
  job.done = true; for (const x of job.steps) if (x.s === 'run' || x.s === 'wait') x.s = job.cancelled ? 'cancelled' : x.s;
  if (handoffJob !== job) return;
  pushHandoff(); lastHandoffJob = job; handoffJob = null; lastSaid = ''; updateTrayMenu(); escToCancel(false);
}
// Esc 仲裁（只在交接期间占用全局 Esc）：桌宠自己在前台 → 一下就取消；别的应用在前台 → 第一下原样还给它，
// 1 秒内再按一下才算取消交接。还键时先注销热键再补按，稍后重新注册，否则补按的那一下会被自己再截住
let escAt = 0;
function onHandoffEsc() {
  if (!handoffJob) return;
  const now = Date.now();
  if (BrowserWindow.getFocusedWindow() || now - escAt < 1000) { escAt = 0; handoffAction({ action: 'cancel', id: handoffJob.id }); return; }
  escAt = now;
  globalShortcut.unregister('Escape'); winsnap.tapKey(0x1B);
  setTimeout(() => { if (handoffJob) escToCancel(true); }, 60);
}
// 没有 koffi 就还不了键：宁可不占 Esc，只留气泡里的取消按钮；注册失败（被别的程序占用）同样静默
function escToCancel(on) {
  try {
    if (!on) { globalShortcut.unregister('Escape'); escAt = 0; }
    else if (winsnap.available() && !globalShortcut.isRegistered('Escape')) globalShortcut.register('Escape', onHandoffEsc);
  } catch (_) { /* 快捷键不可用 */ }
}
function handoffAction({ action, id } = {}) {
  const job = handoffJob || lastHandoffJob;
  if (!job || job.id !== id) return;
  if (action === 'copy' && job.text) clipboard.writeText(job.text);
  if (action === 'cancel' && job === handoffJob) { job.cancelled = true; job.draftController?.abort(); finishJob(job); }
  if (action === 'close') { job.closed = true; sendPet('cmd', { name: 'hide' }); }
}
function transcriptDirs(kind) {
  if (kind === 'codex') return [codexHome()];
  if (kind === 'cursor') return [cursorDbPath() || cursorModel.DEFAULT_DB];
  if (kind === 'dsh') return [process.env.DSH_HOME || path.join(app.getPath('home'), '.dsh')];
  if (kind === 'workbuddy') return [process.env.WORKBUDDY_HOME || path.join(app.getPath('home'), '.workbuddy')];
  if (kind === 'zcode') return [process.env.ZCODE_HOME || path.join(app.getPath('home'), '.zcode')];
  return activity.detectClaudeDirs(config.data.activity || {});
}
// 桌面目标没法知道用户何时发送：盯新 AI 的对话记录，接手指令出现了就说一声并收起；读不到记录的工具照旧定时收起
function watchReceived(job, targetId, spec) {
  // Cursor 的模型娘可能叫 Claude，但目标工具仍是 cursor，不能去盯 Claude 的记录
  const kind = targetId === 'cursor' ? 'cursor' : handoffApi.KINDS[charOf(targetId) || targetId];
  if (!kind || (kind === 'dsh' && !desktopDraft.isDsh(spec))) return;
  // 指令里已经没有路径了，盯的是这条指令本身：新 AI 的对话记录里出现它，就是用户发出去了
  const check = handoffApi.watchSent(kind, transcriptDirs(kind), job.text);
  job.watching = true; pushHandoff(job);
  const t0 = Date.now();
  const timer = setInterval(() => {
    let hit = false; try { hit = check(); } catch (e) { log('handoff watch', e.message); }
    if (hit && lastHandoffJob === job && !handoffJob && !job.closed) { job.received = true; job.watching = false; pushHandoff(job); log('handoff received'); }
    // 两分钟还没等到发送：ZCode 的旧草稿聊天会绑死临时工作区，任何消息都报「发送失败」且桌宠看不见，
    // 必须主动告诉用户出路（新建会话），而不是静默等到 30 分钟超时
    if (!hit && !job.hinted && Date.now() - t0 > 2 * 60000) {
      job.hinted = true;
      job.steps[3].d = kind === 'zcode' ? '没等到发送：若 ZCode 提示「发送失败」，点 + 新建会话再 Ctrl+V' : '还没等到发送，请确认指令已发出';
      pushHandoff(job);
    }
    if (hit || handoffJob || lastHandoffJob !== job || job.closed || Date.now() - t0 > 30 * 60000) clearInterval(timer);
  }, 3000);
}

// 一键交接：让来源 AI 写 HANDOFF → 等 latest.txt 更新 → 在项目目录打开目标工具 → 粘贴接手指令
async function runHandoff(targetId, spec, src, pin) {
  if (QUOTA_ONLY) return;
  if (handoffJob) { lastSaid = ''; pushHandoff(); return; }
  // 只有终端能可靠地自动粘贴；桌面应用唤出后焦点常不在输入框，打开好工作区后由用户粘贴
  const cli = /cli$/.test(spec.kind);
  const job = handoffJob = { id: ++handoffSerial, target: spec.label, cli, workspace: launcher.supportsWorkspace(spec), cancelled: false, done: false, sent: false, text: src ? handoff.writePrompt(handoffSourceKey(src)) : '', note: '',
    title: `交接 → ${spec.label}`,
    steps: [{ t: '让 AI 写交接', s: src ? 'wait' : 'skip' }, { t: '等交接文件', s: src ? 'wait' : 'skip' }, { t: cli ? '启动目标终端' : '打开目标工具', s: 'wait' }, { t: cli ? '发送接手指令' : '指令放进剪贴板', s: 'wait' }] };
  pushHandoff(); updateTrayMenu(); escToCancel(true);
  const sourceId = src && handoffSourceKey(src);
  const sourceSession = file => {
    if (!sourceId || !file) return null;
    try { return launchTargets().filter(t => t.id === sourceId).map(t => handoffReturn.sessionOf(sourceId, file, t.spec)).find(Boolean) || null; }
    catch (_) { return null; }
  };
  if (pin && pin.kind === handoffApi.KINDS[sourceId]) job.routeSource = sourceSession(pin.file);
  try {
    const lastHandoff = handoff.latest();
    let file = lastHandoff && lastHandoff.file;
    // 没找到来源窗口时用的是「上一次交接」的文件——把是哪个项目说出来，别让人以为是自己这个项目
    if (!src) job.fromLatest = file ? path.basename(path.dirname(file)) : '';
    // 来源是 Claude 且有 DeepSeek Key：桌宠自己读对话记录交给 DeepSeek 整理，不耗来源工具额度；失败再退回让来源 AI 写
    let viaApi = false;
    const srcKind = src && quipsKey() && handoffApi.KINDS[handoffSourceKey(src)];
    // 用户以为在用「省额度」的新流程，实际退回了老流程时必须让他看见原因，不能悄悄扣额度
    if (src && !srcKind) {
      job.fallback = !quipsKey() ? '没有可用的 DeepSeek Key' : `${handoffSourceName(src)} 的对话记录读不到`;
      log('handoff api skipped', job.fallback); pushHandoff();
    }
    if (srcKind) {
      job.viaApi = true; job.steps[0].t = '读对话记录'; job.steps[1].t = 'DeepSeek 整理'; jobStep(job, 0, 'run');
      let tick = null;
      try {
        const q = config.data.quips || {};
        file = await handoffApi.run({ kind: srcKind, dirs: transcriptDirs(srcKind), winTitle: src.title, session: pin && pin.kind === srcKind ? pin.file : undefined, api: { apiKey: quipsKey(), baseUrl: q.baseUrl, model: q.model }, request: http.request,
          history: state.data.handoffTimings,
          onTiming: sample => { if (!job.cancelled) { state.data.handoffTimings = [...(state.data.handoffTimings || []), sample].slice(-24); state.saveSoon(); } },
          onPhase: phase => { job.phase = phase; },
          onRead: (root, meta) => {
            job.routeSource = sourceSession(meta && meta.transcript);
            if (job.routeSource && root) job.routeSource.projectRoot = root;
            job.estimate = meta && meta.estimate;
            // 气泡里带上「读的是哪个对话、多久没动过」：Codex 可能取到别的线程，用户能当场取消
            const L = (meta && meta.label) || {};
            const lbl = L.name ? `《${L.name}》${L.age ? ' · ' + L.age : ''}${L.fresh ? ' · ' + L.fresh : ''}` : '';
            job.sourceLabel = lbl; job.sourceName = L.name || '';
            // 十分钟没动过就基本不可能是你眼下正在用的对话，直接说出来
            job.sourceStale = L.minutes !== null && L.minutes !== undefined && L.minutes >= 10;
            job.steps[0].d = [root ? path.basename(root) : '没认出项目', lbl].filter(Boolean).join(' ');
            jobStep(job, 0, 'ok'); jobStep(job, 1, 'run');
            // 模型不报进度：按经验时长估一个只涨不满的条，加秒数，让人知道没卡住
            const t0 = Date.now();
            job.steps[1].d = handoffEstimate.status(job.estimate, 0);
            pushHandoff();
            tick = setInterval(() => { const sec = Math.round((Date.now() - t0) / 1000); job.progress = job.estimate ? Math.min(0.95, sec / (sec + job.estimate.seconds)) : undefined; job.steps[1].d = handoffEstimate.status(job.estimate, sec, job.phase || '整理'); pushHandoff(); }, 1000);
          },
          // 覆盖 old HANDOFF.md 之前先记下来：替换了几行、备份到哪，收尾时写进气泡
          onWrite: (info) => {
            job.replaced = info.prevLines; job.backup = info.backup;
            job.steps[1].d = info.prevLines ? `替换 ${info.prevLines} 行旧版，已备份` : '';
          } });
        clearInterval(tick); job.progress = undefined;
        if (job.cancelled) return;
        log('handoff api wrote', file);
        // 攒太多的旧交接文件挪去 backups/pruned，不删、不碰 HANDOFF.md
        const pruned = handoffApi.pruneOldHandoffs ? handoffApi.pruneOldHandoffs(path.dirname(file)) : [];
        if (pruned.length) log('handoff pruned', pruned.join(', '));
        job.steps[1].d = job.replaced ? `替换 ${job.replaced} 行旧版，已备份` : path.basename(path.dirname(file));
        jobStep(job, 1, 'ok', ''); viaApi = true;
      } catch (e) {
        clearInterval(tick); job.progress = undefined; job.viaApi = false;
        if (job.cancelled) return;
        if (e.code === 'SOURCE_SELECTION_REQUIRED') { jobStep(job, 0, 'fail', e.message); return; }
        log('handoff api failed', e.message);
        job.fallback = String(e.message || '调用失败').split('\n')[0].slice(0, 60);
        job.steps[0] = { t: '让 AI 写交接', s: 'wait', d: 'API 没成功，改让 AI 写' }; job.steps[1] = { t: '等交接文件', s: 'wait' };
        pushHandoff();
      }
    }
    if (src && !viaApi) {
      const before = (handoff.latest() || {}).at || 0;
      // 读不到记录的工具，只能等它自己写文件；没有本地记录的 IDE（Cursor/Trae 等）多半等不到，少等一会儿早点报错
      const canRead = !!(srcKind && handoffApi.KINDS[handoffSourceKey(src)]);
      const waitMs = canRead ? 20 * 60000 : 8 * 60000;
      jobStep(job, 0, 'run');
      const sent = await pasteTo(src.hwnd, job.text, () => job.cancelled);
      if (job.cancelled) return;
      if (sent) jobStep(job, 0, 'ok');
      else { job.manualSource = true; jobStep(job, 0, 'wait'); }
      jobStep(job, 1, 'run');
      const t0 = Date.now();
      const done = await waitFor(() => {
        const l = handoff.latest(); if (l && l.at > before) return l;
        const m = Math.floor((Date.now() - t0) / 60000); job.steps[1].d = m ? `已等 ${m} 分钟（最多 ${waitMs / 60000}）` : ''; pushHandoff();
        return null;
      }, waitMs, job, 2000);
      if (job.cancelled) return;
      if (!done) { jobStep(job, 1, 'fail', `${waitMs / 60000} 分钟没等到交接完成` + (canRead ? '' : '（这类工具读不到记录，建议换成 Claude/Codex/DSH/WorkBuddy 当来源）')); return; }
      file = done.file; job.manualSource = false; job.steps[0].s = 'ok'; job.steps[1].d = path.basename(path.dirname(file)); jobStep(job, 1, 'ok', '');
    }
    if (!file) { jobStep(job, 2, 'fail', '没有交接文件'); return; }
    let ws = handoff.workspaceOf ? handoff.workspaceOf(file) : path.dirname(file);
    if (!ws) {
      const picked = await dialog.showOpenDialog(petWin, { title: '未识别项目目录，请选择本次交接的实际工作区', properties: ['openDirectory'] });
      if (job.cancelled || picked.canceled || !picked.filePaths?.[0]) { jobStep(job, 2, 'fail', '未选择实际工作区，已停止转接'); return; }
      ws = picked.filePaths[0];
      file = handoff.placeInWorkspace(file, ws);
    }
    job.routeWorkspace = ws;
    const returnSession = handoffReturn.find(state.data.handoffReturns, ws, targetId, sourceId, spec);
    job.project = launcher.supportsWorkspace(spec) ? path.basename(ws) : '';
    // 指令只写技能命令 + 任务名，具体读哪个文件由 takeover 技能自己找（见 skills/takeover/SKILL.md）
    const shown = (f, base) => {
      const rel = handoff.shortPath ? handoff.shortPath(f, base) : f;
      return spec.kind === 'wsl-cli' ? handoff.toWslPath(rel).replace(/\\/g, '/') : rel;
    };
    job.handoffPath = spec.kind === 'wsl-cli' ? handoff.toWslPath(file) : file;
    job.text = handoff.takeoverPrompt(job.handoffPath, { project: path.basename(ws), goal: handoff.goalOf ? handoff.goalOf(file) : '', session: job.sourceName, tool: targetId });
    // 回原会话时 AI 的工作目录是那个会话自己的目录（桌面版按线程，CLI 按项目目录），相对路径按它算
    if (returnSession) { job.text = handoffReturn.prompt(shown(file, job.cli ? ws : (returnSession.cwd || ws)), { project: path.basename(ws), goal: handoff.goalOf ? handoff.goalOf(file) : '', session: job.sourceName, tool: targetId }); job.returning = true; }
    await clipboard.writeText(job.text);
    if (job.cancelled) return;
    job.steps[2].d = launcher.supportsWorkspace(spec) ? `工作区 ${path.basename(ws)}` : '不支持指定工作区';
    jobStep(job, 2, 'run');
    if (!cli) {
      let r = await launchFor(targetId, spec, { cwd: ws, prompt: job.text, session: returnSession, handoff: true });
      if (!r.ok && returnSession && !job.cancelled) {
        job.returning = false;
        job.text = handoff.takeoverPrompt(job.handoffPath, { project: path.basename(ws), tool: targetId });
        await clipboard.writeText(job.text);
        if (job.cancelled) return;
        r = await launchFor(targetId, spec, { cwd: ws, prompt: job.text, handoff: true });
      }
      if (job.cancelled) return;
      if (!r.ok) { jobStep(job, 2, 'fail', r.message || '工具没打开，指令在剪贴板'); return; }
      job.prefilled = !!r.draftPrepared;
      if (desktopDraft.isDsh(spec)) {
        job.fillingDraft = true;
        jobStep(job, 2, 'ok'); job.steps[3].t = '填入接手指令'; jobStep(job, 3, 'run');
        const window = await waitFor(() => winsnap.findWindow('.', 'DSH Desktop.exe'), 12000, job, 300);
        if (job.cancelled) return;
        if (window && winsnap.bringToFront(window.hwnd)) {
          job.draftController = new AbortController();
          const draft = await desktopDraft.prefillDsh({ hwnd: window.hwnd, workspace: ws, prompt: job.text, signal: job.draftController.signal });
          if (job.cancelled) return;
          job.prefilled = draft.prefilled; job.prefillLabel = 'DSH'; job.draftPresent = draft.code === 'draft-present';
          log('handoff DSH draft', draft.code, 'workspaceVerified', draft.workspaceVerified === true);
        }
      }
      jobStep(job, 2, 'ok'); jobStep(job, 3, 'ok', 'Ctrl+V 粘贴接手指令');
      return;
    }
    // 等新开终端里的 Claude 起来（标题变成 Claude Code）
    const existing = new Set(winsnap.titledWindows().map((w) => w.hwnd));
    const routed = (w) => { const c = activity.routeForWindow(w, config.data.activity, config.data.providers, agents()); return c && (charOf(c) || c) === targetId; };
    const findTarget = () => winsnap.titledWindows().find((w) => routed(w) && w.hwnd !== (src && src.hwnd) && w.hwnd !== ownHwnd() && !existing.has(w.hwnd));
    const r = await launchFor(targetId, spec, { cwd: ws, session: returnSession, handoff: true });
    if (job.cancelled) return;
    if (!r.ok) { jobStep(job, 2, 'fail', r.message || '终端没打开，指令在剪贴板'); return; }
    const win = await waitFor(findTarget, 60000, job);
    if (job.cancelled) return;
    if (!win) { jobStep(job, 2, 'fail', '60 秒没等到目标窗口，指令在剪贴板'); return; }
    jobStep(job, 2, 'ok'); jobStep(job, 3, 'run');
    await sleep(2500); // 等 Claude 输入框就绪
    if (job.cancelled) return;
    if (await pasteTo(win.hwnd, job.text, () => job.cancelled)) { job.sent = true; jobStep(job, 3, 'ok', '交接完成'); }
    else jobStep(job, 3, 'fail', '切不过去：指令在剪贴板，请 Ctrl+V 发送');
  } catch (e) { job.error = true; log('handoff failed', e.message); jobStep(job, null, null, '出错：' + e.message); }
  finally {
    if (!job.cancelled && !job.error && job.routeSource && job.routeWorkspace && !job.steps.some(x => x.s === 'fail' || x.s === 'wait' || x.s === 'run')) {
      state.data.handoffReturns = handoffReturn.remember(state.data.handoffReturns, job.routeWorkspace, job.routeSource, targetId);
      state.saveSoon();
    }
    finishJob(job);
    if (!job.cancelled && !job.error && !job.sent && job.handoffPath && !job.steps.some((x) => x.s === 'fail')) watchReceived(job, targetId, spec);
  }
}
function launchCurrent() { if (QUOTA_ONLY) return openSettings('providers'); launchFor(currentCharacter || resolveCharacter()); }

function setAppearance(patch) {
  const before = { ...config.data.appearance };
  Object.assign(config.data.appearance, patch);
  config.saveSoon();
  if (petWin) {
    if (patch.scale !== undefined && patch.scale !== before.scale) {
      const { width, height } = winSizeForScale(patch.scale);
      const b = petWin.getBounds();
      // 以角色所在角为固定点缩放（右下 / 左下）
      const flip = config.data.layout && config.data.layout.snapped && config.data.layout.snapped.h === 'left';
      petWin.setBounds({ x: flip ? b.x : b.x + b.width - width, y: b.y + b.height - height, width, height });
      setTimeout(() => settle(), 200);
    }
    if (patch.alwaysOnTop !== undefined) petWin.setAlwaysOnTop(!!patch.alwaysOnTop, 'screen-saver');
    if (patch.opacity !== undefined) petWin.setOpacity(Math.max(0.25, Math.min(1, Number(patch.opacity) || 1)));
  }
  updateTrayMenu();
  pushData();
}

function startupLnk() { return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', EDITION.name + '.lnk'); }
function setAutostart(on) {
  config.data.autostart = !!on; config.saveSoon();
  try {
    if (!on) { if (fs.existsSync(startupLnk())) fs.unlinkSync(startupLnk()); }
    else if (!fs.existsSync(startupLnk())) {
      const ps = `$ws = New-Object -ComObject WScript.Shell; $l = $ws.CreateShortcut(${JSON.stringify(startupLnk()).replace(/"/g, "'")}); $l.TargetPath = ${JSON.stringify(process.execPath).replace(/"/g, "'")}; $l.Arguments = '${app.isPackaged ? '' : '"' + ROOT.replace(/\\/g, '\\\\') + '"'}'; $l.WorkingDirectory = ${JSON.stringify(app.isPackaged ? path.dirname(process.execPath) : ROOT).replace(/"/g, "'")}; $l.IconLocation = ${JSON.stringify(app.isPackaged ? process.execPath : path.join(ASSETS, 'app.ico')).replace(/"/g, "'")}; $l.Save()`;
      const enc = Buffer.from(ps, 'utf16le').toString('base64');
      require('child_process').execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], (err) => { if (err) log('autostart lnk failed', err.message); });
    }
  } catch (e) { log('autostart failed', e.message); }
  updateTrayMenu();
}

// ---------- IPC ----------
ipcMain.on('pet:ready', () => { petReady = true; pushData(); for (const n of pendingNotices.splice(0)) sendPet('notify', n); });
ipcMain.on('pet:box', (e, box) => {
  const prev = petBox; petBox = box;
  if (pendingSettle && !drag && !!box.flipped === !!pendingSettle.flip) {
    // 镜像的瞬间角色在窗口里换了边：把窗口反向挪同样的距离，角色在屏幕上原地不动，然后再滑向吸附点
    const r = pendingSettle; pendingSettle = null;
    const b = petWin.getBounds(); movePet(b.x + prev.x - box.x, b.y + prev.y - box.y);
    finishSettle(r);
  } else if (boxReceived && petWin && !drag && !pendingSettle && !!prev.flipped === !!box.flipped && (prev.x !== box.x || prev.y !== box.y || prev.w !== box.w || prev.h !== box.h)) {
    // 换立绘或胖瘦时保留原来的贴边落点，避免透明边距差异把角色挤出屏幕。
    const b = petWin.getBounds();
    const old = { x: b.x + prev.x, y: b.y + prev.y, width: prev.w, height: prev.h };
    const wa = areaFor(displayFor(old));
    const sn = config.data.layout.snapped || {};
    let x = b.x + prev.x - box.x, y = b.y + prev.y + prev.h - box.y - box.h;
    if (!attach && sn.h === 'left') x = wa.x - box.x;
    else if (!attach && sn.h === 'right') x = wa.x + wa.width - box.x - box.w;
    else if (attach && attach.mode === 'left') x = b.x + prev.x + prev.w - box.x - box.w;
    if (!attach && sn.v === 'top') y = wa.y - box.y;
    else if (!attach && sn.v === 'bottom') y = wa.y + wa.height - box.y - box.h;
    const safe = geometry.clampPosition({ x: x + box.x, y: y + box.y, width: box.w, height: box.h }, wa);
    x = safe.x - box.x; y = safe.y - box.y;
    movePet(x, y);
    config.data.layout.x = Math.round(x); config.data.layout.y = Math.round(y); config.saveSoon();
    if (attach) startAttachLoop();
  }
  if (!boxReceived) {
    boxReceived = true;
    // 透明边距或立绘尺寸变化后，启动时也按保存的吸附边恢复，而非保留旧窗口坐标造成空隙。
    const rect = petRect(), area = areaFor(displayFor(rect)), sn = config.data.layout.snapped || {};
    let x = rect.x, y = rect.y;
    if (sn.h === 'left') x = area.x;
    if (sn.h === 'right') x = area.x + area.width - rect.width;
    if (sn.v === 'top') y = area.y;
    if (sn.v === 'bottom') y = area.y + area.height - rect.height;
    movePet(x - box.x, y - box.y);
    ensureOnScreen();
  }
});
ipcMain.on('mouse:ignore', (e, ignore) => {
  if (!petWin) return;
  petWin.setIgnoreMouseEvents(!!ignore, { forward: true });
  // 鼠标进到桌宠上：趁还没点，让后台先扫会话、主进程备好工具列表
  if (!ignore && !QUOTA_ONLY && !handoffJob) setImmediate(() => { try { sessionsFor(currentHandoffSource()); launchTargets(); } catch (_) { /* 右键时再扫 */ } });
});
ipcMain.on('drag:start', (e, pt) => { if (!petWin) return; stopAnimation(); closePanel(); const b = petWin.getBounds(); drag = { sx: pt.x, sy: pt.y, wx: b.x, wy: b.y }; attach = null; pendingSettle = null; clearInterval(attachTimer); });
ipcMain.on('drag:move', (e, pt) => { if (!petWin || !drag) return; movePet(drag.wx + pt.x - drag.sx, drag.wy + pt.y - drag.sy); });
ipcMain.on('drag:end', () => { if (!petWin) return; drag = null; settle(); });
// 会话列表要扫 transcript（每种工具几十~上百 ms），右键按下时先建好，松开直接弹，跟左键一样跟手
let preparedMenu = null;
const PET_MENU_W = 260; // 实测 7 项原生菜单窗口宽 276（含阴影），取略小值宁可贴身体也别留缝
ipcMain.on('menu:prepare', () => {
  if (!petWin) return;
  const t = Date.now(); preparedMenu = { menu: Menu.buildFromTemplate(petMenuTemplate()), at: Date.now() };
  if (preparedMenu.at - t > 80) log('pet menu slow', preparedMenu.at - t, 'ms');
});
ipcMain.on('context-menu', (_e, pt) => {
  if (!petWin) return;
  const ready = preparedMenu && Date.now() - preparedMenu.at < 3000 ? preparedMenu.menu : Menu.buildFromTemplate(petMenuTemplate());
  preparedMenu = null;
  // popup 的 x/y 是相对窗口的偏移：渲染端给桌宠身体右侧的锚点，不传时 Windows 缩放/多屏下菜单会偏离鼠标
  const c = screen.getCursorScreenPoint(), b = petWin.getBounds();
  const at = pt && Number.isFinite(pt.x) && Number.isFinite(pt.y) ? { x: Math.round(pt.x), y: Math.round(pt.y) } : { x: c.x - b.x, y: c.y - b.y };
  // shortcut: 菜单宽度按 PET_MENU_W 估算（原生菜单量不到），菜单项文案明显变长时再调
  if (pt && Number.isFinite(pt.left)) {
    const wa = screen.getDisplayMatching(b).workArea;
    if (wa.x + wa.width - (b.x + at.x) < PET_MENU_W) at.x = Math.round(pt.left) - PET_MENU_W;
  }
  ready.popup({ window: petWin, ...at });
});
ipcMain.on('handoff:action', (e, action) => { if (petWin && e.sender === petWin.webContents) handoffAction(action); });
ipcMain.on('panel:toggle', () => togglePanel());
ipcMain.on('panel:close', () => closePanel());
ipcMain.on('panel:size', (e, { h }) => { if (!panelWin || panelWin.isDestroyed()) return; const b = panelWin.getBounds(); if (panelShown && Math.abs(b.height - h) < 2) return; showPanelAt(h); });
ipcMain.on('panel:ready', () => pushData());
ipcMain.on('cmd:pet', (e, c) => sendPet('cmd', c));
ipcMain.on('open-settings', (e, tab) => openSettings(tab));
ipcMain.on('launch', (e, id) => (QUOTA_ONLY ? openSettings('providers') : id ? launchFor(id) : launchCurrent()));
ipcMain.handle('agents:presets', async () => { await launcher.discover(AGENT_PRESETS); return AGENT_PRESETS.map((a) => ({ ...a, installed: launcher.agentSpec(a).kind === 'app' })); });
ipcMain.handle('launch:defaults', async () => { await launcher.discover(agents()); return { ...launcher.defaults(), ...agentLaunch() }; });
ipcMain.handle('quips:generate', () => refreshQuips({ force: true }));
ipcMain.handle('quips:state', () => ({ updatedAt: (state.data.quips || {}).updatedAt || 0, lastError: (state.data.quips || {}).lastError || null, counts: Object.fromEntries(Object.entries((state.data.quips || {}).byCharacter || {}).map(([k, v]) => [k, v.length])), hasKey: !!quipsKey() }));
ipcMain.on('open-external', (e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.on('refresh', () => refreshAll({ force: true, reason: 'ui' }));
ipcMain.on('quit', () => { quitting = true; app.quit(); });
ipcMain.on('appearance:set', (e, patch) => setAppearance(patch || {}));
ipcMain.on('notifications:read', () => { state.data.notifications.forEach((n) => { n.read = true; }); state.saveSoon(); updateTrayMenu(); pushData(); });
ipcMain.on('notification:read', (e, id) => { const n = state.data.notifications.find((x) => x.id === id); if (n) { n.read = true; state.saveSoon(); updateTrayMenu(); } });
ipcMain.on('notifications:clear', () => { state.data.notifications = []; state.saveSoon(); updateTrayMenu(); pushData(); });
ipcMain.on('resnap', () => settle());
ipcMain.on('pet:recover', () => {
  if (!petWin) return;
  stopAnimation(); clearInterval(attachTimer); attach = null; pendingSettle = null; drag = null;
  const wa = areaFor(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
  config.data.layout.snapped = { h: 'right', v: 'bottom' };
  movePet(wa.x + wa.width - petBox.x - petBox.w, wa.y + wa.height - petBox.y - petBox.h);
  flipped = false; sendPet('snap', { flip: false });
  petWin.showInactive();
  setTimeout(() => { ensureOnScreen(); const b = petWin.getBounds(); Object.assign(config.data.layout, { x: b.x, y: b.y, flipped: false }); config.saveSoon(); }, 250);
});
ipcMain.handle('config:get', () => config.data);
ipcMain.handle('config:set', (e, next) => {
  const appearance = next.appearance;
  const rest = { ...next }; delete rest.appearance;
  config.data = deepMerge(config.data, rest);
  // 先保留原外观，让 setAppearance 能比较前后值并真正改变窗口大小。
  if (appearance) setAppearance(appearance);
  if (!config.save()) throw new Error('设置未能写入，请检查本机文件是否可写');
  if (next.autostart !== undefined) setAutostart(next.autostart);
  if (next.refresh) scheduleRefresh();
  if (next.agents) { updateTrayMenu(); launcher.discover(agents()); }
  if (next.providers) refreshAll({ force: true, reason: 'config' });
  else pushData();
  return config.data;
});
ipcMain.handle('provider:test', async (e, p) => providers.fetchSnapshot(p, { wantModels: !QUOTA_ONLY }));
ipcMain.handle('importers:scan', async () => importers.scan());
ipcMain.handle('meta', () => ({ types: providers.TYPE_META, characters: allCharacters(), characterImages: characterImages(), userData, root: ROOT, quotaOnly: QUOTA_ONLY, snapAvailable: winsnap.available(), version: app.getVersion(), electron: process.versions.electron }));
ipcMain.handle('state:get', () => state.data);
ipcMain.handle('notifications:list', () => state.data.notifications);
ipcMain.handle('pick-file', async () => { const r = await dialog.showOpenDialog({ properties: ['openFile', 'showHiddenFiles'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('pick-directory', async () => { const r = await dialog.showOpenDialog({ properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('pick-dir', async () => { const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'showHiddenFiles'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('activity:now', () => { checkActivity(); return lastActivity; });

// ---------- 生命周期 ----------
app.on('second-instance', () => { if (petWin) { petWin.show(); sendPet('cmd', { name: 'bubble' }); } });
app.on('window-all-closed', (e) => { /* 托盘常驻 */ });
app.on('before-quit', () => { quitting = true; closePanel(); config.save(); state.save(); });

app.whenReady().then(() => {
  updateScreenAreas();
  const firstRun = QUOTA_ONLY ? !config.data.quotaOnboardingDone : !config.data.firstRunDone;
  if (firstRun) { config.data.firstRunDone = true; config.save(); }
  createTray();
  createPetWindow();
  if (firstRun) openSettings('providers');
  checkActivity();
  // 首次：只把本机装了的预设 agent 加进来
  launcher.discover([...agents(), ...AGENT_PRESETS]).then(() => {
    if (config.data.agents) return;
    config.data.agents = AGENT_PRESETS.filter((a) => launcher.agentSpec(a).kind === 'app' || (a.dir && fs.existsSync(a.dir)));
    config.save(); updateTrayMenu(); pushData();
  });
  refreshAll({ force: true, reason: 'startup' });
  scheduleRefresh();
  activityTimer = setInterval(checkActivity, 10000);
  setInterval(() => { updateScreenAreas(); checkWindows(); }, 1000); checkWindows();
  setInterval(checkQuotaResets, 15000);
  if (!QUOTA_ONLY) { setTimeout(() => refreshQuips(), 20000); setInterval(() => refreshQuips(), 10 * 60000); }
  powerMonitor.on('resume', () => setTimeout(() => refreshAll({ force: true, reason: 'resume' }), 5000));
  screen.on('display-metrics-changed', () => setTimeout(() => { updateScreenAreas(); ensureOnScreen(); }, 500));
  // 旧版（1.0.4 及以前，散装 electron.exe）留下的自启快捷方式指向已卸载的目录：安装版每次启动按当前 exe 重写
  if (app.isPackaged && fs.existsSync(startupLnk())) { try { fs.unlinkSync(startupLnk()); } catch (_) { /* 删不掉就沿用旧的 */ } setAutostart(true); }
  else { config.data.autostart = fs.existsSync(startupLnk()); updateTrayMenu(); }
  if (!app.isPackaged && process.env.AIPET_DEBUG_SCRIPT) {
    try { require(process.env.AIPET_DEBUG_SCRIPT)({ app, petWin: () => petWin, settingsWin: () => settingsWin, setAppearance, refreshAll, sendPet, checkWindows, currentSelection: characterSelection, openSettings, settle, log, ROOT, emit: (ch, payload) => ipcMain.emit(ch, {}, payload), petBox: () => petBox, refreshQuips, shot: async (file, x, y, w, h) => { const { desktopCapturer } = require('electron'); const d = screen.getPrimaryDisplay(); const sf = d.scaleFactor; const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) } }); const src = srcs.find((s) => String(s.display_id) === String(d.id)) || srcs[0]; const img = src.thumbnail.crop({ x: Math.round(x * sf), y: Math.round(y * sf), width: Math.round(w * sf), height: Math.round(h * sf) }); fs.writeFileSync(path.join(ROOT, file), img.toPNG()); log('shot', file); }, capture: async (win, file) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(ROOT, file), img.toPNG()); log('captured', file, win.getBounds()); } }); } catch (e) { log('debug script failed', e); }
  }
  if (process.argv.includes('--smoke-test') && dataDirArg) {
    require('./smoke-test')({ app, petWin: () => petWin, settingsWin: () => settingsWin, setAppearance, config, state, pushData, userData, ROOT, CHARACTERS, winsnap });
  }
});
