/** One owned Edge window, two tabs: Studio state and the official video-channel backend. */
import {readChannelsPageStreamInfo} from '../server/channels-controls.mjs'
import {backendSessionReady,sessionAddressAllowed} from '../server/browser-session.mjs'
import {createHash} from 'node:crypto'

function installDock({binding,nonce,name,projectName,browserName}){
 if(!document.documentElement){addEventListener('DOMContentLoaded',()=>installDock({binding,nonce,name,projectName,browserName}),{once:true});return}
 if(document.getElementById('xiaoyun-workspace-dock'))return
 const host=document.createElement('div');host.id='xiaoyun-workspace-dock';host.style.cssText='position:fixed;right:18px;top:18px;z-index:2147483647;width:280px;'
 const root=host.attachShadow({mode:'open'});root.innerHTML='<style>:host{all:initial}section{font:13px/1.7 system-ui;background:#191e2c;color:#e9e8ff;border:1px solid #8676dc;border-radius:12px;padding:14px;box-shadow:0 8px 32px #0004}strong{display:block;font-size:14px}p{margin:8px 0;color:#c6c6de}button{font:inherit;border:0;border-radius:7px;padding:8px 12px;cursor:pointer;background:#7560e8;color:white;margin:4px 5px 0 0}button:disabled{opacity:.5}button.secondary{background:#34384d}.mini{float:right;background:transparent;padding:0;color:#c6c6de}section.collapsed .content{display:none}section.collapsed{padding:9px 12px}.error{color:#ffb7c1}</style><section><button class="mini" id="collapse">收起</button><strong id="title"></strong><div class="content"><p id="name"></p><p id="state">正在检测登录和推流信息…</p><button id="sync">同步回小云</button><button class="secondary" id="back">返回小云</button><p id="result" class="error"></p></div></section>'
 root.getElementById('title').textContent='小云 · '+(projectName||'直播准备');root.getElementById('name').textContent=name+' · '+browserName
 root.getElementById('collapse').onclick=()=>{const collapsed=root.querySelector('section').classList.toggle('collapsed');root.getElementById('collapse').textContent=collapsed?'展开':'收起'}
 const act=async action=>{root.getElementById('sync').disabled=true;root.getElementById('result').textContent=action==='sync'?'正在同步登录与推流信息…':'';try{await window[binding](action,nonce)}catch{root.getElementById('result').textContent='同步暂未完成，请返回小云查看提示。'}finally{root.getElementById('sync').disabled=false}}
 root.getElementById('sync').onclick=event=>{if(event.isTrusted)void act('sync')};root.getElementById('back').onclick=event=>{if(event.isTrusted)void act('return')}
 window.__xiaoyunUpdateDock=state=>{root.getElementById('state').textContent=state.loggedIn?(state.streamReady?'已登录，已检测到推流信息。点击同步回小云。':'已登录；请完成封面、标题和开播设置，获取推流信息后再同步。'):'请先扫码并选择视频号或子用户。';root.getElementById('sync').disabled=Boolean(state.busy)||!state.loggedIn}
 document.documentElement.append(host)
}

export function createLocalWorkspace({job,focus,claimTicket,sync,ensureSite}){
 const bound=new WeakSet();let timer=null,publishing=false,ensuring=null,lastSyncedStream=''
 const fingerprint=info=>createHash('sha256').update(JSON.stringify(info)).digest('hex')
 const studioUrl=()=>job.server+'/?prepare='+encodeURIComponent(job.connectionId)+'&scene='+encodeURIComponent(job.projectId)
 const studioRequest=async(path,body)=>{
  if(!job.studioPage||job.studioPage.isClosed()||new URL(job.studioPage.url()).origin!==job.server)throw new Error('小云工作区已关闭，请重新打开')
  const response=await job.studioPage.evaluate(async({path,body,projectId})=>{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Project':projectId},body:JSON.stringify(body),credentials:'same-origin'});return {ok:r.ok,status:r.status,value:await r.json()}},{path,body,projectId:job.projectId})
  if(!response.ok)throw Object.assign(new Error(response.value.error||'小云工作区连接失败'),{status:response.status})
  return response.value
 }
 const sitePage=async()=> (await job.browser.pages()).filter(page=>!page.isClosed()&&sessionAddressAllowed(page.url())).at(-1)||null
 const publish=async(phase='ready')=>{
  if(publishing||!job.browser?.connected||!job.studioPage||job.studioPage.isClosed())return
  publishing=true
  try{const site=await sitePage(),loggedIn=Boolean(site&&await backendSessionReady(site));let streamReady=false,localNeedsSync=false;if(site){const info=await readChannelsPageStreamInfo(site);streamReady=Boolean(info.rtmpUrl&&info.streamKey);localNeedsSync=streamReady&&fingerprint(info)!==lastSyncedStream;await site.evaluate(state=>window.__xiaoyunUpdateDock?.(state),{loggedIn,streamReady,busy:Boolean(job.busy)})}await studioRequest('/api/platforms/'+job.connectionId+'/preparation',{browser:job.browserKind,localLoggedIn:loggedIn,localStreamReady:streamReady,localNeedsSync,phase});job.workspaceAuthenticated=true}catch{job.workspaceAuthenticated=false}finally{publishing=false}
 }
 const installSite=async page=>{
  if(bound.has(page))return;bound.add(page)
  const name='__xiaoyunWorkspaceAction',nonce=job.id
  await page.exposeFunction(name,async(action,proof)=>{if(proof!==nonce||!sessionAddressAllowed(page.url())||!['sync','return'].includes(action))throw new Error('操作来源无效');if(action==='sync')return sync();return returnToStudio()})
  const options={binding:name,nonce,name:job.name,projectName:job.projectName,browserName:job.browserKind==='edge'?'Edge':'Chrome'}
  await page.evaluateOnNewDocument(installDock,options);await page.evaluate(installDock,options)
 }
 const ensure=async()=>{
  if(ensuring)return ensuring
  ensuring=(async()=>{
   if(job.workspaceTicket){const metadata=await claimTicket();job.projectName=metadata.projectName;delete job.workspaceTicket}
   const pages=await job.browser.pages();job.studioPage=pages.find(page=>{try{return !page.isClosed()&&new URL(page.url()).origin===job.server}catch{return false}})||await job.browser.newPage()
   if(!bound.has(job.studioPage)){
    bound.add(job.studioPage)
    await job.studioPage.exposeFunction('__xiaoyunLocalWorkspace',async action=>{if(new URL(job.studioPage.url()).origin!==job.server||action.connectionId!==job.connectionId)throw new Error('工作区连接不匹配');if(action.action==='open')return openPlatform();if(action.action==='sync')return sync();throw new Error('操作无效')})
   }
   if(job.studioPage.url()!==studioUrl())await job.studioPage.goto(studioUrl(),{waitUntil:'domcontentloaded',timeout:30000})
   const site=await sitePage();if(site)await installSite(site)
   if(!timer){timer=setInterval(()=>void publish(job.busy?'syncing':'ready'),3000);timer.unref?.()}
   await publish();return job.studioPage
  })().finally(()=>{ensuring=null});return ensuring
 }
 const returnToStudio=async()=>{await ensure();await publish();await focus(job.browser,job.studioPage,{headless:job.headless});return {ok:true}}
 const openPlatform=async()=>{await ensure();const page=await sitePage()||await ensureSite();await installSite(page);await publish();return {ok:true,focused:await focus(job.browser,page,{headless:job.headless})}}
 return {ensure,studioRequest,publish,openPlatform,returnToStudio,markStreamSynced(info){lastSyncedStream=fingerprint(info)},async inspectStream(){const page=await sitePage();return page?await readChannelsPageStreamInfo(page):{rtmpUrl:'',streamKey:''}},close(){clearInterval(timer);timer=null}}
}
