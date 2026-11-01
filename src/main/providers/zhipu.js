'use strict';
// 智谱 GLM Coding Plan / Z.ai：额度窗口查询
const { request } = require('../http');
const { base, num, pick, toEpochSec, fmtCountdown } = require('./util');

function normBase(u) { return String(u || 'https://api.z.ai').trim().replace(/\/+$/, '').replace(/\/api\/paas\/v4$/, ''); }

// 与 ZCode 客户端一致：3=小时、5=月、6=周；不能从重置时间猜测免费体验。
const UNIT_NAME = { 3: '小时', 5: '月', 6: '周' };
function windowLabel(l) {
  const t = String(l.type || '').toUpperCase();
  const what = t.includes('TOKEN') ? 'Token' : t.includes('TIME') || t.includes('MCP') ? 'MCP' : t.includes('CREDIT') ? '积分' : '额度';
  const n = Number(l.number) || 0, u = UNIT_NAME[l.unit] || '';
  const span = n && u ? (n === 1 && Number(l.unit) === 6 ? '每周' : n === 1 && Number(l.unit) === 5 ? '每月' : `${n}${u}`) : '';
  return (span ? span + ' ' : '') + what;
}
function windowMinutes(l) { const n = Number(l.number) || 0; const m = { 3: 60, 5: 43200, 6: 10080 }[l.unit]; return n && m ? Math.round(n * m) : null; }

function zhipuLabel(l) { return windowLabel(l); }

async function fetchSnapshot(p, ctx) {
  const s = base(p);
  s.kind = 'window';
  const b = normBase(p.baseUrl);
  if (!p.apiKey) { s.error = '未配置 API Key'; return s; }
  let r = null;
  for (const auth of ['Bearer ' + p.apiKey, p.apiKey]) {
    try {
      r = await request(b + '/api/monitor/usage/quota/limit', { headers: { Authorization: auth, Accept: 'application/json', 'Accept-Language': 'zh-CN' }, timeoutMs: 15000 });
      if (r.ok && r.data && (r.data.code === 200 || r.data.success || r.data.data)) break;
    } catch (e) { r = { ok: false, status: 0, data: null, err: e.message }; }
  }
  if (!r || !r.ok || !r.data || !r.data.data) { s.error = `额度接口 HTTP ${r ? r.status : 0}` + (r && r.data && r.data.msg ? ' ' + r.data.msg : '') + (r && r.err ? ' ' + r.err : ''); return s; }
  const d = r.data.data;
  const limits = Array.isArray(d.limits) ? d.limits : (Array.isArray(d) ? d : []);
  const now = Date.now() / 1000;
  for (const l of limits) {
    let pct = num(l.percentage, null);
    const usage = num(pick(l, ['usage', 'total', 'limit']), null);
    const curV = num(pick(l, ['currentValue', 'current', 'used']), null);
    if (pct === null && usage && curV !== null) pct = (curV / usage) * 100;
    if (pct === null) continue;
    const resetsAt = toEpochSec(pick(l, ['nextResetTime', 'resetTime', 'nextReset']));
    s.windows.push({ key: 'w' + s.windows.length, label: zhipuLabel(l, now), usedPercent: pct, resetsAt, windowMinutes: windowMinutes(l), total: usage, used: curV, remaining: num(l.remaining, null), unit: l.unit });
  }
  // 最短窗口作为 primary（决定胖瘦/标签），其余 secondary
  if (s.windows.length) { const byLen = [...s.windows].sort((a, b) => (a.windowMinutes || 1e9) - (b.windowMinutes || 1e9)); byLen[0].key = 'primary'; for (const w of byLen.slice(1)) w.key = `secondary:${w.windowMinutes}:${w.label}`; }
  if (!s.windows.length) { s.error = '额度接口没有有效用量字段'; return s; }
  s.ok = true;
  s.plan = d.level || d.planName || d.plan || null;
  // 任一窗口用尽即视为“饿了”
  const worst = s.windows.reduce((m, w) => Math.max(m, w.usedPercent), 0);
  s.fraction = s.windows.length ? Math.max(0, 1 - worst / 100) : null;
  s.lines = [];
  if (s.plan) s.lines.push(`${p.name} · ${String(s.plan).toUpperCase()}`);
  for (const w of s.windows) {
    const left = w.resetsAt ? fmtCountdown(w.resetsAt - now) : '';
    s.lines.push(`${w.label}已用 ${Math.round(w.usedPercent)}%` + (left ? ` · ${left}后重置` : ''));
  }
  if (ctx && ctx.wantModels) {
    try {
      const m = await request(b + '/api/paas/v4/models', { headers: { Authorization: 'Bearer ' + p.apiKey }, timeoutMs: 15000 });
      if (m.ok && m.data && Array.isArray(m.data.data)) s.models = m.data.data.map((x) => x.id).filter(Boolean).sort();
    } catch (_) { /* ignore */ }
  }
  return s;
}

module.exports = { fetchSnapshot, zhipuLabel };
