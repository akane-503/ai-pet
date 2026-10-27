'use strict';
// API 交接：桌宠自己读来源 AI 的本地对话记录（Claude / Codex），交给 DeepSeek 整理成 HANDOFF.md，不耗来源工具额度
// 用户原话由程序逐字抄写，模型只整理其余部分；模型看不到代码，状态由接手 AI 核对
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { LATEST } = require('./handoff');
const cursorModel = require('./cursor-model');

// 角色 → 记录格式；deepseek 角色也包括网页版，run 里再用窗口标题确认是 DSH
const KINDS = { claude: 'claude', codex: 'codex', workbuddy: 'workbuddy', zcode: 'zcode', cursor: 'cursor', deepseek: 'dsh' };
const DIGEST_CHARS = 60000;

function jsonlFiles(dir, depth, out = [], ext = '.jsonl') {
  let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) jsonlFiles(p, depth - 1, out, ext); } else if (e.name.endsWith(ext)) { const st = fs.statSync(p); out.push({ p, m: st.mtimeMs, size: st.size }); }
  }
  return out;
}

// 会话标题（Claude Code 会把它写进终端窗口标题）
// 会话文件常有几 MB（WSL 路径上更慢），右键每次整读会卡住主进程：按文件大小缓存，只读新追加的部分
const titleCache = new Map();
function aiTitle(file) {
  try {
    const size = fs.statSync(file).size, c = titleCache.get(file);
    if (c && c.size === size) return c.title;
    const from = c && c.size < size ? Math.max(0, c.size - 4096) : 0; // 留一段重叠，防标题行被上次读取切开
    const fd = fs.openSync(file, 'r'), b = Buffer.alloc(size - from);
    try { fs.readSync(fd, b, 0, b.length, from); } finally { fs.closeSync(fd); }
    const m = [...b.toString('utf8').matchAll(/"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g)].pop();
    const title = m ? JSON.parse(`"${m[1]}"`) : (from ? c.title : '');
    titleCache.set(file, { size, title });
    return title;
  } catch (_) { return ''; }
}

// Codex 会话索引在 state_5.sqlite 的 threads 表（rollout_path 指向完整 jsonl）；按文件 mtime 猜会挑到别的会话
// shortcut: 窗口标题不带会话名，只能取最近更新的未归档会话，同时开多个 Codex 会话时可能取错
function codexThread(dir) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'), { readOnly: true });
  try { return db.prepare('select rollout_path p, name, title from threads where archived = 0 order by updated_at_ms desc limit 1').get() || null; } finally { db.close(); }
}

// 来源窗口刚在前台，取最近写过的会话；同时开着几个时，用窗口标题对上会话标题
function newestTranscript(kind, dirs, winTitle = '') {
  // Cursor：窗口标题能对上项目就用那个 composer，否则用当前选中的，最后才取最近更新的
  if (kind === 'cursor') {
    const list = cursorSessions(cursorDb(dirs), 12).filter((s) => s.users > 0);
    if (!list.length) return null;
    const title = String(winTitle || '').toLowerCase();
    const matching = title ? list.filter((s) => s.project && title.includes(s.project.toLowerCase())) : [];
    return (matching.find(s => s.current) || matching[0] || list.find((s) => s.current) || list[0]).ref;
  }
  if (kind === 'codex') {
    for (const d of dirs) { try { const t = codexThread(d); const p = t && t.p.replace(/^\\\\\?\\/, ''); if (p && fs.existsSync(p)) return p; } catch (_) { /* 旧版没有这个库 */ } }
  }
  // DSH 打开工作区会先建空会话，跳过还没发过消息的
  if (kind === 'dsh') return (dirs.flatMap((d) => jsonlFiles(path.join(d, 'sessions'), 2, [], '.jsonl.zstd')).sort((a, b) => b.m - a.m).slice(0, 10).find((f) => {
    try { return parseTranscript(readTranscript(f.p), 'dsh').user.length > 0; } catch (_) { return false; }
  }) || {}).p || null;
  // ZCode 默认用「你最近敲过字的那个会话」，而不是最近被后台刷新过的那个
  if (kind === 'zcode') {
    const list = zcodeSessions(dirs, 20);
    const active = zcodeActiveId(dirs);
    return ((active && list.find((s) => s.p.endsWith('#' + active))) || list[0] || {}).p || null;
  }
  // WorkBuddy：~/.workbuddy/projects/<编码后的工作区>/<sessionId>.jsonl；同样跳过还没有用户发言的
  if (kind === 'workbuddy') return (dirs.flatMap((d) => jsonlFiles(path.join(d, 'projects'), 2)).sort((a, b) => b.m - a.m).slice(0, 10)
    .find((f) => { try { return readTranscript(f.p).includes('"role":"user"'); } catch (_) { return false; } }) || {}).p || null;
  const all = dirs.flatMap((d) => kind === 'codex' ? jsonlFiles(path.join(d, 'sessions'), 3) : jsonlFiles(path.join(d, 'projects'), 1)).sort((a, b) => b.m - a.m);
  const recent = all.slice(0, 5).filter((f) => f.m > Date.now() - 24 * 3600e3);
  const norm = (t) => String(t).replace(/\s+/g, '');
  const byTitle = winTitle && kind === 'claude' && recent.find((f) => { const t = norm(aiTitle(f.p)).slice(0, 12); return t && norm(winTitle).includes(t); });
  return (byTitle || all[0] || {}).p || null;
}

const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && (x.type === 'text' || x.type === 'input_text' || x.type === 'output_text')).map((x) => x.text).join('\n') : '';
// 系统注入、技能正文、交接指令本身都不是用户原话
// 除了明显的脚手架文本，还要挡掉宿主注入（runtime-context / time-context 等），它们不是用户说的话
const isNoise = (t) => !t.trim() || /^\s*(<|# AGENTS\.md|Base directory for this skill|\[Request interrupted|Current runtime context\.|Time sampled while preparing turn|You are an AI agent powered by|background job |The TodoWrite tool hasn't been used recently|Available agent types for the Agent tool)/.test(t) || /^我要把当前任务交接给另一个 AI/.test(t.trim());
// DSH 的 user/message 里混有 runtime-context、skill-catalog、time-context 等宿主注入，
// 它们同样 role=user 却不是用户原话；只有 source.kind === 'user' 才是人打的字。
// 没有 source 字段的旧格式/测试数据保持放行，交由 isNoise 兜底。
const fromHuman = (d) => !d.source || d.source.kind === 'user';

// ZCode（智谱的 IDE/CLI）把会话存在 sqlite 里：session / message / part 三张表，
// message.data 是 {role}，part.data 是 {type:'text'|'tool'…}。这里把一次会话渲染成 jsonl 文本，
// 让上面的解析器照常处理；合成路径形如 zcode:<db 路径>#<sessionId>。
const ZCODE = 'zcode:';
function zcodeDb(dir) {
  for (const c of [path.join(dir, 'cli', 'db', 'db.sqlite'), path.join(dir, 'db', 'db.sqlite')]) { try { if (fs.existsSync(c)) return c; } catch (_) { /* */ } }
  return null;
}
function zcodeOpen(file) {
  const { DatabaseSync } = require('node:sqlite');
  const s = String(file).slice(ZCODE.length);
  const i = s.lastIndexOf('#');
  return new DatabaseSync(s.slice(0, i), { readOnly: true });
}
function zcodeSessions(dirs, n) {
  const { DatabaseSync } = require('node:sqlite');
  const out = [];
  for (const d of dirs) {
    const db = zcodeDb(d); if (!db) continue;
    let sqlite; try { sqlite = new DatabaseSync(db, { readOnly: true }); } catch (_) { continue; }
    try {
      for (const r of sqlite.prepare("select id, title, directory, time_updated from session where time_deleted is null and (task_type is null or task_type = 'interactive') order by time_updated desc limit ?").all(n)) {
        out.push({ p: `${ZCODE}${db}#${r.id}`, m: r.time_updated, size: 0, name: r.title || '', dir: r.directory || '' });
      }
    } catch (_) { /* 老版本没这些列 */ } finally { sqlite.close(); }
  }
  return out.sort((a, b) => b.m - a.m).slice(0, n);
}

// ZCode 没有「当前打开的会话」这种字段，但 input_history 的最后一条就是用户最近敲过字的会话，
// 比 session.time_updated（后台压缩也会刷新）更接近「我正在看的那个」
function zcodeActiveId(dirs) {
  const { DatabaseSync } = require('node:sqlite');
  for (const d of dirs || []) {
    const db = zcodeDb(d); if (!db) continue;
    let sqlite; try { sqlite = new DatabaseSync(db, { readOnly: true }); } catch (_) { continue; }
    try {
      const r = sqlite.prepare('select session_id from input_history order by time_created desc limit 1').get();
      if (r && r.session_id) return r.session_id;
    } catch (_) { /* 表不存在就算了 */ } finally { sqlite.close(); }
  }
  return '';
}
function zcodeText(file) {
  const id = String(file).slice(String(file).lastIndexOf('#') + 1);
  const sqlite = zcodeOpen(file);
  try {
    const s = sqlite.prepare('select title, directory, time_created from session where id = ?').get(id) || {};
    const lines = [{ type: 'ai-title', aiTitle: s.title || '', cwd: s.directory || '' }];
    const byMsg = new Map();
    for (const p of sqlite.prepare('select message_id, data from part where session_id = ? order by sequence, time_created').all(id)) {
      let d; try { d = JSON.parse(p.data); } catch (_) { continue; }
      if (!byMsg.has(p.message_id)) byMsg.set(p.message_id, []);
      byMsg.get(p.message_id).push(d);
    }
    for (const m of sqlite.prepare('select id, data from message where session_id = ? order by time_created, rowid').all(id)) {
      let role = 'user'; try { role = JSON.parse(m.data).role || 'user'; } catch (_) { continue; }
      const content = [];
      for (const p of byMsg.get(m.id) || []) {
        if (p.type === 'text' && p.text) content.push({ type: role === 'user' ? 'input_text' : 'output_text', text: p.text });
        else if (p.type === 'tool') content.push({ type: 'function_call', name: p.tool || 'tool', arguments: JSON.stringify((p.state && p.state.input) || {}) });
      }
      if (!content.length) continue;
      lines.push({ type: 'message', role: role === 'assistant' ? 'assistant' : 'user', content });
    }
    return lines.map((l) => JSON.stringify(l)).join('\n');
  } finally { sqlite.close(); }
}

// Cursor 把会话写在本机 state.vscdb：composerData:<id> 是会话索引，bubbleId:<composerId>:<bubbleId>
// 是单条消息。这里把一次 composer 合成 cursor:<db>#<id>，复用前面的解析/整理流程。
// 聊天正文在部分旧会话里已经不在本地（只剩 textPreview），所以用户原话只认完整气泡，缺了就跳过。
const CURSOR = 'cursor:';
const CURSOR_DB = cursorModel.DEFAULT_DB;
// Cursor 的 Plan / 后台任务会以 user 身份插话，这些不是人打的字
const CURSOR_NOISE = /^(Implement the plan as specified\b|To-do's from the plan have already been created\b|Start multitasking\b)/i;
function cursorDb(dirs) {
  for (const d of dirs || []) {
    const s = String(d || ''); if (!s) continue;
    if (/\.vscdb$/i.test(s)) { if (fs.existsSync(s)) return s; continue; }
    const p = path.join(s, 'state.vscdb'); if (fs.existsSync(p)) return p;
  }
  return CURSOR_DB;
}
function cursorOpen(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}
function cursorRef(db, id) { return `${CURSOR}${db}#${id}`; }
function parseCursorRef(file) {
  const s = String(file).slice(CURSOR.length);
  const i = s.lastIndexOf('#');
  return { db: s.slice(0, i), id: s.slice(i + 1) };
}
function cursorComposer(q, id) {
  try { const r = q.prepare('select value from cursorDiskKV where key = ?').get('composerData:' + id); return r ? JSON.parse(String(r.value)) : null; } catch (_) { return null; }
}
function cursorWorkspace(d) {
  const w = d && d.workspaceIdentifier; if (!w) return '';
  const u = w.uri || w;
  const p = u.fsPath || w.fsPath || '';
  return p ? String(p).replace(/^\\\\\?\\/, '') : '';
}
function cursorBubbles(q, id) {
  const map = new Map();
  try {
    for (const r of q.prepare('select key, value from cursorDiskKV where key like ?').all('bubbleId:' + id + ':%')) {
      const key = String(r.key); const bid = key.slice(key.lastIndexOf(':') + 1);
      try { map.set(bid, JSON.parse(String(r.value))); } catch (_) { /* skip */ }
    }
  } catch (_) { /* 旧版没有气泡表 */ }
  return map;
}
function cursorSelectedId(q) {
  try { const r = q.prepare("select value from ItemTable where key = 'cursor/glass.selectedAgent'").get(); return r && r.value ? String(r.value).trim() : ''; } catch (_) { return ''; }
}
function cursorSessions(dbPath, n = 8) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  let q = null;
  try { q = cursorOpen(dbPath); } catch (_) { return []; }
  try {
    let rows = [];
    try {
      rows = q.prepare("select composerId, recency from composerHeaders where isArchived = 0 and isSubagent = 0 and composerId <> 'empty-state-draft' order by recency desc limit ?").all(Math.max(1, n));
    } catch (_) { /* 旧版没有索引表 */ }
    if (!rows.length) {
      try {
        rows = q.prepare("select key, value from cursorDiskKV where key like 'composerData:%'").all()
          .map((r) => { try { const d = JSON.parse(String(r.value)); return { composerId: String(r.key).slice('composerData:'.length), recency: Number(d.lastUpdatedAt || d.createdAt || 0) }; } catch (_) { return null; } })
          .filter(Boolean).sort((a, b) => b.recency - a.recency).slice(0, Math.max(1, n));
      } catch (_) { /* */ }
    }
    const selected = cursorSelectedId(q);
    const out = [];
    for (const r of rows) {
      const d = cursorComposer(q, r.composerId); if (!d) continue;
      const ws = cursorWorkspace(d);
      const headers = Array.isArray(d.fullConversationHeadersOnly) ? d.fullConversationHeadersOnly : [];
      out.push({
        id: r.composerId, ref: cursorRef(dbPath, r.composerId), name: String(d.name || '').trim(),
        project: ws ? path.basename(ws) : '', workspace: ws,
        at: Number(d.lastUpdatedAt || d.createdAt || r.recency || 0),
        users: headers.filter((h) => h && h.type === 1).length,
        current: r.composerId === selected,
      });
    }
    return out;
  } finally { try { q.close(); } catch (_) { /* */ } }
}
function cursorText(file) {
  const { db, id } = parseCursorRef(file);
  let q = null;
  try { q = cursorOpen(db); } catch (_) { return ''; }
  try {
    const d = cursorComposer(q, id) || {};
    const bubbles = cursorBubbles(q, id);
    const lines = [{ type: 'ai-title', aiTitle: String(d.name || ''), cwd: cursorWorkspace(d) }];
    for (const h of (Array.isArray(d.fullConversationHeadersOnly) ? d.fullConversationHeadersOnly : [])) {
      if (!h || !h.bubbleId) continue;
      const user = h.type === 1;
      const b = bubbles.get(h.bubbleId);
      let t = String((b && b.text) || '');
      // 用户原话必须逐字：本地气泡丢了就跳过，不拿截断的 textPreview 顶替；AI 回复可以用预览补
      if (!t.trim() && !user) t = String((h.grouping && h.grouping.textPreview) || '');
      if (!t.trim()) continue;
      if (user && CURSOR_NOISE.test(t.trim())) continue;
      lines.push({ type: 'message', role: user ? 'user' : 'assistant', content: [{ type: user ? 'input_text' : 'output_text', text: t }] });
    }
    return lines.map((l) => JSON.stringify(l)).join('\n');
  } finally { try { q.close(); } catch (_) { /* */ } }
}
// 分别记录主库和 WAL；只取最大 mtime 会漏掉 WAL checkpoint 后的变化。
function cursorMtime(dbPath) {
  return [dbPath, dbPath + '-wal'].map(f => {
    try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch (_) { return '-'; }
  }).join('|');
}
function watchCursorSent(dbPath, want) {
  let seen = null, stamp = '';
  const poll = () => {
    if (!want) return false;
    const nextStamp = cursorMtime(dbPath);
    if (seen && stamp === nextStamp) return false;
    let q = null;
    try {
      q = cursorOpen(dbPath);
      q.exec('BEGIN');
      // 一次性记住所有旧消息的身份，包括正文尚未同步的消息。
      // 不能拼接历史文本：旧指令 + 任意新消息会误报，切换最近会话也会误报。
      if (!seen) {
        const baseline = new Set();
        for (const row of q.prepare("select key, value from cursorDiskKV where key like 'composerData:%'").all()) {
          let d; try { d = JSON.parse(String(row.value)); } catch (_) { continue; }
          const id = String(row.key).slice('composerData:'.length);
          for (const h of d.fullConversationHeadersOnly || []) if (h && h.type === 1 && h.bubbleId) baseline.add(`${id}:${h.bubbleId}`);
        }
        seen = baseline;
        stamp = nextStamp;
        return false;
      }
      const pending = [];
      const message = q.prepare('select value from cursorDiskKV where key = ?');
      // 只读新增用户消息；已有消息的编辑、排序和正文回填均不算本次发送。
      for (const s of cursorSessions(dbPath, 20)) {
        const d = cursorComposer(q, s.id);
        for (const h of d?.fullConversationHeadersOnly || []) {
          if (!h || h.type !== 1 || !h.bubbleId) continue;
          const key = `${s.id}:${h.bubbleId}`;
          if (seen.has(key)) continue;
          const row = message.get(`bubbleId:${s.id}:${h.bubbleId}`);
          let b; try { b = row && JSON.parse(String(row.value)); } catch (_) { continue; }
          const t = String(b?.text || '').trim();
          // 新消息的 header 和正文可能分两次落库，正文到达之前继续等待。
          if (!t) continue;
          pending.push({ key, text: t });
        }
      }
      for (const m of pending) seen.add(m.key);
      stamp = nextStamp;
      return pending.some(m => !CURSOR_NOISE.test(m.text) && squash(m.text).includes(want));
    } catch (_) { return false; }
    finally { if (q) { try { q.close(); } catch (_) { /* */ } } }
  };
  poll(); // 读失败时保持未初始化，下次只建立基线，不把旧消息当成新发送。
  return poll;
}

// ZCode 的会话在 sqlite 里，合成路径 zcode:…#… 没法 stat：改盯库里的用户消息，
// 出现比基线新的、正文就是那条指令的用户消息，就是用户粘贴发出去了。
// 用户常不开剪贴板而手敲 `$takeover <自己起的任务名>`：正文对不上原指令时，
// 只要新消息以任意接手指令形式开头也算发出；聊天里「提到」$takeover 不算（必须开头）
const ZCODE_TAKEOVER_CMD = /^\s*(?:[$/]takeover\b|use\s+takeover\s+skill\b|用\s*takeover\s*技能)/i;
function watchZcodeSent(dirs, want) {
  const { DatabaseSync } = require('node:sqlite');
  let baseline = null;
  const poll = () => {
    if (!want) return false;
    for (const d of dirs || []) {
      const dbFile = zcodeDb(d); if (!dbFile) continue;
      let sqlite; try { sqlite = new DatabaseSync(dbFile, { readOnly: true }); } catch (_) { continue; }
      try {
        const row = sqlite.prepare("select coalesce(max(m.time_created), 0) t from message m, session s where m.session_id = s.id and s.time_deleted is null and json_valid(m.data) and json_extract(m.data, '$.role') = 'user'").get();
        if (baseline === null) { baseline = row.t; continue; }
        if (row.t <= baseline) continue;
        const fresh = sqlite.prepare("select p.data d from part p, message m, session s where p.message_id = m.id and p.session_id = s.id and m.session_id = s.id and s.time_deleted is null and json_valid(m.data) and json_extract(m.data, '$.role') = 'user' and m.time_created > ? order by m.time_created desc limit 20").all(baseline);
        baseline = row.t;
        for (const r of fresh) {
          let o; try { o = JSON.parse(r.d); } catch (_) { continue; }
          if (!o || o.type !== 'text') continue;
          const t = String(o.text || '');
          if (squash(t).includes(want) || ZCODE_TAKEOVER_CMD.test(t)) return true;
        }
      } catch (_) { /* 老版本没有这些表 */ }
      finally { sqlite.close(); }
    }
    return false;
  };
  poll(); // 第一次只建立基线；读失败时 baseline 保持 null，下次重来
  return poll;
}

// DSH 每追加一段就写一个独立 zstd 帧，Node 只解第一帧，所以按帧头切开逐帧解
function readTranscript(file, from = 0) {
  if (String(file).startsWith(CURSOR)) return cursorText(file);
  if (String(file).startsWith(ZCODE)) return zcodeText(file);
  let b; const fd = fs.openSync(file, 'r');
  try { b = Buffer.alloc(Math.max(0, fs.fstatSync(fd).size - from)); fs.readSync(fd, b, 0, b.length, from); } finally { fs.closeSync(fd); }
  if (!file.endsWith('.zstd')) return b.toString('utf8');
  const pos = []; for (let i = 0; i + 4 <= b.length; i++) if (b.readUInt32LE(i) === 0xFD2FB528) pos.push(i);
  pos.push(b.length);
  let out = '', start = 0;
  // 帧内容里碰巧出现魔数时解压会失败，就并到下一段再试
  for (let k = 1; k < pos.length; k++) { try { out += zlib.zstdDecompressSync(b.subarray(start, pos[k])).toString('utf8'); start = pos[k]; } catch (_) { /* 并入下一段 */ } }
  return out;
}

function recentTranscripts(kind, dirs, n) {
  if (kind === 'cursor') return cursorSessions(cursorDb(dirs), n).map((s) => ({ p: s.ref, m: s.at, size: 0, name: s.name, dir: s.project, current: s.current }));
  if (kind === 'zcode') return zcodeSessions(dirs, n);
  const list = (d) => kind === 'codex' ? jsonlFiles(path.join(d, 'sessions'), 3) : kind === 'dsh' ? jsonlFiles(path.join(d, 'sessions'), 2, [], '.jsonl.zstd') : kind === 'workbuddy' ? jsonlFiles(path.join(d, 'projects'), 2) : jsonlFiles(path.join(d, 'projects'), 1);
  return dirs.flatMap(list).sort((a, b) => b.m - a.m).slice(0, n);
}

// 交接后盯目标工具的对话记录：新追加的内容里出现接手指令，就是用户发出去了；只读新增部分，大文件也不重读
// 目标 AI 常把路径改写（/mnt/d/... ↔ D:\...、转义反斜杠、折行），所以按「去掉标点的纯文本」比对，
// 并保留上一段的尾巴，避免路径被两次追加切开时永远匹配不到。
const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
function watchSent(kind, dirs, needle, { listMs = 8000 } = {}) {
  const want = squash(needle);
  // Cursor 没有可 stat 的 jsonl：盯 state.vscdb 里最近几个 composer 的用户消息
  if (kind === 'cursor') return watchCursorSent(cursorDb(dirs), want);
  // ZCode 的会话也是 sqlite：同样按「新用户消息」判断
  if (kind === 'zcode') return watchZcodeSent(dirs, want);
  const initial = recentTranscripts(kind, dirs, 20);
  const seen = new Map(initial.map((f) => [f.p, f.size]));
  const tails = new Map();
  let files = initial, lastScan = Date.now();
  return () => {
    // 递归扫目录很贵（WSL 上 93 个文件要 0.5 秒，3 秒扫一次会把主进程卡住），30 秒才重扫；
    // 中间只 stat 已知文件（约 25ms/次）。新开的会话最多晚 listMs（默认 8 秒）被认出来，够用了
    if (Date.now() - lastScan >= listMs) {
      lastScan = Date.now();
      const fresh = recentTranscripts(kind, dirs, 20);
      if (fresh.length) { files = fresh; for (const f of fresh) if (!seen.has(f.p)) seen.set(f.p, 0); }
    }
    return files.some((f) => {
      let size; try { size = fs.statSync(f.p).size; } catch (_) { return false; }
      const from = seen.get(f.p) || 0; if (size <= from) return false;
      seen.set(f.p, size);
      const buf = (tails.get(f.p) || '') + readTranscript(f.p, from);
      tails.set(f.p, buf.slice(-4096));
      return squash(buf).includes(want);
    });
  };
}

// 气泡里要让人看见「读的是哪个对话」：Codex 取线程名，Claude 取 ai-title，并带上会话起始日期
// 起始日期比文件 mtime 靠谱：Codex 重新打开旧对话会把 mtime 刷成今天，但内容还是十天前的
function startedAt(file) {
  try {
    const fd = fs.openSync(file, 'r'), b = Buffer.alloc(8192);
    const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
    const head = b.subarray(0, n).toString('utf8');
    const m = head.match(/"timestamp"\s*:\s*"([^"]+)"/);
    if (m) { const t = Date.parse(m[1]); if (t) return t; }
    // Codex 文件名自带开始时间：rollout-2026-10-14T18-14-43-<uuid>.jsonl
    const f = path.basename(file).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (f) return new Date(`${f[1]}-${f[2]}-${f[3]}T${f[4]}:${f[5]}:${f[6]}`).getTime();
  } catch (_) { /* 读不到就算了 */ }
  try { return fs.statSync(file).mtimeMs; } catch (_) { return 0; }
}
// 接手出来的会话，标题/首条消息就是接手指令本身：只留里面的任务名（旧版是「项目_会话」标签），否则文件名会变成整句指令
function sessionName(name) {
  const s = String(name || '').replace(/\s+/g, ' ').trim();
  if (!/takeover/i.test(s)) return s;
  const tag = /^[/$]takeover \[([^\]]*)\]/i.exec(s) || /^【?([^】]*)】/.exec(s);
  if (tag) return tag[1].trim();
  // 现在的指令是「技能命令 + 任务名」：任务名当会话名；旧版把路径直接带上时不要（那是文件，不是名字）
  const rest = s.replace(/^[/$]takeover\s*/i, '').replace(/^用\s*takeover\s*技能\s*/i, '').replace(/^Use\s+takeover\s+skill\s*/i, '').trim().replace(/^(?:--incremental|增量)(?:\s+|$)/i, '');
  return /^[a-z]:[\\/]|^[\\/]|\.md$/i.test(rest) ? '' : rest;
}
function threadLabel(kind, file, dir, cwd) {
  let name = '', updated = 0, born = 0;
  try {
    if (kind === 'claude' || kind === 'workbuddy') name = aiTitle(file);
    else if (kind === 'dsh') name = cwd ? path.basename(cwd) : path.basename(path.dirname(path.dirname(file))).replace(/^-+|-+$/g, '');
    else if (kind === 'zcode') {
      const sqlite = zcodeOpen(file);
      try {
        const r = sqlite.prepare('select title, time_updated, time_created from session where id = ?').get(String(file).slice(String(file).lastIndexOf('#') + 1)) || {};
        name = r.title || ''; updated = r.time_updated || 0; born = r.time_created || 0;
      } finally { sqlite.close(); }
    } else if (kind === 'cursor') {
      const { db, id } = parseCursorRef(file);
      let sqlite = null;
      try {
        sqlite = cursorOpen(db);
        const d = cursorComposer(sqlite, id) || {};
        name = String(d.name || '');
        updated = Number(d.lastUpdatedAt || d.createdAt || 0);
        born = Number(d.createdAt || 0);
      } finally { if (sqlite) { try { sqlite.close(); } catch (_) { /* */ } } }
    } else if (kind === 'codex') {
      const home = dir || path.dirname(path.dirname(path.dirname(path.dirname(file))));
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(home, 'state_5.sqlite'), { readOnly: true });
      try {
        const want = path.basename(file).toLowerCase();
        const hit = db.prepare('select name, title, rollout_path, updated_at_ms from threads where archived = 0 order by updated_at_ms desc limit 50').all()
          .find((r) => String(r.rollout_path || '').toLowerCase().includes(want));
        name = (hit && (hit.name || hit.title)) || '';
        updated = (hit && hit.updated_at_ms) || 0;
      } finally { db.close(); }
    }
  } catch (_) { name = ''; }
  // 会话多久没动过：比「起始日期」更能当场暴露「取到的不是我正在用的那个」
  try { if (!updated) updated = fs.statSync(file).mtimeMs; } catch (_) { /* 文件没了 */ }
  const mins = updated ? Math.max(0, Math.round((Date.now() - updated) / 60000)) : null;
  const t = born || startedAt(file), d = t ? (Date.now() - t) / 86400e3 : 0;
  const age = !t ? '' : d >= 1 ? `${new Date(t).getMonth() + 1}/${new Date(t).getDate()} 开始` : '今天开始';
  return { name: sessionName(name).slice(0, 40), age, updated, minutes: mins, fresh: freshText(mins) };
}
function freshText(mins) {
  if (mins === null || mins === undefined) return '';
  if (mins < 1) return '刚刚动过';
  if (mins < 60) return `${mins} 分钟前动过`;
  if (mins < 1440) return `${Math.round(mins / 60)} 小时前动过`;
  return `${Math.round(mins / 1440)} 天前动过`;
}

// 一个目录里可能同时住着两个项目（例如拼图和串口屏都在 pintu 下），交接文件不能互相覆盖：
// HANDOFF.md 属于「上一个写它的会话」，换了会话就另存成 HANDOFF-<会话名>.md
const slug = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
function pickFile({ dir, transcript, label, root }) {
  const main = path.join(dir, 'HANDOFF.md');
  if (!root || !fs.existsSync(main)) return main;
  let prev = '';
  try { prev = fs.readFileSync(main, 'utf8'); } catch (_) { return main; }
  const src = (prev.match(/^原始对话：(.+)$/m) || [])[1];
  if (!src || src.trim() === transcript) return main;
  return path.join(dir, `HANDOFF-${slug(label && label.name)}.md`);
}

// 菜单里让人选「从哪个会话交接」：只列最近 N 个，带名字和多久没动过
// ZCode 的会话目录可能是它自己的默认工作区，那就标成「默认工作区」，别把 ~/.zcode 当项目名
function zcodeProject(dir) {
  const s = String(dir || '');
  if (!s) return '';
  const home = os.homedir(), zc = path.join(home, '.zcode').toLowerCase();
  return s.toLowerCase().startsWith(zc) ? '默认工作区' : path.basename(s);
}
// DSH 会话没有标题，只能从第一条用户消息里取；按「文件 + mtime」缓存，右键菜单不会每次重新解压
const dshMetaCache = new Map();
function dshMeta(file) {
  let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch (_) { /* 没了 */ }
  const key = `${file}|${mtime}`;
  if (dshMetaCache.has(key)) return dshMetaCache.get(key);
  let meta = { name: '', project: '' };
  try {
    const r = parseTranscript(readTranscript(file), 'dsh');
    meta = { name: sessionName(r.user[0]).slice(0, 26), project: r.cwd ? path.basename(r.cwd) : '' };
  } catch (_) { /* 解压失败就留空 */ }
  dshMetaCache.set(key, meta);
  return meta;
}
// ZCode 的会话目录多数是它自己的默认工作区；这时候解析一次会话，用「提到最多的目录」当项目名，
// 让菜单里能看出这条会话到底在改哪个项目（按文件 + mtime 缓存，菜单重建不用再解析）
const zcodeMetaCache = new Map();
function zcodeMeta(file, dir) {
  const project = zcodeProject(dir);
  if (project !== '默认工作区') return { project };
  let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch (_) { /* 合成路径没有 mtime */ }
  const key = `${file}|${mtime}`;
  if (zcodeMetaCache.has(key)) return zcodeMetaCache.get(key);
  let meta = { project };
  try {
    const r = parseTranscript(readTranscript(file), 'zcode');
    const dir2 = commonDir(r.items || [], 'Ubuntu');
    if (dir2) { const parts = dir2.split(/[\\/]+/).filter(Boolean); meta = { project: parts.slice(-2).join('\\') }; }
  } catch (_) { /* 解析失败就保留默认工作区 */ }
  zcodeMetaCache.set(key, meta);
  return meta;
}
// 给重名会话补的短 id：同一路径永远得到同一串，避免「同一项目里好几个会话长得一样」
const shortId = (s) => { let h = 0; for (const ch of String(s)) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0; return h.toString(36).slice(-4).padStart(4, '0'); };
function recentSessions(kind, dirs, n = 5) {
  // ZCode：标出「你最近敲过字的那个会话」，菜单里能一眼看出默认会转接谁
  const active = kind === 'zcode' ? zcodeActiveId(dirs) : '';
  const list = recentTranscripts(kind, dirs, n).map((f) => {
    if (kind === 'zcode') {
      const minutes = f.m ? Math.max(0, Math.round((Date.now() - f.m) / 60000)) : null;
      return { file: f.p, name: (f.name || '（无标题）').slice(0, 40), project: zcodeMeta(f.p, f.dir).project, fresh: freshText(minutes), minutes,
        current: !!active && f.p.endsWith('#' + active) };
    }
    if (kind === 'cursor') {
      const minutes = f.m ? Math.max(0, Math.round((Date.now() - f.m) / 60000)) : null;
      return { file: f.p, name: (f.name || '（无标题）').slice(0, 40), project: f.dir || '', fresh: freshText(minutes), minutes, current: !!f.current };
    }
    if (kind === 'dsh') {
      const meta = dshMeta(f.p), minutes = f.m ? Math.max(0, Math.round((Date.now() - f.m) / 60000)) : null;
      return { file: f.p, minutes, fresh: freshText(minutes),
        name: meta.name || path.basename(path.dirname(path.dirname(f.p))).replace(/^-+|-+$/g, ''), project: meta.project };
    }
    let l = {};
    try { l = threadLabel(kind, f.p, (dirs || [])[0]); } catch (_) { /* 没名字也照列 */ }
    return { file: f.p, name: l.name || path.basename(f.p).replace(/\.jsonl(\.zstd)?$/, '').slice(0, 40), project: '', fresh: l.fresh || '', minutes: l.minutes };
  });
  // 同一项目里多个会话可能重名：重名的补一段短 id，否则菜单里根本分不出
  const count = new Map();
  for (const s of list) { const k = `${s.name}|${s.project}`; count.set(k, (count.get(k) || 0) + 1); }
  for (const s of list) {
    if (count.get(`${s.name}|${s.project}`) > 1) s.name = `${s.name} · #${shortId(s.file)}`;
  }
  return list;
}
// → { user: [原话], items: [{ role: 'user'|'ai'|'tool'|'summary', t }] }
function parseTranscript(text, kind) {
  const user = [], items = []; let cwd = null;
  for (const line of String(text).split('\n')) {
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (kind === 'dsh') {
      const d = o.data || {}, m = d.message || {};
      if (o.type === 'session' && o.cwd) cwd = o.cwd;
      else if (o.type === 'user/message') { const t = textOf(d.content); if (fromHuman(d) && !isNoise(t)) { user.push(t.trim()); items.push({ role: 'user', t }); } }
      else if (o.type === 'assistant/message') { const t = textOf(m.content); if (t.trim()) items.push({ role: 'ai', t }); }
      else if (o.type === 'tool/call') { const full = String(d.arguments || ''); items.push({ role: 'tool', t: `${d.name}: ${full.slice(0, 400)}`, full }); }
    } else if (kind === 'cursor') {
      // 合成格式和 CodeBuddy 系一样：{type:'message', role, content:[{type:'input_text'|'output_text'}]}
      if (o.type === 'ai-title') { if (o.cwd) cwd = String(o.cwd).replace(/^\\\\\?\\/, ''); }
      else if (o.type === 'message') {
        const t = textOf(o.content);
        if (o.role === 'user') { if (!isNoise(t) && !CURSOR_NOISE.test(t.trim())) { user.push(t.trim()); items.push({ role: 'user', t }); } }
        else if (o.role === 'assistant' && t.trim()) items.push({ role: 'ai', t });
      }
    } else if (kind === 'workbuddy' || kind === 'zcode') {
      // CodeBuddy 系：{type:'message', role, content:[{type:'input_text'|'output_text'|'function_call'}]}
      if (o.type === 'ai-title') { if (o.cwd) cwd = String(o.cwd).replace(/^\\\\\?\\/, ''); }
      else if (o.type === 'message') {
        // WorkBuddy 把「真正的提问」包在 <user_query> 里，前面是整段 <system-reminder> 脚手架
        const raw = textOf(o.content);
        const q = raw.match(/<user_query>([\s\S]*?)<\/user_query>/);
        const t = q ? q[1] : raw.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '');
        if (o.role === 'user') { if (!isNoise(t)) { user.push(t.trim()); items.push({ role: 'user', t }); } }
        else if (o.role === 'assistant') {
          if (t.trim()) items.push({ role: 'ai', t });
          for (const c of o.content || []) if (c && (c.type === 'function_call' || c.type === 'tool_use')) { const full = String(c.arguments || c.input || ''); items.push({ role: 'tool', t: `${c.name}: ${full.slice(0, 400)}`, full }); }
        }
      }
    } else if (kind === 'codex') {
      const p = o.payload || {};
      if (o.type === 'session_meta' && p.cwd) cwd = String(p.cwd).replace(/^\\\\\?\\/, '');
      if (o.type === 'compacted' && p.message) items.push({ role: 'summary', t: String(p.message) });
      if (o.type !== 'response_item') continue;
      if (p.type === 'message' && p.role === 'user') { const t = textOf(p.content); if (!isNoise(t)) { user.push(t.trim()); items.push({ role: 'user', t }); } }
      else if (p.type === 'message' && p.role === 'assistant') items.push({ role: 'ai', t: textOf(p.content) });
      else if (p.type === 'custom_tool_call' || p.type === 'function_call') { const full = String(p.input || p.arguments || ''); items.push({ role: 'tool', t: `${p.name}: ${full.slice(0, 400)}`, full }); }
    } else {
      if (typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;
      const m = o.message; if (!m || o.isMeta) continue;
      if (o.isCompactSummary) { items.push({ role: 'summary', t: textOf(m.content) }); continue; }
      if (o.type === 'user') { const t = textOf(m.content); if (!isNoise(t)) { user.push(t.trim()); items.push({ role: 'user', t }); } }
      else if (o.type === 'assistant' && Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === 'text') items.push({ role: 'ai', t: c.text });
          else if (c.type === 'tool_use') { const full = JSON.stringify(c.input || {}); items.push({ role: 'tool', t: `${c.name}: ${full.slice(0, 400)}`, full }); }
        }
      }
    }
  }
  return { user, items, cwd };
}

// 对话里出现的绝对路径 → Windows 路径（WSL 的 /mnt/x/ 和 /home/ 都转过去）
function pathsIn(t, distro = 'Ubuntu') {
  const out = [];
  for (const m of String(t).matchAll(/(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\/mnt\/[a-z]\/|\/home\/)[^\s"'`<>|*?,;:()\]]+/g)) {
    let p = m[0].replace(/\\\\/g, '\\');
    const mnt = /^\/mnt\/([a-z])\/(.*)$/.exec(p);
    if (mnt) p = `${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, '\\')}`;
    else if (p.startsWith('/home/')) p = `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`;
    out.push(p.replace(/\//g, '\\'));
  }
  return out;
}

// 被提到最多的 git 仓库就是项目根目录——但「提到」不等于「在哪儿干活」：
// Codex 自己的 ~/.codex/memories 是个 git 仓库，会话里读写记忆就会把它刷成「最常提到的仓库」，
// 结果 17:30 那次把 pintu 的交接写进了 Codex 的内部目录。所以：工具自己的目录一律不算项目，
// 并且会话 cwd 不是家目录/盘符根时，只接受「cwd 本身或它的上下级」当项目根。
const internalDirs = () => {
  const home = os.homedir();
  return ['.codex', '.claude', '.dsh', '.handoff', '.zcode'].map((d) => path.join(home, d).toLowerCase());
};
// WSL 里的工具自家目录（如 ~/.claude/memories）同样不算项目；pathsIn 已把 /home/ 转成 UNC 路径
const WSL_INTERNAL = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\home\\[^\\]+\\\.(?:codex|claude|dsh|handoff|zcode)(?:[\\/]|$)/i;
const internalPath = (p) => internalDirs().some((d) => String(p).toLowerCase().startsWith(d)) || WSL_INTERNAL.test(String(p));
// 没有 git 仓库、cwd 又是工具自己的目录时，退而求其次：被工具调用提到次数最多的目录
function commonDir(items, distro) {
  const m = new Map();
  for (const it of items) if (it.role === 'tool') for (const p of pathsIn(it.full || it.t, distro)) {
    if (internalPath(p)) continue;
    const d = path.dirname(p);
    m.set(d, (m.get(d) || 0) + 1);
  }
  return [...m.entries()].filter(([d, n]) => n >= 3 && fs.existsSync(d)).sort((a, b) => b[1] - a[1]).map((e) => e[0])[0] || null;
}
// 非 git 项目连 commonDir 都会偏深（提到的多是 tmp/output 子目录）：
// 按祖先目录统计覆盖量，取「盖住七成路径的最深目录」——家目录里跑的会话也能落回真实项目根，而不是掉进全局 .handoff
function dominantDir(items, distro) {
  const paths = [];
  for (const it of items) if (it.role === 'tool') for (const p of pathsIn(it.full || it.t, distro)) {
    if (!internalPath(p)) paths.push(p);
  }
  if (paths.length < 3) return null;
  const home = os.homedir().toLowerCase();
  const tooBroad = (d) => {
    const k = d.toLowerCase();
    return /^[a-z]:[\\/]?$/.test(k) || k === home || /^\\\\wsl(?:\.localhost|\$)\\[^\\]+[\\/]?$/.test(k) || /^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\home(?:[\\/][^\\/]*)?[\\/]?$/.test(k);
  };
  const counts = new Map(), depth = new Map(), original = new Map();
  for (const p of paths) {
    let d = path.dirname(p);
    for (let i = 0; i < 12; i++) {
      const k = d.toLowerCase();
      if (!counts.has(k)) { counts.set(k, 0); depth.set(k, d.split(/[\\/]+/).filter(Boolean).length); original.set(k, d); }
      counts.set(k, counts.get(k) + 1);
      const up = path.dirname(d); if (up === d) break; d = up;
    }
  }
  const need = Math.max(3, Math.ceil(paths.length * 0.7));
  return [...counts.entries()]
    .filter(([k, n]) => n >= need && !tooBroad(k) && !internalPath(k) && fs.existsSync(k))
    .sort((a, b) => depth.get(b[0]) - depth.get(a[0]) || counts.get(b[0]) - counts.get(a[0]))
    .map((e) => original.get(e[0]))[0] || null;
}
function projectRoot(items, distro, cwd) {
  const linuxHome = /^\/home\/[^/]+\/?$/.test(cwd || '');
  if (/^\/mnt\/[a-z]\//i.test(cwd || '')) cwd = cwd[5].toUpperCase() + ':\\' + cwd.slice(7).replace(/\//g, '\\');
  else if (/^\/home\//.test(cwd || '')) cwd = '\\\\wsl.localhost\\' + distro + cwd.replace(/\//g, '\\');
  const cache = new Map(), count = new Map();
  const internal = (p) => { const s = String(p).toLowerCase(); return internalDirs().some((d) => s === d || s.startsWith(d + path.sep)) || WSL_INTERNAL.test(String(p)); };
  const rootOf = (p) => {
    let d = p;
    for (let i = 0; i < 12; i++) {
      if (cache.has(d)) return cache.get(d);
      let r = null; try { if (fs.existsSync(path.join(d, '.git'))) r = d; } catch (_) { /* */ }
      if (r) { cache.set(d, r); return r; }
      const up = path.dirname(d); if (up === d) break; d = up;
    }
    cache.set(p, null); return null;
  };
  for (const it of items) if (it.role === 'tool') for (const p of pathsIn(it.full || it.t, distro)) {
    if (internal(p)) continue;
    const r = rootOf(p); if (r && !internal(r)) count.set(r, (count.get(r) || 0) + 1);
  }
  const winner = [...count.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])[0] || null;
  // A desktop session can be hosted in a scratch folder while commands explicitly
  // operate in another repo. Use repeated recent command workdirs, not paths merely read.
  const explicit = new Map(); let order = 0;
  for (const it of items.filter(it => it.role === 'tool').slice(-80)) {
    const text = String(it.full || it.t || '');
    const dirs = [];
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      for (const [k, v] of Object.entries(value)) {
        if (/^(workdir|work_dir|cwd)$/.test(k) && typeof v === 'string') dirs.push(v);
        else if (v && typeof v === 'object') visit(v);
      }
    };
    try { visit(JSON.parse(text)); } catch (_) { /* JS orchestration is not JSON */ }
    if (!dirs.length) for (const m of text.matchAll(/\b(?:workdir|work_dir|cwd)["']?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)) {
      try { dirs.push(m[1][0] === '"' ? JSON.parse(m[1]) : m[1].slice(1, -1).replace(/\\\\/g, '\\')); } catch (_) { /* skip malformed paths */ }
    }
    for (let d of new Set(dirs)) {
      const mnt = /^\/mnt\/([a-z])\/(.*)$/i.exec(d);
      if (mnt) d = mnt[1].toUpperCase() + ':\\' + mnt[2].replace(/\//g, '\\');
      else if (d.startsWith('/home/')) d = '\\\\wsl.localhost\\' + distro + d.replace(/\//g, '\\');
      if (!path.isAbsolute(d) || internal(d) || !fs.existsSync(d)) continue;
      const r = rootOf(d) || d;
      if (r.replace(/[\\/]+$/, '').toLowerCase() === os.homedir().toLowerCase() || /^[a-z]:[\\/]?$/i.test(r)) continue;
      if (!internal(r)) explicit.set(r, { n: (explicit.get(r)?.n || 0) + 1, at: ++order });
    }
  }
  const active = [...explicit.entries()].filter(([, v]) => v.n >= 2).sort((a, b) => b[1].n - a[1].n || b[1].at - a[1].at)[0];
  if (active) return active[0];
  if (!cwd || !fs.existsSync(cwd)) return winner;
  // ZCode 的 cwd 是它自己的工作区（~/.zcode/workspace/default），不是项目：这时用「被提到最多的目录」
  if (internal(cwd)) return winner || dominantDir(items, distro) || commonDir(items, distro);
  const home = os.homedir();
  const broad = linuxHome || cwd.replace(/[\\/]+$/, '').toLowerCase() === home.toLowerCase() || /^[a-z]:\\?$/i.test(cwd);
  // 会话从家目录/盘符根启动时 cwd 不能当项目；否则交接跟着 cwd 走，winner 落在 cwd 里面才替代它
  if (broad) return winner || dominantDir(items, distro);
  const norm = (s) => String(s).replace(/[\\/]+$/, '').toLowerCase();
  const under = (child, parent) => norm(child) === norm(parent) || norm(child).startsWith(norm(parent) + path.sep);
  // winner 得真正落在 cwd 里面才算比 cwd 准；只是盖住 cwd 的上级仓库（伞仓库套着一天一个的工作目录）不算，
  // 否则在非 git 工作区里开的会话会把交接文件送到上面的伞仓库根
  if (!winner) return cwd;
  if (under(winner, cwd)) return winner;
  if (under(cwd, winner)) return cwd;
  // 例外：会话开在非 git 的草稿目录（如 kk），活却集中干在一个完全无关的仓库（如 D 盘的 ai-pet）——
  // 提及够多（≥5 次工具调用）说明那才是真项目，交接文件和工作区都按真实仓库走；零星提到别的仓库不算
  if (!fs.existsSync(path.join(cwd, '.git')) && (count.get(winner) || 0) >= 5) return winner;
  return cwd;
}

// 从后往前塞，超预算就丢最早的；早先摘要总保留
function buildDigest(items, budget = DIGEST_CHARS) {
  const tag = { user: '用户', ai: 'AI', tool: '工具调用', summary: '早先对话摘要' };
  const fmt = (it) => `【${tag[it.role]}】${it.role === 'tool' ? it.t : it.t.slice(0, it.role === 'summary' ? 12000 : 3000)}`;
  const summary = items.filter((x) => x.role === 'summary').slice(-1).map(fmt);
  const out = []; let size = summary.join('').length;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === 'summary') continue;
    const s = fmt(items[i]); if (size + s.length > budget) break;
    out.unshift(s); size += s.length;
  }
  return [...summary, ...out].join('\n\n');
}

function git(root) {
  const run = (...a) => { try { return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim(); } catch (_) { return ''; } };
  return { head: run('rev-parse', '--short', 'HEAD'), status: run('status', '--short'), stat: run('diff', '--stat') };
}

const PROMPT = `你是交接整理员。根据下面的 AI 编程对话（可能截断），写一份当前任务短摘要，供另一个 AI 配合 Git 现场继续工作。
只依据记录，不编造；正文通常 40–80 行、1500 中文字以内。不累计历史流水账，不粘贴完整对话、工具输出或全部用户原话。
只保留仍适用的目标、验收标准、约束、用户纠正、关键决策与否决理由。必要的用户原话只选少量关键短引文，不截断会改变含义的约束。
状态标 [已验证]（记录里有运行结果，注明命令与结果）/[未验证]/[推测]，不要把对话中的完成声明当现场验收。
用简体中文 Markdown，第一行是 "# HANDOFF — <任务一句话>"，只写以下二级标题：
## 当前任务
## 当前状态
包含相关文件和未提交工作、影响下一步的决策、验证结果与仍待验证项。规格和详细证据只引用已有路径。
## 下一步
按顺序列 1–3 个可执行步骤，含必要文件或命令。
原始对话路径、代码锚点和历史备份由程序附上，接手者仅在缺少关键约束或证据冲突时按需检索。不要输出寒暄。`;

// 会话太长时，把「最近 60k 字符以外」的旧记录交给 DeepSeek 压成要点，而不是直接扔掉
const COMPACT_PROMPT = '你在压缩一段较早的 AI 对话记录，供交接文档使用。保留：用户目标与关键原话、已完成的改动、被否决的方案、踩过的坑与报错原文。丢弃寒暄与重复。输出简体中文，不超过 1200 字，不要 Markdown 标题。';
const COMPACT_AT = DIGEST_CHARS * 2.5;

async function chat({ api, request, system, user, maxTokens = 8000, temperature = 0.2 }) {
  const base = String(api.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const payload = { model: api.model || 'deepseek-flash', temperature, max_tokens: maxTokens, thinking: { type: 'disabled' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  // 粘贴来的 Key 带乱码/全角字符时 fetch 只报 ByteString，这里先给出能看懂的错
  if (/[^\x21-\x7e]/.test(String(api.apiKey || '').trim())) throw new Error('DeepSeek Key 含非 ASCII 字符（多半是复制时带了乱码或全角符号），请在设置里重新粘贴');
  const send = () => request(base + '/chat/completions', { method: 'POST', timeoutMs: 180000, headers: { Authorization: 'Bearer ' + String(api.apiKey || '').trim(), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  let r = await send();
  if (r.status === 400 && /thinking|unknown|invalid/i.test(r.text || '')) { delete payload.thinking; r = await send(); }
  const out = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
  if (!r.ok || !out) throw new Error(`DeepSeek ${r.status} ${String(r.text || '').slice(0, 120)}`);
  return out.trim();
}

async function digestFor(items, { api, request, onPhase }) {
  const recent = buildDigest(items);
  const total = items.reduce((n, it) => n + String(it.t || '').length, 0);
  if (total <= COMPACT_AT) return { digest: recent, compacted: 0 };
  let acc = 0, cut = items.length;
  while (cut > 0 && acc < DIGEST_CHARS) { cut--; acc += String(items[cut].t || '').length; }
  const older = items.slice(0, cut);
  if (older.length < 5) return { digest: recent, compacted: 0 };
  try {
    if (onPhase) onPhase('压缩旧记录');
    const text = await chat({ api, request, system: COMPACT_PROMPT, user: buildDigest(older, DIGEST_CHARS * 2), maxTokens: 2000, temperature: 0.1 });
    if (!text) return { digest: recent, compacted: 0 };
    return { digest: `【更早的 ${older.length} 条已压缩】\n${text.slice(0, 8000)}\n\n【最近的对话】\n${recent}`, compacted: older.length };
  } catch (_) { return { digest: recent, compacted: 0 }; }
}

async function summarize({ digest, gitInfo, api, request }) {
  const ctx = gitInfo && gitInfo.head ? `\n\n【git 实测】HEAD ${gitInfo.head}\n${gitInfo.status}\n${gitInfo.stat}` : '';
  return chat({ api, request, system: PROMPT, user: digest + ctx });
}

// 短摘要 + 兼容的头部定位接口；历史原话通过原始对话按需读取
function compose({ body, user, kind, transcript, root, sessionCwd, gitInfo, compacted, previous, now = new Date() }) {
  const md = body;
  const lines = md.split('\n'); const title = /^# /.test(lines[0]) ? lines.shift() : '# HANDOFF';
  const stamp = now.toLocaleString('zh-CN', { hour12: false });
  const head = [title, `生成时间：${stamp}　来源工具：${{ codex: 'Codex', dsh: 'DSH Desktop', workbuddy: 'WorkBuddy', zcode: 'ZCode', cursor: 'Cursor' }[kind] || 'Claude Code'}（由 AI 桌宠用 DeepSeek 按对话记录整理，**未核对代码**，接手先用 git 核对）`,
    `代码锚点：${(gitInfo && gitInfo.head) || '未知'}　项目根目录：${root || '未识别'}`, `会话启动目录：${sessionCwd || '未识别'}（可能与实际项目不同，以项目根目录为准）`,
    ...(root ? [`<!-- ai-pet-project:${JSON.stringify({ root })} -->`] : []), `原始对话：${transcript}`,
    '上下文读取：默认只读当前摘要和相关 Git 差异；缺少关键约束或证据冲突时，在上述会话内按任务关键词检索并局部展开，不通读全部历史。',
    // 旧稿留在备份中，当前摘要不重复载入历史
    ...(compacted ? [`早先对话：更早的 ${compacted} 条已用 DeepSeek 压缩成摘要`] : []),
    ...(previous ? [`历史：覆盖前 ${previous.lines} 行，已备份到 ${previous.backup}（本文只记录本轮，旧版决策与坑看备份）`] : []), ''];
  const tail = gitInfo && gitInfo.head ? `\n\n## 附：git 实测（桌宠生成时）\n\`\`\`\n${gitInfo.status || '(干净)'}\n\n${gitInfo.stat}\n\`\`\`\n` : '\n';
  return head.join('\n') + '\n' + lines.join('\n').trim() + tail;
}

// 一个项目里会话多了会攒出一堆 HANDOFF-<会话名>.md：只把「桌宠生成的、最旧的」挪进 backups/pruned，
// 不删除，也不碰 HANDOFF.md 和用户自己起的文件
function pruneOldHandoffs(dir, keep = 10) {
  try {
    const bak = path.join(path.dirname(LATEST), 'backups', 'pruned');
    const files = fs.readdirSync(dir).filter((n) => /^HANDOFF-.+\.md$/.test(n))
      .map((n) => ({ n, p: path.join(dir, n), t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .filter((f) => { try { return fs.readFileSync(f.p, 'utf8').includes('由 AI 桌宠用 DeepSeek'); } catch (_) { return false; } })
      .sort((a, b) => b.t - a.t);
    if (files.length <= keep) return [];
    fs.mkdirSync(bak, { recursive: true });
    const moved = [];
    for (const f of files.slice(keep)) { fs.renameSync(f.p, path.join(bak, `${Date.now()}-${f.n}`)); moved.push(f.n); }
    return moved;
  } catch (_) { return []; }
}
// 全流程：找记录 → 整理 → 写 HANDOFF.md（旧文件先备份）→ 追加 latest.txt；返回 HANDOFF 路径
async function run({ kind, dirs, winTitle, api, request, session, onRead, onWrite, onPhase, onTiming, history }) {
  if (!api || !api.apiKey) throw new Error('没有可用的 DeepSeek Key');
  if (kind === 'dsh' && !/DeepSeek Harness|DSH/i.test(winTitle || '')) throw new Error('来源不是 DSH 桌面版');
  // 菜单里选定了会话就用它，没选才按「最近更新的」猜
  const pinned = session && (String(session).startsWith(ZCODE) || String(session).startsWith(CURSOR) || fs.existsSync(session)) ? session : null;
  if (kind === 'codex' && session && !pinned) { const e = new Error('所选 Codex 会话记录已不存在，请重新选择来源会话'); e.code = 'SOURCE_SELECTION_REQUIRED'; throw e; }
  const transcript = pinned || newestTranscript(kind, dirs, winTitle);
  if (!transcript) throw new Error('没找到对话记录');
  const distro = (/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/i.exec(transcript) || [])[1] || 'Ubuntu';
  const { user, items, cwd } = parseTranscript(readTranscript(transcript), kind);
  if (!items.length) throw new Error('对话记录是空的');
  // 不是 git 仓库时退回会话自己记的工作目录（Codex 有）
  const root = projectRoot(items, distro, cwd);
  const gitInfo = root ? git(root) : null;
  const label = threadLabel(kind, transcript, (dirs || [])[0], cwd);
  const total = items.reduce((n, it) => n + String(it.t || '').length, 0);
  let acc = 0, cut = items.length;
  while (cut > 0 && acc < DIGEST_CHARS) { cut--; acc += String(items[cut].t || '').length; }
  const compactChars = total > COMPACT_AT && cut >= 5 ? buildDigest(items.slice(0, cut), DIGEST_CHARS * 2).length : 0;
  const estimate = require('./handoff-estimate').estimate({ records: items.length, digestChars: buildDigest(items).length, compactChars }, history, api.model || 'deepseek-flash');
  // 让气泡在点下去的那一刻就写清楚「读的是哪个对话、多旧」，选错会话时用户能当场取消
  if (onRead) onRead(root, { transcript, label, cwd, estimate });
  const started = Date.now();
  // 超长会话先压缩旧片段，别让最早的上下文白白丢掉
  const { digest, compacted } = await digestFor(items, { api, request, onPhase });
  if (onPhase) onPhase('整理交接');
  const body = await summarize({ digest, gitInfo, api, request });
  if (onTiming) onTiming({ model: api.model || 'deepseek-flash', work: estimate.work, seconds: Math.max(0.001, (Date.now() - started) / 1000) });
  const dir = root || path.dirname(LATEST);
  // 同目录换了会话就另存，避免两个项目互相顶掉对方的交接文件
  const file = root ? pickFile({ dir, transcript, label, root }) : path.join(dir, `HANDOFF-${Date.now()}.md`);
  let backup = null, prevLines = 0;
  if (fs.existsSync(file)) {
    const prev = fs.readFileSync(file, 'utf8');
    prevLines = prev ? prev.split('\n').length : 0;
    const bak = path.join(path.dirname(LATEST), 'backups'); fs.mkdirSync(bak, { recursive: true });
    backup = path.join(bak, `${Date.now()}-${path.basename(dir)}-HANDOFF.md`);
    fs.copyFileSync(file, backup);
  }
  // 覆盖前告诉调用方「替换了多少行、备份在哪」——这个文件是唯一真相源，不能悄悄重写
  if (onWrite) onWrite({ file, backup, prevLines });
  fs.mkdirSync(dir, { recursive: true });
  // 先写临时文件再改名：写到一半断电/被杀也不会留下半截 HANDOFF.md
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, compose({ body, user, kind, transcript, root, sessionCwd: cwd, gitInfo, compacted, previous: backup ? { lines: prevLines, backup } : null }), 'utf8');
  fs.renameSync(tmp, file);
  fs.mkdirSync(path.dirname(LATEST), { recursive: true });
  fs.appendFileSync(LATEST, file + os.EOL, 'utf8');
  return file;
}

module.exports = { KINDS, sessionName, newestTranscript, readTranscript, watchSent, threadLabel, freshText, pickFile, recentSessions, zcodeProject, digestFor, pruneOldHandoffs, commonDir, dominantDir, parseTranscript, pathsIn, projectRoot, buildDigest, compose, summarize, run };
