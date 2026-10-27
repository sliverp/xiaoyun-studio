import { WebSocketServer, WebSocket } from 'ws'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePresentation } from './store.mjs'
import { ProjectLibrary } from './projects.mjs'
import { Auth, equalToken, checkOrigin } from './auth.mjs'
import { Assets, sendFile } from './assets.mjs'
import { Events } from './events.mjs'
import { MediaEngine, detectTools } from './media.mjs'
import { Providers } from './providers.mjs'
import { LiveDirector } from './director.mjs'
import { PlatformManager } from './platform-manager.mjs'
import { ChannelsCollector } from './channels.mjs'

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const fail=(status,message)=>Object.assign(new Error(message),{status})
async function body(req,limit=1024*1024){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw fail(413,'请求内容过大');chunks.push(chunk)}return Buffer.concat(chunks)}
async function jsonBody(req){const bytes=await body(req);try{return bytes.length?JSON.parse(bytes.toString('utf8')):{}}catch{throw fail(400,'请求 JSON 格式无效')}}
function json(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value))}

/** Own one shared director and media process; controller browsers never own broadcast playback. */
export async function createStudio({root=ROOT,dataDir=process.env.STUDIO_DATA_DIR||join(ROOT,'.data'),host=process.env.STUDIO_HOST||'127.0.0.1',port=Number(process.env.PORT||18080),password=process.env.STUDIO_ADMIN_PASSWORD,mediaFactory,providerFactory,directorFactory,channelsFactory,platformCollectorFactory,env=process.env}={}){
 dataDir=resolve(dataDir);mkdirSync(dataDir,{recursive:true,mode:0o700})
 const projects=new ProjectLibrary({root,dataDir,env}),auth=new Auth({dataDir,password,secure:env.STUDIO_SECURE_COOKIE==='1'}),events=new Events()
 const clients=new Set(),monitors=new Set(),ownedRuntimes=new Set();let current,store,assets,media,director,providers,channels,platforms,actions,closing=false,switching=false
 const projectState=()=>({activeId:projects.activeId,projects:projects.list(),switching})
 const projectError=(code,message)=>Object.assign(fail(409,message),{code})
 const visibleConfig=()=>{const c=store.get();delete c.tts.demoAsset;return c}
 const setup=()=>({tools:detectTools(),providers:providers?.status?.()||{},firstRun:auth.firstRun,headless:true,obsRequired:false,softwareVersion:'0.1.0',commentIngestConfigured:Boolean(store.secret('commentIngestKey'))})
 const snapshot=()=>({projects:projectState(),config:visibleConfig(),director:director?.status?.()||{},media:media?.status?.()||{},channels:channels?.status?.()||{},platforms:platforms?.status?.()||{catalog:[],connections:[],limit:8},secrets:store.presence(),setup:setup()})
 events.getSnapshot=snapshot
 const trustedRender=req=>{const value=req.headers['x-render-token']||new URL(req.url,'http://studio.local').searchParams.get('renderToken');return typeof value==='string'&&current&&equalToken(value,current.renderToken)}
 const internalAccess=req=>trustedRender(req)||auth.isAuthenticated(req)
 const ensurePreview=()=>current.ensurePreview()
 const programState=()=>{const c=store.get(),m=media.status(),d=director.programState();return {...d,scene:c.scene,slideRevision:m.slide?.revision||0,slide:{title:m.slide?.title||'',pageNumber:m.slide?.pageNumber||0,pageCount:m.slide?.pageCount||0,revision:m.slide?.revision||0},audio:current.meter,serverAt:Date.now()}}
 const createActions=runtime=>{
 const {store,media,director,channels,platforms,assets}=runtime,ensurePreview=runtime.ensurePreview,applyBgm=runtime.applyBgm,check=runtime.assertActive
 const navigate=async direction=>{await ensurePreview();check();if(director.status().running&&!director.status().paused)throw fail(409,'请先暂停 AI 讲解，再手动切页');if(direction==='next')await media.nextSlide();else if(direction==='prev')await media.previousSlide();else await media.firstSlide();check();await director.refreshPresentation?.();return snapshot()}
 return {
  'platform.chat.connect':async value=>{await platforms.connect(value.id);return snapshot()},
  'platform.chat.login':async value=>{await platforms.connect(value.id,{login:true});return snapshot()},
  'platform.chat.disconnect':async value=>{await platforms.disconnect(value.id);return snapshot()},
  'platform.chat.click':async value=>{await platforms.click(value.id,{x:value.x,y:value.y});return snapshot()},
  'output.platform.start':async value=>{await platforms.start(value.id);return snapshot()},
  'output.platform.stop':async value=>{await platforms.stop(value.id);return snapshot()},
  'output.platform.retry':async value=>{await platforms.retry(value.id);return snapshot()},
  'channels.connect':async()=>{await channels.connect();return snapshot()},
  'channels.disconnect':async()=>{await channels.disconnect();return snapshot()},
  'channels.click':async value=>{await channels.click({x:value.x,y:value.y});return snapshot()},
  'preview.start':async()=>{await ensurePreview();return snapshot()},
  'live.start':async()=>{await ensurePreview();check();await director.start();return snapshot()},
  'live.pause':()=>{director.pause();return snapshot()},'live.resume':()=>{director.resume();return snapshot()},
  'live.stop':()=>{director.stop();return snapshot()},'live.finish':()=>{director.finish();return snapshot()},
  'live.restart':async()=>{await director.restart();return snapshot()},
  'speech.say':async value=>{await ensurePreview();check();await director.say(value.text);return snapshot()},
  'chat.ask':async value=>{await ensurePreview();check();await director.ask(value.text,{interrupt:value.interrupt===true});return snapshot()},
  'cue.play':async value=>{const cue=store.get().cues.find(c=>c.id===value.id);if(!cue)throw fail(404,'口播不存在');await ensurePreview();check();if(cue.audioUrl)await director.playRecording({text:cue.text||cue.title,path:assets.resolveUrl(cue.audioUrl)});else await director.say(cue.text);return snapshot()},
  'sale.queue':()=>{director.queueSale();return snapshot()},'sale.hide':()=>{director.hideSale();return snapshot()},
  'lottery.queue':()=>{director.queueLottery();return snapshot()},
  'presentation.open':async value=>{if(director.status().running&&!director.status().paused)throw fail(409,'请先暂停 AI 讲解，再更换演示稿');const url=value.url||store.get().presentation.url;validatePresentation(url);await media.openPresentation(url);check();store.update({presentation:{url}});await director.refreshPresentation?.();return snapshot()},
  'presentation.next':()=>navigate('next'),'presentation.prev':()=>navigate('prev'),'presentation.first':()=>navigate('first'),
  'output.start':async()=>{const c=store.get();await media.startOutput({...c.output,videoBitrate:c.output.videoBitrate+'k',audioBitrate:c.output.audioBitrate+'k',destinations:platforms.destinations()},{prepare:ensurePreview});return snapshot()},
  'output.stop':async()=>{platforms.cancelOutputStarts();await media.stopOutput();return snapshot()},
  'bgm.set':value=>{if(value.asset!==undefined)store.update({bgm:{asset:value.asset}});applyBgm();return snapshot()},
 }}
 const relayAudio=buffer=>{for(const socket of monitors){if(socket.readyState!==WebSocket.OPEN)continue;if(socket.bufferedAmount>256*1024){socket.close(1013,'监听延迟过高，请重新连接');continue}socket.send(buffer,{binary:true},()=>{})}}
 async function createRuntime(id){
  const runtime={id,dataDir:projects.directory(id),store:projects.openStore(id),renderToken:randomBytes(32).toString('hex'),meter:{rms:0,voiceRms:0,bgmRms:0},pending:new Set(),closed:false,previewPromise:null}
  ownedRuntimes.add(runtime)
  runtime.close=async()=>{
   if(runtime.cleanupComplete)return
   if(runtime.closePromise)return runtime.closePromise
   runtime.closed=true
   const operation=(async()=>{
    const errors=[]
    try{runtime.platforms?.cancelOutputStarts();await runtime.media?.stopOutput?.()}catch(error){errors.push(error)}
    const results=await Promise.allSettled([()=>runtime.director?.close?.(),()=>runtime.platforms?.close(),()=>runtime.channels?.close(),()=>runtime.media?.close(),()=>runtime.providers?.close?.()].map(close=>Promise.resolve().then(close)))
    runtime.cleanupComplete=results.every(result=>result.status==='fulfilled')
    for(const result of results)if(result.status==='rejected')errors.push(result.reason)
    if(runtime.cleanupComplete)ownedRuntimes.delete(runtime)
    if(errors.length)throw new AggregateError(errors,'当前场次停止时遇到问题，请检查后重试')
   })()
   runtime.closePromise=operation
   try{return await operation}finally{if(runtime.closePromise===operation)runtime.closePromise=null}
  }
  try{
  runtime.assertActive=()=>{if(closing)throw fail(503,'服务正在关闭');if(switching)throw projectError('PROJECT_SWITCHING','正在切换直播场次，请稍候');if(current!==runtime||runtime.closed)throw projectError('PROJECT_CHANGED','直播场次已在其他页面切换，请刷新当前场次后再操作')}
  const active=()=>current===runtime&&!runtime.closed&&!closing&&!switching
  const runtimeEvents={publish:(type,payload)=>{if(active())events.publish(type,payload)}}
  runtime.assets=new Assets({root,dataDir,runtimeDataDir:runtime.dataDir})
  const options={dataDir:runtime.dataDir,baseUrl,renderToken:runtime.renderToken,getSettings:()=>runtime.store.get(),onAudio:buffer=>{if(active())relayAudio(buffer)},onStatus:payload=>runtimeEvents.publish('media',payload),onMeter:payload=>{if(active()){runtime.meter=payload;runtime.director?.audioProgress(payload);events.publish('meter',payload)}}}
  runtime.media=mediaFactory?.(options)||new MediaEngine(options)
  runtime.providers=providerFactory?.({store:runtime.store,dataDir:runtime.dataDir})||new Providers({store:runtime.store,dataDir:runtime.dataDir})
  runtime.director=directorFactory?.({store:runtime.store,media:runtime.media,providers:runtime.providers,events:runtimeEvents,dataDir:runtime.dataDir})||new LiveDirector({store:runtime.store,media:runtime.media,providers:runtime.providers,events:runtimeEvents,dataDir:runtime.dataDir})
  runtime.applyBgm=()=>{const c=runtime.store.get();try{runtime.media.setBgm(c.bgm.asset?runtime.assets.resolveUrl(c.bgm.asset):null,{volume:c.bgm.volume,ducking:c.bgm.ducking})}catch(error){runtimeEvents.publish('error',{error:runtime.store.redact(error.message)})}}
  runtime.ensurePreview=()=>{runtime.assertActive();if(runtime.previewPromise&&!runtime.media.status().ready)runtime.previewPromise=null;if(!runtime.previewPromise)runtime.previewPromise=runtime.media.initialize().then(async()=>{runtime.assertActive();if(!runtime.media.status().slide?.pageNumber&&runtime.store.get().presentation.url)await runtime.media.openPresentation(runtime.store.get().presentation.url);runtime.assertActive();runtime.applyBgm()}).catch(error=>{runtimeEvents.publish('error',{error:runtime.store.redact(error.message)});runtime.previewPromise=null;throw error});return runtime.previewPromise}
  const channelOptions={dataDir:runtime.dataDir,onComments:items=>{if(active())runtime.director.addComments(items)},onMetrics:value=>{if(active())runtime.director.ingestMetrics(value)},onStatus:value=>runtimeEvents.publish('channels',value)}
  runtime.channels=channelsFactory?.(channelOptions)||new ChannelsCollector(channelOptions)
  runtime.platforms=new PlatformManager({store:runtime.store,media:runtime.media,director:runtime.director,events:runtimeEvents,dataDir:runtime.dataDir,collectorFactory:platformCollectorFactory,prepareOutput:runtime.ensurePreview})
  runtime.actions=createActions(runtime)
  return runtime
  }catch(error){try{await runtime.close()}catch(cleanup){throw new AggregateError([error,cleanup],'场次初始化失败，清理时遇到问题')}throw error}
 }
 function installRuntime(runtime){current=runtime;({store,assets,media,director,providers,channels,platforms,actions}=runtime)}
 async function activateProject(id,stopCurrent){
  if(switching)throw projectError('PROJECT_SWITCHING','正在切换直播场次，请稍候')
  projects.openStore(id)
  if(id===current.id&&!current.closed)return snapshot()
  const previous=current,output=previous.media.status().output||{},speech=previous.director.status()
  if((speech.running||output.running||output.active||previous.pending.size)&&!stopCurrent)throw projectError('PROJECT_BUSY','当前场次正在播报、推流、录制或处理操作，请确认停止后切换')
  switching=true;events.publish('state',snapshot())
  let next
  try{
   for(const socket of monitors)socket.close(1012,'直播场次已切换')
   await previous.close()
   if(closing)throw fail(503,'服务正在关闭')
   next=await createRuntime(id)
   if(closing)throw fail(503,'服务正在关闭')
   projects.activate(id)
   installRuntime(next)
  }catch(error){
   if(next&&current!==next)await next.close()
   if(!closing&&previous.cleanupComplete){projects.activate(previous.id);installRuntime(await createRuntime(previous.id))}
   throw error
  }finally{switching=false;if(!closing)events.publish('state',snapshot())}
  return snapshot()
 }
 const server=http.createServer(async(req,res)=>{
  let requestRuntime,pendingToken
  try{
   const url=new URL(req.url,'http://studio.local'),path=url.pathname
   res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Content-Type-Options','nosniff')
   if(closing)throw fail(503,'服务正在关闭')
   if(path==='/health'){return json(res,{ok:true,status:'ok',version:'0.1.0'})}
   if(path==='/api/session'&&req.method==='GET')return json(res,{authenticated:auth.isAuthenticated(req),firstRun:auth.firstRun})
   if(path==='/api/login'&&req.method==='POST'){checkOrigin(req);const data=await jsonBody(req);res.setHeader('Set-Cookie',auth.login(req,data.password));return json(res,{ok:true})}
   if(!current)throw fail(503,'直播服务正在准备，请稍候')
   requestRuntime=current
   const {store,assets,media,director,channels,platforms,actions,ensurePreview,applyBgm}=requestRuntime
   const readBody=async()=>{const value=await jsonBody(req);requestRuntime.assertActive();return value}
   const publicFiles={'/':'index.html','/index.html':'index.html','/app.mjs':'app.mjs','/style.css':'style.css','/favicon.svg':'favicon.svg'}
   if(publicFiles[path]&&['GET','HEAD'].includes(req.method)){res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");return sendFile(req,res,join(root,'public',publicFiles[path]),{noCache:true})}
   if(path==='/vendor/pdfjs/pdf.mjs'||path==='/vendor/pdfjs/pdf.worker.mjs')return sendFile(req,res,join(root,'node_modules/pdfjs-dist/build',path.endsWith('worker.mjs')?'pdf.worker.mjs':'pdf.mjs'))
   if(path==='/pdf-viewer'||path==='/pdf-viewer.mjs'){if(!internalAccess(req))throw fail(401,'请先登录');return sendFile(req,res,join(root,'public',path==='/pdf-viewer'?'pdf-viewer.html':'pdf-viewer.mjs'),{noCache:true})}
   if(path==='/program'||path==='/program.mjs'||path==='/program.css'){
    if(!internalAccess(req))throw fail(401,'请先登录')
    return sendFile(req,res,join(root,'public',path==='/program'?'program.html':path.slice(1)),{noCache:true})
   }
   if(path.startsWith('/internal/')){
    if(!internalAccess(req))throw fail(401,'内部渲染认证失败')
    if(path==='/internal/program')return json(res,programState())
    if(path==='/internal/slide.jpg'){const frame=media.getSlideFrame();if(!frame){res.writeHead(204);return res.end()}res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});return res.end(frame)}
    const avatar=/^\/internal\/avatar\/([a-z-]+)\.png$/.exec(path)
    if(avatar){if(!['greeting','listen','ponder','explain','happy','wink','rest','thinking','cool'].includes(avatar[1]))throw fail(404,'形象不存在');return sendFile(req,res,join(root,'public/builtin/avatar',avatar[1]+'.png'))}
    if(path.startsWith('/internal/assets/'))return sendFile(req,res,assets.resolveUrl(path.replace('/internal/assets/','/assets/')))
    throw fail(404,'未找到资源')
   }
   if(path.startsWith('/assets/')){
    if(!internalAccess(req))throw fail(401,'请先登录')
    const file=assets.resolveUrl(path);return sendFile(req,res,file,{attachment:path.startsWith('/assets/uploads/')&&['.html','.svg'].includes(extname(file))&&!trustedRender(req)})
   }
   const ingest=(path==='/api/comments'||path==='/api/metrics')&&typeof req.headers['x-ingest-key']==='string'&&equalToken(req.headers['x-ingest-key'],store.secret('commentIngestKey'))
   if(!auth.isAuthenticated(req)&&!ingest)throw fail(401,'请先登录')
   checkOrigin(req)
   if(!['GET','HEAD','OPTIONS'].includes(req.method)){
    requestRuntime.assertActive()
    const expected=req.headers['x-studio-project']
    if(expected!==undefined&&(typeof expected!=='string'||expected!==requestRuntime.id))throw projectError('PROJECT_CHANGED','直播场次已在其他页面切换，请刷新当前场次后再操作')
    if(!/^\/api\/projects\/[A-Za-z0-9_-]+\/activate$/.test(path)){pendingToken={};requestRuntime.pending.add(pendingToken)}
   }
   if(path==='/api/logout'&&req.method==='POST'){res.setHeader('Set-Cookie',auth.logout(req));return json(res,{ok:true})}
   if(path==='/api/state'&&req.method==='GET')return json(res,snapshot())
   if(path==='/api/projects'&&req.method==='GET')return json(res,projectState())
   const projectValue=async allowed=>{const value=await readBody();if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail(400,'场次操作参数无效');return value}
   if(path==='/api/projects'&&req.method==='POST'){const project=projects.create(await projectValue(['name','copyCurrent']));events.publish('state',snapshot());return json(res,{ok:true,project,projects:projectState()},201)}
   const projectPath=/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(\/activate)?$/.exec(path)
   if(projectPath){
    const id=projectPath[1]
    if(projectPath[2]&&req.method==='POST'){const value=await projectValue(['stopCurrent']);if(value.stopCurrent!==undefined&&typeof value.stopCurrent!=='boolean')throw fail(400,'停止当前场次选项无效');return json(res,{ok:true,...await activateProject(id,value.stopCurrent===true)})}
    if(!projectPath[2]&&req.method==='PUT'){const value=await projectValue(['name']),project=projects.rename(id,value.name);events.publish('state',snapshot());return json(res,{ok:true,project,projects:projectState()})}
    if(!projectPath[2]&&req.method==='DELETE'){projects.remove(id);events.publish('state',snapshot());return json(res,{ok:true,projects:projectState()})}
   }
   if(path==='/api/platforms'&&req.method==='GET')return json(res,platforms.status())
   if(path==='/api/platforms'&&req.method==='POST'){platforms.create(await readBody());return json(res,{ok:true,...snapshot()},201)}
   const platformPath=/^\/api\/platforms\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(\/frame\.jpg)?$/.exec(path)
   if(platformPath){const id=platformPath[1];if(platformPath[2]&&req.method==='GET'){const frame=platforms.frame(id);if(!frame){res.writeHead(204,{'Cache-Control':'no-store'});return res.end()}res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});return res.end(frame)}if(!platformPath[2]&&req.method==='PUT'){await platforms.update(id,await readBody());requestRuntime.assertActive();return json(res,{ok:true,...snapshot()})}if(!platformPath[2]&&req.method==='DELETE'){await platforms.remove(id);requestRuntime.assertActive();return json(res,{ok:true,...snapshot()})}}
   if(path==='/api/channels/status'&&req.method==='GET')return json(res,channels.status())
   if(path==='/api/channels/frame.jpg'&&req.method==='GET'){const frame=channels.getFrame();if(!frame){res.writeHead(204,{'Cache-Control':'no-store'});return res.end()}res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});return res.end(frame)}
   if(path==='/api/setup'&&req.method==='GET')return json(res,setup())
   if(path==='/api/events'&&req.method==='GET'){
    if(clients.size>=32)throw fail(429,'监控连接过多')
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('event: message\ndata: '+JSON.stringify({type:'snapshot',payload:snapshot()})+'\n\n')
    const listener=event=>{if(res.writableEnded||res.destroyed)return;if(res.writableLength>1024*1024){res.destroy();return}res.write('id: '+event.id+'\ndata: '+JSON.stringify(event)+'\n\n')}
    const ping=setInterval(()=>res.write(': ping\n\n'),15000);ping.unref();events.on('event',listener);clients.add(res);const cleanup=()=>{clearInterval(ping);events.off('event',listener);clients.delete(res)};res.studioCleanup=cleanup;req.on('close',cleanup);return
   }
   if(path==='/api/config'&&req.method==='PUT'){
    const data=await readBody()
    if(data.patch?.platforms!==undefined)throw fail(400,'请通过平台连接入口修改平台设置')
    if(data.patch?.output&&(['preparing','starting','streaming','running','reconnecting'].includes(media.status().output?.state)||media.status().output?.active||media.status().output?.running))throw fail(409,'请先停止推流或录制，再修改输出设置')
    if(data.patch)store.update(data.patch);if(data.secrets)store.setSecrets(data.secrets);director.settingsChanged?.();applyBgm();events.publish('config',visibleConfig());return json(res,snapshot())
   }
   if(path==='/api/action'&&req.method==='POST'){const data=await readBody(),action=Object.hasOwn(actions,data.action)?actions[data.action]:null;if(!action)throw fail(400,'操作不存在');const result=await action(data);requestRuntime.assertActive();return json(res,{ok:true,...result})}
   if(path==='/api/assets'&&req.method==='GET')return json(res,assets.list())
   if(path==='/api/upload'&&req.method==='POST'){
    const bytes=await body(req,100*1024*1024);requestRuntime.assertActive();const entry=assets.upload(bytes,{filename:String(req.headers['x-filename']||'asset'),type:String(req.headers['x-asset-type']||'')});return json(res,{ok:true,url:entry.url,asset:entry},201)
   }
   if(path==='/api/frame.jpg'&&req.method==='GET'){void ensurePreview().catch(()=>{});const frame=media.getFrame();if(!frame){res.writeHead(204,{'Cache-Control':'no-store'});return res.end()}res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});return res.end(frame)}
   if(path==='/api/slide.jpg'&&req.method==='GET'){const frame=media.getSlideFrame();if(!frame){res.writeHead(204);return res.end()}res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});return res.end(frame)}
   if(path==='/api/comments'&&req.method==='POST'){const data=await readBody();director.addComments(Array.isArray(data)?data:data.comments||data.items||data.events||[]);return json(res,{ok:true})}
   if(path==='/api/metrics'&&req.method==='POST'){director.ingestMetrics(await readBody());return json(res,{ok:true})}
   if(path==='/api/ingest-key'&&req.method==='POST')return json(res,{key:store.secret('commentIngestKey')})
   if(path==='/api/transcribe'&&req.method==='POST'){const bytes=await body(req,16*1024*1024);requestRuntime.assertActive();const text=await requestRuntime.providers.transcribe(bytes,req.headers['content-type']||'audio/webm');requestRuntime.assertActive();return json(res,{text})}
   if(path==='/api/report'&&req.method==='GET'){
    const format=url.searchParams.get('format')||'json';if(!['json','csv','md'].includes(format))throw fail(400,'报告格式无效');const report=director.report(format);if(format==='json')return json(res,report);res.writeHead(200,{'Content-Type':format==='csv'?'text/csv; charset=utf-8':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="broadcast-report.'+format+'"','Cache-Control':'no-store'});return res.end(report)
   }
   throw fail(404,'未找到页面或接口')
  }catch(error){if(res.headersSent)return res.destroy();const errorStore=requestRuntime?.store||store,message=errorStore?errorStore.redact(error.message||error):String(error.message||error);json(res,{ok:false,error:message,...(String(error.code||'').startsWith('PROJECT_')?{code:error.code}:{}),activeProjectId:projects.activeId},error.status||(['ENOENT','ENOTDIR'].includes(error.code)?404:400))}
  finally{if(pendingToken)requestRuntime.pending.delete(pendingToken)}
 })
 const monitorServer=new WebSocketServer({noServer:true,maxPayload:1024})
 server.on('upgrade',(req,socket,head)=>{try{const url=new URL(req.url,'http://studio.local');if(closing||switching||url.pathname!=='/api/monitor'||!auth.isAuthenticated(req)||monitors.size>=8)throw new Error('not authorized');if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw new Error('invalid origin');monitorServer.handleUpgrade(req,socket,head,client=>{monitors.add(client);client.send(JSON.stringify({sampleRate:48000,channels:2,format:'s16le',projectId:current.id}));client.on('close',()=>monitors.delete(client));client.on('error',()=>monitors.delete(client))})}catch{socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')}})
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,host,done)})
 const address=server.address(),baseUrl='http://127.0.0.1:'+address.port
 try{installRuntime(await createRuntime(projects.activeId))}catch(error){await Promise.allSettled([...ownedRuntimes].map(runtime=>runtime.close()));monitorServer.close();await new Promise(done=>server.close(done));throw error}
 async function close(){if(closing)return;closing=true;for(const client of [...clients]){client.studioCleanup?.();client.end()}for(const socket of monitors)socket.terminate();monitorServer.close();const results=await Promise.allSettled([...ownedRuntimes].map(runtime=>runtime.close()));await new Promise(done=>server.close(done));const errors=results.filter(result=>result.status==='rejected');if(errors.length)throw new AggregateError(errors.map(result=>result.reason),'直播运行资源未能完整停止')}
 return {server,baseUrl,auth,events,projects,snapshot,ensurePreview,close,dataDir,get runtimeDataDir(){return current.dataDir},get store(){return store},get assets(){return assets},get media(){return media},get director(){return director},get providers(){return providers},get channels(){return channels},get platforms(){return platforms}}
}
