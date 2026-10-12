'use strict';
const impls = {
  deepseek: require('./deepseek'),
  codex: require('./codex'),
  newapi: require('./newapi'),
  openai: require('./newapi'),
  zhipu: require('./zhipu'),
  'claude-oauth': require('./claude-oauth'),
};

const TYPE_META = {
  deepseek: { label: 'DeepSeek 官方', fields: ['apiKey', 'lowBalance'], kind: 'balance', defaultCharacter: 'deepseek' },
  codex: { label: 'Codex / ChatGPT 账号', fields: ['codexHome', 'warnPercent'], kind: 'window', defaultCharacter: 'codex' },
  newapi: { label: '中转站 (new-api / one-api)', fields: ['baseUrl', 'apiKey', 'accessToken', 'userId', 'lowBalance', 'announcements'], kind: 'balance', defaultCharacter: 'claude' },
  zhipu: { label: '智谱 GLM / Z.ai Coding Plan', fields: ['baseUrl', 'apiKey', 'warnPercent'], kind: 'window', defaultCharacter: 'zcode' },
  'claude-oauth': { label: 'Claude 订阅 (Claude Code 登录)', fields: ['credentialsPath', 'warnPercent'], kind: 'window', defaultCharacter: 'claude' },
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
