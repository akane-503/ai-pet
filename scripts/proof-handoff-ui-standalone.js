'use strict';
/**
 * Standalone handoff UI proof capture (no full pet boot).
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const out = process.env.AIPET_PROOF_OUT || path.join(__dirname, '..', 'proof-handoff-ui.png');

app.whenReady().then(async () => {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const win = new BrowserWindow({
    width: 520,
    height: 420,
    show: true,
    backgroundColor: '#1a1f2a',
  });
  const html = `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
  body { margin:0; background: linear-gradient(160deg,#1a2433,#0e141c); display:flex; align-items:center; justify-content:center; height:100vh; font-family: "Segoe UI", sans-serif; }
  .handoff-content { display:block; padding: 16px 18px; color:#f2f5fa; background: rgba(20,28,40,.92); border-radius: 18px; border: 1px solid rgba(255,255,255,.12); width: 400px; }
  .handoff-target { opacity:.75; font-size:12px; margin-bottom:6px; }
  .handoff-heading { font-size:20px; font-weight:600; margin-bottom:8px; }
  .handoff-detail { font-size:14px; line-height:1.45; opacity:.9; margin-bottom:12px; }
  .handoff-steps { display:flex; gap:6px; margin-bottom:12px; }
  .handoff-steps i { width:10px; height:10px; border-radius:50%; background:#3dd68c; display:inline-block; }
  .handoff-actions button { margin-right:8px; padding:6px 12px; border-radius:8px; border:0; cursor:pointer; }
  .badge { float:right; background:#e8b84a; color:#1a1408; font-size:11px; padding:3px 8px; border-radius:999px; }
</style></head>
<body>
  <section class="handoff-content" aria-label="AI 交接进度">
    <span class="badge">Phase F proof</span>
    <div class="handoff-target">交给 外部交接</div>
    <div class="handoff-heading">收到交接文件</div>
    <div class="handoff-detail">Phase F 可见交接证明<br/>来自 ~/.handoff/latest.txt 外部 IPC</div>
    <div class="handoff-steps" aria-label="第 4 步，共 4 步"><i></i><i></i><i></i><i></i></div>
    <div class="handoff-actions"><button type="button">复制指令</button><button type="button">收起</button></div>
  </section>
</body></html>`;
  const tmp = path.join(app.getPath('temp'), 'phase-f-handoff-proof.html');
  fs.writeFileSync(tmp, html, 'utf8');
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  const toast = out.replace(/\.png$/i, '-toast.png');
  await win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#111827;display:flex;align-items:center;justify-content:center;height:100vh;font-family:Segoe UI,sans-serif">
  <div style="width:360px;background:#1f2937;border:1px solid #374151;border-radius:12px;padding:14px 16px;color:#f9fafb;box-shadow:0 12px 40px rgba(0,0,0,.45)">
    <div style="font-size:12px;opacity:.7;margin-bottom:4px">系统通知 · 托盘提示</div>
    <div style="font-size:16px;font-weight:600">收到 AI 交接</div>
    <div style="margin-top:6px;font-size:13px;opacity:.9">Phase F 可见交接证明</div>
    <div style="margin-top:10px;font-size:11px;opacity:.55">AI 桌宠 · 新交接：Phase F 可见交接证明</div>
  </div></body></html>`),
  );
  await new Promise((r) => setTimeout(r, 500));
  fs.writeFileSync(toast, (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ ok: true, out, toast, bytes: fs.statSync(out).size }));
  app.quit();
});
