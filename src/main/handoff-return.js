'use strict';
// Only retain local session references, never transcript contents or credentials.
const fs = require('fs');
const path = require('path');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
// Launch-time syntax differs from an in-session slash command. Never resume "last".
const CLI_RESUME = { claude: { command: /^claude(?:\.exe|\.cmd)?$/i, flag: '--resume' }, codex: { command: /^codex(?:\.exe|\.cmd)?$/i, flag: 'resume' } };
function cliResume(tool, spec, session) {
  const policy = CLI_RESUME[tool];
  if (!policy || !/^(?:wsl-)?cli$/.test(spec?.kind || '') || !policy.command.test(spec.command || '') || session?.tool !== tool || !UUID.test(session.id || '')) return '';
  return spec.command + ' ' + policy.flag + ' ' + session.id;
}

function sessionOf(tool, transcript, spec) {
  if (!['codex', 'claude'].includes(tool) || !transcript || !spec) return null;
  let fd;
  try {
    fd = fs.openSync(transcript, 'r');
    const b = Buffer.alloc(128 * 1024), n = fs.readSync(fd, b, 0, b.length, 0);
    for (const line of b.toString('utf8', 0, n).split('\n')) {
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      const id = tool === 'codex' ? (o.type === 'session_meta' && o.payload?.id) : o.sessionId;
      const cwd = tool === 'codex' ? o.payload?.cwd : o.cwd;
      if (!UUID.test(id || '') || !cwd) continue;
      if (tool === 'codex' && !(spec.kind === 'store' && /^OpenAI\.Codex_[^!]+!App$/i.test(spec.target || '')) && !cliResume(tool, spec, { tool, id })) return null;
      if (tool === 'claude' && !cliResume(tool, spec, { tool, id })) return null;
      const unc = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/i.exec(transcript);
      if (/cli$/.test(spec.kind) && (!!unc !== (spec.kind === 'wsl-cli') || (unc && spec.distro && unc[1] !== spec.distro))) return null;
      return { tool, id, transcript, cwd, spec: { kind: spec.kind, label: spec.label, target: spec.target, command: spec.command, distro: spec.distro } };
    }
  } catch (_) { /* missing/unreadable session: use a new conversation */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}
function remember(rows, workspace, source, target, now = Date.now()) {
  if (!source || !path.isAbsolute(workspace)) return rows || [];
  const project = key(workspace);
  const boundProject = source.projectRoot && key(source.projectRoot) === project;
  let cwd = source.cwd.replace(/^\\\\\?\\/, '');
  if (source.spec.kind === 'wsl-cli' && cwd.startsWith('/')) {
    const drive = /^\/mnt\/([a-z])\/(.*)$/i.exec(cwd);
    cwd = drive ? drive[1] + ':\\' + drive[2].replace(/\//g, '\\') : '\\\\wsl.localhost\\' + source.spec.distro + cwd.replace(/\//g, '\\');
  }
  if (!boundProject && key(cwd) !== project && !key(cwd).startsWith(project + path.sep)) return rows || [];
  return [{ ...source, project, to: target, at: now }, ...(Array.isArray(rows) ? rows : []).filter(r => !(r.project === project && r.tool === source.tool))].slice(0, 40);
}
function find(rows, workspace, target, from, spec) {
  if (!from || from === target) return null;
  const r = (Array.isArray(rows) ? rows : []).find(r => r.project === key(workspace) && r.tool === target && r.to === from);
  if (!r || r.spec?.kind !== spec.kind || (spec.kind === 'wsl-cli' && (r.spec.distro || '') !== (spec.distro || ''))) return null;
  const checked = sessionOf(target, r.transcript, spec);
  return checked && checked.id === r.id && checked.cwd === r.cwd ? checked : null;
}
function prompt(file, meta = {}) {
  return require('./handoff').takeoverPrompt(file, { ...meta, incremental: true });
}
module.exports = { sessionOf, remember, find, prompt, UUID, cliResume };
