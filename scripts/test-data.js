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

test('handoff desktop launch failure stays a failure and never requests automatic paste', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const sent = [], copied = [], calls = [];
  const ctx = vm.createContext({ QUOTA_ONLY: false,
    path, setTimeout, Date, console, AbortController, state: {data: {}, saveSoon:()=>{}}, handoffEstimate: require('../src/main/handoff-estimate'), handoffReturn: require('../src/main/handoff-return'), handoffJob: null, lastAgentWin: null, lastHandoffJob: null, handoffSerial:0, updateTrayMenu: () => {}, desktopDraft:{isDsh:()=>false}, quipsKey: () => null, handoffApi: { KINDS: {} }, charOf: (k) => k,
    launcher: { supportsWorkspace: s => s.kind === 'app', launch: async (...args) => { calls.push(args); return { ok:false, message:'fixture launch failed' }; } },
    launchCfg: () => ({}), recent: {}, pushData: () => {}, log: () => {},
    sendPet: (_ch, p) => sent.push(p), clipboard: { writeText: s => copied.push(s) },
    handoff: { latest: () => ({file:'D:\\fixture\\HANDOFF.md',at:1}), takeoverPrompt: p => `接手 ${p}`, goalOf: () => '' },
    winsnap: { pasteKeys: () => { throw Error('desktop must not paste'); } },
  });
  vm.runInContext(source.slice(source.indexOf('async function launchFor('), source.indexOf('function launchCurrent()')), ctx);
  await vm.runInContext("runHandoff('fixture', {kind:'app',label:'Fixture'}, null)", ctx);
  assert.equal(calls.length, 1); assert.equal(calls[0][2].cwd, 'D:\\fixture');
  assert.equal(copied.length, 1);
  assert.ok(sent.every(p => p.target === 'Fixture'));
  assert.equal(sent.at(-1).heading, '还差一步');
  assert.equal(sent.at(-1).detail, 'fixture launch failed');
  assert.equal(sent.at(-1).failed, true);
  ctx.launcher.launch = async () => ({ok:true});
  await vm.runInContext("runHandoff('fixture', {kind:'app',label:'Fixture'}, null)", ctx);
  assert.equal(sent.at(-1).heading, '到新对话粘贴');
  assert.match(sent.at(-1).detail, /工作区：fixture/);
  // 没有来源窗口时用的是「上一次交接」，必须说清是哪个项目，别让人以为是自己这个
  assert.match(sent.at(-1).detail, /用的是最近一次交接：fixture/);
  await vm.runInContext("runHandoff('fixture', {kind:'url',label:'Fixture'}, null)", ctx);
  assert.equal(sent.at(-1).heading, '到新对话粘贴');
  assert.doesNotMatch(sent.at(-1).detail, /工作区/);
  let resolveLaunch;
  ctx.launcher.launch = () => new Promise(r => {resolveLaunch=r;});
  const previous = vm.runInContext("runHandoff('fixture', {kind:'app',label:'Old'}, null)", ctx);
  await new Promise(setImmediate);
  const oldId = sent.at(-1).id;
  vm.runInContext(`handoffAction({action:'cancel',id:${oldId}})`, ctx);
  assert.equal(sent.at(-1).cancelled, true);
  ctx.launcher.launch = async () => ({ok:true});
  await vm.runInContext("runHandoff('fixture', {kind:'app',label:'New'}, null)", ctx);
  const count=sent.length, latestId=sent.at(-1).id;
  resolveLaunch({ok:false,message:'late old failure'}); await previous;
  assert.equal(sent.length,count); assert.equal(sent.at(-1).id,latestId);
  vm.runInContext(`handoffAction({action:'copy',id:${oldId}})`, ctx);
  const beforeCopy=copied.length;
  vm.runInContext(`handoffAction({action:'copy',id:${latestId}})`, ctx);
  assert.equal(copied.length,beforeCopy+1);
  ctx.handoff.writePrompt = () => 'write fixture handoff';
  let reads=0;
  ctx.handoff.latest = () => ({file:'D:\\fixture\\HANDOFF.md',at:++reads>=3?2:1});
  ctx.winsnap.bringToFront = () => false;
  ctx.waitFor = async fn => fn();
  await vm.runInContext("runHandoff('fixture', {kind:'app',label:'Manual source'}, {hwnd:'owned-fixture'})",ctx);
  assert.ok(sent.some(p=>p.manualSource));
  assert.equal(sent.at(-1).failed,false); assert.equal(sent.at(-1).manualSource,false);
  assert.equal(sent.at(-1).heading,'到新对话粘贴');
  ctx.launcher.launch=async()=>{throw Error('fixture unexpected exception')};
  await vm.runInContext("runHandoff('fixture', {kind:'app',label:'Error'}, null)",ctx);
  assert.equal(sent.at(-1).failed,true); assert.match(sent.at(-1).detail,/unexpected exception/);
  ctx.launcher.launch=async()=>({ok:true});
  ctx.desktopDraft={isDsh:()=>true,prefillDsh:async()=>({code:'prefilled',prefilled:true,workspaceVerified:true})};
  ctx.winsnap.findWindow=()=>({hwnd:'dsh-fixture'});ctx.winsnap.bringToFront=()=>true;
  await vm.runInContext("runHandoff('deepseek', {kind:'app',label:'DSH Desktop'}, null)",ctx);
  assert.equal(sent.at(-1).heading,'在 DSH 确认发送');
  ctx.desktopDraft.prefillDsh=async()=>({code:'draft-present',prefilled:false,workspaceVerified:true});
  await vm.runInContext("runHandoff('deepseek', {kind:'app',label:'DSH Desktop'}, null)",ctx);
  assert.equal(sent.at(-1).heading,'到新对话粘贴');assert.match(sent.at(-1).detail,/保留原草稿/);
  let draftAborted=false;
  ctx.desktopDraft.prefillDsh=({signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>{draftAborted=true;resolve({code:'cancelled',prefilled:false});},{once:true}));
  const filling=vm.runInContext("runHandoff('deepseek', {kind:'app',label:'DSH Desktop'}, null)",ctx);
  await new Promise(setImmediate);
  const fillingId=sent.at(-1).id;
  vm.runInContext(`handoffAction({action:'cancel',id:${fillingId}})`,ctx);await filling;
  assert.equal(draftAborted,true);assert.equal(sent.at(-1).cancelled,true);
});

test('handoff marker must point to an existing absolute file, not a stale missing path or directory', () => {
  const {latest}=require('../src/main/handoff');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pet-handoff-'));
  try {
    const marker=path.join(dir,'latest.txt'), file=path.join(dir,'HANDOFF.md');
    fs.writeFileSync(marker,path.join(dir,'missing.md')); assert.equal(latest(marker),null);
    fs.writeFileSync(marker,dir); assert.equal(latest(marker),null);
    fs.writeFileSync(marker,'HANDOFF.md'); assert.equal(latest(marker),null);
    fs.writeFileSync(file,'fixture'); fs.writeFileSync(marker,`old line\n"${file}"\n`);
    assert.equal(latest(marker).file,file);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('pet right-click exposes copy, cancel and hide without squeezing controls into the bubble', () => {
  const source=fs.readFileSync(path.join(__dirname,'../src/main/main.js'),'utf8'),actions=[],commands=[];
  const ctx=vm.createContext({ QUOTA_ONLY: false,buildMenuTemplate:()=>Array.from({length:9},(_,i)=>({label:'ordinary '+i})),handoffJob:{id:9,text:'fixture'},lastHandoffJob:null,petWin:null,handoffAction:a=>actions.push(a),sendPet:(ch,p)=>commands.push({ch,p})});
  vm.runInContext(source.slice(source.indexOf('function petMenuTemplate()'),source.indexOf('function updateTrayMenu()')),ctx);
  const menu=vm.runInContext('petMenuTemplate()',ctx);
  menu.find(x=>x.label?.includes('复制交接指令')).click();assert.equal(actions[0].action,'copy');assert.equal(actions[0].id,9);
  menu.find(x=>x.label?.includes('取消交接')).click();assert.equal(actions[1].action,'cancel');
  menu.find(x=>x.label==='收起交接提示').click();assert.equal(actions[2].action,'close');
  ctx.lastHandoffJob=ctx.handoffJob;ctx.handoffJob=null;
  const completed=vm.runInContext('petMenuTemplate()',ctx);
  assert.ok(completed.some(x=>x.label?.includes('复制交接指令')));assert.equal(completed.some(x=>x.label?.includes('取消交接')),false);
});

test('handoff checks focus again before delayed Enter and reports whether it was sent', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/winsnap.js'), 'utf8');
  let focused = '1', stealFocus = false;
  const keys = [];
  const api = { GetForegroundWindow: () => focused, keybd_event: (...args) => keys.push(args) };
  const ctx = vm.createContext({ QUOTA_ONLY: false, init: () => api, koffi: {address:p=>p}, setTimeout: cb => { if (stealFocus) focused='2'; cb(); } });
  vm.runInContext(source.slice(source.indexOf('async function pasteKeys('), source.indexOf('function available()')), ctx);
  assert.equal(await vm.runInContext("pasteKeys(true, '1')", ctx), true);
  assert.equal(keys.filter(k=>k[0]===0x0D).length, 2);
  keys.length=0; stealFocus=true;
  assert.equal(await vm.runInContext("pasteKeys(true, '1')", ctx), false);
  assert.equal(keys.filter(k=>k[0]===0x0D).length, 0);
  keys.length=0;
  assert.equal(await vm.runInContext("pasteKeys(true, '1')", ctx), false);
  assert.equal(keys.length, 0);
  focused='1'; keys.length=0; ctx.cancelled=false;
  ctx.setTimeout=cb=>{ctx.cancelled=true;cb();};
  assert.equal(await vm.runInContext("pasteKeys(true, '1', () => cancelled)",ctx),false);
  assert.equal(keys.filter(k=>k[0]===0x0D).length,0);
});

test('relay displays balance first, including real zero, and never substitutes lifetime spend', () => {
  assert.equal(isRelay({ type: 'newapi' }), true);
  assert.equal(isRelay({ type: 'openai' }), true);
  assert.equal(isRelay({ type: 'codex' }), false);
  assert.equal(isRelay({ type: 'gemini' }), false);
  assert.equal(isRelay({ type: 'gemini', baseUrl: 'https://relay.invalid' }), true);
  assert.equal(isRelay({ type: 'gemini', auth: 'relay' }), true);
  assert.equal(isRelay({ type: 'gemini' }, { relay: true }), true);
  const metric = relayMetric({ balance: 0, currency: 'USD', extra: { unlimited: true, used: 999 } }, null);
  assert.equal(metric.label, '余额'); assert.equal(metric.value, 0);
  assert.equal(relayMetric({ balance: null, extra: { used: 999 }, todayUsage: 999 }, null).value, null);
});

test('relay never presents partial local observations as whole-day spend', () => {
  const now = new Date(2026, 9, 20, 12);
  const ledger = { date: '2026-10-20', todayUsage: 1.25, lastCurrency: 'USD#used' };
  const s = { balance: null, currency: 'USD', extra: { unlimited: true, used: 999 } };
  assert.equal(relayMetric(s, ledger, now).value, null);
  assert.equal(relayMetric(s, { ...ledger, todayUsage: 0 }, now).value, null);
  assert.equal(relayMetric(s, { ...ledger, date: '2026-10-19' }, now).value, null);
  assert.equal(relayMetric(s, { ...ledger, lastCurrency: 'CNY' }, now).value, null);
  assert.equal(relayMetric(s, ledger, now).label, '账户余额');
  assert.match(relayMetric(s, ledger, now).hint, /需配置系统访问令牌/);
  assert.equal(relayMetric({ ...s, balance: 3.25 }, ledger, now).value, 3.25);
});

function mockedModule(relative, mocks) {
  const file = path.resolve(__dirname, '..', relative);
  const native = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, __dirname:path.dirname(file), __filename:file, require: (id) => mocks[id] || native(id), process, Buffer, console, setTimeout, clearTimeout }, { filename: file });
  return module.exports;
}
const response = (data, ok = true, status = 200) => ({ data, ok, status, text: ok ? '' : 'fixture failure' });
const httpMock = (fn) => ({ request: fn, requestRetry: fn });

test('HTTP read retries use Node after Chromium network failure, without replaying POST through another stack', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/http.js'), 'utf8');
  for (const method of ['GET', 'POST']) {
    let electronCalls = 0, nodeCalls = 0;
    const module = { exports: {} };
    const nativeFetch = async () => { nodeCalls++; return { ok: true, status: 200, text: async () => '{"value":1}' }; };
    vm.runInNewContext(source, {
      module, exports: module.exports, AbortController,
      setTimeout: (fn, ms) => setTimeout(fn, ms === 600 ? 0 : ms), clearTimeout,
      fetch: nativeFetch, require: () => ({ net: { fetch: async () => { electronCalls++; throw new Error('net::ERR_TIMED_OUT'); } } }),
    });
    if (method === 'GET') {
      const r = await module.exports.requestRetry('https://fixture.invalid', { method });
      assert.equal(r.data.value, 1); assert.equal(nodeCalls, 1); assert.equal(electronCalls, 1);
    } else {
      await assert.rejects(module.exports.requestRetry('https://fixture.invalid', { method }), /ERR_TIMED_OUT/);
      assert.equal(nodeCalls, 0); assert.equal(electronCalls, 2);
    }
  }
});

test('B edition hides handoff and tool launch menus, and blocks handoff execution', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const ctx = vm.createContext({ QUOTA_ONLY: true, config: { data: { appearance: {} } },
    state: { data: { notifications: [] } }, allCharacters: () => [], winsnap: { available: () => false }, petWin: null,
  });
  vm.runInContext(source.slice(source.indexOf('function buildMenuTemplate('), source.indexOf('function updateTrayMenu(')), ctx);
  const labels = vm.runInContext('petMenuTemplate().map(m => m.label || "").join("|")', ctx);
  assert.doesNotMatch(labels, /交接|打开其他|打开对应/);
  assert.match(labels, /刷新额度|设置/);
  vm.runInContext(source.slice(source.indexOf('async function runHandoff('), source.indexOf('function launchCurrent(')), ctx);
  await vm.runInContext('runHandoff()', ctx); // 没有任何交接依赖也应直接返回。
});

test('B onboarding only enables actual quota results and uses account credentials for relays', () => {
  const g = require('../src/renderer/onboarding');
  assert.equal(g.usable({ ok: true, balance: 0 }), true);
  assert.equal(g.usable({ ok: true, windows: [{ usedPercent: 0 }] }), true);
  assert.equal(g.usable({ ok: true, usedTotal: 900, balance: null }), false);
  assert.equal(g.usable({ ok: false, balance: 5 }), false);
  assert.deepEqual(g.fieldsFor({ type: 'newapi' }), ['baseUrl', 'accessToken', 'userId']);
  assert.deepEqual(g.fieldsFor({ type: 'gemini', auth: 'oauth' }), ['credentialsPath']);
});

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

test('Gemini CLI on a relay reports relay usage instead of a fabricated balance', async () => {
  const normBase = require('../src/main/providers/newapi').normBase;
  const impl = mockedModule('src/main/providers/gemini.js', { './newapi': { normBase, fetchSnapshot: async () => ({ ok: true, currency: 'USD', balance: null, usedTotal: 0.0801, extra: { unlimited: true, used: 0.0801 } }) } });
  const r = await impl.fetchSnapshot({ baseUrl: 'https://relay.invalid', apiKey: 'fixture' });
  assert.equal(r.ok, true); assert.equal(r.relay, true); assert.equal(r.balance, null); assert.equal(r.usedTotal, 0.0801);
  assert.match(r.lines.join(' '), /中转站/);
  assert.match(r.lines.join(' '), /今日用量未知/);
  assert.doesNotMatch(r.lines.join(' '), /累计已用/);
});

test('Gemini relay failure is reported as a relay error, not as missing credentials', async () => {
  const normBase = require('../src/main/providers/newapi').normBase;
  const impl = mockedModule('src/main/providers/gemini.js', { './newapi': { normBase, fetchSnapshot: async () => ({ ok: false, error: 'billing HTTP 401' }) } });
  const r = await impl.fetchSnapshot({ baseUrl: 'https://relay.invalid', apiKey: 'fixture' });
  assert.equal(r.ok, false); assert.match(r.error, /中转站/); assert.match(r.error, /401/);
});

test('Gemini OAuth maps remaining fraction to per-group usage and keeps the lowest', async () => {
  const http = { request: async (url) => url.includes('loadCodeAssist')
    ? response({ currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'proj-1' })
    : response({ buckets: [
      { modelId: 'gemini-3-pro', remainingFraction: 0.25, resetTime: '2026-10-22T00:00:00Z' },
      { modelId: 'gemini-3-flash', remainingFraction: 0.9, resetTime: '2026-10-22T00:00:00Z' },
      { modelId: 'gemini-3-pro-preview', remainingFraction: 0.5 },
      { modelId: 'gemini-unknown', remainingFraction: null },
    ] }) };
  const impl = mockedModule('src/main/providers/gemini.js', { '../http': http, './util': { ...require('../src/main/providers/util'), readJson: () => ({ access_token: 'fixture', expiry_date: Date.now() + 3600e3 }) } });
  const r = await impl.fetchSnapshot({ auth: 'oauth' });
  assert.equal(r.ok, true); assert.equal(r.plan, 'Pro');
  assert.deepEqual(r.windows.map((w) => [w.key, Math.round(w.usedPercent)]), [['pro', 75], ['flash', 10]]);
  assert.equal(r.windows[0].resetsAt, Date.parse('2026-10-22T00:00:00Z') / 1000);
  assert.equal(r.fraction, 0.25);
  assert.match(r.lines[0], /Gemini Pro/);
});

test('Gemini expired OAuth token asks for a CLI login instead of guessing quota', async () => {
  const impl = mockedModule('src/main/providers/gemini.js', { '../http': httpMock(async () => response({})), './util': { ...require('../src/main/providers/util'), readJson: () => ({ access_token: 'fixture', expiry_date: Date.now() - 3600e3 }) } });
  const r = await impl.fetchSnapshot({ auth: 'oauth' });
  assert.equal(r.ok, false); assert.match(r.error, /过期/);
});

test('Gemini without any credentials explains where to point the CLI', async () => {
  const impl = mockedModule('src/main/providers/gemini.js', { '../http': httpMock(async () => response({})), './util': { ...require('../src/main/providers/util'), readJson: () => null } });
  const r = await impl.fetchSnapshot({ auth: 'oauth' });
  assert.equal(r.ok, false); assert.match(r.error, /oauth_creds\.json/);
  assert.equal(r.relay, false); assert.equal(r.source, 'oauth');
});

test('Gemini refresh does not keep relay amounts after switching to official auth', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const old = { ok: true, relay: true, source: 'relay', balance: 2, at: 1 };
  let result = { ok: false, relay: false, source: 'oauth', error: 'missing OAuth' };
  const state = { data: { snapshots: { gemini: old } }, saveSoon: () => {} };
  const ctx = vm.createContext({ QUOTA_ONLY: false,
    refreshing: false, lastModelsCheck: Date.now(), pushData: () => {}, Date,
    config: { data: { refresh: {}, notify: {} } }, state,
    enabledProviders: () => [{ id: 'gemini', type: 'gemini' }],
    providers: { fetchSnapshot: async () => result }, log: () => {},
  });
  vm.runInContext(source.slice(source.indexOf('async function refreshAll('), source.indexOf('function scheduleRefresh(')), ctx);
  await vm.runInContext('refreshAll()', ctx);
  assert.equal(state.data.snapshots.gemini.ok, false);
  assert.equal(state.data.snapshots.gemini.balance, undefined);
  state.data.snapshots.gemini = old;
  result = { ok: false, relay: true, source: 'relay', error: 'temporary network failure' };
  await vm.runInContext('refreshAll()', ctx);
  assert.equal(state.data.snapshots.gemini.stale, true);
  assert.equal(state.data.snapshots.gemini.balance, 2, '同一来源暂时失败仍保留旧数据并标过期');
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

test('switching launch kind does not inherit a different entry and empty CLI commands never launch', async () => {
  let spawns = 0;
  const impl = mockedModule('src/main/launcher.js', {
    electron: { shell: {} }, './winsnap': {},
    child_process: { spawn: () => { spawns++; throw Error('must not spawn'); } },
  });
  const spec = impl.resolve('codex', { codex: { kind: 'cli', command: 'codex' } });
  assert.equal(spec.command, 'codex'); assert.equal(spec.target, undefined); assert.equal(spec.process, undefined); assert.equal(spec.script, undefined);
  for (const kind of ['cli', 'wsl-cli']) {
    const result = await impl.launch('codex', { codex: { kind, command: '   ' } });
    assert.equal(result.ok, false); assert.match(result.message, /填写启动命令/);
  }
  assert.equal(spawns, 0);
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
  let installed = true, running = false, spawns = 0, focused = 0, opened = 0, cli = false;
  const impl = mockedModule('src/main/launcher.js', {
    fs: { existsSync: p => (cli && /[\\/]npm[\\/]gemini\.cmd$/.test(p)) || (installed && /[\\/]Google[\\/]Gemini[\\/]Gemini\.exe$/.test(p)) },
    electron: { shell: { openExternal: async () => { opened++; } } },
    './winsnap': { findWindow: (_, exe) => running && exe === 'Gemini.exe' ? { hwnd: 'fixture' } : null, bringToFront: () => { focused++; } },
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
  // 装了 Gemini CLI 时默认开 CLI
  cli = true;
  const g = impl.resolve('gemini', {}); assert.equal(g.kind, 'cli'); assert.equal(g.label, 'Gemini CLI'); assert.equal(g.command, 'gemini');
  for (const [kind, label] of [['cli', 'Gemini CLI'], ['app', 'Gemini 桌面版'], ['url', 'Gemini 网页']]) {
    assert.equal(impl.resolve('gemini', { gemini: { kind, label: '哈基米 · Gemini' } }).label, label);
  }
  assert.equal(impl.resolve('gemini', { gemini: { kind: 'cli', label: '我的 Gemini' } }).label, '我的 Gemini');
});

test('menus hide absent local tools and automatic web fallbacks, and detect later CLI installation', () => {
  let installed = false;
  const impl = mockedModule('src/main/launcher.js', {
    electron: { shell: {} }, './winsnap': {},
    fs: { existsSync: p => installed && /[\\/]fixture-cli-only\.cmd$/i.test(p) },
  });
  const cli = { kind: 'cli', command: 'fixture-cli-only' };
  assert.equal(impl.menuAvailable(cli), false);
  installed = true;
  assert.equal(impl.menuAvailable(cli), true, '不重启也可在下一次菜单检测发现新安装');
  assert.equal(impl.menuAvailable({ kind: 'app', target: 'D:\\missing.exe' }), false);
  assert.equal(impl.menuAvailable({ kind: 'url', target: 'https://fixture.invalid', webFallback: true }), false);
  assert.equal(impl.menuAvailable({ kind: 'url', target: 'https://fixture.invalid' }), true, '主动配置的网页保留');
  assert.equal(impl.menuAvailable({ kind: 'wsl-cli', command: 'claude' }), true);
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const ctx = vm.createContext({ QUOTA_ONLY: false,
    allCharacters: () => [{ id: 'gemini' }, { id: 'codex' }], launchCfg: () => ({}),
    launcher: { resolve: id => ({ id }), menuAvailable: spec => spec.id !== 'gemini', claudeWinSpec: () => null },
  });
  vm.runInContext(source.slice(source.indexOf('function launchTargets('), source.indexOf('async function launchFor(')), ctx);
  assert.equal(vm.runInContext('launchTargets().map(t => t.id).join() ', ctx), 'codex');
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

test('Codex desktop workspace uses app PATH and waits for command failure without shell interpolation', async () => {
  let call, fail=false, entryExists=true, opened;
  const impl=mockedModule('src/main/launcher.js',{
    fs:{existsSync:p=>entryExists||!String(p).endsWith('codex.js'),statSync:()=>({isDirectory:()=>true})},
    electron:{shell:{openExternal:async url=>{opened=url;}}}, './winsnap':{findWindow:()=>({hwnd:'existing-codex'})},
    child_process:{execFile:(exe,args,opts,cb)=>{call={exe,args,opts};cb(fail?new Error('fixture'):null)},spawn:()=>{throw Error('must use workspace command, not foreground existing window')}},
  });
  const spec={kind:'store',target:'OpenAI.Codex_fixture!App',label:'Codex',process:'ChatGPT.exe'};
  assert.equal(impl.supportsWorkspace(spec),true);
  const cwd='D:\\Workspace with spaces & punctuation\\pet';
  const result=await impl.launch('codex',{codex:spec},{cwd});
  assert.equal(result.ok,true);assert.equal(call.args[1],'app');assert.equal(call.args[2],cwd);
  assert.equal(call.opts.env.ELECTRON_RUN_AS_NODE,'1');assert.equal(call.opts.shell,undefined);
  fail=true;assert.equal((await impl.launch('codex',{codex:spec},{cwd})).ok,false);
  entryExists=false;assert.equal(impl.supportsWorkspace(spec),true);
  const prompt='接手 D:\\项目\\HANDOFF.md；先核对，再继续 & + #';
  const draft=await impl.launch('codex',{codex:spec},{cwd,prompt});
  assert.equal(draft.draftPrepared,true);
  const url=new URL(opened);assert.equal(url.protocol,'codex:');assert.equal(url.hostname,'threads');assert.equal(url.pathname,'/new');
  assert.equal(url.searchParams.get('path'),cwd);assert.equal(url.searchParams.get('prompt'),prompt);
  assert.equal(url.searchParams.has('autoSubmit'),false);
});

test('DSH workspace uses its explicit attached flag; normal launches honor configured cwd and handoff overrides it', async () => {
  const calls=[];
  const impl=mockedModule('src/main/launcher.js',{
    fs:{existsSync:()=>true,statSync:p=>{if(p.startsWith('/'))throw Error('WSL paths must not be checked on Windows');return {isDirectory:()=>p!=='D:\\not-a-directory'};}},
    electron:{shell:{}},'./winsnap':{findWindow:()=>null},
    child_process:{spawn:(cmd,args)=>{calls.push({cmd,args});const child=new EventEmitter();child.unref=()=>{};process.nextTick(()=>child.emit('spawn'));return child;}},
  });
  const spec={kind:'app',label:'DSH Desktop',target:'D:\\Programs\\DSH Desktop.exe',cwd:'D:\\Default project'};
  assert.equal((await impl.launch('deepseek',{deepseek:spec})).ok,true);
  assert.equal(calls.at(-1).args[0],'--dsh-desktop-workspace=D:\\Default project');
  assert.equal((await impl.launch('deepseek',{deepseek:spec},{cwd:'D:\\Handoff & workspace'})).ok,true);
  assert.equal(calls.at(-1).args[0],'--dsh-desktop-workspace=D:\\Handoff & workspace');
  const before=calls.length;
  assert.equal((await impl.launch('deepseek',{deepseek:spec},{cwd:'D:\\not-a-directory'})).ok,false);
  assert.equal(calls.length,before);
  assert.equal((await impl.launch('claude',{claude:{kind:'wsl-cli',command:'claude',distro:'Ubuntu',cwd:'/home/fixture'}})).ok,true);
  assert.ok(calls.at(-1).args.includes('/home/fixture'));
});

test('workspace tools reopen an existing app with the correct directory argument; chat apps only focus', async () => {
  const calls=[]; let focused=0;
  const impl=mockedModule('src/main/launcher.js',{
    fs:{existsSync:()=>true,statSync:p=>({isDirectory:()=>p!=='D:\\missing'})},
    electron:{shell:{}},'./winsnap':{findWindow:()=>({hwnd:'existing'}),bringToFront:()=>{focused++;}},
    child_process:{spawn:(cmd,args,opts)=>{calls.push({cmd,args,opts});const child=new EventEmitter();child.unref=()=>{};process.nextTick(()=>child.emit('spawn'));return child;}},
  });
  const cwd='D:\\项目 with spaces & punctuation\\交接';
  for(const [exe,arg] of [['ZCode.exe','--open-workspace='+cwd],['WorkBuddy.exe',cwd],['Cursor.exe',cwd],['Qoder IDE.exe',cwd],['DSH Desktop.exe','--dsh-desktop-workspace='+cwd]]) {
    const spec={kind:'app',target:'D:\\Programs\\'+exe,process:exe,label:exe,args:['--fixture']};
    assert.equal(impl.supportsWorkspace(spec),true);
    const r=await impl.launch('fixture',{fixture:spec},{cwd});
    assert.equal(r.ok,true);assert.equal(r.workspaceRequested,true);assert.equal(r.already,undefined);
    assert.equal(JSON.stringify(calls.at(-1).args),JSON.stringify(['--fixture',arg]));assert.equal(calls.at(-1).opts.shell,undefined);
    const count=calls.length;
    assert.equal((await impl.launch('fixture',{fixture:spec},{cwd:'D:\\missing'})).ok,false);assert.equal(calls.length,count);
  }
  for(const exe of ['Gemini.exe','Doubao.exe','yuanbao.exe']) {
    const spec={kind:'app',target:'D:\\Programs\\'+exe,process:exe,label:exe};const count=calls.length;
    assert.equal(impl.supportsWorkspace(spec),false);
    assert.equal((await impl.launch('fixture',{fixture:spec},{cwd})).already,true);assert.equal(calls.length,count);
  }
  assert.equal(focused,3);
});

test('DSH prefill sends prompt through stdin and only accepts a verified structured response', async () => {
  let launched,received,cb;
  const child={stdin:{on:()=>{},end:s=>{received=JSON.parse(s);cb(null,JSON.stringify({code:'prefilled',prefilled:true,workspaceVerified:true}));}}};
  const impl=mockedModule('src/main/desktop-draft.js',{child_process:{execFile:(command,args,opts,done)=>{launched={command,args,opts};cb=done;return child;}}});
  const result=await impl.prefillDsh({hwnd:'123',workspace:'D:\\Workspace with spaces',prompt:'private fixture text'});
  assert.equal(result.prefilled,true);assert.equal(result.workspaceVerified,true);
  assert.equal(received.prompt,'private fixture text');assert.equal(launched.args.some(x=>String(x).includes('private fixture text')),false);
  child.stdin.end=()=>cb(null,JSON.stringify({code:'prefilled',prefilled:true,workspaceVerified:false}));
  assert.equal((await impl.prefillDsh({hwnd:'123',workspace:'D:\\Workspace',prompt:'fixture'})).prefilled,false);
  const controller=new AbortController();controller.abort();
  assert.equal((await impl.prefillDsh({hwnd:'123',workspace:'D:\\Workspace',prompt:'fixture',signal:controller.signal})).prefilled,false);
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

test('WSL distro names parse from reg query output', () => {
  const out = '\r\nHKEY_CURRENT_USER\\...\\Lxss\\{a}\r\n    DistributionName    REG_SZ    Ubuntu-24.04\r\n\r\nHKEY_CURRENT_USER\\...\\Lxss\\{b}\r\n    DistributionName    REG_SZ    docker-desktop\r\n\r\n搜索结束: 找到 2 匹配。\r\n';
  assert.deepEqual(activity.wslDistros(out), ['Ubuntu-24.04', 'docker-desktop']);
});

test('handoff paths convert for WSL tools', () => {
  const { toWslPath } = require('../src/main/handoff');
  assert.equal(toWslPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\a\\HANDOFF.md'), '/home/a/HANDOFF.md');
  assert.equal(toWslPath('\\\\wsl$\\Ubuntu\\x'), '/x');
  assert.equal(toWslPath('D:\\01_Projects\\p\\HANDOFF.md'), '/mnt/d/01_Projects/p/HANDOFF.md');
  assert.equal(toWslPath('/home/a/HANDOFF.md'), '/home/a/HANDOFF.md');
});

test('workspace goes to CLIs, editors and DSH, not store apps', () => {
  const impl = mockedModule('src/main/launcher.js', { './winsnap': {}, electron: { shell: {} } });
  const dsh = { kind: 'app', target: 'E:\\x\\DSH Desktop.exe' }, code = { kind: 'app', target: 'C:\\VS\\Code.exe' };
  assert.equal(impl.supportsWorkspace(dsh), true); assert.equal(impl.supportsWorkspace(code), true);
  assert.equal(impl.supportsWorkspace({ kind: 'store', target: 'OpenAI.Codex' }), false);
  assert.equal(impl.supportsWorkspace({ kind: 'wsl-cli' }), true);
});

test('API handoff parses Claude transcripts: verbatim user words, no injected noise, paths to the repo', () => {
  const h = require('../src/main/handoff-api');
  const rows = [
    { type: 'user', message: { role: 'user', content: '把交接做进桌宠\n第二行' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/x</command-name>' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
    { type: 'user', message: { role: 'user', content: '我要把当前任务交接给另一个 AI。请用 handoff 技能' } },
    { type: 'user', isCompactSummary: true, message: { role: 'user', content: '早先摘要' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'Bash', input: { command: 'cd /mnt/d/p/ai-pet && npm test' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  ];
  const { user, items } = h.parseTranscript(rows.map((r) => JSON.stringify(r)).join('\n') + '\nnot json', 'claude');
  assert.equal(JSON.stringify(user), JSON.stringify(['把交接做进桌宠\n第二行']));
  assert.equal(JSON.stringify(items.map((x) => x.role)), JSON.stringify(['user', 'summary', 'ai', 'tool']));
  assert.equal(JSON.stringify(h.pathsIn('see https://a.b D:\\x\\y.js and /mnt/c/u/z /home/a/b', 'Ubuntu-24.04')), JSON.stringify(['D:\\x\\y.js', 'C:\\u\\z', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\a\\b']));
});

test('API handoff digest keeps the summary and the newest turns within budget', () => {
  const h = require('../src/main/handoff-api');
  const items = [{ role: 'summary', t: 'S' }, ...Array.from({ length: 50 }, (_, i) => ({ role: 'ai', t: 'x'.repeat(100) + i }))];
  const d = h.buildDigest(items, 1000);
  assert.ok(d.startsWith('【早先对话摘要】S')); assert.ok(d.endsWith('49')); assert.ok(d.length <= 1000); assert.ok(!d.includes('x0\n'));
});

test('API handoff document inserts verbatim quotes as section 2 and flags it unverified', () => {
  const h = require('../src/main/handoff-api');
  const md = h.compose({ body: '# HANDOFF — 测试\n## 1. 目标与验收标准\nA\n## 3. 关键决策\nB', user: ['原话一\n续', '原话一\n续', '原话二'], kind: 'claude', transcript: 'T.jsonl', root: 'D:\\p', gitInfo: { head: 'abc', status: ' M a.js', stat: '' } });
  assert.ok(md.startsWith('# HANDOFF — 测试\n生成时间：'));
  assert.ok(md.includes('未核对代码') && md.includes('原始对话：T.jsonl') && md.includes('代码锚点：abc'));
  assert.ok(md.indexOf('## 1.') < md.indexOf('## 2. 用户原话') && md.indexOf('## 2. 用户原话') < md.indexOf('## 3.'));
  assert.equal(md.split('> 原话一\n> 续').length, 2);
  assert.ok(md.includes('## 附：git 实测') && md.includes(' M a.js'));
});

test('API handoff reads Codex rollouts and finds the thread through state_5.sqlite', () => {
  const h = require('../src/main/handoff-api');
  const rows = [
    { type: 'session_meta', payload: { cwd: '\\\\?\\D:\\fixture\\proj' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '改一下气泡' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'Get-Content D:\\fixture\\proj\\a.js' } },
  ];
  const r = h.parseTranscript(rows.map((x) => JSON.stringify(x)).join('\n'), 'codex');
  assert.equal(r.cwd, 'D:\\fixture\\proj');
  assert.equal(JSON.stringify(r.user), JSON.stringify(['改一下气泡']));
  assert.equal(r.items.map((i) => i.role).join(), 'user,ai,tool');
  let DatabaseSync; try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-')), roll = path.join(dir, 'new.jsonl');
  fs.writeFileSync(roll, ''); fs.writeFileSync(path.join(dir, 'old.jsonl'), '');
  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  db.exec('create table threads (rollout_path text, name text, title text, archived int, updated_at_ms int)');
  const ins = db.prepare('insert into threads values (?,?,?,?,?)');
  ins.run('\\\\?\\' + roll, 'new', 'new', 0, 2); ins.run(path.join(dir, 'old.jsonl'), 'old', 'old', 0, 1); ins.run(path.join(dir, 'x.jsonl'), 'arch', 'arch', 1, 3);
  db.close();
  assert.equal(h.newestTranscript('codex', [dir]), roll);
});

test('API handoff reads multi-frame zstd DSH sessions', () => {
  const h = require('../src/main/handoff-api');
  if (!zlibHasZstd()) return;
  const zlib = require('node:zlib');
  const rows = [
    { type: 'session', version: 4, cwd: 'D:\\fixture\\dsh' },
    { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'You are' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '接手这个' }], role: 'user' } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '想想' }, { type: 'text', text: '好的' }] } } },
    { type: 'tool/call', data: { name: 'shell', arguments: '{"cmd":"git -C D:\\\\fixture\\\\dsh status"}' } },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-')), ses = path.join(dir, 'sessions', '--D-fixture-dsh--', 'session-1');
  fs.mkdirSync(ses, { recursive: true });
  const file = path.join(ses, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat(rows.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n')))));
  assert.equal(h.newestTranscript('dsh', [dir]), file);
  const r = h.parseTranscript(h.readTranscript(file), 'dsh');
  assert.equal(r.cwd, 'D:\\fixture\\dsh');
  assert.equal(JSON.stringify(r.user), JSON.stringify(['接手这个']));
  assert.equal(r.items.map((i) => `${i.role}:${i.t}`).join('|').replace(/:shell.*/, ''), 'user:接手这个|ai:好的|tool');
});
test('API handoff ignores DSH host injections: only source.kind user counts as verbatim words', () => {
  const h = require('../src/main/handoff-api');
  if (!zlibHasZstd()) return;
  const zlib = require('node:zlib');
  const rows = [
    { type: 'session', version: 4, cwd: 'D:\\fixture\\dsh2' },
    { type: 'user/message', data: { content: [{ type: 'text', text: '真正的话' }], role: 'user', source: { kind: 'user', rpcId: 'r1' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Current runtime context. 这行是宿主注入' }], role: 'user', source: { kind: 'runtime-context' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 2' }], role: 'user', source: { kind: 'time-context' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '- `takeover`: 技能清单不是用户说的' }], role: 'user', source: { kind: 'skill-catalog' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Current runtime context. 没有 source 也要挡' }], role: 'user' } },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-noise-')), ses = path.join(dir, 'sessions', '--D-fixture-dsh2--', 'session-1');
  fs.mkdirSync(ses, { recursive: true });
  const file = path.join(ses, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat(rows.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n')))));
  const r = h.parseTranscript(h.readTranscript(file), 'dsh');
  assert.equal(JSON.stringify(r.user), JSON.stringify(['真正的话']));
  assert.equal(r.items.filter((i) => i.role === 'user').length, 1);
    const empty = path.join(dir, 'sessions', '--D-fixture-dsh2--', 'new-empty');
    fs.mkdirSync(empty, { recursive: true });
    const emptyFile = path.join(empty, 'session.v4.jsonl.zstd');
    fs.writeFileSync(emptyFile, zlib.zstdCompressSync(Buffer.from(JSON.stringify(rows[2]) + '\n')));
    fs.utimesSync(emptyFile, new Date(), new Date(Date.now() + 2000));
    assert.equal(h.newestTranscript('dsh', [dir], 'DSH Desktop'), file, '只有宿主注入的空会话不能成为默认来源');
});
function zlibHasZstd() { return typeof require('node:zlib').zstdCompressSync === 'function'; }

test('API handoff notices the takeover prompt only in newly appended transcript text', () => {
  const h = require('../src/main/handoff-api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), proj = path.join(dir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const needle = JSON.stringify('D:\\fixture\\HANDOFF.md').slice(1, -1);
  const old = path.join(proj, 'old.jsonl');
  fs.writeFileSync(old, JSON.stringify({ text: '早先提过 D:\\fixture\\HANDOFF.md' }) + '\n');
  const check = h.watchSent('claude', [dir], needle, { listMs: 0 });
  assert.equal(check(), false);
  fs.appendFileSync(old, JSON.stringify({ text: '别的话' }) + '\n');
  assert.equal(check(), false);
  fs.writeFileSync(path.join(proj, 'new.jsonl'), JSON.stringify({ text: '用 takeover 技能接手这个交接文件：D:\\fixture\\HANDOFF.md 。' }) + '\n');
  assert.equal(check(), true);
});

test('API handoff still recognizes the sent prompt when the target rewrites the path or splits it', () => {
  const h = require('../src/main/handoff-api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch2-')), proj = path.join(dir, 'projects', 'p');
  try {
    fs.mkdirSync(proj, { recursive: true });
    const f = path.join(proj, 's.jsonl');
    fs.writeFileSync(f, JSON.stringify({ text: '旧对话' }) + '\n');
    const check = h.watchSent('claude', [dir], 'D:\\01_Projects\\Active\\ai-pet\\HANDOFF.md');
    assert.equal(check(), false);
    // 目标把 Windows 路径写成 WSL 路径
    const line = JSON.stringify({ text: '用 takeover 技能接手 /mnt/d/01_Projects/Active/ai-pet/HANDOFF.md 。' }) + '\n';
    fs.appendFileSync(f, line.slice(0, 58));
    assert.equal(check(), false);
    // 同一条记录被两次追加切开（路径跨块），靠尾巴缓冲也要能拼回来
    fs.appendFileSync(f, line.slice(58));
    assert.equal(check(), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('API handoff labels the conversation it read so a wrong pick is visible before it settles', () => {
  const h = require('../src/main/handoff-api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-'));
  try {
    const proj = path.join(dir, 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
    const f = path.join(proj, 's.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'ai-title', aiTitle: '修复桌宠工具切换' }) + '\n');
    const l = h.threadLabel('claude', f, dir);
    assert.equal(l.name, '修复桌宠工具切换');
    assert.equal(l.age, '今天开始');
    // Codex 旧会话：重新打开后 mtime 变今天，但文件名里的开始日期要能透出来
    const old = path.join(proj, 'rollout-2026-10-14T18-14-43-abc.jsonl');
    fs.writeFileSync(old, JSON.stringify({ type: 'session_meta', payload: { cwd: 'D:\\x' } }) + '\n');
    assert.equal(h.threadLabel('codex', old, dir).age, '10/14 开始');
    // 十分钟没动过就该被标出来（Codex 的 mtime / threads.updated_at_ms 都算「最近动过」）
    assert.equal(l.minutes, 0); assert.equal(l.fresh, '刚刚动过');
    assert.equal(h.freshText(0), '刚刚动过');
    assert.equal(h.freshText(5), '5 分钟前动过');
    assert.equal(h.freshText(300), '5 小时前动过');
    assert.equal(h.freshText(3000), '2 天前动过');
    assert.equal(h.freshText(null), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('API handoff keeps a second project in the same folder from overwriting the first one', () => {
  const h = require('../src/main/handoff-api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
  try {
    const main = path.join(dir, 'HANDOFF.md');
    assert.equal(h.pickFile({ dir, transcript: 'A.jsonl', root: dir }), main);
    fs.writeFileSync(main, '原始对话：A.jsonl\n\n## 1. 目标\n');
    // 同一个会话接着写：仍然覆盖 HANDOFF.md
    assert.equal(h.pickFile({ dir, transcript: 'A.jsonl', root: dir }), main);
    // 同目录换了会话：另存，别顶掉拼图那份
    const other = h.pickFile({ dir, transcript: 'B.jsonl', root: dir, label: { name: '检查正点原子串口屏新版本' } });
    assert.equal(path.basename(other), 'HANDOFF-检查正点原子串口屏新版本.md');
    // 没有项目根（认不出目录）时维持老行为
    assert.equal(h.pickFile({ dir, transcript: 'B.jsonl', root: null }), main);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('API handoff document says how much history it replaced and where the backup is', () => {
  const h = require('../src/main/handoff-api');
  const md = h.compose({ body: '# HANDOFF — x\n\n## 3. 关键决策\n', user: ['原话'], kind: 'claude', transcript: 'p.jsonl', root: 'R',
    gitInfo: { head: 'abc' }, previous: { lines: 319, backup: 'C:\\bk\\HANDOFF.md' } });
  assert.match(md, /历史：覆盖前 319 行/);
  assert.match(md, /C:\\bk\\HANDOFF\.md/);
  assert.match(md, /## 2\. 用户原话/);
});

test('API handoff failure is shown in the bubble instead of silently falling back to the source AI', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const sent = [];
  const ctx = vm.createContext({ QUOTA_ONLY: false,
    path, setTimeout, clearTimeout, setInterval, clearInterval, Date, console, AbortController, handoffJob: null, lastAgentWin: null, lastHandoffJob: null, handoffSerial: 0, updateTrayMenu: () => {},
    desktopDraft: { isDsh: () => false }, quipsKey: () => 'fixture-key', handoffEstimate: require('../src/main/handoff-estimate'), handoffReturn: require('../src/main/handoff-return'), state: {data: {}, saveSoon:()=>{}}, launchTargets:()=>[],
    handoffApi: { KINDS: { claude: 'claude' }, run: async () => { throw new Error('DeepSeek 401 余额不足'); } },
    charOf: (k) => k,
    config: { data: { quips: {}, activity: {} } }, activity: { detectClaudeDirs: () => ['D:\\fixture\\projects'] }, app: { getPath: () => 'C:\\Users\\fixture' }, http: { request: async () => ({}) },
    launcher: { supportsWorkspace: () => true, launch: async () => ({ ok: true }) },
    launchCfg: () => ({}), recent: {}, pushData: () => {}, log: () => {},
    sendPet: (_ch, p) => sent.push(p), clipboard: { writeText: () => {} },
    handoff: { latest: () => ({ file: 'D:\\fixture\\HANDOFF.md', at: 1 }), takeoverPrompt: p => `接手 ${p}`, goalOf: () => '', writePrompt: () => '写交接' },
    winsnap: { pasteKeys: () => true, bringToFront: () => true, titledWindows: () => [] },
    shell: { openPath: () => {} },
  });
  vm.runInContext(source.slice(source.indexOf('async function launchFor('), source.indexOf('function launchCurrent()')), ctx);
  const running = vm.runInContext("runHandoff('fixture', {kind:'app',label:'Fixture'}, {character:'claude',hwnd:'h',title:'Claude'})", ctx);
  await new Promise(setImmediate);
  const fb = sent.find((v) => v.heading === '退回原流程');
  assert.ok(fb, 'expected a visible fallback bubble');
  assert.match(fb.detail, /余额不足/);
  assert.match(fb.detail, /会耗来源额度/);
  vm.runInContext('handoffAction({action:"cancel",id:handoffJob&&handoffJob.id})', ctx);
  await running;
});

test('API handoff shows the conversation it read and the history it replaced in the bubble', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const sent = [];
  const ctx = vm.createContext({ QUOTA_ONLY: false,
    path, setTimeout, clearTimeout, setInterval, clearInterval, Date, console, AbortController, handoffJob: null, lastAgentWin: null, lastHandoffJob: null, handoffSerial: 0, updateTrayMenu: () => {},
    desktopDraft: { isDsh: () => false }, quipsKey: () => 'fixture-key', handoffEstimate: require('../src/main/handoff-estimate'), handoffReturn: require('../src/main/handoff-return'), state: {data: {}, saveSoon:()=>{}}, launchTargets:()=>[],
    handoffApi: { KINDS: { claude: 'claude' }, run: async (o) => { o.onRead('D:\\fixture', { label: { name: '查找记录', age: '9 天前', minutes: 300, fresh: '5 小时前动过' } }); o.onWrite({ file: 'D:\\fixture\\HANDOFF.md', backup: 'C:\\bk.md', prevLines: 319 }); return 'D:\\fixture\\HANDOFF.md'; } },
    charOf: (k) => k,
    config: { data: { quips: {}, activity: {} } }, activity: { detectClaudeDirs: () => ['D:\\fixture\\projects'] }, app: { getPath: () => 'C:\\Users\\fixture' }, http: { request: async () => ({}) },
    launcher: { supportsWorkspace: () => true, launch: async () => ({ ok: true }) },
    launchCfg: () => ({}), recent: {}, pushData: () => {}, log: () => {},
    sendPet: (_ch, p) => sent.push(p), clipboard: { writeText: () => {} },
    handoff: { latest: () => ({ file: 'D:\\fixture\\HANDOFF.md', at: 1 }), takeoverPrompt: p => `接手 ${p}`, goalOf: () => '', writePrompt: () => '写交接' },
    winsnap: { pasteKeys: () => true, bringToFront: () => true, titledWindows: () => [] },
    shell: { openPath: () => {} },
  });
  vm.runInContext(source.slice(source.indexOf('async function launchFor('), source.indexOf('function launchCurrent()')), ctx);
  await vm.runInContext("runHandoff('fixture', {kind:'app',label:'Fixture'}, {character:'claude',hwnd:'h',title:'Claude'})", ctx);
  assert.ok(sent.some((v) => /查找记录.*9 天前.*5 小时前动过/.test(v.detail || '')), 'bubble should name the conversation, its start date and how long ago it moved');
  assert.ok(sent.some((v) => /可能不是你正开着的对话/.test(v.detail || '')), 'stale source must be called out');
  assert.match(sent.at(-1).detail, /旧版 319 行已备份/);
  const session={tool:'codex',id:'01234567-89ab-cdef-0123-456789abcdef'};
  ctx.handoffReturn={...require('../src/main/handoff-return'),find:()=>session};
  const requests=[];
  ctx.launcher.launch=async (...args)=>{requests.push(args);return {ok:true,sessionRestored:true,draftPrepared:true};};
  await vm.runInContext("runHandoff('codex', {kind:'store',label:'Codex'}, {character:'claude',hwnd:'h',title:'Claude'})",ctx);
  assert.equal(requests[0][2].session.id,session.id);assert.match(requests[0][2].prompt,/takeover --incremental/);
  assert.equal(sent.at(-1).heading,'在 Codex 确认发送');assert.match(sent.at(-1).detail,/增量指令已预填/);
  requests.length=0;
  ctx.launcher.launch=async (...args)=>{requests.push(args);return {ok:requests.length>1};};
  await vm.runInContext("runHandoff('codex', {kind:'store',label:'Codex'}, {character:'claude',hwnd:'h',title:'Claude'})",ctx);
  assert.equal(requests.length,2);assert.equal(requests[1][2].session,undefined);assert.doesNotMatch(requests[1][2].prompt,/--incremental/);
  assert.equal(sent.at(-1).heading,'到新对话粘贴');
});

test('return routes persist per project, revalidate original session and refuse missing or mismatched references', () => {
  const h=require('../src/main/handoff-return');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pet-return-'));
  try {
    const file=path.join(dir,'session.jsonl'),id='01234567-89ab-cdef-0123-456789abcdef';
    const spec={kind:'store',target:'OpenAI.Codex_fixture!App',label:'Codex'};
    fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,cwd:dir}})+'\n');
    const source=h.sessionOf('codex',file,spec);assert.equal(source.id,id);
    assert.equal(h.sessionOf('codex',file,{kind:'cli',command:'codex'}).id,id);
    assert.equal(h.sessionOf('codex',file,{kind:'cli',command:'codex && other'}),null);
    assert.equal(h.cliResume('gemini',{kind:'cli',command:'gemini'},{tool:'gemini',id}), '');
    const rows=JSON.parse(JSON.stringify(h.remember([],dir,source,'deepseek')));
    assert.equal(h.find(rows,dir,'codex','deepseek',spec).id,id);
    assert.equal(h.find(rows,dir,'codex','workbuddy',spec),null);
    assert.equal(h.find(rows,dir,'codex',null,spec),null);
    assert.equal(h.find(rows,path.join(dir,'different-project'),'codex','deepseek',spec),null);
    assert.equal(h.remember([],path.join(dir,'different-project'),source,'deepseek').length,0);
    const bound=h.remember([],path.join(dir,'different-project'),{...source,projectRoot:path.join(dir,'different-project')},'deepseek');
    assert.equal(h.find(bound,path.join(dir,'different-project'),'codex','deepseek',spec).id,id);
    fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',cwd:dir}}));
    assert.equal(h.find(rows,dir,'codex','deepseek',spec),null);
    fs.unlinkSync(file);assert.equal(h.find(rows,dir,'codex','deepseek',spec),null);
    fs.writeFileSync(file,JSON.stringify({sessionId:id,cwd:dir}));
    assert.equal(h.sessionOf('claude',file,{kind:'cli',command:'claude'}).id,id);
    assert.equal(h.sessionOf('claude',file,{kind:'wsl-cli',command:'claude',distro:'Ubuntu'}),null);
    assert.equal(h.sessionOf('claude',file,{kind:'cli',command:'claude && other'}),null);
    assert.equal(h.prompt('HANDOFF.md'),'Take over changes: HANDOFF.md');assert.equal(h.prompt('HANDOFF.md').includes('\n'),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('return launch uses exact Codex thread or Claude resume UUID without automatically submitting a desktop prompt', async () => {
  const calls=[];let url;
  const impl=mockedModule('src/main/launcher.js',{
    fs:{existsSync:()=>true,statSync:()=>({isDirectory:()=>true})},electron:{shell:{openExternal:async u=>{url=u;}}},
    './winsnap':{findWindow:()=>({hwnd:'already-open'}),bringToFront:()=>{throw Error('must restore thread, not focus app');}},
    child_process:{spawn:(cmd,args)=>{calls.push({cmd,args});const c=new EventEmitter();c.unref=()=>{};process.nextTick(()=>c.emit('spawn'));return c;}},
  });
  const id='01234567-89ab-cdef-0123-456789abcdef',cwd='D:\\Fixture project';
  const r=await impl.launch('codex',{}, {cwd,prompt:'incremental handoff',session:{tool:'codex',id}});
  assert.equal(r.sessionRestored,true);assert.equal(r.draftPrepared,true);assert.equal(new URL(url).pathname,'/'+id);assert.equal(new URL(url).searchParams.get('prompt'),'incremental handoff');
  const complex='补充 D:\\项目 with spaces\\HANDOFF.md & # ? + 中文';
  await impl.launch('codex',{}, {cwd,prompt:complex,session:{tool:'codex',id}});
  assert.equal(new URL(url).searchParams.get('prompt'),complex);assert.equal(new URL(url).searchParams.has('autoSubmit'),false);
  await impl.launch('claude',{claude:{kind:'wsl-cli',command:'claude',distro:'Ubuntu'}},{cwd,session:{tool:'claude',id}});
  assert.ok(calls.at(-1).args.some(a=>a==='claude --resume '+id+'; exec bash'));
  await impl.launch('claude',{claude:{kind:'cli',command:'claude'}},{cwd,session:{tool:'claude',id}});
  assert.equal(calls.at(-1).args.at(-1),'claude --resume '+id);
  await impl.launch('codex',{codex:{kind:'cli',command:'codex'}},{cwd,session:{tool:'codex',id}});
  assert.equal(calls.at(-1).args.at(-1),'codex resume '+id);
  await impl.launch('codex',{codex:{kind:'wsl-cli',command:'codex',distro:'Ubuntu'}},{cwd,session:{tool:'codex',id}});
  assert.ok(calls.at(-1).args.some(a=>a==='codex resume '+id+'; exec bash'));
  await impl.launch('claude',{claude:{kind:'cli',command:'claude'}},{cwd,session:{tool:'claude',id:'bad & command'}});
  assert.equal(calls.at(-1).args.at(-1),'claude');
});

test('takeover prompt is just the skill call plus a task label, never a path', () => {
  const { takeoverPrompt, shortPath } = require('../src/main/handoff');
  // 装了技能的机器：指令只有技能命令和任务名
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-takeover-'));
  for (const d of ['.claude', '.codex', '.zcode', '.workbuddy', '.dsh']) { fs.mkdirSync(path.join(home, d, 'skills', 'takeover'), { recursive: true }); fs.writeFileSync(path.join(home, d, 'skills', 'takeover', 'SKILL.md'), 'x'); }
  const p = takeoverPrompt('D:\\01_Projects\\Active\\ai-pet\\HANDOFF-修复桌宠工具切换与提醒.md', { tool: 'claude', project: 'ai-pet', home });
  assert.equal(p, '/takeover 修复桌宠工具切换与提醒');
  assert.equal(p.includes('\n'), false, 'Windows Terminal 粘贴多行会弹确认框，必须单行');
  // 泛名 HANDOFF.md：退回交接标题（去项目名前缀、括号说明）
  assert.equal(takeoverPrompt('D:\\p\\HANDOFF.md', { tool: 'claude', project: 'ai-pet', goal: 'ai-pet 桌宠交接功能联调（NSIS）', home }), '/takeover 桌宠交接功能联调');
  // 再退回来源会话名；什么线索都没有就只发技能命令
  assert.equal(takeoverPrompt('D:\\p\\HANDOFF.md', { tool: 'claude', session: '串口屏调试', home }), '/takeover 串口屏调试');
  assert.equal(takeoverPrompt('D:\\p\\HANDOFF.md', { tool: 'claude', home }), '/takeover');
  // 各工具调技能的写法不同
  assert.equal(takeoverPrompt('D:\\p\\HANDOFF-修复工具切换.md', { tool: 'codex', project: 'ai-pet', home }), '$takeover 修复工具切换');
  assert.equal(takeoverPrompt('D:\\p\\HANDOFF.md', { tool: 'zcode', home }), '$takeover');
  assert.equal(takeoverPrompt('D:\\p\\HANDOFF.md', { tool: 'workbuddy', home }), '/takeover');
  // 没装技能的工具拿不到「按任务名找文件」的技能，退回带路径的短句
  assert.equal(takeoverPrompt('D:\\p\\HANDOFF-修复工具切换.md', { tool: 'gemini', home }), '接手交接文件：D:\\p\\HANDOFF-修复工具切换.md');
  assert.equal(takeoverPrompt('D:\\p\\HANDOFF.md', { tool: 'custom-agent', home }), '接手交接文件：D:\\p\\HANDOFF.md');
  // 任务名里的括号/换行/标点不能破坏格式，太长的截短
  assert.equal(takeoverPrompt('D:\\p\\HANDOFF.md', { tool: 'claude', goal: 'a\n[b]：后面的说明', home }), '/takeover a b');
  assert.equal(takeoverPrompt('D:\\p\\HANDOFF-abcdefghijklmnopqrstuvwxyz0123456789.md', { tool: 'claude', home }), '/takeover abcdefghijklmnopqrstuvwx');
  const returning = require('../src/main/handoff-return');
  assert.equal(returning.prompt('D:\\p\\HANDOFF-修复工具切换.md', { tool: 'codex', home }), '$takeover --incremental 修复工具切换');
  assert.equal(returning.prompt('D:\\p\\HANDOFF-修复工具切换.md', { tool: 'claude', home }), '/takeover --incremental 修复工具切换');
  assert.equal(returning.prompt('D:\\p\\HANDOFF-修复工具切换.md', { tool: 'zcode', home }), '$takeover --incremental 修复工具切换');
  assert.equal(returning.prompt('D:\\p\\HANDOFF.md', { tool: 'custom-agent', home }), 'Take over changes: D:\\p\\HANDOFF.md');
  assert.equal(require('../src/main/handoff-api').sessionName('$takeover --incremental 修复工具切换'), '修复工具切换');
  const skill = fs.readFileSync(path.join(__dirname, '../skills/takeover/SKILL.md'), 'utf8');
  assert.match(skill, /只吸收.*新增/);
  assert.match(skill, /去重/);
  // 旧路径形式和无技能兜底仍然支持相对路径。
  assert.equal(shortPath('D:\\01_Projects\\Active\\ai-pet\\HANDOFF.md', 'D:\\01_Projects\\Active\\ai-pet'), 'HANDOFF.md');
  assert.equal(shortPath('D:\\p\\doc\\HANDOFF.md', 'D:\\p'), 'doc\\HANDOFF.md');
  assert.equal(shortPath('C:\\elsewhere\\HANDOFF.md', 'D:\\p'), 'C:\\elsewhere\\HANDOFF.md');
  assert.equal(shortPath('HANDOFF.md', 'D:\\p'), 'HANDOFF.md');
  assert.equal(shortPath('D:\\p\\HANDOFF.md', ''), 'D:\\p\\HANDOFF.md');
});

test('write prompt is just the skill command when the source tool has the handoff skill', () => {
  const { writePrompt } = require('../src/main/handoff');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-skill-'));
  for (const d of ['.claude', '.codex', '.zcode', '.workbuddy']) { fs.mkdirSync(path.join(home, d, 'skills', 'handoff'), { recursive: true }); fs.writeFileSync(path.join(home, d, 'skills', 'handoff', 'SKILL.md'), 'x'); }
  assert.equal(writePrompt('claude', home), '/handoff');
  assert.equal(writePrompt('codex', home), '$handoff');
  // 没装技能（DSH 这里没建）或不认识的工具：发完整说明
  assert.match(writePrompt('deepseek', home), /^请用 handoff 技能.*latest\.txt/);
  assert.equal(writePrompt('zcode', home), '$handoff');
  assert.equal(writePrompt('workbuddy', home), '/handoff');
  assert.match(writePrompt('gemini', home), /^请用 handoff 技能/);
  assert.match(writePrompt('kimi', home), /^请用 handoff 技能/);
});

test('handoff distinguishes a scratch session directory from repeated explicit command workdirs', () => {
  const h=require('../src/main/handoff-api'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pet-workspace-'));
  try {
    const cwd=path.join(dir,'chat'),actual=path.join(dir,'actual project'),other=path.join(dir,'reference');
    for(const p of [cwd,actual,other])fs.mkdirSync(path.join(p,'.git'),{recursive:true});
    const item={role:'tool',t:'exec',full:JSON.stringify({cmd:'git status',workdir:actual})};
    assert.equal(h.projectRoot([item,item],'Ubuntu',cwd),actual);
    // Reading references from another project must not override the session directory.
    assert.equal(h.projectRoot([{role:'tool',t:'read '+other+'\\file.js'}],'Ubuntu',cwd),cwd);
    const js={role:'tool',t:'exec',full:'await tools.exec_command({cmd:"git status",workdir:'+JSON.stringify(actual)+'});'};
    assert.equal(h.projectRoot([js,js],'Ubuntu',cwd),actual);
    const file=path.join(cwd,'HANDOFF.md');
    fs.writeFileSync(file,h.compose({body:'# HANDOFF — QA',user:[],kind:'codex',transcript:'fixture',root:actual,sessionCwd:cwd}));
    assert.equal(require('../src/main/handoff').workspaceOf(file),actual);
    fs.writeFileSync(file,'<!-- ai-pet-project:{"root":"not-absolute"} -->');
    assert.equal(require('../src/main/handoff').workspaceOf(file),cwd);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('handoff time estimate scales with content and compaction, calibrates per model and admits overruns', () => {
  const h=require('../src/main/handoff-estimate');
  const small=h.estimate({records:5,digestChars:1000},[],'model-a');
  const large=h.estimate({records:400,digestChars:60000,compactChars:120000},[],'model-a');
  assert.equal(small.requests,1);assert.equal(large.requests,2);assert.ok(large.seconds>small.seconds);
  const slow=h.estimate({records:5,digestChars:1000},[{model:'model-a',work:small.work,seconds:small.seconds*2}],'model-a');
  assert.equal(slow.calibrated,true);assert.ok(slow.seconds>small.seconds);
  assert.equal(h.estimate({records:5,digestChars:1000},[{model:'other',work:1,seconds:100}],'model-a').calibrated,false);
  assert.match(h.status(small,0),/预计共/);assert.match(h.status(small,small.maxSec+1),/超过预估/);
});

test('handoff API emits a content estimate and separate workspace metadata using only a local fixture response', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pet-plan-'));
  try {
    const actual=path.join(dir,'actual project'),chat=path.join(dir,'chat'),transcript=path.join(dir,'source.jsonl'),marker=path.join(dir,'marker.txt');
    fs.mkdirSync(actual);fs.mkdirSync(chat);
    const rows=[{type:'session_meta',payload:{cwd:chat}},...Array.from({length:2},()=>({type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:'git status',workdir:actual})}})),{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'修复项目路径'}]}}];
    fs.writeFileSync(transcript,rows.map(r=>JSON.stringify(r)).join('\n'));
    const api=mockedModule('src/main/handoff-api.js',{'./handoff':{LATEST:marker}});
    let plan,timing,requests=0;const phases=[];
    const file=await api.run({kind:'codex',dirs:[dir],session:transcript,api:{apiKey:'fixture',model:'fixture-model'},
      request:async()=>{requests++;return {ok:true,status:200,data:{choices:[{message:{content:'# HANDOFF — QA\n## 1. 目标\n## 3. 决策'}}]}};},
      onRead:(root,meta)=>{assert.equal(root,actual);assert.equal(meta.cwd,chat);plan=meta.estimate;},onPhase:p=>phases.push(p),onTiming:t=>{timing=t;}});
    assert.equal(requests,1);assert.equal(plan.requests,1);assert.ok(plan.maxSec>plan.minSec);assert.ok(timing.seconds>0);assert.equal(timing.model,'fixture-model');
    assert.deepEqual(phases,['整理交接']);assert.equal(require('../src/main/handoff').workspaceOf(file),actual);
    assert.ok(fs.readFileSync(file,'utf8').includes('会话启动目录：'+chat));assert.equal(fs.readFileSync(marker,'utf8').trim(),file);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('Codex defaults to automatic transfer with multiple sessions, while an explicitly missing selection still stops', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pet-source-'));
  try {
    const h=mockedModule('src/main/handoff-api.js',{'./handoff':{LATEST:path.join(dir,'latest.txt')}});
    const sessions=path.join(dir,'sessions','2026','10','23');fs.mkdirSync(sessions,{recursive:true});
    for(const n of ['a','b'])fs.writeFileSync(path.join(sessions,n+'.jsonl'),[
      JSON.stringify({type:'session_meta',payload:{cwd:dir}}),
      JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:n}]}}),
    ].join('\n'));
    fs.utimesSync(path.join(sessions,'a.jsonl'),1,1);fs.utimesSync(path.join(sessions,'b.jsonl'),2,2);
    let calls=0,selected;const request=async()=>{calls++;return {ok:true,status:200,data:{choices:[{message:{content:'# HANDOFF — fixture'}}]}};};
    await h.run({kind:'codex',dirs:[dir],api:{apiKey:'fixture'},request,onRead:(_root,meta)=>{selected=meta.transcript;}});
    assert.equal(selected,path.join(sessions,'b.jsonl'));assert.equal(calls,1);
    await assert.rejects(h.run({kind:'codex',dirs:[dir],api:{apiKey:'fixture'},request,session:path.join(dir,'missing.jsonl')}),e=>e.code==='SOURCE_SELECTION_REQUIRED');
    assert.equal(calls,1);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('API handoff does not mistake tool-internal git repos for the project root', () => {
  const h = require('../src/main/handoff-api');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  try {
    const cwd = path.join(tmp, 'pintu'); fs.mkdirSync(cwd);
    const toolRepo = path.join(tmp, 'memories'); fs.mkdirSync(path.join(toolRepo, '.git'), { recursive: true });
    const nested = path.join(cwd, 'Host'); fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    const items = [{ role: 'tool', full: `read ${toolRepo}\\MEMORY.md` }, { role: 'tool', full: `write ${toolRepo}\\raw.md` }];
    // 提到的仓库跟 cwd 无关 → 用 cwd，绝不能落到 Codex 自己的 memories 仓库
    assert.equal(h.projectRoot(items, 'Ubuntu', cwd), cwd);
    // cwd 里的嵌套仓库仍然算项目
    assert.equal(h.projectRoot([{ role: 'tool', full: `edit ${nested}\\x.cs` }], 'Ubuntu', cwd), nested);
    // 会话从家目录启动时，仍然认提到的仓库
    assert.equal(h.projectRoot(items, 'Ubuntu', os.homedir()), toolRepo);
    // ~/.codex 下的仓库即使有 .git 也不算项目
    const internal = path.join(os.homedir(), '.codex', 'memories-fake');
    assert.equal(h.projectRoot([{ role: 'tool', full: `read ${internal}\\x.md` }], 'Ubuntu', cwd), cwd);
    // 上级伞仓库只盖住 cwd（cwd 自己不是仓库）：交接跟着会话工作区走，不升到伞仓库根
    const day = path.join(tmp, 'docs', '2026-10-10', 'kk');
    fs.mkdirSync(path.join(tmp, 'docs', '.git'), { recursive: true }); fs.mkdirSync(day, { recursive: true });
    const dayItems = [{ role: 'tool', full: `read ${day}\\HANDOFF.md` }, { role: 'tool', full: `edit ${day}\\a.js` }, { role: 'tool', full: `edit ${day}\\b.js` }];
    assert.equal(h.projectRoot(dayItems, 'Ubuntu', day), day);
    // 2026/10/23 21:11 用户实测：会话开在 kk 草稿目录（非 git）、活全在 D 盘的 ai-pet 仓库——
    // 提及 ≥5 次时按真实仓库走，交接文件和工作区都落 ai-pet，别停在 kk
    const scratch = path.join(tmp, 'kk'), repo = path.join(tmp, 'ai-pet');
    fs.mkdirSync(scratch, { recursive: true }); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const repoItems = [1, 2, 3, 4, 5, 6].map((i) => ({ role: 'tool', full: `edit ${path.join(repo, 'f' + i + '.js')}` }));
    assert.equal(h.projectRoot(repoItems, 'Ubuntu', scratch), repo, '草稿目录里集中改另一个仓库 → 按仓库');
    assert.equal(h.projectRoot(repoItems.slice(0, 2), 'Ubuntu', scratch), scratch, '只提两次不算，零星引用不动摇会话目录');
    fs.mkdirSync(path.join(scratch, '.git'), { recursive: true });
    assert.equal(h.projectRoot(repoItems, 'Ubuntu', scratch), scratch, 'cwd 自己是仓库时仍然优先 cwd');
    fs.rmSync(path.join(scratch, '.git'), { recursive: true, force: true });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('handoff files parked in the global .handoff cache expose no workspace', () => {
  const handoff = require('../src/main/handoff');
  const cache = path.dirname(handoff.LATEST);
  const file = path.join(cache, `HANDOFF-test-${process.pid}.md`);
  fs.writeFileSync(file, '# HANDOFF — 没识别出项目时先停在这里\n\n正文\n');
  try {
    // 没有项目标记又躺在全局缓存里 → 不当工作区，主进程会弹目录选择并搬走文件
    assert.equal(handoff.workspaceOf(file), null);
    assert.throws(() => handoff.placeInWorkspace(file, cache), /实际项目文件夹/);
  } finally { fs.rmSync(file, { force: true }); }
});

test('handoff marker falls back to the last existing file when the newest entry is gone', () => {
  const { latest } = require('../src/main/handoff');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-marker-'));
  try {
    const a = path.join(dir, 'A.md'), b = path.join(dir, 'B.md'), marker = path.join(dir, 'latest.txt');
    fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'b');
    fs.writeFileSync(marker, [a, b, path.join(dir, 'gone.md')].join('\n') + '\n');
    const l = latest(marker);
    assert.equal(l.file, b);
    assert.equal(l.line, 2); assert.equal(l.total, 3);
    // 全都不在时仍然是 null，而不是抛错
    fs.writeFileSync(marker, path.join(dir, 'gone1.md') + '\n' + path.join(dir, 'gone2.md') + '\n');
    assert.equal(latest(marker), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('API handoff lists recent sessions with names and freshness for the picker', () => {
  const h = require('../src/main/handoff-api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  try {
    const proj = path.join(dir, 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'a.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: '甲会话' }) + '\n');
    fs.writeFileSync(path.join(proj, 'b.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: '乙会话' }) + '\n');
    const list = h.recentSessions('claude', [dir], 5);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((x) => x.name).sort(), ['乙会话', '甲会话']);
    assert.ok(list.every((x) => x.fresh && typeof x.file === 'string'), '每个候选都要带新鲜度');
    // 标题按文件大小缓存、只读新增：追加改名行要读到，追加普通行要保留旧名
    fs.appendFileSync(path.join(proj, 'a.jsonl'), 'x'.repeat(9000) + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: '甲改名' }) + '\n');
    assert.ok(h.recentSessions('claude', [dir], 5).some((x) => x.name === '甲改名'));
    fs.appendFileSync(path.join(proj, 'a.jsonl'), 'y'.repeat(9000) + '\n');
    assert.ok(h.recentSessions('claude', [dir], 5).some((x) => x.name === '甲改名'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('API handoff compacts a very long session instead of silently dropping the oldest turns', async () => {
  const h = require('../src/main/handoff-api');
  const big = Array.from({ length: 60 }, (_, i) => ({ role: 'user', t: '很长的历史 ' + 'x'.repeat(4000) + ' #' + i }));
  const calls = [];
  const request = async (url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: true, status: 200, data: { choices: [{ message: { content: '压缩后的历史要点' } }] } }; };
  const api = { apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
  const d = await h.digestFor(big, { api, request });
  assert.equal(calls.length, 1, '超长会话要多花一次压缩调用');
  assert.match(d.digest, /【更早的 \d+ 条已压缩】/);
  assert.match(d.digest, /压缩后的历史要点/);
  assert.ok(d.compacted > 0);
  // 短会话不压缩、一次调用都不花
  let n = 0;
  const d2 = await h.digestFor([{ role: 'user', t: '一句话' }], { api, request: async () => { n++; return { ok: true, status: 200, data: { choices: [{ message: { content: 'x' } }] } }; } });
  assert.equal(n, 0); assert.equal(d2.compacted, 0);
  // 压缩失败时退回普通 digest，不把整个交接搞挂
  const d3 = await h.digestFor(big, { api, request: async () => { throw new Error('boom'); } });
  assert.equal(d3.compacted, 0); assert.ok(d3.digest.length > 0);
});

test('API handoff archives the oldest per-session handoffs instead of deleting anything', () => {
  const h = require('../src/main/handoff-api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  try {
    const head = '# HANDOFF — x\n（由 AI 桌宠用 DeepSeek 按对话记录整理）\n';
    for (let i = 0; i < 12; i++) {
      const f = path.join(dir, `HANDOFF-会话${i}.md`);
      fs.writeFileSync(f, head); fs.utimesSync(f, new Date(2026, 9, 1, 0, i), new Date(2026, 9, 1, 0, i));
    }
    fs.writeFileSync(path.join(dir, 'HANDOFF-我自己写的.md'), '用户手写，不含桌宠标记');
    fs.writeFileSync(path.join(dir, 'HANDOFF.md'), head);
    const moved = h.pruneOldHandoffs(dir, 10);
    assert.equal(moved.length, 2);
    assert.equal(fs.readdirSync(dir).filter((n) => /^HANDOFF-会话/.test(n)).length, 10);
    assert.ok(fs.existsSync(path.join(dir, 'HANDOFF-我自己写的.md')), '用户自己的文件不能动');
    assert.ok(fs.existsSync(path.join(dir, 'HANDOFF.md')), '主交接文件不能动');
    // 少于阈值时什么都不做
    assert.deepEqual(h.pruneOldHandoffs(dir, 50), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('API handoff reads WorkBuddy sessions and keeps the real prompt out of the system reminder', () => {
  const h = require('../src/main/handoff-api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-'));
  try {
    const proj = path.join(dir, 'projects', 'c-Users-x-WorkBuddy'); fs.mkdirSync(proj, { recursive: true });
    const file = path.join(proj, 'abc.jsonl');
    const rows = [
      { type: 'ai-title', aiTitle: '获取会议纪要', cwd: 'C:\\Users\\x\\WorkBuddy\\2026-10-20' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<system-reminder data-role="user-context"><user_info>OS</user_info></system-reminder>\n<user_query>帮我整理会议纪要</user_query>' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }, { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls D:/proj"}' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<system-reminder>x</system-reminder>' }] },
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert.equal(h.newestTranscript('workbuddy', [dir]), file);
    const r = h.parseTranscript(h.readTranscript(file), 'workbuddy');
    assert.deepEqual(r.user, ['帮我整理会议纪要']);
    assert.equal(r.cwd, 'C:\\Users\\x\\WorkBuddy\\2026-10-20');
    assert.ok(r.items.some((i) => i.role === 'tool' && i.full.includes('D:/proj')), '工具调用要保留完整参数供路径扫描');
    assert.equal(h.threadLabel('workbuddy', file, dir).name, '获取会议纪要');
    // 没有用户发言的会话不能被选中
    fs.writeFileSync(path.join(proj, 'empty.jsonl'), JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }) + '\n');
    assert.equal(h.newestTranscript('workbuddy', [dir]), file);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pet right-click menu pops at the cursor (offset relative to the pet window)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const start = source.indexOf("let preparedMenu");
  const block = source.slice(start, source.indexOf('\n});', source.indexOf("ipcMain.on('context-menu'")) + 4);
  const on = {}; let handler = null, popped = null, built = 0;
  const ctx = vm.createContext({
    ipcMain: { on: (ch, fn) => { on[ch] = fn; handler = on['context-menu']; } },
    petWin: { getBounds: () => ({ x: 1500, y: 700, width: 300, height: 360 }) },
    screen: { getCursorScreenPoint: () => ({ x: 1620, y: 850 }) },
    Menu: { buildFromTemplate: () => { built++; return { popup: (o) => { popped = o; } }; } },
    petMenuTemplate: () => [], log: () => {},
  });
  vm.runInContext(block, ctx);
  handler = on['context-menu'];
  handler();
  assert.equal(popped.x, 120); assert.equal(popped.y, 150);
  handler(null, { x: 40.6, y: 77 });
  assert.equal(popped.x, 41); assert.equal(popped.y, 77);
  // 按下时预建的菜单在松开时直接复用，不再重建
  on['menu:prepare'](); const n = built; handler(null, { x: 1, y: 2 });
  assert.equal(built, n);
  // 锚在桌宠身体右侧；右边放不下（桌宠贴屏幕右沿）改放身体左边
  ctx.screen.getDisplayMatching = () => ({ workArea: { x: 0, y: 0, width: 2560, height: 1440 } });
  handler(null, { x: 220, y: 90, left: 80 });
  assert.equal(popped.x, 220); assert.equal(popped.y, 90);
  ctx.screen.getDisplayMatching = () => ({ workArea: { x: 0, y: 0, width: 1800, height: 1080 } });
  handler(null, { x: 220, y: 90, left: 80 });
  assert.equal(popped.x, 80 - 260); assert.equal(popped.y, 90);
});

test('handoff Esc arbitration: pet focused cancels at once; otherwise first Esc goes back to the app and a quick second one cancels', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const log = []; let focused = null, registered = false, timers = [], clock = 1000;
  const ctx = vm.createContext({
    Date: { now: () => clock }, setTimeout: (fn) => timers.push(fn),
    BrowserWindow: { getFocusedWindow: () => focused },
    winsnap: { available: () => true, tapKey: (vk) => log.push('tap ' + vk) },
    globalShortcut: { isRegistered: () => registered, register: () => { registered = true; log.push('reg'); }, unregister: () => { registered = false; log.push('unreg'); } },
    handoffAction: (x) => { log.push(x.action); ctx.handoffJob = null; },
    handoffJob: { id: 1 },
  });
  vm.runInContext(source.slice(source.indexOf('let escAt = 0;'), source.indexOf('function handoffAction(')), ctx);
  vm.runInContext('escToCancel(true)', ctx);
  vm.runInContext('onHandoffEsc()', ctx);
  assert.deepEqual(log, ['reg', 'unreg', 'tap 27'], '别的应用在前台：第一下 Esc 原样还回去');
  timers.shift()(); assert.equal(registered, true, '还完键重新占住 Esc');
  clock += 2000; log.length = 0;
  vm.runInContext('onHandoffEsc()', ctx);
  assert.deepEqual(log, ['unreg', 'tap 27'], '隔太久的第二下仍算新的第一下');
  timers.shift()(); clock += 400; log.length = 0;
  vm.runInContext('onHandoffEsc()', ctx);
  assert.deepEqual(log, ['cancel'], '1 秒内连按两下取消交接，不再还键');
  ctx.handoffJob = { id: 2 }; focused = {}; log.length = 0; clock += 5000;
  vm.runInContext('onHandoffEsc()', ctx);
  assert.deepEqual(log, ['cancel'], '桌宠自己在前台：一下就取消');
  ctx.winsnap.available = () => false; registered = false; log.length = 0;
  vm.runInContext('escToCancel(true)', ctx);
  assert.deepEqual(log, [], '还不了键时不占用全局 Esc');
});

test('handoff menu nests target tools under each source session, so picking a session never closes and re-pops the menu', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const runs = [];
  const ctx = vm.createContext({ path, handoffJob: null, lastAgentWin: { hwnd: 7, title: 'Codex' },
    winsnap: { titledWindows: () => [{ hwnd: 7 }] }, handoff: { latest: () => null }, handoffSourceKey: () => 'codex', transcriptDirs: () => ['D:\\x'],
    handoffApi: { KINDS: { codex: 'codex' }, recentSessions: () => [{ file: 'a', name: '甲' }, { file: 'b', name: '乙' }], newestTranscript: () => 'b', threadLabel: () => ({}) },
    launchTargets: () => [{ id: 'claude', spec: { label: 'Claude Code' } }, { id: 'zcode', spec: { label: 'ZCode' } }],
    runHandoff: (...a) => runs.push(a), probeSources: () => {}, shell: {}, log: () => {}, __dirname: 'D:\\app',
    utilityProcess: { fork: () => { const w = new EventEmitter(); w.postMessage = (m) => posted.push(m); workers.push(w); return w; } } });
  const posted = [], workers = [];
  // 会话扫描在后台进程里跑（真实扫描逻辑走 session-worker 的 scan），主进程这次只发请求、不阻塞
  const worker = mockedModule('src/main/session-worker.js', { './handoff-api': ctx.handoffApi });
  vm.runInContext(source.slice(source.indexOf('let sessionCache'), source.indexOf('// 一键看')) + source.slice(source.indexOf('function currentHandoffSource('), source.indexOf('const sleep =')), ctx);
  assert.equal(vm.runInContext('handoffMenu()', ctx).some((m) => m.submenu), false, '还没扫完：先不列会话，菜单照常弹');
  vm.runInContext('handoffMenu()', ctx);
  assert.equal(posted.length, 1, '扫描进行中不重复发请求');
  assert.equal(workers.length, 1);
  assert.deepEqual({ ...posted[0] }, { key: 'codex|Codex', kind: 'codex', dirs: ['D:\\x'], title: 'Codex' });
  workers[0].emit('message', { key: posted[0].key, ...worker.scan(posted[0]) });
  const menu = vm.runInContext('handoffMenu()', ctx);
  assert.equal(posted.length, 1, '缓存新鲜时不再扫');
  const sessions = menu.find((m) => m.submenu);
  assert.equal(sessions.label, '换个会话交接（默认《乙》）');
  const pick = sessions.submenu.find((m) => m.label === '《甲》').submenu.find((m) => m.label === '交给 ZCode');
  pick.click();
  assert.equal(runs[0][0], 'zcode');
  assert.deepEqual({ ...runs[0][3] }, { kind: 'codex', file: 'a', name: '甲' });
  menu.find((m) => m.label === '交给 Claude Code').click();
  assert.equal(runs[1][3], null, '顶层目标走自动来源');
});

test('source probe pops a menu with readable tools, in the same style as the session picker', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const popped = [];
  const ctx = vm.createContext({ QUOTA_ONLY: false,
    path, console, log: () => {}, transcriptDirs: () => ['D:\\x'],
    petWin: { id: 1, getBounds: () => ({ x: 1500, y: 900, width: 220, height: 220 }) },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    Menu: { buildFromTemplate: (t) => ({ popup: (o) => popped.push({ t, o }) }) },
    handoffApi: {
      recentSessions: (k) => (k === 'codex' ? [] : [{ name: `${k} 会话`, project: k === 'zcode' ? '默认工作区' : '', fresh: '3 分钟前动过' }]),
    },
  });
  vm.runInContext(source.slice(source.indexOf('function probeSources('), source.indexOf('function handoffMenu(')), ctx);
  const rows = vm.runInContext('probeSources()', ctx);
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((r) => r.ok).length, 5);
  assert.equal(popped.length, 1);
  const t = popped[0].t;
  assert.equal(t[0].label, '可读来源 5/6');
  assert.equal(t[0].enabled, false);
  const items = t.filter((x) => x.type !== 'separator');
  assert.equal(items.length, 7);
  assert.equal(items[1].label, '✓ Claude：claude 会话 · 3 分钟前动过');
  assert.match(items.find((x) => x.label.includes('ZCode')).label, /（默认工作区）/);
  assert.equal(items.find((x) => x.label.includes('Codex')).label, '✗ Codex：没找到记录');
  assert.ok(items.every((x) => x.enabled === false), '只是展示，点了不该有动作');
  assert.equal(popped[0].o.window.id, 1, '菜单要挂在桌宠窗口上弹出');
  assert.equal(typeof popped[0].o.x, 'number'); assert.equal(typeof popped[0].o.y, 'number');
  // popup 用「相对窗口」的偏移：桌宠在 (1500,900)，菜单要落在它左边、稍微靠下
  assert.equal(popped[0].o.x, -340, 'x 是相对窗口的偏移，不是屏幕坐标');
  // 桌宠贴着屏幕下沿时会往上让：900+60 被 1080-280 夹住 → 相对偏移 -100
  assert.equal(popped[0].o.y, -100);
});

test('API handoff reads ZCode sessions straight from its sqlite store', () => {
  const h = require('../src/main/handoff-api');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-'));
  try {
    const dbPath = path.join(dir, 'cli', 'db', 'db.sqlite'); fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('create table session (id text, title text, directory text, time_created integer, time_updated integer, task_type text, time_deleted integer)');
    db.exec('create table message (id text, session_id text, time_created integer, data text)');
    db.exec('create table part (id text, message_id text, session_id text, time_created integer, sequence integer, data text)');
    const now = Date.now();
    db.prepare('insert into session values (?,?,?,?,?,?,?)').run('sess_1', '配字幕，翻译', 'D:\\proj', now - 3600000, now - 60000, 'interactive', null);
    db.prepare('insert into message values (?,?,?,?)').run('m1', 'sess_1', now - 3000000, JSON.stringify({ role: 'user' }));
    db.prepare('insert into message values (?,?,?,?)').run('m2', 'sess_1', now - 2900000, JSON.stringify({ role: 'assistant' }));
    db.prepare('insert into part values (?,?,?,?,?,?)').run('p1', 'm1', 'sess_1', now - 3000000, 0, JSON.stringify({ type: 'text', text: '配字幕，翻译' }));
    db.prepare('insert into part values (?,?,?,?,?,?)').run('p2', 'm2', 'sess_1', now - 2900000, 0, JSON.stringify({ type: 'text', text: '好的' }));
    db.prepare('insert into part values (?,?,?,?,?,?)').run('p3', 'm2', 'sess_1', now - 2890000, 1, JSON.stringify({ type: 'tool', tool: 'shell', state: { input: { cmd: 'ls D:/proj' } } }));
    db.close();
    const file = h.newestTranscript('zcode', [dir]);
    assert.ok(file.startsWith('zcode:'), 'ZCode 的会话用合成路径表示');
    const r = h.parseTranscript(h.readTranscript(file), 'zcode');
    assert.deepEqual(r.user, ['配字幕，翻译']);
    assert.equal(r.cwd, 'D:\\proj');
    assert.ok(r.items.some((i) => i.role === 'tool' && i.full.includes('D:/proj')), '工具参数要保留供路径扫描');
    const l = h.threadLabel('zcode', file, dir);
    assert.equal(l.name, '配字幕，翻译');
    assert.ok(l.minutes <= 2, '新鲜度按 session.time_updated 算');
    assert.equal(h.recentSessions('zcode', [dir], 3)[0].name, '配字幕，翻译');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('API handoff falls back to the most mentioned folder when the session runs inside a tool workspace', () => {
  const h = require('../src/main/handoff-api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  try {
    const work = path.join(dir, 'VideoCaptioner', 'work-dir'); fs.mkdirSync(work, { recursive: true });
    const items = [1, 2, 3, 4].map((i) => ({ role: 'tool', full: JSON.stringify({ cmd: `cat ${path.join(work, 'f' + i + '.py')}` }) }));
    assert.equal(h.commonDir(items, 'Ubuntu'), work);
    // 只提过一次的目录不算（避免临时文件把项目根带偏）
    assert.equal(h.commonDir([items[0]], 'Ubuntu'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('non-git projects in a home-directory session resolve to the dominant folder, not the global cache', () => {
  const h = require('../src/main/handoff-api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-'));
  try {
    // 复刻 2026/10/23 20:04 的翻车现场：WSL 家目录里的 Claude 改 E 盘文档，项目不是 git 仓库，
    // 提到的路径多在 tmp/output 子目录里——以前 projectRoot 返回 null，交接文件掉进全局 .handoff
    const proj = path.join(dir, 'E', 'School', '微专业');
    const tmp = path.join(proj, 'tmp'), out = path.join(proj, 'output');
    fs.mkdirSync(tmp, { recursive: true }); fs.mkdirSync(out, { recursive: true });
    const tool = (p) => ({ role: 'tool', full: JSON.stringify({ cmd: `cat ${p}` }) });
    const items = [];
    for (let i = 0; i < 4; i++) items.push(tool(path.join(tmp, `t${i}.html`)));
    for (let i = 0; i < 2; i++) items.push(tool(path.join(out, `o${i}.pdf`)));
    // dominantDir 取「盖住七成路径的最深目录」：tmp 只有三分之二，微专业全盖住
    assert.equal(h.dominantDir(items, 'Ubuntu'), proj);
    assert.equal(h.commonDir(items, 'Ubuntu'), tmp, 'commonDir 会偏深到子目录，dominantDir 才是项目根');
    // 家目录 cwd（broad）不再直接放弃：兜到 dominantDir，交接文件落回项目根
    assert.equal(h.projectRoot(items, 'Ubuntu-24.04', '/home/akane503'), proj);
    // 会话跑在 ~/.handoff 里（全局交接文件被转接时的目录）也一样能找回项目
    assert.equal(h.projectRoot(items, 'Ubuntu', path.join(os.homedir(), '.handoff')), proj);
    // 路径太少（不足 3 条）不猜，仍交给上层弹目录选择
    assert.equal(h.dominantDir(items.slice(0, 2), 'Ubuntu'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('watchSent recognizes a pasted takeover command in ZCode sqlite sessions', () => {
  const h = require('../src/main/handoff-api');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwatch-'));
  try {
    const dbPath = path.join(dir, 'cli', 'db', 'db.sqlite'); fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('create table session (id text, title text, directory text, time_created integer, time_updated integer, task_type text, time_deleted integer)');
    db.exec('create table message (id text, session_id text, time_created integer, data text)');
    db.exec('create table part (id text, message_id text, session_id text, time_created integer, sequence integer, data text)');
    const now = Date.now();
    db.prepare('insert into session values (?,?,?,?,?,?,?)').run('sess_old', '旧会话', 'D:\\proj', now - 900000, now - 800000, 'interactive', null);
    db.prepare('insert into message values (?,?,?,?)').run('m1', 'sess_old', now - 800000, JSON.stringify({ role: 'user' }));
    db.prepare('insert into part values (?,?,?,?,?,?)').run('p1', 'm1', 'sess_old', now - 800000, 0, JSON.stringify({ type: 'text', text: '$takeover 旧任务' }));
    db.close();
    const check = h.watchSent('zcode', [dir], '$takeover 继续桌宠');
    assert.equal(check(), false, '建立基线时不把旧消息当发送');
    assert.equal(check(), false, '没有新消息时保持未发送');
    // 用户在新会话里粘贴并发送了接手指令：正文与指令吻合才算发出
    const db2 = new DatabaseSync(dbPath);
    db2.prepare('insert into session values (?,?,?,?,?,?,?)').run('sess_new', '$takeover 继续桌宠', 'D:\\proj', now, now, 'interactive', null);
    db2.prepare('insert into message values (?,?,?,?)').run('m2', 'sess_new', now, JSON.stringify({ role: 'user' }));
    db2.prepare('insert into part values (?,?,?,?,?,?)').run('p2', 'm2', 'sess_new', now, 0, JSON.stringify({ type: 'text', text: '$takeover 继续桌宠' }));
    db2.close();
    assert.equal(check(), true);
    // 用户没粘剪贴板、手敲了自己的任务名：以接手指令开头也算发出（2026/10/23 21:13 实测场景）
    const check2 = h.watchSent('zcode', [dir], '$takeover 继续桌宠');
    assert.equal(check2(), false);
    const db5 = new DatabaseSync(dbPath);
    db5.prepare('insert into message values (?,?,?,?)').run('m4', 'sess_new', now + 2000, JSON.stringify({ role: 'user' }));
    db5.prepare('insert into part values (?,?,?,?,?,?)').run('p4', 'm4', 'sess_new', now + 2000, 0, JSON.stringify({ type: 'text', text: '$takeover AI 桌宠' }));
    db5.close();
    assert.equal(check2(), true, '手敲任意 $takeover 开头的任务名也算发出');
    // 聊天里提到 $takeover 但不是以指令开头，不算发送
    const check3 = h.watchSent('zcode', [dir], '$takeover 继续桌宠');
    assert.equal(check3(), false);
    const db6 = new DatabaseSync(dbPath);
    db6.prepare('insert into message values (?,?,?,?)').run('m5', 'sess_new', now + 3000, JSON.stringify({ role: 'user' }));
    db6.prepare('insert into part values (?,?,?,?,?,?)').run('p5', 'm5', 'sess_new', now + 3000, 0, JSON.stringify({ type: 'text', text: '为什么我粘贴 $takeover 它不识别啊' }));
    db6.close();
    assert.equal(check3(), false, '聊天提到不算，必须以指令开头');
    // 已删除会话里的旧消息不参与
    const db3 = new DatabaseSync(dbPath);
    db3.prepare('update session set time_deleted = ? where id = ?').run(now, 'sess_new');
    db3.close();
    const check4 = h.watchSent('zcode', [dir], '$takeover 另一个任务');
    assert.equal(check4(), false);
    const db7 = new DatabaseSync(dbPath);
    db7.prepare('update session set time_deleted = null where id = ?').run('sess_new');
    db7.prepare('insert into message values (?,?,?,?)').run('m6', 'sess_new', now + 4000, JSON.stringify({ role: 'user' }));
    db7.prepare('insert into part values (?,?,?,?,?,?)').run('p6', 'm6', 'sess_new', now + 4000, 0, JSON.stringify({ type: 'text', text: 'use takeover skill 另一个任务' }));
    db7.close();
    assert.equal(check4(), true, 'Use takeover skill 形式也算');
    const db8 = new DatabaseSync(dbPath);
    db8.prepare('insert into message values (?,?,?,?)').run('m3', 'sess_new', now + 5000, JSON.stringify({ role: 'assistant' }));
    db8.prepare('insert into part values (?,?,?,?,?,?)').run('p3', 'm3', 'sess_new', now + 5000, 0, JSON.stringify({ type: 'text', text: 'AI 的回复不算用户发送' }));
    db8.close();
    assert.equal(check4(), false, 'assistant 消息即便更新了基线也不触发');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('session picker tells apart several sessions of the same project', () => {
  const h = require('../src/main/handoff-api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-'));
  try {
    const proj = path.join(dir, 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
    // 两个同标题的 Claude 会话 + 一个不同标题的：同标题的要补短 id，否则菜单里一模一样
    for (const [name, title] of [['a', '接管 ai-pet'], ['b', '接管 ai-pet'], ['c', '另一个会话']]) {
      fs.writeFileSync(path.join(proj, `${name}.jsonl`), JSON.stringify({ type: 'ai-title', aiTitle: title }) + '\n');
    }
    const list = h.recentSessions('claude', [dir], 5);
    assert.equal(list.length, 3);
    const dup = list.filter((s) => s.name.startsWith('接管 ai-pet'));
    assert.equal(dup.length, 2);
    assert.ok(dup.every((s) => /· #[a-z0-9]{4}$/.test(s.name)), '重名会话要带短 id');
    assert.notEqual(dup[0].name, dup[1].name);
    assert.equal(list.find((s) => s.name === '另一个会话') !== undefined, true, '不重名的保持原样');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ZCode sessions inside the default workspace show the folder they actually worked in', () => {
  const h = require('../src/main/handoff-api');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmet-'));
  try {
    const dbPath = path.join(dir, 'cli', 'db', 'db.sqlite'); fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('create table session (id text, title text, directory text, time_created integer, time_updated integer, task_type text, time_deleted integer)');
    db.exec('create table message (id text, session_id text, time_created integer, data text)');
    db.exec('create table part (id text, message_id text, session_id text, time_created integer, sequence integer, data text)');
    const now = Date.now();
    db.prepare('insert into session values (?,?,?,?,?,?,?)').run('sess_1', '配字幕，翻译', path.join(os.homedir(), '.zcode', 'workspace', 'default'), now - 3600000, now - 60000, 'interactive', null);
    db.prepare('insert into message values (?,?,?,?)').run('m1', 'sess_1', now - 3000000, JSON.stringify({ role: 'user' }));
    db.prepare('insert into message values (?,?,?,?)').run('m2', 'sess_1', now - 2900000, JSON.stringify({ role: 'assistant' }));
    db.prepare('insert into part values (?,?,?,?,?,?)').run('p1', 'm1', 'sess_1', now - 3000000, 0, JSON.stringify({ type: 'text', text: '配字幕' }));
    const work = path.join(dir, 'VideoCaptioner', 'work-dir'); fs.mkdirSync(work, { recursive: true });
    for (let i = 0; i < 3; i++) db.prepare('insert into part values (?,?,?,?,?,?)').run(`t${i}`, 'm2', 'sess_1', now - 3000000, i + 1, JSON.stringify({ type: 'tool', tool: 'shell', state: { input: { cmd: `cat ${path.join(work, 'f' + i + '.py')}` } } }));
    db.close();
    const s = h.recentSessions('zcode', [dir], 3)[0];
    assert.equal(s.name, '配字幕，翻译');
    assert.match(s.project, /VideoCaptioner\\work-dir$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ZCode defaults to the session you last typed in, and marks it in the picker', () => {
  const h = require('../src/main/handoff-api');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zact-'));
  try {
    const dbPath = path.join(dir, 'cli', 'db', 'db.sqlite'); fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('create table session (id text, title text, directory text, time_created integer, time_updated integer, task_type text, time_deleted integer)');
    db.exec('create table message (id text, session_id text, time_created integer, data text)');
    db.exec('create table part (id text, message_id text, session_id text, time_created integer, sequence integer, data text)');
    db.exec('create table input_history (id text, project_id text, session_id text, text text, kind text, time_created integer, attachments text)');
    const now = Date.now();
    // newer 是按 time_updated 最新的（后台压缩会刷新它），active 才是用户最后敲字的那个
    db.prepare('insert into session values (?,?,?,?,?,?,?)').run('sess_newer', '后台压缩过的新会话', 'D:\\proj', now - 7200000, now - 60000, 'interactive', null);
    db.prepare('insert into session values (?,?,?,?,?,?,?)').run('sess_active', '正在用的会话', 'D:\\proj', now - 9000000, now - 300000, 'interactive', null);
    db.prepare('insert into message values (?,?,?,?)').run('m1', 'sess_active', now - 9000000, JSON.stringify({ role: 'user' }));
    db.prepare('insert into part values (?,?,?,?,?,?)').run('p1', 'm1', 'sess_active', now - 9000000, 0, JSON.stringify({ type: 'text', text: '继续做这个' }));
    db.prepare('insert into input_history values (?,?,?,?,?,?,?)').run('i1', 'proj', 'sess_active', '继续做这个', 'user', now - 120000, null);
    db.prepare('insert into input_history values (?,?,?,?,?,?,?)').run('i2', 'proj', 'sess_newer', '早先的话', 'user', now - 5000000, null);
    db.close();
    const picked = h.newestTranscript('zcode', [dir]);
    assert.match(picked, /#sess_active$/, '默认要取最后敲过字的会话，而不是 time_updated 最新的');
    const list = h.recentSessions('zcode', [dir], 5);
    assert.equal(list.find((s) => s.current).name, '正在用的会话');
    assert.equal(list.filter((s) => s.current).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pet right-click drops the redundant launch item: double-click already opens the tool', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const ctx = vm.createContext({ QUOTA_ONLY: false,
    buildMenuTemplate: () => [...Array.from({ length: 9 }, (_, i) => ({ label: `ordinary ${i}` })), { label: '⚙️ 设置…' }],
    handoffJob: null, lastHandoffJob: null, petWin: null,
    handoffAction: () => {}, sendPet: () => {}, launchCurrent: () => {},
  });
  vm.runInContext(source.slice(source.indexOf('function petMenuTemplate()'), source.indexOf('function updateTrayMenu()')), ctx);
  const menu = vm.runInContext('petMenuTemplate()', ctx);
  assert.equal(menu.some((m) => m.label === 'ordinary 0'), false, '「打开当前工具」不该出现在右键菜单里');
  assert.ok(menu.some((m) => m.label === 'ordinary 1'), '打开其他…要留着');
  assert.ok(menu.some((m) => m.label === 'ordinary 2'), '交接入口要留着');
  assert.ok(menu.some((m) => m.label === '⚙️ 设置…'), '右键要能直接进设置');
});
test('sessions started by a takeover prompt are named by its task label, not the whole command', () => {
  const { sessionName } = require('../src/main/handoff-api');
  // 现在的指令只有「技能命令 + 任务名」，任务名就是会话名
  assert.equal(sessionName('$takeover 修复桌宠工具切换与提醒'), '修复桌宠工具切换与提醒');
  assert.equal(sessionName('/takeover 串口屏调试'), '串口屏调试');
  assert.equal(sessionName('用 takeover 技能 串口屏调试'), '串口屏调试');
  assert.equal(sessionName('$takeover Codex/Claude 兼容'), 'Codex/Claude 兼容');
  // 旧版带标签/带路径的写法照样认
  assert.equal(sessionName('Ai-pet · ai-pet】用 takeover 技能接手这个交接文件：D:'), 'Ai-pet · ai-pet');
  assert.equal(sessionName('【pintu · BOM】用 takeover 技能接手这个交接文件：D:\\x.md'), 'pintu · BOM');
  assert.equal(sessionName('/takeover [ai-pet_交接联调] D:\\x\\HANDOFF.md'), 'ai-pet_交接联调');
  assert.equal(sessionName('$takeover [pintu] /mnt/d/x.md'), 'pintu');
  // 只带路径的旧指令不拿路径当名字
  assert.equal(sessionName('/takeover D:\\x\\HANDOFF.md'), '');
  assert.equal(sessionName('/takeover /mnt/d/x/HANDOFF.md'), '');
  assert.equal(sessionName('检查正点原子串口屏新版本'), '检查正点原子串口屏新版本');
});

test('Cursor models map to their own model girl, not the tool default', () => {
  const cursor = require('../src/main/cursor-model');
  assert.equal(cursor.characterForModel('claude-opus-4-7'), 'claude');
  assert.equal(cursor.characterForModel('claude-sonnet-4-6'), 'claude');
  assert.equal(cursor.characterForModel('gpt-5.6-sol'), 'codex');
  assert.equal(cursor.characterForModel('gpt-5.3-codex'), 'codex');
  assert.equal(cursor.characterForModel('o3-mini'), 'codex');
  assert.equal(cursor.characterForModel('gemini-4-argon'), 'gemini');
  assert.equal(cursor.characterForModel('grok-4.7'), 'grok');
  assert.equal(cursor.characterForModel('kimi-k3'), 'kimi');
  assert.equal(cursor.characterForModel('glm-5.3'), 'zcode');
  assert.equal(cursor.characterForModel('qwen3-max'), 'qwen');
  assert.equal(cursor.characterForModel('deepseek-v4'), 'deepseek');
  assert.equal(cursor.characterForModel('doubao-seed-2-1'), 'seed');
  // 旧版会把参数写进模型名
  assert.equal(cursor.characterForModel('claude-4.6-sonnet[thinking=true]'), 'claude');
  assert.equal(cursor.prettyModel('claude-4.6-sonnet[thinking=true]'), 'Claude 4.6 Sonnet');
  // Auto / Cursor 自家模型没有对应立绘，交给调用方回落
  assert.equal(cursor.characterForModel('default'), null);
  assert.equal(cursor.characterForModel('composer-2.5'), null);
  assert.equal(cursor.characterForModel('muse-wonder-1.0', 'meta'), null);
  // 显示名：有 Cursor 的目录就用它，没有才自己拼
  assert.equal(cursor.prettyModel('claude-opus-4-7'), 'Claude Opus 4.7');
  assert.equal(cursor.prettyModel('gemini-4-argon'), 'Gemini 4 Argon');
});

test('Cursor local state exposes the active model and falls back to Auto', () => {
  const cursor = require('../src/main/cursor-model');
  const { DatabaseSync } = require('node:sqlite');
  const APP_USER_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-model-'));
  try {
    const dbPath = path.join(dir, 'state.vscdb');
    const appUser = {
      availableDefaultModels2: [
        { name: 'default', clientDisplayName: 'Auto', serverModelName: 'default', vendorName: 'cursor' },
        { name: 'gemini-4-argon', clientDisplayName: 'Gemini 4 Argon', serverModelName: 'gemini-4-argon', vendorName: 'google' },
        { name: 'claude-opus-4-7', clientDisplayName: 'Claude Opus 4.7', serverModelName: 'claude-opus-4-7', vendorName: 'anthropic' },
      ],
      aiSettings: { modelConfig: { composer: { modelName: 'default', selectedModels: [{ modelId: 'default' }] } } },
    };
    const make = (model) => {
      let db = new DatabaseSync(dbPath);
      db.exec('create table if not exists ItemTable (key text, value text)');
      db.exec('create table if not exists cursorDiskKV (key text, value text)');
      db.exec('create table if not exists composerHeaders (composerId text, recency integer, isArchived integer, isSubagent integer)');
      db.prepare('insert or replace into ItemTable values (?,?)').run(APP_USER_KEY, JSON.stringify(appUser));
      db.prepare('insert or replace into ItemTable values (?,?)').run('cursor/glass.selectedAgent', 'c1');
      db.prepare("delete from cursorDiskKV where key = 'composerData:c1'").run();
      db.prepare('insert into cursorDiskKV values (?,?)').run('composerData:c1', JSON.stringify({ createdAt: 1, modelConfig: { modelName: model, selectedModels: [{ modelId: model }] } }));
      db.prepare('delete from composerHeaders').run();
      db.prepare('insert into composerHeaders values (?,?,?,?)').run('c1', 1234, 0, 0);
      db.close();
    };
    make('gemini-4-argon');
    let info = cursor.read(dbPath);
    assert.equal(info.ok, true);
    assert.equal(info.model, 'gemini-4-argon');
    assert.equal(info.label, 'Gemini 4 Argon');
    assert.equal(info.character, 'gemini');
    assert.equal(info.auto, false);
    // 没被缓存的路径读到的是真实数据（同名缓存只影响 info()）
    make('default');
    info = cursor.read(dbPath);
    assert.equal(info.auto, true);
    assert.equal(info.label, 'Auto');
    assert.equal(info.character, null);
    assert.equal(cursor.character(dbPath), 'claude');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Cursor missing/unreadable state never breaks the pet character', () => {
  const cursor = require('../src/main/cursor-model');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-none-'));
  try {
    const info = cursor.read(path.join(dir, 'missing.vscdb'));
    assert.equal(info.ok, false);
    assert.equal(info.character, null);
    assert.equal(cursor.character(path.join(dir, 'missing.vscdb')), 'claude');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('character selection reports the tool and model while keeping older reasons', () => {
  const now = Date.now();
  const r = activity.selectCharacter({ appearance: { character: 'auto' }, now, foreground: { character: 'gemini', at: now, label: 'Cursor · Gemini 4 Argon' } });
  assert.equal(r.character, 'gemini');
  assert.equal(r.why, '前台是 Cursor · Gemini 4 Argon');
  assert.equal(activity.selectCharacter({ appearance: { character: 'auto' }, now, foreground: { character: 'codex', at: now } }).why, '前台是 codex');
});

test('Cursor mascot follows the active model and falls back to the configured look', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const info = { value: { ok: true, character: 'gemini', label: 'Gemini 4 Argon' } };
  const ctx = vm.createContext({ QUOTA_ONLY: false,
    cursorModel: { info: () => info.value },
    config: { data: { providers: [] } },
    enabledProviders: () => [],
    allCharacters: () => [
      { id: 'deepseek', keys: ['deepseek'] }, { id: 'codex', keys: ['codex'] },
      { id: 'claude', keys: ['claude'] }, { id: 'gemini', keys: ['gemini'] },
      { id: 'qwen', keys: ['qwen'] },
    ],
  });
  vm.runInContext(source.slice(source.indexOf('function charOf('), source.indexOf('function characterImages(')), ctx);
  assert.equal(vm.runInContext("mascotOf('cursor')", ctx), 'gemini', 'Cursor 用 Gemini 时应该显示哈基米');
  assert.equal(vm.runInContext("mascotOf('codex')", ctx), 'codex', '普通工具仍走原来的角色映射');
  info.value = { ok: true, character: null, label: 'Auto' };
  assert.equal(vm.runInContext("mascotOf('cursor')", ctx), 'claude', 'Auto/无对应立绘时回落 Cursor 的默认 look');
  ctx.config.data.providers = [{ type: 'cursor', enabled: true, character: 'qwen' }];
  assert.equal(vm.runInContext("mascotOf('cursor')", ctx), 'qwen', '用户显式指定 Cursor 角色时尊重配置');
  ctx.config.data.providers = [{ type: 'cursor', enabled: true, character: 'cursor', dbPath: 'D:\\custom\\state.vscdb' }];
  assert.equal(vm.runInContext('cursorDbPath()', ctx), 'D:\\custom\\state.vscdb');
  assert.equal(vm.runInContext("mascotOf('cursor')", ctx), 'claude', '旧配置里的 cursor 空角色不能漏过去');
});

test('Cursor receipt ignores old commands, message edits and session reorder, and waits for new message bodies', () => {
  const h = require('../src/main/handoff-api');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-receipt-'));
  const dbPath = path.join(dir, 'state.vscdb');
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('create table cursorDiskKV(key text primary key, value text); create table ItemTable(key text, value text); create table composerHeaders(composerId text, recency integer, isArchived integer, isSubagent integer)');
    const put = (key, data) => db.prepare('insert or replace into cursorDiskKV values (?,?)').run(key, JSON.stringify(data));
    const headers = [{ type: 1, bubbleId: 'old' }, { type: 1, bubbleId: 'hydrated-old' }];
    put('composerData:demo', { fullConversationHeadersOnly: headers });
    put('bubbleId:demo:old', { text: '$takeover 演示任务' });
    db.prepare('insert into composerHeaders values (?,1,0,0)').run('demo');
    // 旧会话最初不在最近 20 条；重新排序后也不能认作本次交接。
    for (let i = 0; i < 21; i++) {
      db.prepare('insert into composerHeaders values (?,?,0,0)').run('other' + i, i + 2);
      put('composerData:other' + i, { fullConversationHeadersOnly: [] });
    }
    const check = h.watchSent('cursor', [dbPath], '$takeover 演示任务');
    let tick = Date.now();
    const changed = () => { fs.utimesSync(dbPath, new Date(), new Date(tick += 2000)); return check(); };
    assert.equal(check(), false);
    db.prepare('update composerHeaders set recency=100 where composerId=?').run('demo');
    assert.equal(changed(), false, '旧会话重排不能报接手');
    put('bubbleId:demo:hydrated-old', { text: '$takeover 演示任务' });
    put('bubbleId:demo:old', { text: '$takeover 演示任务 编辑旧消息' });
    assert.equal(changed(), false, '旧正文回填或编辑不能报接手');
    headers.push({ type: 1, bubbleId: 'unrelated' });
    put('composerData:demo', { fullConversationHeadersOnly: headers });
    put('bubbleId:demo:unrelated', { text: '完全无关的新消息' });
    assert.equal(changed(), false, '历史已有同名指令时，无关新消息也不能误报');
    headers.push({ type: 1, bubbleId: 'new' });
    put('composerData:demo', { fullConversationHeadersOnly: headers });
    assert.equal(changed(), false, '新 header 没有正文时等待');
    put('bubbleId:demo:new', { text: '$takeover 演示任务' });
    assert.equal(changed(), true, '同名指令真正再次发送才成功');
    assert.equal(check(), false, '同一条消息只消费一次');
  } finally {
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Cursor handoff reads the composer transcript, names the session and watches for the sent instruction', () => {
  const h = require('../src/main/handoff-api');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-handoff-'));
  try {
    const dbPath = path.join(dir, 'state.vscdb');
    const id = 'c1111111-1111-1111-1111-111111111111';
    const data = {
      name: '测试会话', createdAt: Date.now() - 3600e3, lastUpdatedAt: Date.now() - 60e3,
      workspaceIdentifier: { uri: { fsPath: 'D:\\proj\\demo' } },
      fullConversationHeadersOnly: [
        { bubbleId: 'b1', type: 1, grouping: { hasText: true } },
        { bubbleId: 'b2', type: 2, grouping: { hasText: true } },
        { bubbleId: 'b3', type: 1, grouping: { hasText: true } },
        { bubbleId: 'b4', type: 2, grouping: { hasText: false } },
      ],
    };
    let db = new DatabaseSync(dbPath);
    db.exec('create table ItemTable(key text, value text)');
    db.exec('create table cursorDiskKV(key text, value text)');
    db.exec('create table composerHeaders(composerId text, recency integer, isArchived integer, isSubagent integer)');
    db.prepare('insert into ItemTable values (?,?)').run('cursor/glass.selectedAgent', id);
    db.prepare('insert into composerHeaders values (?,?,?,?)').run(id, Date.now() - 60e3, 0, 0);
    db.prepare('insert into cursorDiskKV values (?,?)').run('composerData:' + id, JSON.stringify(data));
    const put = (bid, type, text) => db.prepare('insert into cursorDiskKV values (?,?)').run(`bubbleId:${id}:${bid}`, JSON.stringify({ type, text }));
    put('b1', 1, '帮我做一个演示项目');
    put('b2', 2, '好的，先看一下目录。');
    // Plan 模式会以 user 身份插话，这不是人打的字
    put('b3', 1, 'Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.');
    put('b4', 2, '计划已执行。');
    db.close();

    assert.equal(h.KINDS.cursor, 'cursor');
    const ref = h.newestTranscript('cursor', [dbPath], 'main.js - demo - Cursor');
    assert.match(ref, /^cursor:/);
    const parsed = h.parseTranscript(h.readTranscript(ref), 'cursor');
    assert.deepEqual(parsed.user, ['帮我做一个演示项目']);
    assert.equal(parsed.cwd, 'D:\\proj\\demo');
    assert.ok(parsed.items.some((x) => x.role === 'ai' && /好的/.test(x.t)));
    const label = h.threadLabel('cursor', ref);
    assert.equal(label.name, '测试会话');
    assert.ok(label.fresh);
    const list = h.recentSessions('cursor', [dbPath], 5);
    assert.equal(list[0].project, 'demo');
    assert.equal(list[0].current, true);

    // 同项目的后台会话更新更晚，也不能压过当前选中的聊天。
    db = new DatabaseSync(dbPath);
    db.prepare('insert into composerHeaders values (?,?,0,0)').run('background', Date.now() + 1000);
    db.prepare('insert into cursorDiskKV values (?,?)').run('composerData:background', JSON.stringify({ ...data, name: '后台会话' }));
    db.close();
    assert.equal(h.newestTranscript('cursor', [dbPath], 'main.js - demo - Cursor'), ref);

    const check = h.watchSent('cursor', [dbPath], '$takeover 继续做演示');
    assert.equal(check(), false);
    db = new DatabaseSync(dbPath);
    db.prepare('insert into cursorDiskKV values (?,?)').run(`bubbleId:${id}:b5`, JSON.stringify({ type: 1, text: '$takeover 继续做演示' }));
    data.fullConversationHeadersOnly.push({ bubbleId: 'b5', type: 1, grouping: { hasText: true } });
    db.prepare('update cursorDiskKV set value=? where key=?').run(JSON.stringify(data), 'composerData:' + id);
    db.prepare('update composerHeaders set recency=? where composerId=?').run(Date.now(), id);
    db.close();
    assert.equal(check(), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('menuWindows enumerates only own-process Electron menu columns; null (no FFI) means "unknown", never an empty list', () => {
  const w = require('../src/main/winsnap');
  assert.equal(typeof w.menuWindows, 'function');
  if (!w.available()) { assert.equal(w.menuWindows(), null, 'koffi 不可用时返回 null（未知），调用方退化为单次弹'); return; }
  // node 进程自己没有 Electron 菜单窗口，但必须拿到数组（可探测）而不是 null
  const r = w.menuWindows();
  assert.ok(Array.isArray(r), '可探测时返回数组');
  assert.ok(r.every((x) => typeof x.left === 'number' && typeof x.top === 'number'), '每列带屏幕矩形');
});
