/** Shared browser controls; all rendering, synthesis and output run on the server. */
const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
let snapshot = {}, authenticated = false, eventSource = null, configDirty = false, hydrated = false, assets = [], activeTab = 'director', polling = null, previewTimer = null, setupTimer = null, toastTimer = null;
let channelsTimer = null, channelsFocus = null, channelsFrameRevision = 0;
let audioMonitor = null, monitorEnabled = false, monitorReconnect = null;
let microphone = null, microphoneEnabled = false, microphoneBusy = false, recordingParts = [], preRoll = [], phraseStarted = 0, lastVoicedAt = 0, voicedDuration = 0, phraseActive = false, asrAbort = null;
const stageLabels = {idle:'准备就绪',ended:'已结束',cue:'固定口播',question:'人机对话',stopped:'已停止',opening:'开场欢迎',source:'内容讲解',lecture:'内容讲解',comment:'弹幕回应',engagement:'互动引导','flash-sale':'秒杀提醒',sale:'秒杀提醒',lottery:'口令抽奖','lottery-announcement':'抽奖说明','lottery-wait':'等待参与','lottery-result':'开奖播报',closing:'收尾告别',waiting:'等待就绪',advancing:'翻页',error:'需要处理',paused:'已暂停',scheduling:'调度下一轮'};
const stageDescriptions = {idle:'配置素材与模型后，开始你的直播。',stopped:'当前没有 AI 播报，开始后会从开场进入分享。',opening:'先欢迎观众，再自然进入本场主题。',source:'讲一个完整段落，再检查弹幕、互动和翻页。',comment:'查看近期未读弹幕，回应共同问题或具体观众。',engagement:'适量提问或邀请点赞、分享，然后回到内容。','flash-sale':'参与提醒后继续当前主题，二维码独立到期收起。',sale:'参与提醒后继续当前主题，二维码独立到期收起。',closing:'告别完整播完后，停止 AI 播报。',advancing:'正在等待下一页画面与内容。',error:'检查错误提示和运行检查，修复后再继续。'};
function pathGet(object, path) { return path.split('.').reduce((value,key) => value?.[key], object); }
function pathSet(object, path, value) { const keys = path.split('.'); let current = object; for (const key of keys.slice(0,-1)) current = current[key] ||= {}; current[keys.at(-1)] = value; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function stateValue(value) { if (value?.state?.config) return value.state; if (value?.status?.config) return value.status; return value; }
function notify(message, error = false) { $('toast').textContent = String(message); $('toast').style.borderColor = error ? '#bd6579' : ''; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, error ? 7000 : 3500); }
function showError(error) { const text = error?.message || String(error); $('global-alert').textContent = text; $('global-alert').hidden = false; notify(text,true); logActivity(text,true); }
function markDirty() { configDirty = true; $('settings-dirty').hidden = false; }
async function api(path, {method = 'GET',body,signal,headers={}}={}) {
  const options = {method,cache:'no-store',credentials:'same-origin',headers:{...headers},signal};
  if (body !== undefined) { if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) options.body = body; else { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); } }
  const response = await fetch(path, options);
  let value; try { value = await response.json(); } catch { throw new Error(`服务返回了无法读取的响应（${response.status}）`); }
  if (response.status === 401 && authenticated) { showLogin(); throw new Error('登录已过期，请重新登录。'); }
  if (!response.ok || value?.ok === false) throw new Error(value.error || value.message || `操作失败（${response.status}）`);
  return value;
}
function useTab(name) {
  activeTab = name;
  $$('[data-tab]').forEach(button => { button.classList.toggle('active',button.dataset.tab === name); button.setAttribute('aria-selected',String(button.dataset.tab === name)); });
  $$('[data-panel]').forEach(panel => panel.hidden = panel.dataset.panel !== name);
  if (name === 'broadcast') refreshSetup().catch(showError);
  if (name === 'materials') refreshAssets().catch(showError);
  if (name === 'director') updatePreviews();
}
function beijingInput(value) { if (value === null || value === undefined || value === '') return ''; const date = new Date(value); return Number.isFinite(date.getTime()) ? new Date(date.getTime()+8*3600000).toISOString().slice(0,16) : ''; }
function beijingValue(value) { if (!value) return null; const time = Date.parse(value+':00+08:00'); if (!Number.isFinite(time)) throw new Error('请填写有效的北京时间'); return time; }
function changedConfig(previous,next){if(JSON.stringify(previous)===JSON.stringify(next))return undefined;if(next&&typeof next==='object'&&!Array.isArray(next)){const result={};for(const [key,value] of Object.entries(next)){const changed=changedConfig(previous?.[key],value);if(changed!==undefined)result[key]=changed;}return Object.keys(result).length?result:undefined;}return next;}
function readForm() {
  const patch = {}, secrets = {};
  for (const input of $$('[data-config]')) {
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.hasAttribute('data-lines')) value = input.value.split(/\n+/).map(text=>text.trim()).filter(Boolean);
    else if (input.hasAttribute('data-beijing')) value = beijingValue(input.value);
    else if (input.type === 'number' || input.type === 'range' || input.tagName === 'SELECT' && ['sale.intervalMinutes'].includes(input.dataset.config)) {
      value = Number(input.value);
      if (!Number.isFinite(value)) throw new Error('请检查数字设置');
      if (input.dataset.scale) value *= Number(input.dataset.scale);
    } else value = input.value.trim();
    pathSet(patch,input.dataset.config,value);
  }
  patch.llm.fallbacks = $$('[data-fallback-slot]').map(row=>{const baseUrl=row.querySelector('[data-fallback-url]').value.trim(),model=row.querySelector('[data-fallback-model]').value.trim();if(!baseUrl&&!model)return null;if(!baseUrl||!model)throw new Error('备用通道的 API 地址和模型名称需要一起填写');return {baseUrl,model,keyName:row.dataset.keyName};}).filter(Boolean);
  for (const input of $$('[data-secret]')) if (input.value.trim()) secrets[input.dataset.secret] = input.value.trim();
  patch.cues = [...document.querySelectorAll('.cue-edit-row')].map((row,index)=>({...snapshot.config?.cues?.find(cue=>cue.id===row.dataset.id),id:row.dataset.id,title:row.querySelector('[data-cue-title]').value.trim()||'口播 '+(index+1),text:row.querySelector('[data-cue-text]').value.trim(),audioUrl:row.querySelector('[data-cue-audio]').value})).filter(cue=>cue.text||cue.audioUrl);
  return {patch:changedConfig(snapshot.config||{},patch)||{},secrets};
}
function hydrate(config, savedSecrets={}) {
  if (configDirty) return;
  for (const input of $$('[data-config]')) {
    const value = pathGet(config,input.dataset.config);
    if (value === undefined) continue;
    if (input.type === 'checkbox') input.checked = value === true;
    else if (input.hasAttribute('data-lines')) input.value = Array.isArray(value) ? value.join('\n') : value || '';
    else if (input.hasAttribute('data-beijing')) input.value = beijingInput(value);
    else input.value = input.dataset.scale ? Number(value)/Number(input.dataset.scale) : value ?? '';
  }
  renderFallbackEditor(config.llm?.fallbacks||[],savedSecrets);
  for (const input of $$('[data-secret]')) { input.value=''; input.placeholder=savedSecrets[input.dataset.secret] ? '已保存 · 留空保持不变' : '尚未配置'; }
  $('quick-bgm').value = config.bgm?.asset || '';
  $('quick-bgm-volume').value = config.bgm?.volume ?? .12;
  renderCueEditor(config.cues||[]);
  hydrated = true; updateRangeLabels(); updateTtsFields();
}
function renderFallbackEditor(routes,savedSecrets) {
  const signature=JSON.stringify([routes,savedSecrets]);if($('fallback-editor').dataset.signature===signature)return;$('fallback-editor').dataset.signature=signature;
  $('fallback-editor').innerHTML=Array.from({length:3},(_,index)=>{const route=routes[index]||{},keyName=route.keyName||'fallbackKey'+(index+1);return `<div class="fallback-row" data-fallback-slot="${index}" data-key-name="${escapeHtml(keyName)}"><h4>备用通道 ${index+1}</h4><label>API 地址<input data-fallback-url value="${escapeHtml(route.baseUrl||'')}" placeholder="https://…/v1"></label><label>模型名称<input data-fallback-model value="${escapeHtml(route.model||'')}" placeholder="模型供应商提供的模型 ID"></label><label>API Key<input type="password" data-secret="${escapeHtml(keyName)}" autocomplete="new-password" placeholder="${savedSecrets[keyName]?'已保存 · 留空保持不变':'尚未配置'}"></label></div>`;}).join('');
  for(const input of $('fallback-editor').querySelectorAll('input'))input.addEventListener('input',markDirty);
}
function updateRangeLabels() {
  $('speech-speed-label').textContent = `${Number(document.querySelector('[data-config="tts.speed"]').value || 1).toFixed(2)}×`;
  $('comment-frequency-label').textContent = `${document.querySelector('[data-config="live.commentFrequency"]').value || 0}%`;
  $('bgm-volume-label').textContent = `${Math.round(Number($('quick-bgm-volume').value)*100)}%`;
  $('vad-threshold-label').textContent = `${(Number($('vad-threshold').value)*100).toFixed(1)}%`;
}
function updateTtsFields() { const provider = $('tts-provider').value; $('tencent-fields').hidden=provider!=='tencent'; $('compatible-tts-fields').hidden=provider!=='openai'; $('tts-demo-hint').hidden=provider!=='demo'; }
async function saveSettings({quiet=false}={}) {
  const body = readForm();
  const result = await api('/api/config',{method:'PUT',body});
  configDirty=false;$('settings-dirty').hidden=true;
  $$('[data-secret]').forEach(input=>input.value='');
  const value=stateValue(result);if(value?.config)applyState(value);else await refreshState();
  if(!quiet)notify('设置已保存');return result;
}
function readStage(director={}) { const stage = director.stage?.id || director.stage || director.stateMachine?.current?.id || director.phase || 'idle'; return typeof stage === 'string' ? stage : 'idle'; }
function timeLabel(seconds) { const total = Math.max(0,Math.floor(Number(seconds)||0));return [Math.floor(total/3600),Math.floor(total/60)%60,total%60].map(n=>String(n).padStart(2,'0')).join(':'); }
function level(value) { const v=Math.max(0,Math.min(1,Number(value)||0));return {width:Math.min(100,Math.sqrt(v)*120),label:v>.0001?`${Math.max(-80,20*Math.log10(v)).toFixed(1)} dB`:'−∞ dB'}; }
function updateMeter(audio={}) { for(const [name,value] of [['voice',audio.voiceRms],['bgm',audio.bgmRms],['output',audio.rms]]){const result=level(value);$(name+'-meter').style.width=result.width+'%';$(name+'-level').textContent=result.label;} }
function updateOutput(media={}) {
 const output=media.output||{}, state=output.state||'stopped',active=output.active===true, pending=['preparing','starting','reconnecting'].includes(state),on=active||pending,recordOnly=output.mode==='record';
 $('output-pill').className='status-pill'+(active?' live':'');$('output-pill').innerHTML=`<i></i>${active?(recordOnly?'正在录制':'正在推流'):pending?'正在连接输出':'未推流'}`;
 $('output-mode').textContent=active?(recordOnly?'本地录制':output.mode==='both'?'RTMP + 录制':'RTMP 输出'):pending?'编码器连接中':'未连接平台';
 $('output-start').hidden=on;$('output-stop').hidden=!on;
 $('output-duration').textContent=timeLabel(output.seconds ?? (output.startedAt?(Date.now()-output.startedAt)/1000:0));
 $('fps-value').textContent=Number.isFinite(media.currentFps)?Number(media.currentFps).toFixed(1):'—';
 $('dropped-value').textContent=String(media.droppedFrames||0);
 $('program-resolution').textContent=media.width&&media.height?`${media.width} × ${media.height} · ${media.fps||'—'} FPS`:media.initialized?'渲染器已就绪':'后台正在准备';
 $('output-error').textContent=output.error||media.error||'';$('output-error').hidden=!$('output-error').textContent;
 updateMeter(media.audio);
}
function renderComments(director={}) {
 let comments=director.recentComments||director.comments?.recent||director.comments||director.commentQueue?.recent||[];if(!Array.isArray(comments))comments=[];
 const count=director.commentCount ?? director.comments?.buffered ?? director.commentQueue?.buffered ?? comments.length;$('comment-count').textContent=`${count} 条`;
 $('comment-list').innerHTML=comments.length?comments.slice(-15).map(item=>`<div class="comment"><strong>${escapeHtml(item.nickname||item.user||'观众')}</strong>${escapeHtml(item.content||item.text||'')}</div>`).join(''):'<p class="empty-copy">尚未收到弹幕，连接采集端后会显示在这里。</p>';
}
function renderCues(config={}) {
 const cues=Array.isArray(config.cues)?config.cues:[];
 const signature=JSON.stringify(cues.map(item=>[item.id,item.title,item.text,item.audioUrl]));
 if($('cue-list').dataset.signature===signature)return;$('cue-list').dataset.signature=signature;
 $('cue-list').innerHTML=cues.length?cues.map(cue=>`<div class="cue-item"><div><strong>${escapeHtml(cue.title||cue.id||'固定口播')}</strong><small>${cue.audioUrl?'预录音 · 点击播放':'文字口播 · 服务端合成'}</small></div><button data-cue="${escapeHtml(cue.id)}">▶ 播报</button></div>`).join(''):'<p class="empty-copy">导入口播素材后，这里会出现可直接播放的固定段落。</p>';
}
let speechSignature='';
function applyState(value) {
 if(!value?.config)return;snapshot=value;
 const director=value.director||{},media=value.media||{},stage=readStage(director),paused=director.paused===true,running=director.running===true;
 $('current-stage').textContent=paused?'已暂停':director.stageLabel||stageLabels[stage]||stage;
 $('stage-description').textContent=director.reason||director.stageReason||director.stateMachine?.current?.reason||stageDescriptions[stage]||'完整口播结束后按优先级选择下一步。';
 $('stage-dot').classList.toggle('active',running&&!paused);
 $$('[data-stage-node]').forEach(node=>node.classList.toggle('current',node.dataset.stageNode===stage));
 $('live-start').disabled=running;$('live-pause').hidden=paused;$('live-pause').disabled=!running;$('live-resume').hidden=!paused;
 const error=director.error||media.error;if(error){$('global-alert').textContent=error;$('global-alert').hidden=false;}else $('global-alert').hidden=true;
 $('footer-status').textContent=paused?'AI 已暂停 · 后台状态共享':running?`AI 播报中 · ${stageLabels[stage]||stage}`:'AI 已停止 · 等待场控开始';
 const slide=media.slide||director.presentation||director.slide||{};
 $('slide-position').textContent=slide.pageNumber?`第 ${slide.pageNumber} / ${slide.pageCount||'—'} 页`:'尚未载入演示稿';
 $('slide-title').textContent=slide.title||'内容载入后，小云会结合讲解笔记分享';
 const sale=director.sale||director.flashSale||{},remaining=sale.remainingSeconds ?? (sale.expiresAt?Math.ceil((sale.expiresAt-Date.now())/1000):0);
 $('sale-status').textContent=sale.active?`剩余 ${Math.max(0,Math.floor(remaining/60))}:${String(Math.max(0,remaining%60)).padStart(2,'0')}`:sale.queued?'提醒已排队':'未展示';
 const lottery=director.lottery?.current||director.lottery||{};
 $('lottery-status').textContent=lottery.winner?`${lottery.winner.nickname||lottery.winner.id||lottery.winner} · ${lottery.prize||'中奖'}`:lottery.state?({queued:'抽奖已排队',announcing:'正在说明参与方式',waiting:'正在收集参与弹幕',result:'正在播报结果',completed:'本轮抽奖已完成'}[lottery.state]||'抽奖记录已保存'):'完整口播结束后进入抽奖环节';
 $('demo-badge').hidden=value.config.tts?.provider!=='demo';
 $$('[data-layout]').forEach(button=>button.classList.toggle('selected',button.dataset.layout===(value.config.scene?.layout?.mode||'standard')));
 renderComments(director);renderHistory(director.history||[]);renderCues(value.config);updateOutput(media);hydrate(value.config,value.secrets||{});
 const speech=director.currentSpeech||director.speech;
 const text=typeof speech==='string'?speech:speech?.text;
 if(text&&text!==speechSignature){speechSignature=text;appendMessage('assistant',text);}
}
async function refreshState(){if(!authenticated)return;try{const value=await api('/api/state');applyState(stateValue(value));}catch(error){if(authenticated)throw error;}}
function appendMessage(role,text){const log=$('conversation-log');log.querySelector('.empty-copy')?.remove();const entry=document.createElement('div');entry.className='message '+(role==='user'?'user':role==='error'?'error-message':'assistant');const title=document.createElement('strong');title.textContent=role==='user'?'你':role==='error'?'提示':snapshot.config?.identity?.name||'小云';const paragraph=document.createElement('span');paragraph.textContent=String(text).slice(0,2400);entry.append(title,paragraph);log.append(entry);while(log.children.length>60)log.firstElementChild.remove();log.scrollTop=log.scrollHeight;}
const seenHistory=new Set();
function renderHistory(rows){for(const row of rows){const key=String(row.at)+':'+row.to+':'+row.reason;if(seenHistory.has(key))continue;seenHistory.add(key);logActivity((stageLabels[row.to]||row.to||'状态变化')+' · '+(row.reason||''));}if(seenHistory.size>300){const recent=[...seenHistory].slice(-100);seenHistory.clear();for(const key of recent)seenHistory.add(key);}}
function logActivity(text,error=false){const log=$('activity-log');log.querySelector('.empty-copy')?.remove();const entry=document.createElement('div');entry.className='activity-entry'+(error?' error-entry':'');const time=document.createElement('time');time.textContent=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date());const message=document.createElement('span');message.textContent=String(text).slice(0,400);entry.append(time,message);log.prepend(entry);while(log.children.length>120)log.lastElementChild.remove();}
async function runAction(action,extra={},button=null){
 if(button?.disabled)return;
 const wasDisabled=button?.disabled;if(button)button.disabled=true;
 try{
  if(['output.start','live.start'].includes(action)&&configDirty)await saveSettings({quiet:true});
  const result=await api('/api/action',{method:'POST',body:{action,...extra}});const value=stateValue(result);if(value?.config)applyState(value);else await refreshState();
  const labels={'live.start':'开始 AI 播报','live.pause':'AI 已暂停','live.resume':'AI 继续播报','live.restart':'已安排从头播报','live.finish':'已安排整段播完后告别','live.stop':'AI 已停止','sale.queue':'秒杀提醒已排队','sale.hide':'已收起秒杀码','lottery.queue':'抽奖已排队','presentation.next':'已翻到下一页','presentation.prev':'已翻到上一页','presentation.first':'已回到第一页','output.start':'后台正在启动编码与输出','output.stop':'输出已停止','bgm.set':'背景音乐已更新','cue.play':'固定口播已安排'};
  if(labels[action]){notify(labels[action]);logActivity(labels[action]);}return result;
 }catch(error){showError(error);throw error;}finally{if(button)button.disabled=wasDisabled||false;}
}
function installEvents(){
 eventSource?.close();eventSource=new EventSource('/api/events');
 eventSource.onopen=()=>{$('connection-pill').className='status-pill ok';$('connection-pill').innerHTML='<i></i>后台已连接';};
 eventSource.onerror=()=>{$('connection-pill').className='status-pill';$('connection-pill').innerHTML='<i></i>正在重连';};
 const accept=event=>{try{const value=JSON.parse(event.data);const type=value.type||event.type,payload=value.payload??value.data??value;
  if(payload?.config)applyState(payload);
  else if(type==='state'||type==='snapshot')applyState(stateValue(payload));
  else if(type==='director'){snapshot.director=payload;applyState(snapshot);}
  else if(type==='media'){snapshot.media=payload;applyState(snapshot);}
  else if(type==='meter'){if(snapshot.media)snapshot.media.audio=payload;updateMeter(payload);}
  else if(type==='speech'){const text=payload.text||payload.speech;if(text&&text!==speechSignature){speechSignature=text;appendMessage('assistant',text);}}
  else if(type==='error'){showError(payload.error||payload.message||'后台发生错误');}
  else if(type==='log'||type==='activity')logActivity(payload.message||payload.text||String(payload));
 }catch{ /* Ignore incomplete reconnect events; polling reconciles the shared state. */ }};
 eventSource.onmessage=accept;for(const name of ['state','snapshot','director','media','meter','speech','error','log','activity'])eventSource.addEventListener(name,accept);
}
function loadPreview(id,empty,url){const preloader=new Image();preloader.onload=()=>{$(id).src=preloader.src;$(id).hidden=false;$(empty).hidden=true;};preloader.onerror=()=>{if(!$(id).getAttribute('src')){$(id).hidden=true;$(empty).hidden=false;}};preloader.src=url+'?t='+Date.now();}
function updatePreviews(){if(authenticated&&activeTab==='director'&&!document.hidden){loadPreview('program-preview','program-empty','/api/frame.jpg');loadPreview('slide-preview','slide-empty','/api/slide.jpg');}}
async function refreshAssets(){const value=await api('/api/assets');assets=Array.isArray(value)?value:value.assets||value.items||[];renderAssets();}
function renderAssets(){
 $('asset-count').textContent=`${assets.length} 项`;
 $('asset-list').innerHTML=assets.length?assets.map(asset=>`<div class="asset-item"><span>${asset.type==='audio'?'♫':['html','pdf','presentation'].includes(asset.type)?'▤':'▧'}</span><div><strong>${escapeHtml(asset.name||asset.id)}</strong><small>${escapeHtml(asset.type||'素材')} · ${Number(asset.size||0)>1048576?(Number(asset.size)/1048576).toFixed(1)+' MB':Math.round(Number(asset.size||0)/1024)+' KB'}</small></div><a href="${escapeHtml(asset.url)}" target="_blank" rel="noopener">查看 ↗</a></div>`).join(''):'<p class="empty-copy">上传的素材仅保存在你的服务中。</p>';
 const music=assets.filter(asset=>asset.type==='audio'||/\.(mp3|wav|m4a|ogg|flac)$/i.test(asset.url||''));
 for(const select of document.querySelectorAll('[data-cue-audio]')){const current=select.value;select.innerHTML=cueAudioOptions(current);}
 for(const id of ['quick-bgm','settings-bgm']){const select=$(id),current=select.value||snapshot.config?.bgm?.asset||'';select.innerHTML='<option value="">不播放背景音乐</option>'+music.map(asset=>`<option value="${escapeHtml(asset.url)}">${escapeHtml(asset.name||asset.id)}</option>`).join('');if(current&&!music.some(asset=>asset.url===current)){const option=document.createElement('option');option.value=current;option.textContent=current.split('/').at(-1);select.append(option);}select.value=current;}
}
function cueAudioOptions(value='') {
 const audio=assets.filter(asset=>asset.type==='audio'||/\.(mp3|wav|m4a|ogg|flac)$/i.test(asset.url||''));
 const options='<option value="">按文字合成</option>'+audio.map(asset=>`<option value="${escapeHtml(asset.url)}" ${asset.url===value?'selected':''}>${escapeHtml(asset.name||asset.id)}</option>`).join('');
 return value&&!audio.some(asset=>asset.url===value)?options+`<option selected value="${escapeHtml(value)}">${escapeHtml(value.split('/').at(-1))}</option>`:options;
}
function renderCueEditor(cues) {
 const signature=JSON.stringify(cues);if($('cue-editor').dataset.signature===signature)return;$('cue-editor').dataset.signature=signature;
 $('cue-editor').innerHTML='';for(const cue of cues)addCueEditor(cue,false);
 if(!cues.length)$('cue-editor').innerHTML='<p class="empty-copy">添加你的第一条固定口播。</p>';
}
function addCueEditor(cue={},dirty=true) {
 $('cue-editor').querySelector('.empty-copy')?.remove();const row=document.createElement('div');row.className='cue-edit-row';row.dataset.id=cue.id||crypto.randomUUID();
 row.innerHTML=`<div class="cue-edit-top"><label>标题<input data-cue-title value="${escapeHtml(cue.title||'') }" placeholder="例如：开场欢迎"></label><label>使用录音<select data-cue-audio>${cueAudioOptions(cue.audioUrl||'')}</select></label><button class="danger ghost small-button" data-remove-cue>删除</button></div><label>口播内容<textarea data-cue-text rows="2" placeholder="小云需要直接朗读的内容">${escapeHtml(cue.text||'')}</textarea></label>`;
 row.addEventListener('input',markDirty);row.addEventListener('change',markDirty);row.querySelector('[data-remove-cue]').addEventListener('click',()=>{row.remove();markDirty();});$('cue-editor').append(row);if(dirty)markDirty();
}
async function uploadFile(file,type,targetInput){
 const mime=file.type||'application/octet-stream';
 const value=await api('/api/upload',{method:'POST',body:file,headers:{'Content-Type':mime,'X-Filename':encodeURIComponent(file.name),'X-Asset-Type':type}});
 const asset=value.asset||{},url=value.url||asset.url;
 if(targetInput&&url){const input=document.querySelector(`[data-config="${targetInput}"]`);if(input){input.value=url;markDirty();}}
 await refreshAssets();notify(`已上传 ${file.name}`);return url;
}
async function refreshSetup(){
 const result=await api('/api/setup');const setup=result.setup||result;
 const items=[];
 const add=(name,ok,detail)=>items.push({name,ok,detail});
 const tools=setup.tools||setup;
 if(Array.isArray(setup.checks)){for(const item of setup.checks)add(item.name||item.label,item.ok??item.ready,item.message||item.detail||'');}
 else {
  for(const [key,label] of [['chromium','Chromium 渲染器'],['ffmpeg','FFmpeg 编码器'],['node','Node.js']]){
   const entry=tools[key]??setup[key];if(entry!==undefined)add(label,typeof entry==='object'?entry.available??entry.ok??entry.ready:Boolean(entry),typeof entry==='object'?entry.version||entry.path||entry.error||'':String(entry));
  }
  if(setup.renderer!==undefined)add('节目渲染',setup.renderer.ready??setup.renderer.initialized??Boolean(setup.renderer),setup.renderer.error||'');
  if(setup.providers){for(const [key,label] of [['llm','对话模型'],['tts','语音合成'],['asr','语音识别']]){const entry=setup.providers[key];if(entry!==undefined)add(label,typeof entry==='object'?entry.configured??entry.ready??entry.ok:Boolean(entry),typeof entry==='object'?entry.message||entry.provider||'':String(entry));}}
 }
 if(!items.length){const media=snapshot.media||{};add('后台渲染',media.initialized,media.error||'请等待后端初始化');add('模型密钥',snapshot.secrets?.llmKey,'在 AI 与语音中配置供应商');add('语音合成',snapshot.config?.tts?.provider==='demo'||snapshot.secrets?.ttsKey||snapshot.secrets?.tencentSecretKey,snapshot.config?.tts?.provider==='demo'?'当前仅演示预录音':snapshot.config?.tts?.provider||'尚未配置');}
 $('setup-results').innerHTML=items.map(item=>`<div class="diagnostic-row ${item.ok?'':'warning'}"><i>${item.ok?'✓':'!'}</i><div>${escapeHtml(item.name)}<small>${escapeHtml(item.detail|| (item.ok?'已就绪':'等待配置或初始化'))}</small></div><span class="badge">${item.ok?'就绪':'待处理'}</span></div>`).join('');
}
function showLogin(){authenticated=false;eventSource?.close();eventSource=null;clearInterval(polling);clearInterval(previewTimer);clearInterval(setupTimer);clearInterval(channelsTimer);channelsFrameRevision++;$('channels-dialog').hidden=true;channelsFocus=null;void stopMicrophone();void stopMonitor();$('studio').hidden=true;$('login-screen').hidden=false;}
async function enterStudio(){authenticated=true;$('login-screen').hidden=true;$('studio').hidden=false;await Promise.all([refreshState(),refreshAssets()]);installEvents();clearInterval(polling);polling=setInterval(()=>refreshState().catch(error=>{if(authenticated)logActivity(error.message,true);}),3000);clearInterval(previewTimer);previewTimer=setInterval(updatePreviews,800);clearInterval(setupTimer);setupTimer=setInterval(()=>{if(activeTab==='broadcast')refreshSetup().catch(()=>{});},12000);updatePreviews();$('comments-endpoint').textContent=location.origin+'/api/comments';$('metrics-endpoint').textContent=location.origin+'/api/metrics';}

async function refreshChannels() {
 if($('channels-dialog').hidden)return;
 try{
  const value=await api('/api/channels/status'),status=value.status||value;
  const browserReady=status.browserOpen===true||status.connected===true;const label=status.error?'监听需要处理':status.label||(status.loginRequired?'等待微信扫码登录':browserReady?(status.commentCount>0?'已收到 '+status.commentCount+' 条弹幕':'浏览器已连接 · 尚未收到弹幕'):'浏览器未连接');
  $('channels-status').textContent=label;$('channels-error').textContent=status.error||'';$('channels-error').hidden=!status.error;
  $('connect-channels').disabled=['connecting','reconnecting'].includes(status.state);
  const revision=++channelsFrameRevision;if(!browserReady){$('channels-image').removeAttribute('src');$('channels-image').hidden=true;$('channels-empty').hidden=false;return;}const image=new Image();image.onload=()=>{if(revision!==channelsFrameRevision)return;$('channels-image').src=image.src;$('channels-image').hidden=false;$('channels-empty').hidden=true;};image.onerror=()=>{if(revision!==channelsFrameRevision)return;$('channels-image').hidden=true;$('channels-empty').hidden=false;};image.src='/api/channels/frame.jpg?t='+Date.now();
 }catch(error){$('channels-error').textContent=error.message;$('channels-error').hidden=false;}
}
function openChannels(){ channelsFocus=document.activeElement;$('channels-dialog').hidden=false;$('close-channels').focus();void refreshChannels();clearInterval(channelsTimer);channelsTimer=setInterval(refreshChannels,2000); }
function closeChannels(){ $('channels-dialog').hidden=true;clearInterval(channelsTimer);channelsTimer=null;channelsFrameRevision++;channelsFocus?.focus();channelsFocus=null; }
/** Optional operator headphones tap; the encoded audio remains owned by the server. */
function clearMonitorNodes() {
 if(!audioMonitor)return;
 for(const source of audioMonitor.nodes){try{source.stop();}catch{/* Already ended sources require no cleanup. */}}
 audioMonitor.nodes.clear();audioMonitor.nextTime=audioMonitor.context.currentTime+.08;
}
function connectMonitor() {
 if(!monitorEnabled||!audioMonitor)return;
 const url=new URL('/api/monitor',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
 const socket=new WebSocket(url);socket.binaryType='arraybuffer';audioMonitor.socket=socket;audioMonitor.format=null;
 socket.onmessage=event=>{
  if(!monitorEnabled||audioMonitor?.socket!==socket)return;
  if(typeof event.data==='string'){
   try{const format=JSON.parse(event.data);if(format.format==='s16le'&&format.sampleRate===48000&&format.channels===2)audioMonitor.format=format;else throw new Error();}catch{notify('音频监听格式无法识别',true);void stopMonitor();}return;
  }
  if(!audioMonitor.format||!(event.data instanceof ArrayBuffer)||event.data.byteLength%4||event.data.byteLength>384000)return;
  const {context,nodes}=audioMonitor,count=event.data.byteLength/4,view=new DataView(event.data),buffer=context.createBuffer(2,count,48000);
  for(let channel=0;channel<2;channel++){const samples=buffer.getChannelData(channel);for(let index=0;index<count;index++)samples[index]=view.getInt16((index*2+channel)*2,true)/32768;}
  if(audioMonitor.nextTime<context.currentTime-.1||audioMonitor.nextTime>context.currentTime+.6)clearMonitorNodes();
  const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);nodes.add(source);source.onended=()=>{nodes.delete(source);source.disconnect();};
  const start=Math.max(context.currentTime+.035,audioMonitor.nextTime);source.start(start);audioMonitor.nextTime=start+count/48000;
 };
 socket.onclose=()=>{if(monitorEnabled&&audioMonitor?.socket===socket){clearMonitorNodes();$('monitor-toggle').textContent='♬ 监听重连中…';monitorReconnect=setTimeout(connectMonitor,2500);}};
 socket.onopen=()=>{if(monitorEnabled)$('monitor-toggle').textContent='♬ 关闭声音监听';};
}
async function startMonitor() {
 if(monitorEnabled)return;
 const AudioContext=window.AudioContext||window.webkitAudioContext,context=new AudioContext({sampleRate:48000});await context.resume();
 audioMonitor={context,socket:null,nodes:new Set(),nextTime:context.currentTime+.08,format:null};monitorEnabled=true;
 $('monitor-toggle').classList.add('listening');$('monitor-toggle').setAttribute('aria-pressed','true');connectMonitor();
 notify('已开启耳机监听；关闭监听不会停止直播声音');
}
async function stopMonitor() {
 monitorEnabled=false;clearTimeout(monitorReconnect);monitorReconnect=null;
 if(audioMonitor){clearMonitorNodes();audioMonitor.socket?.close();await audioMonitor.context.close();audioMonitor=null;}
 $('monitor-toggle').textContent='♬ 开启声音监听';$('monitor-toggle').classList.remove('listening');$('monitor-toggle').setAttribute('aria-pressed','false');
}
/** Continuous PCM VAD; only completed, sufficiently voiced phrases are submitted. */
async function refreshDevices(requestPermission=false){
 if(!navigator.mediaDevices?.enumerateDevices)throw new Error('当前浏览器无法访问麦克风，请使用 HTTPS 或本机 localhost。');
 if(requestPermission){const stream=await navigator.mediaDevices.getUserMedia({audio:true});stream.getTracks().forEach(track=>track.stop());}
 const previous=$('microphone-device').value,devices=(await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='audioinput');
 $('microphone-device').innerHTML='<option value="">系统默认麦克风</option>'+devices.filter(device=>device.deviceId!=='default').map((device,index)=>`<option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.label||'麦克风 '+(index+1))}</option>`).join('');
 if(devices.some(device=>device.deviceId===previous))$('microphone-device').value=previous;
}
function waveFile(parts,sampleRate){const length=parts.reduce((sum,part)=>sum+part.length,0),buffer=new ArrayBuffer(44+length*2),view=new DataView(buffer);const text=(offset,value)=>[...value].forEach((char,i)=>view.setUint8(offset+i,char.charCodeAt(0)));text(0,'RIFF');view.setUint32(4,36+length*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,length*2,true);let offset=44;for(const part of parts)for(const sample of part){const v=Math.max(-1,Math.min(1,sample));view.setInt16(offset,v<0?v*32768:v*32767,true);offset+=2;}return new Blob([buffer],{type:'audio/wav'});}
async function sendUtterance(parts,sampleRate){if(!microphoneEnabled||microphoneBusy)return;microphoneBusy=true;asrAbort=new AbortController();$('microphone-state').textContent='正在识别这句话…';try{const value=await api('/api/transcribe',{method:'POST',body:waveFile(parts,sampleRate),headers:{'Content-Type':'audio/wav'},signal:asrAbort.signal});const text=String(value.text||value.transcript||value.result?.text||'').trim();if(text&&microphoneEnabled){appendMessage('user',text);await runAction('chat.ask',{text});}}catch(error){if(error.name!=='AbortError'&&microphoneEnabled){appendMessage('error',error.message);notify(error.message,true);}}finally{microphoneBusy=false;asrAbort=null;if(microphoneEnabled)$('microphone-state').textContent='正在听 · 说话即可';}}
function resetPhrase(){recordingParts=[];preRoll=[];phraseStarted=0;lastVoicedAt=0;voicedDuration=0;phraseActive=false;}
async function startMicrophone(){
 if(!navigator.mediaDevices?.getUserMedia)throw new Error('麦克风需要 HTTPS 或 localhost，请检查访问地址。');
 const deviceId=$('microphone-device').value;
 const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:deviceId?{exact:deviceId}:undefined,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
 const AudioContext=window.AudioContext||window.webkitAudioContext,context=new AudioContext();await context.resume();
 const source=context.createMediaStreamSource(stream),processor=context.createScriptProcessor(4096,1,1),mute=context.createGain();mute.gain.value=0;source.connect(processor);processor.connect(mute);mute.connect(context.destination);
 microphone={stream,context,processor,source,mute};microphoneEnabled=true;resetPhrase();
 processor.onaudioprocess=event=>{
  if(!microphoneEnabled)return;const samples=new Float32Array(event.inputBuffer.getChannelData(0));let sum=0;for(const sample of samples)sum+=sample*sample;const rms=Math.sqrt(sum/samples.length),threshold=Number($('vad-threshold').value),now=performance.now(),duration=samples.length/context.sampleRate*1000;
  $('microphone-meter').style.width=Math.min(100,Math.sqrt(rms)*130)+'%';
  if(microphoneBusy){resetPhrase();return;}
  const voiced=rms>=threshold;
  if(!phraseActive){preRoll.push(samples);while(preRoll.length>Math.ceil(context.sampleRate*.35/samples.length))preRoll.shift();if(voiced){voicedDuration+=duration;if(voicedDuration>=220){phraseActive=true;phraseStarted=now;lastVoicedAt=now;recordingParts=[...preRoll];preRoll=[];$('microphone-state').textContent='听到了，继续说…';}}else voicedDuration=Math.max(0,voicedDuration-duration);return;}
  recordingParts.push(samples);if(voiced){lastVoicedAt=now;voicedDuration+=duration;}
  if(now-lastVoicedAt>=900||now-phraseStarted>=20000){const parts=recordingParts;const enough=voicedDuration>=350;resetPhrase();if(enough)void sendUtterance(parts,context.sampleRate);}
 };
 $('microphone-toggle').textContent='🎙 闭麦';$('microphone-toggle').classList.add('listening');$('microphone-state').textContent='正在听 · 说话即可';$('microphone-device').disabled=true;
 await refreshDevices(false);logActivity('已开启连续语音输入；AI 播报期间仍可提问');
}
async function stopMicrophone(){microphoneEnabled=false;asrAbort?.abort();resetPhrase();if(microphone){microphone.processor.onaudioprocess=null;microphone.source.disconnect();microphone.processor.disconnect();microphone.mute.disconnect();microphone.stream.getTracks().forEach(track=>track.stop());await microphone.context.close();microphone=null;}$('microphone-toggle').textContent='🎙 开启语音';$('microphone-toggle').classList.remove('listening');$('microphone-state').textContent='麦克风已关闭';$('microphone-meter').style.width='0%';$('microphone-device').disabled=false;}

$('login-form').addEventListener('submit',async event=>{event.preventDefault();$('login-error').textContent='';const button=event.submitter;button.disabled=true;try{await api('/api/login',{method:'POST',body:{password:$('login-password').value}});$('login-password').value='';await enterStudio();}catch(error){$('login-error').textContent=error.message;}finally{button.disabled=false;}});
$('logout').addEventListener('click',async()=>{try{await stopMicrophone();await stopMonitor();await api('/api/logout',{method:'POST',body:{}});showLogin();}catch(error){showError(error);}});
$$('[data-tab]').forEach(button=>button.addEventListener('click',()=>useTab(button.dataset.tab)));$$('[data-tab-target]').forEach(button=>button.addEventListener('click',()=>useTab(button.dataset.tabTarget)));
$$('[data-action]').forEach(button=>button.addEventListener('click',()=>runAction(button.dataset.action,{},button).catch(()=>{})));
$$('[data-config],[data-secret]').forEach(input=>{input.addEventListener('input',()=>{markDirty();updateRangeLabels();});input.addEventListener('change',()=>{markDirty();if(input.id==='tts-provider')updateTtsFields();});});
$$('.save-settings').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await saveSettings();}catch(error){showError(error);}finally{button.disabled=false;}}));
$$('[data-layout]').forEach(button=>button.addEventListener('click',async()=>{try{const patch={scene:{layout:{...(snapshot.config?.scene?.layout||{}),mode:button.dataset.layout}}};const result=await api('/api/config',{method:'PUT',body:{patch}});const value=stateValue(result);if(value?.config)applyState(value);else await refreshState();notify('节目场景已更新');}catch(error){showError(error);}}));
$('load-presentation').addEventListener('click',async()=>{try{await saveSettings({quiet:true});const url=document.querySelector('[data-config="presentation.url"]').value.trim();await runAction('presentation.open',{url});notify('演示页已载入后台');}catch(error){showError(error);}});
$$('.asset-upload').forEach(input=>input.addEventListener('change',async()=>{const file=input.files?.[0];if(!file)return;input.disabled=true;try{const type=/\.pdf$/i.test(file.name)?'pdf':/\.html?$/i.test(file.name)?'html':file.type.startsWith('audio/')||/\.(mp3|wav|ogg|m4a)$/i.test(file.name)?'audio':'image';await uploadFile(file,type,input.dataset.uploadTarget);}catch(error){showError(error);}finally{input.value='';input.disabled=false;}}));
$('notes-upload').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file)return;try{document.querySelector('[data-config="presentation.notes"]').value=await file.text();markDirty();notify('笔记已填入，保存设置后生效');}catch(error){showError(error);}finally{event.target.value='';}});
$('chat-form').addEventListener('submit',async event=>{event.preventDefault();const text=$('chat-text').value.trim();if(!text)return;appendMessage('user',text);$('chat-text').value='';try{await runAction('chat.ask',{text},event.submitter);}catch{}});
$('chat-text').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('chat-form').requestSubmit();}});
$('say-form').addEventListener('submit',async event=>{event.preventDefault();const text=$('say-text').value.trim();if(!text)return;try{await runAction('speech.say',{text},event.submitter);$('say-text').value='';}catch{}});
$('cue-list').addEventListener('click',event=>{const button=event.target.closest('[data-cue]');if(button)runAction('cue.play',{id:button.dataset.cue},button).catch(()=>{});});
$('apply-bgm').addEventListener('click',async()=>{try{const asset=$('quick-bgm').value,volume=Number($('quick-bgm-volume').value);await api('/api/config',{method:'PUT',body:{patch:{bgm:{...(snapshot.config?.bgm||{}),asset,volume}}}});await runAction('bgm.set',{asset,volume});}catch(error){showError(error);}});
$('quick-bgm-volume').addEventListener('input',updateRangeLabels);
$('demo-comment').addEventListener('click',async()=>{try{await api('/api/comments',{method:'POST',body:{comments:[{id:'console-test-'+Date.now(),nickname:'场控测试',content:'这个方案可以做什么？',at:Date.now()}]}});await refreshState();notify('测试弹幕已送入真实队列');}catch(error){showError(error);}});
$('add-cue').addEventListener('click',()=>addCueEditor());
$('open-channels').addEventListener('click',openChannels);
$('close-channels').addEventListener('click',closeChannels);
$('channels-dialog').addEventListener('click',event=>{if(event.target===$('channels-dialog'))closeChannels();});
$('channels-dialog').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeChannels();return;}if(event.key!=='Tab')return;const focusable=[...$('channels-dialog').querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')].filter(node=>node.getClientRects().length);const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}});
$('refresh-channels').addEventListener('click',refreshChannels);
$('connect-channels').addEventListener('click',async()=>{try{await api('/api/action',{method:'POST',body:{action:'channels.connect'}});await refreshChannels();}catch(error){$('channels-error').textContent=error.message;$('channels-error').hidden=false;}});
$('disconnect-channels').addEventListener('click',async()=>{try{await api('/api/action',{method:'POST',body:{action:'channels.disconnect'}});await refreshChannels();}catch(error){showError(error);}});
$('channels-image').addEventListener('click',async event=>{const image=$('channels-image'),rect=image.getBoundingClientRect();if(!image.naturalWidth||!image.naturalHeight)return;const x=Math.round((event.clientX-rect.left)*image.naturalWidth/rect.width),y=Math.round((event.clientY-rect.top)*image.naturalHeight/rect.height);try{await api('/api/action',{method:'POST',body:{action:'channels.click',x,y}});await refreshChannels();}catch(error){$('channels-error').textContent=error.message;$('channels-error').hidden=false;}});
$('refresh-setup').addEventListener('click',()=>refreshSetup().catch(showError));
$('monitor-toggle').addEventListener('click',async()=>{try{if(monitorEnabled)await stopMonitor();else await startMonitor();}catch(error){await stopMonitor();showError(error);}});
$('microphone-toggle').addEventListener('click',async()=>{try{if(microphoneEnabled)await stopMicrophone();else await startMicrophone();}catch(error){await stopMicrophone();showError(error);}});
$('refresh-devices').addEventListener('click',()=>refreshDevices(true).catch(showError));
$('vad-threshold').value=localStorage.getItem('xiaoyun-vad-threshold')||'0.03';$('vad-threshold').addEventListener('input',()=>{localStorage.setItem('xiaoyun-vad-threshold',$('vad-threshold').value);updateRangeLabels();});
addEventListener('pagehide',()=>{eventSource?.close();clearInterval(polling);clearInterval(previewTimer);clearInterval(setupTimer);clearInterval(channelsTimer);void stopMicrophone();void stopMonitor();});
async function boot(){try{const session=await api('/api/session');if(session.authenticated)await enterStudio();else showLogin();}catch(error){showLogin();$('login-error').textContent=error.message;}}
updateRangeLabels();boot();
