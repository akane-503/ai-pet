'use strict';
(function (root) {
  const isRelay = p => p && (p.type === 'newapi' || p.type === 'openai');
  function relayMetric(snapshot, ledger, now = new Date()) {
    const s = snapshot || {}, currency = s.currency || 'USD';
    if (Number.isFinite(s.balance)) return { label: '余额', value: s.balance, currency, hint: s.extra && s.extra.mode === 'token' ? '令牌剩余额度' : '账户余额' };
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (ledger && ledger.date === day && Number.isFinite(ledger.todayUsage) && ledger.todayUsage >= 0
      && (ledger.lastCurrency === currency || ledger.lastCurrency === currency + '#used')) {
      return { label: '今日已用', value: ledger.todayUsage, currency, hint: '自桌宠观测起统计' };
    }
    return { label: '今日用量', value: null, currency, hint: '今日数据待刷新 · 可配置账户余额' };
  }
  const usage = { isRelay, relayMetric };
  if (typeof module === 'object' && module.exports) module.exports = usage;
  else root.PetUsage = usage;
})(typeof globalThis === 'object' ? globalThis : this);
