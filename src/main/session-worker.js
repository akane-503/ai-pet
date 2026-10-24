// 在 utilityProcess 里扫会话：WSL 下的 Claude 记录一次要几百 ms，放主进程会卡住拖动、右键和窗口响应
const handoffApi = require('./handoff-api');
function scan({ kind, dirs, title }) {
  let list = [];
  try { list = handoffApi.recentSessions(kind, dirs, 8); } catch (_) { /* 读不到就不列 */ }
  // 自动挑的是哪个会话直接写出来：跟真正交接时同一个 newestTranscript 规则
  let auto = '';
  if (list.length >= 2) {
    try { const file = handoffApi.newestTranscript(kind, dirs, title); auto = file ? ((list.find((s) => s.file === file) || handoffApi.threadLabel(kind, file, dirs[0])).name || '') : ''; } catch (_) { /* 识别不了就不写名字 */ }
  }
  return { kind, list, auto };
}
if (process.parentPort) process.parentPort.on('message', (e) => process.parentPort.postMessage({ key: e.data.key, ...scan(e.data) }));
module.exports = { scan };
