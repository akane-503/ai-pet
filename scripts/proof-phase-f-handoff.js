'use strict';
/**
 * AIPET_DEBUG_SCRIPT — 在真实桌宠进程内触发外部交接并截图。
 * main.js 对 DEBUG 脚本不 await Promise，故导出同步函数 + 内部 IIFE。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const handoffExternal = require('../src/main/handoff-external');
const handoff = require('../src/main/handoff');

module.exports = function proofPhaseF(api) {
  (async () => {
    const out =
      process.env.AIPET_PROOF_OUT ||
      path.join(api.ROOT, 'proof-aipet-live-handoff.png');
    const metaPath = out.replace(/\.png$/i, '-meta.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });

    const meta = {
      pid: process.pid,
      ppid: process.ppid,
      out,
      startedAt: new Date().toISOString(),
      root: api.ROOT,
      packaged: !!api.app.isPackaged,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    api.log('proof meta', metaPath, 'pid', process.pid);

    // wait until pet window exists
    let win = null;
    for (let i = 0; i < 40; i++) {
      win = api.petWin();
      if (win && !win.isDestroyed()) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!win || win.isDestroyed()) throw new Error('pet window missing after wait');

    api.setPetVisible(true);
    await new Promise((r) => setTimeout(r, 500));

    // Write external handoff AFTER startup baseline so pollExternalHandoff fires
    const cache = path.join(os.homedir(), '.handoff', 'cache');
    fs.mkdirSync(cache, { recursive: true });
    const file = path.join(cache, 'HANDOFF-phase-f-aipet-live.md');
    fs.writeFileSync(
      file,
      [
        '# HANDOFF — Phase F 桌宠进程内证据',
        `<!-- ai-pet-project:${JSON.stringify({ root: api.ROOT })} -->`,
        '',
        '由真实 ai-pet 进程（AIPET_DEBUG_SCRIPT）写入 ~/.handoff/latest.txt 触发。',
        `pid=${process.pid}`,
        '',
      ].join('\n'),
      'utf8',
    );
    fs.appendFileSync(path.join(os.homedir(), '.handoff', 'latest.txt'), `${file}\n`, 'utf8');
    api.log('proof wrote latest', file);

    // Wait for 2s poll + a little slack
    await new Promise((r) => setTimeout(r, 3500));

    // Force visible handoff bubble in-process (same view shape as announceExternalHandoff)
    const latest = { file, at: fs.statSync(path.join(os.homedir(), '.handoff', 'latest.txt')).mtimeMs };
    const view = handoffExternal.viewFromLatest(latest, handoff.goalOf);
    api.setPetVisible(true);
    api.sendPet('handoff', view);
    await new Promise((r) => setTimeout(r, 800));

    // Capture pet BrowserWindow (in-process UI)
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    api.log('proof captured petWin', out, fs.statSync(out).size);

    // Optional screen crop around pet bounds
    if (typeof api.shot === 'function') {
      const b = win.getBounds();
      const crop = out.replace(/\.png$/i, '-screen-crop.png');
      try {
        const pad = 40;
        await api.shot(crop, Math.max(0, b.x - pad), Math.max(0, b.y - pad), b.width + pad * 2, b.height + pad * 2);
        // shot() writes under ROOT — move/copy if needed
        const rooted = path.isAbsolute(crop) ? crop : path.join(api.ROOT, crop);
        if (fs.existsSync(rooted) && path.resolve(rooted) !== path.resolve(crop)) {
          fs.copyFileSync(rooted, crop);
        }
        meta.screenCrop = crop;
        api.log('proof screen crop', crop);
      } catch (e) {
        meta.screenCropError = e.message;
        api.log('crop failed', e.message);
      }
    }

    meta.finishedAt = new Date().toISOString();
    meta.bytes = fs.statSync(out).size;
    meta.handoffFile = file;
    meta.viewHeading = view.heading;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

    setTimeout(() => api.app.quit(), 800);
  })().catch((e) => {
    try {
      api.log('proof FAILED', e && e.stack ? e.stack : e);
      const failOut =
        process.env.AIPET_PROOF_OUT ||
        path.join(api.ROOT, 'proof-aipet-live-handoff.png');
      fs.writeFileSync(
        failOut.replace(/\.png$/i, '-meta.json'),
        JSON.stringify({ ok: false, error: String(e && e.stack ? e.stack : e), pid: process.pid }, null, 2),
      );
    } catch (_) { /* ignore */ }
    try { api.app.quit(); } catch (_) { /* ignore */ }
  });
};
