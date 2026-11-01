'use strict';
// 工具、设置字段和探测能力共用一个目录。新增工具不必往设置页加一块 HTML。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { AGENT_PRESETS } = require('./config');
const HOME = process.env.USERPROFILE || os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const ACTIVITY_FIELDS = [
  { key: 'windowMin', label: '活跃判定窗口（分钟）', type: 'number', min: 1 },
  ...[['codexDir','Codex 目录','.codex'], ['claudeDir','Claude 配置目录','.claude'], ['geminiDir','Gemini 目录','.gemini'], ['qwenDir','Qwen 目录','.qwen'], ['zcodeDir','ZCode 目录','.zcode']].map(([key,label,dir]) => ({ key,label,type:'directory', suggested:path.join(HOME,dir) })),
  { key:'kimiDir',label:'Kimi 数据目录',type:'directory',suggested:path.join(APPDATA,'kimi-desktop','kimi-agent') },
  { key:'claudeSettingsPath',label:'Claude 路由配置',type:'file',suggested:path.join(HOME,'.claude','settings.json') },
];
const TOOLS = [
  { id:'deepseek',name:'DSH Desktop',home:'.dsh',transcript:'dsh',data:()=>path.join(HOME,'.dsh') },
  { id:'codex',name:'Codex',home:'.codex',transcript:'codex',activityKey:'codexDir' },
  { id:'claude',name:'Claude',home:'.claude',transcript:'claude',activityKey:'claudeDir' },
  { id:'zcode',name:'ZCode',home:'.zcode',transcript:'zcode',activityKey:'zcodeDir' },
  { id:'gemini',name:'Gemini',home:'.gemini',activityKey:'geminiDir' },
  { id:'qwen',name:'Qwen',home:'.qwen',activityKey:'qwenDir' },
  { id:'kimi',name:'Kimi',activityKey:'kimiDir' },
  { id:'grok',name:'Grok Bot',data:()=>path.join(APPDATA,'Grok Bot') },
  ...AGENT_PRESETS.map(a=>({id:a.id,name:a.name,preset:a,home:'.'+a.id,transcript:['cursor','workbuddy'].includes(a.id)?a.id:null,
    data:a.id==='cursor'?()=>path.join(APPDATA,'Cursor','User','globalStorage','state.vscdb'):a.id==='workbuddy'?()=>path.join(HOME,'.workbuddy','workbuddy.db'):null})),
];
function exists(p) { try { return !!p && fs.existsSync(p); } catch (_) { return false; } }
function definitions(config) {
  const byId = new Map(TOOLS.map(t=>[t.id,{...t}]));
  for (const a of config.agents || []) byId.set(a.id, { ...(byId.get(a.id)||{}),id:a.id,name:a.name||a.id,agent:a });
  return [...byId.values()];
}
function inspect(config, specs, { available = () => false, modelInfo = () => null, cursorInfo = () => null } = {}) {
  const activity = config.activity || {};
  return { at:Date.now(),platform:process.platform,activityFields:ACTIVITY_FIELDS,tools:definitions(config).map(t=> {
    const agent=t.agent||t.preset, spec=specs[t.id]||null;
    const field=ACTIVITY_FIELDS.find(f=>f.key===t.activityKey);
    const provider=(config.providers||[]).find(p=>p.type === (t.id==='grok'?'cursor':t.id));
    const dataPath=(t.id==='cursor' && provider?.dbPath) || (t.id==='codex' && provider?.codexHome) || (t.activityKey && (activity[t.activityKey] || field?.suggested)) || t.agent?.dbPath || t.data?.() || t.agent?.dir || '';
    const dataFound=exists(dataPath), installed=!!(spec && available(spec));
    const model=t.id==='cursor'?cursorInfo():modelInfo(t.id,t.agent||{});
    const skill=t.home?path.join(HOME,t.home,'skills','takeover','SKILL.md'):'';
    const providerTypes=t.id==='grok'||t.id==='cursor'?['cursor']:t.id==='zcode'?['zhipu']:t.id==='claude'?['claude-oauth']:[t.id];
    const providers=(config.providers||[]).filter(p=>providerTypes.includes(p.type)).map(p=>({id:p.id,name:p.name,enabled:!!p.enabled}));
    return {id:t.id,name:t.name,configured:!!(t.agent || config.launch?.[t.id]),installed,dataPath,dataFound,
      entry:spec?(spec.command||spec.target||''):'',launchKind:spec?.kind||'',launchLabel:spec?.label||'',
      launchAvailable:installed,webFallback:!!spec?.webFallback,activityKey:t.activityKey||'',
      model:model?{ok:model.ok,label:model.label||model.model||'',auto:!!model.auto,error:model.error||null}:null,
      modelSupported:t.id==='cursor'||t.id==='workbuddy'||!!t.agent?.modelFile,
      modelNote:t.id==='yuanbao'||t.id==='trae'?'当前没有可靠的本地模型读取器，可配置模型状态文件':'',
      transcript:t.transcript||'',handoffReadable:!!t.transcript&&dataFound,skillInstalled:exists(skill),skillPath:skill,
      providers,preset:!t.agent&&t.preset?{...t.preset}:null,custom:!!t.agent&&!t.preset,
      process:agent?.process||'' };
  }) };
}
module.exports = { ACTIVITY_FIELDS, TOOLS, definitions, inspect };
