'use strict';
// 从本机已有配置里发现凭据（只在本机读取，用于首次自动填充；用户可在设置里覆盖）
const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || '';
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } }
function readJson(p) { try { return JSON.parse(readText(p)); } catch (_) { return null; } }
function exists(p) { try { return fs.existsSync(p); } catch (_) { return false; } }

function findDeepSeekKey() {
  const cands = [];
  const j = readJson(path.join(HOME, '.codex', 'big-fish-pet', 'deepseek-credentials.json'));
  if (j) { const k = j.apiKey || j.api_key || j.DEEPSEEK_API_KEY || j.key; if (k) cands.push({ key: k, from: '旧大肥鱼 deepseek-credentials.json' }); }
  for (const f of ['deepseek.config.toml', 'config.toml']) {
    const t = readText(path.join(HOME, '.codex', f));
    const m = /(?:DEEPSEEK_API_KEY|api_key)\s*=\s*["']?(sk-[A-Za-z0-9]{20,})/.exec(t);
    if (m) cands.push({ key: m[1], from: '~/.codex/' + f });
  }
  if (process.env.DEEPSEEK_API_KEY) cands.push({ key: process.env.DEEPSEEK_API_KEY, from: '环境变量' });
  const ds = readJson(path.join(HOME, '.dsh', 'credentials.json'));
  if (ds && ds.DEEPSEEK_API_KEY) cands.push({ key: ds.DEEPSEEK_API_KEY, from: '~/.dsh/credentials.json' });
  return cands;
}

function claudeSettingsCandidates() {
  const dirs = [path.join(HOME, '.claude')];
  const cc = readJson(path.join(HOME, '.cc-switch', 'settings.json'));
  if (cc && cc.claudeConfigDir) dirs.push(cc.claudeConfigDir);
  const out = [];
  for (const d of dirs) {
    const s = readJson(path.join(d, 'settings.json'));
    const env = s && s.env;
    if (env && env.ANTHROPIC_BASE_URL && (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY)) {
      out.push({ baseUrl: env.ANTHROPIC_BASE_URL, apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || null, from: path.join(d, 'settings.json') });
    }
  }
  return out;
}

// cc-switch 的 sqlite 里 settings_config 是明文 JSON，直接扫字符串找 BASE_URL / TOKEN 对
function ccSwitchCandidates() {
  const f = path.join(HOME, '.cc-switch', 'cc-switch.db');
  if (!exists(f)) return [];
  let buf;
  try { buf = fs.readFileSync(f); } catch (_) { return []; }
  const text = buf.toString('latin1');
  const out = [];
  const re = /"ANTHROPIC_BASE_URL"\s*:\s*"([^"]+)"[^{}]{0,400}?"(?:ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) out.push({ baseUrl: m[1], apiKey: m[2], from: 'cc-switch (claude)' });
  const re2 = /"(?:ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)"\s*:\s*"([^"]+)"[^{}]{0,400}?"ANTHROPIC_BASE_URL"\s*:\s*"([^"]+)"/g;
  while ((m = re2.exec(text))) out.push({ baseUrl: m[2], apiKey: m[1], from: 'cc-switch (claude)' });
  const re3 = /"OPENAI_API_KEY"\s*:\s*"([^"]+)"[\s\S]{0,600}?base_url\s*=\s*\\?"([^"\\]+)/g;
  while ((m = re3.exec(text))) out.push({ baseUrl: m[2], apiKey: m[1], from: 'cc-switch (codex)' });
  const seen = new Set();
  return out.filter((c) => { const k = c.baseUrl + '|' + c.apiKey; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ZCode（智谱桌面 agent）自己的 provider 配置里有 Z.ai / bigmodel 的 API Key
function zcodeCandidates() {
  const j = readJson(path.join(HOME, '.zcode', 'v2', 'config.json'));
  const out = [];
  const provs = (j && j.provider) || {};
  for (const [id, p] of Object.entries(provs)) {
    const o = (p && p.options) || {};
    if (!o.apiKey || !o.baseURL) continue;
    const u = String(o.baseURL).toLowerCase();
    if (!(u.includes('z.ai') || u.includes('bigmodel'))) continue;
    out.push({ baseUrl: u.includes('bigmodel') ? 'https://open.bigmodel.cn' : 'https://api.z.ai', apiKey: o.apiKey, from: 'ZCode ' + (p.name || id), planKey: u.includes('zcode-plan') });
  }
  const seen = new Set();
  return out.filter((c) => { const k = c.baseUrl + '|' + c.apiKey; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Gemini CLI 走中转站时，地址和 Key 在 ~/.gemini/.env（官方 OAuth 则只有 oauth_creds.json）
function geminiCandidates() {
  const env = require('./providers/gemini').readEnvFile(path.join(HOME, '.gemini', '.env'));
  const baseUrl = env.GOOGLE_GEMINI_BASE_URL || env.GEMINI_BASE_URL || '';
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  if (!baseUrl || /googleapis\.com/i.test(baseUrl)) return [];
  return [{ baseUrl, apiKey, from: '~/.gemini/.env' }];
}

function classify(baseUrl) {
  const u = String(baseUrl || '').toLowerCase();
  if (u.includes('bigmodel.cn') || u.includes('z.ai')) return 'zhipu';
  if (u.includes('api.deepseek.com')) return 'deepseek';
  if (u.includes('api.anthropic.com') || u.includes('api.openai.com')) return 'official';
  return 'newapi';
}

function scan() {
  const relays = [...claudeSettingsCandidates(), ...ccSwitchCandidates()];
  return {
    deepseek: findDeepSeekKey(),
    relays: [...relays.map((r) => ({ ...r, type: classify(r.baseUrl) })), ...zcodeCandidates().map((r) => ({ ...r, type: 'zhipu' })), ...geminiCandidates().map((r) => ({ ...r, type: 'gemini' }))],
    codexAuth: exists(path.join(HOME, '.codex', 'auth.json')),
    claudeCreds: require('./activity').detectClaudeDirs({}).map((d) => path.join(d, '.credentials.json')).filter(exists),
    geminiCreds: exists(path.join(HOME, '.gemini', 'oauth_creds.json')),
  };
}

module.exports = { scan, classify };
