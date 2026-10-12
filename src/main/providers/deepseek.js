'use strict';
const { requestRetry } = require('../http');
const { base, num, fmtMoney } = require('./util');

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const MODELS_URL = 'https://api.deepseek.com/models';

function pickBalance(infos) {
  if (!Array.isArray(infos) || !infos.length) return null;
  const cny = infos.find((b) => b.currency === 'CNY' && num(b.total_balance, 0) > 0);
  const any = infos.find((b) => num(b.total_balance, 0) > 0);
  const cny0 = infos.find((b) => b.currency === 'CNY');
  return cny || any || cny0 || infos[0];
}

async function fetchSnapshot(p, ctx) {
  const s = base(p);
  if (!p.apiKey) { s.error = '未配置 API Key'; return s; }
  const headers = { Authorization: 'Bearer ' + p.apiKey, Accept: 'application/json' };
  const r = await requestRetry(BALANCE_URL, { headers, timeoutMs: 20000 });
  if (!r.ok || !r.data) { s.error = `余额接口 HTTP ${r.status}` + (r.data && r.data.error ? ' ' + JSON.stringify(r.data.error).slice(0, 80) : ''); return s; }
  const info = pickBalance(r.data.balance_infos);
  if (!info) { s.error = '余额数据为空'; return s; }
  if (num(info.total_balance) === null) { s.error = '余额接口缺少有效金额'; return s; }
  s.ok = true;
  s.currency = info.currency || 'CNY';
  s.balance = num(info.total_balance, 0);
  s.granted = num(info.granted_balance);
  s.toppedUp = num(info.topped_up_balance);
  s.extra.isAvailable = r.data.is_available !== false;
  if (ctx && ctx.wantModels) {
    try {
      const m = await requestRetry(MODELS_URL, { headers, timeoutMs: 15000 });
      if (m.ok && m.data && Array.isArray(m.data.data)) s.models = m.data.data.map((x) => x.id).filter(Boolean).sort();
    } catch (_) { /* ignore */ }
  }
  s.lines = [`DeepSeek 余额 ${fmtMoney(s.balance, s.currency)}`];
  if (s.granted > 0) s.lines.push(`其中赠送 ${fmtMoney(s.granted, s.currency)}`);
  return s;
}

module.exports = { fetchSnapshot };
