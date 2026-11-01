'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const activity = require('../src/main/activity');
const { diffSnapshots } = require('../src/main/notify');
const gifts = require('../src/main/gifts');

test('foreground and recent user choices beat background session writes; manual mode remains available', () => {
  const now = Date.now();
  const options = { appearance: { character: 'auto', favorite: 'deepseek' }, now, activity: { active: 'claude', details: { claude: now } } };
  assert.equal(activity.selectCharacter({ ...options, foreground: { character: 'codex', at: now } }).character, 'codex');
  assert.equal(activity.selectCharacter({ ...options, recent: { character: 'zcode', at: now, reason: 'launch' } }).character, 'zcode');
  assert.equal(activity.selectCharacter({ ...options, appearance: { character: 'gemini' }, foreground: { character: 'codex', at: now } }).character, 'gemini');
  const latest = activity.selectCharacter({ ...options, activity: { details: { claude: now - 2000, codex: now - 500 } } });
  assert.equal(latest.character, 'codex');
  assert.match(latest.why, /codex/);
  assert.equal(activity.selectCharacter({ ...options, activity: {} }).character, 'deepseek');
});

test('native process identity survives task titles; spinner detection is restricted to terminals', () => {
  assert.equal(activity.characterForWindow({ title: '桌宠需求 · 项目', processName: 'ChatGPT.exe' }), 'codex');
  assert.equal(activity.characterForWindow({ title: '工作区', processName: 'ZCode.exe' }), 'zcode');
  assert.equal(activity.characterForWindow({ title: '◑ 修复桌宠', processName: 'WindowsTerminal.exe' }), 'claude');
  assert.equal(activity.characterForWindow({ title: '◑ 无关下载', processName: 'explorer.exe' }), null);
  assert.equal(activity.characterForWindow({ title: 'Gemini - Google Chrome', processName: 'chrome.exe' }), 'gemini');
  assert.equal(activity.characterForWindow({ title: '新的对话', processName: 'Gemini.exe' }), 'gemini');
  assert.equal(activity.characterForWindow({ title: 'Gemini', processName: 'unknown.exe' }), 'gemini');
  assert.equal(activity.characterForWindow({ title: 'Google Gemini', processName: 'unknown.exe' }), 'gemini');
  assert.equal(activity.characterForWindow({ title: '如何安装 Gemini Desktop - Google Chrome', processName: 'chrome.exe' }), null);
  assert.equal(activity.characterForWindow({ title: '如何安装 Claude Code - Google Chrome', processName: 'chrome.exe' }), null);
});

test('CLI routing and native windows use the same model, while websites retain their service', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'big-fish-pet'));
  fs.writeFileSync(path.join(dir, 'big-fish-pet', 'conversation-mode.txt'), 'deepseek');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }));
  const cfg = { codexDir: dir, claudeDir: dir };
  assert.equal(activity.routeForWindow({ processName: 'ChatGPT.exe' }, cfg), 'deepseek');
  assert.equal(activity.routeForWindow({ title: '◑ 任务', processName: 'WindowsTerminal.exe' }, cfg), 'zcode');
  assert.equal(activity.routeForWindow({ title: 'Claude - Google Chrome', processName: 'chrome.exe' }, cfg), 'claude');
});

const provider = { id: 'test', name: '测试工具', warnPercent: 90, lowBalance: 5 };
const config = { resets: true, gifts: true, lowBalance: true };
const now = Math.floor(Date.now() / 1000);
const snapshot = (usedPercent, resetsAt, extra = {}) => ({ ok: true, at: Date.now(), windows: [{ key: 'primary', label: '5小时', usedPercent, resetsAt, ...extra }] });

test('real cycle resets notify even below 15%; gradual rolling-window recovery stays quiet', () => {
  assert.equal(diffSnapshots(snapshot(2, now - 30), snapshot(0, now + 18000), provider, config)[0].kind, 'reset');
  assert.equal(diffSnapshots(snapshot(20, now - 30), snapshot(25, now + 18000), provider, config)[0].kind, 'reset');
  assert.equal(diffSnapshots(snapshot(65, now + 3000), snapshot(40, now + 3000), provider, config).length, 0);
  assert.equal(diffSnapshots(snapshot(0, now - 30), snapshot(0, now - 30), provider, config).length, 0);
});

test('early resets obey gifts setting independently of normal resets', () => {
  const prev = snapshot(5, now + 3000), next = snapshot(0, now + 18000);
  assert.equal(diffSnapshots(prev, next, provider, { ...config, resets: false })[0].kind, 'gift');
  assert.equal(diffSnapshots(prev, next, provider, { ...config, gifts: false }).length, 0);
});

test('different quota cycles have different notification identities', () => {
  const first = diffSnapshots(snapshot(2, now - 3600), snapshot(0, now - 1800), provider, config)[0];
  const second = diffSnapshots(snapshot(2, now - 1800), snapshot(0, now + 18000), provider, config)[0];
  assert.notEqual(first.eventKey, second.eventKey);
});

test('gift balances are detected despite simultaneous spending and credits work without quota windows', () => {
  const prev = { ok: true, balance: 20, granted: 2, currency: 'CNY' };
  const next = { ok: true, balance: 19, granted: 3, currency: 'CNY' };
  assert.equal(diffSnapshots(prev, next, provider, config)[0].kind, 'gift');
  assert.equal(diffSnapshots({ ok: true, credits: { balance: 2 } }, { ok: true, credits: { balance: 3 } }, provider, config)[0].kind, 'gift');
  assert.equal(diffSnapshots({ ok: true }, { ok: true, credits: { balance: 3 } }, provider, config).length, 0);
  assert.equal(diffSnapshots({ ok: false }, { ok: true, credits: { balance: 3 } }, provider, config).length, 0);
});

test('token limit increases notify and disabled low-balance alerts remain disabled', () => {
  const ev = diffSnapshots(snapshot(40, now + 1000, { total: 2000 }), snapshot(30, now + 1000, { total: 3000 }), provider, config);
  assert.equal(ev[0].kind, 'gift');
  assert.match(ev[0].body, /1000/);
  assert.equal(diffSnapshots(null, { ok: true, balance: 0, extra: { isAvailable: false } }, provider, { ...config, lowBalance: false }).length, 0);
});

test('gift window increase carries claim info with remaining value and expiry', () => {
  const ev = diffSnapshots(snapshot(40, now + 1000, { total: 2000, remaining: 1200 }), snapshot(30, now + 1000, { total: 3000, remaining: 2100 }), provider, config);
  assert.equal(ev[0].kind, 'gift');
  assert.equal(ev[0].claim.key, `gift:test:primary:${now + 1000}`);
  assert.equal(ev[0].claim.granted, 1000);
  assert.equal(ev[0].claim.remaining, 2100);
  assert.equal(ev[0].claim.resetsAt, now + 1000);
  assert.match(ev[0].body, /剩 2100/);
  assert.match(ev[0].body, /后过期/);
});

test('a brand-new quota window counts as a claimable gift and honors the gifts setting', () => {
  const prev = snapshot(30, now + 1000);
  const next = { ok: true, at: Date.now(), windows: [prev.windows[0], { key: 'w9', label: '每日 积分', usedPercent: 0, total: 5000, remaining: 5000, resetsAt: now + 86400 }] };
  const ev = diffSnapshots(prev, next, provider, config);
  const gift = ev.find((e) => e.claim && e.claim.windowKey === 'w9');
  assert.ok(gift, 'new window should emit a claimable gift');
  assert.equal(gift.claim.granted, 5000);
  assert.equal(gift.claim.unit, '积分');
  assert.match(gift.body, /总量 5000/);
  assert.equal(diffSnapshots(prev, next, provider, { ...config, gifts: false }).length, 0);
});

// ---------- 送额度待领取 ----------
const T = Date.now();
const giftClaimOf = (over = {}) => ({ key: 'gift:zhipu:primary:100', windowKey: 'primary', label: '5小时 积分', granted: 1000, remaining: 800, resetsAt: Math.floor(T / 1000) + 7200, usedPercent: 40, unit: '积分', providerId: 'zhipu', providerName: 'Z.ai', at: T - 3600e3, lastRemind: T - 3600e3, reminders: 0, claimed: false, notifId: 'n1', ...over });
const giftWindow = (over = {}) => ({ key: 'primary', label: '5小时 积分', usedPercent: 40, remaining: 800, resetsAt: Math.floor(T / 1000) + 7200, ...over });
const giftCtx = (over = {}) => ({ snapshots: { zhipu: { ok: true, windows: [giftWindow()] } }, providerById: (id) => ({ id, name: 'Z.ai', enabled: true }), notify: { gifts: true, giftRemindMin: 30 }, quiet: false, now: T, ...over });

test('gift claims remind on the configured cadence until claimed, then stay quiet', () => {
  const list = [giftClaimOf()];
  let r = gifts.collectGiftReminders(list, giftCtx());
  assert.equal(r.notices.length, 1);
  assert.equal(list[0].reminders, 1);
  assert.match(r.notices[0].body, /剩 800/);
  assert.match(r.notices[0].body, /后过期/);
  assert.equal(gifts.collectGiftReminders(list, giftCtx({ now: T + 60000 })).notices.length, 0, 'interval not yet elapsed');
  assert.equal(gifts.collectGiftReminders(list, giftCtx({ now: T + 31 * 60000 })).notices.length, 1, 'reminds again after the interval');
  assert.equal(gifts.claimGift(list, 'gift:zhipu:primary:100').claimed, true);
  assert.equal(gifts.collectGiftReminders(list, giftCtx({ now: T + 62 * 60000 })).notices.length, 0, 'claimed claims never remind again');
});

test('gift claims resolve themselves when the source vanishes, expiry passes or the cycle restarts', () => {
  const gone = [giftClaimOf()];
  gifts.collectGiftReminders(gone, giftCtx({ snapshots: {} }));
  assert.equal(gone[0].resolved, true);

  const expired = [giftClaimOf({ resetsAt: Math.floor(T / 1000) - 7 * 3600 })];
  const r = gifts.collectGiftReminders(expired, giftCtx());
  assert.equal(expired[0].resolved, true);
  assert.deepEqual(r.readIds, ['n1'], 'resolved claims clear their unread badge');

  const restarted = [giftClaimOf()];
  gifts.collectGiftReminders(restarted, giftCtx({ snapshots: { zhipu: { ok: true, windows: [giftWindow({ usedPercent: 5, remaining: 1900, resetsAt: Math.floor(T / 1000) + 14400 })] } } }));
  assert.equal(restarted[0].resolved, true, 'deadline moved forward with usage dropped = cycle restarted');

  const rolling = [giftClaimOf()];
  gifts.collectGiftReminders(rolling, giftCtx({ snapshots: { zhipu: { ok: true, windows: [giftWindow({ usedPercent: 55, remaining: 700, resetsAt: Math.floor(T / 1000) + 9000 })] } } }));
  assert.equal(rolling[0].resolved, undefined, 'rolling-window deadline drift with rising usage is not a reset');
});

test('quiet hours, disabled gifts and interval 0 silence repeats without resolving claims', () => {
  const base = () => [giftClaimOf({ lastRemind: T - 3600e3 })];
  assert.equal(gifts.collectGiftReminders(base(), giftCtx({ quiet: true })).notices.length, 0);
  assert.equal(gifts.collectGiftReminders(base(), giftCtx({ notify: { gifts: false, giftRemindMin: 30 } })).notices.length, 0);
  assert.equal(gifts.collectGiftReminders(base(), giftCtx({ notify: { gifts: true, giftRemindMin: 0 } })).notices.length, 0);
  const list = base();
  gifts.collectGiftReminders(list, giftCtx({ quiet: true }));
  assert.equal(list[0].resolved, undefined);
});

test('repeat gifts on the same window merge into one pending claim', () => {
  const list = [];
  const p = { id: 'zhipu', name: 'Z.ai' };
  assert.equal(gifts.upsertGiftClaim(list, p, { key: 'g1', granted: 500, remaining: 1500, resetsAt: 1, usedPercent: 30 }, 'a1'), 'new');
  assert.equal(gifts.upsertGiftClaim(list, p, { key: 'g1', granted: 300, remaining: 1800, resetsAt: 1, usedPercent: 25 }, 'a2'), 'exists');
  assert.equal(list.length, 1);
  assert.equal(list[0].granted, 800);
  assert.equal(list[0].remaining, 1800);
  assert.equal(list[0].notifId, 'a1', 'original notification stays the single source');
  const pruned = gifts.pruneGiftClaims([{ claimed: true, claimedAt: T - 40 * 86400e3, at: T - 41 * 86400e3 }, { resolved: true, at: T - 1000 }].map((c) => ({ key: 'k', ...c })));
  assert.equal(pruned.length, 1, 'settled claims are pruned after 30 days');
});

test('stuck quota hints fire for the binding window with the right way out', () => {
  const list = [];
  const provs = [
    { id: 'zhipu', type: 'zhipu', name: 'Z.ai Coding Plan', enabled: true },
    { id: 'codex', type: 'codex', name: 'Codex / ChatGPT', enabled: true },
  ];
  const snaps = {
    zhipu: { ok: true, windows: [{ key: 'primary', label: '5小时 积分', usedPercent: 100, windowMinutes: 300, resetsAt: Math.floor(T / 1000) + 3600 }] },
    codex: { ok: true, credits: { has_credits: true, balance: '8.50', overage_limit_reached: false }, windows: [{ key: 'primary', label: '5小时', usedPercent: 100, windowMinutes: 300, resetsAt: Math.floor(T / 1000) + 3600 }] },
  };
  let out = gifts.scanStuckClaims(list, { snapshots: snaps, providers: provs, now: T });
  assert.equal(out.length, 2);
  const z = out.find((e) => e.claim.providerId === 'zhipu');
  assert.equal(z.claim.key, `stuck:zhipu:primary:${Math.floor(T / 1000) + 3600}`);
  assert.match(z.body, /重置机会/);
  assert.match(z.body, /输入框右下角/);
  const c = out.find((e) => e.claim.providerId === 'codex');
  assert.match(c.body, /8\.50 credits/);
  assert.match(c.title, /用完了/);
  // 没用完不提示；同周期再扫不重复发
  snaps.zhipu.windows[0].usedPercent = 40;
  assert.equal(gifts.scanStuckClaims(list, { snapshots: snaps, providers: provs, now: T + 1000 }).length, 0);
  snaps.zhipu.windows[0].usedPercent = 100;
  assert.equal(gifts.scanStuckClaims(list, { snapshots: snaps, providers: provs, now: T + 2000 }).length, 0, 'already tracked, stays silent');
});

test('stuck hints mention waiting when credits are absent and skip non-binding windows', () => {
  const list = [];
  const provs = [{ id: 'codex', type: 'codex', name: 'Codex / ChatGPT', enabled: true }];
  const snaps = { codex: { ok: true, credits: { has_credits: false, balance: '0' }, windows: [{ key: 'primary', label: '5小时', usedPercent: 100, windowMinutes: 300, resetsAt: Math.floor(T / 1000) + 3600 }, { key: 'secondary', label: '7天', usedPercent: 100, windowMinutes: 10080, resetsAt: Math.floor(T / 1000) + 86400 }] } };
  const out = gifts.scanStuckClaims(list, { snapshots: snaps, providers: provs, now: T });
  assert.equal(out.length, 1, 'only the binding (shortest) window triggers');
  assert.match(out[0].body, /5小时用完了/);
  assert.match(out[0].body, /后自动重置/);
  assert.doesNotMatch(out[0].body, /credits/);
  // 5 小时还有余量时，每周窗口耗尽不算卡住
  const list2 = [];
  snaps.codex.windows[0].usedPercent = 30;
  assert.equal(gifts.scanStuckClaims(list2, { snapshots: snaps, providers: provs, now: T }).length, 0);
});

test('stuck hints resolve the moment quota recovers and re-arm if it runs out again', () => {
  const list = [];
  const provs = [{ id: 'zhipu', type: 'zhipu', name: 'Z.ai Coding Plan', enabled: true }];
  const w = { key: 'primary', label: '5小时 积分', usedPercent: 100, windowMinutes: 300, resetsAt: Math.floor(T / 1000) + 3600 };
  const snaps = { zhipu: { ok: true, windows: [w] } };
  gifts.scanStuckClaims(list, { snapshots: snaps, providers: provs, now: T });
  list[0].notifId = 'n9'; // 主进程落通知时会回填；测试里手工对齐
  // 额度恢复（重置或用了重置卡）→ 出路提示自动了结并清未读
  w.usedPercent = 20;
  let r = gifts.collectGiftReminders(list, giftCtx({ snapshots: snaps, now: T + 60000 }));
  assert.equal(list[0].resolved, true);
  assert.deepEqual(r.readIds, ['n9']);
  // 同一周期又跑光了 → 重新武装并再次提示
  w.usedPercent = 100;
  const again = gifts.scanStuckClaims(list, { snapshots: snaps, providers: provs, now: T + 120000 });
  assert.equal(again.length, 1);
  assert.match(again[0].title, /又用完了/);
  assert.equal(list[0].resolved, false);
  r = gifts.collectGiftReminders(list, giftCtx({ snapshots: snaps, now: T + 33 * 60000 }));
  assert.equal(r.notices.length, 1, 're-armed hint repeats on the normal cadence');
  assert.equal(r.notices[0].kind, 'stuck');
  assert.match(r.notices[0].title, /还没额度/);
});

test('zhipu uses ZCode period codes and never infers free trials from reset dates', () => {
  const zhipu = require('../src/main/providers/zhipu');
  const now = Math.floor(Date.now() / 1000);
  for (const seconds of [3 * 3600, 5.45 * 86400, 30 * 86400]) {
    assert.equal(zhipu.zhipuLabel({ type: 'CREDIT_LIMIT', unit: 6, number: 1, nextResetTime: (now + seconds) * 1000 }, now), '每周 积分');
  }
  assert.equal(zhipu.zhipuLabel({ type: 'TOKENS_LIMIT', unit: 6, number: 1 }), '每周 Token');
  assert.equal(zhipu.zhipuLabel({ type: 'TIME_LIMIT', unit: 5, number: 1 }), '每月 MCP');
  assert.equal(zhipu.zhipuLabel({ type: 'CREDIT_LIMIT', unit: 3, number: 5 }), '5小时 积分');
});

test('a relabeled known window is not mistaken for a brand-new gift window', () => {
  const resetsAt = now + 5 * 86400;
  const prev = { ok: true, at: Date.now(), windows: [{ key: 'primary', label: '5小时 积分', usedPercent: 9, resetsAt: now + 7200, unit: 3 }, { key: 'secondary:1440:每日 积分', label: '每日 积分', usedPercent: 60, total: 10000, remaining: 3918, resetsAt, unit: 6 }] };
  const next = { ok: true, at: Date.now(), windows: [{ key: 'primary', label: '5小时 积分', usedPercent: 10, resetsAt: now + 7200, unit: 3 }, { key: 'secondary:1440:免费体验 积分', label: '免费体验 积分', usedPercent: 61, total: 10000, remaining: 3917, resetsAt, unit: 6 }] };
  const ev = diffSnapshots(prev, next, provider, config);
  assert.equal(ev.filter((e) => e.claim).length, 0, 'relabel must not fire a claimable new-window gift');
  assert.equal(ev.length, 0);
});
