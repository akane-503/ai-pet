import fs from 'fs';
import path from 'path';

const pet = 'D:/01_Projects/Active/ai-pet';
const wt = {
  manager: pet,
  t020: 'D:/01_Projects/Active/ai-pet.team-worktrees/T-020',
  t021: 'D:/01_Projects/Active/ai-pet.team-worktrees/T-021',
  integration: 'D:/01_Projects/Active/ai-pet.team-worktrees/integration',
};

function read(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
function write(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s.replace(/\r?\n/g, '\n'), 'utf8');
  console.log('wrote', p, Buffer.byteLength(s, 'utf8'));
}

const mgrPrompt = `你是本仓的 Manager（管理层）。工作区必须是仓库根（含 .team/）。

先读 .team/MANAGER.md、.team/CURSOR_SESSIONS.md、.team/PROTOCOL.md、.team/BULLETIN.md，
再跑：
  node .team/tools/team.mjs status
  node .team/tools/team.mjs doctor
用中文回报板子与下一步。不要改业务代码（src/**）。

板子上应有待认领 T-020 / T-021；执行会话 cwd 分别为对应 team-worktrees。开场材料见本目录 START_HERE.md。`;

const integPrompt = `你是集成者：只做 merge/门禁/accept，不改业务功能代码。
先跑 node D:/01_Projects/Active/ai-pet/.team/tools/team.mjs status（控制面在仓根）。
有「待验收」再 integrate；冲突走 ARB。详见本目录 START_HERE.md。`;

function executorStart(id, briefPath, worktree) {
  const brief = read(briefPath);
  return `# START_HERE · Executor ${id}

> **工作目录必须是本 worktree**：\`${worktree}\`
> 控制面 CLI：\`node D:/01_Projects/Active/ai-pet/.team/tools/team.mjs\`

## 你要做的

1. 读下方「会话简报」全文（含 token）
2. \`claim\` → 只改写集 → \`submit\`
3. 不要改 .team/、不要 npm install、不要开子会话

## 一键开场（可整段复制到 Cursor Agent）

\`\`\`text
请严格按本 worktree 的 START_HERE.md 与下方会话简报执行任务 ${id}：
先 claim，只在写集内改文件并提交，再 submit。
所有 team 命令用控制面绝对路径 node D:/01_Projects/Active/ai-pet/.team/tools/team.mjs。
\`\`\`

## 会话简报（dispatch 生成）

${brief || ('（缺少 sessions/' + id + '.md — 请先在仓根 team dispatch）')}
`;
}

write(path.join(wt.manager, 'START_HERE.md'), `# START_HERE · Manager（ai-pet 根）

> 本窗口 = **Manager**。不要在这里改 src/**。

## 一键开场（复制到 Agent 输入框后发送）

\`\`\`text
${mgrPrompt}
\`\`\`

## 本机材料

| 角色 | 路径 |
|---|---|
| 分会话说明 | \`.team/CURSOR_SESSIONS.md\` |
| 模板 | \`.team/cursor-prompts/\` |
| 执行 T-020 | \`D:/01_Projects/Active/ai-pet.team-worktrees/T-020\` + \`START_HERE.md\` |
| 执行 T-021 | \`D:/01_Projects/Active/ai-pet.team-worktrees/T-021\` + \`START_HERE.md\` |
| 集成（可选） | \`D:/01_Projects/Active/ai-pet.team-worktrees/integration\` |

## 一键脚本

\`\`\`powershell
pwsh -NoProfile -File .\\scripts\\open-cursor-sessions.ps1
\`\`\`
`);

write(path.join(wt.t020, 'START_HERE.md'), executorStart('T-020', path.join(pet, '.team/local/sessions/T-020.md'), wt.t020));
write(path.join(wt.t021, 'START_HERE.md'), executorStart('T-021', path.join(pet, '.team/local/sessions/T-021.md'), wt.t021));
write(path.join(wt.integration, 'START_HERE.md'), `# START_HERE · Integration

> 可选会话。控制面仍在仓根 \`${pet}\`。

## 开场

\`\`\`text
${integPrompt}
\`\`\`
`);

const workspace = {
  folders: [
    { name: 'Manager · ai-pet', path: pet },
    { name: 'Executor · T-020', path: wt.t020 },
    { name: 'Executor · T-021', path: wt.t021 },
    { name: 'Integration', path: wt.integration },
  ],
  settings: { 'window.title': 'ai-pet team sessions' },
};
write(path.join(pet, 'ai-pet-team.code-workspace'), JSON.stringify(workspace, null, 2) + '\n');

write(path.join(pet, '.team/local/cursor-open/manager.prompt.txt'), mgrPrompt + '\n');
write(path.join(pet, '.team/local/cursor-open/integration.prompt.txt'), integPrompt + '\n');
write(path.join(pet, '.team/local/cursor-open/T-020.prompt.txt'),
  `请严格按本 worktree 的 START_HERE.md 执行任务 T-020（claim→写集→submit）。控制面：node ${pet}/.team/tools/team.mjs\n`);
write(path.join(pet, '.team/local/cursor-open/T-021.prompt.txt'),
  `请严格按本 worktree 的 START_HERE.md 执行任务 T-021（claim→写集→submit）。控制面：node ${pet}/.team/tools/team.mjs\n`);

console.log('OK materials');