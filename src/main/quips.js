'use strict';
// 用 DeepSeek API 定期给每个角色生成新梗（台词），存到 state.quips
const { request } = require('./http');

const PERSONA = {
  deepseek: '鲸鱼娘（DeepSeek 拟人，B站梗“蓝色大肥鱼”）：吃白饭的蓝色大肥鱼、服务器繁忙请稍后再试、缓存命中省钱、峰谷时段（谷价随便造/峰价省着用）、幻方量化家的大小姐、哦鲸鲸、DeepSleep、便宜又大碗、DSH 大烧货。',
  codex: '龙娘（GPT / Codex 拟人，OpenAI 家的大小姐）：名梗是“看额度”——Plus 用户盯着 5 小时窗口和 7 天窗口发愁、额度到了就干瞪眼等重置、降智、黑屏竞态、身价六万亿、硅谷豪门顶流千金、image 2.5 在哪。',
  claude: 'Claude 娘（Anthropic 拟人，硅谷理工学霸家的优雅千金）：名梗是“骂 A 社”——Anthropic 老是涨价、封号、限流、改额度、拒绝回答、可惜没个好爹；最贵之人、SOTA 的威严、先想清楚再动手、上下文压缩、写 TODO。',
  zcode: 'Zcode 狐娘（智谱 GLM 拟人，蒙眼工程师狐娘）：送 token 活动、免费 3 亿 token、国模一姐、信任补丁、A0 图纸、本地部署踩坑、每日积分用完了、Coding Plan Lite。',
  gemini: 'Gemini 猫娘（Google Gemini 拟人）：哈基米、故障机器猫、美国豆包、在酒馆疯狂截断哈气、极其极其极其、世界知识和多模态独一档、用户说啥都是你对。',
  qwen: '千问娘（阿里 Qwen 拟人）：六边形战士、开源界的劳模、遍地二创后代、阿里家的元气大小姐、什么都会一点。',
  kimi: 'Kimi 娘（月之暗面拟人）：百万字长文、国模一姐、月光大小姐、力大砖飞、kimi 有点累了、免费用户排队。',
  grok: 'Grok 娘（xAI 拟人，马斯克家的毒舌千金）：@grok is it true、嘴臭但好用、金发雌小鬼、背靠 X 和 SpaceX、什么都敢说。',
  seed: '豆包（字节豆包拟人，经典黑短发大眼睛形象）：奶包/奶豆、省流、劲爆尾杀、那你去找豆包啊、免费但会记住你、我是村姑？姐是御姐。',
};

function buildPrompt(charId, count, avoid) {
  return `你是一个桌宠台词写手。角色：${PERSONA[charId] || charId}。
请为这个角色写 ${count} 句桌宠气泡台词，要求：
- 第一人称，语气是这个角色本人在跟主人（用户）说话；要好笑、有梗，紧扣上面列出的名梗，可以自嘲、吐槽、撒娇、阴阳怪气。
- 每句 6~22 个字，纯中文为主，不要 emoji、不要引号、不要编号、不要解释。
- 句子之间风格多样，别重复同一个梗超过两次。
${avoid && avoid.length ? '- 避免和这些已有台词雷同：' + avoid.slice(0, 40).join(' / ') : ''}
只输出 JSON：{"lines": ["...", "..."]}`;
}

let thinkingSupported = null; // 是否接受 thinking:{type:'disabled'}（关掉推理，省 token 也快）
async function generateFor(cfg, charId, avoid = [], attempt = 0) {
  const base = String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const count = Math.max(5, Math.min(60, Math.round((Number(cfg.perCharacter) || 25) / (attempt + 1))));
  const payload = { model: cfg.model || 'deepseek-flash', temperature: 1.3, max_tokens: 8000, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: buildPrompt(charId, count, avoid) }] };
  if (thinkingSupported !== false) payload.thinking = { type: 'disabled' };
  let r = await request(base + '/chat/completions', { method: 'POST', timeoutMs: 120000, headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (r.status === 400 && payload.thinking && /thinking|unknown|invalid/i.test(r.text || '')) { thinkingSupported = false; delete payload.thinking; r = await request(base + '/chat/completions', { method: 'POST', timeoutMs: 120000, headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
  else if (r.ok && payload.thinking) thinkingSupported = true;
  if (!r.ok || !r.data) throw new Error(`HTTP ${r.status} ${(r.text || '').slice(0, 120)}`);
  const msg = r.data.choices && r.data.choices[0] && r.data.choices[0].message;
  const content = msg && msg.content;
  const finish = r.data.choices && r.data.choices[0] && r.data.choices[0].finish_reason;
  let lines = [];
  try { const j = JSON.parse(content); lines = Array.isArray(j.lines) ? j.lines : Array.isArray(j) ? j : []; }
  catch (_) {
    // 被截断或带了多余文字：尽量把引号里的句子抠出来
    const m = String(content || '').match(/"([^"\n]{4,40})"/g);
    lines = m ? m.map((x) => x.slice(1, -1)) : String(content || '').split(/\n+/).map((x) => x.replace(/^[\d\-\.、\s"“”]+|["“”\s]+$/g, '')).filter(Boolean);
  }
  lines = [...new Set(lines.filter((x) => typeof x === 'string').map((x) => x.trim()))].filter((x) => x.length >= 4 && x.length <= 40 && !/^lines?$/i.test(x) && !avoid.includes(x)).slice(0, count);
  if (!lines.length) {
    if (attempt < 2) return generateFor(cfg, charId, avoid, attempt + 1); // 推理吃光 token：减半数量再试
    throw new Error(`没解析出台词 (finish=${finish}, content=${String(content || '').slice(0, 60)})`);
  }
  return lines;
}

async function generateAll(cfg, characterIds, existing, onProgress) {
  const out = {}; const errors = {};
  for (const id of characterIds) {
    try { out[id] = await generateFor(cfg, id, (existing && existing[id]) || []); onProgress && onProgress(id, out[id].length); }
    catch (e) { errors[id] = e.message; onProgress && onProgress(id, 0, e.message); }
  }
  return { quips: out, errors };
}

function dueCharacters(cfg, state, ids, now = Date.now()) {
  const interval = Math.max(1, Number(cfg.intervalHours) || 24) * 3600000;
  return ids.filter((id) => {
    const failed = (state.failed || []).includes(id);
    if (failed && now < (state.retryAfter || 0)) return false;
    const at = (state.characterAt || {})[id] || (!failed ? state.updatedAt : 0) || 0;
    return now - at >= interval;
  });
}
module.exports = { generateAll, generateFor, dueCharacters, PERSONA };
