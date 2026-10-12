'use strict';
// Codex / ChatGPT 账号用量：优先 wham/usage 接口，失败时从本地 session 日志中取最近一次 rate_limits
const fs = require('fs');
const path = require('path');
const { request } = require('../http');
const { base, readJson, num, pick, toEpochSec, fmtCountdown } = require('./util');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function decodeJwt(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (_) { return null; }
}

function windowFrom(obj, key, label) {
  if (!obj) return null;
  const used = num(pick(obj, ['used_percent', 'usedPercent', 'utilization']), null);
  if (used === null) return null;
  let resetsAt = toEpochSec(pick(obj, ['resets_at', 'reset_at', 'resetsAt', 'reset_time']));
  const after = num(pick(obj, ['reset_after_seconds', 'resets_in_seconds', 'reset_in_seconds']), null);
  if (resetsAt === null && after !== null) resetsAt = Math.round(Date.now() / 1000 + after);
  let windowMinutes = num(pick(obj, ['window_minutes', 'windowMinutes']), null);
  const ws = num(pick(obj, ['limit_window_seconds', 'window_seconds']), null);
  if (windowMinutes === null && ws !== null) windowMinutes = Math.round(ws / 60);
  return { key, label: label || (windowMinutes >= 10000 ? '7天' : windowMinutes >= 240 ? '5小时' : `${windowMinutes}分`), usedPercent: used, resetsAt, windowMinutes };
}

function parseRateLimit(rl) {
  if (!rl) return [];
  const ws = [];
  const p = windowFrom(pick(rl, ['primary_window', 'primary']), 'primary');
  const s = windowFrom(pick(rl, ['secondary_window', 'secondary']), 'secondary');
  if (p) ws.push(p);
  if (s) ws.push(s);
  return ws;
}

// 从 session 日志（rollout-*.jsonl）中找最近的 rate_limits
function fromSessionLogs(codexHome) {
  try {
    const root = path.join(codexHome, 'sessions');
    if (!fs.existsSync(root)) return null;
    const files = [];
    const years = fs.readdirSync(root).filter((x) => /^\d{4}$/.test(x)).sort().slice(-1);
    for (const y of years) {
      const months = fs.readdirSync(path.join(root, y)).filter((x) => /^\d{2}$/.test(x)).sort().slice(-2);
      for (const m of months) {
        const days = fs.readdirSync(path.join(root, y, m)).filter((x) => /^\d{2}$/.test(x)).sort().slice(-3);
        for (const d of days) {
          const dir = path.join(root, y, m, d);
          for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.jsonl')) continue;
            const fp = path.join(dir, f);
            try { files.push({ fp, mtime: fs.statSync(fp).mtimeMs }); } catch (_) { /* */ }
          }
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (const { fp, mtime } of files.slice(0, 4)) {
      const size = fs.statSync(fp).size;
      const start = Math.max(0, size - 400000);
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      let idx = text.lastIndexOf('"rate_limits"');
      while (idx >= 0) {
        const lineStart = text.lastIndexOf('\n', idx) + 1;
        const lineEnd = text.indexOf('\n', idx);
        const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
        try {
          const j = JSON.parse(line);
          const rl = j.payload && j.payload.rate_limits ? j.payload.rate_limits : (j.rate_limits || null);
          if (rl) {
            const ws = parseRateLimit(rl);
            if (ws.length) return { windows: ws, credits: rl.credits || null, at: (j.timestamp ? Date.parse(j.timestamp) : mtime) || mtime, planType: rl.plan_type || null };
          }
        } catch (_) { /* skip */ }
        idx = text.lastIndexOf('"rate_limits"', lineStart - 2);
      }
    }
  } catch (e) { console.warn('[codex] session log parse failed', e.message); }
  return null;
}

function readModelsCache(codexHome) {
  const j = readJson(path.join(codexHome, 'models_cache.json'));
  if (!j || !Array.isArray(j.models)) return null;
  return j.models.filter((m) => m.visibility !== 'hide').map((m) => m.slug || m.display_name).filter(Boolean).sort();
}

function readCurrentModel(codexHome) {
  try {
    const t = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(t);
    const mp = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(t);
    return { model: m ? m[1] : null, provider: mp ? mp[1] : null };
  } catch (_) { return { model: null, provider: null }; }
}

async function fetchSnapshot(p) {
  const s = base(p);
  s.kind = 'window';
  const home = p.codexHome || path.dirname(p.authPath || '');
  const auth = readJson(p.authPath || path.join(home, 'auth.json'));
  const cur = readCurrentModel(home);
  s.extra.model = cur.model;
  s.extra.modelProvider = cur.provider;
  s.models = readModelsCache(home);
  let apiErr = null;
  if (auth && auth.tokens && auth.tokens.access_token) {
    const tok = auth.tokens.access_token;
    const claims = decodeJwt(tok) || {};
    const authClaims = claims['https://api.openai.com/auth'] || {};
    const accountId = auth.tokens.account_id || authClaims.chatgpt_account_id || null;
    const exp = num(claims.exp, null);
    if (exp && exp * 1000 < Date.now() - 60000) {
      apiErr = '登录令牌已过期（等 Codex 自动刷新）';
    } else {
      try {
        const headers = {
          Authorization: 'Bearer ' + tok,
          'User-Agent': 'codex_cli_rs/0.70.0 (Windows 10.0; x86_64) ai-pet',
          originator: 'codex_cli_rs',
          Accept: 'application/json',
        };
        if (accountId) headers['ChatGPT-Account-Id'] = accountId;
        const r = await request(USAGE_URL, { headers, timeoutMs: 20000 });
        if (r.ok && r.data) {
          const d = r.data;
          const ws = parseRateLimit(d.rate_limit || d.rate_limits || d);
          if (ws.length) {
            s.ok = true; s.windows = ws; s.source = 'api';
            s.plan = d.plan_type || authClaims.chatgpt_plan_type || null;
            s.credits = d.credits || null;
          } else apiErr = '接口返回无额度字段';
        } else apiErr = `用量接口 HTTP ${r.status}` + (r.status === 403 ? '（可能被 Cloudflare 拦截）' : '');
      } catch (e) { apiErr = '用量接口失败: ' + e.message; }
    }
    if (!s.plan) s.plan = authClaims.chatgpt_plan_type || null;
  } else {
    apiErr = auth ? '未找到 ChatGPT 登录令牌（API Key 模式无额度窗口）' : '未找到 auth.json';
  }
  if (!s.ok) {
    const log = fromSessionLogs(home);
    if (log) {
      s.ok = true; s.windows = log.windows; s.credits = log.credits; s.source = 'session-log'; s.at = log.at;
      s.extra.apiError = apiErr; s.extra.logAt = log.at;
    } else { s.error = apiErr || '无可用数据'; }
  }
  // 已过重置时间的窗口视为归零
  const now = Date.now() / 1000;
  for (const w of s.windows) {
    if (w.resetsAt && w.resetsAt < now) { w.usedPercent = 0; w.expired = true; }
  }
  const prim = s.windows.find((w) => w.key === 'primary');
  s.fraction = prim ? Math.max(0, 1 - prim.usedPercent / 100) : null;
  s.lines = [];
  if (s.plan) s.lines.push(`套餐 ${String(s.plan).toUpperCase()}` + (s.extra.model ? ` · ${s.extra.model}` : ''));
  for (const w of s.windows) {
    const left = w.resetsAt ? fmtCountdown(w.resetsAt - now) : '';
    s.lines.push(`${w.label}已用 ${Math.round(w.usedPercent)}%` + (left ? ` · ${left}后重置` : ''));
  }
  if (s.source === 'session-log') s.lines.push('（来自本地会话日志）');
  return s;
}

module.exports = { fetchSnapshot, fromSessionLogs, readModelsCache, readCurrentModel };
