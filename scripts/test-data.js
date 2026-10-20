'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { JsonStore, deepMerge } = require('../src/main/config');
const { num, toEpochSec } = require('../src/main/providers/util');
const { dueCharacters } = require('../src/main/quips');
const activity = require('../src/main/activity');
const { isRelay, relayMetric } = require('../src/shared/usage');

test('relay displays balance first, including real zero, and never substitutes lifetime spend', () => {
  assert.equal(isRelay({ type: 'newapi' }), true);
  assert.equal(isRelay({ type: 'openai' }), true);
  assert.equal(isRelay({ type: 'codex' }), false);
  const metric = relayMetric({ balance: 0, currency: 'USD', extra: { unlimited: true, used: 999 } }, null);
  assert.equal(metric.label, '余额'); assert.equal(metric.value, 0);
  assert.equal(relayMetric({ balance: null, extra: { used: 999 }, todayUsage: 999 }, null).value, null);
});

test('relay daily spend is date and currency scoped and retains observed zero', () => {
  const now = new Date(2026, 9, 20, 12);
  const ledger = { date: '2026-10-20', todayUsage: 1.25, lastCurrency: 'USD#used' };
  const s = { balance: null, currency: 'USD', extra: { unlimited: true, used: 999 } };
  assert.equal(relayMetric(s, ledger, now).value, 1.25);
  assert.equal(relayMetric(s, { ...ledger, todayUsage: 0 }, now).value, 0);
  assert.equal(relayMetric(s, { ...ledger, date: '2026-10-19' }, now).value, null);
  assert.equal(relayMetric(s, { ...ledger, lastCurrency: 'CNY' }, now).value, null);
  assert.match(relayMetric(s, ledger, now).hint, /观测/);
});

function mockedModule(relative, mocks) {
  const file = path.resolve(__dirname, '..', relative);
  const native = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: (id) => mocks[id] || native(id), process, Buffer, console, setTimeout, clearTimeout }, { filename: file });
  return module.exports;
}
const response = (data, ok = true, status = 200) => ({ data, ok, status, text: ok ? '' : 'fixture failure' });
const httpMock = (fn) => ({ request: fn, requestRetry: fn });

test('missing numbers stay unknown and real zero remains zero', () => {
  for (const x of [null, undefined, '', false, true, 'bad']) assert.equal(num(x), null);
  assert.equal(num('0'), 0);
  assert.equal(num(0), 0);
  assert.equal(toEpochSec('1800000000000'), 1800000000);
});

test('DeepSeek requires real total balance and does not fabricate a gift amount', async () => {
  let info = { currency: 'CNY' };
  const impl = mockedModule('src/main/providers/deepseek.js', { '../http': httpMock(async () => response({ balance_infos: [info] })) });
  assert.equal((await impl.fetchSnapshot({ apiKey: 'fixture' })).ok, false);
  info = { currency: 'CNY', total_balance: '0' };
  const r = await impl.fetchSnapshot({ apiKey: 'fixture' });
  assert.equal(r.ok, true); assert.equal(r.balance, 0); assert.equal(r.granted, null);
});

test('relay cannot subtract a failed usage query from the entire quota', async () => {
  const impl = mockedModule('src/main/providers/newapi.js', { '../http': httpMock(async (url) => url.includes('/subscription') ? response({ hard_limit_usd: 20 }) : response(null, false, 503)) });
  const r = await impl.fetchSnapshot({ baseUrl: 'https://fixture.invalid', apiKey: 'fixture', announcements: false });
  assert.equal(r.ok, false); assert.equal(r.balance, null); assert.match(r.error, /用量获取失败/);
});

test('unlimited relay tokens expose cumulative usage and leave account balance unknown', async () => {
  const impl = mockedModule('src/main/providers/newapi.js', { '../http': httpMock(async (url) => response(url.includes('/subscription') ? { hard_limit_usd: 1e8 } : { total_usage: 500 })) });
  const r = await impl.fetchSnapshot({ baseUrl: 'https://fixture.invalid', apiKey: 'fixture', announcements: false });
  assert.equal(r.ok, true); assert.equal(r.balance, null); assert.equal(r.extra.unlimited, true); assert.equal(r.extra.used, 5);
  assert.ok(r.lines.every(line => !line.includes('累计')));
});

test('Claude 0.5 utilization means 0.5 percent and optional Sonnet window is preserved', async () => {
  const impl = mockedModule('src/main/providers/claude-oauth.js', { '../http': httpMock(async () => response({ five_hour: { utilization: 0.5 }, seven_day_sonnet: { utilization: 0 } })), './util': { ...require('../src/main/providers/util'), readJson: () => ({ claudeAiOauth: { accessToken: 'fixture' } }) } });
  const r = await impl.fetchSnapshot({});
  assert.equal(r.windows[0].usedPercent, 0.5); assert.equal(r.windows[1].key, 'sonnet'); assert.equal(r.windows[1].usedPercent, 0);
});

test('ZCode returns failure for empty quota data, while real zero percent is valid', async () => {
  let limits = [{ percentage: null }];
  const impl = mockedModule('src/main/providers/zhipu.js', { '../http': httpMock(async () => response({ code: 200, data: { limits } })) });
  assert.equal((await impl.fetchSnapshot({ apiKey: 'fixture' })).ok, false);
  limits = [{ percentage: 0, type: 'TOKENS_LIMIT', number: 5, unit: 3 }];
  const r = await impl.fetchSnapshot({ apiKey: 'fixture' });
  assert.equal(r.ok, true); assert.equal(r.windows[0].usedPercent, 0);
});

test('config persistence recovers last valid backup without losing corrupt original', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-store-'));
  t.after(() => { assert.ok(dir.startsWith(path.join(os.tmpdir(), 'aipet-store-'))); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'config.json'), defaults = () => ({ appearance: { scale: 1, character: 'auto' }, secretFixture: '' });
  const store = new JsonStore(file, defaults);
  store.load(); store.data.secretFixture = 'keep-local'; assert.equal(store.save(), true);
  store.data.appearance.scale = 1.5; assert.equal(store.save(), true);
  fs.writeFileSync(file, '{broken');
  const recovered = new JsonStore(file, defaults).load();
  assert.equal(recovered.secretFixture, 'keep-local');
  assert.ok(fs.readdirSync(dir).some((x) => x.startsWith('config.json.broken-')));
  assert.equal(deepMerge({ appearance: { scale: 1.5, character: 'zcode' } }, { appearance: { scale: 1.2 } }).appearance.character, 'zcode');
});

test('failed quip roles retry after backoff; successful roles wait their normal interval', () => {
  const now = 2000000000000, state = { updatedAt: now - 60000, characterAt: { codex: now - 60000 }, failed: ['claude'], retryAfter: now + 60000 };
  assert.deepEqual(dueCharacters({ intervalHours: 24 }, state, ['codex', 'claude'], now), []);
  assert.deepEqual(dueCharacters({ intervalHours: 24 }, state, ['codex', 'claude'], now + 60001), ['claude']);
});

test('new background work takes over once the short launch grace expires', () => {
  const now = Date.now();
  const r = activity.selectCharacter({ appearance: { character: 'auto' }, now, recent: { character: 'zcode', reason: 'launch', at: now - 20000 }, activity: { details: { claude: now - 500 } } });
  assert.equal(r.character, 'claude');
});

test('launcher reports asynchronous spawn failures and constrains running detection to the executable', async () => {
  let processFilter;
  const impl = mockedModule('src/main/launcher.js', { electron: { shell: { openExternal: async () => { throw new Error('fixture browser failure'); } } }, './winsnap': { findWindow: (_, exe) => { processFilter = exe; return null; } }, child_process: { execFileSync: () => '', spawn: () => { const c = new EventEmitter(); c.unref = () => {}; process.nextTick(() => c.emit('error', new Error('fixture spawn failure'))); return c; } } });
  const r = await impl.launch('zcode', { zcode: { kind: 'app', target: __filename, label: 'fixture' } });
  assert.equal(processFilter, path.basename(__filename)); assert.equal(r.ok, false); assert.match(r.message, /spawn failure/);
  const url = await impl.launch('gemini', { gemini: { kind: 'url', target: 'https://fixture.invalid' } });
  assert.equal(url.ok, false); assert.match(url.message, /browser failure/);
});

test('Gemini desktop uses a stable installed entry, focuses its process and falls back to web when absent', async () => {
  let installed = true, running = false, spawns = 0, focused = 0, opened = 0;
  const impl = mockedModule('src/main/launcher.js', {
    fs: { existsSync: p => installed && /[\\/]Google[\\/]Gemini[\\/]Gemini\.exe$/.test(p) },
    electron: { shell: { openExternal: async () => { opened++; } } },
    './winsnap': { findWindow: (_, exe) => running && exe === 'Gemini.exe' ? { hwnd: 'fixture' } : null, focusWindow: () => { focused++; } },
    child_process: { execFileSync: () => '', spawn: () => { spawns++; const child = new EventEmitter(); child.unref = () => {}; process.nextTick(() => child.emit('spawn')); return child; } },
  });
  const spec = impl.resolve('gemini', {});
  assert.equal(spec.kind, 'app'); assert.equal(spec.process, 'Gemini.exe'); assert.doesNotMatch(spec.target, /app-\d/);
  assert.equal((await impl.launch('gemini', {})).ok, true); assert.equal(spawns, 1); assert.equal(opened, 0);
  running = true;
  assert.equal((await impl.launch('gemini', {})).already, true); assert.equal(focused, 1); assert.equal(spawns, 1);
  installed = false; running = false;
  assert.equal(impl.resolve('gemini', {}).kind, 'url');
  assert.equal((await impl.launch('gemini', {})).ok, true); assert.equal(opened, 1);
});

test('GPT uses registered Windows activation without a personal repair script or blocking process scan', async () => {
  let processScans = 0;
  const calls = [];
  const impl = mockedModule('src/main/launcher.js', {
    fs: { existsSync: () => true },
    electron: { shell: {} },
    './winsnap': { findWindow: () => null },
    child_process: {
      execFileSync: () => { processScans++; return '"ChatGPT.exe","fixture"'; },
      spawn: (command, args) => { calls.push({ command, args }); const child = new EventEmitter(); child.unref = () => {}; process.nextTick(() => child.emit('spawn')); return child; },
    },
  });
  assert.equal(impl.defaults().codex.script, undefined);
  const result = await impl.launch('codex', {});
  assert.equal(result.ok, true); assert.equal(result.already, undefined);
  assert.equal(processScans, 0);
  assert.equal(calls[0].command, 'explorer.exe');
  assert.equal(calls[0].args[0], 'shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App');
});

test('custom agents match by process or title before built-in rules and survive bad regex', () => {
  const agents = [{ id: 'trae', process: 'Trae.exe|Trae CN.exe' }, { id: 'yb', title: '^腾讯元宝' }, { id: 'bad', title: '(' }];
  assert.equal(activity.characterForWindow({ title: 'x', processName: 'Trae CN.exe' }, agents), 'trae');
  assert.equal(activity.routeForWindow({ title: '腾讯元宝 - Google Chrome', processName: 'chrome.exe' }, {}, [], agents), 'yb');
  assert.equal(activity.characterForWindow({ title: 'Codex', processName: 'ChatGPT.exe' }, agents), 'codex');
});

test('cursor usage prefers reported percent, falls back to overall ratio, builds cookie from JWT sub', () => {
  const { parseUsage, cookieFor } = require('../src/main/providers/cursor');
  const a = parseUsage({ membershipType: 'pro', billingCycleEnd: '2026-11-01T00:00:00Z', individualUsage: { plan: { used: 0, limit: 0, totalPercentUsed: 30.8, autoPercentUsed: 28.6 }, onDemand: { enabled: true, used: 50, limit: 200 } } });
  assert.equal(a.windows[0].usedPercent, 30.8); assert.equal(a.windows[1].usedPercent, 25); assert.equal(a.plan, 'pro');
  assert.equal(parseUsage({ individualUsage: { overall: { used: 4500, limit: 45000 } } }).windows[0].usedPercent, 10);
  assert.equal(parseUsage({ individualUsage: { overall: { used: 1, limit: null } } }).windows.length, 0);
  const jwt = 'h.' + Buffer.from(JSON.stringify({ sub: 'auth0|user_42' })).toString('base64url') + '.s';
  assert.equal(cookieFor(jwt), 'WorkosCursorSessionToken=user_42%3A%3A' + jwt);
});

test('custom json provider reads dotted paths', () => {
  const { parse } = require('../src/main/providers/custom');
  const d = { data: { q: { used: 30, total: 120 }, wallet: [{ left: '8.5' }] } };
  assert.equal(parse({ usedPath: 'data.q.used', limitPath: 'data.q.total' }, d).windows[0].usedPercent, 25);
  assert.equal(parse({ balancePath: 'data.wallet.0.left' }, d).balance, 8.5);
  assert.equal(parse({ usedPath: 'nope' }, d).windows.length, 0);
});
