'use strict';
// Cursor 是多模型 IDE：同一个窗口里可能用 Claude / GPT / Gemini / Grok……
// 它把「当前 composer 用哪个模型」写在本机 state.vscdb（composerData / aiSettings）。
// 这里只读这些记录，把模型映射成桌宠的模型娘；读不到时返回 null，由调用方回落到 Cursor 的预设立绘。
// 注意：模型选 Auto 时 Cursor 在服务端路由，本机不写真实模型，只能显示「Auto」。
const fs = require('fs');
const path = require('path');

const DEFAULT_DB = path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const APP_USER_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
const SELECTED_KEY = 'cursor/glass.selectedAgent';
const CACHE_MS = 4000;
const CATALOG_MS = 60000;

// 模型名 → 角色。先看模型 id（Cursor 会给 grok 标 vendor=cursor），再看厂商兜底。
// Cursor 自家的 Composer / Muse 没有对应立绘，返回 null 交给回落。
const RULES = [
  [/(^|[-_.])(claude|anthropic|opus|sonnet|haiku)/i, 'claude'],
  [/(^|[-_.])(gpt|openai|codex)/i, 'codex'],
  [/(^|[-_.])o[134]([-_.]|$)/i, 'codex'],
  [/(^|[-_.])(gemini|google)/i, 'gemini'],
  [/(^|[-_.])(grok|xai)/i, 'grok'],
  [/(^|[-_.])(kimi|moonshot)/i, 'kimi'],
  [/(^|[-_.])(glm|zhipu|zai|zcode)/i, 'zcode'],
  [/(^|[-_.])(qwen|qwq|dashscope)/i, 'qwen'],
  [/(^|[-_.])(deepseek)/i, 'deepseek'],
  [/(^|[-_.])(doubao|seed|volc)/i, 'seed'],
];
const VENDOR = { anthropic: 'claude', openai: 'codex', google: 'gemini', xai: 'grok', moonshot: 'kimi', zai: 'zcode', alibaba: 'qwen', deepseek: 'deepseek', bytedance: 'seed', volcengine: 'seed' };

function isAuto(id) { return !id || /^(default|auto)$/i.test(String(id).trim()); }
// 有些版本把参数一起写进 modelName：claude-4.6-sonnet[thinking=true,context=200k]
function bareModel(id) { return String(id || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim(); }

// "claude-opus-4-7" → "Claude Opus 4.7"（拿不到 Cursor 自带的显示名时才用）
function prettyModel(id) {
  const words = bareModel(id).split(/[-_]+/).filter(Boolean);
  const out = words.map((w) => (/^\d+(?:\.\d+)?$/.test(w) ? w : /^(gpt|glm|ai)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)));
  return out.join(' ').replace(/\b(\d+)\s+(\d+)\b/g, '$1.$2');
}

function characterForModel(model, vendor) {
  const id = bareModel(model).toLowerCase();
  if (!id || isAuto(id)) return null;
  for (const [re, ch] of RULES) if (re.test(id)) return ch;
  return VENDOR[String(vendor || '').toLowerCase()] || null;
}

function openDb(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

function appUser(q) {
  try { const row = q.prepare('select value from ItemTable where key = ?').get(APP_USER_KEY); return row ? JSON.parse(String(row.value)) : null; } catch (_) { return null; }
}

// Cursor 的模型目录：serverModelName/name → { label, vendor }，用来显示「Claude Opus 4.7」这种名字
function catalogOf(dbPath, q) {
  const hit = catalogCache.get(dbPath);
  if (hit && Date.now() - hit.at < CATALOG_MS) return hit.map;
  const map = new Map();
  let own = null;
  try {
    if (!q) { own = q = openDb(dbPath); }
    const list = (appUser(q) || {}).availableDefaultModels2;
    for (const m of Array.isArray(list) ? list : []) {
      for (const key of [m && m.name, m && m.serverModelName, m && m.inputboxShortModelName]) {
        if (key) map.set(String(key).toLowerCase(), { label: m.clientDisplayName || prettyModel(key), vendor: m.vendorName || '' });
      }
    }
  } catch (_) { /* 旧版/只读失败：用 id 自己拼显示名 */ }
  finally { if (own) { try { own.close(); } catch (_) { /* */ } } }
  catalogCache.set(dbPath, { at: Date.now(), map });
  return map;
}

function pickModel(data) {
  const mc = (data && data.modelConfig) || {};
  const ids = [mc.modelName];
  for (const s of Array.isArray(mc.selectedModels) ? mc.selectedModels : []) if (s && s.modelId) ids.push(s.modelId);
  const list = ids.map((x) => String(x || '').trim()).filter(Boolean);
  return list.find((x) => !isAuto(x)) || list[0] || '';
}

function selectedComposer(q) {
  let id = '';
  try { const row = q.prepare('select value from ItemTable where key = ?').get(SELECTED_KEY); if (row && row.value) id = String(row.value).trim(); } catch (_) { /* 旧版没有 */ }
  // 选中的可能是子 agent / 已归档的旧 composer：有索引表时确认一下，别按它的模型换娘
  if (id) {
    let ok = true;
    try { const h = q.prepare('select isArchived, isSubagent from composerHeaders where composerId = ?').get(id); if (h) ok = !h.isArchived && !h.isSubagent; } catch (_) { /* 旧版没有这张表 */ }
    if (ok) return id;
  }
  try { const row = q.prepare("select composerId from composerHeaders where isArchived = 0 and isSubagent = 0 and composerId <> 'empty-state-draft' order by recency desc limit 1").get(); if (row) return String(row.composerId); } catch (_) { /* 旧版没有这张表 */ }
  return id;
}

function composerData(q, id) {
  if (!id) return null;
  try { const row = q.prepare('select value from cursorDiskKV where key = ?').get('composerData:' + id); return row ? JSON.parse(String(row.value)) : null; } catch (_) { return null; }
}

// 兜底：没有 composerHeaders 时扫 composerData，按自身时间戳取最新
function newestComposerData(q) {
  try {
    let best = null;
    for (const row of q.prepare("select value from cursorDiskKV where key like 'composerData:%'").all()) {
      let d = null; try { d = JSON.parse(String(row.value)); } catch (_) { continue; }
      const at = Number(d.lastUpdatedAt || d.createdAt || 0);
      if (!best || at > best.at) best = { at, d };
    }
    return best && best.d;
  } catch (_) { return null; }
}

function recency(q, id) {
  try { const row = q.prepare('select recency from composerHeaders where composerId = ?').get(id); return Number(row && row.recency) || 0; } catch (_) { return 0; }
}

function failed(error) { return { ok: false, model: '', label: '', vendor: '', character: null, auto: true, at: 0, error }; }

function read(dbPath = DEFAULT_DB) {
  if (!dbPath || !fs.existsSync(dbPath)) return failed('没找到 Cursor 本机数据');
  let q = null;
  try {
    q = openDb(dbPath);
    const catalog = catalogOf(dbPath, q);
    const id = selectedComposer(q);
    const data = composerData(q, id) || newestComposerData(q);
    let model = pickModel(data);
    if (!model) {
      // 当前 composer 还没写过模型时，看全局 aiSettings 的 composer 配置
      const ai = (appUser(q) || {}).aiSettings || {};
      model = pickModel({ modelConfig: ai.modelConfig && ai.modelConfig.composer });
    }
    const auto = isAuto(model);
    if (auto) model = '';
    const bare = bareModel(model);
    const meta = bare ? (catalog.get(bare.toLowerCase()) || catalog.get(model.toLowerCase())) : null;
    return {
      ok: true,
      model,
      label: auto ? 'Auto' : ((meta && meta.label) || prettyModel(bare)),
      vendor: (meta && meta.vendor) || '',
      character: characterForModel(bare, meta && meta.vendor),
      auto,
      at: recency(q, id) || Date.now(),
    };
  } catch (e) {
    return failed(e.message);
  } finally { if (q) { try { q.close(); } catch (_) { /* */ } } }
}

// dbPath → { at, info }；checkWindows 每秒都会问一次，别每次都开库
// 读失败（Cursor 正在写库/锁住）时沿用上一次成功的结果，避免角色在 4 秒窗口里来回闪
const cache = new Map();
const lastGood = new Map();
const catalogCache = new Map();
function info(dbPath = DEFAULT_DB) {
  const key = dbPath || DEFAULT_DB;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const next = read(key);
  if (next.ok) lastGood.set(key, next);
  else if (lastGood.has(key)) { const prev = lastGood.get(key); cache.set(key, { at: Date.now(), info: prev }); return prev; }
  cache.set(key, { at: Date.now(), info: next });
  return next;
}
function character(dbPath = DEFAULT_DB) {
  const i = info(dbPath);
  return (i && i.character) || 'claude';
}
function resetCache() { cache.clear(); lastGood.clear(); catalogCache.clear(); }

module.exports = { DEFAULT_DB, read, info, character, characterForModel, prettyModel, resetCache };
