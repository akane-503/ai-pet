'use strict';
(() => {
  const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  let flow=window.TransferFlow.initial(),data=null,busy=false,polls=0,workspaceInfo=null,probing=false,probeSequence=0;
  const act=action=>{flow=window.TransferFlow.change(flow,action);$('#status').textContent='';$('#more').open=false;if(action.type==='session'){workspaceInfo=null;probing=false;probeSequence++;}render();if(action.type==='session')locateWorkspace();};
  function render() {
    if(!data)return;
    for(const view of ['targets','sessions','modes'])$('#'+view).hidden=flow.view!==view;
    $('#back').hidden=flow.view==='targets';
    const tool=data.tools.find(t=>t.index===flow.target), session=flow.session;
    $('#heading').textContent=flow.view==='sessions'?'选择来源会话':flow.view==='modes'?`${tool?.label||'目标工具'} · 接手方式`:'转接工具';
    // 只在「看起来不能用」的时候解释一句：没读来源 / 没有别的工具可选
    const intro=!data.readable?'没识别到可读的来源工具：先打开来源工具、切到要转接的对话，再打开这个菜单。'
      :!data.tools.length?'没有可转接的其他工具：来源工具不会出现在这里，可在设置 → 打开工具里加一个入口。':'';
    $('#intro').textContent=intro;$('#intro').hidden=!intro;
    $('#source-name').textContent=session?.name||workspaceInfo?.name||data.autoName||data.sourceLabel||'尚未识别来源工具';
    $('#source-project').textContent=session?.project||data.sourceLabel||'请先使用来源工具，再打开转接窗口';
    $('.source').title=[session?.name||data.autoName||'',session?.project||data.sourceLabel||''].filter(Boolean).join('\n');
    $('#change-source').disabled=!data.readable;
    const project=workspaceInfo?.project||'';
    $('#workspace').textContent='工作区：'+(project?project.replace(/[\\/]+$/,'').split(/[\\/]/).pop():probing?'自动定位中…':'由接手 AI 自动定位');
    $('#workspace').title=project||'无需手动选目录；接手 AI 会先从来源记录定位项目，再开始工作';
    const targetScroll=$('#target-list').scrollTop,sessionScroll=$('#session-list').scrollTop;
    const query=$('#search').value.toLowerCase();
    $('#target-list').innerHTML=data.tools.filter(t=>t.label.toLowerCase().includes(query)).map(t=>`<button class="choice" data-target="${t.index}"><strong>${esc(t.label)}</strong><small>${esc(t.kindLabel)} · ${t.workspace?'带目录':'仅指令'}</small></button>`).join('')||`<p>${data.tools.length?'没有匹配的工具。':'没有可转接的其他工具。'}</p>`;
    const sessionQuery=$('#session-search').value.toLowerCase();
    const sessions=data.sessions.filter(s=>!sessionQuery||`${s.name} ${s.project}`.toLowerCase().includes(sessionQuery));
    $('#session-list').innerHTML=sessions.map(s=>`<button class="choice ${session?.file===s.file?'selected':''}" data-session="${esc(s.file)}"><strong>${esc(s.name)}</strong><small>${esc([s.project,s.fresh].filter(Boolean).join(' / '))}</small></button>`).join('')||(data.loading?'<p>正在读取来源会话…</p>':data.sessions.length?'<p>没有匹配的会话。</p>':'<p>没有读到会话。可返回使用自动识别，或重新打开此窗口检查。</p>');
    $('#target-list').scrollTop=targetScroll;$('#session-list').scrollTop=sessionScroll;
    $('#start-direct').disabled=busy||probing||!data.readable;
    $('#start-summary').disabled=busy||probing||!data.canSummarize;
    $('#summary-reason').textContent=data.canSummarize?'':data.readable?'未配置 DeepSeek Key，可在设置中配置。':'当前来源没有可用的本地会话读取器。';
    $('#start-file').hidden=!data.hasFile;
    // 用哪个交接文件要说出来：latest.txt 里最后一条可能来自别的项目
    $('#start-file').textContent=data.hasFile?`接手已有交接文件${data.fileDir?`（${data.fileDir}）`:''}`:'';
    $('#start-file').title=data.file?`用的是最近一次交接：${data.file}`:'';;
    if(data.colors) ['--line','--text','--hint'].forEach((key,i)=>document.documentElement.style.setProperty(key,data.colors[i]));
    requestSize();
  }
  let resizeFrame=0;
  function requestSize(){
    if(!data)return;
    cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{
      const menu=$('.menu'),list=flow.view==='targets'?$('#target-list'):flow.view==='sessions'?$('#session-list'):null;
      let height=menu.scrollHeight;
      if(list){
        const overhead=height-list.clientHeight;
        height=overhead+Math.min(248,list.scrollHeight);
        list.style.maxHeight=Math.max(40,Math.min(248,innerHeight-14-overhead))+'px';
      }else if(flow.view==='modes'){
        const mode=$('#modes'),overhead=height-mode.clientHeight;
        height=overhead+mode.scrollHeight;
        mode.style.maxHeight=Math.max(60,innerHeight-14-overhead)+'px';
      }
      window.pet.send('transfer:size',{height:Math.ceil(height)+14});
    });
  }
  $('#more').addEventListener('toggle',requestSize);
  window.addEventListener('resize',requestSize);
  async function locateWorkspace(){
    if(!data?.readable||probing)return;
    const sequence=++probeSequence,selection=flow.session?.file||null;probing=true;render();
    try{const result=await window.pet.invoke('transfer:workspace',{session:selection});if(sequence===probeSequence)workspaceInfo=result;}
    catch(_){if(sequence===probeSequence)workspaceInfo={project:'',delegated:true};}
    finally{if(sequence===probeSequence){probing=false;render();}}
  }
  async function load() {
    try {data=await window.pet.invoke('transfer:data');render();if(!workspaceInfo&&!probing)locateWorkspace();if(data.loading&&polls++<60)setTimeout(load,700);}
    catch(e){$('#status').textContent='读取失败：'+e.message;}
  }
  async function start(mode) {
    if(busy||probing)return;busy=true;render();$('#status').textContent='正在启动接手…';
    try {const r=await window.pet.invoke('transfer:start',{target:flow.target,mode,session:flow.session?.file||null});if(!r.ok)throw Error(r.error);window.pet.send('transfer:close');}
    catch(e){busy=false;render();$('#status').textContent=e.message;}
  }
  $('#target-list').addEventListener('click',e=>{const b=e.target.closest('[data-target]');if(b){act({type:'target',target:Number(b.dataset.target)});$('#more').open=false;$('#start-direct').focus();}});
  $('#session-list').addEventListener('click',e=>{const b=e.target.closest('[data-session]');if(b)act({type:'session',session:data.sessions.find(s=>s.file===b.dataset.session)});});
  $('#change-source').addEventListener('click',()=>act({type:'sessions'}));
  $('#auto-source').addEventListener('click',()=>act({type:'session',session:null}));
  $('#back').addEventListener('click',()=>act({type:'back'}));
  $('#search').addEventListener('input',render);
  $('#session-search').addEventListener('input',()=>{$('#session-list').scrollTop=0;render();});
  $('#start-direct').addEventListener('click',()=>start('direct'));
  $('#start-summary').addEventListener('click',()=>start('summary'));
  $('#start-file').addEventListener('click',()=>start('file'));
  $('#close').addEventListener('click',()=>window.pet.send('transfer:close'));
  window.addEventListener('keydown',e=>{if(e.key==='Escape'){if(flow.view==='targets')window.pet.send('transfer:close');else act({type:'back'});}});
  load();
})();
