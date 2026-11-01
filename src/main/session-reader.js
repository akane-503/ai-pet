'use strict';
// Standalone, read-only reader. Also shipped outside asar so a receiving AI can run it.
const fs = require('node:fs');
const path = require('node:path');
const MAX_BYTES = 131072;
function normalizeWorkspace(value) {
  let s=String(value||'');
  if(/^file:\/\//i.test(s)){try{s=require('node:url').fileURLToPath(s);}catch(_){return '';}}
  s=s.replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\/,'').replace(/^\/([a-z]:[\\/])/i,'$1');
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(s)?path.win32.normalize(s):s;
}
function referenceKey(ref) {
  const m=/^(zcode|cursor):(.+)#([^#]+)$/.exec(String(ref));
  let file=normalizeWorkspace(m?m[2]:ref).replace(/\\/g,'/');
  if(process.platform==='win32')file=file.toLowerCase();
  return (m?m[1]+':':'')+file+(m?'#'+m[3]:'');
}
function codexMetadata(file) {
  const {DatabaseSync}=require('node:sqlite');
  let dir=path.dirname(file);
  for(let i=0;i<8;i++) {
    const dbFile=path.join(dir,'state_5.sqlite');
    if(fs.existsSync(dbFile)) {
      let db;
      try {
        db=new DatabaseSync(dbFile,{readOnly:true});
        const m=/^\/mnt\/([a-z])\/(.*)$/i.exec(file);
        const candidate=normalizeWorkspace(m?m[1].toUpperCase()+':\\'+m[2].replace(/\//g,'\\'):file);
        return db.prepare('select cwd,title from threads where rollout_path = ? collate nocase or rollout_path = ? collate nocase or rollout_path = ? collate nocase limit 1').get(file,candidate,'\\\\?\\'+candidate)||null;
      } catch(_) {return null;} finally {if(db)db.close();}
    }
    const parent=path.dirname(dir);if(parent===dir)break;dir=parent;
  }
  return null;
}
function parseRef(value) {
  const raw = String(value || '').trim().replace(/^"(.*)"$/, '$1');
  const m = /^(zcode|cursor):(.+)#([^#]+)$/.exec(raw);
  const kind = m ? m[1] : /\.jsonl\.zstd$/i.test(raw) ? 'dsh' : 'jsonl';
  let file = m ? m[2] : raw;
  if (!file || /[\r\n\0]/.test(file) || !path.isAbsolute(file)) throw new Error('来源必须是本机绝对路径或 zcode:/cursor: 会话引用');
  let repaired = false;
  if (!fs.existsSync(file)) {
    // 某些输入框吞掉 Users/<name> 与隐藏目录间的分隔符；只在唯一候选存在时修复。
    const candidate = file.replace(/([\\/]Users[\\/][^\\/]+?)(\.(?:zcode|cursor))([\\/])/i, '$1/$2$3');
    if (candidate !== file && fs.existsSync(candidate)) { file = candidate; repaired = true; }
    else throw new Error('找不到来源文件：' + file);
  }
  if (!fs.statSync(file).isFile()) throw new Error('来源不是文件');
  return { kind, file, id: m ? m[3] : '', ref: m ? `${kind}:${file}#${m[3]}` : file, repaired };
}
function textOf(c) { return typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && /^(text|input_text|output_text)$/.test(x.type)).map(x => x.text || '').join('\n') : ''; }
// 只保留工具输入里的路径证据，不把命令、凭据或大段参数放进接手元数据。
function workspaceHints(input) {
  const hints = [], seen = new Set();
  const add = (key,value) => {
    value=normalizeWorkspace(value);
    if (typeof value !== 'string' || value.length > 2048 || !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value)) return;
    const id=key+':'+value; if(!seen.has(id)) {seen.add(id);hints.push({[key]:value});}
  };
  const visit = (value, depth = 0) => {
    if(depth>8) return;
    if(typeof value==='string') {
      try { if(value.trim().startsWith('{')) visit(JSON.parse(value),depth+1); } catch(_) {}
      for(const m of value.matchAll(/\b(workdir|work_dir|cwd)["']?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)) {
        try {add('workdir',m[2][0]==='"'?JSON.parse(m[2]):m[2].slice(1,-1).replace(/\\\\/g,'\\'));} catch(_) {}
      }
      for(const m of value.matchAll(/(?:^|[;&\n]|\b)(?:cd(?:\s+\/d)?|Set-Location|Push-Location)\s+(?:(?:-LiteralPath|-Path)\s+)?("[^"\r\n]+"|'[^'\r\n]+'|[a-z]:[\\/][^\s;&]+|\/[^\s;&]+)/gi)) add('workdir',m[1].replace(/^["']|["']$/g,''));
      return;
    }
    if(!value || typeof value!=='object') return;
    for(const [key,v] of Object.entries(value)) {
      if(/^(workdir|work_dir|cwd)$/.test(key)) add('workdir',v);
      else if(/^(file_path|filePath|path)$/.test(key)) add('file_path',v);
      else if(typeof v==='object'||typeof v==='string') visit(v,depth+1);
    }
  };
  visit(input); return hints.slice(0,16);
}
function readSession(value, { limit = 18, maxBytes = MAX_BYTES } = {}) {
  const ref = parseRef(value);
  limit = Math.max(2, Math.min(60, Number(limit) || 18));
  maxBytes = Math.max(4096, Math.min(MAX_BYTES, Number(maxBytes) || MAX_BYTES));
  const result = { ...ref, project: '', title: '', messages: [], workspaceHints: [], truncated: false };
  if (ref.kind === 'zcode' || ref.kind === 'cursor') {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(ref.file, { readOnly: true });
    try {
      if (ref.kind === 'zcode') {
        const session = db.prepare('select directory,title from session where id=?').get(ref.id);
        if (!session) throw new Error('指定的 ZCode 会话不存在');
        result.project = session.directory || ''; result.title = session.title || '';
        // 即使尾部消息全是汇报，也从同一会话最近的工具调用取有界路径证据。
        const inputs = db.prepare("select substr(json_extract(data,'$.state.input'),1,16384) input from part where session_id=? and json_valid(data) and json_extract(data,'$.type')='tool' order by time_created desc,rowid desc limit 80").all(ref.id);
        for(const row of inputs.reverse()) result.workspaceHints.push(...workspaceHints(row.input));
        const rows = db.prepare('select id,data from message where session_id=? order by time_created desc,rowid desc limit ?').all(ref.id, limit + 1);
        result.truncated = rows.length > limit;
        for (const row of rows.slice(0, limit).reverse()) {
          const role = JSON.parse(row.data).role;
          if (!['user', 'assistant'].includes(role)) continue;
          const parts = db.prepare("select json_extract(data,'$.type') type, substr(json_extract(data,'$.text'),-?) text, length(json_extract(data,'$.text')) size, json_extract(data,'$.tool') tool, json_extract(data,'$.state.status') status, substr(json_extract(data,'$.state.output'),-2048) output from part where session_id=? and message_id=? and json_valid(data) and json_extract(data,'$.type') in ('text','tool') order by time_created,rowid limit 80").all(maxBytes, ref.id, row.id);
          const texts = parts.flatMap(p => {
            if (p.size > maxBytes) result.truncated=true;
            if (p.type==='tool') return [`[工具 ${p.tool||'unknown'}：${p.status||'未知状态'}，输出尾部]${p.output||''}`];
            return typeof p.text==='string' && p.text ? [p.text] : [];
          });
          if (texts.length) result.messages.push({ role, text: texts.join('\n') });
        }
      } else {
        const row = db.prepare('select value from cursorDiskKV where key=?').get('composerData:' + ref.id);
        if (!row) throw new Error('指定的 Cursor 会话不存在');
        const data = JSON.parse(row.value);
        result.title = data.name || '';
        const uri=data.workspaceIdentifier?.uri||data.workspaceUri;
        result.project = data.workspaceIdentifier?.fsPath || (typeof uri==='string'?uri:uri?.fsPath||uri?.path) || data.workspacePath || '';
        const headers = data.fullConversationHeadersOnly || [];
        result.truncated = headers.length > limit;
        const query = db.prepare('select substr(value,1,?) value from cursorDiskKV where key=?');
        for (const h of headers.slice(-limit)) {
          const bubble = query.get(maxBytes, `bubbleId:${ref.id}:${h.bubbleId}`);
          let text = ''; try { text = bubble ? JSON.parse(bubble.value).text || '' : ''; } catch (_) { result.truncated = true; }
          if (text) result.messages.push({ role: h.type === 1 ? 'user' : 'assistant', text });
        }
      }
    } finally { db.close(); }
  } else {
    const fd = fs.openSync(ref.file, 'r');
    const readAt = (offset,length) => { const b=Buffer.alloc(Math.max(0,length)); if(b.length&&offset>=0)fs.readSync(fd,b,0,b.length,offset); return b; };
    // DSH 每追加一段写一个独立 zstd 帧：按帧头切开逐帧解；半截帧跳过，不影响后面的
    const dshText = (buf) => {
      const decompress = require('node:zlib').zstdDecompressSync;
      if (!decompress) throw new Error('DSH 压缩会话需要 Node 24+ 的 zstd 支持，请使用普通交接或可用的解压工具');
      const positions=[]; for(let i=0;i+4<=buf.length;i++) if(buf.readUInt32LE(i)===0xFD2FB528) positions.push(i);
      if(!positions.length) return '';
      positions.push(buf.length); let text='', frame=positions[0];
      for(let i=1;i<positions.length;i++) {
        try { text += decompress(buf.subarray(frame,positions[i]),{maxOutputLength:MAX_BYTES*8}).toString('utf8'); frame=positions[i]; }
        catch(_) { /* 写入中的半截帧或假魔数，跳过 */ }
      }
      return text;
    };
    // 会话尾部至少要有一个带原文的用户消息，才算读到了「当前任务」；只有工具调用不算
    const DSH_USER = /"type":"user\/message"/;
    let tail;
    try {
      const size = fs.fstatSync(fd).size;
      if (ref.kind === 'dsh') {
        // session 事件（带 cwd）只写在文件头，尾部窗口里通常已经没有它：工作区得单独从头里取，
        // 否则 DSH 来源永远定位不到项目，只能让接手 AI 自己找
        const head = dshText(readAt(0, Math.min(size, 65536)));
        for(const line of head.split(/\r?\n/)) { try { const d=JSON.parse(line); if(d.type==='session'&&d.cwd) { result.project=d.cwd; break; } } catch(_) {} }
        // 尾部可能被大段工具输出占满，把用户/助手消息挤出窗口：逐级放大再读，最多 2 MiB
        for(let bytes=maxBytes;;bytes*=4) {
          const start=Math.max(0,size-bytes);
          tail=dshText(readAt(start,size-start));
          result.truncated=start>0;
          if(DSH_USER.test(tail)||start===0||bytes>=16*MAX_BYTES) break;
        }
      } else {
        const start = Math.max(0, size - maxBytes);
        if (start > 0) {
          const head = readAt(0, Math.min(MAX_BYTES,size));
          for(const line of head.toString('utf8').split(/\r?\n/)) { try { const d=JSON.parse(line); const p=d.payload||d.message||d; if(p.cwd||d.cwd) {result.project=p.cwd||d.cwd;break;} } catch(_) {} }
        }
        tail = readAt(start, size - start).toString('utf8');
        result.truncated = start > 0;
        if (start > 0) tail = tail.slice(tail.indexOf('\n') + 1);
      }
    } finally { fs.closeSync(fd); }
    for (const line of tail.split(/\r?\n/)) {
      try {
        const d = JSON.parse(line), p = d.payload || d.message || d;
        if (!result.project) result.project = p.cwd || d.cwd || '';
        if (p.type === 'function_call'||p.type==='custom_tool_call') {
          const input=p.arguments||p.input||'';
          result.workspaceHints.push(...workspaceHints(input));
          result.messages.push({role:'assistant',text:`[工具调用 ${p.name||'tool'}] ${String(input).slice(0,2048)}`});
        }
        if (p.type==='function_call_output'||p.type==='custom_tool_call_output') result.messages.push({role:'assistant',text:'[工具输出尾部] '+String(p.output||'').slice(-2048)});
        for(const c of Array.isArray(p.content)?p.content:[]) if(c.type==='tool_use'||c.type==='function_call') result.workspaceHints.push(...workspaceHints(c.input||c.arguments));
        if (ref.kind==='dsh') {
          const data=d.data||{};
          if(d.type==='tool/call') result.workspaceHints.push(...workspaceHints(data.arguments));
          if(d.type==='user/message' && (!data.source||data.source.kind==='user')) {const text=textOf(data.content);if(text)result.messages.push({role:'user',text});}
          if(d.type==='assistant/message') {
            const text=textOf(data.message?.content);
            if(text)result.messages.push({role:'assistant',text});
            // 工具型回复（reasoning + tool-call）没有正文：留一行调用名，接手方才知道刚才在干什么，
            // 也能保证尾部只剩工具回合时不至于「没有可读文本」
            else {
              const calls=(Array.isArray(data.message?.content)?data.message.content:[]).filter(c=>c&&/^tool[-_]call$/.test(String(c.type))).map(c=>c.name).filter(Boolean);
              if(calls.length)result.messages.push({role:'assistant',text:`[工具调用 ${[...new Set(calls)].join(', ')}]`});
            }
          }
          continue;
        }
        let role = p.role || (d.type === 'user' || d.type === 'assistant' ? d.type : '');
        const text = d.type === 'event_msg' && p.type === 'user_message' ? (role = 'user', p.message) : textOf(p.content);
        if (['user','assistant'].includes(role) && text) result.messages.push({ role, text });
      } catch (_) { /* partial/unknown line */ }
    }
    if (result.messages.length > limit) { result.messages = result.messages.slice(-limit); result.truncated = true; }
  }
  // Bound rendered text and retain the newest messages; oversized messages carry explicit truncation.
  let remaining = maxBytes;
  result.messages = result.messages.reverse().flatMap(m => {
    if (remaining <= 0) { result.truncated = true; return []; }
    if (Buffer.byteLength(m.text) > remaining) { m.text = Buffer.from(m.text).subarray(-remaining).toString('utf8'); m.truncated = true; result.truncated = true; }
    remaining -= Buffer.byteLength(m.text); return [m];
  }).reverse();
  if(ref.kind==='jsonl') {
    const metadata=codexMetadata(ref.file);
    if(metadata?.cwd)result.project=metadata.cwd;
    if(metadata?.title)result.title=metadata.title;
  }
  result.project=normalizeWorkspace(result.project);
  // 工具自己的配置目录不是项目；不能把目标 AI 开进内部工作区。
  result.cwd = result.project;
  result.workspaceHints = result.workspaceHints.slice(-160);
  if (/(?:^|[\\/])\.(?:codex|claude|zcode|dsh|handoff)(?:[\\/]|$)/i.test(result.project)) result.project='';
  if (!result.messages.length) throw new Error('指定会话尾部没有可读文本；请扩大指定会话范围或使用普通交接');
  return result;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), i = args.indexOf('--from');
    if (i < 0 || !args[i + 1]) throw new Error('用法：node session-reader.js --from <会话引用>');
    console.log(JSON.stringify(readSession(args[i + 1]), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { parseRef, readSession, normalizeWorkspace, referenceKey };
