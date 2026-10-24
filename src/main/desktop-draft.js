'use strict';
const { execFile } = require('child_process');
const path = require('path');

// 打包后 powershell 读不了 app.asar 里的文件，脚本被 asarUnpack 解到旁边
const SCRIPT = path.join(__dirname, 'dsh-draft.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function isDsh(spec) { return !!spec && spec.kind === 'app' && /^dsh desktop\.exe$/i.test(path.basename(spec.target || '')); }

function prefillDsh({ hwnd, workspace, prompt, signal }) {
  if (process.platform !== 'win32' || !hwnd || !workspace || !prompt || signal?.aborted) return Promise.resolve({ code: 'unavailable', prefilled: false });
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
    child.stdin.end(JSON.stringify({ hwnd: String(hwnd), workspace, prompt }));
  });
}
module.exports = { isDsh, prefillDsh };
