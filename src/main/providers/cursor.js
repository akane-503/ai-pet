'use strict';
// Cursor 本月用量：读本机登录 token，调 cursor.com 的 usage-summary（非公开接口，格式可能变）
const path = require('path');
const { base, num, toEpochSec, fmtCountdown } = require('./util');
const cursorModel = require('../cursor-model');

const DB = path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');

function readToken(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get(); return row ? String(row.value) : ''; } finally { db.close(); }
}
// cookie 需要 “用户ID::token”，用户ID 在 JWT sub 的 | 后面
function cookieFor(token) {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
  return 'WorkosCursorSessionToken=' + String(payload.sub || '').split('|').pop() + '%3A%3A' + token;
}
// 免费档的 used/limit 常为 0，额度在 bonus 里，所以优先用接口给的百分比
function parseUsage(d) {
  const u = (d && d.individualUsage) || {};
  const plan = u.plan || {}, overall = u.overall || {};
  let pct = num(plan.totalPercentUsed, null);
  if (pct === null && num(overall.limit, 0) > 0) pct = num(overall.used, 0) / num(overall.limit) * 100;
  const windows = pct === null ? [] : [{ key: 'primary', label: '本月', usedPercent: Math.max(0, Math.min(100, pct)), resetsAt: toEpochSec(d.billingCycleEnd) }];
  const od = u.onDemand || {};
  if (od.enabled && num(od.limit, 0) > 0) windows.push({ key: 'ondemand', label: '按量', usedPercent: Math.max(0, Math.min(100, num(od.used, 0) / num(od.limit) * 100)), resetsAt: toEpochSec(d.billingCycleEnd) });
  return { windows, plan: d && d.membershipType || null, auto: num(plan.autoPercentUsed, null), api: num(plan.apiPercentUsed, null) };
}

async function fetchSnapshot(p) {
  const { request } = require('../http');
  const s = base(p); s.kind = 'window';
  let cookie = p.cookie ? (p.cookie.includes('=') ? p.cookie : 'WorkosCursorSessionToken=' + p.cookie) : '';
  if (!cookie) {
    let token = '';
    if (!require('fs').existsSync(p.dbPath || DB)) { s.error = '没找到 Cursor 本机登录数据（未安装或路径不对）'; return s; }
    try { token = readToken(p.dbPath || DB); } catch (e) { s.error = '读不到 Cursor 登录信息：' + e.message; return s; }
    if (!token) { s.error = 'Cursor 未登录'; return s; }
    try { cookie = cookieFor(token); } catch (_) { s.error = 'Cursor 登录 token 格式不认识'; return s; }
  }
  const r = await request('https://cursor.com/api/usage-summary', { headers: { Cookie: cookie, Accept: 'application/json' }, timeoutMs: 20000 });
  if (!r.ok || !r.data) { s.error = `用量接口 HTTP ${r.status}`; return s; }
  const u = parseUsage(r.data);
  if (!u.windows.length) { s.error = '接口无用量字段'; return s; }
  Object.assign(s, { ok: true, windows: u.windows, plan: u.plan });
  // Cursor 是多模型 IDE：把当前 composer 的模型也写进快照，气泡里能看出「这个额度在用哪个模型」
  const cur = cursorModel.info(p.dbPath || DB);
  if (cur && cur.ok) { s.extra.model = cur.model || null; s.extra.modelLabel = cur.label || null; s.extra.modelCharacter = cur.character || null; s.extra.modelAuto = !!cur.auto; }
  s.fraction = 1 - u.windows[0].usedPercent / 100;
  const now = Date.now() / 1000;
  const modelTag = cur && cur.ok && cur.label ? ` · ${cur.label}` : '';
  s.lines = [`Cursor ${u.plan || ''}${modelTag}`.replace(/\s+/g, ' ').trim(), ...u.windows.map((w) => `${w.label}已用 ${Math.round(w.usedPercent)}%` + (w.resetsAt ? ` · ${fmtCountdown(w.resetsAt - now)}后重置` : ''))];
  if (u.auto !== null || u.api !== null) s.lines.push(`Auto ${Math.round(u.auto || 0)}% · API ${Math.round(u.api || 0)}%`);
  return s;
}
module.exports = { fetchSnapshot, parseUsage, cookieFor };
