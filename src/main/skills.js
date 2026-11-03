'use strict';
// 接手技能的部署：只写各工具用户目录下的 skills\handoff 和 skills\takeover 两个子目录，
// 不碰同一个 skills 目录里的其他技能，也不替用户创建他没用过的工具目录。
// 安装器不再拷技能，改由桌宠首启向导和「设置 → 接手与转接」按需部署。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SKILLS = ['handoff', 'takeover'];

// 支持技能的工具：id、用户目录下的文件夹、显示名。与旧安装器的工具列表保持一致。
const TOOLS = [
  { id: 'claude', dir: '.claude', name: 'Claude Code' },
  { id: 'codex', dir: '.codex', name: 'Codex' },
  { id: 'dsh', dir: '.dsh', name: 'DeepSeek Harness' },
  { id: 'gemini', dir: '.gemini', name: 'Gemini CLI' },
  { id: 'cursor', dir: '.cursor', name: 'Cursor' },
  { id: 'copilot', dir: '.copilot', name: 'GitHub Copilot' },
  { id: 'qwen', dir: '.qwen', name: 'Qwen Code' },
  { id: 'codebuddy', dir: '.codebuddy', name: 'CodeBuddy' },
  { id: 'workbuddy', dir: '.workbuddy', name: 'WorkBuddy' },
  { id: 'zcode', dir: '.zcode', name: 'ZCode' },
  { id: 'trae', dir: '.trae-cn', name: 'TRAE CN' },
  { id: 'junie', dir: '.junie', name: 'Junie' },
  { id: 'openclaw', dir: '.openclaw', name: 'OpenClaw' },
];

function homeDir(home) {
  const h = home || process.env.USERPROFILE || os.homedir();
  if (!path.isAbsolute(h)) throw new Error('技能目录必须是绝对路径');
  return h;
}
function skillsRoot(home, tool) { return path.join(home, tool.dir, 'skills'); }
function exists(p) { try { return fs.existsSync(p); } catch (_) { return false; } }
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } }
// Skills Manager 等工具用链接部署技能：内容归它管，我们不写穿链接，也不替它删
function externalManaged(root) { return SKILLS.some((name) => isLink(path.join(root, name))); }
function filesIn(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(next);
      else if (e.isFile()) out.push(next);
    }
  };
  walk('');
  return out.sort();
}
// 目标里的 SKILL.md 与随包内容一致才算最新；旧版本部署的技能会被标成可更新
function upToDate(source, root) {
  try {
    const bundled = path.join(source, 'takeover');
    const target = path.join(root, 'takeover');
    const files = filesIn(bundled);
    return files.every((f) => fs.readFileSync(path.join(bundled, f)).equals(fs.readFileSync(path.join(target, f))));
  } catch (_) { return false; }
}

function checkSource(source) {
  for (const name of SKILLS) {
    const dir = path.join(source, name);
    if (!exists(path.join(dir, 'SKILL.md'))) throw new Error(`随包技能不完整：${name}`);
  }
}

// 列出所有支持技能的工具：本机有没有这个工具、技能装了没有、是不是当前版本
function list({ home, source } = {}) {
  const h = homeDir(home);
  return TOOLS.map((tool) => {
    const root = skillsRoot(h, tool);
    const present = exists(path.join(h, tool.dir));
    const deployed = SKILLS.every((name) => exists(path.join(root, name, 'SKILL.md')));
    return { id: tool.id, name: tool.name, dir: tool.dir, path: root, present, deployed, managed: externalManaged(root), upToDate: deployed && !!source && upToDate(source, root) };
  });
}

// 只部署到明确选中、且本机确实存在的工具；返回每个工具的结果，不因一个失败中断其他
function deploy({ home, tools, source } = {}) {
  const h = homeDir(home);
  if (!source) throw new Error('缺少随包技能目录');
  checkSource(source);
  const wanted = new Set(Array.isArray(tools) ? tools : []);
  const results = [];
  for (const tool of TOOLS) {
    if (!wanted.has(tool.id)) continue;
    const root = skillsRoot(h, tool);
    if (!exists(path.join(h, tool.dir))) { results.push({ id: tool.id, name: tool.name, ok: false, error: '本机没有这个工具' }); continue; }
    if (externalManaged(root)) { results.push({ id: tool.id, name: tool.name, ok: true, skipped: true, managed: true, path: root }); continue; }
    try {
      fs.mkdirSync(root, { recursive: true });
      for (const name of SKILLS) {
        fs.cpSync(path.join(source, name), path.join(root, name), { recursive: true, force: true });
        if (!exists(path.join(root, name, 'SKILL.md'))) throw new Error('写入后找不到 SKILL.md');
      }
      results.push({ id: tool.id, name: tool.name, ok: true, path: root });
    } catch (e) { results.push({ id: tool.id, name: tool.name, ok: false, error: e.message }); }
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), results };
}

// 只删 handoff / takeover 两个技能目录，skills 目录本身和其他技能保留
function remove({ home, tools } = {}) {
  const h = homeDir(home);
  const wanted = new Set(Array.isArray(tools) ? tools : []);
  const results = [];
  for (const tool of TOOLS) {
    if (!wanted.has(tool.id)) continue;
    const root = skillsRoot(h, tool);
    if (externalManaged(root)) { results.push({ id: tool.id, name: tool.name, ok: false, managed: true, error: '由 Skills Manager 管理，请在它里面移除' }); continue; }
    try {
      for (const name of SKILLS) fs.rmSync(path.join(root, name), { recursive: true, force: true });
      results.push({ id: tool.id, name: tool.name, ok: true, path: root });
    } catch (e) { results.push({ id: tool.id, name: tool.name, ok: false, error: e.message }); }
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), results };
}

module.exports = { SKILLS, TOOLS, list, deploy, remove, skillsRoot, homeDir };
