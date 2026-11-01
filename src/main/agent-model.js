'use strict';
// 多模型 agent 工具的「当前模型」读取，供桌宠角色跟随（与 cursor-model 同一套映射规则）。
// WorkBuddy：每条会话在 ~/.workbuddy/workbuddy.db 的 sessions 表里记 model，取最近活跃未删除的一条。
// 元宝（WebView2 的 localStorage leveldb）与 Trae（AI 会话库 ModularData/ai-agent/database.db 加密，
// state.vscdb 的 model_list_map 只有模型目录、无选中标记）都无法可靠读到当前模型——不编造，回落 look。
const fs = require('fs');
const path = require('path');
const { characterForModel, prettyModel } = require('./cursor-model');

const WORKBUDDY_DB = path.join(process.env.USERPROFILE || '', '.workbuddy', 'workbuddy.db');
const CACHE_MS = 4000;
// WorkBuddy 自家档位名（算力档，不是厂商模型）：别拿去映射，原样显示
const TIER_RE = /^(?:fast|smart|auto|default)[-_ ]?model$/i;

function readWorkbuddy(dbPath = WORKBUDDY_DB) {
  const fail = (error) => ({ ok: false, model: '', label: '', character: null, auto: true, at: 0, error });
  if (!dbPath || !fs.existsSync(dbPath)) return fail('没找到 WorkBuddy 本地数据');
  let q = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    q = new DatabaseSync(dbPath, { readOnly: true });
    const row = q.prepare("select model, updated_at from sessions where deleted_at is null and model is not null and model <> '' order by updated_at desc limit 1").get();
    if (!row) return { ok: true, model: '', label: '', character: null, auto: true, at: 0, error: null };
    const model = String(row.model).trim();
    const tier = TIER_RE.test(model);
    return {
      ok: true,
      model,
      label: tier ? model : prettyModel(model),
      character: tier ? null : characterForModel(model, ''),
      auto: tier,
      at: Number(row.updated_at || 0) / 1000,
      error: null,
    };
  } catch (e) {
    return fail(e.message);
  } finally { if (q) { try { q.close(); } catch (_) { /* */ } } }
}

const READERS = { workbuddy: readWorkbuddy };
const cache = new Map();
const lastGood = new Map();
function readModelFile(file, field) {
  try {
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('模型状态文件超过 1 MB');
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const value = field ? String(field).split('.').reduce((v,k)=>v?.[k],JSON.parse(text)) : text.trim();
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('模型字段必须是长度不超过 256 的非空字符串');
    const model=value.trim(), auto=TIER_RE.test(model)||/^(auto|default)$/i.test(model);
    return {ok:true,model,label:auto?model:prettyModel(model),character:auto?null:characterForModel(model,''),auto,at:fs.statSync(file).mtimeMs};
  } catch(e) { return {ok:false,model:'',label:'',character:null,auto:true,error:e.message}; }
}
function info(agentId, { dbPath, modelFile, modelPath } = {}) {
  const reader = modelFile ? () => readModelFile(modelFile, modelPath) : READERS[agentId];
  if (!reader) return null;
  const cacheKey = JSON.stringify([agentId,dbPath||'',modelFile||'',modelPath||'']);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const next = reader(dbPath);
  // 读失败（工具正写库/锁住）沿用上一次成功结果，避免角色闪动；读到档位名是真实状态，不沿用
  if (next.ok) lastGood.set(cacheKey, next);
  else if (lastGood.has(cacheKey) && !modelFile) { const prev = lastGood.get(cacheKey); cache.set(cacheKey, { at: Date.now(), info: prev }); return prev; }
  cache.set(cacheKey, { at: Date.now(), info: next });
  return next;
}
function resetCache() { cache.clear(); lastGood.clear(); }

module.exports = { info, resetCache, readWorkbuddy, readModelFile, WORKBUDDY_DB };
