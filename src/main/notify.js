'use strict';
// 事件引擎：对比上一次快照与本次快照，产出通知（重置 / 赠送 / 上新 / 余额低 / 公告）
const { fmtMoney } = require('./providers/util');

function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

// 记账：观测余额下降累计为今日已用
function updateLedger(ledger, balance, currency) {
  const t = todayStr();
  const l = ledger || { date: t, lastBalance: null, lastCurrency: null, todayUsage: 0, history: [] };
  if (l.date !== t) {
    l.history = [...(l.history || []), { date: l.date, usage: l.todayUsage }].slice(-30);
    l.date = t; l.todayUsage = 0; l.lastBalance = balance; l.lastCurrency = currency;
    return l;
  }
  if (l.lastCurrency && currency && l.lastCurrency !== currency) { l.lastBalance = balance; l.lastCurrency = currency; return l; }
  if (l.lastBalance !== null && balance < l.lastBalance) l.todayUsage = +(l.todayUsage + (l.lastBalance - balance)).toFixed(4);
  l.lastBalance = balance; l.lastCurrency = currency || l.lastCurrency;
  return l;
}

function diffSnapshots(prev, next, provider, notifyCfg) {
  const ev = [];
  if (!next || !next.ok) return ev;
  const name = provider.name;
  // 余额类
  if (next.balance !== null && next.balance !== undefined) {
    if (prev && prev.ok && prev.balance !== null && prev.balance !== undefined && prev.currency === next.currency) {
      const delta = next.balance - prev.balance;
      const grantedDelta = (next.granted || 0) - (prev.granted || 0);
      if (notifyCfg.gifts && (delta > 0.005 || grantedDelta > 0.005)) {
        const isGift = grantedDelta > 0.005;
        ev.push({ kind: 'gift', eventKey: `balance:${prev.at}:${next.at}:${next.balance}:${next.granted}`, title: isGift ? `🎁 ${name} 送额度了` : `💰 ${name} 余额增加`, body: `${isGift ? '赠送 +' + fmtMoney(grantedDelta, next.currency) : '+' + fmtMoney(delta, next.currency)}，余额 ${fmtMoney(next.balance, next.currency)}` });
      }
      const low = Number(provider.lowBalance);
      if (notifyCfg.lowBalance && low > 0 && next.balance < low && prev.balance >= low) {
        ev.push({ kind: 'low', title: `⚠️ ${name} 余额不足`, body: `只剩 ${fmtMoney(next.balance, next.currency)} 了，记得充值~` });
      }
    }
    if (notifyCfg.lowBalance && next.extra && next.extra.isAvailable === false && !(prev && prev.extra && prev.extra.isAvailable === false)) {
      ev.push({ kind: 'low', title: `⛔ ${name} 余额已耗尽`, body: '接口已不可用，充值后恢复' });
    }
  }
  // 窗口类
  if (Array.isArray(next.windows) && next.windows.length && prev && prev.ok && Array.isArray(prev.windows)) {
    for (const w of next.windows) {
      const pw = prev.windows.find((x) => x.key === w.key) || prev.windows.find((x) => x.label === w.label);
      if (!pw) continue;
      if (!Number.isFinite(pw.usedPercent) || !Number.isFinite(w.usedPercent)) continue;
      const drop = pw.usedPercent - w.usedPercent;
      const now = Date.now() / 1000;
      const advanced = w.resetsAt && pw.resetsAt && w.resetsAt > pw.resetsAt + 120;
      const elapsed = pw.resetsAt && pw.resetsAt <= now + 5;
      const newlyExpired = w.expired && !pw.expired;
      // 真实跨周期即使只用过 1% 也提醒；滚动窗口的小幅回落不算重置。
      const reset = (elapsed && (advanced || newlyExpired || (drop > 0 && w.usedPercent === 0))) || (drop > 0 && (advanced || (w.usedPercent === 0 && !pw.resetsAt)));
      if (reset && !pw.expired) {
        const early = pw.resetsAt && now < pw.resetsAt - 120;
        if (early ? notifyCfg.gifts : notifyCfg.resets) ev.push({ kind: early ? 'gift' : 'reset', eventKey: `reset:${w.key}:${pw.resetsAt || prev.at}:${w.resetsAt || next.at}`, title: early ? `🎁 ${name} ${w.label}额度提前重置了` : `⏰ ${name} ${w.label}额度已重置`, body: `已用 ${Math.round(pw.usedPercent)}% → ${Math.round(w.usedPercent)}%，${w.expired ? '已到重置时间（本地估算，待接口确认）' : '新额度可用了'}` });
      }
      const increased = Number.isFinite(w.total) && Number.isFinite(pw.total) && w.total > pw.total && !advanced;
      if (notifyCfg.gifts && increased) {
        const unit = /token/i.test(w.label) ? 'token' : '额度';
        ev.push({ kind: 'gift', eventKey: `limit:${w.key}:${pw.total}:${w.total}:${next.at}`, title: `🎁 ${name} ${w.label}增加了`, body: `+${w.total - pw.total} ${unit}，总量 ${pw.total} → ${w.total}` });
      }
      const warn = Number(provider.warnPercent) || 90;
      if (notifyCfg.lowBalance && w.usedPercent >= warn && pw.usedPercent < warn) {
        const left = w.resetsAt ? Math.max(0, Math.round((w.resetsAt - Date.now() / 1000) / 60)) : null;
        ev.push({ kind: 'low', title: `⚠️ ${name} ${w.label}额度快用完了`, body: `已用 ${Math.round(w.usedPercent)}%` + (left !== null ? `，约 ${left >= 60 ? Math.floor(left / 60) + '小时' + (left % 60) + '分' : left + '分'}后重置` : '') });
      }
    }
  }
  // 积分独立于窗口列表；缺失字段不能当作 0。
  const nb = next.credits && next.credits.balance;
  const pb = prev && prev.ok && prev.credits ? prev.credits.balance : null;
  if (notifyCfg.gifts && nb != null && pb != null && nb !== '' && pb !== '' && Number.isFinite(Number(nb)) && Number.isFinite(Number(pb)) && Number(nb) > Number(pb)) {
    ev.push({ kind: 'gift', eventKey: `credits:${prev.at}:${next.at}:${nb}`, title: `🎁 ${name} 送积分了`, body: `Credits ${pb} → ${nb}` });
  }
  return ev;
}

function diffModels(prevList, nextList, provider, notifyCfg) {
  if (!notifyCfg.newModels || !Array.isArray(nextList) || !nextList.length) return [];
  if (!Array.isArray(prevList)) return []; // 首次记录不通知
  const prevSet = new Set(prevList);
  const added = nextList.filter((m) => !prevSet.has(m));
  if (!added.length) return [];
  return [{ kind: 'model', title: `🆕 ${provider.name} 上新模型`, body: added.slice(0, 8).join(', ') + (added.length > 8 ? ` 等 ${added.length} 个` : '') }];
}

function diffAnnouncements(prevIds, list, provider, notifyCfg) {
  if (!notifyCfg.announcements || !Array.isArray(list) || !list.length) return { events: [], ids: (prevIds || []) };
  const ids = list.map((a) => a.id);
  if (!Array.isArray(prevIds)) return { events: [], ids }; // 首次不通知
  const prev = new Set(prevIds);
  const events = list.filter((a) => !prev.has(a.id)).slice(0, 5).map((a) => ({ kind: 'announcement', title: `📣 ${provider.name} 公告`, body: a.content.slice(0, 200) }));
  return { events, ids: Array.from(new Set([...prevIds, ...ids])).slice(-200) };
}

function inQuietHours(spec) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec || '').trim());
  if (!m) return false;
  const now = new Date(); const cur = now.getHours() * 60 + now.getMinutes();
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

module.exports = { updateLedger, diffSnapshots, diffModels, diffAnnouncements, inQuietHours, todayStr };
