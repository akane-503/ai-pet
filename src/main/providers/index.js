'use strict';
const impls = {
  deepseek: require('./deepseek'),
  codex: require('./codex'),
  newapi: require('./newapi'),
  openai: require('./newapi'),
  gemini: require('./gemini'),
  zhipu: require('./zhipu'),
  'claude-oauth': require('./claude-oauth'),
  cursor: require('./cursor'),
  kimi: require('./kimi'),
  custom: require('./custom'),
};

const TYPE_META = {
  deepseek: { label: 'DeepSeek 官方', fields: ['apiKey', 'lowBalance'], kind: 'balance', defaultCharacter: 'deepseek' },
  codex: { label: 'Codex / ChatGPT 账号', fields: ['codexHome', 'warnPercent'], kind: 'window', defaultCharacter: 'codex' },
  newapi: { label: '中转站 (new-api / one-api)', fields: ['baseUrl', 'apiKey', 'accessToken', 'userId', 'lowBalance', 'announcements'], kind: 'balance', defaultCharacter: 'claude' },
  gemini: { label: 'Gemini CLI（OAuth / 中转站）', fields: ['baseUrl', 'apiKey', 'accessToken', 'userId', 'credentialsPath', 'project', 'auth', 'warnPercent'], kind: 'window', defaultCharacter: 'gemini' },
  zhipu: { label: '智谱 GLM / Z.ai Coding Plan', fields: ['baseUrl', 'apiKey', 'warnPercent'], kind: 'window', defaultCharacter: 'zcode' },
  'claude-oauth': { label: 'Claude 订阅 (Claude Code 登录)', fields: ['credentialsPath', 'warnPercent'], kind: 'window', defaultCharacter: 'claude' },
  cursor: { label: 'Cursor 订阅（读本机登录）', fields: ['dbPath', 'cookie', 'warnPercent'], kind: 'window', defaultCharacter: 'claude' },
  kimi: { label: 'Kimi 桌面版（Kimi Work）', fields: ['agentDir', 'warnPercent'], kind: 'window', defaultCharacter: 'kimi' },
  custom: { label: '自定义 JSON 接口', fields: ['baseUrl', 'apiKey', 'balancePath', 'usedPath', 'limitPath', 'currency', 'warnPercent'], kind: 'window', defaultCharacter: 'deepseek' },
};

async function fetchSnapshot(provider, ctx) {
  const impl = impls[provider.type];
  if (!impl) return { providerId: provider.id, type: provider.type, name: provider.name, ok: false, error: '未知类型 ' + provider.type, at: Date.now(), windows: [], lines: [] };
  try {
    const s = await impl.fetchSnapshot(provider, ctx || {});
    s.at = s.at || Date.now();
    return s;
  } catch (e) {
    return { providerId: provider.id, type: provider.type, name: provider.name, ok: false, error: e.message, at: Date.now(), windows: [], lines: [] };
  }
}

module.exports = { fetchSnapshot, TYPE_META, impls };
