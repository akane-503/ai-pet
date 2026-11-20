'use strict';
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 打包后 powershell 读不了 app.asar 里的文件，脚本被 asarUnpack 解到旁边
const SCRIPT = path.join(__dirname, 'dsh-draft.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function isDsh(spec) { return !!spec && spec.kind === 'app' && /^dsh (?:desktop|next)\.exe$/i.test(path.basename(spec.target || '')); }

function registeredWorkspace(workspace, home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8').replace(/^\uFEFF/, ''));
    const rows = Object.values(data.tables?.workspaces || {});
    const key = value => path.resolve(value).toLowerCase();
    const matches = rows.filter(row => typeof row.path === 'string' && key(row.path) === key(workspace));
    if (matches.length !== 1 || !matches[0].title || rows.filter(row => row.title === matches[0].title).length !== 1) return null;
    return { title: matches[0].title };
  } catch (_) { return null; }
}

function prefillDsh({ hwnd, workspace, prompt, signal, spec }) {
  if (process.platform !== 'win32' || !hwnd || !workspace || !prompt || signal?.aborted) return Promise.resolve({ code: 'unavailable', prefilled: false });
  const next = !!spec && /^dsh next\.exe$/i.test(path.basename(spec.target || ''));
  const registered = next ? registeredWorkspace(workspace) : null;
  if (next && !registered) return Promise.resolve({ code: 'workspace-unregistered', prefilled: false, workspaceVerified: false });
  return new Promise((resolve) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      windowsHide: true, encoding: 'utf8', timeout: 14000, maxBuffer: 64 * 1024, signal,
    }, (err, stdout) => {
      if (err) { resolve({ code: signal?.aborted ? 'cancelled' : 'unavailable', prefilled: false }); return; }
      try {
        const value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
        const code = String(value.code || 'unavailable'), workspaceVerified = value.workspaceVerified === true;
        resolve({ code, prefilled: value.prefilled === true && workspaceVerified && ['prefilled', 'already-filled'].includes(code), workspaceVerified });
      } catch (_) { resolve({ code: 'invalid-response', prefilled: false }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ hwnd: String(hwnd), workspace, prompt, next, workspaceTitle: registered?.title }));
  });
}
module.exports = { isDsh, prefillDsh, registeredWorkspace };
