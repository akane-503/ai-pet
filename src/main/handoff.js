'use strict';
// 跨 AI 交接：桌宠只负责复制指令 + 打开下一个工具；交接内容由 AI 写进项目里的 HANDOFF.md
// 最近一次交接的路径记在 ~/.handoff/latest.txt（由写交接的 AI 追加），桌宠读最后一行
const fs = require('fs');
const path = require('path');
const os = require('os');

const LATEST = path.join(os.homedir(), '.handoff', 'latest.txt');
const latestWsl = () => LATEST.replace(/^([A-Za-z]):/, (_, d) => '/mnt/' + d.toLowerCase()).replace(/\\/g, '/');

// 指令必须单行：Windows Terminal 粘贴多行会弹确认框，自动回车就发不出去
// 来源工具装了 handoff 技能就只发技能命令，没装才发完整说明
// shortcut: 只查 Windows 用户目录下的技能，WSL 里的 Claude Code 视同已同步；两边不同步时再按来源细分
const SKILL_HOME = { claude: '.claude', codex: '.codex', deepseek: '.dsh', zcode: '.zcode', workbuddy: '.workbuddy', gemini: '.gemini', cursor: '.cursor' };
// 各工具调技能的写法：Codex、ZCode 输入框用 $（ZCode 粘贴 $takeover 实测能触发技能）；Gemini CLI / Cursor 没有单个技能的命令，只能用话点名；其余是斜杠命令
const skillCall = (tool, name) => (tool === 'gemini' || tool === 'cursor') ? `用 ${name} 技能` : `${tool === 'codex' || tool === 'zcode' ? '$' : '/'}${name}`;
function writePrompt(tool, home = os.homedir()) {
  const dir = SKILL_HOME[tool];
  if (dir && fs.existsSync(path.join(home, dir, 'skills', 'handoff', 'SKILL.md'))) return skillCall(tool, 'handoff');
  return `请用 handoff 技能把当前任务交接给下一个 AI。没有该技能就在项目根目录写 HANDOFF.md，依次包含：目标与验收标准、我的原话（逐字）、关键决策与否决方案、改动清单、当前状态（逐条标 [已验证]/[未验证]/[推测]）、已知问题（附报错原文）、环境与命令、下一步（精确到文件/命令）。进度以 git 和文件为准，不凭记忆。最后把 HANDOFF.md 的 Windows 绝对路径追加一行到 ${LATEST}（WSL 下为 ${latestWsl()}，用 wslpath -w 转换；目录不存在就新建）。`;
}

// 文件在目标工具打开的那个目录里就只写相对路径（回原会话的指令还带着文件名）
function shortPath(file, root) {
  const s = String(file || '');
  if (!root || !path.isAbsolute(root) || !path.isAbsolute(s)) return s;
  try {
    const rel = path.relative(root, s);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  } catch (_) { /* 跨盘等算不出相对路径 */ }
  return s;
}

// 接手指令只留一小段：技能命令 + 任务名。读哪个文件由 takeover 技能自己按任务名找
// （顺序见 skills/takeover/SKILL.md），所以指令里不塞路径；目标工具没装技能时才退回带路径的一句
function takeoverPrompt(file, meta = {}) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[[\]【】]/g, '').split(/[：:，,。；;、（(]/)[0].trim().slice(0, 24);
  // 交接文件名里通常已经是任务名（HANDOFF-修复桌宠工具切换与提醒.md）
  const named = /^HANDOFF-(.+)$/i.exec(path.basename(String(file || ''), '.md'));
  let label = clean(named && named[1]);
  if (!label) {
    const project = clean(meta.project);
    const goal = clean(meta.goal);
    label = (project && goal.toLowerCase().startsWith(project.toLowerCase()) ? goal.slice(project.length) : goal).trim() || clean(meta.session);
  }
  const skill = SKILL_HOME[meta.tool];
  if (!skill || !fs.existsSync(path.join(meta.home || os.homedir(), skill, 'skills', 'takeover', 'SKILL.md'))) return meta.incremental ? `Take over changes: ${file}` : `接手交接文件：${file}`;
  return [skillCall(meta.tool, 'takeover'), meta.incremental ? '--incremental' : '', label].filter(Boolean).join(' ');
}

// 返回 { file, at } 或 null
function latest(marker = LATEST) {
  try {
    const lines = fs.readFileSync(marker, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return null;
    // 从后往前找第一个还在的文件：被删/被移走的项目不该把整个交接卡死
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const file = line.startsWith('"') && line.endsWith('"') ? line.slice(1, -1) : line;
      if (!path.isAbsolute(file)) continue;
      try { if (!fs.statSync(file).isFile()) continue; } catch (_) { continue; }
      return { file, at: fs.statSync(marker).mtimeMs, line: i + 1, total: lines.length };
    }
    return null;
  } catch (_) { return null; }
}

// 给 WSL 里的工具用：C:\a\b → /mnt/c/a/b，\\wsl.localhost\发行版\x → /x
function toWslPath(p) {
  const s = String(p);
  const unc = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)?$/i.exec(s);
  if (unc) return (unc[1] || '\\').replace(/\\/g, '/');
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(s);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
  return s;
}

// 交接文件第一行 "# HANDOFF — <任务一句话>" 里的任务
function goalOf(file) {
  try { const m = /^#\s*HANDOFF\s*[—–-]+\s*(.+)/.exec(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); return m ? m[1].trim() : ''; } catch (_) { return ''; }
}

function isHandoffCache(root) {
  const cache = path.resolve(path.dirname(LATEST)).toLowerCase(), p = path.resolve(root).toLowerCase();
  return p === cache || p.startsWith(cache + path.sep);
}
function workspaceOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r'); const b = Buffer.alloc(16384), n = fs.readSync(fd, b, 0, b.length, 0);
    const match = /<!-- ai-pet-project:(.+?) -->/.exec(b.toString('utf8', 0, n));
    const root = match && JSON.parse(match[1]).root;
    if (typeof root === 'string' && path.isAbsolute(root) && !isHandoffCache(root) && fs.statSync(root).isDirectory()) return root;
  } catch (_) { /* legacy or moved document uses its current directory */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const dir = path.dirname(file);
  return isHandoffCache(dir) ? null : dir;
}
function placeInWorkspace(file, root) {
  if (!path.isAbsolute(root) || isHandoffCache(root) || !fs.statSync(root).isDirectory()) throw new Error('请选择实际项目文件夹，不能使用全局 .handoff 缓存');
  const original = fs.readFileSync(file, 'utf8');
  const name = (goalOf(file) || path.basename(file, '.md')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60);
  const body = original.replace(/<!-- ai-pet-project:.*? -->\r?\n/g, '').replace('项目根目录：未识别', '项目根目录：' + root);
  const text = `<!-- ai-pet-project:${JSON.stringify({ root })} -->\n`;
  const at = body.indexOf('\n');
  const content = at >= 0 ? body.slice(0, at + 1) + text + body.slice(at + 1) : body + '\n' + text;
  for (let i = 0; i < 1000; i++) {
    const target = path.join(root, `HANDOFF-${name}${i ? '-' + i : ''}.md`);
    try { fs.writeFileSync(target, content, { flag: 'wx' }); return target; }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (fs.readFileSync(target, 'utf8') === content) return target; }
  }
  throw new Error('交接文件重名过多，请选择其他项目目录');
}
module.exports = { LATEST, writePrompt, takeoverPrompt, shortPath, goalOf, latest, toWslPath, workspaceOf, placeInWorkspace };
