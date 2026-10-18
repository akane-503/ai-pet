'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const activity = require('../src/main/activity');
const { diffSnapshots } = require('../src/main/notify');

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
