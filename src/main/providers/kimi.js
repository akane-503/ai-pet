'use strict';
// Kimi 桌面版（Kimi Work）：读本机 kimi-agent 状态文件，报告上下文用量、当前模型和限流状态。
// 套餐数值额度在会员接口后面，桌面版不把登录令牌交给第三方，本地能拿到的真实数据是：
// 上下文窗口用量、撞额度墙的记录（403/paywall）、当前模型与可选模型、会员等级（JWT claims）。
const fs = require('fs');
const path = require('path');
const { base, readJson, num, fmtCountdown } = require('./util');

const AGENT_DIR = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'), 'kimi-desktop', 'kimi-agent');

// { 会话key: 值 } 里挑 updatedAt 最新的那个
function latestConversation(j) {
  let bestKey = null, at = 0;
  for (const [k, v] of Object.entries(j || {})) {
    const t = Date.parse(v && v.updatedAt) || 0;
    if (t >= at) { at = t; bestKey = k; }
  }
  if (!bestKey && j && Object.keys(j).length) bestKey = Object.keys(j).pop();
  return bestKey;
}

// latest:<workspaceId> 单桶；返回 [{ key, name, efforts }]
function readModels(dir) {
  const j = readJson(path.join(dir, 'kimi-work-models-cache.json'));
  const bucket = j && j[Object.keys(j)[0]];
  return ((bucket && bucket.models) || []).map((m) => ({
    key: m.key || m.modelId,
    name: m.displayName || m.key || m.modelId,
    efforts: (m.reasoningEffortOptions || []).map((e) => String(e.effort || '').replace(/^REASONING_EFFORT_/, '').toLowerCase()).filter(Boolean),
  })).filter((m) => m.key);
}

function thinkingLabel(level) {
  const map = { low: '低', medium: '中', high: '高', max: '超高', ultra: '超高' };
  const k = String(level || '').toLowerCase().replace(/^reasoning_effort_/, '');
  return map[k] || (k ? k : null);
}

// 会话撞额度墙：paywallTrigger=work_rate_limit_exceeded 或状态 blocked
function rateLimited(dir) {
  const errs = readJson(path.join(dir, 'conversation-errors.json'));
  for (const v of Object.values(errs || {})) {
    const list = Array.isArray(v) ? v : safeParse(v) || [];
    for (const item of list) {
      const j = typeof item === 'string' ? safeParse(item) : item;
      if (j && (j.paywallTrigger === 'work_rate_limit_exceeded' || /rate_limit/.test(String(j.paywallTrigger || '')))) return true;
    }
  }
  const st = readJson(path.join(dir, 'conversation-statuses.json'));
  for (const v of Object.values(st || {})) if (v === 'blocked') return true;
  return false;
}
function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// 会员等级藏在 Local Storage 的 JWT claims 里；access 半小时就过期，refresh 十来天，看 refresh 的等级足够
function membershipLevel(root) {
  const dir = path.join(root, 'Local Storage', 'leveldb');
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(log|ldb)$/.test(f)) continue;
      const text = fs.readFileSync(path.join(dir, f)).toString('latin1');
      for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
        let claims = null;
        try { claims = JSON.parse(Buffer.from(m[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (_) { continue; }
        if (!claims || (claims.typ !== 'refresh' && claims.type !== 'refresh')) continue;
        const iat = num(claims.iat, 0);
        if (!best || iat > best.iat) best = { iat, level: num((claims.membership || {}).level) ?? num((claims.code_membership || {}).level) };
      }
    }
  } catch (_) { /* 没登录或读不到就当没有 */ }
  return best && best.level !== null ? best.level : null;
}

async function fetchSnapshot(p) {
  const s = base(p);
  s.kind = 'window';
  const dir = p.agentDir || AGENT_DIR;
  if (!fs.existsSync(dir)) { s.error = '没找到 Kimi 桌面版数据（未安装，或还没打开过 Kimi）'; return s; }

  const models = readModels(dir);
  const usageKey = latestConversation(readJson(path.join(dir, 'conversation-context-usage.json')));
  const usageAll = readJson(path.join(dir, 'conversation-context-usage.json')) || {};
  const usage = usageKey ? usageAll[usageKey] : null;
  const modelAll = readJson(path.join(dir, 'conversation-kimi-work-models.json')) || {};
  const modelKey = (usageKey && modelAll[usageKey] && modelAll[usageKey].modelKey) || (Object.values(modelAll)[0] || {}).modelKey || null;
  const thinking = (usageKey && modelAll[usageKey] && modelAll[usageKey].thinkingLevel) || (Object.values(modelAll)[0] || {}).thinkingLevel || null;
  const meta = models.find((m) => m.key === modelKey);
  const modelName = meta ? meta.name : modelKey;
  if (modelName) s.extra.model = modelName;
  const tl = thinkingLabel(thinking);
  if (tl) s.extra.thinking = tl;
  if (models.length) s.models = models.map((m) => m.name);

  const used = num(usage && usage.contextUsage, null);
  if (used !== null) s.windows.push({ key: 'context', label: '上下文', usedPercent: Math.round(used * 1000) / 10, resetsAt: null });
  const wall = rateLimited(dir);
  if (wall) s.windows.push({ key: 'work', label: 'Work 额度', usedPercent: 100, resetsAt: null });

  const level = membershipLevel(path.dirname(dir));
  if (level !== null) { s.plan = '会员 L' + level; s.extra.membershipLevel = level; }

  s.ok = true;
  s.source = 'local';
  s.at = statMtime(path.join(dir, 'conversation-context-usage.json')) || Date.now();
  s.fraction = used !== null ? Math.max(0, Math.min(1, 1 - used)) : null;
  s.lines = [];
  if (used !== null || modelName) {
    s.lines.push(modelName ? `Kimi Work · ${modelName}${tl ? `（推理${tl}）` : ''}` : 'Kimi Work 未选模型');
    if (used !== null) s.lines.push(`上下文已用 ${Math.round(used * 100)}% · 剩 ${Math.round((num(usage.remainingContextTokens) || 0) / 1000)}k tokens`);
    s.lines.push(wall ? 'Work 额度已用完，等下个周期刷新' : '最近没撞额度墙');
  } else {
    s.lines.push('还没开过 Kimi Work 会话');
  }
  return s;
}

function statMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; } }

module.exports = { fetchSnapshot, readModels, rateLimited, membershipLevel, latestConversation, thinkingLabel, AGENT_DIR };
