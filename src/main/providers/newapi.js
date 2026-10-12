'use strict';
// new-api / one-api 类中转站：支持 API Key（billing 接口）或 系统访问令牌 + 用户ID（/api/user/self）
const { requestRetry, request } = require('../http');
const { base, num, fmtMoney } = require('./util');

const QUOTA_PER_UNIT = 500000; // new-api 默认 500000 quota = $1

function normBase(u) {
  let b = String(u || '').trim().replace(/\/+$/, '');
  b = b.replace(/\/v1$/, '');
  return b;
}
function ymd(d) { return d.toISOString().slice(0, 10); }

function stripHtml(s) { return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

async function fetchAnnouncements(baseUrl) {
  const out = [];
  try {
    const r = await request(baseUrl + '/api/status', { timeoutMs: 15000 });
    const anns = r.data && r.data.data && Array.isArray(r.data.data.announcements) ? r.data.data.announcements : [];
    for (const a of anns) out.push({ id: 'ann-' + (a.id ?? a.publishDate), content: stripHtml(a.content), date: a.publishDate || null, type: a.type || 'default' });
    const notice = r.data && r.data.data ? r.data.data.notice : null;
    if (notice) out.push({ id: 'notice-' + hash(stripHtml(notice)), content: stripHtml(notice).slice(0, 300), date: null, type: 'notice' });
  } catch (_) { /* ignore */ }
  try {
    const n = await request(baseUrl + '/api/notice', { timeoutMs: 15000 });
    if (n.data && typeof n.data.data === 'string' && n.data.data.trim()) {
      const txt = stripHtml(n.data.data);
      out.push({ id: 'notice-' + hash(txt), content: txt.slice(0, 300), date: null, type: 'notice' });
    }
  } catch (_) { /* ignore */ }
  const seen = new Set();
  return out.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

async function fetchSnapshot(p, ctx) {
  const s = base(p);
  const b = normBase(p.baseUrl);
  if (!b) { s.error = '未配置地址'; return s; }
  s.currency = 'USD';
  let done = false;
  if (p.accessToken && p.userId) {
    try {
      const r = await requestRetry(b + '/api/user/self', { headers: { Authorization: 'Bearer ' + p.accessToken, 'New-Api-User': String(p.userId), Accept: 'application/json' }, timeoutMs: 15000 });
      if (r.ok && r.data && r.data.success && r.data.data && num(r.data.data.quota) !== null) {
        const d = r.data.data;
        s.ok = true; done = true;
        s.balance = num(d.quota, 0) / QUOTA_PER_UNIT;
        const used = num(d.used_quota);
        s.extra.used = used === null ? null : used / QUOTA_PER_UNIT;
        s.extra.requests = num(d.request_count);
        s.extra.group = d.group || null;
        s.extra.username = d.username || d.display_name || null;
        s.extra.mode = 'user';
      } else s.error = `user/self HTTP ${r.status}`;
    } catch (e) { s.error = e.message; }
  }
  if (!done && p.apiKey) {
    try {
      const headers = { Authorization: 'Bearer ' + p.apiKey, Accept: 'application/json' };
      const sub = await requestRetry(b + '/v1/dashboard/billing/subscription', { headers, timeoutMs: 15000 });
      if (sub.ok && sub.data) {
        const total = num(sub.data.hard_limit_usd, null);
        const end = new Date(Date.now() + 86400000);
        const start = new Date(Date.now() - 99 * 86400000);
        const use = await requestRetry(`${b}/v1/dashboard/billing/usage?start_date=${ymd(start)}&end_date=${ymd(end)}`, { headers, timeoutMs: 15000 });
        const usedValue = use.ok && use.data ? num(use.data.total_usage) : null;
        const used = usedValue !== null ? usedValue / 100 : null;
        if (total !== null && used !== null) {
          s.ok = true; done = true;
          s.extra.used = used;
          s.extra.total = total;
          s.extra.mode = 'token';
          if (total >= 1e7) { // new-api 对“不限额令牌”返回 1e8，此时拿不到账户真实余额
            s.extra.unlimited = true; s.balance = null; s.usedTotal = used;
          } else s.balance = total - used;
          if (sub.data.access_until) s.extra.accessUntil = sub.data.access_until;
        } else s.error = total === null ? 'subscription 无有效总额' : `用量获取失败（HTTP ${use.status}），无法计算余额`;
      } else s.error = s.error || `billing HTTP ${sub.status}`;
    } catch (e) { s.error = s.error || e.message; }
  }
  if (!done && !p.apiKey && !(p.accessToken && p.userId)) s.error = '未配置 API Key 或 访问令牌+用户ID';
  if (p.announcements !== false) s.announcements = await fetchAnnouncements(b);
  if (ctx && ctx.wantModels && p.apiKey) {
    try {
      const m = await request(b + '/v1/models', { headers: { Authorization: 'Bearer ' + p.apiKey }, timeoutMs: 15000 });
      if (m.ok && m.data && Array.isArray(m.data.data)) s.models = m.data.data.map((x) => x.id).filter(Boolean).sort();
    } catch (_) { /* ignore */ }
  }
  if (s.ok) {
    if (s.extra.unlimited) s.lines = [`${p.name} 令牌不限额 · 累计已用 ${fmtMoney(s.extra.used, 'USD')}`, '（填“系统访问令牌+用户ID”可看账户余额）'];
    else { s.lines = [`${p.name} 余额 ${fmtMoney(s.balance, 'USD')}`]; if (s.extra.used) s.lines.push(`累计已用 ${fmtMoney(s.extra.used, 'USD')}`); }
  }
  return s;
}

module.exports = { fetchSnapshot, normBase, fetchAnnouncements };
