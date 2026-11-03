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
  // 单一安装包：安装器只落盘，功能选择在桌宠首次启动的向导里（设置里随时可改），不再分版本
  execFileSync(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--win', 'nsis'], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'installer-latest.js')], { cwd: root, stdio: 'inherit' });
  publish(path.join(root, 'dist/installer', `AI-Pet-Setup-${pkg.version}.exe`), 'setup.exe');
  fs.writeFileSync(path.join(out, '使用说明.txt'), `AI 桌宠 ${pkg.version}\n\n安装时只选安装目录，不再询问功能。第一次启动会打开设置向导：\n· 要不要启用工具转接；开启后可以把 handoff / takeover 两个技能部署到本机检测到的 AI 工具\n  （例如 ~/.claude/skills、~/.codex/skills），之后可在「设置 → 接手与转接」里补装、更新或移除。\n· 额度来源（DeepSeek、Codex、中转站、GLM 等）可先跳过，之后在「设置 → 账号与额度」里连。\n· DeepSeek API Key 用于生成台词和压缩超长会话，可跳过，之后在「设置 → 外观 → 台词生成」里填。\n\n静默安装：AI-Pet-Setup-${pkg.version}.exe /S /KEY=<DeepSeek Key> /NOHANDOFF /D=<目录>\n中转站余额需要系统访问令牌＋用户 ID，不是模型 API Key。\n无需另装 Node.js。请勿把自己的配置文件或密钥发给朋友。\n`);
})().catch(e => { console.error(e); process.exitCode = 1; });
