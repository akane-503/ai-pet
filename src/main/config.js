'use strict';
// 配置与持久化状态（JSON 文件，存放在 %APPDATA%/ai-pet/）
const fs = require('fs');
const path = require('path');
const os = require('os');

const WIN_HOME = process.env.USERPROFILE || os.homedir();

// 常见 agent 预设：process 进程名（| 分隔）、title 窗口标题正则、dir 会话目录、look 借用哪个内置角色的立绘
const AGENT_PRESETS = [
  { id: 'cursor', name: 'Cursor', process: 'Cursor.exe', look: 'claude', url: 'https://cursor.com' },
  { id: 'trae', name: 'Trae', process: 'Trae.exe|Trae CN.exe', look: 'seed', url: 'https://www.trae.ai' },
  { id: 'windsurf', name: 'Windsurf', process: 'Windsurf.exe', look: 'gemini', url: 'https://windsurf.com' },
  { id: 'kiro', name: 'Kiro', process: 'Kiro.exe', look: 'grok', url: 'https://kiro.dev' },
  { id: 'qoder', name: 'Qoder', process: 'Qoder IDE.exe|Qoder.exe', look: 'qwen', url: 'https://qoder.com' },
  { id: 'codebuddy', name: 'CodeBuddy', process: 'CodeBuddy.exe', look: 'kimi', url: 'https://www.codebuddy.ai' },
  { id: 'workbuddy', name: 'WorkBuddy', process: 'WorkBuddy.exe', look: 'qwen', dir: path.join(WIN_HOME, '.workbuddy', 'sessions'), url: 'https://www.workbuddy.cn' },
  { id: 'yuanbao', name: '元宝', process: 'yuanbao.exe', title: '^腾讯元宝', look: 'deepseek', url: 'https://yuanbao.tencent.com' },
];

function defaultConfig() {
  return {
    version: 1,
    appearance: {
      scale: 1.25,
      character: 'auto',          // auto | deepseek | codex | claude | glm | gemini | cat ...
      favorite: 'deepseek',       // auto 模式下无活动时回落的角色
      deepseekSkin: 'classic',    // classic(原版胸像) | chibi(Q版胸像) | svg
      customImages: {},           // characterId -> 本机图片路径（覆盖内置立绘）
      bubbleOn: true,
      bubbleSeconds: 5,
      headpatStyle: 'rub',        // rub(原版揉头节奏) | gentle(轻拍差分)
      sound: 'off',               // off | duck | fx1
      volume: 0.6,
      peakMode: 'default',        // default | liang | strong | off
      alwaysOnTop: true,
      snapScreen: true,
      snapWindows: true,
      fullAmountCNY: 100,         // 余额多少算“吃饱”（影响体型）
      opacity: 1,
      quipsOn: true,
      idleQuipMin: 6,             // 闲置时每隔约 N 分钟随口说一句（0 关闭）
    },
    refresh: { intervalSec: 300, newsIntervalMin: 60 },
    providers: [
      { id: 'deepseek', type: 'deepseek', name: 'DeepSeek', enabled: false, apiKey: '', lowBalance: 5, character: 'deepseek' },
      { id: 'codex', type: 'codex', name: 'Codex / ChatGPT', enabled: false, authPath: path.join(WIN_HOME, '.codex', 'auth.json'), codexHome: path.join(WIN_HOME, '.codex'), warnPercent: 90, character: 'codex' },
      { id: 'relay', type: 'newapi', name: '中转站', enabled: false, baseUrl: '', apiKey: '', accessToken: '', userId: '', lowBalance: 1, character: 'claude', announcements: true },
      { id: 'zhipu', type: 'zhipu', name: 'GLM Coding Plan', enabled: false, baseUrl: 'https://open.bigmodel.cn', apiKey: '', warnPercent: 90, character: 'zcode' },
      { id: 'claude-oauth', type: 'claude-oauth', name: 'Claude 订阅', enabled: false, credentialsPath: path.join(WIN_HOME, '.claude', '.credentials.json'), warnPercent: 90, character: 'claude' },
      { id: 'gemini', type: 'gemini', name: 'Gemini CLI', enabled: false, baseUrl: '', apiKey: '', accessToken: '', userId: '', credentialsPath: path.join(WIN_HOME, '.gemini', 'oauth_creds.json'), project: '', auth: 'auto', warnPercent: 90, character: 'gemini' },
      { id: 'kimi', type: 'kimi', name: 'Kimi', enabled: false, agentDir: '', warnPercent: 90, character: 'kimi' },
    ],
    notify: {
      toast: false, bubble: true, sound: false,
      resets: true, gifts: true, newModels: true, lowBalance: true, announcements: false, rss: false,
      quietHours: '',            // 例如 "23:00-08:00"
      rssFeeds: [],              // { name, url, enabled }
    },
    activity: {
      mode: 'auto',
      windowMin: 15,
      codexDir: path.join(WIN_HOME, '.codex'),
      claudeDir: '',              // 自动探测（WSL 或本机）
      geminiDir: path.join(WIN_HOME, '.gemini'),
      qwenDir: path.join(WIN_HOME, '.qwen'),
      kimiDir: path.join(process.env.APPDATA || path.join(WIN_HOME, 'AppData', 'Roaming'), 'kimi-desktop', 'kimi-agent'),
      claudeSettingsPath: '',
    },
    quips: { enabled: false, apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', intervalHours: 24, perCharacter: 25, keep: 80 },   // 用户主动启用后，使用自己的 DeepSeek Key 生成台词
    agents: null,               // null = 首次启动时按本机已装的 AGENT_PRESETS 自动填
    launch: {},                 // characterId -> { kind: app|store|wsl-cli|cli|url, label, target, match, distro, command, cwd }
    layout: { x: null, y: null, snapped: null },
    autostart: false,
    firstRunDone: false,
    quotaOnboardingDone: false,
  };
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra !== undefined ? extra : base;
  if (typeof base !== 'object' || base === null) return extra !== undefined ? extra : base;
  const out = { ...base };
  for (const k of Object.keys(extra || {})) {
    out[k] = (typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) && typeof extra[k] === 'object' && extra[k] !== null && !Array.isArray(extra[k]))
      ? deepMerge(base[k], extra[k]) : extra[k];
  }
  return out;
}

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = null;
    this._timer = null;
  }
  load() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置格式错误'); }
    catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.copyFileSync(this.file, this.file + '.broken-' + Date.now(), fs.constants.COPYFILE_EXCL); } catch (_) { /* 保留原文件 */ }
        console.error('JSON 文件异常，尝试恢复备份:', path.basename(this.file));
      }
      try { raw = JSON.parse(fs.readFileSync(this.file + '.bak', 'utf8')); } catch (_) { raw = null; }
    }
    this.data = deepMerge(this.defaults(), raw || {});
    // providers 数组：补齐默认项缺失字段
    if (Array.isArray(this.data.providers)) {
      const defs = this.defaults().providers;
      this.data.providers = this.data.providers.map((p) => {
        const d = defs.find((x) => x.id === p.id) || defs.find((x) => x.type === p.type) || {};
        return { ...d, ...p };
      });
    }
    return this.data;
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      try { const prev = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (prev && typeof prev === 'object' && !Array.isArray(prev)) fs.copyFileSync(this.file, this.file + '.bak'); } catch (_) { /* 首次保存或损坏文件不覆盖有效备份 */ }
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) { console.error('save failed', this.file, e.message); return false; }
  }
  saveSoon() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.save(), 400);
  }
}

function defaultState() {
  return {
    handoffReturns: [],   // project/tool -> original local session reference; no transcript text
    handoffTimings: [],   // completed request durations/workload only, no conversation contents
    snapshots: {},        // providerId -> 最近一次成功结果
    ledgers: {},          // providerId -> { date, lastBalance, lastCurrency, todayUsage, history[] }
    models: {},           // providerId -> [model ids]
    announcements: {},    // providerId -> [ids]
    rssSeen: {},          // url -> [guids]
    notifications: [],    // { id, ts, kind, title, body, providerId, read }
    lastActive: null,     // 最近活跃的 providerId
    lastActiveAt: 0,
    codexModels: [],      // codex models_cache 里的 slug 列表
    maxBalanceSeen: {},   // providerId -> 观测过的最大余额（用于体型）
    quips: { updatedAt: 0, byCharacter: {}, lastError: null },
  };
}

module.exports = { JsonStore, defaultConfig, defaultState, deepMerge, WIN_HOME, AGENT_PRESETS };
