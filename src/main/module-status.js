'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildModuleTree } = require('./module-tree');

const exec = promisify(execFile);

function cliPath() {
  const configured = process.env.TEAM_PM_CLI;
  if (configured && path.isAbsolute(configured)) return configured;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'npm', 'node_modules', 'project-team-pm', 'bin', 'team.mjs');
  }
  return '';
}

async function runStatus(root) {
  const cli = cliPath();
  if (!cli || !(await fs.stat(cli).catch(() => null))?.isFile()) {
    throw new Error('未找到 team CLI。请检查 project-team-pm 的 npm link 或 TEAM_PM_CLI。');
  }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS;
  const { stdout } = await exec(process.execPath, [cli, 'status', '--json'], {
    cwd: root, env, encoding: 'utf8', timeout: 8000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  return JSON.parse(stdout);
}

/**
 * Reads `team status --json` and returns only the project goal and module tree.
 * Org nodes, tickets and worker reports are dropped.
 */
async function readModuleProgress(directory, options = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('请输入项目的完整目录路径。');
  }
  const root = await fs.realpath(directory);
  const teamDir = await fs.stat(path.join(root, '.team')).catch(() => null);
  if (!teamDir?.isDirectory()) throw new Error('此目录没有可读取的 .team，请确认项目目录。');
  const status = await (options.run || runStatus)(root);
  if (!status || status.schemaVersion !== 1 || typeof status.repo?.root !== 'string'
    || await fs.realpath(status.repo.root) !== root) {
    throw new Error('无法读取项目状态，请确认目录使用 team 控制面后重试。');
  }
  const tree = buildModuleTree({
    goal: status.charter?.goal || status.goal || status.charter?.title || status.repo?.name,
    name: status.repo?.name,
    modules: Array.isArray(status.modules) ? status.modules : [],
  });
  return { name: status.repo.name || path.basename(root), goal: tree.goal, modules: tree.modules, moduleTree: tree.root };
}

module.exports = { readModuleProgress };
