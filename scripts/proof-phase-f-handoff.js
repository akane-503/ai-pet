'use strict';
/**
 * AIPET_DEBUG_SCRIPT: write external handoff → wait for poll → capture pet bubble.
 * Usage (from ai-pet root):
 *   $env:AIPET_PROOF_OUT=".../media/phase-f-handoff-ui.png"
 *   $env:AIPET_DEBUG_SCRIPT=(Resolve-Path .\scripts\proof-phase-f-handoff.js)
 *   npx electron . --user-data-dir=...\tmp-proof
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = async function proofPhaseF(api) {
  const out = process.env.AIPET_PROOF_OUT || path.join(api.ROOT, 'proof-handoff-ui.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const cache = path.join(os.homedir(), '.handoff', 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const file = path.join(cache, 'HANDOFF-phase-f-proof.md');
  fs.writeFileSync(
    file,
    `# HANDOFF — Phase F 可见交接证明\n\n<!-- ai-pet-project:${JSON.stringify({ root: api.ROOT })} -->\n\nproject-team-pm live IPC → 桌宠弹窗/托盘。\n`,
    'utf8',
  );
  fs.appendFileSync(path.join(os.homedir(), '.handoff', 'latest.txt'), `${file}\n`, 'utf8');
  api.log('proof wrote', file);

  // wait for pet ready + external poll (2s interval)
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const win = api.petWin();
    if (win && !win.isDestroyed()) break;
  }
  await new Promise((r) => setTimeout(r, 2800));

  const win = api.petWin();
  if (!win || win.isDestroyed()) throw new Error('pet window missing');
  api.setPetVisible(true);
  // Force show handoff bubble if poll already fired; re-emit via ipc if needed
  await new Promise((r) => setTimeout(r, 400));
  await api.capture(win, out);
  api.log('proof captured', out);

  // Also capture a crop around the pet if shot helper exists
  if (typeof api.shot === 'function') {
    const b = win.getBounds();
    const crop = out.replace(/\.png$/i, '-crop.png');
    try {
      await api.shot(crop, b.x, b.y, b.width, b.height);
      api.log('proof crop', crop);
    } catch (e) {
      api.log('crop failed', e.message);
    }
  }

  setTimeout(() => api.app.quit(), 500);
};
