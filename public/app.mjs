/** Shared browser controls; all rendering, synthesis and output run on the server. */
import {DEFAULT_PERSONA_ID, PERSONA_PRESETS, getPersonaPreset, isPersonaCustomized} from './personas.mjs';
import {PcmMonitorPlayer} from './pcm-monitor.mjs';
import {BroadcastHistory} from './broadcasts-ui.mjs';
import {PROGRAM_STAGES,programOf} from './program-config.mjs';
import {ProviderEditor} from './providers-ui.mjs';
import {videoChannelPreparation,streamErrorPresentation} from './platform-preparation.mjs';
const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
let snapshot = {}, authenticated = false, eventSource = null, configDirty = false, hydrated = false, assets = [], activeTab = 'director', polling = null, previewTimer = null, setupTimer = null, toastTimer = null;
let saleActionPending=false;
let testCommentSending=null;
let quickBgmDraft=null,quickBgmRevision=0,quickBgmSaving=null;
let platformSaving=false,channelControlQueue=Promise.resolve(),channelControlPending=0,channelViewVersion=0,channelScrollTimer=null,channelScrollPending=null;
let channelsTimer = null, channelsFocus = null, channelsFrameRevision = 0, activePlatformId = null;
let editingPlatformId = null, selectedPlatformKind = null, platformReturnFocus = null;
let audioMonitor = null, monitorEnabled = false, monitorReconnect = null;
let monitorPreference = localStorage.getItem('xiaoyun-local-sound')||'auto', monitorState = 'muted';
let workspaceOpen=false,projectEpoch=0,projectSwitchPending=false,projectFormMode='create',editingProjectMetaId=null,projectReturnFocus=null,pendingProjectContinuation=null,pendingSwitchProjectId=null,deletingProjectId=null;
let microphone = null, microphoneEnabled = false, microphoneBusy = false, recordingParts = [], preRoll = [], phraseStarted = 0, lastVoicedAt = 0, voicedDuration = 0, phraseActive = false, asrAbort = null;
const workspaceLabels = {director:'直播控制',broadcasts:'直播场次',visuals:'画面展示',persona:'主播设定',program:'节目编排',connections:'外部连接'};
const workspaceSections = {visuals:'content',program:'flow',connections:'platforms'};
const dirtyTabs = new Set();
let settingsSaving = false, settingsSavePromise = null, draftRevision = 0;
let previewPersonaId = DEFAULT_PERSONA_ID, personaHydrationKey = '';
const stageLabels = {idle:'准备就绪',ended:'已结束',cue:'固定口播',question:'人机对话',stopped:'已停止',opening:'开场欢迎',source:'内容讲解',lecture:'内容讲解',comment:'弹幕回应',engagement:'互动引导','flash-sale':'秒杀提醒',sale:'秒杀提醒',lottery:'口令抽奖','lottery-announcement':'抽奖说明','lottery-wait':'等待参与','lottery-result':'开奖播报',closing:'收尾告别',waiting:'等待就绪',advancing:'翻页',error:'需要处理',paused:'已暂停',scheduling:'调度下一轮'};
const stageDescriptions = {idle:'配置素材与模型后，开始你的直播。',stopped:'当前没有 AI 播报，开始后会从开场进入分享。',opening:'先欢迎观众，再自然进入本场主题。',source:'讲一个完整段落，再检查弹幕、互动和翻页。',comment:'查看近期未读弹幕，回应共同问题或具体观众。',engagement:'适量提问或邀请点赞、分享，然后回到内容。','flash-sale':'参与提醒后继续当前主题，二维码独立到期收起。',sale:'参与提醒后继续当前主题，二维码独立到期收起。',closing:'告别完整播完后，停止 AI 播报。',advancing:'正在等待下一页画面与内容。',error:'检查错误提示和运行检查，修复后再继续。'};
function pathGet(object, path) { return path.split('.').reduce((value,key) => value?.[key], object); }
function pathSet(object, path, value) { const keys = path.split('.'); let current = object; for (const key of keys.slice(0,-1)) current = current[key] ||= {}; current[keys.at(-1)] = value; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
/** A controller-local deck can be browsed without sending any live navigation action. */
class PresentationPreview {
 constructor(){
  this.mode='live';this.visible=false;this.source='';this.frameUrl='';this.freePage=1;this.freeCount=0;this.ready=false;this.loading=false;this.generation=0;this.state={};
  this.frame=$('content-preview-frame');
  $('content-preview-live').onclick=()=>this.setMode('live');$('content-preview-browse').onclick=()=>this.setMode('browse');
  $('content-preview-prev').onclick=()=>void this.move(this.freePage-1);$('content-preview-next').onclick=()=>void this.move(this.freePage+1);
  $('content-preview-page').onchange=()=>void this.move(Number($('content-preview-page').value));
  this.frame.onload=()=>void this.loaded();
  new ResizeObserver(()=>this.resize()).observe($('content-preview-viewport'));
  document.querySelector('[data-config="presentation.url"]').addEventListener('input',()=>this.update(this.state));
 }
 reset(){this.unload();this.mode='live';this.source='';this.frameUrl='';this.freePage=1;this.freeCount=0;$('content-slide-preview').removeAttribute('src');$('content-slide-preview').hidden=true;$('content-slide-empty').hidden=false;this.update({});}
 unload(){this.generation++;this.ready=false;this.loading=false;this.frame.removeAttribute('src');this.frame.dataset.loaded='';}
 setVisible(value){if(this.visible===value)return;this.visible=value;if(!value)this.unload();else if(this.mode==='browse')this.ensureFrame();}
 setMode(mode){if(mode==='browse'&&!this.frameUrl)return;this.mode=mode;$('content-preview-error').hidden=true;this.renderMode();if(mode==='browse')this.ensureFrame();else this.unload();updatePreviews();}
 renderMode(){
  const browse=this.mode==='browse';$('content-preview-follow').hidden=browse;$('content-preview-independent').hidden=!browse;
  for(const [id,active] of [['content-preview-live',!browse],['content-preview-browse',browse]]){$(id).classList.toggle('active',active);$(id).setAttribute('aria-pressed',String(active));}
  $('content-preview-caption').textContent=browse?'自由预览：在这里翻页不会改变直播画面，也不会打断讲解。':'跟随后台当前画面；此处不操作直播翻页。';
 }
 update(value){
  this.state=value;const c=value.config?.presentation||{},d=value.director||{},slide=value.media?.slide?.pageNumber?value.media.slide:d.page||{};
  let source,frameUrl='';try{if(c.url){source=new URL(c.url,location.origin);if(!['http:','https:'].includes(source.protocol)||source.username||source.password)source=null;}}
  catch{source=null;}
  if(source?.origin===location.origin){
   if(source.pathname==='/assets/builtin/slides/index.html')frameUrl=source.href;
   else if(source.pathname.startsWith('/assets/')&&/\.pdf$/i.test(source.pathname)){const u=new URL('/pdf-viewer',location.origin);u.searchParams.set('file',source.href);frameUrl=u.href;}
  }
  if((source?.href||'')!==this.source){this.unload();this.mode='live';this.freePage=1;this.freeCount=0;this.source=source?.href||'';}
  this.frameUrl=frameUrl;
  $('content-preview-browse').disabled=!frameUrl;$('content-preview-browse').title=frameUrl?'逐页浏览，不影响直播':'内置演示稿和已上传的 PDF 支持独立翻页；其他网页可在新窗口查看原稿。';
  const original=$('content-preview-original');original.hidden=!source;
  if(source){original.href=frameUrl||source.href;original.textContent=source.origin===location.origin&&source.pathname.startsWith('/assets/uploads/')&&/\.html?$/i.test(source.pathname)?'下载 HTML 原稿 ↗':'在新窗口独立预览 ↗';}
  const number=Number(slide.pageNumber)||0,count=Number(slide.pageCount)||0,active=value.media?.output?.active===true;
  $('content-page-count').textContent=count>1?'共 '+count+' 页':count===1?'已识别 1 页':'尚未载入';
  $('content-live-position').textContent=number?(active?'正在播出':'后台当前')+'：第 '+number+' / '+(count||'—')+' 页'+(slide.title?' · '+slide.title:''):'载入演示稿后显示当前页数';
  $('content-advance-status').textContent='自动翻页：'+(c.autoAdvance===false?'已关闭，需在直播控制手动翻页':'已开启，讲清当前页后翻页');
  $('content-loop-status').textContent='整稿循环：'+(c.loop===false?'已关闭':'已开启 · 第 '+Math.max(1,Number(d.cycle)||1)+' 轮，末页讲完回到第一页');
  $('content-talk-status').textContent=d.error?'播报需要处理：'+d.error:!d.running?'AI 未在播报，页面不会自动前进。':d.paused?'AI 已暂停，恢复后继续讲解和翻页。':count===1?'当前只识别到 1 页；如果原稿有多页，请检查它是否支持翻页。':d.stage==='advancing'?'正在翻页，等待下一页画面。':(d.stageLabel||stageLabels[d.stage]||'正在讲解')+' · 当前页已讲 '+(Number(d.page?.turns)||0)+' 段；完整口播结束后再安排翻页。';
  const last=[...(d.history||[])].reverse().find(row=>row.from==='advancing'&&Number.isFinite(row.at));
  $('content-last-advance').textContent=last?'最近翻页：'+new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZone:'Asia/Shanghai'}).format(last.at):'';
  $('content-preview-draft').hidden=document.querySelector('[data-config="presentation.url"]').value.trim()===String(c.url||'').trim();
  this.renderMode();if(this.visible&&this.mode==='browse')this.ensureFrame();
 }
 resize(){const width=$('content-preview-viewport').clientWidth;if(width)this.frame.style.transform='scale('+(width/1280)+')';}
 ensureFrame(){
  if(!this.visible||this.mode!=='browse'||!this.frameUrl||this.frame.getAttribute('src'))return;
  const u=new URL(this.frameUrl);if(u.pathname==='/pdf-viewer')u.searchParams.set('page',String(this.freePage));else u.hash='slide-'+this.freePage;
  this.generation++;this.loading=true;this.ready=false;this.navigation();this.frame.src=u.href;this.resize();
 }
 async loaded(){
  if(this.mode!=='browse'||!this.frame.getAttribute('src'))return;const generation=this.generation;let timer;
  try{const w=this.frame.contentWindow;if(w.location.href==='about:blank')return;
   if(w.studioPdfReady)await Promise.race([w.studioPdfReady,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('预览载入超时，请重新打开预览。')),15000)})]);
   if(generation!==this.generation)return;if(w.studioPdfError)throw new Error(w.studioPdfError);
   if(typeof w.studioDeck?.goToSlide!=='function')throw new Error('此演示稿未提供独立翻页。');
   this.ready=true;this.loading=false;this.readCounter();this.resize();
  }catch(e){if(generation!==this.generation)return;this.ready=false;this.loading=false;$('content-preview-error').textContent='独立预览未能载入：'+e.message;$('content-preview-error').hidden=false;this.navigation();}
  finally{clearTimeout(timer);}
 }
 readCounter(){
  if(!this.ready||this.mode!=='browse')return;
  try{const doc=this.frame.contentDocument,counter=doc.querySelector('[data-slide-count]');this.freeCount=Math.min(5000,Math.max(1,Number(counter?.getAttribute('data-slide-count'))||1));this.freePage=Math.max(1,Number(counter?.getAttribute('data-slide-number'))||1);
   const select=$('content-preview-page');if(select.options.length!==this.freeCount){const slides=[...doc.querySelectorAll('.slide')];select.replaceChildren(...Array.from({length:this.freeCount},(_,i)=>new Option('第 '+(i+1)+' 页'+(slides[i]?.dataset.title?' · '+slides[i].dataset.title:''),String(i+1))));}select.value=String(this.freePage);this.navigation();
  }catch{this.ready=false;this.navigation();}
 }
 navigation(){$('content-preview-prev').disabled=!this.ready||this.loading||this.freePage<=1;$('content-preview-next').disabled=!this.ready||this.loading||this.freePage>=this.freeCount;$('content-preview-page').disabled=!this.ready||this.loading;}
 async move(number){
  if(!this.ready||this.loading||number<1||number>this.freeCount)return;const generation=this.generation;this.loading=true;this.navigation();
  try{await this.frame.contentWindow.studioDeck.goToSlide(number);if(generation===this.generation)this.readCounter();}
  catch(e){if(generation===this.generation){$('content-preview-error').textContent='预览翻页未完成：'+e.message;$('content-preview-error').hidden=false;}}
  finally{if(generation===this.generation){this.loading=false;this.navigation();}}
 }
 tick(){if(this.visible&&this.mode==='browse')this.readCounter();}
}
const presentationPreview=new PresentationPreview();
function stateValue(value) { if (value?.state?.config) return value.state; if (value?.status?.config) return value.status; return value; }
function notify(message, error = false) { $('toast').textContent = String(message); $('toast').style.borderColor = error ? '#bd6579' : ''; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, error ? 7000 : 3500); }
function showError(error) { const text = error?.message || String(error); $('global-alert').textContent = text; $('global-alert').hidden = false; notify(text,true); logActivity(text,true); }
function syncSaveState() {
  $('settings-dirty').hidden = !configDirty;
  $('workspace-draftbar').hidden = !configDirty;
  $('workspace-save-state').textContent = settingsSaving ? '正在保存…' : configDirty ? '有未保存的修改' : '场景设置已保存';
  $('workspace-save-state').classList.toggle('is-dirty',configDirty);
  $('draft-scope').textContent = [...dirtyTabs].map(name=>workspaceLabels[name]).filter(Boolean).join('、') || '保存后应用到当前场景';
  $$('.save-settings').forEach(button=>{button.disabled=settingsSaving||!configDirty;button.setAttribute('aria-busy',String(settingsSaving));});
  $('discard-settings').disabled=settingsSaving;
  $$('[data-tab]').forEach(button=>button.toggleAttribute('data-dirty',dirtyTabs.has(button.dataset.tab)));
}
function markDirty(event) {
  configDirty = true; draftRevision++;
  dirtyTabs.add(event?.target?.closest?.('[data-panel]')?.dataset.panel || activeTab);
  syncSaveState();
  renderSaleQr();
}
async function api(path, {method = 'GET',body,signal,headers={},projectId=projectData().activeId}={}) {
  const options = {method,cache:'no-store',credentials:'same-origin',headers:{...headers},signal};
  if(method!=='GET'&&projectId&&!['/api/login','/api/logout'].includes(path))options.headers['X-Studio-Project']=projectId;
  if (body !== undefined) { if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) options.body = body; else { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); } }
  const response = await fetch(path, options);
  let value; try { value = await response.json(); } catch { throw new Error(`服务返回了无法读取的响应（${response.status}）`); }
  if (response.status === 401 && authenticated) { showLogin(); throw new Error('登录已过期，请重新登录。'); }
  if (!response.ok || value?.ok === false) {const error=new Error(value.error||value.message||`操作失败（${response.status}）`);error.status=response.status;error.response=value;error.code=value.code;if(value.code==='PROJECT_CHANGED'&&authenticated)void refreshState().catch(()=>{});throw error;}
  if(method!=='GET'&&projectId&&!['/api/login','/api/logout'].includes(path)&&!/^\/api\/projects\/[^/]+\/activate$/.test(path))requireCurrentProject(projectId);
  return value;
}
function projectData(){const value=snapshot.projects||{};return {activeId:value.activeId||null,projects:Array.isArray(value.projects)?value.projects:[]};}
function currentProject(){const data=projectData();return data.projects.find(item=>item.id===data.activeId)||null;}
function acceptProjects(value){const data=Array.isArray(value?.projects)?value:value?.projects;if(!data||!Array.isArray(data.projects))return;const boundId=projectData().activeId;if(boundId&&data.activeId!==boundId){snapshot.projects={...data,activeId:boundId};renderProjects();void refreshState().catch(()=>{});return;}snapshot.projects=data;renderProjects();}
function projectDate(value){const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date):'刚刚';}
function renderProjects(){
 const {activeId,projects}=projectData(),current=currentProject();$('current-project-name').textContent=current?.name||'未选择场景';$('project-count').textContent=`${projects.length} 个场景`;$('copy-current-project').disabled=!current||projectSwitchPending||snapshot.projects?.switching===true;
 const busy=projectSwitchPending||snapshot.projects?.switching;const signature=JSON.stringify([activeId,projects,busy]);if($('project-list').dataset.signature===signature)return;$('project-list').dataset.signature=signature;
 $('project-list').innerHTML=projects.length?projects.map((item,index)=>`<article class="panel project-card ${item.id===activeId?'is-current':''}"><div class="project-card-top"><span class="project-card-symbol">${String(index+1).padStart(2,'0')}</span><span class="badge ${item.id===activeId?'current-project-badge':''}">${item.id===activeId?'当前场景':'已保存'}</span></div><h3>${escapeHtml(item.name)}</h3><p>更新于 ${escapeHtml(projectDate(item.updatedAt||item.createdAt))}</p><div class="project-card-actions"><button class="primary" data-project-open="${escapeHtml(item.id)}" ${item.id===activeId?'id="open-current-project"':''} ${busy?'disabled':''}>${item.id===activeId?'打开当前场景':'打开场景'}</button><button class="ghost" data-project-rename="${escapeHtml(item.id)}" ${busy?'disabled':''}>重命名</button>${item.id===activeId?'':`<button class="icon-button" data-project-delete="${escapeHtml(item.id)}" aria-label="删除 ${escapeHtml(item.name)}" ${busy?'disabled':''}>删除</button>`}</div></article>`).join(''):'<div class="panel projects-empty"><h3>为下一场直播，留一个位置。</h3><p>新建场景后，口播、讲解素材与平台配置都会保存下来。</p><button class="primary" data-project-create>＋ 新建场景</button></div>';
}
async function refreshProjects(){if(!authenticated)return;const epoch=projectEpoch;try{const value=await api('/api/projects');if(epoch!==projectEpoch)return;acceptProjects(value);$('projects-error').hidden=true;}catch(error){if(epoch===projectEpoch){$('projects-error').textContent=error.message;$('projects-error').hidden=false;}throw error;}}
function showProjectHome(){presentationPreview.setVisible(false);providerEditor.stopPreview();workspaceOpen=false;void stopMonitor().catch(showError);void stopMicrophone().catch(showError);$('project-workspace').hidden=true;$('projects-home').hidden=false;void refreshProjects().catch(()=>{});}
async function showProjectWorkspace(){workspaceOpen=true;$('projects-home').hidden=true;$('project-workspace').hidden=false;let view;try{view=JSON.parse(sessionStorage.getItem('xiaoyun-workspace-'+projectData().activeId)||'null');}catch{}useTab(view?.tab||'director',view?.section);await Promise.all([refreshAssets(),refreshPlatforms()]);updatePreviews();}
function clearProjectForms(){quickBgmDraft=null;quickBgmRevision++;quickBgmSaving=null;providerEditor.reset();$('runtime-prompts-content').replaceChildren();$('runtime-prompts-viewer').open=false;configDirty=false;hydrated=false;personaHydrationKey='';dirtyTabs.clear();draftRevision++;syncSaveState();for(const id of ['cue-editor','cue-list','fallback-editor','platform-list'])$(id).dataset.signature='';$$('[data-secret]').forEach(input=>input.value='');}
function discardConfigChanges(){clearProjectForms();hydrate(snapshot.config||{},snapshot.secrets||{});}
function resetProjectView(){
 presentationPreview.reset();clearChannelDrafts();resetTestCommentForm();
 clearTimeout(channelScrollTimer);channelScrollPending=null;projectEpoch++;broadcastHistory.reset();clearProjectForms();speechSignature='';seenHistory.clear();assets=[];renderAssets();$('conversation-log').innerHTML='<p class="empty-copy">你可以打字，或打开麦克风与小云对话。</p>';$('activity-log').innerHTML='<p class="empty-copy">状态变化、活动与错误会显示在这里。</p>';$('chat-text').value='';$('say-text').value='';$('global-alert').hidden=true;
 for(const [id,empty]of [['program-preview','program-empty'],['slide-preview','slide-empty']]){$(id).removeAttribute('src');$(id).hidden=true;$(empty).hidden=false;}
 for(const id of ['channels-dialog','platform-picker','platform-editor','project-form-dialog','project-unsaved-dialog','project-busy-dialog','project-delete-dialog'])$(id).hidden=true;
 clearInterval(channelsTimer);channelsFrameRevision++;activePlatformId=null;editingPlatformId=null;selectedPlatformKind=null;pendingProjectContinuation=null;pendingSwitchProjectId=null;deletingProjectId=null;$('platform-key').value='';void stopMicrophone();clearMonitorNodes();if(audioMonitor){audioMonitor.ready=false;audioMonitor.format=null;audioMonitor.socket?.close();setMonitorState('connecting','场景已切换，正在连接新场景的本机声音。');}
}
function requireCurrentProject(id){if(id&&id!==projectData().activeId){const error=new Error('当前场景已切换，旧操作已取消，请在新场景重试。');error.status=409;error.code='PROJECT_CHANGED';throw error;}}
function projectModalFocus(){if(!projectReturnFocus)projectReturnFocus=document.activeElement;}
function restoreProjectFocus(){const element=projectReturnFocus?.isConnected?projectReturnFocus:$('new-project');projectReturnFocus=null;element?.focus();}
function openProjectForm(mode,id=null){
 if(mode==='copy'&&configDirty){askAboutUnsaved(()=>openProjectForm(mode,id));return;}
 const item=id?projectData().projects.find(value=>value.id===id):currentProject();projectModalFocus();projectFormMode=mode;editingProjectMetaId=id;$('project-form-error').hidden=true;$('project-form-title').textContent=mode==='rename'?'重命名场景':mode==='copy'?'复制当前场景':'新建直播场景';$('save-project').textContent=mode==='rename'?'保存名称':mode==='copy'?'创建副本':'创建场景';$('project-name').value=mode==='rename'?item?.name||'':mode==='copy'?(item?.name||'当前场景')+' · 副本':'';$('project-form-description').textContent=mode==='rename'?'为这个场景换一个容易找到的名字。':mode==='copy'?'复制当前场景的设置与已保存凭证；运行记录和平台登录不会复制。':'每个场景单独保存口播、素材选择、平台与 AI 设置。创建后仍留在场景列表，由你决定何时打开。';$('project-form-dialog').hidden=false;$('project-name').focus();
}
function closeProjectForm(){ $('project-form-dialog').hidden=true;editingProjectMetaId=null;restoreProjectFocus(); }
async function submitProjectForm(event){event.preventDefault();const button=$('save-project'),origin=projectData().activeId;button.disabled=true;$('project-form-error').hidden=true;try{const name=$('project-name').value.trim(),id=editingProjectMetaId;const value=await api('/api/projects'+(projectFormMode==='rename'?'/'+encodeURIComponent(id):''),{method:projectFormMode==='rename'?'PUT':'POST',body:{name,...(projectFormMode==='copy'?{copyCurrent:true}:{})},projectId:origin});requireCurrentProject(origin);acceptProjects(value);await refreshProjects();closeProjectForm();notify(projectFormMode==='rename'?'场景名称已保存':'场景已创建，点击「打开场景」继续配置');}catch(error){$('project-form-error').textContent=error.message;$('project-form-error').hidden=false;}finally{button.disabled=false;}}
function askAboutUnsaved(continuation){projectModalFocus();pendingProjectContinuation=continuation;$('project-unsaved-error').hidden=true;$('project-unsaved-dialog').hidden=false;$('project-unsaved-save').focus();}
function closeProjectUnsaved(){ $('project-unsaved-dialog').hidden=true;pendingProjectContinuation=null;restoreProjectFocus(); }
async function continueAfterUnsaved(save){const buttons=['project-unsaved-save','project-unsaved-discard','project-unsaved-cancel'].map($);buttons.forEach(button=>button.disabled=true);try{if(save)await saveSettings({quiet:true});else discardConfigChanges();const continuation=pendingProjectContinuation;pendingProjectContinuation=null;$('project-unsaved-dialog').hidden=true;projectReturnFocus=null;await continuation?.();}catch(error){$('project-unsaved-error').textContent=error.message;$('project-unsaved-error').hidden=false;}finally{buttons.forEach(button=>button.disabled=false);}}
function requestProjectOpen(id){if(!id)return;if(id===projectData().activeId){void showProjectWorkspace().catch(showError);return;}if(configDirty){askAboutUnsaved(()=>activateProject(id));return;}void activateProject(id);}
function closeProjectBusy(){ $('project-busy-dialog').hidden=true;pendingSwitchProjectId=null;restoreProjectFocus(); }
async function activateProject(id,stopCurrent=false){
 const origin=projectData().activeId;if(projectSwitchPending)return;projectSwitchPending=true;$('project-force-switch').disabled=true;renderProjects();
 try{const value=await api('/api/projects/'+encodeURIComponent(id)+'/activate',{method:'POST',body:stopCurrent?{stopCurrent:true}:{},projectId:origin});const state=stateValue(value);if(!state?.config)throw new Error('场景已切换，但未收到配置，请刷新后重试。');applyState(state);$('project-busy-dialog').hidden=true;pendingSwitchProjectId=null;projectReturnFocus=null;await showProjectWorkspace();notify('已打开「'+(currentProject()?.name||'直播场景')+'」');}
 catch(error){if(error.status===409&&error.code==='PROJECT_BUSY'){pendingSwitchProjectId=id;projectModalFocus();$('project-busy-message').textContent=error.message;$('project-busy-error').hidden=true;$('project-busy-dialog').hidden=false;$('project-force-switch').focus();}else if(stopCurrent&&!$('project-busy-dialog').hidden){$('project-busy-error').textContent=error.message;$('project-busy-error').hidden=false;}else showError(error);}
 finally{projectSwitchPending=false;$('project-force-switch').disabled=false;renderProjects();}
}
function openProjectDelete(id){const item=projectData().projects.find(value=>value.id===id);if(!item||id===projectData().activeId)return;projectModalFocus();deletingProjectId=id;$('project-delete-description').textContent='将删除「'+item.name+'」的场景设置、全部直播场次和运行记录。当前场景不会受影响。';$('project-delete-error').hidden=true;$('project-delete-dialog').hidden=false;$('project-delete-cancel').focus();}
function closeProjectDelete(){ $('project-delete-dialog').hidden=true;deletingProjectId=null;restoreProjectFocus(); }
async function deleteProject(){if(!deletingProjectId)return;const button=$('project-delete-confirm');button.disabled=true;try{const value=await api('/api/projects/'+encodeURIComponent(deletingProjectId),{method:'DELETE'});acceptProjects(value);await refreshProjects();closeProjectDelete();notify('场景已删除');}catch(error){$('project-delete-error').textContent=error.message;$('project-delete-error').hidden=false;}finally{button.disabled=false;}}

function rememberWorkspaceView() {
  try { sessionStorage.setItem('xiaoyun-workspace-'+projectData().activeId,JSON.stringify({tab:activeTab,section:workspaceSections[activeTab]})); } catch {}
}
function useSection(name, section) {
  const panel=document.querySelector(`[data-panel="${name}"]`);
  const buttons=panel ? [...panel.querySelectorAll('[data-subtab]')] : [];
  if(!buttons.length)return;
  if(!buttons.some(button=>button.dataset.subtab===section))section=buttons[0].dataset.subtab;
  workspaceSections[name]=section;
  for(const button of buttons){const selected=button.dataset.subtab===section;button.classList.toggle('active',selected);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}
  panel.querySelectorAll('[data-subpanel]').forEach(element=>element.hidden=element.dataset.subpanel!==section);
  if(name==='connections'&&section==='output')refreshSetup().catch(showError);
  rememberWorkspaceView();
}
function useTab(name, section) {
  if(!Object.hasOwn(workspaceLabels,name))name='director';
  activeTab=name;
  $$('[data-tab]').forEach(button=>{const selected=button.dataset.tab===name;button.classList.toggle('active',selected);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
  $$('[data-panel]').forEach(panel=>panel.hidden=panel.dataset.panel!==name);
  useSection(name,section||workspaceSections[name]);
  if(name==='connections')refreshPlatforms().catch(showError);
  if(['visuals','program'].includes(name))refreshAssets().catch(showError);
  updatePreviews();
  if(name==='broadcasts')void broadcastHistory.refresh().catch(showError);
  rememberWorkspaceView();
  window.scrollTo({top:0,behavior:'instant'});
}
function keyboardTabs(event,selector,vertical=false) {
  const keys=vertical?['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End']:['ArrowLeft','ArrowRight','Home','End'];
  if(!keys.includes(event.key))return;
  const button=event.target.closest('[role="tab"]');if(!button)return;
  const buttons=[...event.currentTarget.querySelectorAll(selector)],index=buttons.indexOf(button);if(index<0)return;
  const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(['ArrowRight','ArrowDown'].includes(event.key)?1:-1)+buttons.length)%buttons.length;
  event.preventDefault();buttons[next].focus();buttons[next].click();
}
function renderPreparation() {
  const c=snapshot.config||{},providers=snapshot.setup?.providers||{},connections=snapshot.platforms?.connections||[];
  $('preflight-visuals').textContent=c.presentation?.url?'演示稿已选择':'尚未添加演示稿';
  $('preflight-persona').textContent=(c.identity?.name||'未设定人物')+' · '+(getPersonaPreset(c.identity?.personaId)?.name||'自定义人格');
  $('preflight-program').textContent=`${c.cues?.length||0} 条固定口播 · ${c.sale?.enabled||c.lottery?.enabled?'自动活动已启用':'手动活动'}`;
  const receiving=connections.filter(item=>item.chat?.state==='receiving').length;
  $('preflight-connections').textContent=connections.length?`${connections.length} 个平台 · ${receiving} 路收到弹幕`:c.output?.record?'仅本地录制 · 未添加平台':'尚未添加平台';
  $('preflight-summary').textContent=providers.modelConfigured?'配置保存在当前场景':'AI 模型尚未配置';
}
function beijingInput(value) { if (value === null || value === undefined || value === '') return ''; const date = new Date(value); return Number.isFinite(date.getTime()) ? new Date(date.getTime()+8*3600000).toISOString().slice(0,16) : ''; }
function beijingValue(value) { if (!value) return null; const time = Date.parse(value+':00+08:00'); if (!Number.isFinite(time)) throw new Error('请填写有效的北京时间'); return time; }
function changedConfig(previous,next){if(JSON.stringify(previous)===JSON.stringify(next))return undefined;if(next&&typeof next==='object'&&!Array.isArray(next)){const result={};for(const [key,value] of Object.entries(next)){const changed=changedConfig(previous?.[key],value);if(changed!==undefined)result[key]=changed;}return Object.keys(result).length?result:undefined;}return next;}
function readForm() {
  const patch = {}, secrets = {};
  for (const input of $$('[data-config]')) {
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if(input.hasAttribute('data-json-array'))value=JSON.parse(input.value);
    else if (input.hasAttribute('data-lines')) value = input.value.split(/\n+/).map(text=>text.trim()).filter(Boolean);
    else if (input.hasAttribute('data-beijing')) value = beijingValue(input.value);
    else if (input.type === 'number' || input.type === 'range' || input.tagName === 'SELECT' && ['sale.intervalMinutes'].includes(input.dataset.config)) {
      value = Number(input.value);
      if (!Number.isFinite(value)) throw new Error('请检查数字设置');
      if (input.dataset.scale) value *= Number(input.dataset.scale);
    } else value = input.value.trim();
    pathSet(patch,input.dataset.config,value);
  }
  for(const path of new Set($$('[data-array-config]').map(input=>input.dataset.arrayConfig)))pathSet(patch,path,$$('[data-array-config]').filter(input=>input.dataset.arrayConfig===path&&input.checked).map(input=>input.value));
  const routes=providerEditor.read();patch.llm.fallbacks=routes.models;patch.tts.fallbacks=routes.speech;Object.assign(secrets,routes.secrets);
  for (const input of $$('[data-secret]')) if (input.value.trim()) secrets[input.dataset.secret] = input.value.trim();
  patch.cues = [...document.querySelectorAll('.cue-edit-row')].map((row,index)=>({...snapshot.config?.cues?.find(cue=>cue.id===row.dataset.id),id:row.dataset.id,title:row.querySelector('[data-cue-title]').value.trim()||'口播 '+(index+1),text:row.querySelector('[data-cue-text]').value.trim(),audioUrl:row.querySelector('[data-cue-audio]').value})).filter(cue=>cue.text||cue.audioUrl);
  const changed=changedConfig(snapshot.config||{},patch)||{};
  if(changed.identity&&Object.hasOwn(changed.identity,'systemPrompt'))changed.identity.personaId=patch.identity.personaId;
  return {patch:changed,secrets};
}
function renderPersonaLibrary() {
  const options=[...PERSONA_PRESETS,{id:'custom',name:'自定义人格',description:'保留当前提示词，自由定义主播的性格与表达。'}];
  $('persona-presets').innerHTML=options.map((preset,index)=>`<button type="button" class="persona-preset" data-persona-preset="${escapeHtml(preset.id)}" aria-pressed="false"><span class="persona-preset-number">${String(index+1).padStart(2,'0')}</span><strong>${escapeHtml(preset.name)}</strong><small>${escapeHtml(preset.description)}</small></button>`).join('');
  renderPersonaControls();
}
function updateProgramForm(){
 const orderInput=document.querySelector('[data-config="program.order"]');let order;try{order=JSON.parse(orderInput.value);}catch{order=PROGRAM_STAGES.map(stage=>stage.id);}
 const rows=new Map($$('[data-program-stage]').map(row=>[row.dataset.programStage,row]));
 for(const [index,id]of order.entries()){
  const row=rows.get(id);if(!row)continue;$('program-stage-editor').append(row);row.querySelector('.program-position').textContent=String(index+1).padStart(2,'0');row.classList.toggle('is-disabled',!row.querySelector('input').checked);row.querySelector('[data-program-move="up"]').disabled=index===0;row.querySelector('[data-program-move="down"]').disabled=index===order.length-1;
 }
 const stages=[...(document.querySelector('[data-config="program.opening"]').checked?[{id:'opening',name:'开场'}]:[]),...order.filter(id=>rows.get(id)?.querySelector('input').checked).map(id=>PROGRAM_STAGES.find(stage=>stage.id===id)),...(document.querySelector('[data-config="program.closing"]').checked?[{id:'closing',name:'告别'}]:[])];
 $('program-flow-preview').innerHTML=stages.map(stage=>`<span><b>${escapeHtml(stage.name)}</b></span>`).join('<i>→</i>');
 for(const card of $$('.lottery-rule-card')){const input=card.querySelector('[data-array-config]');card.classList.toggle('selected',input.checked);card.querySelector('[data-trigger-fields]').hidden=!input.checked;}
 const enabled=document.querySelector('[data-config="program.enabled.lottery"]').checked,automatic=document.querySelector('[data-config="lottery.enabled"]').checked;
 $('lottery-program-note').textContent=!enabled?'抽奖环节已关闭。规则仍会保存；在「流程与节奏」启用抽奖后再运行。':automatic?'勾选下面需要使用的规则，支持单选或多选。':'当前仅手动抽奖。勾选「启用自动触发」后，已选规则才会运行。';
}
function applyProgramPreset(name){
 const set=(path,value)=>{const input=document.querySelector(`[data-config="${path}"]`);if(input.type==='checkbox')input.checked=value;else input.value=Array.isArray(value)?JSON.stringify(value):value;};
 if(name==='lecture'){for(const stage of PROGRAM_STAGES)set('program.enabled.'+stage.id,stage.id==='source');}
 if(name==='interactive'){set('program.enabled.source',true);set('program.enabled.engagement',true);set('program.enabled.comment',true);set('live.engagementMinTurns',1);set('live.engagementCooldownSeconds',15);set('live.commentFrequency',80);set('program.order',['source','engagement','comment','lottery','sale']);}
 if(name==='no-lottery'){set('program.enabled.lottery',false);set('lottery.enabled',false);}
 if(name==='no-closing')set('program.closing',false);
 markDirty({target:$('program-stage-editor')});updateProgramForm();updateRangeLabels();
}
function renderLiveProgram(config,stage){
 const program=programOf(config),flow=document.querySelector('.flow-track'),key=JSON.stringify(program);
 if(flow.dataset.program!==key){const stages=[...(program.opening?[{id:'opening',name:'开场'}]:[]),...program.order.filter(id=>program.enabled[id]).map(id=>PROGRAM_STAGES.find(value=>value.id===id)),...(program.closing?[{id:'closing',name:'告别'}]:[])];flow.innerHTML=stages.map(item=>`<span data-stage-node="${item.id}">${escapeHtml(item.name)}</span>`).join('<i>→</i>');flow.dataset.program=key;}
 $$('[data-stage-node]').forEach(node=>node.classList.toggle('current',node.dataset.stageNode===(stage.startsWith('lottery-')?'lottery':stage)));
 $('live-finish').textContent=program.closing?'结束并告别':'播完本段后结束';
 const lottery=document.querySelector('[data-action="lottery.queue"]');lottery.disabled=!program.enabled.lottery;lottery.textContent=program.enabled.lottery?'✧ 安排口令抽奖':'抽奖环节已关闭';
}
function renderManualSale(){
 const config=snapshot.config||{},director=snapshot.director||{},sale=director.sale||{},enabled=programOf(config).enabled.sale,configured=Boolean(config.sale?.link&&config.sale?.qrUrl),queued=sale.queued===true,active=sale.active===true,closing=director.closing||director.stage==='closing';
 const insert=$('live-sale-insert'),cancel=$('live-sale-cancel'),status=$('sale-status'),remaining=Math.max(0,Math.ceil(Number(sale.remainingSeconds)||0));
 insert.disabled=Boolean(saleActionPending||!enabled||!configured||!director.running||director.paused||closing||queued||active);
 insert.textContent=saleActionPending==='sale.queue'?'正在插入…':queued?'秒杀已排队':active?'秒杀码展示中':'下一环节插入秒杀';
 cancel.hidden=!queued&&!active;cancel.disabled=Boolean(saleActionPending);cancel.textContent=queued?'取消插入':'收起秒杀码';
 status.textContent=saleActionPending==='sale.queue'?'正在安排下一环节…':saleActionPending==='sale.hide'?'正在取消本轮秒杀…':active?`秒杀码正在展示 · 剩余 ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}；讲解继续，入口到期自动收起。`:queued?(director.paused?'下一环节：秒杀 · AI 已暂停，继续后在当前整段播完时执行。':'下一环节：秒杀 · 当前整段口播播完后执行，再接回讲解。'):!enabled?'秒杀环节已关闭，请在节目编排中启用。':!configured?'请先在节目编排中配置秒杀链接和二维码。':!director.running?'开始 AI 播报后，可将秒杀插入下一环节。':director.paused?'请先继续 AI 播报，再插入秒杀。':closing?'正在结束播报，暂不能插入秒杀。':'当前整段口播播完后插入秒杀，讲解画面保持当前页。';
 status.classList.toggle('is-queued',queued);status.classList.toggle('is-active',active);
 for(const node of $$('[data-stage-node="sale"]')){node.classList.toggle('queued',queued);node.title=queued?'下一环节将优先播报秒杀':'';}
}
function updateLayoutPicker(){
 const input=document.querySelector('[data-config="scene.layout.mode"]'),mode=input.value;
 const captions=document.querySelector('[data-config="scene.layout.showCaptions"]'),avatar=document.querySelector('[data-config="scene.layout.showAvatar"]'),community=document.querySelector('[data-config="scene.layout.showCommunity"]');
 const choices={standard:{name:'演示稿 + 小云',description:'演示稿在左侧，小云与可选的社群入口在右侧。'},avatar:{name:'小云大画面',description:'小云居中放大，隐藏演示稿；右侧可显示社群入口。'},slides:{name:'只显示演示稿',description:'演示稿加宽，人物和社群入口隐藏；标题和字幕仍按下方设置显示。'},green:{name:'小云绿幕',description:'绿色背景上只保留小云，供外部软件去掉绿底后合成。'}};
 const choice=choices[mode]||choices.standard;
 $$('[data-layout]').forEach(button=>{const selected=button.dataset.layout===mode;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
 for(const image of $$('[data-layout-avatar]'))if(!image.hasAttribute('href'))image.setAttribute('href','/internal/avatar/explain.png');
 if(mode==='green')$('advanced-layout').open=true;
 $('layout-choice-title').textContent='当前选择：'+choice.name;$('layout-choice-description').textContent=choice.description;
 const draft={mode,showAvatar:avatar.checked,showCommunity:community.checked,showCaptions:captions.checked},saved=snapshot.config?.scene?.layout||{},pending=Object.entries(draft).some(([key,value])=>saved[key]!==value);
 $('layout-choice-state').textContent=pending?'待保存':'已保存';$('layout-choice-state').classList.toggle('warning',pending);
 const warning=$('layout-choice-warning');warning.hidden=mode==='slides'||avatar.checked;warning.textContent='「显示小云」已关闭，这个布局会隐藏人物。可在下方重新开启。';
 avatar.disabled=mode==='slides';community.disabled=['slides','green'].includes(mode);captions.disabled=mode==='green';
 $('layout-caption-help').textContent=mode==='green'?'绿幕布局不显示字幕，方便外部软件合成。':'口播时，字幕显示在画面下方。';
 $('layout-elements-help').textContent=mode==='slides'?'演示稿布局会隐藏小云和社群入口；切回其他布局后沿用原来的开关。':mode==='green'?'绿幕布局只显示小云，社群入口在其他布局中使用。':'这两个元素可以分别开关，按你的直播需要选择。';
}
function renderPersonaControls() {
  const current=document.querySelector('[data-config="identity.personaId"]').value;
  const prompt=document.querySelector('[data-config="identity.systemPrompt"]').value;
  const selected=getPersonaPreset(previewPersonaId);
  const currentName=getPersonaPreset(current)?.name||'自定义人格';
  const label='当前：'+currentName+(isPersonaCustomized(current,prompt)?' · 已调整':'');
  if($('persona-current').textContent!==label)$('persona-current').textContent=label;
  $$('[data-persona-preset]').forEach(button=>{const active=button.dataset.personaPreset===previewPersonaId;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));});
  $('persona-preview-name').textContent=selected?.name||'自定义人格';
  $('persona-preview-description').textContent=selected?.description||'保留当前系统提示词，按你的内容、观众和表达习惯继续编写。';
  $('persona-preview-tags').innerHTML=(selected?.tags||['自由定义']).map(tag=>`<span>${escapeHtml(tag)}</span>`).join('');
  $('persona-preview-prompt').textContent=selected?.prompt||prompt;
  $('persona-preview-summary').textContent=selected?'查看完整内置提示词':'查看当前提示词';
  const applied=previewPersonaId===current&&(!selected||!isPersonaCustomized(current,prompt));
  $('apply-persona').disabled=applied;
  $('apply-persona').textContent=applied?'正在使用此人格':!selected?'使用自定义人格':previewPersonaId===current?'重新应用内置提示词':'应用此人格';
  const reference=$('persona-reference');reference.hidden=!selected?.reference;
  if(selected?.reference){reference.href=selected.reference.url;reference.textContent='参考：'+selected.reference.label+' ↗';}else{reference.removeAttribute('href');reference.textContent='';}
}
function applyPersona() {
  const selected=getPersonaPreset(previewPersonaId),input=document.querySelector('[data-config="identity.systemPrompt"]');
  document.querySelector('[data-config="identity.personaId"]').value=previewPersonaId;
  if(selected)input.value=selected.prompt;
  markDirty({target:input});renderPersonaControls();
  notify('已应用「'+(selected?.name||'自定义人格')+'」，保存场景设置后生效');
}
function hydrate(config, savedSecrets={}) {
  renderQuickBgm(config);
  if (configDirty) return;
  for (const input of $$('[data-config]')) {
    const value = pathGet(config,input.dataset.config);
    if (value === undefined) continue;
    if (input.type === 'checkbox') input.checked = value === true;
    else if(input.hasAttribute('data-json-array'))input.value=JSON.stringify(value);
    else if (input.hasAttribute('data-lines')) input.value = Array.isArray(value) ? value.join('\n') : value || '';
    else if (input.hasAttribute('data-beijing')) input.value = beijingInput(value);
    else {
      if(input.tagName==='SELECT'&&value&&![...input.options].some(option=>option.value===value)){const option=document.createElement('option');option.value=value;option.textContent=String(value).split('/').at(-1);input.append(option);}
      input.value = input.dataset.scale ? Number(value)/Number(input.dataset.scale) : value ?? '';
    }
  }
  for(const input of $$('[data-array-config]'))input.checked=pathGet(config,input.dataset.arrayConfig)?.includes(input.value)===true;
  providerEditor.hydrate(config,savedSecrets);
  for (const input of $$('[data-secret]')) { input.value=''; input.placeholder=savedSecrets[input.dataset.secret] ? '已保存 · 留空保持不变' : '尚未配置'; }
  renderCueEditor(config.cues||[]);
  hydrated = true; updateRangeLabels(); updateTtsFields();
  $$('[data-auto-details]').forEach(details=>{if(pathGet(config,details.dataset.autoDetails))details.open=true;});
  updateLayoutPicker();
  const personaKey=JSON.stringify([config.identity?.personaId,config.identity?.systemPrompt]);
  if(personaHydrationKey!==personaKey){previewPersonaId=config.identity?.personaId||DEFAULT_PERSONA_ID;personaHydrationKey=personaKey;}
  renderPersonaControls();
  updateProgramForm();
  renderSaleQr();
}
function renderQuickBgm(config=snapshot.config||{}) {
  const music=quickBgmDraft?.asset??config.bgm?.asset??'',select=$('quick-bgm');
  if(music&&![...select.options].some(option=>option.value===music)){const option=document.createElement('option');option.value=music;option.textContent=music.split('/').at(-1);select.append(option);}
  // Do not rewrite a focused native select on every live-state event.
  if(select.value!==music)select.value=music;
  $('quick-bgm-volume').value=quickBgmDraft?.volume??config.bgm?.volume??.12;
  $('bgm-volume-label').textContent=`${Math.round(Number($('quick-bgm-volume').value)*100)}%`;
  $('apply-bgm').disabled=Boolean(quickBgmSaving)||!quickBgmDraft;
  $('apply-bgm').textContent=quickBgmSaving?'应用中…':quickBgmDraft?'应用':'已应用';
}
function editQuickBgm(field,value) {
  quickBgmDraft={...quickBgmDraft,[field]:value};quickBgmRevision++;renderQuickBgm();
}
async function applyQuickBgm() {
  if(quickBgmSaving||!quickBgmDraft)return;
  const origin=projectData().activeId,revision=quickBgmRevision,patch={...quickBgmDraft},saved={...snapshot.config?.bgm},pending={origin};
  quickBgmSaving=pending;renderQuickBgm();
  try{
    const result=await api('/api/config',{method:'PUT',body:{patch:{bgm:patch}},projectId:origin});requireCurrentProject(origin);
    // Refresh only unchanged music form fields; preserve other scene drafts and intentional music drafts.
    for(const [field,value]of Object.entries(patch)){const input=document.querySelector(`[data-config="bgm.${field}"]`);if(input&&input.value===String(saved[field]??''))input.value=String(value);}
    if(revision===quickBgmRevision)quickBgmDraft=null;
    const value=stateValue(result);if(value?.config)applyState(value);else await refreshState();
    notify(quickBgmDraft?'背景音乐已应用，新的调整仍待应用':'背景音乐已更新');
  }catch(error){showError(error);}
  finally{if(quickBgmSaving===pending){quickBgmSaving=null;renderQuickBgm();}}
}
function renderSaleQr() {
  const url=document.querySelector('[data-config="sale.qrUrl"]').value.trim(),valid=url.startsWith('/assets/');
  const image=$('sale-qr-preview'),status=$('sale-qr-status'),saved=url===snapshot.config?.sale?.qrUrl;
  const label=()=>{
    const failed=valid&&image.dataset.failed===url;
    image.hidden=!valid||failed;
    status.textContent=failed?'二维码图片加载失败，请更换或检查素材':valid?saved?'已配置秒杀二维码':'新二维码待保存':'尚未配置秒杀二维码';
    $('sale-qr-description').textContent=valid?`${saved?'已保存到当前场景。':'保存场景设置后生效。'}秒杀时显示在演示稿右上角，每轮 ${Number(document.querySelector('[data-config="sale.durationSeconds"]').value)||30} 分钟。`:'上传活动二维码后可在这里预览。';
    $('sale-qr-upload-label').textContent=valid?'更换秒杀二维码':'上传秒杀二维码';
  };
  image.onload=()=>{delete image.dataset.failed;label();};
  image.onerror=()=>{image.dataset.failed=url;label();};
  if(valid&&image.getAttribute('src')!==url){delete image.dataset.failed;image.src=url;}
  if(!valid){image.removeAttribute('src');delete image.dataset.failed;}
  label();
}
function updateRangeLabels() {
  $('speech-speed-label').textContent = `${Number(document.querySelector('[data-config="tts.speed"]').value || 1).toFixed(2)}×`;
  $('comment-frequency-label').textContent = `${document.querySelector('[data-config="live.commentFrequency"]').value || 0}%`;
  $('bgm-volume-label').textContent = `${Math.round(Number($('quick-bgm-volume').value)*100)}%`;
  $('vad-threshold-label').textContent = `${(Number($('vad-threshold').value)*100).toFixed(1)}%`;
}
function updateTtsFields() { providerEditor.primaryVoice();const provider = $('tts-provider').value; $('tencent-fields').hidden=provider!=='tencent'; $('compatible-tts-fields').hidden=provider!=='openai'; $('tts-demo-hint').hidden=provider!=='demo'; }
async function saveSettings({quiet=false}={}) {
  if(settingsSavePromise)return settingsSavePromise;
  const origin=projectData().activeId,body=readForm(),revision=draftRevision;
  settingsSaving=true;syncSaveState();
  const operation=(async()=>{
    const result=await api('/api/config',{method:'PUT',body,projectId:origin});requireCurrentProject(origin);
    if(revision===draftRevision){configDirty=false;dirtyTabs.clear();providerEditor.signature='';}
    $$('[data-secret]').forEach(input=>{if(input.value.trim()===body.secrets[input.dataset.secret])input.value='';});
    const value=stateValue(result);if(value?.config)applyState(value);else await refreshState();
    if(!quiet)notify(configDirty?'已保存提交的设置，仍有新的修改待保存':'场景设置已保存');return result;
  })();
  settingsSavePromise=operation;
  try{return await operation;}finally{settingsSavePromise=null;settingsSaving=false;syncSaveState();}
}
function readStage(director={}) { const stage = director.stage?.id || director.stage || director.stateMachine?.current?.id || director.phase || 'idle'; return typeof stage === 'string' ? stage : 'idle'; }
function timeLabel(seconds) { const total = Math.max(0,Math.floor(Number(seconds)||0));return [Math.floor(total/3600),Math.floor(total/60)%60,total%60].map(n=>String(n).padStart(2,'0')).join(':'); }
function level(value) { const v=Math.max(0,Math.min(1,Number(value)||0));return {width:Math.min(100,Math.sqrt(v)*120),label:v>.0001?`${Math.max(-80,20*Math.log10(v)).toFixed(1)} dB`:'−∞ dB'}; }
function updateMeter(audio={}) { for(const [name,value] of [['voice',audio.voiceRms],['bgm',audio.bgmRms],['output',audio.rms]]){const result=level(value);$(name+'-meter').style.width=result.width+'%';$(name+'-level').textContent=result.label;} }
const platformMarks={bilibili:{mark:'哔',color:'#f899ba',tint:'#ed72a91b',line:'#e581ac4d'},douyin:{mark:'抖',color:'#9de3ed',tint:'#62cfdb18',line:'#76cfdb42'},kuaishou:{mark:'快',color:'#ffba85',tint:'#f49b5e1c',line:'#ec9b6350'},wechat:{mark:'微',color:'#8ddcae',tint:'#63c48c1b',line:'#6ec38c45'}};
function platformData(){const value=snapshot.platforms||{};return {catalog:Array.isArray(value.catalog)?value.catalog:[],connections:Array.isArray(value.connections)?value.connections:[],limit:Number(value.limit)||8};}
function findPlatform(id){return platformData().connections.find(item=>item.id===id);}
function platformStream(connection){return snapshot.media?.output?.platforms?.find(item=>item.id===connection.id)||connection.stream||{};}
function renderStreamError(stream){const issue=streamErrorPresentation(stream);return issue.current?`<p class="error platform-card-error">推流：${escapeHtml(issue.current)}</p>`:issue.previous?`<details class="platform-previous-error"><summary>上次推流记录（已停止）</summary><p>${escapeHtml(issue.previous)}</p></details>`:'';}
function streamDisplayFields(stream){return {state:stream.state,active:stream.active,error:stream.error,reconnects:stream.reconnects};}
function platformCatalog(kind){return platformData().catalog.find(item=>item.id===kind)||{id:kind,name:kind,description:'',roomPlaceholder:'直播间链接或房间号',loginDescription:'按平台要求完成登录。'};}
function platformMark(kind){const style=platformMarks[kind]||{mark:'播',color:'#b0a5ff',tint:'#6d67ed25',line:'#7e77ff55'};return `<span class="platform-mark" style="--platform-color:${style.color};--platform-tint:${style.tint};--platform-line:${style.line}">${style.mark}</span>`;}
function streamPresentation(stream){const state=stream.state||'stopped';if(stream.active===true)return {label:'正在推流',tone:'good',on:true};if(['preparing','starting','reconnecting','running','streaming','stopping'].includes(state))return {label:state==='stopping'?'正在停止推流':state==='reconnecting'?'正在重连':'正在连接推流',tone:'wait',on:true};if(state==='error')return {label:'推流失败',tone:'bad',on:false};return {label:state==='disabled'?'未启用推流':state==='not-configured'?'待填写推流信息':'未推流',tone:'',on:false};}
function chatPresentation(chat){const state=chat.state||'disconnected';const tone=state==='receiving'?'good':chat.error||state==='error'?'bad':['connecting','reconnecting','login-required'].includes(state)||chat.loginRequired?'wait':'';return {label:chat.label||(state==='receiving'?'正在接收直播数据':chat.loginRequired?'等待扫码登录':chat.browserOpen?'浏览器已连接 · 等待消息':'弹幕未连接'),tone};}
function renderVideoChannel(item,output){
 const flow=videoChannelPreparation(item),id=escapeHtml(item.id),chat=item.chat||{},feedback=chatPresentation(chat),pending=item.preparation?.localOnline&&item.preparation?.phase==='syncing',action=flow.action==='start'?'output.platform.start':flow.action==='stop'?'output.platform.stop':null
 const primary=action?`data-platform-action="${action}"`:`data-platform-ui="${flow.action==='sync'?'sync-local':'local'}"`
 return `<article class="panel platform-card video-channel-card" data-connection="${id}"><div class="platform-card-header">${platformMark('wechat')}<div class="platform-card-title"><h3>${escapeHtml(item.name||'视频号直播间')}</h3><p>视频号 · ${flow.browser} 工作区</p></div><label class="platform-enable"><input type="checkbox" data-platform-enable="${id}" ${item.enabled?'checked':''} ${output.on?'disabled':''}>参与同时推流</label></div><div class="video-setup-summary"><strong>${pending?'正在同步登录与推流信息…':escapeHtml(flow.headline)}</strong><span class="badge">${output.on?'正在推流':'尚未推流'}</span></div><ol class="video-setup-steps">${flow.steps.map((step,index)=>`<li class="${step.done?'done':'pending'}"><span>${step.done?'✓':index+1}</span><div><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.text)}</small></div></li>`).join('')}</ol><p class="video-setup-next">${escapeHtml(flow.detail)}</p><div class="platform-card-actions"><button class="${flow.live?'danger':'primary'}" ${primary} data-platform-id="${id}" ${pending||flow.stopping?'disabled':''}>${pending?'正在同步…':escapeHtml(flow.label)}</button>${flow.action==='sync'||flow.action==='start'||flow.action==='stop'?`<button data-platform-ui="local" data-platform-id="${id}">在 ${flow.browser} 查看视频号</button>`:''}<button class="ghost platform-edit-action" data-platform-ui="edit" data-platform-id="${id}">连接设置</button><details class="platform-more"><summary>更多</summary><button data-platform-ui="chat" data-platform-id="${id}">服务器后台（备用）</button><button data-platform-ui="remove" data-platform-id="${id}" ${output.on?'disabled':''}>移除连接</button></details></div>${renderStreamError(item.stream||{})}<div class="platform-status-cell video-chat-status" role="status"><small>弹幕与观众反馈</small><strong><i class="connection-dot ${feedback.tone}"></i>${escapeHtml(feedback.label)}</strong><p>${escapeHtml(chat.loginRequired?'视频号后台登录已失效，暂时无法采集弹幕；不影响推流。':chat.error||(chat.state!=='receiving'&&chat.reason?chat.reason:Number(chat.commentCount)>0?'已收到 '+Number(chat.commentCount)+' 条真实弹幕。':chat.state==='receiving'?'已收到平台实时响应，等待观众发送弹幕。':chat.reason||'弹幕尚未连接，请打开视频号后台连接当前直播间。'))}</p></div><p class="platform-card-footnote">${flow.live?'小云正在发送画面和声音。':'按顺序完成：视频号设置 → 同步回小云 → 开始推流。'} 已收到 ${Number(chat.commentCount)||0} 条真实弹幕。</p></article>`
}
async function refreshPlatforms(){if(!authenticated)return;const epoch=projectEpoch,value=await api('/api/platforms');if(epoch!==projectEpoch)return;snapshot.platforms=value.platforms||value;renderPlatformConnections();updateOutput(snapshot.media||{});}
function renderPlatformConnections(){
 const {catalog,connections,limit}=platformData();$('platform-count').textContent=`${connections.length} / ${limit} 个平台连接`;$('add-platform').disabled=connections.length>=limit;
 const signature=JSON.stringify([catalog,connections.map(item=>({...item,preparation:item.preparation?{browser:item.preparation.browser,localOnline:item.preparation.localOnline,localLoggedIn:item.preparation.localLoggedIn,localStreamReady:item.preparation.localStreamReady,localNeedsSync:item.preparation.localNeedsSync,serverVerifiedAt:item.preparation.serverVerifiedAt,phase:item.preparation.phase}:undefined,stream:streamDisplayFields(platformStream(item)),chat:{state:item.chat?.state,label:item.chat?.label,error:item.chat?.error,browserOpen:item.chat?.browserOpen,loginRequired:item.chat?.loginRequired,commentCount:item.chat?.commentCount,messageResponses:item.chat?.messageResponses,lastMessageAt:item.chat?.lastMessageAt}}))]);
 if($('platform-list').dataset.signature===signature)return;$('platform-list').dataset.signature=signature;
 if(!connections.length){$('platform-list').innerHTML='<div class="panel platform-empty"><span>＋</span><h3>添加你的第一个直播平台</h3><p>选择平台，填写推流地址与房间链接；再按需要连接弹幕。</p><button class="primary" data-platform-ui="add">添加平台</button></div>';return;}
 $('platform-list').innerHTML=connections.map(item=>{const platform=platformCatalog(item.platform),stream=platformStream(item),chat=item.chat||{},output=streamPresentation(stream),feedback=chatPresentation(chat),configured=Boolean(item.rtmpUrl),chatSupported=platform.chatSupported!==false;
 if(item.platform==='wechat')return renderVideoChannel({...item,stream},output)
 const chatDetail=chat.reason||(Number(chat.commentCount)>0?`累计收到 ${Number(chat.commentCount)} 条弹幕`:chat.loginRequired?'请完成平台登录，随后检查实时消息':chat.browserOpen?'尚未收到真实直播消息':'连接后核对当前直播间的实时消息');
 const outputDetail=stream.active?'平台是否公开开播，以平台后台为准':configured?(item.streamKeySaved?'推流地址与密钥已保存':'推流地址已保存'):'尚未填写推流服务器地址';
 return `<article class="panel platform-card" data-connection="${escapeHtml(item.id)}"><div class="platform-card-header">${platformMark(item.platform)}<div class="platform-card-title"><h3>${escapeHtml(item.name||platform.name)}</h3><p>${escapeHtml(platform.name)}</p></div><label class="platform-enable"><input type="checkbox" data-platform-enable="${escapeHtml(item.id)}" ${item.enabled?'checked':''} ${output.on?'disabled':''}>参与同时推流</label></div><span class="platform-room" title="${escapeHtml(item.roomUrl||'')}">${escapeHtml(item.roomUrl||(item.platform==='wechat'?'视频号助手直播后台':item.platform==='custom'?'通过 RTMP / RTMPS 输出':'尚未填写直播间链接或房间号'))}</span><div class="platform-status-grid"><div class="platform-status-cell"><small>画面与声音</small><strong><i class="connection-dot ${output.tone}"></i><span class="connection-status-value">${escapeHtml(output.label)}</span></strong><p>${escapeHtml(outputDetail)}</p></div><div class="platform-status-cell"><small>弹幕与观众反馈</small><strong><i class="connection-dot ${feedback.tone}"></i><span class="connection-status-value">${escapeHtml(feedback.label)}</span></strong><p>${escapeHtml(chatSupported?chatDetail:platform.description||'此平台弹幕接入尚未就绪')}</p></div></div>${renderStreamError(stream)}${chat.error?`<p class="error platform-card-error">弹幕：${escapeHtml(chat.error)}</p>`:''}<div class="platform-card-actions"><button class="${output.on?'danger ghost':'primary'}" data-platform-action="${output.on?'output.platform.stop':stream.state==='error'?'output.platform.retry':'output.platform.start'}" data-platform-id="${escapeHtml(item.id)}" ${stream.state==='stopping'?'disabled':''}>${output.on?'停止推流':stream.state==='error'?'重试推流':'开始推流'}</button>${item.platform==='wechat'?`<button data-platform-ui="local" data-platform-id="${escapeHtml(item.id)}">本机浏览器登录</button>`:''}<button data-platform-ui="chat" data-platform-id="${escapeHtml(item.id)}" ${chatSupported?'':'disabled'}>${item.platform==='wechat'?(chat.browserOpen?'查看视频号后台':'扫码登录视频号'):(chat.loginRequired?'完成弹幕登录':chat.browserOpen?'查看弹幕连接':'连接弹幕')}</button><button class="ghost platform-edit-action" data-platform-ui="edit" data-platform-id="${escapeHtml(item.id)}">设置</button><button class="icon-button" data-platform-ui="remove" data-platform-id="${escapeHtml(item.id)}" aria-label="移除 ${escapeHtml(item.name||platform.name)}" ${output.on?'disabled':''}>移除</button></div><p class="platform-card-footnote">${output.on?'停止此平台推流后，可以修改参与同时推流的设置。':!chatSupported?'此连接仅推流；弹幕可通过高级接入口接入。':chat.state==='receiving'?(Number(chat.commentCount)>0?'已收到此直播间的真实弹幕。':'已收到真实直播指标，等待弹幕。'):'推流和弹幕独立连接；登录与实时消息需在实际开播环境核对。'}</p></article>`;
 }).join('');
}
function rememberPlatformFocus(){if(!platformReturnFocus)platformReturnFocus=document.activeElement;}
function restorePlatformFocus(){const target=platformReturnFocus?.isConnected?platformReturnFocus:$('add-platform');platformReturnFocus=null;target?.focus();}
function openPlatformPicker(){rememberPlatformFocus();const {catalog,connections,limit}=platformData();$('platform-catalog').innerHTML=catalog.length?catalog.map(item=>`<button class="platform-catalog-card" data-platform-kind="${escapeHtml(item.id)}" ${connections.length>=limit?'disabled':''}>${platformMark(item.id)}<span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.chatSupported===false?'仅推流 · '+(item.description||'其他平台'):item.description||'配置推流与弹幕连接')}</small></span></button>`).join(''):'<p class="platform-catalog-empty">平台列表尚未加载，请稍后重试。</p>';$('platform-picker').hidden=false;$('close-platform-picker').focus();}
function closePlatformPicker(){ $('platform-picker').hidden=true;restorePlatformFocus(); }
function openPlatformEditor(kind,id=null){
 const connection=id?findPlatform(id):null;if(id&&!connection){notify('这个连接已被移除，请刷新后重试',true);return;}rememberPlatformFocus();$('platform-picker').hidden=true;editingPlatformId=id;selectedPlatformKind=kind;const catalog=platformCatalog(kind);$('platform-form').reset();$('platform-editor-kind').textContent=catalog.name;$('platform-editor-title').textContent=id?'编辑直播连接':'添加直播连接';$('platform-name').value=connection?.name||catalog.name+'直播间';$('platform-enabled').checked=connection?.enabled??true;$('platform-rtmp').value=connection?.rtmpUrl||'';$('platform-room').value=connection?.roomUrl||'';$('platform-room').disabled=catalog.chatSupported===false;$('platform-room').placeholder=catalog.roomPlaceholder||'平台官方直播间链接或房间号';$('platform-key').value='';$('platform-key').placeholder=connection?.streamKeySaved?'已保存 · 留空保持不变':'平台提供的串流密钥';$('platform-clear-key-row').hidden=!connection?.streamKeySaved;$('platform-clear-key').checked=false;$('platform-local-login').hidden=kind!=='wechat';$('platform-scan-login').hidden=catalog.chatSupported===false;$('platform-login-help').hidden=catalog.chatSupported===false;$('platform-scan-login').textContent=kind==='wechat'?'扫码登录视频号':'扫码登录'+catalog.name;$('platform-room-help').textContent=catalog.loginDescription||'按平台要求登录并连接当前直播间。';$('platform-editor-error').hidden=true;$('platform-editor').hidden=false;$('platform-name').focus();
}
function closePlatformEditor(){ $('platform-editor').hidden=true;$('platform-key').value='';editingPlatformId=null;selectedPlatformKind=null;restorePlatformFocus(); }
async function savePlatform(event,{login=false,local=false,localTab=null}={}){
 event.preventDefault();if(platformSaving)return;platformSaving=true;const buttons=['save-platform','platform-scan-login','platform-local-login','cancel-platform-editor','close-platform-editor'].map($);buttons.forEach(button=>button.disabled=true);$('platform-editor-error').hidden=true;
 try{const editingId=editingPlatformId,rtmpUrl=$('platform-rtmp').value.trim();if(rtmpUrl&&!/^rtmps?:\/\//i.test(rtmpUrl))throw new Error('请填写 RTMP 或 RTMPS 推流地址，例如 rtmp://…/live。');const basic={name:$('platform-name').value.trim(),enabled:$('platform-enabled').checked,roomUrl:$('platform-room').value.trim(),rtmpUrl},existing=editingPlatformId?findPlatform(editingPlatformId):null;const body=existing?(changedConfig({name:existing.name,enabled:existing.enabled,roomUrl:existing.roomUrl,rtmpUrl:existing.rtmpUrl},basic)||{}):{...basic,platform:selectedPlatformKind};if($('platform-clear-key').checked)body.streamKey=null;else if($('platform-key').value.trim())body.streamKey=$('platform-key').value.trim();const result=await api('/api/platforms'+(editingPlatformId?'/'+encodeURIComponent(editingPlatformId):''),{method:editingPlatformId?'PUT':'POST',body});const value=stateValue(result);if(value?.config)applyState(value);else await refreshPlatforms();const id=editingId||result.connection?.id;if((login||local)&&!id)throw new Error('未能取得连接编号，请保存后在平台卡片登录');closePlatformEditor();if(local)void startLocalBrowserLogin(id,localTab);else if(login)openChannels(id,{login:true});else notify('平台连接已保存；推流和弹幕可分别启动');}
 catch(error){localTab?.close();$('platform-editor-error').textContent=error.message;$('platform-editor-error').hidden=false;}
 finally{platformSaving=false;buttons.forEach(button=>button.disabled=false);}
}
function trapModalKeys(event,close){if(event.key==='Escape'){event.preventDefault();close();return;}if(event.key!=='Tab')return;const focusable=[...event.currentTarget.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')].filter(node=>node.getClientRects().length),first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}

function updateOutput(media={}) {
 const output=media.output||{},state=output.state||'stopped',connections=platformData().connections,streams=Array.isArray(output.platforms)?output.platforms:connections.map(platformStream),activeCount=streams.filter(item=>item.active===true).length,requestedCount=Math.max(activeCount,streams.filter(item=>!['stopped','idle','disabled'].includes(item.state)).length),pending=['preparing','starting','reconnecting'].includes(state),on=output.running===true||output.encodingActive===true||pending,recording=output.recordingStatus?.active===true,failed=streams.some(item=>['error','reconnecting'].includes(item.state)),active=activeCount>0;
 let pill=active?`${activeCount} / ${requestedCount} 路正在推流${failed?' · 部分异常':''}`:recording?(failed?'仅录制 · 推流异常':'正在录制'):failed||state==='error'?'推流异常':state==='stopping'?'正在停止输出':pending?'正在准备输出':output.encodingActive?'编码器运行 · 未推流':'未推流';
 $('output-pill').className='status-pill'+(active||recording?' live':'');$('output-pill').innerHTML='<i></i>'+escapeHtml(pill);
 $('output-mode').textContent=active?`${activeCount} / ${requestedCount} 平台${recording?' · 录制中':''}`:recording?'仅本地录制':failed||state==='error'?'输出需要处理':on?'正在准备输出':'未推流';
 $('output-start').hidden=on;$('output-stop').hidden=!on;
 $('output-duration').textContent=timeLabel(output.seconds ?? (output.startedAt?(Date.now()-output.startedAt)/1000:0));
 $('fps-value').textContent=Number.isFinite(media.currentFps)?Number(media.currentFps).toFixed(1):'—';
 $('dropped-value').textContent=String(media.droppedFrames||0);
 $('program-resolution').textContent=media.width&&media.height?`${media.width} × ${media.height} · ${media.fps||'—'} FPS`:media.initialized?'渲染器已就绪':'后台正在准备';
 $('output-error').textContent=output.error||media.error||'';$('output-error').hidden=!$('output-error').textContent;
 $('output-platform-summary').innerHTML=connections.length?connections.map(item=>{const stream=streamPresentation(platformStream(item));return `<div class="output-platform-row"><i class="connection-dot ${stream.tone}"></i><span>${escapeHtml(item.name)}</span><b>${escapeHtml(stream.label)}</b></div>`;}).join(''):'';
 updateMeter(media.audio);
}

function renderComments(director={}) {
 let comments=director.recentComments||director.comments?.recent||director.comments||director.commentQueue?.recent||[];if(!Array.isArray(comments))comments=[];
 const count=director.commentCount ?? director.comments?.buffered ?? director.commentQueue?.buffered ?? comments.length;$('comment-count').textContent=`${count} 条`;
 $('comment-list').innerHTML=comments.length?comments.slice(-15).map(item=>`<div class="comment">${item.connectionName||item.platformName?`<small class="comment-source">${escapeHtml(item.connectionName||item.platformName)}</small>`:''}<strong>${escapeHtml(item.nickname||item.user||'观众')}</strong>${escapeHtml(item.content||item.text||'')}</div>`).join(''):'<p class="empty-copy">尚未收到弹幕，连接采集端后会显示在这里。</p>';
}
function renderCues(config={}) {
 const cues=Array.isArray(config.cues)?config.cues:[];
 const signature=JSON.stringify(cues.map(item=>[item.id,item.title,item.text,item.audioUrl]));
 if($('cue-list').dataset.signature===signature)return;$('cue-list').dataset.signature=signature;
 $('cue-list').innerHTML=cues.length?cues.map(cue=>`<div class="cue-item"><div><strong>${escapeHtml(cue.title||cue.id||'固定口播')}</strong><small>${cue.audioUrl?'预录音 · 点击播放':'文字口播 · 服务端合成'}</small></div><button data-cue="${escapeHtml(cue.id)}">▶ 播报</button></div>`).join(''):'<p class="empty-copy">导入口播素材后，这里会出现可直接播放的固定段落。</p>';
}
let speechSignature='';
function applyState(value) {
 if(!value?.config)return;const previousProject=projectData().activeId,nextProject=value.projects?.activeId;const changedProject=previousProject&&nextProject&&previousProject!==nextProject;if(changedProject)resetProjectView();snapshot=value;renderProjects();broadcastHistory.update(value.broadcasts||{active:null,total:0});if(changedProject){void refreshAssets().catch(()=>{});if(!projectSwitchPending)notify('当前场景已切换为「'+(currentProject()?.name||'新场景')+'」');}
 const director=value.director||{},media=value.media||{},stage=readStage(director),paused=director.paused===true,running=director.running===true;
 $('current-stage').textContent=paused?'已暂停':director.stageLabel||stageLabels[stage]||stage;
 $('stage-description').textContent=director.reason||director.stageReason||director.stateMachine?.current?.reason||stageDescriptions[stage]||'完整口播结束后按优先级选择下一步。';
 $('stage-dot').classList.toggle('active',running&&!paused);
 const voice=director.currentSpeech?.voice;$('live-voice-status').hidden=!voice;$('live-voice-status').textContent=voice?(voice.source==='recording'?'正在播放固定录音 · 音色由录音文件决定':`输出音色：${voice.voiceName||voice.voice} · ${Number(voice.speed||1).toFixed(2)}×${voice.fallback?' · 备用通道 '+voice.route+(voice.reason?'（'+voice.reason+'）':''):''}`):'';$('live-voice-status').classList.toggle('is-fallback',Boolean(voice?.fallback));
 const chunks=director.currentSpeech?.audio;$('live-speech-chunks').hidden=!running||!(chunks?.total>1);$('live-speech-chunks').textContent=chunks?.total>1?`当前口播：第 ${chunks.playing||1} / ${chunks.total} 块 · 已合成 ${chunks.ready} 块${chunks.ready<chunks.total?' · 后续同步合成中':''}`:'';
 const pacing=$('live-page-progress');if(pacing){pacing.hidden=!running||!director.page?.minimumTurns;pacing.textContent=`第${director.page?.pageNumber||1}页 · 已完成${director.page?.turns||0}段讲解 · 每页至少${director.page?.minimumTurns||3}段`;}
 const production=director.production;$('live-queue-status').hidden=!running||!production;$('live-queue-status').textContent=production?`播报队列：${production.ready} 段可播${production.working?' · 正在提前生成':''}${production.items?.[0]?.pageNumber?' · 下一段第 '+production.items[0].pageNumber+' 页'+(production.items[0].paragraphNumber?' · 第 '+production.items[0].paragraphNumber+' 段':''):''}`:'';
 renderLiveProgram(value.config,stage);
 $('live-start').disabled=running;$('live-pause').hidden=paused;$('live-pause').disabled=!running;$('live-resume').hidden=!paused;
 const error=director.error||media.error;if(error){$('global-alert').textContent=error;$('global-alert').hidden=false;}else $('global-alert').hidden=true;
 $('footer-status').textContent=paused?'AI 已暂停 · 后台状态共享':running?`AI 播报中 · ${stageLabels[stage]||stage}`:'AI 已停止 · 等待场控开始';
 const slide=media.slide||director.presentation||director.slide||{};
 $('slide-position').textContent=slide.pageNumber?`第 ${slide.pageNumber} / ${slide.pageCount||'—'} 页`:'尚未载入演示稿';
 $('slide-title').textContent=slide.title||'内容载入后，小云会结合讲解笔记分享';
 renderManualSale();
 const lottery=director.lottery?.current||director.lottery||{};
 $('lottery-status').textContent=lottery.winner?`${lottery.winner.nickname||lottery.winner.id||lottery.winner} · ${lottery.prize||'中奖'}`:lottery.state?({queued:'抽奖已排队',announcing:'正在说明参与方式',waiting:'正在收集参与弹幕',result:'正在播报结果',completed:'本轮抽奖已完成'}[lottery.state]||'抽奖记录已保存'):'完整口播结束后进入抽奖环节';
 providerEditor.status(value.setup?.providers);
 $('demo-badge').hidden=value.config.tts?.provider!=='demo';
  renderComments(director);renderHistory(director.history||[]);renderCues(value.config);renderPlatformConnections();updateOutput(media);hydrate(value.config,value.secrets||{});presentationPreview.update(value);renderPreparation();
 const speech=director.currentSpeech||director.speech;
 const text=typeof speech==='string'?speech:speech?.text;
 if(text&&text!==speechSignature){speechSignature=text;appendMessage('assistant',text);}
}
async function refreshState(){if(!authenticated)return;const epoch=projectEpoch;try{const value=stateValue(await api('/api/state'));if(epoch===projectEpoch||value.projects?.activeId===projectData().activeId)applyState(value);}catch(error){if(authenticated)throw error;}}
function appendMessage(role,text){const log=$('conversation-log');log.querySelector('.empty-copy')?.remove();const entry=document.createElement('div');entry.className='message '+(role==='user'?'user':role==='error'?'error-message':'assistant');const title=document.createElement('strong');title.textContent=role==='user'?'你':role==='error'?'提示':snapshot.config?.identity?.name||'小云';const paragraph=document.createElement('span');paragraph.textContent=String(text).slice(0,2400);entry.append(title,paragraph);log.append(entry);while(log.children.length>60)log.firstElementChild.remove();log.scrollTop=log.scrollHeight;}
const seenHistory=new Set();
function renderHistory(rows){for(const row of rows){const key=String(row.at)+':'+row.to+':'+row.reason;if(seenHistory.has(key))continue;seenHistory.add(key);logActivity((stageLabels[row.to]||row.to||'状态变化')+' · '+(row.reason||''));}if(seenHistory.size>300){const recent=[...seenHistory].slice(-100);seenHistory.clear();for(const key of recent)seenHistory.add(key);}}
function logActivity(text,error=false){const log=$('activity-log');log.querySelector('.empty-copy')?.remove();const entry=document.createElement('div');entry.className='activity-entry'+(error?' error-entry':'');const time=document.createElement('time');time.textContent=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date());const message=document.createElement('span');message.textContent=String(text).slice(0,400);entry.append(time,message);log.prepend(entry);while(log.children.length>120)log.lastElementChild.remove();}
async function runAction(action,extra={},button=null){
 if(button?.disabled)return;
 const wasDisabled=button?.disabled,origin=projectData().activeId;if(button)button.disabled=true;
 const saleAction=['sale.queue','sale.hide'].includes(action);if(saleAction){saleActionPending=action;renderManualSale();}
 try{
  if(['cue.play','speech.say','chat.ask','live.start','live.resume','live.restart','live.finish'].includes(action)&&monitorPreference!=='muted'){try{await startMonitor();}catch(error){if(monitorPreference!=='muted')throw error;}}requireCurrentProject(origin);
  if(!workspaceOpen&&['cue.play','speech.say','chat.ask','live.start','live.resume','live.restart','live.finish'].includes(action))throw new Error('已返回场景列表，播放操作已取消。');
  if(['output.start','output.platform.start','output.platform.retry','live.start','broadcast.external.start'].includes(action)&&configDirty)await saveSettings({quiet:true});
  const result=await api('/api/action',{method:'POST',body:{action,...extra},projectId:origin});requireCurrentProject(origin);const value=stateValue(result);if(value?.config)applyState(value);else await refreshState();
  const labels={'broadcast.external.start':'已开始记录外部直播，请在下播时结束本场','broadcast.end':'本场直播已结束，记录已保存','live.start':'开始 AI 播报','live.pause':'AI 已暂停','live.resume':'AI 继续播报','live.restart':'已安排从头播报','live.finish':programOf(snapshot.config||{}).closing?'已安排整段播完后告别':'已安排本段播完后结束','live.stop':'AI 已停止','sale.queue':'已插入下一环节，当前整段播完后进入秒杀','sale.hide':'已取消本轮秒杀','lottery.queue':'抽奖已排队','presentation.next':'已翻到下一页','presentation.prev':'已翻到上一页','presentation.first':'已回到第一页','output.start':'后台正在启动编码与输出','output.stop':'全部输出已停止','output.platform.start':'正在启动该平台推流','output.platform.stop':'已停止该平台推流','output.platform.retry':'正在重试该平台推流','platform.chat.connect':'正在连接该平台弹幕','platform.chat.login':'正在打开平台登录页','platform.chat.disconnect':'已断开该平台弹幕','bgm.set':'背景音乐已更新','cue.play':'固定口播已安排'};
  if(labels[action]){notify(labels[action]);logActivity(labels[action]);}return result;
 }catch(error){showError(error);throw error;}finally{if(button)button.disabled=wasDisabled||false;if(saleAction){saleActionPending=false;renderManualSale();}}
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
  else if(type==='projects'){acceptProjects(payload);}
  else if(type==='broadcasts'){snapshot.broadcasts=payload;broadcastHistory.update(payload);}
  else if(type==='platforms'){snapshot.platforms=payload;renderPlatformConnections();updateOutput(snapshot.media||{});}
  else if(type==='meter'){if(snapshot.media)snapshot.media.audio=payload;updateMeter(payload);}
  else if(type==='speech'){const text=payload.text||payload.speech;if(text&&text!==speechSignature){speechSignature=text;appendMessage('assistant',text);}}
  else if(type==='error'){showError(payload.error||payload.message||'后台发生错误');}
  else if(type==='log'||type==='activity')logActivity(payload.message||payload.text||String(payload));
 }catch{ /* Ignore incomplete reconnect events; polling reconciles the shared state. */ }};
 eventSource.onmessage=accept;for(const name of ['state','snapshot','director','media','platforms','projects','meter','speech','error','log','activity'])eventSource.addEventListener(name,accept);
}
function loadPreview(id,empty,url){const epoch=projectEpoch,preloader=new Image();preloader.onload=()=>{if(epoch!==projectEpoch)return;$(id).src=preloader.src;$(id).hidden=false;$(empty).hidden=true;};preloader.onerror=()=>{if(epoch!==projectEpoch)return;if(!$(id).getAttribute('src')){$(id).hidden=true;$(empty).hidden=false;}};preloader.src=url+'?t='+Date.now();}
function updatePreviews(){const content=authenticated&&workspaceOpen&&activeTab==='visuals'&&workspaceSections.visuals==='content'&&!document.hidden;presentationPreview.setVisible(Boolean(content));if(!authenticated||!workspaceOpen||document.hidden)return;if(activeTab==='director'){loadPreview('program-preview','program-empty','/api/frame.jpg');loadPreview('slide-preview','slide-empty','/api/slide.jpg');}else if(content){if(presentationPreview.mode==='live')loadPreview('content-slide-preview','content-slide-empty','/api/slide.jpg');else presentationPreview.tick();}}
async function refreshAssets(){const epoch=projectEpoch,value=await api('/api/assets');if(epoch!==projectEpoch)return;assets=Array.isArray(value)?value:value.assets||value.items||[];renderAssets();}
function renderAssets(){
 $('asset-count').textContent=`${assets.length} 项`;
 $('asset-list').innerHTML=assets.length?assets.map(asset=>`<div class="asset-item"><span>${asset.type==='audio'?'♫':['html','pdf','presentation'].includes(asset.type)?'▤':'▧'}</span><div><strong>${escapeHtml(asset.name||asset.id)}</strong><small>${escapeHtml(asset.type||'素材')} · ${Number(asset.size||0)>1048576?(Number(asset.size)/1048576).toFixed(1)+' MB':Math.round(Number(asset.size||0)/1024)+' KB'}</small></div><a href="${escapeHtml(asset.url)}" target="_blank" rel="noopener">查看 ↗</a></div>`).join(''):'<p class="empty-copy">上传的素材仅保存在你的服务中。</p>';
 const music=assets.filter(asset=>asset.type==='audio'||/\.(mp3|wav|m4a|ogg|flac)$/i.test(asset.url||''));
 for(const select of document.querySelectorAll('[data-cue-audio]')){const current=select.value;select.innerHTML=cueAudioOptions(current);}
 for(const id of ['quick-bgm','settings-bgm']){const select=$(id),current=select.value;select.innerHTML='<option value="">不播放背景音乐</option>'+music.map(asset=>`<option value="${escapeHtml(asset.url)}">${escapeHtml(asset.name||asset.id)}</option>`).join('');if(current&&!music.some(asset=>asset.url===current)){const option=document.createElement('option');option.value=current;option.textContent=current.split('/').at(-1);select.append(option);}select.value=current;}
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
 const mime=file.type||'application/octet-stream',origin=projectData().activeId;
 const value=await api('/api/upload',{method:'POST',body:file,headers:{'Content-Type':mime,'X-Filename':encodeURIComponent(file.name),'X-Asset-Type':type},projectId:origin});requireCurrentProject(origin);
 const asset=value.asset||{},url=value.url||asset.url;
  if(targetInput&&url){const input=document.querySelector(`[data-config="${targetInput}"]`);if(input){input.value=url;markDirty({target:input});}}
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
  if(setup.providers){for(const [key,label] of [['modelConfigured','对话模型'],['speechConfigured','语音合成'],['recognitionConfigured','语音识别（可选）']]){const ready=setup.providers[key];if(ready!==undefined)add(label,ready,key==='speechConfigured'&&setup.providers.demo?'当前使用演示预录音':ready?'服务已配置':'请在「外部连接 → AI 与语音服务」中配置');}}
 }
 if(!items.length){const media=snapshot.media||{};add('后台渲染',media.initialized,media.error||'请等待后端初始化');add('模型密钥',snapshot.secrets?.llmKey,'在外部连接中配置模型服务');add('语音合成',snapshot.config?.tts?.provider==='demo'||snapshot.secrets?.ttsKey||snapshot.secrets?.tencentSecretKey,snapshot.config?.tts?.provider==='demo'?'当前仅演示预录音':snapshot.config?.tts?.provider||'尚未配置');}
 $('setup-results').innerHTML=items.map(item=>`<div class="diagnostic-row ${item.ok?'':'warning'}"><i>${item.ok?'✓':'!'}</i><div>${escapeHtml(item.name)}<small>${escapeHtml(item.detail|| (item.ok?'已就绪':'等待配置或初始化'))}</small></div><span class="badge">${item.ok?'就绪':'待处理'}</span></div>`).join('');
}
function showLogin(){resetTestCommentForm();presentationPreview.reset();presentationPreview.setVisible(false);clearChannelDrafts();clearTimeout(channelScrollTimer);channelScrollPending=null;authenticated=false;eventSource?.close();eventSource=null;clearInterval(polling);clearInterval(previewTimer);clearInterval(setupTimer);clearInterval(channelsTimer);channelsFrameRevision++;$('channels-dialog').hidden=true;$('platform-picker').hidden=true;$('platform-editor').hidden=true;$('platform-key').value='';for(const id of ['project-form-dialog','project-unsaved-dialog','project-busy-dialog','project-delete-dialog'])$(id).hidden=true;clearProjectForms();workspaceOpen=false;channelsFocus=null;activePlatformId=null;platformReturnFocus=null;void stopMicrophone();void stopMonitor();$('studio').hidden=true;$('login-screen').hidden=false;}
async function enterStudio(){authenticated=true;$('login-screen').hidden=true;$('studio').hidden=false;await Promise.all([refreshState(),refreshProjects()]);const route=new URL(location.href),prepareId=route.searchParams.get('prepare');if(prepareId&&(!route.searchParams.get('scene')||route.searchParams.get('scene')===projectData().activeId)){await showProjectWorkspace();useTab('connections','platforms');document.querySelector('[data-connection="'+CSS.escape(prepareId)+'"]')?.classList.add('is-preparing')}else showProjectHome();installEvents();clearInterval(polling);polling=setInterval(()=>refreshState().catch(error=>{if(authenticated)logActivity(error.message,true);}),3000);clearInterval(previewTimer);previewTimer=setInterval(updatePreviews,800);clearInterval(setupTimer);setupTimer=setInterval(()=>{if(workspaceOpen&&activeTab==='connections'&&workspaceSections.connections==='output')refreshSetup().catch(()=>{});},12000);updatePreviews();$('comments-endpoint').textContent=location.origin+'/api/comments';$('metrics-endpoint').textContent=location.origin+'/api/metrics';}

async function refreshChannels() {
 if($('channels-dialog').hidden||!activePlatformId)return;
 const epoch=projectEpoch;
 try{
  const value=await api('/api/platforms'),platforms=value.platforms||value;if(epoch!==projectEpoch||$('channels-dialog').hidden)return;snapshot.platforms=platforms;renderPlatformConnections();const connection=platformData().connections.find(item=>item.id===activePlatformId);if(!connection){closeChannels();notify('这个平台连接已被移除',true);return;}const status=connection.chat||{},catalog=platformCatalog(connection.platform),browserReady=status.browserOpen===true||status.connected===true;
  $('channels-title').textContent=(connection.name||catalog.name)+(connection.platform==='wechat'?' · 视频号登录 / 后台':' · 弹幕连接');$('channels-description').textContent=connection.platform==='wechat'&&!status.loginRequired?'直接操作服务器上的视频号后台，设置标题、上传封面，完成开播并查看推流信息。':catalog.loginDescription||'浏览器在服务器上运行；请按平台要求完成登录。';$('channels-status').textContent=chatPresentation(status).label;const selecting=status.accountSelectionRequired===true;$('channels-scroll-up').hidden=connection.platform!=='wechat';$('channels-scroll-down').hidden=connection.platform!=='wechat';$('channels-scroll-up').disabled=!browserReady;$('channels-scroll-down').disabled=!browserReady;$('channels-detail').textContent=selecting?'扫码已进入账号选择流程，请直接在画面中选择视频号、身份或子用户。':status.reason||(status.commentCount>0?'累计收到 '+status.commentCount+' 条真实弹幕':'推流与弹幕独立连接；目前仅显示实际采集状态。');$('channels-error').textContent=status.error||'';$('channels-error').hidden=!status.error;$('connect-channels').disabled=channelControlPending>0||['connecting','reconnecting'].includes(status.state);$('login-channels').disabled=channelControlPending>0||['connecting','reconnecting'].includes(status.state);$('connect-channels').textContent=connection.platform==='wechat'?'打开直播管理':'连接直播间';$('channels-browser-tools').hidden=connection.platform!=='wechat';$('local-browser-login').hidden=connection.platform!=='wechat';$('local-browser-help').hidden=connection.platform!=='wechat';if(status.fileUploadRequested&&!channelControlPending){$('channels-control-feedback').textContent='请选择下方「上传封面 / 图片」，把本机图片送到刚才点击的上传控件。';}$('disconnect-channels').disabled=!browserReady&&!['connecting','reconnecting'].includes(status.state);
  const revision=++channelsFrameRevision;if(!browserReady){$('channels-image').removeAttribute('src');$('channels-image').hidden=true;$('channels-empty').hidden=false;return;}const image=new Image();image.onload=()=>{if(revision!==channelsFrameRevision)return;$('channels-image').src=image.src;$('channels-image').hidden=false;$('channels-empty').hidden=true;};image.onerror=()=>{if(revision!==channelsFrameRevision)return;$('channels-image').hidden=true;$('channels-empty').hidden=false;};image.src='/api/platforms/'+encodeURIComponent(activePlatformId)+'/frame.jpg?t='+Date.now();
 }catch(error){$('channels-error').textContent=error.message;$('channels-error').hidden=false;}
}
async function startLocalBrowserLogin(id,tab){
 if(typeof window.__xiaoyunLocalWorkspace==='function'){tab?.close();try{await window.__xiaoyunLocalWorkspace({connectionId:id,action:'open'});await refreshState()}catch(error){showError(error)}return}
 if(configDirty){tab?.close();askAboutUnsaved(()=>startLocalBrowserLogin(id));return}
 if(!tab){tab=window.open('about:blank','_blank');if(tab)tab.opener=null}
 try{const grant=await api('/api/platforms/'+encodeURIComponent(id)+'/local-workspace',{method:'POST',body:{browser:'edge'}});const url='http://127.0.0.1:18082/#'+encodeURIComponent(JSON.stringify({serverUrl:location.origin,token:grant.token,workspaceTicket:grant.workspaceTicket,browser:grant.browser,intent:'open'}));if(!tab)throw new Error('请允许此页面打开 Edge 工作区，再重新点击。');tab.location.replace(url);if(activePlatformId===id&&!$('channels-dialog').hidden)closeChannels();notify('正在打开 Edge 工作区，小云登录和当前场景会一并恢复。')}catch(error){tab?.close();showError(error)}
}
async function syncLocalWorkspace(id){
 if(typeof window.__xiaoyunLocalWorkspace!=='function'){await startLocalBrowserLogin(id);return}
 try{const result=await window.__xiaoyunLocalWorkspace({connectionId:id,action:'sync'});await refreshState();notify(result.streamConfigured?'登录和推流信息已同步，可以开始推流。':'登录已同步；还没有检测到推流地址和推流码，请继续视频号开播设置。')}catch(error){showError(error)}
}
$('local-browser-login').addEventListener('click',()=>void startLocalBrowserLogin(activePlatformId));
async function platformChatAction(action){return channelControl(action,{})}
function clearChannelDrafts(){channelViewVersion++;for(const id of ['channels-input-text','channels-stream-url','channels-stream-key','channels-upload-file'])$(id).value='';$('channels-stream-info').hidden=true;$('channels-control-feedback').classList.remove('is-error');$('channels-control-feedback').textContent='直接点击画面中的按钮或输入框；可在下方输入中文标题。'}
function openChannels(id,{login=false}={}){clearChannelDrafts();clearTimeout(channelScrollTimer);channelScrollPending=null;const connection=findPlatform(id);if(!connection)return;channelsFocus=document.activeElement;activePlatformId=id;$('channels-image').removeAttribute('src');$('channels-image').hidden=true;$('channels-empty').hidden=false;$('channels-error').hidden=true;$('channels-title').textContent=(connection.name||platformCatalog(connection.platform).name)+(connection.platform==='wechat'?' · 视频号登录 / 后台':' · 弹幕连接');$('channels-dialog').hidden=false;$('close-channels').focus();void refreshChannels();clearInterval(channelsTimer);channelsTimer=setInterval(refreshChannels,2000);$('channels-image').parentElement.classList.remove('actual-size');$('channels-size-toggle').textContent='原尺寸查看';if(login||connection.platform==='wechat')void platformChatAction('platform.chat.login');else if(!connection.chat?.browserOpen)void platformChatAction('platform.chat.connect');}
function closeChannels(){clearChannelDrafts();clearTimeout(channelScrollTimer);channelScrollPending=null;$('channels-dialog').hidden=true;clearInterval(channelsTimer);channelsTimer=null;channelsFrameRevision++;activePlatformId=null;if(channelsFocus?.isConnected)channelsFocus.focus();else $('add-platform').focus();channelsFocus=null; }
/** Local playback is independent of server recording and platform output. */
function setMonitorPreference(value){monitorPreference=value;localStorage.setItem('xiaoyun-local-sound',value);}
function setMonitorState(state,message=''){
 monitorState=state;const label={ready:'已开启',connecting:'正在连接',error:'出错',muted:monitorPreference==='muted'?'静音':'未开启'}[state]||'未开启';$('monitor-state').textContent=label;$('monitor-toggle').textContent='本机声音 · '+label;$('monitor-toggle').dataset.state=state;$('monitor-toggle').classList.toggle('listening',state==='ready');$('monitor-toggle').setAttribute('aria-pressed',String(state==='ready'));$('monitor-mute').hidden=state!=='error';$('monitor-description').classList.toggle('is-error',state==='error');
 const defaults={ready:'本机声音已开启。若仍无声，请检查系统音量与声音输出设备；推流和录制独立运行。',connecting:'正在连接本机声音，等待浏览器允许播放；推流和录制不受影响。',error:'本机声音暂不可用，请点击重试；也可选择本机静音，仅保留服务端输出。',muted:monitorPreference==='muted'?'本浏览器已静音；服务端口播、推流和录制照常进行。点击上方按钮可恢复本机声音。':'点击口播时会自动开启本机声音；只影响这台浏览器，不影响推流或录制。'};$('monitor-description').textContent=message||defaults[state];
}
function clearMonitorNodes(monitor=audioMonitor){
 monitor?.player.clear();
}
function failMonitor(monitor,error){
 if(audioMonitor!==monitor)return;clearTimeout(monitor.timeout);clearTimeout(monitorReconnect);monitorReconnect=null;monitor.ready=false;monitor.settled=true;monitor.reject?.(error);clearMonitorNodes(monitor);monitor.socket?.close();monitor.context.onstatechange=null;audioMonitor=null;monitorEnabled=false;void monitor.context.close().catch(()=>{});setMonitorState('error',error.message);
}
function armMonitorReady(monitor){
 if(monitor.promise&&!monitor.settled)return monitor.promise;monitor.settled=false;monitor.promise=new Promise((resolve,reject)=>{monitor.resolve=resolve;monitor.reject=reject;});monitor.promise.catch(()=>{});clearTimeout(monitor.timeout);monitor.timeout=setTimeout(()=>failMonitor(monitor,new Error('本机声音连接超时。请点击「本机声音」重试，或选择仅本机静音。')),8000);return monitor.promise;
}
function completeMonitorReady(monitor){
 if(audioMonitor!==monitor||!monitorEnabled||monitor.socket?.readyState!==WebSocket.OPEN||!monitor.format||monitor.format.projectId&&monitor.format.projectId!==projectData().activeId||monitor.context.state!=='running')return;clearTimeout(monitor.timeout);monitor.ready=true;monitor.settled=true;monitor.reconnects=0;monitor.resolve?.(monitor);setMonitorState('ready');
}
function connectMonitor(monitor=audioMonitor){
 if(!monitorEnabled||!monitor||audioMonitor!==monitor)return;armMonitorReady(monitor);const url=new URL('/api/monitor',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';const socket=new WebSocket(url);socket.binaryType='arraybuffer';monitor.socket=socket;monitor.format=null;
 socket.onopen=()=>completeMonitorReady(monitor);
 socket.onmessage=event=>{
  if(!monitorEnabled||audioMonitor!==monitor||monitor.socket!==socket)return;
  if(typeof event.data==='string'){try{const format=JSON.parse(event.data);if(format.format!=='s16le'||format.sampleRate!==48000||format.channels!==2)throw new Error('本机声音格式无法识别，请重新连接。');monitor.format=format;completeMonitorReady(monitor);}catch(error){failMonitor(monitor,error instanceof Error?error:new Error('本机声音格式无法识别。'));}return;}
  if(!monitor.ready||!monitor.format||monitor.format.projectId&&monitor.format.projectId!==projectData().activeId||!(event.data instanceof ArrayBuffer)||event.data.byteLength%4||event.data.byteLength>384000)return;
  monitor.player.push(event.data);
 };
 socket.onclose=()=>{if(!monitorEnabled||audioMonitor!==monitor||monitor.socket!==socket)return;monitor.ready=false;monitor.format=null;monitor.socket=null;clearMonitorNodes(monitor);if(monitor.reconnects>=3){failMonitor(monitor,new Error('本机声音连接中断。请点击「本机声音」重试；服务端输出不受影响。'));return;}monitor.reconnects++;armMonitorReady(monitor);setMonitorState('connecting','本机声音连接中断，正在重新连接；不会重复提交已经播放的口播。');clearTimeout(monitorReconnect);monitorReconnect=setTimeout(()=>connectMonitor(monitor),2500);};
 socket.onerror=()=>{/* The close event owns reconnection and the bounded ready timeout. */};
}
/** Call before the first await in a click or submit handler to preserve browser activation. */
function startMonitor(){
 if(!workspaceOpen)return Promise.reject(new Error('请先打开场景，再开启本机声音。'));
 setMonitorPreference('on');let monitor=audioMonitor;
 if(!monitor||monitor.context.state==='closed'){
  const AudioContext=window.AudioContext||window.webkitAudioContext;if(!AudioContext)throw new Error('当前浏览器不支持本机声音播放，请换用支持 Web Audio 的浏览器。');const context=new AudioContext({sampleRate:48000});monitor={context,player:new PcmMonitorPlayer(context),socket:null,format:null,ready:false,promise:null,settled:true,timeout:null,reconnects:0};audioMonitor=monitor;monitorEnabled=true;
  context.onstatechange=()=>{if(audioMonitor!==monitor||!monitorEnabled)return;if(context.state==='running')completeMonitorReady(monitor);else if(context.state!=='closed'){monitor.ready=false;clearMonitorNodes(monitor);setMonitorState('error','浏览器暂停了本机声音。请点击「本机声音」恢复；推流与录制不受影响。');}};
 }
 monitorEnabled=true;let resume;try{resume=monitor.context.resume();}catch(error){failMonitor(monitor,new Error('浏览器未能开启本机声音：'+error.message));return Promise.reject(error);}
 if(monitor.ready&&monitor.context.state==='running'&&monitor.socket?.readyState===WebSocket.OPEN&&monitor.format&&(!monitor.format.projectId||monitor.format.projectId===projectData().activeId)){Promise.resolve(resume).catch(error=>failMonitor(monitor,error));return Promise.resolve(monitor);}
 const ready=armMonitorReady(monitor);setMonitorState('connecting');if(!monitor.socket||monitor.socket.readyState===WebSocket.CLOSED||monitor.socket.readyState===WebSocket.CLOSING){clearTimeout(monitorReconnect);connectMonitor(monitor);}Promise.resolve(resume).then(()=>completeMonitorReady(monitor)).catch(error=>failMonitor(monitor,new Error('浏览器未能开启本机声音：'+error.message)));return ready;
}
async function stopMonitor({muted=false}={}){
 if(muted)setMonitorPreference('muted');monitorEnabled=false;clearTimeout(monitorReconnect);monitorReconnect=null;const monitor=audioMonitor;audioMonitor=null;
 if(monitor){clearTimeout(monitor.timeout);monitor.ready=false;monitor.settled=true;monitor.reject?.(new Error(muted?'本机声音已静音。':'本机声音已关闭。'));clearMonitorNodes(monitor);monitor.socket?.close();monitor.context.onstatechange=null;await monitor.context.close();}setMonitorState('muted');
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
 const origin=projectData().activeId,soundReady=monitorPreference!=='muted'?startMonitor():Promise.resolve();soundReady.catch(()=>{});
 const deviceId=$('microphone-device').value;
 await soundReady;requireCurrentProject(origin);const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:deviceId?{exact:deviceId}:undefined,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});if(origin!==projectData().activeId||!authenticated||!workspaceOpen){stream.getTracks().forEach(track=>track.stop());requireCurrentProject(origin);throw new Error('语音输入已取消。');}
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

const broadcastHistory=new BroadcastHistory({api,getSceneId:()=>projectData().activeId,onError:showError,action:runAction});
$('new-project').addEventListener('click',()=>openProjectForm('create'));
$('copy-current-project').addEventListener('click',()=>openProjectForm('copy'));
$('refresh-projects').addEventListener('click',()=>refreshProjects().catch(showError));
$('open-projects').addEventListener('click',showProjectHome);
$('rename-current-project').addEventListener('click',()=>openProjectForm('rename',projectData().activeId));
$('project-list').addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled)return;if(button.hasAttribute('data-project-open'))requestProjectOpen(button.dataset.projectOpen);else if(button.hasAttribute('data-project-rename'))openProjectForm('rename',button.dataset.projectRename);else if(button.hasAttribute('data-project-delete'))openProjectDelete(button.dataset.projectDelete);else if(button.hasAttribute('data-project-create'))openProjectForm('create');});
$('project-form').addEventListener('submit',submitProjectForm);
for(const id of ['close-project-form','cancel-project-form'])$(id).addEventListener('click',closeProjectForm);
for(const id of ['close-project-unsaved','project-unsaved-cancel'])$(id).addEventListener('click',closeProjectUnsaved);
$('project-unsaved-save').addEventListener('click',()=>continueAfterUnsaved(true));
$('project-unsaved-discard').addEventListener('click',()=>continueAfterUnsaved(false));
for(const id of ['close-project-busy','project-busy-cancel'])$(id).addEventListener('click',closeProjectBusy);
$('project-force-switch').addEventListener('click',()=>{const id=pendingSwitchProjectId;if(id)void activateProject(id,true);});
for(const id of ['close-project-delete','project-delete-cancel'])$(id).addEventListener('click',closeProjectDelete);
$('project-delete-confirm').addEventListener('click',deleteProject);
for(const [id,close]of [['project-form-dialog',closeProjectForm],['project-unsaved-dialog',closeProjectUnsaved],['project-busy-dialog',closeProjectBusy],['project-delete-dialog',closeProjectDelete]]){$(id).addEventListener('click',event=>{if(event.target===$(id))close();});$(id).addEventListener('keydown',event=>trapModalKeys(event,close));}
$('login-form').addEventListener('submit',async event=>{event.preventDefault();$('login-error').textContent='';const button=event.submitter;button.disabled=true;try{await api('/api/login',{method:'POST',body:{password:$('login-password').value}});$('login-password').value='';await enterStudio();}catch(error){$('login-error').textContent=error.message;}finally{button.disabled=false;}});
$('logout').addEventListener('click',async()=>{try{await stopMicrophone();await stopMonitor();await api('/api/logout',{method:'POST',body:{}});showLogin();}catch(error){showError(error);}});
$$('[data-tab]').forEach(button=>button.addEventListener('click',()=>useTab(button.dataset.tab)));
$$('[data-tab-target]').forEach(button=>button.addEventListener('click',()=>{useTab(button.dataset.tabTarget,button.dataset.subtabTarget);const heading=document.querySelector(`[data-panel="${activeTab}"] .page-heading h2`);if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}));
$$('[data-subtab]').forEach(button=>button.addEventListener('click',()=>useSection(button.closest('[data-panel]').dataset.panel,button.dataset.subtab)));
document.querySelector('.workspace-nav').addEventListener('keydown',event=>keyboardTabs(event,'[data-tab]',true));
const compactWorkspace=matchMedia('(max-width: 900px)');
const orientWorkspaceNavigation=()=>document.querySelector('.workspace-nav').setAttribute('aria-orientation',compactWorkspace.matches?'horizontal':'vertical');
compactWorkspace.addEventListener('change',orientWorkspaceNavigation);orientWorkspaceNavigation();
$$('.section-tabs').forEach(nav=>nav.addEventListener('keydown',event=>keyboardTabs(event,'[data-subtab]')));
$$('[data-action]').forEach(button=>button.addEventListener('click',()=>runAction(button.dataset.action,{},button).catch(()=>{})));
const providerEditor=new ProviderEditor({markDirty,test:testProvider,preview:previewVoice});
let providerTesting=false;
async function testProvider(kind,route){
 if(providerTesting)return;providerTesting=true;
 const buttons=$$('[data-provider-test],[data-route-action="test"]');buttons.forEach(button=>button.disabled=true);
 const origin=projectData().activeId,epoch=projectEpoch;const outputs=[$('provider-test-result'),...(kind==='speech'?[$('persona-provider-test-result')]:[])];const show=text=>outputs.forEach(output=>{output.hidden=false;output.textContent=text;});show('正在保存并测试'+(kind==='model'?'模型连接':'音色')+'…');
 if(kind==='speech')for(const id of ['voice-preview','persona-voice-preview']){$(id).pause();$(id).hidden=true;}
 try{
  if(configDirty)await saveSettings({quiet:true});requireCurrentProject(origin);
  const result=await api('/api/providers/test',{method:'POST',body:{kind,route},projectId:origin});requireCurrentProject(origin);
  providerEditor.status(result.providers);show((route?'备用 '+route:'主用')+'测试成功 · '+(result.elapsedMs/1000).toFixed(2)+' 秒'+(result.text?' · '+result.text:' · 点击播放器试听'));
  if(result.audioUrl)for(const id of ['voice-preview','persona-voice-preview']){$(id).src=result.audioUrl;$(id).hidden=false;}
  notify('通道测试成功');
 }catch(error){if(epoch===projectEpoch){show(error.message);showError(error);}}
 finally{providerTesting=false;buttons.filter(button=>button.isConnected).forEach(button=>button.disabled=false);}
}
async function previewVoice(draft){
 if(providerTesting)return;providerTesting=true;
 const buttons=$$('[data-provider-preview],[data-provider-test],[data-route-action="preview"],[data-route-action="test"]');buttons.forEach(button=>button.disabled=true);
 const origin=projectData().activeId,epoch=projectEpoch,outputs=[$('provider-test-result'),$('persona-provider-test-result')];
 const show=text=>outputs.forEach(output=>{output.hidden=false;output.textContent=text;});show('正在生成所选音色的试听…');
 for(const id of ['voice-preview','persona-voice-preview']){$(id).pause();$(id).hidden=true;}
 try{
  const result=await api('/api/providers/preview',{method:'POST',body:draft,projectId:origin});requireCurrentProject(origin);
  show(result.voiceName+' · '+(result.cached?'已加载试听':(result.elapsedMs/1000).toFixed(2)+' 秒生成')+' · 点击播放器试听');
  for(const id of ['voice-preview','persona-voice-preview']){$(id).src=result.audioUrl;$(id).hidden=false;}
 }catch(error){if(epoch===projectEpoch){show(error.message);showError(error);}}
 finally{providerTesting=false;buttons.filter(button=>button.isConnected).forEach(button=>button.disabled=false);}
}
async function loadRuntimePrompts(){
 const origin=projectData().activeId,output=$('runtime-prompts-content');output.textContent='正在读取当前场景的提示词…';
 try{const data=await api('/api/prompts');requireCurrentProject(origin);output.innerHTML=`<h4>所有模型环节共用的完整系统提示词</h4><pre>${escapeHtml(data.system)}</pre>`+data.stages.map(stage=>`<h4>${escapeHtml(stage.name)} · ${stage.mode==='model'?'环节任务提示词':'固定台词 / 模板'}</h4><pre>${escapeHtml(stage.instruction)}</pre>`).join('');}
 catch(error){if(origin===projectData().activeId)output.textContent=error.message;}
}
$('runtime-prompts-viewer').addEventListener('toggle',()=>{if($('runtime-prompts-viewer').open)void loadRuntimePrompts()});
$('refresh-runtime-prompts').addEventListener('click',()=>void loadRuntimePrompts());
$$('[data-config],[data-secret],[data-array-config]').forEach(input=>{input.addEventListener('input',event=>{markDirty(event);updateRangeLabels();if(input.dataset.config==='identity.systemPrompt')renderPersonaControls();if(input.dataset.config?.startsWith('scene.layout.'))updateLayoutPicker();if(input.dataset.arrayConfig||input.dataset.config?.startsWith('program.')||input.dataset.config?.startsWith('lottery.'))updateProgramForm();});input.addEventListener('change',event=>{markDirty(event);if(input.id==='tts-provider')updateTtsFields();if(input.dataset.config?.startsWith('scene.layout.'))updateLayoutPicker();if(input.dataset.arrayConfig||input.dataset.config?.startsWith('program.')||input.dataset.config?.startsWith('lottery.'))updateProgramForm();});});
$('program-stage-editor').addEventListener('click',event=>{const button=event.target.closest('[data-program-move]');if(!button||button.disabled)return;const row=button.closest('[data-program-stage]'),input=document.querySelector('[data-config="program.order"]'),order=JSON.parse(input.value),index=order.indexOf(row.dataset.programStage),next=index+(button.dataset.programMove==='up'?-1:1);if(next<0||next>=order.length)return;[order[index],order[next]]=[order[next],order[index]];input.value=JSON.stringify(order);markDirty(event);updateProgramForm();(button.disabled?row.querySelector('input'):button).focus();});
$$('[data-program-preset]').forEach(button=>button.addEventListener('click',()=>applyProgramPreset(button.dataset.programPreset)));
$('persona-presets').addEventListener('click',event=>{const button=event.target.closest('[data-persona-preset]');if(!button)return;previewPersonaId=button.dataset.personaPreset;renderPersonaControls();});
$('apply-persona').addEventListener('click',applyPersona);
$$('.save-settings').forEach(button=>button.addEventListener('click',async()=>{try{await saveSettings();}catch(error){showError(error);}}));
$('discard-settings').addEventListener('click',()=>{discardConfigChanges();notify('已恢复到上次保存的设置');});
$$('[data-layout]').forEach(button=>button.addEventListener('click',()=>{document.querySelector('[data-config="scene.layout.mode"]').value=button.dataset.layout;markDirty({target:button});updateLayoutPicker();}));
$('save-and-preview-layout').addEventListener('click',async()=>{const button=$('save-and-preview-layout'),origin=projectData().activeId;button.disabled=true;try{if(configDirty)await saveSettings({quiet:true});requireCurrentProject(origin);useTab('director');notify('已打开当前场景的实际节目预览');}catch(error){showError(error);}finally{button.disabled=false;}});
$('load-presentation').addEventListener('click',async()=>{try{await saveSettings({quiet:true});const url=document.querySelector('[data-config="presentation.url"]').value.trim();await runAction('presentation.open',{url});notify('演示页已载入后台');}catch(error){showError(error);}});
$$('.asset-upload').forEach(input=>input.addEventListener('change',async()=>{const file=input.files?.[0];if(!file)return;input.disabled=true;try{const type=/\.pdf$/i.test(file.name)?'pdf':/\.html?$/i.test(file.name)?'html':file.type.startsWith('audio/')||/\.(mp3|wav|ogg|m4a)$/i.test(file.name)?'audio':'image';await uploadFile(file,type,input.dataset.uploadTarget);}catch(error){showError(error);}finally{input.value='';input.disabled=false;}}));
$('notes-upload').addEventListener('change',async event=>{const file=event.target.files?.[0],origin=projectData().activeId;if(!file)return;try{const text=await file.text();requireCurrentProject(origin);document.querySelector('[data-config="presentation.notes"]').value=text;markDirty();notify('笔记已填入，保存设置后生效');}catch(error){showError(error);}finally{event.target.value='';}});
$('chat-form').addEventListener('submit',async event=>{event.preventDefault();const text=$('chat-text').value.trim();if(!text)return;appendMessage('user',text);$('chat-text').value='';try{await runAction('chat.ask',{text},event.submitter);}catch{}});
$('chat-text').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('chat-form').requestSubmit();}});
$('say-form').addEventListener('submit',async event=>{event.preventDefault();const text=$('say-text').value.trim();if(!text)return;try{await runAction('speech.say',{text},event.submitter);$('say-text').value='';}catch{}});
$('cue-list').addEventListener('click',event=>{const button=event.target.closest('[data-cue]');if(button)runAction('cue.play',{id:button.dataset.cue},button).catch(()=>{});});
$('quick-bgm').addEventListener('change',()=>editQuickBgm('asset',$('quick-bgm').value));
$('apply-bgm').addEventListener('click',applyQuickBgm);
$('quick-bgm-volume').addEventListener('input',()=>editQuickBgm('volume',Number($('quick-bgm-volume').value)));
function testCommentRows(){
 const nickname=$('test-comment-nickname').value.trim()||'场控测试',batch=$('test-comment-batch').checked,text=$('test-comment-content').value.trim();
 if(!text)return [];
 const lines=batch?text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean):[text];
 if(lines.length>1000)throw new Error('每次最多发送1000条，请减少行数。');
 return lines.map((line,index)=>{
  const split=batch?line.search(/[｜|]/):-1,name=split>=0?line.slice(0,split).trim()||nickname:nickname,content=split>=0?line.slice(split+1).trim():line;
  if(!content)throw new Error(`第${index+1}条弹幕内容不能为空。`);
  if(name.length>100)throw new Error(`第${index+1}条昵称最多100字。`);
  if(content.length>500)throw new Error(`第${index+1}条弹幕最多500字。`);
  return {nickname:name,content};
 });
}
function updateTestCommentForm({preserveError=false}={}){
 const batch=$('test-comment-batch').checked;$('test-comment-format').hidden=!batch;$('test-comment-content').maxLength=batch?601000:500;
 $('test-comment-content').placeholder=batch?'小明｜开启秒杀\n小林｜你用的是什么模型？':'输入想测试的问题，例如：开启秒杀';
 let count=0,error='';try{count=testCommentRows().length;}catch(value){error=value.message;}
 if(error||!preserveError){$('test-comment-error').textContent=error;$('test-comment-error').hidden=!error;}
 $('test-comment-send').disabled=!!testCommentSending||!count||!!error;$('test-comment-send').textContent=testCommentSending?'正在发送…':count?`发送${count}条测试弹幕`:'发送测试弹幕';
}
function closeTestCommentForm(){ $('test-comment-form').hidden=true;$('demo-comment').setAttribute('aria-expanded','false');$('demo-comment').focus(); }
function resetTestCommentForm(){if(!$('test-comment-form'))return;testCommentSending=null;$('test-comment-form').reset();$('test-comment-form').hidden=true;$('demo-comment').setAttribute('aria-expanded','false');$('test-comment-status').hidden=true;updateTestCommentForm();}
if($('test-comment-form')){
$('demo-comment').addEventListener('click',()=>{if(!$('test-comment-form').hidden)return closeTestCommentForm();$('test-comment-form').hidden=false;$('demo-comment').setAttribute('aria-expanded','true');updateTestCommentForm();$('test-comment-content').focus();});
$('test-comment-cancel').addEventListener('click',closeTestCommentForm);
$('test-comment-form').addEventListener('input',()=>{$('test-comment-status').hidden=true;updateTestCommentForm();});
$('test-comment-form').addEventListener('change',updateTestCommentForm);
$('test-comment-form').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeTestCommentForm();}});
$('test-comment-form').addEventListener('submit',async event=>{
 event.preventDefault();if(testCommentSending)return;const origin=projectData().activeId,epoch=projectEpoch;let token;
 try{
  const rows=testCommentRows();if(!rows.length)throw new Error('请先填写弹幕内容。');requireCurrentProject(origin);
  token={};testCommentSending=token;updateTestCommentForm();$('test-comment-status').hidden=true;
  const prefix='console-test-'+(globalThis.crypto?.randomUUID?.()||Date.now()+'-'+Math.random().toString(36).slice(2)),at=Date.now();
  await api('/api/comments',{method:'POST',projectId:origin,body:{comments:rows.map((row,index)=>({...row,id:prefix+'-'+index,at}))}});
  if(epoch!==projectEpoch)return;requireCurrentProject(origin);$('test-comment-status').textContent=`已发送${rows.length}条测试弹幕${rows.length>100?'，最近100条进入回应窗口':''}。`;$('test-comment-status').hidden=false;
  void refreshState().catch(showError);
 }catch(error){if(epoch===projectEpoch){$('test-comment-error').textContent=error.message;$('test-comment-error').hidden=false;}}
 finally{if(testCommentSending===token){testCommentSending=null;updateTestCommentForm({preserveError:true});}}
});
}else $('demo-comment').addEventListener('click',()=>notify('页面已更新，请刷新后编辑测试弹幕。'));
$('add-cue').addEventListener('click',()=>addCueEditor());
$('open-channels').addEventListener('click',()=>useTab('connections','platforms'));
$('add-platform').addEventListener('click',openPlatformPicker);
$('platform-list').addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;const id=button.dataset.platformId,ui=button.dataset.platformUi;if(ui==='add')openPlatformPicker();else if(ui==='edit'){const connection=findPlatform(id);if(connection)openPlatformEditor(connection.platform,id);}else if(ui==='local')void startLocalBrowserLogin(id);else if(ui==='sync-local')void syncLocalWorkspace(id);else if(ui==='chat')openChannels(id,{login:findPlatform(id)?.platform==='wechat'});else if(ui==='remove'){button.disabled=true;try{const result=await api('/api/platforms/'+encodeURIComponent(id),{method:'DELETE'});const value=stateValue(result);if(value?.config)applyState(value);else await refreshPlatforms();notify('已移除平台连接');}catch(error){showError(error);button.disabled=false;}}else if(button.dataset.platformAction)void runAction(button.dataset.platformAction,{id},button).catch(()=>{});});
$('platform-list').addEventListener('change',async event=>{const input=event.target.closest('[data-platform-enable]');if(!input)return;input.disabled=true;try{const result=await api('/api/platforms/'+encodeURIComponent(input.dataset.platformEnable),{method:'PUT',body:{enabled:input.checked}});const value=stateValue(result);if(value?.config)applyState(value);else await refreshPlatforms();}catch(error){input.checked=!input.checked;showError(error);}finally{input.disabled=false;}});
$('platform-catalog').addEventListener('click',event=>{const button=event.target.closest('[data-platform-kind]');if(button)openPlatformEditor(button.dataset.platformKind);});
$('close-platform-picker').addEventListener('click',closePlatformPicker);
$('close-platform-editor').addEventListener('click',closePlatformEditor);
$('cancel-platform-editor').addEventListener('click',closePlatformEditor);
$('platform-form').addEventListener('submit',savePlatform);
$('platform-scan-login').addEventListener('click',event=>void savePlatform(event,{login:true}));
$('platform-local-login').addEventListener('click',event=>{const tab=window.open('about:blank','_blank');if(tab)tab.opener=null;void savePlatform(event,{local:true,localTab:tab})});
$('platform-key').addEventListener('input',()=>{if($('platform-key').value)$('platform-clear-key').checked=false;});
for(const [id,close]of [['platform-picker',closePlatformPicker],['platform-editor',closePlatformEditor],['channels-dialog',closeChannels]]){$(id).addEventListener('click',event=>{if(event.target===$(id))close();});$(id).addEventListener('keydown',event=>trapModalKeys(event,close));}
$('close-channels').addEventListener('click',closeChannels);
$('refresh-channels').addEventListener('click',refreshChannels);
$('connect-channels').addEventListener('click',()=>platformChatAction('platform.chat.connect'));
$('login-channels').addEventListener('click',()=>platformChatAction('platform.chat.login'));
$('disconnect-channels').addEventListener('click',()=>platformChatAction('platform.chat.disconnect'));
function channelPoint(event){const image=$('channels-image'),rect=image.getBoundingClientRect();return {x:Math.max(0,Math.min(image.naturalWidth-1,Math.floor((event.clientX-rect.left)*image.naturalWidth/rect.width))),y:Math.max(0,Math.min(image.naturalHeight-1,Math.floor((event.clientY-rect.top)*image.naturalHeight/rect.height)))}}
function queueChannelOperation(operation){
 if(!activePlatformId||channelControlPending>=40)return Promise.resolve();const id=activePlatformId,version=channelViewVersion,projectId=projectData().activeId;channelControlPending++;
 const task=channelControlQueue.catch(()=>{}).then(async()=>{if(id!==activePlatformId||version!==channelViewVersion||projectId!==projectData().activeId){channelControlPending--;return;}$('channels-control-feedback').classList.remove('is-error');$('channels-control-feedback').textContent='正在操作服务器浏览器…';$('connect-channels').disabled=true;$('login-channels').disabled=true;try{const result=await operation(id,projectId);if(id!==activePlatformId||version!==channelViewVersion)return;const value=stateValue(result);if(value?.config)applyState(value);$('channels-control-feedback').textContent='操作已完成。';await refreshChannels();return result}catch(error){if(id===activePlatformId&&version===channelViewVersion){$('channels-control-feedback').classList.add('is-error');$('channels-control-feedback').textContent=error.message;$('channels-error').textContent=error.message;$('channels-error').hidden=false}return undefined}finally{channelControlPending--;if(id===activePlatformId&&version===channelViewVersion)void refreshChannels()}});
 channelControlQueue=task;return task;
}
function channelControl(action,point){return queueChannelOperation((id,projectId)=>api('/api/action',{method:'POST',projectId,body:{action,id,...point}}))}
let channelDragStart=null,channelDragSuppressUntil=0;
$('channels-image').addEventListener('pointerdown',event=>{if(findPlatform(activePlatformId)?.platform==='wechat'&&event.button===0){channelDragSuppressUntil=0;channelDragStart={point:channelPoint(event),clientX:event.clientX,clientY:event.clientY};$('channels-image').setPointerCapture(event.pointerId)}});
$('channels-image').addEventListener('pointercancel',()=>{channelDragStart=null});
$('channels-image').addEventListener('pointerup',event=>{const start=channelDragStart;channelDragStart=null;if(start&&Math.hypot(event.clientX-start.clientX,event.clientY-start.clientY)>6){channelDragSuppressUntil=Date.now()+500;const end=channelPoint(event);void channelControl('platform.chat.drag',{fromX:start.point.x,fromY:start.point.y,toX:end.x,toY:end.y})}});
$('channels-image').addEventListener('dragstart',event=>event.preventDefault());
$('channels-image').addEventListener('click',event=>{if(Date.now()<channelDragSuppressUntil){channelDragSuppressUntil=0;return;}if(activePlatformId&&$('channels-image').naturalWidth){$('channels-image').focus({preventScroll:true});void channelControl('platform.chat.click',channelPoint(event))}});
$('channels-image').addEventListener('wheel',event=>{if(findPlatform(activePlatformId)?.platform!=='wechat')return;event.preventDefault();const point=channelPoint(event);channelScrollPending={...point,deltaY:Math.max(-600,Math.min(600,(channelScrollPending?.deltaY||0)+event.deltaY))};clearTimeout(channelScrollTimer);channelScrollTimer=setTimeout(()=>{const pending=channelScrollPending;channelScrollPending=null;if(pending)void channelControl('platform.chat.scroll',pending)},150)},{passive:false});
for(const [id,deltaY] of [['channels-scroll-up',-400],['channels-scroll-down',400]])$(id).addEventListener('click',()=>{const image=$('channels-image');if(image.naturalWidth)void channelControl('platform.chat.scroll',{x:Math.floor(image.naturalWidth*.65),y:Math.floor(image.naturalHeight*.6),deltaY})});
$('channels-size-toggle').addEventListener('click',()=>{const large=$('channels-image').parentElement.classList.toggle('actual-size');$('channels-size-toggle').textContent=large?'适应窗口':'原尺寸查看'});
$('channels-send-text').addEventListener('click',async()=>{const text=$('channels-input-text').value;if(!text)return;const result=await channelControl('platform.chat.type',{text,replace:$('channels-input-replace').checked});if(result&&$('channels-input-text').value===text)$('channels-input-text').value=''});
for(const button of $$('[data-channel-key]'))button.addEventListener('click',()=>void channelControl('platform.chat.key',{key:button.dataset.channelKey}));
$('channels-image').addEventListener('keydown',event=>{if(findPlatform(activePlatformId)?.platform!=='wechat'||event.isComposing)return;let key=event.key;if((event.ctrlKey||event.metaKey)&&key.toLowerCase()==='a')key='SelectAll';else if((event.ctrlKey||event.metaKey)&&key.toLowerCase()==='z')key=event.shiftKey?'Redo':'Undo';else if(event.ctrlKey||event.metaKey||event.altKey)return;const keys=['Enter','Tab','Escape','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','SelectAll','Undo','Redo'];if(keys.includes(key)){event.preventDefault();event.stopPropagation();void channelControl('platform.chat.key',{key})}else if(key.length===1){event.preventDefault();event.stopPropagation();void channelControl('platform.chat.type',{text:key,replace:false})}});
$('channels-image').addEventListener('paste',event=>{if(findPlatform(activePlatformId)?.platform!=='wechat')return;const text=event.clipboardData?.getData('text/plain');if(text){event.preventDefault();void channelControl('platform.chat.type',{text,replace:false})}});
$('channels-upload-image').addEventListener('click',()=>$('channels-upload-file').click());
$('channels-upload-file').addEventListener('change',async()=>{const file=$('channels-upload-file').files[0];if(!file)return;if(file.size>10*1024*1024){$('channels-control-feedback').textContent='封面图片不能超过 10MB';return}await queueChannelOperation((id,projectId)=>api('/api/platforms/'+encodeURIComponent(id)+'/browser/upload',{method:'POST',projectId,body:file}));$('channels-upload-file').value=''});
$('channels-read-stream').addEventListener('click',async()=>{const result=await queueChannelOperation((id,projectId)=>api('/api/platforms/'+encodeURIComponent(id)+'/browser/stream-info',{method:'POST',projectId}));if(result){$('channels-stream-url').value=result.rtmpUrl||'';$('channels-stream-key').value=result.streamKey||'';$('channels-stream-info').hidden=false}});
$('channels-apply-stream').addEventListener('click',async()=>{const rtmpUrl=$('channels-stream-url').value,streamKey=$('channels-stream-key').value;if(!rtmpUrl||!streamKey){$('channels-control-feedback').textContent='推流地址或推流码未读取完整，请在后台打开完整的推流信息后重新读取';return}const result=await queueChannelOperation((id,projectId)=>api('/api/platforms/'+encodeURIComponent(id),{method:'PUT',projectId,body:{rtmpUrl,streamKey}}));if(result){$('channels-stream-info').hidden=true;$('channels-stream-url').value='';$('channels-stream-key').value='';notify('推流地址和推流码已填入此连接')}});
$('refresh-setup').addEventListener('click',()=>refreshSetup().catch(showError));
$('monitor-toggle').addEventListener('click',async()=>{try{if(monitorEnabled&&monitorState!=='error')await stopMonitor({muted:true});else await startMonitor();}catch(error){setMonitorState('error',error.message);showError(error);}});
$('monitor-mute').addEventListener('click',()=>stopMonitor({muted:true}).catch(showError));
$('microphone-toggle').addEventListener('click',async()=>{try{if(microphoneEnabled)await stopMicrophone();else await startMicrophone();}catch(error){await stopMicrophone();showError(error);}});
$('refresh-devices').addEventListener('click',()=>refreshDevices(true).catch(showError));
$('vad-threshold').value=localStorage.getItem('xiaoyun-vad-threshold')||'0.03';$('vad-threshold').addEventListener('input',()=>{localStorage.setItem('xiaoyun-vad-threshold',$('vad-threshold').value);updateRangeLabels();});
addEventListener('pagehide',()=>{eventSource?.close();clearInterval(polling);clearInterval(previewTimer);clearInterval(setupTimer);clearInterval(channelsTimer);void stopMicrophone();void stopMonitor();});
addEventListener('beforeunload',event=>{if(configDirty){event.preventDefault();event.returnValue='';}});
async function boot(){try{const session=await api('/api/session');if(session.authenticated)await enterStudio();else showLogin();}catch(error){showLogin();$('login-error').textContent=error.message;}}
renderPersonaLibrary();updateRangeLabels();setMonitorState('muted');boot();
