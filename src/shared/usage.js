'use strict';
(function (root) {
  // 中转站计费口径：new-api 类数据源，或 Gemini CLI 走中转站时（快照里带 relay 标记）
  const isRelay = (p, s) => !!(p && (p.type === 'newapi' || p.type === 'openai'
    || (s && s.relay === true)
    || (p.type === 'gemini' && (p.auth === 'relay' || !!p.baseUrl))));
  function relayMetric(snapshot, ledger, now = new Date()) {
    const s = snapshot || {}, currency = s.currency || 'USD';
    if (Number.isFinite(s.balance)) return { label: '余额', value: s.balance, currency, hint: s.extra && s.extra.mode === 'token' ? '令牌剩余额度' : '账户余额' };
    // 本地 ledger 只覆盖桌宠运行时的余额/累计差额，不能代表完整自然日。
    // billing usage 还可能忽略日期参数；禁止拿观测值或累计值冒充今日用量。
    return { label: '账户余额', value: null, currency, hint: '需配置系统访问令牌＋用户 ID；API Key 无法查询账户余额' };
  }
  const usage = { isRelay, relayMetric };
  if (typeof module === 'object' && module.exports) module.exports = usage;
  else root.PetUsage = usage;
})(typeof globalThis === 'object' ? globalThis : this);
