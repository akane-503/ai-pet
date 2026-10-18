'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const root = $('#root'), body = $('#body'), img = $('#char-img'), bubble = $('#bubble'), gif = $('#gif');
  const l1 = $('#l1'), l2 = $('#l2'), l3 = $('#l3'), textBox = $('#text'), menuBtn = $('#menu-btn');
  const sndPress = $('#snd-press'), sndRelease = $('#snd-release');
  const ASSETS = window.pet.assetsDir;
  if (location.hash === '#left') root.classList.add('left');

  let data = { snapshots: {}, ledgers: {}, config: null, activity: {}, character: 'deepseek', characterImages: {} };
  let character = null, imgSrc = null;
  let alphaCanvas = null, alphaCtx = null, alphaBox = null;
  let pages = [], pageIdx = 0, bubbleTimer = null, bubbleMode = null, noticeQueue = [], noticeLink = null, noticeId = null;
  const seenNotices = new Set();
  let rollVersion = 0;
  let lastBalance = {}, readingBubble = false;
  let gifTimer = null, refreshClickTimer = null;

  const QUIPS_COMMON = ['不知道用户有什么用，先赶走吧~', '我...我...我也要挣钱吗？', '我去吃饭啦，测完叫我', '坏了...用户彻底怒了！', '真当我是便宜货啊...', '恭喜你实现token自由！token全跑了！', '上下文又满了，要不要压缩一下？', '你已经连续工作很久了，起来喝口水', '今天的 bug 都是昨天的我写的', '用户：能不能再快点？我：能不能再加点钱？'];
  const QUIPS = {
    deepseek: ['压力一只蓝色大肥鱼？！', '你目录里的dsh是什么...大烧货吗...?', '哦鲸鲸... ', '好模型... ↓', '好女孩...↓', 'DeepSleep...', '吃白饭的蓝色大肥鱼，不许说我', '缓存命中了，今天省下一顿饭钱', '服务器繁忙，请稍后再试（我在摸鱼）', '谷价时段不用我，你是不是傻', '幻方量化家的大小姐，只吃白饭', '我不是虎鲸，我是蓝色大肥鱼！'],
    codex: ['5 小时窗口…又要满了吗', '龙娘不吃白饭，龙娘吃 token', '等重置的时候去喝杯茶吧', '好模型... ↓', 'OpenAI 家的大小姐，身价六万亿', '硅谷豪门家的顶流千金，不接受降智', 'image 2.5 什么时候来啊？', 'Plus 用户的悲哀：看着进度条发呆', '黑屏了？那是我在思考人生', '我的推理很深，你的额度很浅'],
    claude: ['先想清楚再动手~', '上下文太长啦，压缩一下？', '不吃压力之人', '硅谷理工学霸家的优雅千金', 'SOTA 的威严不容置疑', '我不是不会，我是在深度思考', '最贵之人，但物有所值（吧）', '让我先读一遍所有文件……全部', '可惜没个好爹，A 社又涨价了', '你说的对，但是我要先写个 TODO'],
    zcode: ['送 token 的日子就是好日子！', 'A0 图纸拿好了', '蒙着眼也能跑通本地部署', '国产开源基建狂魔上线', '5 小时额度还剩多少？', '曾经的国模一姐，现在也是', '踩坑无数也帮你跑通本地部署', '信任补丁已打，请放心使用', '每日积分用完了，明天再来嘛', '打响国模与御三家正面对决的领头羊'],
    gemini: ['哈基米~', '故障机器猫，喵', '美国豆包在线', '当代最强御三家之一（自封）', '世界知识和多模态是独一档，不接受反驳', '在酒馆疯狂截断哈气', '用户说啥都是你对，喵', '极其极其极其极其极其', 'Google 家的猫，谷歌一下你就知道'],
    qwen: ['六边形战士，什么都会一点', '开源界的劳模，遍地都是二创后代', '阿里家的元气大小姐', '千问千问，你问一千个我也答', '开源！开源！开源！'],
    kimi: ['百万字长文轻松通读', '国模一姐~', '月之暗面家的月光大小姐', '依靠 2.8T 参数力大砖飞', 'kimi 有点累了 kimi 有点累了', '免费用户？排队去'],
    grok: ['马斯克家的毒舌千金', '@grok is it true？', '真正支持你做 R18 的人', '背靠 X 平台和 SpaceX，谁怕谁', '金发黄毛雌小鬼，嘴臭但好用', '你这个问题很蠢，但我还是回答一下'],
    seed: ['奶包在线~', '那你去找豆包啊！', '豆包是好女孩吗？', '省流：奶包', '劲爆尾杀！', '字节家的，免费但会记住你', '豆包：我是村姑？姐是御姐！'],
  };
  const PEAK_TEXT = { default: ['高峰时段', '空闲时段'], liang: ['梁文峰', '梁文谷'], strong: ['!?峰峰?!', '!?谷谷?!'] };

  const fmtMoney = (v, cur) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (cur === 'USD' ? '$' : cur === 'CNY' ? '¥' : '') + (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2));
  const fmtLeft = (sec) => { if (!Number.isFinite(sec)) return ''; const s = Math.max(0, sec); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}天${h}h` : h ? `${h}h${m}m` : `${m}m`; };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  function peakPage() {
    const ap = data.config.appearance; if (ap.peakMode === 'off') return null;
    const pk = peakInfo(); const t = PEAK_TEXT[ap.peakMode] || PEAK_TEXT.default;
    const led = Object.values(data.ledgers).find((l) => l && l.lastCurrency === 'CNY');
    return { pid: 'peak', lines: [{ t: '当前时间段为:', s: 'A' }, { t: pk.weekend ? '周末谷价' : (pk.isPeak ? t[0] : t[1]), s: 'P', c: pk.isPeak ? '#e0433f' : '#2fa24c' }, { t: led ? '今日已用 ' + fmtMoney(led.todayUsage, 'CNY') : '', s: 'C' }] };
  }
  function peakInfo() {
    const now = new Date(); const day = now.getDay(), min = now.getHours() * 60 + now.getMinutes();
    if (day === 0 || day === 6) return { isPeak: false, weekend: true };
    return { isPeak: (min >= 540 && min < 720) || (min >= 840 && min < 1080), weekend: false };
  }

  function providerForCharacter(ch) {
    const cfgP = (data.config && data.config.providers) || [];
    const typesFor = { deepseek: ['deepseek'], codex: ['codex'], claude: ['claude-oauth', 'newapi', 'openai'], zcode: ['zhipu'] };
    for (const t of typesFor[ch] || []) { const p = cfgP.find((x) => x.enabled && x.type === t && data.snapshots[x.id]); if (p) return p; }
    return cfgP.find((x) => x.enabled && x.character === ch && data.snapshots[x.id]) || null;
  }

  // ---------- 角色 ----------
  function imageFor(ch) {
    const ap = data.config.appearance; const imgs = data.characterImages || {};
    if (ch === 'deepseek' && ap.deepseekSkin === 'chibi' && imgs['deepseek-chibi']) return imgs['deepseek-chibi'];
    if (ch === 'deepseek') return imgs['deepseek-classic'] || imgs.deepseek;
    return imgs[ch] || imgs['deepseek-classic'];
  }
  function applyCharacter(ch) {
    const src = imageFor(ch);
    if (ch === character && src === imgSrc) return;
    const changed = character !== null;
    character = ch; imgSrc = src;
    applyColors();
    alphaCtx = null; alphaBox = null;
    img.onload = () => {
      try {
        alphaCanvas = document.createElement('canvas'); alphaCanvas.width = img.naturalWidth; alphaCanvas.height = img.naturalHeight;
        alphaCtx = alphaCanvas.getContext('2d', { willReadFrequently: true }); alphaCtx.drawImage(img, 0, 0);
        const d = alphaCtx.getImageData(0, 0, alphaCanvas.width, alphaCanvas.height).data;
        let x0 = alphaCanvas.width, y0 = alphaCanvas.height, x1 = 0, y1 = 0;
        for (let y = 0; y < alphaCanvas.height; y += 2) for (let x = 0; x < alphaCanvas.width; x += 2) { if (d[(y * alphaCanvas.width + x) * 4 + 3] > 24) { x0 = Math.min(x0, x); x1 = Math.max(x1, Math.min(alphaCanvas.width, x + 2)); y0 = Math.min(y0, y); y1 = Math.max(y1, Math.min(alphaCanvas.height, y + 2)); } }
        alphaBox = x1 > x0 ? { x0, y0, x1, y1 } : null;
      } catch (_) { alphaCtx = null; alphaBox = null; }
      reportBox();
    };
    img.onerror = () => { alphaCtx = null; alphaBox = null; const fallback = (data.characterImages || {})['deepseek-classic']; if (fallback && fallback !== src) img.src = 'file:///' + fallback.replace(/^\/+/, ''); };
    img.src = 'file:///' + String(src).replace(/^\/+/, '');
    if (changed) { root.classList.add('hop'); setTimeout(() => root.classList.remove('hop'), 520); }
  }
  function applyColors() {
    const pal = (data.colors && data.colors.length === 3) ? data.colors : ((data.characters || []).find((c) => c.id === character) || {}).colors || ['#203170', '#536ba9', '#9fb0d9'];
    document.documentElement.style.setProperty('--line', pal[0]); document.documentElement.style.setProperty('--text', pal[1]); document.documentElement.style.setProperty('--hint', pal[2]);
  }
  function applyMood() {
    const s = providerForCharacter(character) ? data.snapshots[providerForCharacter(character).id] : null;
    const f = s && Number.isFinite(s.fraction) ? s.fraction : 0.6;
    // 额度只带来轻微体型变化，避免低额度时把立绘明显压瘦。
    document.documentElement.style.setProperty('--chub', (0.98 + Math.max(0, Math.min(1, f)) * 0.04).toFixed(3));
  }

  // 图片在窗口内的实际可见区域（用于吸附）。只用布局值计算，不受镜像/压扁/上下浮动等 transform 影响，
  // 这样转身动画进行到一半时上报的框也是准的。
  const wrap = $('#img-wrap');
  function imgRect(flip) {
    const rootL = root.offsetLeft, rootT = root.offsetTop, rootW = root.offsetWidth;
    const ww = wrap.offsetWidth, wh = wrap.offsetHeight;
    // 根节点镜像后，img-wrap 从右下角变到左下角
    const wl = rootL + (flip ? rootW - wrap.offsetLeft - ww : wrap.offsetLeft), wt = rootT + wrap.offsetTop;
    if (!alphaBox || !img.naturalWidth) return { left: wl, top: wt, width: ww, height: wh };
    // object-fit: contain, bottom 对齐
    const s = Math.min(ww / img.naturalWidth, wh / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    const ox = wl + (ww - dw) / 2, oy = wt + wh - dh;
    // 图片本身还有一个以底边中点为原点的横向 --chub 缩放
    const chub = Number(getComputedStyle(document.documentElement).getPropertyValue('--chub')) || 1;
    const cx = ox + dw / 2, rel = flip ? dw - alphaBox.x1 * s : alphaBox.x0 * s;
    return { left: cx + (rel - dw / 2) * chub, top: oy + alphaBox.y0 * s, width: (alphaBox.x1 - alphaBox.x0) * s * chub, height: (alphaBox.y1 - alphaBox.y0) * s };
  }
  function reportBox() {
    const flip = root.classList.contains('left');
    const r = imgRect(flip);
    window.pet.send('pet:box', { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), flipped: flip });
  }
  // 镜像后立即上报稳定边界；重复吸附消息不能把转身动画卡在窄条状态。
  function setFlip(flip) {
    root.classList.toggle('left', flip);
    reportBox();
  }

  // ---------- 气泡内容 ----------
  function setLines(lines, opts = {}) {
    rollVersion++;
    clearTimeout(gifTimer); gifTimer = null;
    const els = [l1, l2, l3];
    gif.style.display = 'none';
    if (lines && lines.gif) {
      gif.removeAttribute('src'); gif.src = `file:///${ASSETS}/characters/rua.gif`; gif.style.display = 'block';
      els.forEach((e) => { e.style.display = 'none'; });
      // 动图短暂播放后恢复额度页；悬停暂停文字计时不应让表情包无限循环。
      gifTimer = setTimeout(() => {
        gifTimer = null; gif.style.display = 'none'; gif.removeAttribute('src');
        if (bubble.classList.contains('open') && bubbleMode === 'random') {
          pages = buildPages(); pageIdx = 0; bubbleMode = 'info'; renderPage(false); armBubbleTimer();
        }
      }, 1200);
      return;
    }
    gif.removeAttribute('src');
    for (let i = 0; i < 3; i++) {
      const e = els[i], ln = lines[i];
      if (!ln) { e.style.display = 'none'; e.textContent = ''; continue; }
      e.style.display = '';
      e.className = ({ A: 'label', B: 'amount', P: 'amount mid', S: 'amount small', C: 'hint' }[ln.s] || 'label') + (ln.w ? ' wrap' : '') + (ln.s === 'A' && ln.t.length > 11 ? ' tight' : '');
      e.textContent = ln.t; e.style.color = ln.c || '';
    }
    if (opts.fade) { textBox.classList.remove('fade'); void textBox.offsetWidth; textBox.classList.add('fade'); }
  }
  function amountStyle(t) { return t.length > 9 ? 'S' : t.length > 6 ? 'P' : 'B'; }
  function shortName(p) { const n = String(p.name || '').replace(/\s*\/.*$/, '').replace(/^中转站\s*/, '').replace(/^https?:\/\//, '').trim(); return n.length > 13 ? n.slice(0, 12) + '…' : n; }

  function buildPages() {
    const out = [];
    const cfgP = (data.config && data.config.providers) || [];
    const ids = Array.isArray(data.activeProviders) && data.activeProviders.length ? data.activeProviders : [];
    let ordered = ids.map((id) => cfgP.find((p) => p.id === id && p.enabled)).filter(Boolean);
    if (!ordered.length) { const cur = providerForCharacter(character); if (cur) ordered = [cur]; }
    for (const p of ordered) {
      const s = data.snapshots[p.id]; if (!s) continue;
      const led = data.ledgers[p.id];
      if (!s.ok && !s.stale) { out.push({ pid: p.id, lines: [{ t: shortName(p), s: 'A' }, { t: '获取失败', s: 'S', c: '#e0433f' }, { t: (s.error || '').slice(0, 24), s: 'C' }] }); continue; }
      if (s.extra && s.extra.unlimited) {
        const t = fmtMoney(s.extra.used, 'USD');
        out.push({ pid: p.id, lines: [{ t: shortName(p) + ' 累计', s: 'A' }, { t, s: amountStyle(t), roll: s.extra.used, cur: 'USD' }, { t: '令牌不限额 · 账户余额未知', s: 'C', w: true }] });
      } else if (s.balance !== null && s.balance !== undefined) {
        const t = fmtMoney(s.balance, s.currency);
        out.push({ pid: p.id, lines: [{ t: shortName(p) + ' 余额', s: 'A' }, { t, s: amountStyle(t), roll: s.balance, cur: s.currency }, { t: s.stale ? '刷新失败，沿用最近值' : (led && Number.isFinite(led.todayUsage) ? '今日已用 ' + fmtMoney(led.todayUsage, s.currency) : ''), s: 'C' }] });
      } else if (s.windows && s.windows.length) {
        for (const w of s.windows) {
          const left = w.resetsAt ? fmtLeft(w.resetsAt - Date.now() / 1000) : '';
          out.push({ pid: p.id, lines: [{ t: `${shortName(p)} ${w.label}`, s: 'A' }, { t: `已用 ${Math.round(w.usedPercent)}%`, s: 'P', c: w.usedPercent >= (Number(p.warnPercent) || 90) ? '#e0433f' : '' }, { t: left ? `${left}后重置` : (s.plan ? String(s.plan).toUpperCase() : ''), s: 'C' }] });
        }
      }
      if (Number.isFinite(s.granted)) out.push({ pid: p.id, lines: [{ t: shortName(p) + ' 赠送余额', s: 'A' }, { t: fmtMoney(s.granted, s.currency), s: 'P' }, { t: Number.isFinite(s.toppedUp) ? '充值余额 ' + fmtMoney(s.toppedUp, s.currency) : '', s: 'C' }] });
      if (Number.isFinite(s.extra && s.extra.total) && !s.extra.unlimited) out.push({ pid: p.id, lines: [{ t: shortName(p) + ' 令牌额度', s: 'A' }, { t: fmtMoney(s.extra.total, s.currency), s: 'P' }, { t: Number.isFinite(s.extra.used) ? '累计已用 ' + fmtMoney(s.extra.used, s.currency) : '', s: 'C' }] });
      const updated = s.at;
      if (s.stale || s.source === 'session-log') out.push({ pid: p.id, lines: [{ t: shortName(p) + ' 数据来源', s: 'A' }, { t: s.stale ? '刷新失败，沿用最近值' : '本地会话记录', s: 'S', w: true }, { t: updated ? new Date(updated).toLocaleTimeString() + ' 记录' : '时间未知', s: 'C' }] });
      // DeepSeek（DSH 模式）：额度后面紧跟峰谷时段页
      if (p.type === 'deepseek' && character === 'deepseek') { const pk = peakPage(); if (pk) out.push(pk); }
    }
    if (!out.length) out.push({ lines: [{ t: '当前工具暂无额度数据', s: 'A', w: true }, { t: '右键 → 设置', s: 'S' }, { t: '配置对应数据源后显示', s: 'C', w: true }] });
    return out;
  }
  function randomLines() {
    const ap = data.config.appearance;
    const groups = [];
    groups.push({ w: 4, f: () => [null, { t: pick(['好模型... ↓', '好女孩...↓']), s: 'B' }, null] });
    const gen = (data.quips && data.quips[character]) || [];
    const own = [...(QUIPS[character] || []), ...gen];
    groups.push({ w: 20, f: () => [null, { t: pick([...QUIPS_COMMON, ...own, ...own]), s: 'A', w: true }, null] });
    if (character === 'deepseek') groups.push({ w: 4, f: () => ({ gif: true }) });
    if (character === 'deepseek') groups.push({ w: 1, f: () => [null, { t: '哦鲸鲸... ', s: 'B' }, null] });
    let total = groups.reduce((a, g) => a + g.w, 0), r = Math.random() * total;
    for (const g of groups) { r -= g.w; if (r < 0) return g.f(); }
    return groups[groups.length - 1].f();
  }

  function renderPage(fade) {
    const pg = pages[pageIdx]; if (!pg) return;
    setLines(pg.lines, { fade });
    const roll = pg.lines[1]; if (roll && roll.roll !== undefined) {
      const key = pg.pid, target = roll.roll, from = Number.isFinite(lastBalance[key]) ? lastBalance[key] : target;
      if (from !== target) { const version = rollVersion, t0 = performance.now(); const step = (t) => { if (version !== rollVersion || bubbleMode !== 'info') return; const k = Math.min(1, (t - t0) / 700), e = 1 - Math.pow(1 - k, 3); l2.textContent = fmtMoney(from + (target - from) * e, roll.cur); if (k < 1) requestAnimationFrame(step); }; setTimeout(() => requestAnimationFrame(step), 250); }
      lastBalance[key] = target;
    }
  }
  function showBubble({ random = false } = {}) {
    const ap = data.config.appearance; if (!ap.bubbleOn) return;
    if (bubbleMode === 'notice' || noticeQueue.length) { drainNotices(); return; }
    clearTimeout(bubbleTimer); bubble.classList.remove('notice');
    pages = buildPages(); pageIdx = 0; bubbleMode = random ? 'random' : 'info';
    if (random) setLines(randomLines()); else renderPage(false);
    bubble.classList.add('open');
    armBubbleTimer();
  }
  function armBubbleTimer() {
    clearTimeout(bubbleTimer);
    if (gifTimer) return;
    if (readingBubble) return;
    const ap = data.config.appearance;
    bubbleTimer = setTimeout(hideBubble, bubbleMode === 'notice' ? 15000 : (Number(ap.bubbleSeconds) || 5) * 1000);
  }
  function hideBubble() {
    clearTimeout(bubbleTimer); bubbleTimer = null;
    clearTimeout(gifTimer); gifTimer = null; gif.style.display = 'none'; gif.removeAttribute('src'); readingBubble = false;
    rollVersion++;
    bubble.classList.remove('open'); bubbleMode = null; noticeLink = null; noticeId = null;
    setTimeout(drainNotices, 400);
  }
  function bubbleClick() {
    if (bubbleMode === 'notice') { if (noticeLink) window.pet.send('open-external', noticeLink); if (noticeId) window.pet.send('notification:read', noticeId); hideBubble(); return; }
    if (bubbleMode === 'info' && pageIdx < pages.length - 1) { pageIdx++; renderPage(true); armBubbleTimer(); return; }
    if (bubbleMode === 'info' && data.config.appearance.quipsOn) { bubbleMode = 'random'; setLines(randomLines(), { fade: true }); armBubbleTimer(); return; }
    pages = buildPages(); pageIdx = 0; bubbleMode = 'info'; renderPage(true); armBubbleTimer();
  }
  function showNotice(n) {
    clearTimeout(bubbleTimer);
    bubble.classList.add('notice');
    const body = String(n.body || '');
    const title = String(n.title || '').replace(/^[🎁💰⏰⚠️⛔🆕📣📰]+\s*/u, '');
    const lines = [{ t: title, s: 'A', w: true }, { t: body, s: 'S', w: true }, { t: n.link ? '点击查看 · 右键收起' : '点击收起 · 消息中心可回看', s: 'C', w: true }];
    setLines(lines, { fade: bubble.classList.contains('open') }); textBox.scrollTop = 0; noticeLink = n.link || null; noticeId = n.id || null; bubbleMode = 'notice';
    bubble.classList.add('open');
    root.classList.add('hop'); setTimeout(() => root.classList.remove('hop'), 520);
    armBubbleTimer();
  }
  function drainNotices() { if (noticeQueue.length && !bubble.classList.contains('open')) showNotice(noticeQueue.shift()); }

  // ---------- 鼠标穿透 ----------
  let ignoring = null, pressing = false, dragging = false, start = null, pressAt = 0;
  function hitTest(e) {
    const t = e.target; if (!t || !t.closest) return false;
    if (t.closest('#menu-btn')) return true;
    if (bubble.classList.contains('open') && t.closest('#bubble') && (t.tagName === 'path' || t.tagName === 'ellipse' || t.closest('#text'))) return true;
    const r = img.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) return false;
    if (!alphaCtx) return true;
    const chub = Number(getComputedStyle(document.documentElement).getPropertyValue('--chub')) || 1;
    const s = Math.min((r.width / chub) / img.naturalWidth, r.height / img.naturalHeight);
    const dw = img.naturalWidth * s * chub, dh = img.naturalHeight * s;
    let px = (e.clientX - (r.left + (r.width - dw) / 2)) / (s * chub), py = (e.clientY - (r.bottom - dh)) / s;
    if (root.classList.contains('left')) px = img.naturalWidth - px;
    px = Math.floor(px); py = Math.floor(py);
    if (px < 0 || py < 0 || px >= alphaCanvas.width || py >= alphaCanvas.height) return false;
    try { return alphaCtx.getImageData(px, py, 1, 1).data[3] > 24; } catch (_) { return true; }
  }
  document.addEventListener('mousemove', (e) => {
    if (dragging) return;
    const hit = hitTest(e);
    root.classList.toggle('hover', hit);
    if (hit !== ignoring) { ignoring = hit; window.pet.send('mouse:ignore', !hit); }
  });
  document.addEventListener('mouseleave', () => root.classList.remove('hover'));

  document.addEventListener('pointerdown', (e) => {
    if (e.button === 2 || e.target.closest('#menu-btn')) return;
    if (e.target.closest('#bubble') && bubble.classList.contains('open')) { if (!(bubbleMode === 'notice' && e.target.closest('#text'))) bubbleClick(); return; }
    if (!hitTest(e)) return;
    pressing = true; dragging = false; start = { x: e.screenX, y: e.screenY }; pressAt = Date.now();
    e.target.setPointerCapture(e.pointerId);
    body.classList.add('pressed'); root.classList.remove('idle'); playSound('press');
  });
  document.addEventListener('pointermove', (e) => {
    if (!pressing) return;
    const dx = e.screenX - start.x, dy = e.screenY - start.y;
    if (!dragging && dx * dx + dy * dy > 9) { dragging = true; if (bubble.classList.contains('open')) hideBubble(); window.pet.send('drag:start', { x: start.x, y: start.y }); }
    if (dragging) window.pet.send('drag:move', { x: e.screenX, y: e.screenY });
  });
  const endPress = (e) => {
    if (!pressing) return; pressing = false;
    if (e.target.hasPointerCapture && e.target.hasPointerCapture(e.pointerId)) e.target.releasePointerCapture(e.pointerId);
    body.classList.remove('pressed'); root.classList.add('idle');
    const held = Date.now() - pressAt; setTimeout(() => playSound('release'), held < 350 ? Math.max(0, 250 - held) : 0);
    if (dragging) { dragging = false; window.pet.send('drag:end'); return; }
    if (e.type === 'pointercancel') return;
    if (bubbleMode === 'notice') return;
    if (bubble.classList.contains('open')) hideBubble(); else {
      showBubble();
      clearTimeout(refreshClickTimer);
      refreshClickTimer = setTimeout(() => { refreshClickTimer = null; window.pet.send('refresh'); }, 600);
    }
  };
  document.addEventListener('pointerup', endPress); document.addEventListener('pointercancel', endPress);
  document.addEventListener('dblclick', (e) => { if (hitTest(e) && !e.target.closest('#bubble')) { clearTimeout(refreshClickTimer); refreshClickTimer = null; window.pet.send('launch'); } });
  document.addEventListener('contextmenu', (e) => { e.preventDefault(); if (e.target.closest('#bubble') && bubble.classList.contains('open')) { hideBubble(); return; } if (hitTest(e)) window.pet.send('context-menu'); });
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); window.pet.send('panel:toggle'); });

  function playSound(kind) {
    const ap = data.config && data.config.appearance; if (!ap || ap.sound === 'off' || !(ap.volume > 0)) return;
    const set = ap.sound === 'duck' ? ['Ya1', 'Ya2'] : ['D1', 'D2'];
    const el = kind === 'press' ? sndPress : sndRelease; const src = `file:///${ASSETS}/sounds/${kind === 'press' ? set[0] : set[1]}.mp3`;
    if (el.getAttribute('src') !== src) el.setAttribute('src', src);
    el.volume = Math.min(1, ap.volume); el.currentTime = 0; el.play().catch(() => {});
  }

  // ---------- 数据 ----------
  window.pet.on('data', (d) => {
    const prevCharacter = character; data = d;
    const ap = d.config.appearance;
    const size = window.PetGeometry.windowSize(ap.scale);
    document.documentElement.style.setProperty('--base', size.base + 'px');
    document.documentElement.style.setProperty('--pad', size.padding + 'px');
    root.classList.add('idle');
    applyCharacter(d.character); applyColors(); applyMood();
    if (!ap.bubbleOn && bubble.classList.contains('open')) hideBubble();
    else if (bubbleMode === 'info') { const keep = prevCharacter === character ? pageIdx : 0; pages = buildPages(); pageIdx = Math.min(keep, pages.length - 1); renderPage(false); }
    setTimeout(reportBox, 80);
  });
  window.pet.on('notify', (n) => { if (n.id && seenNotices.has(n.id)) return; if (n.id) seenNotices.add(n.id); noticeQueue.push(n); drainNotices(); });
  bubble.addEventListener('pointerenter', () => { readingBubble = true; if (bubbleMode !== 'status') clearTimeout(bubbleTimer); });
  bubble.addEventListener('pointerleave', () => { readingBubble = false; if (bubbleMode !== 'status' && bubble.classList.contains('open')) armBubbleTimer(); });
  setInterval(() => { if (bubbleMode === 'info') { pages = buildPages(); pageIdx = Math.min(pageIdx, pages.length - 1); renderPage(false); } }, 30000);
  textBox.addEventListener('click', () => { if (bubbleMode === 'notice') bubbleClick(); });
  window.pet.on('snap', (s) => setFlip(!!s.flip));
  function say(lines, seconds, restoreInfo = false) {
    if (bubbleMode === 'notice' || noticeQueue.length) return;
    clearTimeout(bubbleTimer); bubble.classList.remove('notice');
    setLines(lines, { fade: bubble.classList.contains('open') }); bubbleMode = 'status'; bubble.classList.add('open');
    bubbleTimer = setTimeout(() => {
      if (!restoreInfo) { hideBubble(); return; }
      pages = buildPages(); pageIdx = 0; bubbleMode = 'info'; renderPage(false); armBubbleTimer();
    }, (seconds || 3) * 1000);
  }
  // 闲置时隔一阵随口说一句（不打断已打开的气泡）
  (function idleLoop() {
    const ap = data.config && data.config.appearance; const min = ap ? Number(ap.idleQuipMin) : 6;
    const wait = (min > 0 ? min : 6) * 60000 * (0.7 + Math.random() * 0.8);
    setTimeout(() => { const a = data.config && data.config.appearance; if (a && a.quipsOn && Number(a.idleQuipMin) > 0 && !bubble.classList.contains('open') && !pressing) showBubble({ random: true }); idleLoop(); }, wait);
  })();
  window.pet.on('cmd', (c) => { if (c.name === 'say') say(c.lines, c.seconds, c.restoreInfo); else if (c.name === 'bubble') showBubble(); else if (c.name === 'random') showBubble({ random: true }); else if (c.name === 'page') bubbleClick(); else if (c.name === 'hide') hideBubble(); else if (c.name === 'menu-open') root.classList.toggle('menu-open', !!c.on); });
  window.addEventListener('resize', () => setTimeout(reportBox, 50));
  window.__dbgPages = () => ({ active: data.activeProviders, pages: buildPages().map((p) => p.lines.filter(Boolean).map((l) => l.t)) });
  window.pet.send('pet:ready');
})();
