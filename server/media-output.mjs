import {spawn} from 'node:child_process'
import {mkdirSync} from 'node:fs'
import {join,basename} from 'node:path'
import {performance} from 'node:perf_hooks'
import {SAMPLE_RATE,CHANNELS} from './audio-mixer.mjs'

export const MAX_DESTINATIONS=8
export const SINK_BUFFER_LIMIT=2*1024*1024
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const abort=()=>new DOMException('输出操作已取消','AbortError')
async function prepareWithSignal(operation,signal){
 signal.throwIfAborted()
 let listener
 const cancelled=new Promise((_,reject)=>{listener=()=>reject(signal.reason||abort());signal.addEventListener('abort',listener,{once:true})})
 try{return await Promise.race([Promise.resolve().then(()=>operation({signal})),cancelled])}finally{signal.removeEventListener('abort',listener)}
}

/** Remove private output URLs, configured keys and render tokens from subprocess errors. */
export function redactMediaError(text,secrets=[]){
 let value=String(text||'')
 for(const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length))value=value.split(String(secret)).join('[redacted]')
 return value.replace(/(?:rtmps?:\/\/)[^\s'"<>]+/gi,'[RTMP destination]').replace(/([?&](?:renderToken|token|key|secret)=)[^&\s]+/gi,'$1[redacted]').slice(-1800)
}
/** Join a private stream key without exposing the resulting destination in status. */
export function joinStreamDestination(rtmpUrl,streamKey=''){
 if(!rtmpUrl)return ''
 if(typeof rtmpUrl!=='string'||typeof streamKey!=='string')throw new Error('推流地址和密钥需要是文本')
 let url;try{url=new URL(rtmpUrl)}catch{throw new Error('请输入有效的 RTMP/RTMPS 推流地址')}
 if(!['rtmp:','rtmps:'].includes(url.protocol)||url.username||url.password)throw new Error('推流仅支持不含登录凭据的 RTMP/RTMPS 地址')
 if(/[|\r\n\0]/.test(streamKey)||/[|\r\n\0]/.test(rtmpUrl))throw new Error('推流密钥无效')
 return streamKey?rtmpUrl.replace(/\/+$/,'')+'/'+streamKey:rtmpUrl
}
/** Resolve explicit destinations; a legacy destination is used only when the array is omitted. */
export function normalizeDestinations(value){
 const items=Object.hasOwn(value,'destinations')?value.destinations:value.rtmpUrl?[{id:'legacy',platform:'custom',name:'默认推流',rtmpUrl:value.rtmpUrl,streamKey:value.streamKey||''}]:[]
 if(!Array.isArray(items)||items.length>MAX_DESTINATIONS)throw new Error('最多同时推流到8个平台')
 const seen=new Set()
 return items.map(item=>{
  if(!item||typeof item!=='object'||!/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)||seen.has(item.id))throw new Error('推流连接需要有效且唯一的ID')
  seen.add(item.id)
  if(typeof item.platform!=='string'||item.platform.length>80||typeof item.name!=='string'||item.name.length>160)throw new Error('推流平台名称无效')
  const destination=joinStreamDestination(item.rtmpUrl,item.streamKey??'');if(!destination)throw new Error('请填写平台的推流地址')
  return {id:item.id,platform:item.platform,name:item.name,destination,streamKey:item.streamKey??''}
 })
}
/** Encode the composed scene once to a self-describing MPEG-TS transport shared by all outputs. */
export function buildEncoderArgs({width,height,fps,videoBitrate,audioBitrate}){
 return ['-hide_banner','-loglevel','warning','-y','-thread_queue_size','128','-probesize','32768','-analyzeduration','0','-f','image2pipe','-framerate',String(fps),'-vcodec','mjpeg','-i','pipe:0','-thread_queue_size','512','-f','s16le','-ar',String(SAMPLE_RATE),'-ac',String(CHANNELS),'-i','pipe:3','-map','0:v:0','-map','1:a:0','-vf',`scale=${width}:${height}:flags=fast_bilinear,format=yuv420p`,'-c:v','libx264','-preset','veryfast','-tune','zerolatency','-b:v',videoBitrate,'-maxrate',videoBitrate,'-bufsize',String(Number.parseInt(videoBitrate)*2)+'k','-g',String(fps*2),'-x264-params','repeat-headers=1','-c:a','aac','-b:a',audioBitrate,'-ar',String(SAMPLE_RATE),'-progress','pipe:4','-stats_period','0.5','-mpegts_flags','+resend_headers+initial_discontinuity','-muxdelay','0','-flush_packets','1','-f','mpegts','pipe:1']
}
/** Remux encoded packets without another video/audio encoder; each output owns its network connection. */
export function buildRemuxArgs({destination,recordPath}){
 const args=['-hide_banner','-loglevel','warning','-y','-fflags','+genpts+discardcorrupt','-probesize','8388608','-analyzeduration','3000000','-f','mpegts','-i','pipe:0','-map','0:v:0','-map','0:a:0','-c','copy','-bsf:a','aac_adtstoasc','-max_interleave_delta','1000000','-flush_packets','1','-progress','pipe:3','-stats_period','0.5']
 if(recordPath)args.push('-movflags','+frag_keyframe+empty_moov','-f','mp4',recordPath)
 else args.push('-rw_timeout','5000000','-flvflags','no_duration_filesize','-f','flv',destination)
 return args
}
function progress(stream,update){
 let pending=''
 stream.on('data',chunk=>{pending=(pending+chunk.toString()).slice(-32768);let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);const split=line.indexOf('=');if(split>0)update(line.slice(0,split),line.slice(split+1))}})
}
function statistics(target,key,value){
 const number=Number(value)
 if(key==='frame'&&Number.isFinite(number)&&number>=0){if(number>target.frames)target.lastProgressAt=performance.now();target.frames=number}
 if(key==='fps'&&Number.isFinite(number))target.fps=number
 if(key==='total_size'&&Number.isFinite(number))target.bytes=number
 if(key==='out_time_us'&&Number.isFinite(number))target.seconds=number/1e6
}
const emptyStats=()=>({frames:0,fps:0,bytes:0,seconds:0,lastProgressAt:performance.now()})
function safeSink(sink){
 return {id:sink.id,platform:sink.platform,name:sink.name,active:Boolean(sink.process&&sink.state==='streaming'),state:sink.state,error:sink.error,startedAt:sink.startedAt,seconds:sink.seconds,bytes:sink.bytes,fps:sink.fps,encodedFrames:sink.frames,reconnects:sink.reconnects}
}

/** Own one encoder and bounded, independently restartable packet-copy outputs. */
export class OutputGraph {
 constructor({ffmpeg,dataDir,getFrame,onStatus=()=>{},onDrop=()=>{},renderToken=''}){
  Object.assign(this,{ffmpeg,dataDir,getFrame,onStatus,onDrop,renderToken})
  this.encoder=null;this.sinks=new Map();this.recording=null;this.wanted=false;this.stopping=false;this.closed=false;this.generation=0;this.preparation=null;this.state='stopped';this.error='';this.options=null;this.retryTimer=null;this.reconnects=0;this.failures=0;this.startedAt=null;this.lastEncoder=emptyStats()
 }
 status(){
  const platforms=[...this.sinks.values()].map(safeSink),record=this.recording?safeSink(this.recording):null,stats=this.encoder||this.lastEncoder
  const requested=platforms.filter(item=>this.sinks.get(item.id).wanted),recordWanted=this.recording?.wanted,all=[...requested,...(recordWanted?[record]:[])],active=all.some(item=>item.active),running=this.wanted||Boolean(this.encoder)||this.stopping
  let state=this.state
  if(this.stopping)state='stopping'
  else if(this.wanted&&this.encoder){
   const failed=all.some(item=>item.state==='error'||item.state==='reconnecting')
   state=active?(failed?'degraded':'streaming'):all.some(item=>item.state==='reconnecting')?'reconnecting':all.length&&all.every(item=>item.state==='error')?'error':'starting'
  }
  const issues=all.filter(item=>item.error).map(item=>item.name+'：'+item.error).join('；')
  return {running,encodingActive:Boolean(this.encoder?.frames>0),active,mode:platforms.length?(this.recording?'both':'rtmp'):this.recording?'record':null,state,error:this.error||issues,startedAt:this.startedAt,seconds:stats.seconds,fps:stats.fps,bytes:stats.bytes,encodedFrames:stats.frames,reconnects:this.reconnects,platforms,recording:Boolean(record?.active),recordingFile:this.recording?basename(this.recording.recordPath):null,recordingStatus:record}
 }
 emit(){this.onStatus(this.status())}
 secrets(){return [this.renderToken,...[...this.sinks.values()].flatMap(sink=>[sink.streamKey,sink.destination])]}
 createSink(value,kind='platform'){
  return {...value,kind,wanted:true,state:'starting',error:'',startedAt:null,reconnects:0,failures:0,timer:null,process:null,attempt:0,...emptyStats()}
 }
 async start({destinations,record,...options},beforeStart=async()=>{}){
  if(this.closed)throw new Error('输出引擎已关闭')
  if(this.status().running)throw new Error('输出已经启动，请先停止后再修改推流设置')
  if(!destinations.length&&!record)throw new Error('请配置推流平台，或启用本地录制')
  this.wanted=true;this.stopping=false;const generation=++this.generation;this.state='preparing';this.error='';this.options=options;this.reconnects=0;this.failures=0;this.lastEncoder=emptyStats();this.startedAt=Date.now()
  this.sinks=new Map(destinations.map(value=>[value.id,this.createSink(value)]));this.recording=null
  if(record){const directory=join(this.dataDir,'recordings');mkdirSync(directory,{recursive:true});this.recording=this.createSink({id:'@record',platform:'recording',name:'本地录制',recordPath:join(directory,new Date().toISOString().replace(/[:.]/g,'-')+'.mp4')},'record')}
  const controller=new AbortController();this.preparation=controller
  this.emit()
  try{await prepareWithSignal(beforeStart,controller.signal);controller.signal.throwIfAborted();if(!this.wanted||generation!==this.generation)throw abort();this.startEncoder(generation)}catch(error){if(generation===this.generation){this.wanted=false;this.state='error';this.error=redactMediaError(error.message,this.secrets());this.emit()}throw error}finally{if(this.preparation===controller)this.preparation=null}
  await sleep(150);return this.status()
 }
 startEncoder(generation){
  if(!this.wanted||this.closed||generation!==this.generation)return
  const child=spawn(this.ffmpeg,buildEncoderArgs(this.options),{stdio:['pipe','pipe','pipe','pipe','pipe'],windowsHide:true})
  const encoder={child,generation,stopping:false,audioBlocked:false,videoBlocked:false,...emptyStats()};this.encoder=encoder;this.state='starting';this.error=''
  let detail=''
  child.stderr.on('data',chunk=>{detail=(detail+chunk.toString()).slice(-6000)})
  child.stdout.on('data',chunk=>this.fanOut(chunk))
  for(const stream of [child.stdin,child.stdio[3]])stream.on('error',()=>{/* Encoder exit closes its input pipes before the owned close event. */})
  child.once('error',()=>{detail='无法启动 FFmpeg 编码进程'})
  progress(child.stdio[4],(key,value)=>{statistics(encoder,key,value);if(encoder.frames>0){this.error='';this.failures=0}if(key==='progress')this.emit()})
  encoder.closed=new Promise(resolve=>child.once('close',(code,signal)=>{
   clearInterval(encoder.timer);clearInterval(encoder.watchdog);this.lastEncoder={...encoder,child:undefined}
   if(this.encoder===encoder)this.encoder=null
   resolve()
   if(!encoder.stopping&&this.wanted&&generation===this.generation){this.error=redactMediaError(detail||'编码进程退出（'+(code??signal)+'）',this.secrets());void this.recoverEncoder(generation)}
   this.emit()
  }))
  encoder.timer=setInterval(()=>{
   if(this.encoder!==encoder||encoder.stopping)return
   const frame=this.getFrame();if(!frame)return
   if(encoder.videoBlocked){this.onDrop();return}
   if(!child.stdin.write(frame)){encoder.videoBlocked=true;child.stdin.once('drain',()=>{if(this.encoder===encoder)encoder.videoBlocked=false})}
  },1000/this.options.fps)
  encoder.watchdog=setInterval(()=>{const now=performance.now();if(!encoder.stopping&&(now-encoder.lastProgressAt>20000||encoder.audioBlocked&&now-encoder.audioBlockedSince>10000)){detail='编码器长时间没有输出进度';child.kill('SIGTERM')}},1000)
  for(const sink of this.allSinks())if(sink.wanted)this.startSink(sink)
  this.emit()
 }
 allSinks(){return [...this.sinks.values(),...(this.recording?[this.recording]:[])]}
 isCurrent(sink){return sink.kind==='record'?this.recording===sink:this.sinks.get(sink.id)===sink}
 startSink(sink){
  if(!this.wanted||!this.encoder||!sink.wanted||!this.isCurrent(sink)||sink.process)return
  clearTimeout(sink.timer);sink.timer=null;sink.attempt++;sink.startedAt=Date.now();sink.state='starting';Object.assign(sink,emptyStats())
  if(sink.kind==='record'&&sink.attempt>1)sink.recordPath=sink.recordPath.replace(/(?:\.retry\d+)?\.mp4$/,'.retry'+(sink.attempt-1)+'.mp4')
  const child=spawn(this.ffmpeg,buildRemuxArgs(sink.kind==='record'?{recordPath:sink.recordPath}:{destination:sink.destination}),{stdio:['pipe','ignore','pipe','pipe'],windowsHide:true})
  const owned={child,stopping:false,generation:this.generation,attempt:sink.attempt,blockedSince:0,reason:''};sink.process=owned;let detail=''
  child.stderr.on('data',chunk=>{detail=(detail+chunk.toString()).slice(-6000)})
  child.stdin.on('error',()=>{/* Independent sender exit is handled by its close event without affecting the encoder. */})
  child.once('error',()=>{detail='无法启动平台发送进程'})
  progress(child.stdio[3],(key,value)=>{
   if(sink.process!==owned||owned.stopping||owned.reason)return
   statistics(sink,key,value)
   if(sink.frames>0){sink.state='streaming';sink.error='';sink.failures=0}
   if(key==='progress')this.emit()
  })
  owned.closed=new Promise(resolve=>child.once('close',(code,signal)=>{
   clearInterval(owned.watchdog);clearTimeout(owned.killTimer)
   if(sink.process===owned){sink.process=null;if(!owned.stopping){sink.error=redactMediaError(owned.reason||detail.split(/\r?\n/).filter(Boolean).slice(-5).join('\n')||'平台发送进程退出（'+(code??signal)+'）',this.secrets());sink.state='error';this.queueSinkRetry(sink)}}
   resolve();this.emit()
  }))
  owned.watchdog=setInterval(()=>{if(owned.stopping||sink.process!==owned)return;const now=performance.now();if(now-sink.lastProgressAt>20000||owned.blockedSince&&now-owned.blockedSince>5000)this.failSink(sink,'平台长时间没有发送进度，正在独立重连')},1000)
  this.emit()
 }
 fanOut(chunk){
  for(const sink of this.allSinks()){
   const owned=sink.process;if(!owned||owned.stopping||owned.reason||!owned.child.stdin.writable)continue
   const input=owned.child.stdin
   if(input.writableLength+chunk.length>SINK_BUFFER_LIMIT){this.failSink(sink,'平台发送过慢，已独立重连以保护其他平台');continue}
   if(!input.write(chunk)&&!owned.blockedSince){owned.blockedSince=performance.now();input.once('drain',()=>{owned.blockedSince=0})}
  }
 }
 failSink(sink,reason){
  const owned=sink.process;if(!owned||owned.stopping||owned.reason)return
  owned.reason=reason;sink.error=reason;sink.state='reconnecting';owned.child.kill('SIGTERM');owned.killTimer=setTimeout(()=>owned.child.kill('SIGKILL'),3000);owned.killTimer.unref?.();this.emit()
 }
 queueSinkRetry(sink){
  if(!this.wanted||this.closed||!sink.wanted||!this.isCurrent(sink)||sink.timer)return false
  if(sink.failures>=3){sink.state='error';return false}
  const delay=1000*2**sink.failures++;sink.reconnects++;sink.state='reconnecting';const generation=this.generation
  sink.timer=setTimeout(()=>{sink.timer=null;if(generation===this.generation)this.startSink(sink)},delay);sink.timer.unref?.();this.emit();return true
 }
 async recoverEncoder(generation){
  this.state='reconnecting';await Promise.all(this.allSinks().map(sink=>this.stopSink(sink,'reconnecting')))
  if(!this.wanted||this.closed||generation!==this.generation)return
  if(this.failures>=3){this.wanted=false;this.state='error';this.emit();return}
  const delay=1000*2**this.failures++;this.reconnects++;this.retryTimer=setTimeout(()=>{this.retryTimer=null;this.startEncoder(generation)},delay);this.retryTimer.unref?.();this.emit()
 }
 writePcm(buffer){
  const out=this.encoder;if(!out||out.stopping||!out.child.stdio[3].writable)return
  if(!out.child.stdio[3].write(buffer)){out.audioBlocked=true;out.audioBlockedSince=performance.now();out.child.stdio[3].once('drain',()=>{if(this.encoder===out)out.audioBlocked=false})}
 }
 async addDestination(value){
  if(!this.wanted)throw new Error('请先开始输出，再添加平台')
  const [destination]=normalizeDestinations({destinations:[value]}),existing=this.sinks.get(value.id)
  if(existing?.wanted&&existing.process&&!existing.process.stopping)throw new Error('该平台已经开始输出')
  if(!existing?.wanted&&[...this.sinks.values()].filter(item=>item.wanted).length>=MAX_DESTINATIONS)throw new Error('最多同时推流到8个平台')
  if(!existing&&this.sinks.size>=MAX_DESTINATIONS){const oldest=[...this.sinks.values()].find(item=>!item.wanted&&!item.process);if(oldest)this.sinks.delete(oldest.id)}
  const sink=this.createSink(destination);this.sinks.set(sink.id,sink)
  if(existing)await this.stopSink(existing)
  if(!this.isCurrent(sink)||!this.wanted)throw abort()
  this.startSink(sink);return this.status()
 }
 async stopDestination(id){
  const sink=this.sinks.get(id);if(!sink)throw new Error('没有找到正在输出的平台')
  sink.wanted=false;await this.stopSink(sink)
  if(![...this.sinks.values()].some(item=>item.wanted)&&!this.recording?.wanted)await this.stop()
  this.emit();return this.status()
 }
 async retryDestination(id){
  const sink=this.sinks.get(id);if(!sink)throw new Error('没有找到需要重试的平台')
  if(!this.wanted)throw new Error('请先开始输出，再重试平台')
  if(sink.state==='streaming')return this.status()
  sink.wanted=true;sink.failures=0;await this.stopSink(sink,'reconnecting');this.startSink(sink);return this.status()
 }
 async stopSink(sink,nextState='stopped'){
  clearTimeout(sink.timer);sink.timer=null;const owned=sink.process
  if(!owned){sink.state=nextState;return}
  owned.stopping=true;sink.state='stopping';clearInterval(owned.watchdog);clearTimeout(owned.killTimer);owned.child.stdin.end()
  const terminate=setTimeout(()=>owned.child.kill('SIGTERM'),1000),kill=setTimeout(()=>owned.child.kill('SIGKILL'),3000)
  await owned.closed;clearTimeout(terminate);clearTimeout(kill)
  if(!sink.process)sink.state=nextState
 }
 async stop(){
  this.wanted=false;this.stopping=true;this.generation++;this.preparation?.abort(abort());this.preparation=null;clearTimeout(this.retryTimer);this.retryTimer=null
  for(const sink of this.allSinks()){sink.wanted=false;clearTimeout(sink.timer);sink.timer=null}
  const encoder=this.encoder;this.emit()
  if(encoder){encoder.stopping=true;clearInterval(encoder.timer);clearInterval(encoder.watchdog);encoder.child.stdin.end();encoder.child.stdio[3].end();const kill=setTimeout(()=>encoder.child.kill('SIGKILL'),5000);await encoder.closed;clearTimeout(kill)}
  await Promise.all(this.allSinks().map(sink=>this.stopSink(sink)))
  this.stopping=false;this.state='stopped';this.emit();return this.status()
 }
 async close(){if(this.closed)return;this.closed=true;await this.stop()}
}
