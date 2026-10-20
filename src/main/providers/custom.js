'use strict';
// 自定义 JSON 接口：给没有内置支持的工具用，按点路径（如 data.quota.used）取数
const { base, num, fmtMoney } = require('./util');

function pickPath(obj, p) { return String(p || '').split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj); }

function parse(p, d) {
  const balance = p.balancePath ? num(pickPath(d, p.balancePath), null) : null;
  const used = num(pickPath(d, p.usedPath), null), limit = num(pickPath(d, p.limitPath), null);
  const windows = used !== null && limit > 0 ? [{ key: 'primary', label: '额度', usedPercent: Math.max(0, Math.min(100, used / limit * 100)), resetsAt: null }] : [];
  return { balance, windows };
}

async function fetchSnapshot(p) {
  const { request } = require('../http');
  const s = base(p);
  if (!/^https?:\/\//.test(p.baseUrl || '')) { s.error = '请填写接口地址'; return s; }
  const r = await request(p.baseUrl, { headers: { Accept: 'application/json', ...(p.apiKey ? { Authorization: 'Bearer ' + p.apiKey } : {}) }, timeoutMs: 20000 });
  if (!r.ok || !r.data) { s.error = `HTTP ${r.status}`; return s; }
  const v = parse(p, r.data);
  if (v.balance === null && !v.windows.length) { s.error = '按路径没取到数字'; return s; }
  Object.assign(s, { ok: true, balance: v.balance, currency: p.currency || null, windows: v.windows, kind: v.windows.length ? 'window' : 'balance' });
  if (v.windows.length) s.fraction = 1 - v.windows[0].usedPercent / 100;
  s.lines = [v.balance !== null ? `${p.name} 余额 ${fmtMoney(v.balance, s.currency)}` : `${p.name} 已用 ${Math.round(v.windows[0].usedPercent)}%`];
  return s;
}
module.exports = { fetchSnapshot, parse, pickPath };
