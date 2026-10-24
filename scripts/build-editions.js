'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { build, Platform } = require('electron-builder');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const out = path.join(root, 'dist', 'editions');
function publish(source, target) {
  const to = path.join(out, target); fs.copyFileSync(source, to);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(to)).digest('hex');
  fs.writeFileSync(to + '.sha256', sha + '  ' + target + '\n');
  console.log(JSON.stringify({ installer: to, sha256: sha }));
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  // A follows the existing installer, preserving upgrade identity and setup.exe.
  execFileSync(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--win', 'nsis'], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'installer-latest.js')], { cwd: root, stdio: 'inherit' });
  publish(path.join(root, 'dist/installer', `AI桌宠-Setup-${pkg.version}.exe`), 'setup-A.exe');
  const built = await build({ projectDir: root, targets: Platform.WINDOWS.createTarget('nsis'), config: {
    ...pkg.build,
    appId: 'com.akane503.aipet.quota', productName: 'AI 桌宠 B', executableName: 'AI桌宠B',
    directories: { ...pkg.build.directories, output: 'dist/quota' },
    extraMetadata: { name: 'ai-pet-quota', productName: 'AI 桌宠 B', aiPetEdition: 'quota' },
    extraResources: null,
    nsis: { ...pkg.build.nsis, include: 'build/quota-installer.nsh', shortcutName: 'AI 桌宠 B', artifactName: `AI桌宠-B-Setup-${pkg.version}.exe` },
  } });
  const installer = built.find(f => f.endsWith('.exe'));
  if (!installer) throw new Error('B installer missing');
  publish(installer, 'setup-B.exe');
  fs.writeFileSync(path.join(out, '使用说明.txt'), `AI 桌宠 ${pkg.version}\n\nsetup-A.exe：完整交接版，含额度检测、工具交接和可选技能部署。\nsetup-B.exe：额度纯享试用版，无交接入口、不部署交接技能、不生成付费台词。首次打开按引导选择来源、测试后启用。\n\n两版可同时安装，配置和快捷方式独立。朋友试用建议安装 B 版。\n中转站余额需要系统访问令牌＋用户 ID，不是模型 API Key。\n无需另装 Node.js。请勿把自己的配置文件或密钥发给朋友。\n`);
})().catch(e => { console.error(e); process.exitCode = 1; });
