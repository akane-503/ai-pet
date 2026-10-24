'use strict';
// Gemini CLI 额度：官方 OAuth（cloudcode-pa 剩余配额）或中转站（new-api 计费）
// 数据来源：
//   ~/.gemini/.env            GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY（走中转站时）
//   ~/.gemini/oauth_creds.json 官方登录凭据（oauth-personal）
//   ~/.gemini/settings.json    security.auth.selectedType（用于给出更准的错误提示）
const fs = require('fs');
const path = require('path');
const { request } = require('../http');
const { base, readJson, num, pick, toEpochSec, fmtMoney, fmtCountdown } = require('./util');
const newapi = require('./newapi');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const GEMINI_DIR = path.join(HOME, '.gemini');
const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const OFFICIAL_RE = /(^|\.)googleapis\.com$/i;
const LABELS = { pro: 'Pro 模型', flash: 'Flash 模型', other: '其他模型' };

function hostOf(u) { try { return new URL(u).hostname; } catch (_) { return ''; } }

// .env 是 KEY=VALUE 明文，允许注释、空行、引号
function readEnvFile(file) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function detect(p) {
  const dir = p.geminiDir || GEMINI_DIR;
  const env = readEnvFile(p.envPath || path.join(dir, '.env'));
  const settings = readJson(path.join(dir, 'settings.json')) || {};
  const authType = (settings.security && settings.security.auth && settings.security.auth.selectedType) || '';
  const baseUrl = String(p.baseUrl || env.GOOGLE_GEMINI_BASE_URL || env.GEMINI_BASE_URL || '').trim();
  const apiKey = String(p.apiKey || env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '').trim();
  return { dir, baseUrl, apiKey, authType };
}

async function fetchSnapshot(p, ctx) {
  const s = base(p);
  const det = detect(p);
  // auth: auto（有中转站地址就走中转站）| relay | oauth
  const explicitOfficial = p.auth === 'oauth';
  let relayBase = '';
  if (!explicitOfficial) {
    const candidate = p.auth === 'relay' ? (p.baseUrl || det.baseUrl) : (det.baseUrl || p.baseUrl);
    if (candidate) { const b = newapi.normBase(candidate); if (!OFFICIAL_RE.test(hostOf(b))) relayBase = b; }
  }
  if (p.auth === 'relay' && !relayBase) { s.error = '没找到中转站地址：填「地址」或在 ~/.gemini/.env 里配 GOOGLE_GEMINI_BASE_URL'; return s; }
  s.relay = !!relayBase;
  s.source = relayBase ? 'relay' : 'oauth';
  if (relayBase) return relay(p, s, relayBase, det, ctx);
  return official(p, s, det);
}

// ---------- 中转站：Gemini CLI 只是把地址指过去，额度仍记在中转站账号/Key 上 ----------
async function relay(p, s, baseUrl, det, ctx) {
  const apiKey = p.apiKey || det.apiKey;
  if (!apiKey && !(p.accessToken && p.userId)) { s.error = '中转站没找到 Key：填 API Key，或在 ~/.gemini/.env 里配 GEMINI_API_KEY'; return s; }
  const r = await newapi.fetchSnapshot({ id: p.id, type: 'newapi', name: p.name, baseUrl, apiKey, accessToken: p.accessToken, userId: p.userId, announcements: false }, ctx);
  if (!r.ok) { s.error = '中转站：' + (r.error || '查询失败'); return s; }
  s.ok = true; s.relay = true; s.kind = 'balance'; s.source = 'relay';
  s.currency = r.currency || 'USD';
  s.balance = r.balance; s.usedTotal = r.usedTotal; s.extra = r.extra || {};
  if (r.models) s.models = r.models;
  s.lines = [`Gemini 走中转站 ${baseUrl.replace(/^https?:\/\//, '')}`];
  if (Number.isFinite(s.balance)) s.lines.push(`余额 ${fmtMoney(s.balance, s.currency)}`);
  else s.lines.push('今日用量未知，接口仅提供累计值');
  if (!p.accessToken && Number.isFinite(s.usedTotal)) s.lines.push('填「系统访问令牌 + 用户ID」可看账户余额');
  return s;
}

// ---------- 官方 OAuth：Gemini CLI 的 cloudcode-pa 配额（按模型组返回剩余比例） ----------
function tierLabel(id) {
  const t = String(id || '').toLowerCase();
  if (t === 'standard-tier') return 'Pro';
  if (t === 'free-tier') return 'Free';
  if (t === 'legacy-tier') return 'Legacy';
  return '';
}

async function official(p, s, det) {
  const credPath = p.credentialsPath || path.join(det.dir, 'oauth_creds.json');
  const cred = readJson(credPath);
  const token = cred && (cred.access_token || cred.accessToken);
  if (!token) {
    s.error = p.auth === 'oauth' || det.authType === 'oauth-personal'
      ? '没找到 Gemini CLI 登录凭据（~/.gemini/oauth_creds.json），先用 gemini 登录一次'
      : 'Gemini 走的是 API Key 直连，没有额度接口；填中转站地址，或用 Gemini CLI OAuth 登录';
    return s;
  }
  const exp = num(pick(cred, ['expiry_date', 'expiresAt']));
  if (exp && exp < Date.now() - 60000) { s.error = 'Gemini 登录令牌已过期（打开 Gemini CLI 会自动续期）'; return s; }
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'ai-pet' };
  let project = String(p.project || process.env.GOOGLE_CLOUD_PROJECT || '').trim();
  let tier = '';
  try {
    const la = await request(LOAD_URL, { method: 'POST', headers, body: JSON.stringify({ metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } }), timeoutMs: 20000 });
    if (la.ok && la.data) {
      const tierObj = la.data.currentTier || (Array.isArray(la.data.allowedTiers) ? la.data.allowedTiers[0] : null);
      tier = (tierObj && (tierObj.id || tierObj.name)) || '';
      project = project || String(la.data.cloudaicompanionProject || '');
    }
  } catch (_) { /* 项目/tier 只影响可选信息 */ }
  const q = await request(QUOTA_URL, { method: 'POST', headers, body: JSON.stringify(project ? { project } : {}), timeoutMs: 20000 });
  if (!q.ok || !q.data) { s.error = `Gemini 额度接口 HTTP ${q.status}`; return s; }
  const buckets = Array.isArray(q.data.buckets) ? q.data.buckets : [];
  const groups = new Map();
  for (const b of buckets) {
    const frac = num(pick(b, ['remainingFraction', 'remaining_fraction']), null);
    if (frac === null || frac < 0) continue;
    const id = String(pick(b, ['modelId', 'model_id'], ''));
    const key = /pro/i.test(id) ? 'pro' : /flash|lite/i.test(id) ? 'flash' : 'other';
    const prev = groups.get(key);
    if (!prev || frac < prev.frac) groups.set(key, { frac, reset: toEpochSec(pick(b, ['resetTime', 'reset_time'])), model: id });
  }
  for (const key of ['pro', 'flash', 'other']) {
    const g = groups.get(key); if (!g) continue;
    s.windows.push({ key, label: LABELS[key], usedPercent: Math.max(0, Math.min(100, (1 - g.frac) * 100)), resetsAt: g.reset, windowMinutes: 1440 });
  }
  if (!s.windows.length) { s.error = 'Gemini 额度接口没有返回可用模型'; return s; }
  s.ok = true;
  s.kind = 'window';
  s.plan = tierLabel(tier) || null;
  s.fraction = Math.max(0, Math.min(1, 1 - s.windows[0].usedPercent / 100));
  s.lines = s.plan ? [`Gemini ${s.plan}`] : [];
  for (const w of s.windows) {
    const left = w.resetsAt ? fmtCountdown(w.resetsAt - Date.now() / 1000) : '';
    s.lines.push(`${w.label}已用 ${Math.round(w.usedPercent)}%` + (left ? ` · ${left}后重置` : ''));
  }
  return s;
}

module.exports = { fetchSnapshot, readEnvFile, detect, tierLabel };
