'use strict';
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);

function canonical(p) {
  try { return fsSync.realpathSync.native(p); }
  catch { return path.resolve(p); }
}
function samePath(a, b) {
  return !!a && !!b && canonical(a) === canonical(b);
}
function insidePath(parent, child) {
  if (!parent || !child) return false;
  const relative = path.relative(canonical(parent), canonical(child));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function cliPath() {
  const configured = process.env.TEAM_PM_CLI;
  if (configured && path.isAbsolute(configured)) return configured;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'npm', 'node_modules', 'project-team-pm', 'bin', 'team.mjs');
  }
  return '';
}

async function projectLocation(directory) {
  const selected = await fs.realpath(directory);
  if (!(await fs.stat(selected)).isDirectory()) throw new Error();
  let worktrees = [];
  try {
    const { stdout } = await exec('git', [
      '--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=',
      'worktree', 'list', '--porcelain', '-z',
    ], { cwd: selected, encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true });
    worktrees = stdout.split('\0\0').filter(Boolean).map((record) => {
      const fields = record.split('\0');
      return {
        path: fields.find((field) => field.startsWith('worktree '))?.slice(9) || '',
        branch: fields.find((field) => field.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') || '',
        detached: fields.includes('detached'),
        locked: fields.some((field) => field === 'locked' || field.startsWith('locked ')),
      };
    }).filter((tree) => path.isAbsolute(tree.path));
  } catch { /* An unversioned PM workspace can still expose project status. */ }
  let current = '';
  for (const tree of worktrees) {
    tree.current = insidePath(tree.path, selected);
    if (tree.current) current = tree.path;
  }
  let root = worktrees.length && current ? worktrees[0].path : selected;
  if (!worktrees.length) {
    while (!(await fs.stat(path.join(root, '.team')).catch(() => null))?.isDirectory()) {
      const parent = path.dirname(root);
      if (parent === root) break;
      root = parent;
    }
  }
  root = await fs.realpath(root);
  if (!(await fs.stat(path.join(root, '.team')).catch(() => null))?.isDirectory()) throw new Error();
  return { root, currentRoot: current || selected, worktrees };
}

function taskAssignment(task, worktrees) {
  const assignment = task.assignment;
  const worktree = task.dispatch?.worktree || assignment?.worktree || '';
  const branch = task.dispatch?.branch || assignment?.branch || '';
  const registered = worktrees.find((tree) => samePath(tree.path, worktree));
  if (!assignment && !task.dispatched && !task.sessionId && !task.sessionName) return null;
  return {
    workerId: assignment?.workerId || '',
    sessionLabel: assignment?.sessionLabel || task.sessionName || '',
    sessionId: task.sessionId || '',
    worktree,
    branch: registered?.branch || branch,
    worktreeRegistered: !!registered,
  };
}

function taskEvidence(task) {
  const last = task.evidence?.at(-1);
  return last ? { head: last.head || '', exit: last.exit, at: last.at || '' } : null;
}

// 工作树可视化需要每棵树的落点证据：HEAD、未提交改动数和挂载其上的任务；单个树读失败不影响整体。
async function describeWorktrees(location, tickets) {
  const base = ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath='];
  await Promise.all(location.worktrees.map(async (tree) => {
    const opts = { cwd: tree.path, encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true };
    const [head, status] = await Promise.all([
      exec('git', [...base, 'rev-parse', '--short', 'HEAD'], opts).then((r) => r.stdout.trim()).catch(() => ''),
      exec('git', [...base, 'status', '--porcelain', '-z'], opts)
        .then((r) => r.stdout.split('\0').filter(Boolean).length).catch(() => -1),
    ]);
    tree.head = head;
    tree.dirty = Math.max(status, 0);
    tree.dirtyUnknown = status < 0;
    const task = tickets.find((ticket) => samePath(ticket.assignment?.worktree, tree.path));
    tree.task = task ? { id: task.id, title: task.title, status: task.status } : null;
  }));
  return location.worktrees;
}

async function readLegacyProject(location) {
  const file = path.join(location.root, '.team', 'local', 'board.json');
  if ((await fs.stat(file)).size > 2 * 1024 * 1024) throw new Error('旧版 PM 状态过大，无法显示。');
  let board;
  try { board = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { throw new Error('旧版 PM 状态无法读取。'); }
  if (!board.tasks || typeof board.tasks !== 'object' || Array.isArray(board.tasks)) throw new Error('旧版 PM 任务数据格式无效。');
  const states = { 待认领: 'open', 进行中: 'working', 待验收: 'ready', 已集成: 'ready',
    已完成: 'done', 关闭: 'ended', 阻塞: 'blocked', 等人: 'waiting', 待仲裁: 'blocked', 驳回: 'blocked' };
  const tasks = Object.entries(board.tasks).filter(([, task]) => task && typeof task === 'object')
    .map(([id, task]) => ({ ...task, id: task.id || id }));
  const modules = [...new Set(tasks.map((task) => task.module || '未归属模块'))];
  return {
    ...location,
    compatibility: 'legacy',
    name: board.project || path.basename(location.root),
    org: [
      { id: 'pm', title: board.project || '项目', role: 'L1_pm', parentId: null },
      ...modules.map((name) => ({ id: 'module:' + name, title: name, role: 'L2_workstream', parentId: 'pm' })),
    ],
    tickets: tasks.map((task) => ({
      id: task.id, title: task.title, status: states[task.status] || 'unknown', rawStatus: task.status || '',
      nodeId: 'module:' + (task.module || '未归属模块'),
      assignment: taskAssignment(task, location.worktrees),
      evidence: taskEvidence(task),
      summary: task.blockedReason || '',
      lease: task.claim ? { expiresAt: task.claim.expiresAt, active: Number(task.claim.expiresAt) > Date.now() } : null,
    })),
    attention: tasks.filter((task) => ['阻塞', '等人', '待仲裁'].includes(task.status))
      .map((task) => ({ id: task.id, kind: 'legacy-attention', summary: task.blockedReason || task.title })),
    engagements: [],
  };
}

async function readProjectStatus(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('请输入项目的完整目录路径。');
  }
  let location;
  try {
    location = await projectLocation(directory);
  } catch {
    throw new Error('此目录没有可读取的 .team，请确认项目目录。');
  }
  const { root } = location;
  const legacy = await fs.stat(path.join(root, '.team', 'local', 'board.json')).catch(() => null);
  const current = await fs.stat(path.join(root, '.team', 'board.json')).catch(() => null);
  if (legacy?.isFile() && !current?.isFile()) {
    const view = await readLegacyProject(location);
    await describeWorktrees(view, view.tickets);
    return view;
  }
  const cli = cliPath();
  if (!cli || !(await fs.stat(cli).catch(() => null))?.isFile()) {
    throw new Error('未找到 team CLI。请检查 project-team-pm 的 npm link 或 TEAM_PM_CLI。');
  }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS;
  async function read(args) {
    const { stdout } = await exec(process.execPath, [cli, ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 8000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    return JSON.parse(stdout);
  }
  let status;
  let list;
  try {
    status = await read(['status', '--json']);
    if (status.schemaVersion !== 1 || typeof status.repo?.root !== 'string'
      || !samePath(status.repo.root, root)
      || !Array.isArray(status.personQueue) || !Array.isArray(status.engagements)) throw new Error();
    list = await read(['ticket', 'list']);
    if (!Array.isArray(list.tickets)) throw new Error();
  } catch {
    throw new Error('无法读取项目状态，请确认目录使用新版 team 控制面后重试。');
  }
  const view = {
    ...location,
    name: status.charter?.title || status.repo.name || path.basename(root),
    org: (status.org || []).map(({ id, title, role, parentId, state, blocker, sessionLabel }) => ({ id, title, role, parentId, state, blocker: blocker || null, sessionLabel: sessionLabel || '' })),
    tickets: list.tickets.map((task) => ({
      id: task.id, title: task.title, status: task.status, nodeId: task.nodeId || null,
      assignment: taskAssignment(task, location.worktrees),
      evidence: taskEvidence(task),
      summary: task.reports?.at(-1)?.summary || '',
    })),
    attention: status.personQueue.map(({ id, kind, summary, waitingOn }) => ({ id, kind, summary, waitingOn })),
    engagements: status.engagements
      .filter(({ state }) => ['out', 'in_progress', 'delivered'].includes(state))
      .map(({ id, title, host, state, returnedAt }) => ({ id, title, host, state, returnedAt })),
  };
  await describeWorktrees(view, view.tickets);
  return view;
}

module.exports = { readProjectStatus };
