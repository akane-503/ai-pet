'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async function smoke(ctx) {
  const checks = [];
  const report = { ok: false, version: ctx.app.getVersion(), checks };
  const timeout = setTimeout(() => { fs.writeFileSync(path.join(ctx.userData, 'smoke-report.json'), JSON.stringify({ ...report, error: 'Smoke test timed out' }, null, 2)); ctx.app.exit(1); }, 45000);
  try {
    await delay(1800);
    assert.ok(ctx.config.data.providers.every(p => !p.enabled && !p.apiKey && !p.accessToken));
    assert.equal(ctx.config.data.quips.enabled, false);
    assert.deepEqual(ctx.state.data.snapshots, {});
    checks.push('Fresh profile: no keys, enabled providers, quota history or paid quip requests');
    assert.ok(ctx.settingsWin() && !ctx.settingsWin().isDestroyed());
    assert.ok(ctx.winsnap.available());
    checks.push('First-run settings and Windows native window integration loaded');
    for (const character of ctx.CHARACTERS) {
      ctx.setAppearance({ character: character.id });
      let rendered;
      for (let attempt = 0; attempt < 30; attempt++) {
        await delay(150);
        rendered = await ctx.petWin().webContents.executeJavaScript(`(() => { const img=document.querySelector('#char-img'); const style=getComputedStyle(document.documentElement); return { loaded:img.complete && img.naturalWidth>0, image:decodeURIComponent(img.src).split('/').pop(), colors:['--line','--text','--hint'].map(k=>style.getPropertyValue(k).trim()) }; })()`);
        const expectedImage = character.id === 'deepseek' ? 'deepseek-classic.png' : character.id + '.png';
        if (rendered.loaded && rendered.image === expectedImage && JSON.stringify(rendered.colors) === JSON.stringify(character.colors)) break;
      }
      assert.ok(rendered.loaded, character.id + ' image did not load');
      assert.equal(rendered.image, character.id === 'deepseek' ? 'deepseek-classic.png' : character.id + '.png');
      assert.deepEqual(rendered.colors, character.colors);
      checks.push(character.id + ': image and three character palette colors loaded');
    }
    ctx.setAppearance({ character: 'auto' });
    ctx.config.save(); ctx.state.save();
    report.ok = true;
  } catch (error) { report.error = error.message; }
  clearTimeout(timeout);
  fs.writeFileSync(path.join(ctx.userData, 'smoke-report.json'), JSON.stringify(report, null, 2) + '\n');
  ctx.app.exit(report.ok ? 0 : 1);
};
