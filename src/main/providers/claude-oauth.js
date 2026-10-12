'use strict';
// Claude 订阅（Claude Code OAuth 登录）的 5 小时 / 7 天用量
const { request } = require('../http');
const { base, readJson, num, pick, toEpochSec, fmtCountdown } = require('./util');

async function fetchSnapshot(p) {
  const s = base(p);
  s.kind = 'window';
  const cred = readJson(p.credentialsPath);
  const oauth = cred && (cred.claudeAiOauth || cred.claude_ai_oauth);
  if (!oauth || !oauth.accessToken) { s.error = '未找到 Claude 登录凭据'; return s; }
  if (oauth.expiresAt && num(oauth.expiresAt) < Date.now()) { s.error = '登录令牌已过期（打开 Claude Code 会自动刷新）'; return s; }
  const r = await request('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: 'Bearer ' + oauth.accessToken, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json', 'User-Agent': 'claude-code/2.0 ai-pet' }, timeoutMs: 20000,
  });
  if (!r.ok || !r.data) { s.error = `用量接口 HTTP ${r.status}`; return s; }
  const d = r.data;
  const now = Date.now() / 1000;
  const add = (obj, key, label) => {
    if (!obj) return;
    const used = num(pick(obj, ['utilization', 'used_percent']), null);
    if (used === null) return;
    s.windows.push({ key, label, usedPercent: Math.max(0, Math.min(100, used)), resetsAt: toEpochSec(pick(obj, ['resets_at', 'reset_at'])), windowMinutes: key === 'primary' ? 300 : 10080 });
  };
  add(d.five_hour, 'primary', '5小时');
  add(d.seven_day, 'secondary', '7天');
  add(d.seven_day_opus, 'opus', '7天 Opus');
  add(d.seven_day_sonnet, 'sonnet', '7天 Sonnet');
  if (!s.windows.length) { s.error = '接口无用量字段'; return s; }
  s.ok = true;
  s.plan = oauth.subscriptionType || null;
  const prim = s.windows.find((w) => w.key === 'primary');
  s.fraction = prim ? Math.max(0, 1 - prim.usedPercent / 100) : null;
  s.lines = [];
  if (s.plan) s.lines.push(`Claude ${s.plan}`);
  for (const w of s.windows) {
    const left = w.resetsAt ? fmtCountdown(w.resetsAt - now) : '';
    s.lines.push(`${w.label}已用 ${Math.round(w.usedPercent)}%` + (left ? ` · ${left}后重置` : ''));
  }
  return s;
}
module.exports = { fetchSnapshot };
