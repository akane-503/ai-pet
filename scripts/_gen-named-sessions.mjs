import fs from 'fs';
import path from 'path';

const pet = 'D:/01_Projects/Active/ai-pet';
const sessDir = path.join(pet, '.team', 'cursor-sessions');
fs.mkdirSync(sessDir, { recursive: true });

const roles = [
  {
    key: 'manager',
    file: '01-Manager-管板.code-workspace',
    windowTitle: '【Manager】管板 · ai-pet',
    folderName: '【Manager】管板',
    folder: pet,
    job: '拆任务 / dispatch / engage / 验收；不写业务代码',
    task: '—',
  },
  {
    key: 'T-020',
    file: '02-Exec-T-020-Cursor会话地图.code-workspace',
    windowTitle: '【Exec·T-020】Cursor 会话地图',
    folderName: '【Exec·T-020】会话地图',
    folder: 'D:/01_Projects/Active/ai-pet.team-worktrees/T-020',
    job: '写 docs/cursor-sessions.md（分会话说明）',
    task: 'T-020 docs: Cursor session map for ai-pet',
  },
  {
    key: 'T-021',
    file: '03-Exec-T-021-控制面指针.code-workspace',
    windowTitle: '【Exec·T-021】控制面指针',
    folderName: '【Exec·T-021】控制面指针',
    folder: 'D:/01_Projects/Active/ai-pet.team-worktrees/T-021',
    job: '写 docs/control-plane.md（PM 指针）',
    task: 'T-021 docs: control-plane pointer',
  },
  {
    key: 'integration',
    file: '04-Integration-集成.code-workspace',
    windowTitle: '【Integration】集成验收',
    folderName: '【Integration】集成',
    folder: 'D:/01_Projects/Active/ai-pet.team-worktrees/integration',
    job: 'integrate / accept；有待验收才动手',
    task: '—',
  },
];

function writeWs(r) {
  const ws = {
    folders: [{ name: r.folderName, path: r.folder }],
    settings: {
      'window.title': r.windowTitle,
      'window.titleSeparator': ' · ',
    },
  };
  const p = path.join(sessDir, r.file);
  fs.writeFileSync(p, JSON.stringify(ws, null, 2) + '\n', 'utf8');
  return p;
}

const paths = roles.map(writeWs);

// multi-root with named folders
const multi = {
  folders: roles.map((r) => ({ name: r.folderName, path: r.folder })),
  settings: { 'window.title': '【Team】ai-pet 分会话' },
};
fs.writeFileSync(path.join(pet, 'ai-pet-team.code-workspace'), JSON.stringify(multi, null, 2) + '\n', 'utf8');

const map = [
  '# 会话一览（给你看的名字）',
  '',
  '> 每个 Cursor 窗口标题 / 侧栏根名如下。打开脚本会按这些名字开窗。',
  '',
  '| 窗口名（标题栏） | 角色 | 任务 | 干什么 | workspace 文件 |',
  '|---|---|---|---|---|',
  ...roles.map((r) => `| ${r.windowTitle} | ${r.key} | ${r.task} | ${r.job} | \`.team/cursor-sessions/${r.file}\` |`),
  '',
  '## 一键开命名窗口',
  '',
  '```powershell',
  'pwsh -NoProfile -File .\\scripts\\open-cursor-sessions.ps1 -Gui -Named',
  '```',
  '',
];
fs.writeFileSync(path.join(sessDir, 'SESSION_MAP.md'), map.join('\n'), 'utf8');
fs.writeFileSync(path.join(pet, 'SESSION_MAP.md'), map.join('\n'), 'utf8');

// START_HERE with loud names
function startHere(r, extra = '') {
  return `# ${r.windowTitle}

> **这是给你看的会话名。** 角色：\`${r.key}\`  
> 任务：${r.task}  
> 职责：${r.job}

${extra}
`;
}

const mgrExtra = `## 开场（可 @ 本文件）

\`\`\`text
你是【Manager】管板。读 .team/MANAGER.md 与 SESSION_MAP.md，跑 status/doctor，中文回报。不要改 src/**。
\`\`\`
`;
const execExtra = (id) => `## 开场

\`\`\`text
你是【Exec·${id}】。严格按本 worktree START_HERE 与 .team/local/sessions/${id}.md 执行：claim → 写集 → submit。
控制面：node D:/01_Projects/Active/ai-pet/.team/tools/team.mjs
\`\`\`

## 简报

${fs.existsSync(path.join(pet, '.team/local/sessions', id + '.md')) ? fs.readFileSync(path.join(pet, '.team/local/sessions', id + '.md'), 'utf8') : '(缺简报)'}
`;

fs.writeFileSync(path.join(pet, 'START_HERE.md'), startHere(roles[0], mgrExtra), 'utf8');
fs.writeFileSync(path.join(roles[1].folder, 'START_HERE.md'), startHere(roles[1], execExtra('T-020')), 'utf8');
fs.writeFileSync(path.join(roles[2].folder, 'START_HERE.md'), startHere(roles[2], execExtra('T-021')), 'utf8');
fs.writeFileSync(path.join(roles[3].folder, 'START_HERE.md'), startHere(roles[3], `## 开场\n\n\`\`\`text\n你是【Integration】集成验收。只 integrate/accept，不改业务代码。\n\`\`\`\n`), 'utf8');

fs.writeFileSync(path.join(sessDir, 'roles.json'), JSON.stringify(roles, null, 2) + '\n', 'utf8');
console.log('named workspaces:', paths.length);