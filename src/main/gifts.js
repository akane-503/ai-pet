'use strict';
// 送额度待领取：窗口类赠送（积分窗口总量增加、凭空多出的窗口）登记在案，
// 按配置间隔温和重复提醒，直到用户点「已领取」；窗口重置/消失或过期后自动放弃，绝不无限骚扰。
// 这里只做纯逻辑与状态变更，落通知/落库由 main.js 执行，方便回归测试。
function upsertGiftClaim(list, provider, claim, notifId) {
  const c = list.find((x) => x.key === claim.key);
  if (!c) {
    list.push({ ...claim, providerId: provider.id, providerName: provider.name, at: Date.now(), lastRemind: Date.now(), reminders: 0, claimed: false, notifId: notifId || null });
    return 'new';
  }
  // 同一窗口又加了量：并入原记录（赠送量累加），调用方把新事件的通知标已读，红点只留一条
  c.granted = +(((c.granted || 0) + (claim.granted || 0)).toFixed(4));
  c.remaining = claim.remaining; c.resetsAt = claim.resetsAt;
  if (claim.usedPercent !== undefined) c.usedPercent = claim.usedPercent;
  return 'exists';
}

function fmtLeft(sec) { const s = Math.max(0, sec); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}天${h}h` : h ? `${h}h${m}m` : `${m}m`; }

function giftClaimBody(c, w) {
  const bits = [`赠送 +${c.granted}${c.unit ? ' ' + c.unit : ''}`];
  if (Number.isFinite(w.remaining)) bits.push(`剩 ${w.remaining}`);
  if (c.resetsAt) bits.push(fmtLeft(c.resetsAt - Date.now() / 1000) + '后过期');
  return bits.join(' · ');
}

// 额度卡住时的「出路」文案：ZCode 端内重置机会 / Codex credits / 等自动重置
function stuckBody(p, w, s) {
  const left = w.resetsAt ? fmtLeft(w.resetsAt - Date.now() / 1000) + '后自动重置' : '等下个周期自动重置';
  if (p.type === 'zhipu') return `${w.label}用完了。ZCode 端内闲时会发「重置机会」，留意输入框右下角的重置提示，点一下立即回满；没有的话${left}。`;
  const cr = s && s.credits;
  if (p.type === 'codex' && cr && !cr.overage_limit_reached && Number(cr.balance) > 0) {
    return `${w.label}用完了。还有 ${cr.balance} credits 可以顶上（继续跑会消耗 credits）；或者${left}。`;
  }
  return `${w.label}用完了，${left}。`;
}

// 扫描刚刷新完的快照：最短窗口（挡住你的那道闸）用到 100% 就记一条「出路提示」，
// 额度一恢复（窗口重置或你用掉了重置卡）自动收声；同一周期反复用完会重新武装
function scanStuckClaims(list, { snapshots, providers, now = Date.now() }) {
  const out = [];
  for (const p of providers || []) {
    if (!p || !p.enabled) continue;
    const s = snapshots[p.id];
    if (!s || !s.ok || !Array.isArray(s.windows) || !s.windows.length) continue;
    const w = [...s.windows].sort((a, b) => (a.windowMinutes || 1e9) - (b.windowMinutes || 1e9))[0];
    if (!Number.isFinite(w.usedPercent) || w.usedPercent < 99.5) continue;
    const key = `stuck:${p.id}:${w.key}:${w.resetsAt || 'na'}`;
    let c = list.find((x) => x.key === key);
    if (!c) {
      c = { key, kind: 'stuck', windowKey: w.key, label: w.label, providerId: p.id, providerName: p.name, resetsAt: w.resetsAt || null, remaining: null, granted: 0, unit: '', usedPercent: w.usedPercent, at: now, lastRemind: now, reminders: 0, claimed: false, notifId: null };
      list.push(c);
      out.push({ claim: c, title: `🍗 ${p.name} ${w.label}用完了`, body: stuckBody(p, w, s) });
    } else if (c.resolved && !c.claimed) {
      // 同一周期又用完了（比如刚用掉一张重置卡又跑光了）：重新武装
      c.resolved = false; c.lastRemind = now; c.reminders = 0;
      out.push({ claim: c, title: `🍗 ${p.name} ${w.label}又用完了`, body: stuckBody(p, w, s) });
    }
    if (Number.isFinite(w.usedPercent)) c.usedPercent = w.usedPercent;
  }
  return out;
}

// 扫一遍待领取清单，产出这一分钟该做的事：
// notices 要弹的气泡提醒；recordUpdates 要刷新的消息记录（正文换成最新剩余/过期）；
// readIds 要标已读的消息（赠送已落幕）；dirty 表示清单本身有变化需要落库
function collectGiftReminders(list, { snapshots, providerById, notify, quiet, now = Date.now() }) {
  const out = { notices: [], recordUpdates: [], readIds: [], dirty: false };
  const intervalMin = Number(notify.giftRemindMin) || 0;
  const nowSec = now / 1000;
  for (const c of list) {
    if (c.claimed || c.resolved) continue;
    const p = providerById(c.providerId);
    const s = p && snapshots[c.providerId];
    const w = s && s.ok && (s.windows || []).find((x) => x.key === c.windowKey);
    // 赠送已落幕的三种情况：数据源没了；原定过期时间过了 6 小时；期限前移且用量明显回落
    //（周期真的重启了——只看期限前移不行，Codex 滚动窗口的期限本来就在持续前移）。
    // 「出路提示」多了第四种：额度一恢复就说完了——重置或用户用掉了重置卡都是恢复。
    const recovered = c.kind === 'stuck' && w && Number.isFinite(w.usedPercent) && w.usedPercent < 99.5;
    const rolledOver = w && c.resetsAt && w.resetsAt && w.resetsAt > c.resetsAt + 120
      && Number.isFinite(c.usedPercent) && Number.isFinite(w.usedPercent) && w.usedPercent < c.usedPercent - 5;
    const over = !p || !p.enabled || !w || recovered || (c.resetsAt && nowSec > c.resetsAt + 6 * 3600) || rolledOver;
    if (over) {
      c.resolved = true; out.dirty = true;
      if (c.notifId) out.readIds.push(c.notifId);
      continue;
    }
    if (Number.isFinite(w.remaining)) c.remaining = w.remaining;
    if (!notify.gifts || quiet || intervalMin <= 0) continue;
    // 首次进账已气泡过一次（lastRemind 记在登记时），之后才按间隔重复
    if (now - (c.lastRemind || c.at || 0) < intervalMin * 60000) continue;
    c.lastRemind = now; c.reminders = (c.reminders || 0) + 1; out.dirty = true;
    const body = c.kind === 'stuck' ? stuckBody(p, w, s) : giftClaimBody(c, w);
    if (c.notifId) out.recordUpdates.push({ id: c.notifId, ts: now, body });
    out.notices.push({ id: (c.notifId || c.key) + ':r' + c.reminders, ts: now, kind: c.kind || 'gift', title: c.kind === 'stuck' ? `🍗 ${p.name} ${c.label}还没额度` : `🎁 ${p.name} 赠送额度待领取`, body, eventKey: null, link: null, providerId: c.providerId, claimKey: c.key, read: false });
  }
  return out;
}

// 已领取/已了结满 30 天的登记清掉
function pruneGiftClaims(list, now = Date.now()) {
  const cutoff = now - 30 * 86400e3;
  return list.filter((c) => (c.claimed || c.resolved) ? (c.claimedAt || c.at || 0) > cutoff : true);
}

function claimGift(list, key, now = Date.now()) {
  const c = list.find((x) => x.key === key);
  if (!c || c.claimed) return null;
  c.claimed = true; c.claimedAt = now;
  return c;
}

module.exports = { upsertGiftClaim, collectGiftReminders, pruneGiftClaims, claimGift, giftClaimBody, scanStuckClaims, stuckBody };
