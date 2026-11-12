/** Direct model, speech and recognition clients; no harness or browser playback dependency. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import {MODEL_TIMEOUT_MS,SPEECH_TIMEOUT_MS,speechKeys,TENCENT_VOICES,voiceName,LIVE_SPEECH_CHARACTERS,LIVE_SPEECH_FIRST_CHARACTERS} from '../public/provider-config.mjs'
import {SECRET_NAMES} from './store.mjs'

const require = createRequire(import.meta.url)
const endpoint = (base, suffix) => {
  const url = new URL(String(base || '').replace(/\/$/, '') + suffix)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('服务地址必须是 HTTP/HTTPS 地址')
  return url.href
}
const combinedSignal = (signal, timeout) => AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])])
const checkAbort = signal => { if (signal?.aborted) throw signal.reason || new Error('操作已取消') }
export const hasSpeechContent = text => /[\p{L}\p{N}]/u.test(String(text ?? ''))
const rejectedSpeechText = error => /^(?:InvalidParameter(?:Value)?\.InvalidText|InvalidParameterValue\.TextEmpty|InvalidParameterValue\.ParticipleError)$/.test(error?.code || '') || /^Please check your text\b/i.test(error?.message || '')
const speechTimedOut = error => /^服务超过 [\d.]+ 秒未完成$/.test(error?.message || '') || /^(?:ETIMEDOUT|RequestTimeout)$/.test(error?.code || '')

/** Split at punctuation while preserving all spoken text within Tencent's byte/character limits. */
export function splitSpeech(text, maxCharacters = 150, maxBytes = 450, firstCharacters = maxCharacters) {
  const chars = Array.from(String(text)), parts = []
  let start = 0
  while (start < chars.length) {
    let end = start, bytes = 0, sentence = 0, clause = 0
    while (end < chars.length && end - start < (start === 0 ? firstCharacters : maxCharacters)) {
      const char = chars[end], size = Buffer.byteLength(char)
      if (bytes + size > maxBytes) break
      bytes += size; end++
      if (/[。！？!?；;\n]/u.test(char)) sentence = end
      else if (/[，,：:\s]/u.test(char)) clause = end
    }
    const cut = end === chars.length ? end : sentence || clause || end
    if (cut <= start) throw new Error('语音字符超出单段限制')
    const part = chars.slice(start, cut).join('')
    if (part.trim()) parts.push(part)
    start = cut
  }
  return parts
}

/** A short leading clause reduces time to first audio; subsequent chunks retain natural punctuation. */
export const splitLiveSpeech = text => splitSpeech(text,LIVE_SPEECH_CHARACTERS,LIVE_SPEECH_CHARACTERS*3,LIVE_SPEECH_FIRST_CHARACTERS)

/** Build a PCM WAV container for Tencent's raw signed 16-bit audio. */
export function pcmWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Bound HTTP payloads and surface only non-secret provider errors. */
async function readBounded(response, limit = 24 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('服务响应过大')
  const chunks = []; let size = 0
  for await (const chunk of response.body || []) {
    size += chunk.length
    if (size > limit) throw new Error('服务响应过大')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** A deadline covers connection, body download and validation, including non-cooperative SDK calls. */
async function deadline(operation,milliseconds,signal){
 checkAbort(signal)
 const controller=new AbortController(),timeout=Math.min(120000,Math.max(1,Number(milliseconds)||10000))
 let timer,abort
 const cancelled=new Promise((_,reject)=>{
  const stop=reason=>{controller.abort(reason);reject(reason)}
  abort=()=>stop(signal.reason||new DOMException('操作已取消','AbortError'))
  signal?.addEventListener('abort',abort,{once:true})
  timer=setTimeout(()=>stop(new Error('服务超过 '+timeout/1000+' 秒未完成')),timeout)
 })
 try{return await Promise.race([Promise.resolve().then(()=>operation(controller.signal)),cancelled])}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
}

export class Providers {
 constructor({store,dataDir,fetchImpl=fetch,tencentFactory,now=Date.now}){
  Object.assign(this,{store,fetch:fetchImpl,tencentFactory,now});this.dataDir=resolve(dataDir);this.audioDir=join(this.dataDir,'audio')
  this.cooldowns=new Map();this.speechCooldowns=new Map();this.preferred=0;this.speechPreferred=0;this.signatures={};this.health={model:new Map(),speech:new Map()}
  this.modelState={route:0,label:'',fallback:false,error:'',changedAt:0};this.speechState={route:0,label:'',fallback:false,error:'',changedAt:0}
  this.audioVoices=new Map();this.speechTasks=[];this.speechActive=0;this.speechConcurrency=2
 }
 routes(kind){
  const c=this.store.get()
  if(kind==='model')return [{...c.llm,keyName:'llmKey',label:c.llm?.model||'主模型'},...(c.llm?.fallbacks||[])].slice(0,5)
  return [{...c.tts,slot:0,label:'主语音'},...(c.tts?.fallbacks||[])].slice(0,5).map((route,index)=>{
   const inheritedVoice=Boolean(index&&route.provider==='tencent'&&c.tts?.provider==='tencent'&&route.followPrimaryVoice!==false)
   return {...route,...(inheritedVoice?{voice:c.tts.voice,speed:c.tts.speed}:{}),inheritedVoice,credentialNames:speechKeys(index&&route.provider==='tencent'&&c.tts?.provider==='tencent'&&route.usePrimaryCredentials?0:route.slot||0)}
  })
 }
 rememberAudio(path,index,route,cached){
  this.audioVoices.set(path,{source:'synthesis',provider:route.provider,voice:route.voice,voiceName:voiceName(route.voice,route.provider),speed:Number(route.speed)||1,route:index,fallback:index>0,reason:index>0?(this.health.speech.get(0)?.error||'使用备用语音通道'):'',cached})
  if(this.audioVoices.size>600)this.audioVoices.delete(this.audioVoices.keys().next().value)
 }
 speechInfo(path){const info=this.audioVoices.get(path);return info?{...info}:null}
 credentials(kind,route){
  if(kind==='model')return [this.store.secret(route.keyName||'llmKey')]
  const names=route.credentialNames||speechKeys(0)
  return route.provider==='tencent'?[this.store.secret(names.secretId),this.store.secret(names.secretKey)]:[this.store.secret(names.apiKey)]
 }
 ready(kind,route){return kind==='model'?Boolean(route.baseUrl&&route.model&&this.credentials(kind,route)[0]):route.provider==='demo'?Boolean(route.demoAsset):Boolean(['tencent','openai'].includes(route.provider)&&(route.provider==='tencent'||route.baseUrl)&&this.credentials(kind,route).every(Boolean))}
 redact(value){
  let text=this.store.redact?.(String(value?.message||value||''))||String(value?.message||value||'')
  for(const name of [...SECRET_NAMES,...(this.store.get().llm?.fallbacks||[]).map(route=>route.keyName)]){const secret=name&&this.store.secret(name);if(secret)text=text.split(String(secret)).join('[redacted]')}
  return text.replace(/(?:sk-|AKID)[A-Za-z0-9_-]{8,}/g,'[redacted]').slice(0,350)
 }
 sync(kind,routes){
  const signature=createHash('sha256').update(JSON.stringify(routes.map(route=>({...route,credentials:this.credentials(kind,route)})))).digest('hex')
  if(this.signatures[kind]!==signature){this.signatures[kind]=signature;(kind==='model'?this.cooldowns:this.speechCooldowns).clear();this.health[kind].clear();if(kind==='model'){this.preferred=0;this.modelState={route:0,label:'',fallback:false,error:'',changedAt:0}}else{this.speechPreferred=0;this.speechState={route:0,label:'',fallback:false,error:'',changedAt:0}}}
 }
 order(kind,routes,index){
  this.sync(kind,routes)
  if(index!==undefined){if(!Number.isInteger(index)||index<0||index>=routes.length)throw new Error('通道不存在');return [index]}
  const cooldowns=kind==='model'?this.cooldowns:this.speechCooldowns,preferred=kind==='model'?this.preferred:this.speechPreferred
  return [...new Set([...(this.now()>=(cooldowns.get(0)||0)?[0]:[preferred]),...routes.map((_,i)=>i)])].filter(i=>this.now()>=(cooldowns.get(i)||0))
 }
 success(kind,index,route,elapsed,cached=false){
  const state={route:index,label:route.label||route.model||voiceName(route.voice,route.provider)||'主通道',provider:route.provider,voice:route.voice,voiceName:voiceName(route.voice,route.provider),model:route.model,fallback:index>0,error:'',changedAt:this.now(),elapsedMs:Math.round(elapsed),cached}
  if(kind==='model'){this.preferred=index;this.modelState=state}else{this.speechPreferred=index;this.speechState=state}
  if(!cached)(kind==='model'?this.cooldowns:this.speechCooldowns).delete(index)
  this.health[kind].set(index,{error:'',elapsedMs:state.elapsedMs,lastSuccessAt:this.now()})
 }
 failed(kind,index,error){
  const message=this.redact(error),retryable=kind==='speech'&&speechTimedOut(error),cooldown=retryable?5000:60000
  const cooldowns=kind==='model'?this.cooldowns:this.speechCooldowns
  cooldowns.set(index,this.now()+cooldown)
  this.health[kind].set(index,{error:message,failedAt:this.now(),retryable});(kind==='model'?this.modelState:this.speechState).error=message;return message
 }
 status(){
  const c=this.store.get(),models=this.routes('model'),speech=this.routes('speech');this.sync('model',models);this.sync('speech',speech)
  const list=(kind,routes)=>routes.map((r,i)=>({route:i,label:r.label||r.model||voiceName(r.voice,r.provider)||'主通道',model:r.model,provider:r.provider,voice:r.voice,voiceName:voiceName(r.voice,r.provider),configured:this.ready(kind,r),cooldownUntil:(kind==='model'?this.cooldowns:this.speechCooldowns).get(i)||0,...this.health[kind].get(i)}))
  return {...this.modelState,modelConfigured:models.some(r=>this.ready('model',r)),speechConfigured:speech.some(r=>this.ready('speech',r)),recognitionConfigured:Boolean(c.asr?.baseUrl),demo:c.tts?.provider==='demo',speech:this.speechState,modelRoutes:list('model',models),speechRoutes:list('speech',speech),modelTimeoutMs:c.llm?.timeoutMs||MODEL_TIMEOUT_MS,speechTimeoutMs:c.tts?.timeoutMs||SPEECH_TIMEOUT_MS,speechQueue:{active:this.speechActive,pending:this.speechTasks.length,limit:this.speechConcurrency}}
 }
 async generate(messages,{signal,json=true,validate,routeIndex,maxTokens}={}){
  if(!Array.isArray(messages)||!messages.length)throw new Error('模型消息不能为空')
  if(Buffer.byteLength(JSON.stringify(messages))>120000)throw new Error('本轮模型上下文超出120KB限制')
  const cfg=this.store.get().llm||{},routes=this.routes('model'),order=this.order('model',routes,routeIndex)
  let failure='请配置模型地址、模型名称和 API Key',attempted=false,outputRejected=false
  for(const index of order){
   checkAbort(signal);const route=routes[index];if(!this.ready('model',route))continue
   attempted=true;const started=performance.now()
   try{
    const text=await deadline(async attemptSignal=>{
     const thinking=route.thinking||cfg.thinking||'default'
     const response=await this.fetch(endpoint(route.baseUrl,'/chat/completions'),{method:'POST',signal:attemptSignal,headers:{Authorization:'Bearer '+this.credentials('model',route)[0],'Content-Type':'application/json'},body:JSON.stringify({model:route.model,messages,stream:false,max_tokens:maxTokens||cfg.maxTokens||1600,...(json?{response_format:{type:'json_object'}}:{}),...(thinking!=='default'?{thinking:{type:thinking}}:{})})})
     const raw=await readBounded(response,2*1024*1024)
     if(!response.ok){let detail='';try{detail=JSON.parse(raw).error?.message||''}catch{}throw new Error('模型服务 HTTP '+response.status+(detail?': '+detail.slice(0,200):''))}
     let value;try{value=JSON.parse(raw)}catch{throw new Error('模型返回了无效 JSON 响应')}
     const content=value.choices?.[0]?.message?.content
     if(typeof content!=='string'||!content.trim())throw new Error('模型没有返回文本内容')
     return content.trim()
    },route.timeoutMs||cfg.timeoutMs||MODEL_TIMEOUT_MS,signal)
    checkAbort(signal)
    try {
     if(json){try{JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g,''))}catch{throw new Error('模型口播不是有效 JSON')}}
     validate?.(text)
    } catch(error) {
     // Reject this reply without cooling down a route that returned successfully.
     checkAbort(signal);failure=this.redact(error);outputRejected=true;continue
    }
    this.success('model',index,route,performance.now()-started);return text
   }catch(error){checkAbort(signal);failure=this.failed('model',index,error)}
  }
  if(!attempted&&order.length===0)failure='模型通道正在冷却，稍后重试'
  const error=new Error(attempted?'所有模型通道均未完成：'+failure:failure)
  if(outputRejected)error.code='MODEL_OUTPUT_REJECTED'
  throw error
 }
 /** One shared limit across live chunks, speculative paragraphs and fallback routes. */
 speechAttempt(operation,{signal,priority=0}={}){
  checkAbort(signal)
  return new Promise((resolve,reject)=>{
   const task={operation,signal,priority,resolve,reject,abort:null}
   task.abort=()=>{const index=this.speechTasks.indexOf(task);if(index>=0)this.speechTasks.splice(index,1);reject(signal.reason||new DOMException('语音请求已取消','AbortError'))}
   signal?.addEventListener('abort',task.abort,{once:true});this.speechTasks.push(task);this.drainSpeech()
  })
 }
 drainSpeech(){
  const rank=task=>Number(typeof task.priority==='function'?task.priority():task.priority)||0
  while(this.speechActive<this.speechConcurrency&&this.speechTasks.length){
   let index=0;for(let n=1;n<this.speechTasks.length;n++)if(rank(this.speechTasks[n])<rank(this.speechTasks[index]))index=n
   const task=this.speechTasks.splice(index,1)[0];task.signal?.removeEventListener('abort',task.abort)
   if(task.signal?.aborted){task.reject(task.signal.reason);continue}
   this.speechActive++;Promise.resolve().then(()=>{checkAbort(task.signal);return task.operation()}).then(task.resolve,task.reject).finally(()=>{this.speechActive--;this.drainSpeech()})
  }
 }
 async synthesize(text,{signal,routeIndex,cache=true,priority=0,skipOnTimeout=false}={}){
  checkAbort(signal)
  if(typeof text!=='string'||!text.trim()||text.length>4000)throw new Error('播报文本应为1–4000字')
  const cfg=this.store.get().tts||{}
  if(cfg.provider==='demo'){
   if(!cfg.demoAsset||text.trim()!==String(cfg.demoText||'').trim())throw new Error('演示模式只提供标注的固定试听录音；请配置语音服务后播报自定义文本')
   const path=isAbsolute(cfg.demoAsset)?cfg.demoAsset:resolve(this.dataDir,cfg.demoAsset);await stat(path);return path
  }
  if(!hasSpeechContent(text))throw Object.assign(new Error('本段没有可朗读的文字'),{code:'SPEECH_TEXT_REJECTED'})
  const routes=this.routes('speech'),order=this.order('speech',routes,routeIndex);let failure='请配置语音通道和凭据',attempted=false,textRejected=false
  await mkdir(this.audioDir,{recursive:true,mode:0o700})
  for(const index of order){
   checkAbort(signal);const route=routes[index];if(!this.ready('speech',route))continue;attempted=true
   const started=performance.now(),key=createHash('sha256').update(JSON.stringify({text,provider:route.provider,voice:route.voice,speed:route.speed,model:route.model,baseUrl:route.baseUrl,region:route.region})).digest('hex'),output=join(this.audioDir,key+(route.provider==='tencent'?'.wav':'.mp3'))
   if(cache){try{if((await stat(output)).size>44){this.success('speech',index,route,performance.now()-started,true);this.rememberAudio(output,index,route,true);return output}}catch(error){if(error.code!=='ENOENT')throw error}}
   try{
    const timeout=route.timeoutMs||cfg.timeoutMs||SPEECH_TIMEOUT_MS
    const audio=await this.speechAttempt(()=>deadline(async attemptSignal=>{
     let bytes
     if(route.provider==='tencent')bytes=await this.tencentSpeech(text,route,attemptSignal,timeout)
     else{
      const response=await this.fetch(endpoint(route.baseUrl,'/audio/speech'),{method:'POST',signal:attemptSignal,headers:{Authorization:'Bearer '+this.credentials('speech',route)[0],'Content-Type':'application/json'},body:JSON.stringify({model:route.model||'tts-1',voice:route.voice||'alloy',input:text,speed:Number(route.speed)||1,response_format:'mp3'})})
      if(!response.ok)throw new Error('语音服务 HTTP '+response.status)
      if(/(?:json|text\/)/i.test(response.headers.get('content-type')||''))throw new Error('语音服务返回了非音频响应')
      bytes=await readBounded(response)
     }
     checkAbort(attemptSignal);if(!bytes||bytes.length<=44)throw new Error('语音服务没有返回有效音频');return bytes
    },timeout,signal),{signal,priority})
    checkAbort(signal);const temporary=output+'.'+randomUUID()+'.tmp';await writeFile(temporary,audio,{mode:0o600});await rename(temporary,output);await this.pruneAudio(output)
    this.success('speech',index,route,performance.now()-started);this.rememberAudio(output,index,route,false);return output
   }catch(error){
    checkAbort(signal)
    // Changing channels cannot repair a text error, and the route is still healthy.
    if(rejectedSpeechText(error)){failure=this.redact(error);textRejected=true;continue}
    failure=this.failed('speech',index,error)
    if(skipOnTimeout&&speechTimedOut(error))throw Object.assign(new Error(failure),{code:'SPEECH_TIMEOUT'})
   }
  }
  if(!attempted&&order.length===0)failure='语音通道正在冷却，稍后重试'
  const error=new Error(attempted?'所有语音通道均未完成：'+failure:failure)
  if(textRejected)error.code='SPEECH_TEXT_REJECTED'
  else if(skipOnTimeout&&!attempted&&routes.some((route,index)=>this.ready('speech',route)&&this.health.speech.get(index)?.retryable&&(this.speechCooldowns.get(index)||0)>this.now()))error.code='SPEECH_TIMEOUT'
  throw error
 }
 async tencentSpeech(text,cfg,signal,timeout=5000){
  const [secretId,secretKey]=this.credentials('speech',cfg)
  if(!secretId||!secretKey)throw new Error('请配置腾讯云 SecretId 和 SecretKey')
  const voice=Number(cfg.voice)||602003,rate=Number(cfg.speed)||1,sampleRate=TENCENT_VOICES.find(v=>v.id===String(voice))?.sampleRate||24000
  if(rate<.6||rate>2.5)throw new Error('语速应为0.6–2.5倍')
  const speed=Math.round((rate<1.2?(rate-1)*5:rate<1.5?1+(rate-1.2)/.3:2+(rate-1.5)*4)*100)/100
  const options={credential:{secretId,secretKey},region:cfg.region||'ap-guangzhou',profile:{httpProfile:{endpoint:'tts.tencentcloudapi.com',reqTimeout:Math.max(1,Math.ceil(timeout/1000))}}}
  const client=this.tencentFactory?this.tencentFactory(options):new (require('tencentcloud-sdk-nodejs-tts').tts.v20190823.Client)(options),parts=[]
  const speak=part=>{
   checkAbort(signal)
   return new Promise((resolvePromise,reject)=>{
    const abort=()=>reject(signal?.reason||new Error('语音合成已取消'));signal?.addEventListener('abort',abort,{once:true})
    Promise.resolve().then(()=>client.TextToVoice({Text:part,SessionId:randomUUID(),VoiceType:voice,SampleRate:sampleRate,Codec:'pcm',Speed:speed,Volume:0,ModelType:1})).then(resolvePromise,reject).finally(()=>signal?.removeEventListener('abort',abort))
   })
  }
  for(const part of splitSpeech(text).filter(hasSpeechContent)){
   let result
   try{result=await speak(part)}catch(error){
    checkAbort(signal)
    if(!rejectedSpeechText(error))throw error
    const cleaned=part.replace(/[\p{Extended_Pictographic}\p{Variation_Selector}\p{C}]/gu,' ').replace(/\s+/gu,' ').trim()
    if(cleaned===part.trim()||!hasSpeechContent(cleaned))throw error
    result=await speak(cleaned)
   }
   checkAbort(signal);if(typeof result.Audio!=='string'||!result.Audio)throw new Error('腾讯云未返回合成音频');parts.push(Buffer.from(result.Audio,'base64'))
  }
  return pcmWav(Buffer.concat(parts),sampleRate)
 }
 async test(kind,index=0){
  const started=performance.now()
  if(kind==='model'){const text=await this.generate([{role:'system',content:'请简短回答。'},{role:'user',content:'只回复：连接成功。'}],{json:false,routeIndex:index,maxTokens:40});return {kind,route:index,elapsedMs:Math.round(performance.now()-started),text:text.slice(0,240)}}
  if(kind==='speech'){if(this.store.get().tts.provider==='demo')throw new Error('请先选择真实语音服务，再测试在线音色');const path=await this.synthesize('你好，我是小云。这是当前音色的试听。',{routeIndex:index,cache:false});return {kind,route:index,elapsedMs:Math.round(performance.now()-started),path}}
  throw new Error('测试类型无效')
 }

 /** Audition a draft voice with saved credentials, without changing settings or live route health. */
 async previewSpeech({slot=0,voice,text='你好，我是小云，欢迎来到直播间。今天我们一起聊聊有趣的新发现。',speed,provider}={}){
  const config=this.store.get(),selected=this.routes('speech').find(route=>route.slot===slot)
  if(!selected)throw new Error('请先保存这个备用语音通道的服务配置，再试听音色')
  if(selected.provider==='demo')throw new Error('请先在外部连接中配置真实语音服务，再试听在线音色')
  if(provider&&provider!==selected.provider)throw new Error('语音供应商有未保存的修改，请先保存服务配置')
  if(typeof voice!=='string'||!voice.trim()||voice.length>120||(selected.provider==='tencent'&&!/^\d{1,10}$/.test(voice)))throw new Error('请选择有效音色')
  if(typeof text!=='string'||!text.trim()||Array.from(text).length>150||Buffer.byteLength(text)>450)throw new Error('试听文案应为 1–150 字，最多 450 字节')
  const rate=speed??selected.speed??1
  if(!Number.isFinite(rate)||rate<.6||rate>2)throw new Error('试听语速应为 0.6–2 倍')
  const names=selected.credentialNames,keys={ttsKey:names.apiKey,tencentSecretId:names.secretId,tencentSecretKey:names.secretKey}
  const store={get:()=>({...config,tts:{...selected,timeoutMs:config.tts.timeoutMs,voice:voice.trim(),speed:rate,fallbacks:[]}}),secret:name=>this.store.secret(keys[name]||name),redact:value=>this.redact(value)}
  const preview=new Providers({store,dataDir:this.dataDir,fetchImpl:this.fetch,tencentFactory:this.tencentFactory,now:this.now}),started=performance.now()
  const path=await preview.synthesize(text.trim(),{routeIndex:0})
  return {slot,voice:voice.trim(),voiceName:voiceName(voice.trim(),selected.provider),elapsedMs:Math.round(performance.now()-started),cached:preview.speechState.cached,path}
 }

  async transcribe(buffer, mime = 'audio/webm', { signal } = {}) {
    const cfg = this.store.get().asr || {}
    if (!cfg.baseUrl) throw new Error('请先配置语音识别服务地址')
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error('录音为空或超过20MB')
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mime }), mime.includes('wav') ? 'speech.wav' : 'speech.webm')
    form.append('model', cfg.model || 'sensevoice')
    const response = await this.fetch(endpoint(cfg.baseUrl, '/audio/transcriptions'), { method: 'POST', body: form, signal: combinedSignal(signal, 45000) })
    if (!response.ok) throw new Error('语音识别 HTTP ' + response.status)
    const value = JSON.parse(await readBounded(response, 1024 * 1024))
    const text = value.text || value.result?.text
    if (typeof text !== 'string') throw new Error('识别服务没有返回文字')
    return text.trim().slice(0, 4000)
  }

  async pruneAudio(current) {
    const entries = await readdir(this.audioDir)
    if (entries.length <= 300) return
    const rows = (await Promise.all(entries.filter(name => /^[a-f0-9]{64}\.(mp3|wav)$/.test(name)).map(async name => { const path = join(this.audioDir, name); try{return {path,at:(await stat(path)).mtimeMs}}catch(error){if(error.code==='ENOENT')return null;throw error} }))).filter(Boolean)
    for (const row of rows.sort((a, b) => b.at - a.at).slice(250)) if (row.path !== current) await unlink(row.path).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
