/** Local, dedicated browser windows; transferable state is never placed in browser URLs or logs. */
import http from 'node:http'
import {mkdir,readFile} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolve,join} from 'node:path'
import {randomBytes,createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import puppeteer from 'puppeteer-core'
import {detectTools} from '../server/media.mjs'
import {captureBrowserSession,normalizeBrowserSession,seedBrowserSession,backendSessionReady,CHANNEL_ENTRY,sessionAddressAllowed} from '../server/browser-session.mjs'
import {closePlatformBrowser,browserDeadline} from '../server/platform-browser.mjs'
import {atomicJson} from '../server/store.mjs'
import {createLocalWorkspace} from './local-workspace.mjs'
import {localBrowserPath} from './local-browser-path.mjs'
import {launchLocalBrowser} from './local-browser-launch.mjs'

const execFileAsync=promisify(execFile)
const connectionId=(server,projectId,id)=>createHash('sha256').update(JSON.stringify([server,projectId,id])).digest('hex').slice(0,32)
function detachBrowser(browser){const child=browser?.process();child?.unref();for(const stream of child?.stdio||[])stream?.unref?.();browser?.disconnect()}
/** Only activate the browser process that owns this helper's dedicated browser. */
async function focusBrowser(browser,page,{headless}){
 await page.bringToFront()
 if(headless)return false
 let session
 try{
  session=await browser.target().createCDPSession();const target=await page.createCDPSession()
  try{const {targetInfo}=await target.send('Target.getTargetInfo'),window=await session.send('Browser.getWindowForTarget',{targetId:targetInfo.targetId});if(window.bounds.windowState==='minimized')await session.send('Browser.setWindowBounds',{windowId:window.windowId,bounds:{windowState:'normal'}})}finally{await target.detach()}
  if(process.platform!=='darwin')return true
  const pid=browser.process()?.pid||(await session.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser')?.id
  if(!Number.isSafeInteger(pid)||pid<=0)return false
  const script='ObjC.import("AppKit");var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier('+pid+');if(app){app.activateWithOptions(3);delay(0.2);Boolean(app.active)}else{false}'
  const result=await execFileAsync('/usr/bin/osascript',['-l','JavaScript','-e',script],{timeout:4000});return result.stdout.trim()==='true'
 }catch{return false}finally{await session?.detach().catch(()=>{})}
}

const HTML=`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>小云 · 本机浏览器登录</title><style>body{font:16px/1.8 system-ui;max-width:760px;margin:60px auto;padding:24px;background:#11151f;color:#e6eaf3}button,select{padding:12px 20px;margin:10px 12px 10px 0;border:1px solid #38435a;border-radius:8px;background:#7560e8;color:white;font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}select{max-width:100%;background:#1e2637}p{color:#b6c1d8}.box{border:1px solid #38435a;padding:22px;border-radius:12px}#error{color:#ffb5be}a{color:#b8aaff}</style><h1>在本机浏览器操作视频号</h1><p>这是小云的本机助手，只同步你选中的视频号连接。</p><div class="box"><label id="connection-picker" hidden>选择直播连接 <select id="connections" aria-label="直播连接"></select></label><strong id="name">正在读取本机连接…</strong><p id="status">请稍候</p><button id="open" disabled>打开视频号后台</button><button id="sync" disabled>同步登录状态到服务器</button><p id="result" role="status"></p><p id="error" role="alert"></p><a id="studio" hidden target="_blank" rel="noopener">回小云重新连接 / 授权</a></div><p>在弹出的专用浏览器窗口里扫码、选择账号，并直接设置封面、标题和开播信息。完成后回到这里同步，服务器验证成功后会接管弹幕采集。</p><p>同步成功后可以关闭本机窗口。后续登录过期时，回小云重新连接和同步。</p><script src="/app.js"></script></html>`
const CLIENT=`
const $=id=>document.getElementById(id);
let jobId='',busy=false,connections=[];
const token=document.querySelector('meta[name="local-token"]').content;
async function api(path,value){
 const r=await fetch(path,{method:value?'POST':'GET',headers:{'Content-Type':'application/json','X-Local-Token':token},body:value?JSON.stringify(value):undefined});
 const data=await r.json();
 if(!r.ok){if(r.status===401&&data.code==='LOCAL_AUTH_EXPIRED')location.reload();const error=new Error(data.error||'操作失败');error.status=r.status;error.code=data.code;throw error}
 return data;
}
function bind(id){jobId=id;history.replaceState(null,'',id?'/connections/'+id:'/');$('connections').value=id;$('open').disabled=!id;$('sync').disabled=true}
async function loadConnections(preferred=jobId){
 connections=(await api('/api/connections')).connections;
 $('connections').replaceChildren(new Option('请选择连接',''),...connections.map(c=>new Option(c.name+' · '+new URL(c.server).hostname,c.id)));
 $('connection-picker').hidden=connections.length<2;
 const selected=connections.some(c=>c.id===preferred)?preferred:connections.length===1?connections[0].id:'';
 bind(selected);
 if(!selected){$('name').textContent=connections.length?'请选择直播连接':'尚未连接小云';$('status').textContent=connections.length?'选择后可打开对应的视频号后台。':'请在小云的对应视频号连接里点击「本机浏览器登录」。';$('open').disabled=true}
 return Boolean(selected);
}
async function refresh(){
 if(!jobId||busy)return;
 try{
  const s=await api('/api/status?id='+encodeURIComponent(jobId));
  $('name').textContent=s.name||'视频号连接';$('open').disabled=false;
  $('studio').href=s.server;$('studio').hidden=!s.needsPair;
  $('status').textContent=s.synced?'上次同步成功，服务器独立运行。':s.loggedIn?'本机已登录，可直接操作后台；完成后点击同步。':s.browserOpen?'请在本机浏览器 完成扫码和账号选择。':'后台标签页已关闭，点击「打开视频号后台」即可重新打开。';
  $('sync').disabled=!s.loggedIn||s.needsPair||s.synced;
  if(s.needsPair&&!s.synced)$('result').textContent='本机窗口仍可打开；同步授权已失效，请回小云重新连接。';
 }catch(e){if(e.code==='CONNECTION_NOT_FOUND'){if(await loadConnections())await refresh()}else $('error').textContent=e.message}
}
async function run(action){
 if(!jobId){await loadConnections();await refresh();return}
 busy=true;$('error').textContent='';$('open').disabled=true;$('sync').disabled=true;
 $('result').textContent=action==='open'?'正在打开本机浏览器…':'正在同步并验证登录状态…';
 try{const result=await api('/api/'+action,{id:jobId});$('result').textContent=action==='open'?(result.focused?'浏览器窗口已置前，请直接在窗口中操作。':'后台已打开，请切换到专用浏览器窗口操作。'):'同步成功，服务器已验证此连接。'}catch(e){$('result').textContent='';$('error').textContent=e.message;if(e.code==='CONNECTION_NOT_FOUND')await loadConnections()}
 finally{busy=false;await refresh()}
}
$('open').onclick=()=>run('open');$('sync').onclick=()=>run('sync');
$('connections').onchange=()=>{bind($('connections').value);$('error').textContent='';refresh()};
async function boot(){
 try{
  const fragment=location.hash.slice(1),path=/^\\/connections\\/([a-f0-9]{32})$/.exec(location.pathname);
  history.replaceState(null,'','/');
  if(path)jobId=path[1];else if(fragment.startsWith('connection='))jobId=fragment.slice(11);
  else if(fragment){const pair=JSON.parse(decodeURIComponent(fragment));const data=await api('/api/pair',pair);jobId=data.id;if(data.workspace){$('name').textContent='Edge 工作区已打开';$('status').textContent='小云和视频号已在同一个 Edge 工作窗口中。';setTimeout(()=>window.close(),150);return}}
  await loadConnections(jobId);await refresh();setInterval(refresh,2000);
 }catch(e){$('name').textContent='本机连接需要处理';$('status').textContent='请按下方提示重新连接。';$('error').textContent=e.message;try{if(await loadConnections())await refresh()}catch{}}
}
boot();
`

export async function createLocalBrowserHelper({servers,relay,port=18082,dataDir=resolve(fileURLToPath(new URL('../.data/local-browser',import.meta.url))),headless=false,launch=launchLocalBrowser,fetchImpl=fetch,preferredBrowser='chrome',browserPaths}={}){
 const trusted=new Set((servers||[]).map(value=>new URL(value).origin));if(!trusted.size)throw new Error('请通过 --server 指定你的小云服务器地址')
 if(relay){const u=new URL(relay);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('SSH 转发地址必须是本机回环地址');relay=u.origin}
 const nonce=randomBytes(32).toString('hex'),jobs=new Map();let baseUrl
 await mkdir(dataDir,{recursive:true,mode:0o700})
 const registry=join(dataDir,'connections.json')
 try{const records=JSON.parse(await readFile(registry,'utf8'));if(!Array.isArray(records))throw new Error('invalid registry');for(const item of records){if(!item||!trusted.has(item.server)||typeof item.projectId!=='string'||typeof item.connectionId!=='string'||item.id!==connectionId(item.server,item.projectId,item.connectionId)||typeof item.name!=='string'||item.name.length>100)continue;jobs.set(item.id,{id:item.id,server:item.server,projectId:item.projectId,connectionId:item.connectionId,name:item.name,projectName:item.projectName||'',browserKind:item.browserKind==='edge'?'edge':'chrome',workspace:item.workspace===true,expiresAt:Number(item.expiresAt)||0,token:typeof item.token==='string'&&/^[\w-]{43}$/.test(item.token)?item.token:'',synced:item.synced===true})}}catch(error){if(error.code!=='ENOENT')throw new Error('本机连接记录无法读取，请从小云重新连接')}
 const persist=()=>atomicJson(registry,[...jobs.values()].map(job=>({id:job.id,server:job.server,projectId:job.projectId,connectionId:job.connectionId,name:job.name,projectName:job.projectName||'',browserKind:job.browserKind||'chrome',workspace:Boolean(job.workspace),expiresAt:job.expiresAt,token:!job.synced&&job.expiresAt>Date.now()?job.token:'',synced:Boolean(job.synced)})))
 const profileFor=job=>join(dataDir,job.id+(job.browserKind==='edge'?'-edge':''))
 const watchBrowser=(job,browser)=>{job.browser=browser;browser.once('disconnected',()=>{if(job.browser===browser){job.browser=null;job.page=null}})}
 const adopt=async job=>{
  if(job.browser?.connected)return true
  if(job.adopting)return job.adopting
  job.adopting=(async()=>{let cancelled=false,browser;try{const [port]=String(await readFile(join(profileFor(job),'DevToolsActivePort'))).split('\n');if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)return false;const pending=puppeteer.connect({browserURL:'http://127.0.0.1:'+Number(port),protocolTimeout:5000,defaultViewport:null});pending.then(value=>{if(cancelled)value.disconnect()},()=>{});browser=await browserDeadline(pending,2000,'本机窗口连接超时');watchBrowser(job,browser);return true}catch{cancelled=true;return false}finally{job.adoptChecked=true}})().finally(()=>{job.adopting=null})
  return job.adopting
 }
 const serverCall=async(job,path,value)=>{
  let response;try{response=await fetchImpl((relay||job.server)+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+job.token},body:value===undefined?undefined:JSON.stringify(value),redirect:'error',signal:AbortSignal.timeout(60000)})}catch{throw new Error('无法连接配置的小云服务器，请检查地址和网络')}
  let result;try{result=await response.json()}catch{throw new Error('小云服务器返回了无效响应')}
  if(!response.ok)throw Object.assign(new Error(result.error||'服务器未能完成同步'),{status:response.status});return result
 }
 const pageFor=async job=>{if(!job.browser?.connected)return null;return (await job.browser.pages()).filter(page=>!page.isClosed()&&sessionAddressAllowed(page.url())).at(-1)||null}
 const ensureSite=async job=>{let page=await pageFor(job);if(!page){page=await job.browser.newPage();if(job.seed){await seedBrowserSession(job.browser,page,job.seed);delete job.seed}await page.goto(CHANNEL_ENTRY,{waitUntil:'domcontentloaded',timeout:30000})}job.page=page;return page}
 const claimWorkspace=async job=>{
  const r=await fetchImpl((relay||job.server)+'/api/local-workspace/claim',{method:'POST',headers:{Authorization:'Bearer '+job.workspaceTicket},redirect:'error',signal:AbortSignal.timeout(30000)}),value=await r.json()
  if(!r.ok)throw new Error(value.error||'工作区登录未能恢复，请从小云重新打开')
  const raw=r.headers.getSetCookie().find(cookie=>cookie.startsWith('studio_session=')),match=/^studio_session=([\w-]{43});/.exec(raw||'')
  if(!match)throw new Error('小云工作区没有返回有效登录状态')
  if(value.connectionId!==job.connectionId||value.projectId!==job.projectId)throw new Error('工作区场景不匹配')
  await job.browser.defaultBrowserContext().setCookie({name:'studio_session',value:match[1],domain:new URL(job.server).hostname,path:'/',httpOnly:true,sameSite:'Strict',secure:raw.includes('; Secure'),expires:Date.now()/1000+86400})
  return value
 }
 const workspaceFor=job=>job.controller||=createLocalWorkspace({job,focus:focusBrowser,claimTicket:()=>claimWorkspace(job),sync:()=>sync(job),ensureSite:()=>ensureSite(job)})
 const open=async job=>{
  if(job.opening)return job.opening
  job.opening=(async()=>{
   if(!job.browser?.connected)await adopt(job)
   if(!job.browser?.connected){const args=['--new-window','--disable-dev-shm-usage'];if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox');watchBrowser(job,await launch({executablePath:browserPaths?.[job.browserKind]||localBrowserPath(job.browserKind||'chrome'),userDataDir:profileFor(job),headless,args,defaultViewport:null,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false}))}
   job.page=await pageFor(job)
   if(job.page)delete job.seed
   if(!job.page){job.page=await job.browser.newPage();if(job.seed){await seedBrowserSession(job.browser,job.page,job.seed);delete job.seed}await job.page.goto(CHANNEL_ENTRY,{waitUntil:'domcontentloaded',timeout:30000})}
   if(job.workspace){job.headless=headless;const controller=workspaceFor(job),studio=await controller.ensure(),target=job.initialIntent==='open'?job.page:studio;delete job.initialIntent;for(const page of await job.browser.pages())if(page.url()==='about:blank')await page.close();persist();return {ok:true,opened:true,workspace:true,focused:await focusBrowser(job.browser,target,{headless})}}
   if(!(await job.browser.pages()).some(page=>page.url()===baseUrl+'/connections/'+job.id)){const control=await job.browser.newPage();await control.goto(baseUrl+'/connections/'+job.id)}
   return {ok:true,opened:true,focused:await focusBrowser(job.browser,job.page,{headless})}
  })().finally(()=>{job.opening=null})
  return job.opening
 }
 const pair=async(value,{seed}={})=>{
  if(typeof value?.serverUrl!=='string'||!trusted.has(value.serverUrl)||typeof value.token!=='string')throw new Error('助手仅允许连接启动时指定的小云地址')
  const draft={server:value.serverUrl,token:value.token},grant=await serverCall(draft,'/api/local-login/pair')
  if(grant.platform!=='wechat'||typeof grant.projectId!=='string'||typeof grant.connectionId!=='string')throw new Error('本机登录授权格式无效')
  const id=connectionId(draft.server,grant.projectId,grant.connectionId)
  if(!jobs.has(id)&&jobs.size>=8)throw new Error('本机同时连接最多 8 个账号')
  const job=jobs.get(id)||{id,browserKind:'chrome'},kind=value.browser||preferredBrowser
  if(!['edge','chrome'].includes(kind))throw new Error('请选择 Edge 或 Chrome')
  if(job.browserKind!==kind){if(job.browser?.connected){const page=await pageFor(job);if(page&&await backendSessionReady(page))job.seed=await captureBrowserSession(job.browser,page);detachBrowser(job.browser)}job.controller?.close();job.controller=null;job.browser=null;job.page=null;job.adoptChecked=false;job.browserKind=kind}
  Object.assign(job,draft,{projectId:grant.projectId,connectionId:grant.connectionId,name:grant.name,expiresAt:grant.expiresAt,synced:false});if(seed)job.seed=normalizeBrowserSession(seed);if(value.workspaceTicket){job.workspace=true;job.workspaceTicket=value.workspaceTicket;job.initialIntent=value.intent==='open'?'open':'studio'}jobs.set(id,job);persist();const opened=await open(job);return {id,workspace:opened.workspace===true,server:job.server,connectionId:job.connectionId}
 }
 const status=async job=>{if(!job)throw new Error('本机连接不存在');if(!job.browser?.connected&&!job.adoptChecked)await adopt(job);let page,loggedIn=false;try{page=await pageFor(job);if(page)loggedIn=await backendSessionReady(page)}catch{}return {id:job.id,name:job.name,server:job.server,browser:job.browserKind,workspace:Boolean(job.workspace),browserOpen:Boolean(page),loggedIn,synced:Boolean(job.synced),needsPair:job.workspace?!job.workspaceAuthenticated:!job.token||job.expiresAt<=Date.now(),opening:Boolean(job.opening)}}
 const sync=async job=>{
  if(job.busy)throw new Error('正在同步，请稍候');job.busy=true
  try{
   if(!(await status(job)).loggedIn)throw new Error('请先在视频号完成扫码和账号选择')
   let payload=await captureBrowserSession(job.browser,await pageFor(job))
   if(job.workspace){const controller=workspaceFor(job);await controller.ensure();const grant=await controller.studioRequest('/api/platforms/'+job.connectionId+'/local-login',{});job.token=grant.token;job.expiresAt=grant.expiresAt;payload={session:payload,streamInfo:await controller.inspectStream()};await controller.publish('syncing')}
   const result=await serverCall(job,'/api/local-login/sync',payload);job.synced=true;persist();if(job.workspace){if(result.streamInfoSaved)workspaceFor(job).markStreamSynced(payload.streamInfo);await workspaceFor(job).publish();await workspaceFor(job).returnToStudio()}return {ok:true,...result}
  }catch(error){if(error.status){job.token='';persist()}if(job.workspace)await workspaceFor(job).returnToStudio().catch(()=>{});throw error}finally{job.busy=false;if(job.workspace)await workspaceFor(job).publish()}
 }
 const server=http.createServer(async(req,res)=>{
  const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
  try{
   const url=new URL(req.url,baseUrl),origin='http://'+req.headers.host;if(origin!==baseUrl||req.headers.origin&&req.headers.origin!==baseUrl)throw new Error('本机请求来源无效')
   res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff')
   if((url.pathname==='/'||/^\/connections\/[a-f0-9]{32}$/.test(url.pathname))&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(HTML.replace('<title>','<meta name="local-token" content="'+nonce+'"><title>'))}
   if(url.pathname==='/app.js'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(CLIENT)}
   if(req.headers['x-local-token']!==nonce)return send({error:'本机助手已更新，请刷新页面',code:'LOCAL_AUTH_EXPIRED'},401)
   let value
   if(req.method==='POST'){const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>8192)throw new Error('本机请求过大');chunks.push(chunk)}value=JSON.parse(Buffer.concat(chunks).toString())}
   if(url.pathname==='/api/pair'&&req.method==='POST')return send(await pair(value))
   if(url.pathname==='/api/connections'&&req.method==='GET')return send({connections:[...jobs.values()].map(({id,name,server})=>({id,name,server}))})
   const job=jobs.get(value?.id||url.searchParams.get('id'));if(!job)return send({error:'本机连接已失效，请重新选择连接',code:'CONNECTION_NOT_FOUND'},404)
   if(url.pathname==='/api/status'&&req.method==='GET')return send(await status(job))
   if(url.pathname==='/api/open'&&req.method==='POST')return send(await open(job))
   if(url.pathname==='/api/sync'&&req.method==='POST')return send(await sync(job))
   send({error:'接口不存在'},404)
  }catch(error){send({error:String(error.message).slice(0,300)},400)}
 })
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done)});baseUrl='http://127.0.0.1:'+server.address().port
 // Rebind surviving workspaces without reopening browsers the user has closed.
 await Promise.allSettled([...jobs.values()].filter(job=>job.workspace).map(async job=>{if(await adopt(job)){job.headless=headless;await workspaceFor(job).ensure()}}))
 return {baseUrl,pair,status:async id=>status(jobs.get(id)),sync:async id=>sync(jobs.get(id)),async close({keepBrowsers=false}={}){persist();await Promise.allSettled([...jobs.values()].map(job=>{job.controller?.close();if(keepBrowsers){detachBrowser(job.browser);return}return closePlatformBrowser(job.browser)}));await new Promise(done=>server.close(done))}}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),servers=args.flatMap((arg,i)=>arg==='--server'?[args[i+1]]:[]),bootstrapIndex=args.indexOf('--bootstrap')
 const relayIndex=args.indexOf('--relay'),browserIndex=args.indexOf('--browser'),helper=await createLocalBrowserHelper({servers,relay:relayIndex>=0?args[relayIndex+1]:undefined,preferredBrowser:browserIndex>=0?args[browserIndex+1]:'edge'});console.log('小云本机浏览器助手已启动：'+helper.baseUrl)
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void helper.close({keepBrowsers:true}).finally(()=>process.exit(0))})
 if(bootstrapIndex>=0){const config=JSON.parse(await readFile(args[bootstrapIndex+1],'utf8'));const {id}=await helper.pair(config,{seed:config.seed});console.log('独立的本机视频号窗口已打开。');if(args.includes('--verify-sync')){for(let i=0;i<25;i++){const state=await helper.status(id);if(state.loggedIn){await helper.sync(id);console.log('本机登录状态已同步，服务器验证通过。');break}if(i===24)console.log('请在本机窗口完成扫码，再到助手页点击同步。');await new Promise(done=>setTimeout(done,1000))}}}
}
