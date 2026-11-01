'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
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
  // 单一安装包：转接功能装的时候选（勾「启用工具转接」才部署技能），不再分 A/B 两个版本
  execFileSync(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--win', 'nsis'], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'installer-latest.js')], { cwd: root, stdio: 'inherit' });
  publish(path.join(root, 'dist/installer', `AI桌宠-Setup-${pkg.version}.exe`), 'setup.exe');
  fs.writeFileSync(path.join(out, '使用说明.txt'), `AI 桌宠 ${pkg.version}\n\n安装时可选「启用工具转接」：勾了才有交接给别的 AI 的入口，并把 handoff / takeover 技能部署到本机检测到的 AI 工具；不勾 = 仅查额度的纯享模式。\nDeepSeek API Key 用于生成台词和压缩超长会话，装的时候可填可跳过，之后都能在桌宠「设置」里改。\n\n中转站余额需要系统访问令牌＋用户 ID，不是模型 API Key。\n无需另装 Node.js。请勿把自己的配置文件或密钥发给朋友。\n`);
})().catch(e => { console.error(e); process.exitCode = 1; });
