import { WebSocketServer, WebSocket } from 'ws'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store, validatePresentation } from './store.mjs'
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
 const store=new Store({root,dataDir,env}),auth=new Auth({dataDir,password,secure:env.STUDIO_SECURE_COOKIE==='1'}),assets=new Assets({root,dataDir}),events=new Events()
 const renderToken=randomBytes(32).toString('hex'),clients=new Set(),monitors=new Set();let media,director,providers,channels,platforms,closing=false,previewPromise=null,meter={rms:0,voiceRms:0,bgmRms:0}
 const redact=value=>store.redact(value?.message||value)
 const visibleConfig=()=>{const c=store.get();delete c.tts.demoAsset;return c}
 const setup=()=>({tools:detectTools(),providers:providers?.status?.()||{},firstRun:auth.firstRun,headless:true,obsRequired:false,softwareVersion:'0.1.0',commentIngestConfigured:Boolean(store.secret('commentIngestKey'))})
 const snapshot=()=>({config:visibleConfig(),director:director?.status?.()||{},media:media?.status?.()||{},channels:channels?.status?.()||{},platforms:platforms?.status?.()||{catalog:[],connections:[],limit:8},secrets:store.presence(),setup:setup()})
 events.getSnapshot=snapshot
 const trustedRender=req=>{const value=req.headers['x-render-token']||new URL(req.url,'http://studio.local').searchParams.get('renderToken');return typeof value==='string'&&equalToken(value,renderToken)}
 const internalAccess=req=>trustedRender(req)||auth.isAuthenticated(req)
 const ensurePreview=()=>{if(previewPromise&&!media.status().ready)previewPromise=null;if(!previewPromise)previewPromise=media.initialize().then(async()=>{if(!media.status().slide?.pageNumber&&store.get().presentation.url)await media.openPresentation(store.get().presentation.url);applyBgm()}).catch(error=>{events.publish('error',{error:redact(error)});previewPromise=null;throw error});return previewPromise}
 const applyBgm=()=>{const c=store.get();try{media.setBgm(c.bgm.asset?assets.resolveUrl(c.bgm.asset):null,{volume:c.bgm.volume,ducking:c.bgm.ducking})}catch(e){events.publish('error',{error:redact(e)})}}
 const programState=()=>{const c=store.get(),m=media.status(),d=director.programState();return {...d,scene:c.scene,slideRevision:m.slide?.revision||0,slide:{title:m.slide?.title||'',pageNumber:m.slide?.pageNumber||0,pageCount:m.slide?.pageCount||0,revision:m.slide?.revision||0},audio:meter,serverAt:Date.now()}}
 const navigate=async direction=>{await ensurePreview();if(director.status().running&&!director.status().paused)throw fail(409,'请先暂停 AI 讲解，再手动切页');if(direction==='next')await media.nextSlide();else if(direction==='prev')await media.previousSlide();else await media.firstSlide();await director.refreshPresentation?.();return snapshot()}
 const actions={
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
  'live.start':async()=>{await ensurePreview();await director.start();return snapshot()},
  'live.pause':()=>{director.pause();return snapshot()},'live.resume':()=>{director.resume();return snapshot()},
  'live.stop':()=>{director.stop();return snapshot()},'live.finish':()=>{director.finish();return snapshot()},
  'live.restart':async()=>{await director.restart();return snapshot()},
  'speech.say':async value=>{await ensurePreview();await director.say(value.text);return snapshot()},
  'chat.ask':async value=>{await ensurePreview();await director.ask(value.text,{interrupt:value.interrupt===true});return snapshot()},
  'cue.play':async value=>{const cue=store.get().cues.find(c=>c.id===value.id);if(!cue)throw fail(404,'口播不存在');await ensurePreview();if(cue.audioUrl)await director.playRecording({text:cue.text||cue.title,path:assets.resolveUrl(cue.audioUrl)});else await director.say(cue.text);return snapshot()},
  'sale.queue':()=>{director.queueSale();return snapshot()},'sale.hide':()=>{director.hideSale();return snapshot()},
  'lottery.queue':()=>{director.queueLottery();return snapshot()},
  'presentation.open':async value=>{if(director.status().running&&!director.status().paused)throw fail(409,'请先暂停 AI 讲解，再更换演示稿');const url=value.url||store.get().presentation.url;validatePresentation(url);await media.openPresentation(url);store.update({presentation:{url}});await director.refreshPresentation?.();return snapshot()},
  'presentation.next':()=>navigate('next'),'presentation.prev':()=>navigate('prev'),'presentation.first':()=>navigate('first'),
  'output.start':async()=>{const c=store.get();await media.startOutput({...c.output,videoBitrate:c.output.videoBitrate+'k',audioBitrate:c.output.audioBitrate+'k',destinations:platforms.destinations()},{prepare:ensurePreview});return snapshot()},
  'output.stop':async()=>{platforms.cancelOutputStarts();await media.stopOutput();return snapshot()},
  'bgm.set':value=>{if(value.asset!==undefined)store.update({bgm:{asset:value.asset}});applyBgm();return snapshot()},
 }
 const relayAudio=buffer=>{for(const socket of monitors){if(socket.readyState!==WebSocket.OPEN)continue;if(socket.bufferedAmount>256*1024){socket.close(1013,'监听延迟过高，请重新连接');continue}socket.send(buffer,{binary:true},()=>{})}}
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://studio.local'),path=url.pathname
   res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Content-Type-Options','nosniff')
   if(closing)throw fail(503,'服务正在关闭')
   if(path==='/health'){return json(res,{ok:true,status:'ok',version:'0.1.0'})}
   if(path==='/api/session'&&req.method==='GET')return json(res,{authenticated:auth.isAuthenticated(req),firstRun:auth.firstRun})
   if(path==='/api/login'&&req.method==='POST'){checkOrigin(req);const data=await jsonBody(req);res.setHeader('Set-Cookie',auth.login(req,data.password));return json(res,{ok:true})}
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
   if(path==='/api/logout'&&req.method==='POST'){res.setHeader('Set-Cookie',auth.logout(req));return json(res,{ok:true})}
   if(path==='/api/state'&&req.method==='GET')return json(res,snapshot())
   if(path==='/api/platforms'&&req.method==='GET')return json(res,platforms.status())
   if(path==='/api/platforms'&&req.method==='POST'){platforms.create(await jsonBody(req));return json(res,{ok:true,...snapshot()},201)}
   const platformPath=/^\/api\/platforms\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(\/frame\.jpg)?$/.exec(path)
   if(platformPath){const id=platformPath[1];if(platformPath[2]&&req.method==='GET'){const frame=platforms.frame(id);if(!frame){res.writeHead(204,{'Cache-Control':'no-store'});return res.end()}res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});return res.end(frame)}if(!platformPath[2]&&req.method==='PUT'){await platforms.update(id,await jsonBody(req));return json(res,{ok:true,...snapshot()})}if(!platformPath[2]&&req.method==='DELETE'){await platforms.remove(id);return json(res,{ok:true,...snapshot()})}}
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
    const data=await jsonBody(req)
    if(data.patch?.platforms!==undefined)throw fail(400,'请通过平台连接入口修改平台设置')
    if(data.patch?.output&&(['preparing','starting','streaming','running','reconnecting'].includes(media.status().output?.state)||media.status().output?.active||media.status().output?.running))throw fail(409,'请先停止推流或录制，再修改输出设置')
    if(data.patch)store.update(data.patch);if(data.secrets)store.setSecrets(data.secrets);director.settingsChanged?.();applyBgm();events.publish('config',visibleConfig());return json(res,snapshot())
   }
   if(path==='/api/action'&&req.method==='POST'){const data=await jsonBody(req),action=Object.hasOwn(actions,data.action)?actions[data.action]:null;if(!action)throw fail(400,'操作不存在');return json(res,{ok:true,...await action(data)})}
   if(path==='/api/assets'&&req.method==='GET')return json(res,assets.list())
   if(path==='/api/upload'&&req.method==='POST'){
    const bytes=await body(req,100*1024*1024),entry=assets.upload(bytes,{filename:String(req.headers['x-filename']||'asset'),type:String(req.headers['x-asset-type']||'')});return json(res,{ok:true,url:entry.url,asset:entry},201)
   }
   if(path==='/api/frame.jpg'&&req.method==='GET'){void ensurePreview().catch(()=>{});const frame=media.getFrame();if(!frame){res.writeHead(204,{'Cache-Control':'no-store'});return res.end()}res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});return res.end(frame)}
   if(path==='/api/slide.jpg'&&req.method==='GET'){const frame=media.getSlideFrame();if(!frame){res.writeHead(204);return res.end()}res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});return res.end(frame)}
   if(path==='/api/comments'&&req.method==='POST'){const data=await jsonBody(req);director.addComments(Array.isArray(data)?data:data.comments||data.items||data.events||[]);return json(res,{ok:true})}
   if(path==='/api/metrics'&&req.method==='POST'){director.ingestMetrics(await jsonBody(req));return json(res,{ok:true})}
   if(path==='/api/ingest-key'&&req.method==='POST')return json(res,{key:store.secret('commentIngestKey')})
   if(path==='/api/transcribe'&&req.method==='POST'){const bytes=await body(req,16*1024*1024),text=await providers.transcribe(bytes,req.headers['content-type']||'audio/webm');return json(res,{text})}
   if(path==='/api/report'&&req.method==='GET'){
    const format=url.searchParams.get('format')||'json';if(!['json','csv','md'].includes(format))throw fail(400,'报告格式无效');const report=director.report(format);if(format==='json')return json(res,report);res.writeHead(200,{'Content-Type':format==='csv'?'text/csv; charset=utf-8':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="broadcast-report.'+format+'"','Cache-Control':'no-store'});return res.end(report)
   }
   throw fail(404,'未找到页面或接口')
  }catch(error){if(res.headersSent)return res.destroy();const message=redact(error);json(res,{ok:false,error:message},error.status||(['ENOENT','ENOTDIR'].includes(error.code)?404:400))}
 })
 const monitorServer=new WebSocketServer({noServer:true,maxPayload:1024})
 server.on('upgrade',(req,socket,head)=>{try{const url=new URL(req.url,'http://studio.local');if(url.pathname!=='/api/monitor'||!auth.isAuthenticated(req)||monitors.size>=8)throw new Error('not authorized');if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw new Error('invalid origin');monitorServer.handleUpgrade(req,socket,head,client=>{monitors.add(client);client.send(JSON.stringify({sampleRate:48000,channels:2,format:'s16le'}));client.on('close',()=>monitors.delete(client));client.on('error',()=>monitors.delete(client))})}catch{socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')}})
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,host,done)})
 const address=server.address(),baseUrl='http://127.0.0.1:'+address.port
 media=mediaFactory?.({dataDir,baseUrl,renderToken,getSettings:()=>store.get(),onAudio:relayAudio,onStatus:payload=>events.publish('media',payload),onMeter:payload=>{meter=payload;director?.audioProgress(payload);events.publish('meter',payload)}})||new MediaEngine({dataDir,baseUrl,renderToken,getSettings:()=>store.get(),onAudio:relayAudio,onStatus:payload=>events.publish('media',payload),onMeter:payload=>{meter=payload;director?.audioProgress(payload);events.publish('meter',payload)}})
 providers=providerFactory?.({store,dataDir})||new Providers({store,dataDir})
 director=directorFactory?.({store,media,providers,events,dataDir})||new LiveDirector({store,media,providers,events,dataDir})
 const channelsOptions={dataDir,onComments:items=>director.addComments(items),onMetrics:value=>director.ingestMetrics(value),onStatus:value=>events.publish('channels',value)}
 channels=channelsFactory?.(channelsOptions)||new ChannelsCollector(channelsOptions)
 platforms=new PlatformManager({store,media,director,events,dataDir,collectorFactory:platformCollectorFactory,prepareOutput:ensurePreview})
 async function close(){if(closing)return;closing=true;for(const client of [...clients]){client.studioCleanup?.();client.end()}for(const socket of monitors)socket.terminate();monitorServer.close();platforms.cancelOutputStarts();await media.stopOutput?.();await platforms.close();await channels.close();await director.close?.();await media.close();await new Promise(done=>server.close(done))}
 return {server,baseUrl,store,auth,assets,events,media,director,providers,channels,platforms,snapshot,ensurePreview,close,dataDir}
}
