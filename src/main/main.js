'use strict';
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, Notification, shell, nativeImage, powerMonitor, dialog } = require('electron');
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
const geometry = require('../shared/geometry');

const ROOT = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'assets');
const IS_WIN = process.platform === 'win32';
const dataDirArg = process.argv.find((arg) => arg.startsWith('--data-dir='));
if (dataDirArg) app.setPath('userData', path.resolve(dataDirArg.slice('--data-dir='.length)));

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if (IS_WIN) app.setAppUserModelId(app.isPackaged ? 'com.akane503.aipet' : process.execPath);

const userData = app.getPath('userData');
const config = new JsonStore(path.join(userData, 'config.json'), defaultConfig);
const state = new JsonStore(path.join(userData, 'state.json'), defaultState);
config.load(); state.load();

// colors: [描边/主色, 正文, 提示]
const CHARACTERS = [
  { id: 'deepseek', name: '鲸鱼娘 · DeepSeek', keys: ['deepseek'], colors: ['#203170', '#536ba9', '#7b8cb3'] },
  { id: 'codex', name: '龙娘 · GPT / Codex', keys: ['codex', 'openai', 'gpt'], colors: ['#66547d', '#89739f', '#a294b4'] },
  { id: 'claude', name: 'Claude 娘', keys: ['claude', 'anthropic'], colors: ['#8a3d12', '#bc602f', '#b88a72'] },
  { id: 'zcode', name: 'Zcode 黑狐娘 · 智谱 GLM', keys: ['glm', 'zhipu', 'zcode'], colors: ['#363343', '#5a556a', '#8f899c'] },
  { id: 'gemini', name: 'Gemini 猫娘', keys: ['gemini'], colors: ['#6656ac', '#8670c6', '#a494bc'] },
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
let foreground = { character: null, at: 0 };           // 当前前台窗口对应的 agent
let knownAgentWins = null;                              // 上次看到的 agent 窗口 hwnd -> 角色
function charOf(key) {
  const p = enabledProviders().find((x) => x.type === key || (key === 'zcode' && x.type === 'zhipu'));
  if (p && p.character) return p.character;
  const c = allCharacters().find((x) => x.keys.includes(key) || x.id === key);
  return c ? c.id : null;
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
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
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

function characterSelection() { return activity.selectCharacter({ appearance: config.data.appearance, foreground, recent, activity: lastActivity, charOf }); }
function resolveCharacter() { return characterSelection().character; }
// 正在消耗额度的数据源：最近窗口期内活跃的 agent → provider（最近的在前），再加当前角色对应的
function activeProviderIds() {
  const now = Date.now(); const windowMs = 90000;
  const det = Object.entries((lastActivity && lastActivity.details) || {}).filter(([, t]) => now - t < windowMs).sort((a, b) => b[1] - a[1]);
  const ps = enabledProviders(); const out = [];
  const add = (p) => { if (p && !out.includes(p.id)) out.push(p.id); };
  const forChar = (c) => { if (c === 'deepseek') ps.filter((p) => p.type === 'deepseek').forEach(add); else if (c === 'codex') ps.filter((p) => p.type === 'codex').forEach(add); else if (c === 'zcode') ps.filter((p) => p.type === 'zhipu').forEach(add); else if (c === 'claude') ps.filter((p) => p.type === 'claude-oauth' || p.type === 'newapi' || p.type === 'openai').forEach(add); else ps.filter((p) => p.character === c).forEach(add); };
  // 当前角色对应的排最前，然后是最近打开的，再是窗口期内活跃的
  const cur = currentCharacter || resolveCharacter();
  forChar(cur);
  for (const [k] of det) forChar(charOf(k) || k);
  return out;
}
// ---------- 台词生成（DeepSeek API） ----------
let quipsBusy = false;
function quipsKey() { const q = config.data.quips || {}; if (q.apiKey) return q.apiKey; const ds = (config.data.providers || []).find((p) => p.type === 'deepseek' && p.apiKey); return ds ? ds.apiKey : ''; }
async function refreshQuips({ force = false } = {}) {
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
      const c = charOf(fgc) || fgc;
      foreground = { character: c, at: Date.now() };
      recent = { character: c, at: Date.now(), reason: 'focus' };
    } else foreground = { character: null, at: 0 };
    const wins = winsnap.titledWindows();
    const agentWins = new Map();
    for (const w of wins) { const c = activity.routeForWindow(w, config.data.activity, config.data.providers, agents()); if (c && !w.iconic) agentWins.set(w.hwnd, charOf(c) || c); }
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
    snapshots: state.data.snapshots, ledgers: state.data.ledgers, config: publicConfig(), activity: lastActivity, character,
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
  if (nc.bubble && !quiet) { if (petReady) sendPet('notify', n); else pendingNotices.push(n); }
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
        if (prev && prev.ok) state.data.snapshots[p.id] = { ...prev, stale: true, error: s.error, lastTry: now };
        else state.data.snapshots[p.id] = { ...s, stale: false };
        log('provider failed', p.id, s.error);
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
    { label: `🚀 打开 ${(launcher.resolve(currentCharacter || resolveCharacter(), launchCfg()) || {}).label || '对应工具'}`, click: () => launchCurrent() },
    { label: '🚀 打开其他…', submenu: allCharacters().map((c) => { const sp = launcher.resolve(c.id, launchCfg()); return { label: `${c.name}${sp ? ' → ' + sp.label : ''}`, enabled: !!sp, click: () => launchFor(c.id) }; }) },
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
  return [
    ...all.slice(0, 2),
    { type: 'separator' },
    ...all.slice(4, 8), // 气泡 / 台词 / 摸头 / 消息
    { type: 'separator' },
    { label: '🎛 快捷面板', click: () => togglePanel() },
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

async function launchFor(characterId) {
  const r = await launcher.launch(characterId, launchCfg());
  if (r.ok) { recent = { character: characterId, at: Date.now(), reason: 'launch' }; pushData(); }
  log('launch', characterId, r);
  sendPet('cmd', { name: 'say', seconds: r.ok ? 1.2 : 3, restoreInfo: true, lines: [{ t: r.ok ? (r.already ? '已经开着啦~' : '出发！') : '打不开...', s: 'P', c: r.ok ? '' : '#e0433f' }, { t: r.message, s: 'C', w: true }] });
}
function launchCurrent() { launchFor(currentCharacter || resolveCharacter()); }

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

function startupLnk() { return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'AI 桌宠.lnk'); }
function setAutostart(on) {
  config.data.autostart = !!on; config.saveSoon();
  try {
    if (!on) { if (fs.existsSync(startupLnk())) fs.unlinkSync(startupLnk()); }
    else if (!fs.existsSync(startupLnk())) {
      const ps = `$ws = New-Object -ComObject WScript.Shell; $l = $ws.CreateShortcut(${JSON.stringify(startupLnk()).replace(/"/g, "'")}); $l.TargetPath = ${JSON.stringify(process.execPath).replace(/"/g, "'")}; $l.Arguments = '"${ROOT.replace(/\\/g, '\\\\')}"'; $l.WorkingDirectory = ${JSON.stringify(ROOT).replace(/"/g, "'")}; $l.IconLocation = ${JSON.stringify(path.join(ASSETS, 'app.ico')).replace(/"/g, "'")}; $l.Save()`;
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
ipcMain.on('mouse:ignore', (e, ignore) => { if (petWin) petWin.setIgnoreMouseEvents(!!ignore, { forward: true }); });
ipcMain.on('drag:start', (e, pt) => { if (!petWin) return; stopAnimation(); closePanel(); const b = petWin.getBounds(); drag = { sx: pt.x, sy: pt.y, wx: b.x, wy: b.y }; attach = null; pendingSettle = null; clearInterval(attachTimer); });
ipcMain.on('drag:move', (e, pt) => { if (!petWin || !drag) return; movePet(drag.wx + pt.x - drag.sx, drag.wy + pt.y - drag.sy); });
ipcMain.on('drag:end', () => { if (!petWin) return; drag = null; settle(); });
ipcMain.on('context-menu', () => { if (petWin) Menu.buildFromTemplate(petMenuTemplate()).popup({ window: petWin }); });
ipcMain.on('panel:toggle', () => togglePanel());
ipcMain.on('panel:close', () => closePanel());
ipcMain.on('panel:size', (e, { h }) => { if (!panelWin || panelWin.isDestroyed()) return; const b = panelWin.getBounds(); if (panelShown && Math.abs(b.height - h) < 2) return; showPanelAt(h); });
ipcMain.on('panel:ready', () => pushData());
ipcMain.on('cmd:pet', (e, c) => sendPet('cmd', c));
ipcMain.on('open-settings', (e, tab) => openSettings(tab));
ipcMain.on('launch', (e, id) => (id ? launchFor(id) : launchCurrent()));
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
ipcMain.handle('provider:test', async (e, p) => providers.fetchSnapshot(p, { wantModels: true }));
ipcMain.handle('importers:scan', async () => importers.scan());
ipcMain.handle('meta', () => ({ types: providers.TYPE_META, characters: allCharacters(), characterImages: characterImages(), userData, root: ROOT, snapAvailable: winsnap.available(), version: app.getVersion(), electron: process.versions.electron }));
ipcMain.handle('state:get', () => state.data);
ipcMain.handle('notifications:list', () => state.data.notifications);
ipcMain.handle('pick-file', async () => { const r = await dialog.showOpenDialog({ properties: ['openFile', 'showHiddenFiles'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('pick-dir', async () => { const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'showHiddenFiles'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('activity:now', () => { checkActivity(); return lastActivity; });

// ---------- 生命周期 ----------
app.on('second-instance', () => { if (petWin) { petWin.show(); sendPet('cmd', { name: 'bubble' }); } });
app.on('window-all-closed', (e) => { /* 托盘常驻 */ });
app.on('before-quit', () => { quitting = true; closePanel(); config.save(); state.save(); });

app.whenReady().then(() => {
  updateScreenAreas();
  const firstRun = !config.data.firstRunDone;
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
  setTimeout(() => refreshQuips(), 20000); setInterval(() => refreshQuips(), 10 * 60000);
  powerMonitor.on('resume', () => setTimeout(() => refreshAll({ force: true, reason: 'resume' }), 5000));
  screen.on('display-metrics-changed', () => setTimeout(() => { updateScreenAreas(); ensureOnScreen(); }, 500));
  config.data.autostart = fs.existsSync(startupLnk()); updateTrayMenu();
  if (!app.isPackaged && process.env.AIPET_DEBUG_SCRIPT) {
    try { require(process.env.AIPET_DEBUG_SCRIPT)({ app, petWin: () => petWin, settingsWin: () => settingsWin, setAppearance, refreshAll, sendPet, checkWindows, currentSelection: characterSelection, openSettings, settle, log, ROOT, emit: (ch, payload) => ipcMain.emit(ch, {}, payload), petBox: () => petBox, refreshQuips, shot: async (file, x, y, w, h) => { const { desktopCapturer } = require('electron'); const d = screen.getPrimaryDisplay(); const sf = d.scaleFactor; const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) } }); const src = srcs.find((s) => String(s.display_id) === String(d.id)) || srcs[0]; const img = src.thumbnail.crop({ x: Math.round(x * sf), y: Math.round(y * sf), width: Math.round(w * sf), height: Math.round(h * sf) }); fs.writeFileSync(path.join(ROOT, file), img.toPNG()); log('shot', file); }, capture: async (win, file) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(ROOT, file), img.toPNG()); log('captured', file, win.getBounds()); } }); } catch (e) { log('debug script failed', e); }
  }
  if (process.argv.includes('--smoke-test') && dataDirArg) {
    require('./smoke-test')({ app, petWin: () => petWin, settingsWin: () => settingsWin, setAppearance, config, state, pushData, userData, ROOT, CHARACTERS, winsnap });
  }
});
