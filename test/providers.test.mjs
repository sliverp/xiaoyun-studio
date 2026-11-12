import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Providers, splitSpeech, splitLiveSpeech, pcmWav } from '../server/providers.mjs'
import {TENCENT_VOICES,voiceName,voiceLabel} from '../public/provider-config.mjs'

const fakeStore = (config, secrets = {}) => ({ get: () => config, secret: key => secrets[key] || '' })
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'studio-provider-')); t.after(() => rm(path, { recursive: true, force: true })); return path }

test('model failures use the configured fallback and redact provider credentials', async t => {
  const dataDir = await directory(t), calls = [], secret = 'private-primary-key'
  const store = fakeStore({ llm: { baseUrl: 'https://primary.test/v1', model: 'primary', fallbacks: [{ baseUrl: 'https://backup.test/v1', model: 'backup', keyName: 'backupKey' }] } }, { llmKey: secret, backupKey: 'private-backup-key' })
  const providers = new Providers({ store, dataDir, fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return url.includes('primary') ? Response.json({ error: { message: 'failed: ' + secret } }, { status: 503 }) : Response.json({ choices: [{ message: { content: '{"speech":"备用通道回复。"}' } }] })
  } })
  assert.match(await providers.generate([{ role: 'user', content: '你好' }]), /备用通道/)
  assert.equal(calls.length, 2); assert.match(calls[1].url, /backup.test\/v1\/chat\/completions/)
  assert.equal(providers.status().fallback, true); assert.doesNotMatch(JSON.stringify(providers.status()), /private-/)
  assert.equal(providers.redact('failed: ' + secret), 'failed: [redacted]')
})

test('missing credentials and caller cancellation do not submit a model request', async t => {
  const providers = new Providers({ store: fakeStore({ llm: {} }), dataDir: await directory(t), fetchImpl() { assert.fail('no request expected') } })
  await assert.rejects(providers.generate([{ role: 'user', content: 'hello' }]), /请配置模型/)
  const controller = new AbortController(); controller.abort(new Error('caller stopped'))
  await assert.rejects(providers.generate([{ role: 'user', content: 'hello' }], { signal: controller.signal }), /caller stopped/)
})

test('speech chunks preserve every character and fit both provider limits', () => {
  const text = ('完整的一句话，不可以读一半去回应弹幕。🙂').repeat(40), parts = splitSpeech(text)
  assert.equal(parts.join(''), text)
  assert.ok(parts.every(part => Array.from(part).length <= 150 && Buffer.byteLength(part) <= 450))
  const wav = pcmWav(Buffer.alloc(48000)); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt32LE(40), 48000)
})

test('compatible speech caches real audio privately and preserves the selected voice', async t => {
  const dataDir = await directory(t); let calls = 0
  const providers = new Providers({ dataDir, store: fakeStore({ tts: { provider: 'openai', baseUrl: 'https://speech.test/v1', voice: 'clear', speed: .95 } }, { ttsKey: 'speech-key' }), fetchImpl: async (url, options) => {
    calls++; assert.match(url, /audio\/speech$/); const request = JSON.parse(options.body); assert.equal(request.voice, 'clear'); assert.equal(request.speed, .95)
    return new Response(Buffer.alloc(100, 8), { headers: { 'Content-Type': 'audio/mpeg' } })
  } })
  const first = await providers.synthesize('完整的一段口播。'), second = await providers.synthesize('完整的一段口播。')
  assert.equal(first, second); assert.equal(calls, 1); assert.equal((await readFile(first)).length, 100); assert.equal((await stat(first)).mode & 0o777, 0o600)
})

test('demo audio can never be presented as newly synthesized arbitrary text', async t => {
  const dataDir = await directory(t), file = join(dataDir, 'demo.wav'); await writeFile(file, pcmWav(Buffer.alloc(100)))
  const providers = new Providers({ store: fakeStore({ tts: { provider: 'demo', demoAsset: file, demoText: '固定试听。' } }), dataDir })
  assert.equal(await providers.synthesize('固定试听。'), file)
  await assert.rejects(providers.synthesize('现场随便编造的一段内容。'), /只提供标注的固定试听录音/)
})

test('recognition uses the configured backend and returns only actual recognized text', async t => {
  const providers = new Providers({ dataDir: await directory(t), store: fakeStore({ asr: { baseUrl: 'https://asr.test/v1' } }), fetchImpl: async (url, options) => {
    assert.match(url, /audio\/transcriptions$/); assert.ok(options.body instanceof FormData)
    return Response.json({ text: '识别结果。' })
  } })
  assert.equal(await providers.transcribe(Buffer.from([1, 2, 3]), 'audio/webm'), '识别结果。')
})

const modelReply=text=>Response.json({choices:[{message:{content:JSON.stringify({speech:text,navigation:'stay'})}}]})
const twoModels=()=>({llm:{baseUrl:'https://primary.test/v1',model:'first',timeoutMs:25,thinking:'disabled',fallbacks:[{baseUrl:'https://backup.test/v1',model:'second',keyName:'fallbackKey1',thinking:'default'}]}})
const twoVoices=()=>({tts:{provider:'tencent',voice:'602003',speed:1,timeoutMs:25,fallbacks:[{slot:1,provider:'tencent',voice:'501001',speed:1,usePrimaryCredentials:true,followPrimaryVoice:false}]}})
const keys={llmKey:'fixture-primary-model',fallbackKey1:'fixture-backup-model',tencentSecretId:'fixture-tencent-id',tencentSecretKey:'fixture-tencent-secret'}

test('Tencent text rejections leave healthy speech routes available and retry cleaned text once', async t => {
 const config=twoVoices(),calls=[]
 config.tts.timeoutMs=500
 const providers=new Providers({store:fakeStore(config,keys),dataDir:await directory(t),tencentFactory:()=>({TextToVoice:async request=>{
  calls.push(request.Text)
  if(request.Text.includes('拒绝')||request.Text.includes('🚀'))throw Object.assign(new Error('Please check your text'),{code:'InvalidParameterValue.InvalidText'})
  return {Audio:Buffer.alloc(4800,2).toString('base64')}
 }})})
 await assert.rejects(providers.synthesize('拒绝这一段。'),{code:'SPEECH_TEXT_REJECTED'})
 assert.ok(providers.status().speechRoutes.every(route=>route.cooldownUntil===0))
 await providers.synthesize('准备好了🚀。')
 assert.deepEqual(calls,['拒绝这一段。','拒绝这一段。','准备好了🚀。','准备好了 。'])
 assert.equal(providers.status().speech.route,0)
 await assert.rejects(providers.synthesize('……🚀！'),{code:'SPEECH_TEXT_REJECTED'})
 assert.equal(calls.length,4)
})

test('live synthesis skips a timed-out chunk and uses the backup on the next chunk',async t=>{
 const config=twoVoices(),calls=[];config.tts.timeoutMs=10
 const providers=new Providers({store:fakeStore(config,keys),dataDir:await directory(t),now:()=>1000,tencentFactory:()=>({TextToVoice:request=>{
  calls.push([request.VoiceType,request.Text])
  return request.VoiceType===602003?new Promise(()=>{}):Promise.resolve({Audio:Buffer.alloc(4800,3).toString('base64')})
 }})})
 await assert.rejects(providers.synthesize('超时的片段。',{skipOnTimeout:true}),{code:'SPEECH_TIMEOUT'})
 assert.deepEqual(calls,[[602003,'超时的片段。']])
 assert.equal(providers.status().speechRoutes[0].cooldownUntil,6000)
 await providers.synthesize('继续下一段。',{skipOnTimeout:true})
 assert.deepEqual(calls,[[602003,'超时的片段。'],[501001,'继续下一段。']])
})

test('complete-response deadline switches after stalled headers or stalled body, then skips the cooling primary',async t=>{
 for(const stalledBody of [false,true]){
  const calls=[],store=fakeStore(twoModels(),keys)
  const providers=new Providers({store,dataDir:await directory(t),fetchImpl:async(url,options)=>{
   calls.push({url,request:JSON.parse(options.body)})
   if(url.includes('primary'))return stalledBody?new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}}):new Promise(()=>{})
   return modelReply('备用完成。')
  }})
  const started=performance.now();assert.match(await providers.generate([{role:'user',content:'你好'}]),/备用完成/)
  assert.ok(performance.now()-started<500,'a non-cooperative response must not hold the deadline open')
  assert.equal(calls.length,2);assert.deepEqual(calls[0].request.thinking,{type:'disabled'});assert.equal(calls[1].request.thinking,undefined)
  assert.match(providers.status().modelRoutes[0].error,/超过/)
  await providers.generate([{role:'user',content:'第二次'}]);assert.equal(calls.length,3);assert.match(calls[2].url,/backup/)
 }
})

test('invalid JSON and invalid director protocol both advance to the next model',async t=>{
 for(const bad of ['not-json','{"unexpected":"value"}']){
  let calls=0
  const providers=new Providers({store:fakeStore(twoModels(),keys),dataDir:await directory(t),fetchImpl:async()=>++calls===1?Response.json({choices:[{message:{content:bad}}]}):modelReply('完整口播。')})
  const value=await providers.generate([{role:'user',content:'你好'}],{validate:text=>{if(!JSON.parse(text).speech)throw new Error('没有口播')}})
  assert.match(value,/完整口播/);assert.equal(calls,2)
 }
})

test('caller cancellation never starts a backup or records an outage',async t=>{
 const controller=new AbortController();let calls=0
 const providers=new Providers({store:fakeStore(twoModels(),keys),dataDir:await directory(t),fetchImpl:async()=>{calls++;controller.abort(new Error('用户停止'));return new Promise(()=>{})}})
 await assert.rejects(providers.generate([{role:'user',content:'你好'}],{signal:controller.signal}),/用户停止/)
 assert.equal(calls,1);assert.equal(providers.status().modelRoutes[0].error,undefined)
})

test('cooldown expires and edited credentials immediately restore primary eligibility',async t=>{
 let now=1000,primaryOk=false;const calls=[],vault={...keys}
 const providers=new Providers({store:fakeStore(twoModels(),vault),dataDir:await directory(t),now:()=>now,fetchImpl:async url=>{calls.push(url);return url.includes('primary')&&!primaryOk?new Response('',{status:401}):modelReply('成功。')}})
 await providers.generate([{role:'user',content:'a'}]);primaryOk=true
 now+=60001;await providers.generate([{role:'user',content:'b'}]);assert.equal(providers.status().fallback,false)
 primaryOk=false;await providers.generate([{role:'user',content:'c'}]);primaryOk=true;vault.llmKey='fixture-replaced-key'
 await providers.generate([{role:'user',content:'d'}]);assert.match(calls.at(-1),/primary/)
})

test('Tencent SDK timeout switches to a different voice, reuses only selected credentials and preserves voice-specific caching',async t=>{
 const config=twoVoices(),calls=[];let lateResolve
 const providers=new Providers({store:fakeStore(config,keys),dataDir:await directory(t),tencentFactory:options=>({TextToVoice:async request=>{
  calls.push({request,credential:options.credential})
  if(request.VoiceType===602003)return new Promise(resolve=>lateResolve=resolve)
  return {Audio:Buffer.alloc(4800,3).toString('base64')}
 }})})
 const file=await providers.synthesize('欢迎来直播间。')
 assert.deepEqual(calls.map(x=>x.request.VoiceType),[602003,501001]);assert.deepEqual(calls[1].credential,{secretId:keys.tencentSecretId,secretKey:keys.tencentSecretKey})
 assert.equal(providers.status().speech.fallback,true);assert.equal((await readFile(file)).readUInt32LE(24),24000)
 assert.equal(await providers.synthesize('欢迎来直播间。'),file);assert.equal(calls.length,2)
 lateResolve({Audio:Buffer.alloc(4800,8).toString('base64')});await new Promise(resolve=>setImmediate(resolve))
 assert.equal((await readdir(providers.audioDir)).length,1,'a timed-out SDK result must never create a late cache file')
 config.tts.fallbacks[0].voice='101001';const changed=await providers.synthesize('欢迎来直播间。');assert.notEqual(changed,file)
 assert.equal((await readFile(changed)).readUInt32LE(24),16000)
})

test('speech HTTP failures use the independent compatible backend and redact every saved secret',async t=>{
 const config=twoVoices();config.tts.fallbacks=[{slot:2,provider:'openai',voice:'warm',model:'tts-1',baseUrl:'https://other.test/v1',speed:.9,usePrimaryCredentials:false}]
 const vault={...keys,ttsFallbackKey2:'fixture-other-speech-key'},requests=[]
 const providers=new Providers({store:fakeStore(config,vault),dataDir:await directory(t),tencentFactory:()=>({TextToVoice:async()=>{throw new Error('bad '+keys.tencentSecretKey)}}),fetchImpl:async(url,options)=>{requests.push({url,options});return new Response(Buffer.alloc(200,4),{headers:{'Content-Type':'audio/mpeg'}})}})
 await providers.synthesize('测试。');assert.equal(requests.length,1);assert.equal(requests[0].options.headers.Authorization,'Bearer '+vault.ttsFallbackKey2)
 assert.equal(JSON.parse(requests[0].options.body).voice,'warm');assert.doesNotMatch(JSON.stringify(providers.status()),/fixture-/)
})

test('cancelling a speech request prevents fallback and disk writes',async t=>{
 const controller=new AbortController(),calls=[]
 const providers=new Providers({store:fakeStore(twoVoices(),keys),dataDir:await directory(t),tencentFactory:()=>({TextToVoice:async request=>{calls.push(request);controller.abort(new Error('停止播报'));return {Audio:Buffer.alloc(200).toString('base64')}}})})
 await assert.rejects(providers.synthesize('测试。',{signal:controller.signal}),/停止播报/);assert.equal(calls.length,1);assert.deepEqual(await readdir(providers.audioDir),[])
})

test('per-route test bypasses a cooldown without trying another route, and defaults are ten/five seconds',async t=>{
 const config=twoModels();delete config.llm.timeoutMs;config.tts={provider:'tencent'};let calls=0
 const providers=new Providers({store:fakeStore(config,keys),dataDir:await directory(t),fetchImpl:async()=>{calls++;return new Response('',{status:401})}})
 assert.equal(providers.status().modelTimeoutMs,10000);assert.equal(providers.status().speechTimeoutMs,5000)
 await assert.rejects(providers.test('model',1),/所有模型/);await assert.rejects(providers.test('model',1),/所有模型/);assert.equal(calls,2)
})

test('all official 2.0 basic voices have names, styles and the supported sample rate',()=>{
 const voices=TENCENT_VOICES.filter(voice=>voice.group==='超自然大模型音色 2.0')
 assert.equal(voices.length,18);assert.equal(new Set(TENCENT_VOICES.map(voice=>voice.id)).size,TENCENT_VOICES.length)
 for(const voice of voices){assert.equal(voice.sampleRate,24000);assert.ok(voice.name&&voice.style);assert.doesNotMatch(voiceLabel(voice.id),/40[23]\d{3}/)}
 assert.equal(voiceName('403011'),'云嘉瑜');assert.match(voiceLabel('402001'),/云小团.*温柔甜美.*2\.0/)
 assert.equal(voiceName('alloy','openai'),'alloy')
})

test('auditioning a draft 2.0 voice uses saved credentials and never changes live configuration, cooldown or selected voice',async t=>{
 const config=twoVoices(),before=structuredClone(config),calls=[]
 const providers=new Providers({store:fakeStore(config,keys),dataDir:await directory(t),tencentFactory:options=>({TextToVoice:async request=>{calls.push({options,request});return {Audio:Buffer.alloc(4800,2).toString('base64')}}})})
 const healthBefore=structuredClone(providers.status());providers.speechCooldowns.set(0,Date.now()+60000)
 const preview=await providers.previewSpeech({slot:0,voice:'403011',speed:.9,text:'这是一段试听。',provider:'tencent'})
 assert.equal(preview.voiceName,'云嘉瑜');assert.equal(calls[0].request.VoiceType,403011);assert.equal(calls[0].request.SampleRate,24000)
 assert.equal(calls[0].options.credential.secretKey,keys.tencentSecretKey);assert.deepEqual(config,before)
 assert.equal(providers.status().speech.changedAt,healthBefore.speech.changedAt);assert.ok(providers.speechCooldowns.get(0)>Date.now())
 assert.equal((await readFile(preview.path)).subarray(0,4).toString(),'RIFF')
 const cached=await providers.previewSpeech({slot:0,voice:'403011',speed:.9,text:'这是一段试听。'});assert.equal(cached.cached,true);assert.equal(calls.length,1)
})

test('audition identifies backup credentials by stable slot and an unsupported voice never poisons live health or falls back',async t=>{
 const config=twoVoices();config.tts.fallbacks=[{slot:3,provider:'tencent',voice:'501001',speed:1,usePrimaryCredentials:false},{slot:1,provider:'tencent',voice:'602003',speed:1,usePrimaryCredentials:true}]
 const vault={...keys,ttsFallbackSecretId3:'fixture-other-account-id',ttsFallbackSecretKey3:'fixture-other-account-secret'},calls=[]
 const providers=new Providers({store:fakeStore(config,vault),dataDir:await directory(t),tencentFactory:options=>({TextToVoice:async request=>{calls.push({options,request});throw new Error('音色未开通 '+vault.ttsFallbackSecretKey3)}})})
 const before=structuredClone(providers.status())
 await assert.rejects(providers.previewSpeech({slot:3,voice:'402001'}),error=>/音色未开通/.test(error.message)&&!error.message.includes(vault.ttsFallbackSecretKey3))
 assert.equal(calls.length,1);assert.equal(calls[0].options.credential.secretKey,vault.ttsFallbackSecretKey3);assert.deepEqual(providers.status(),before)
 for(const draft of [{slot:4,voice:'403011'},{slot:0,voice:'invalid'},{slot:0,voice:'402001',text:'字'.repeat(151)},{slot:0,voice:'402001',speed:3},{slot:0,voice:'402001',provider:'openai'}])await assert.rejects(providers.previewSpeech(draft))
 assert.equal(calls.length,1)
})

test('a timed-out main voice defaults to the same voice and speed on backup, including after the primary voice changes',async t=>{
 const config=twoVoices();config.tts.voice='403000';config.tts.speed=1.15;delete config.tts.fallbacks[0].followPrimaryVoice
 config.tts.fallbacks[0].usePrimaryCredentials=false
 const vault={...keys,ttsFallbackSecretId1:'fixture-independent-id',ttsFallbackSecretKey1:'fixture-independent-secret'},calls=[]
 const providers=new Providers({dataDir:await directory(t),store:fakeStore(config,vault),tencentFactory:options=>({TextToVoice:async request=>{calls.push({options,request});return options.credential.secretId===keys.tencentSecretId?new Promise(()=>{}):{Audio:Buffer.alloc(4800,2).toString('base64')}}})})
 const first=await providers.synthesize('欢迎来到直播间，接着讲解。')
 assert.deepEqual(calls.map(call=>call.request.VoiceType),[403000,403000]);assert.deepEqual(calls.map(call=>call.request.Speed),[.75,.75])
 assert.equal(providers.speechInfo(first).voiceName,'云小朵');assert.equal(providers.speechInfo(first).fallback,true);assert.match(providers.speechInfo(first).reason,/超过/)
 assert.equal(config.tts.fallbacks[0].voice,'501001','inheritance does not require overwriting the independent voice draft')
 config.tts.voice='402001';config.tts.speed=.9
 const next=await providers.synthesize('欢迎来到直播间，接着讲解。');assert.notEqual(next,first);assert.deepEqual(calls.slice(-2).map(call=>call.request.VoiceType),[402001,402001])
 assert.equal(providers.speechInfo(next).voiceName,'云小团');assert.equal(providers.speechInfo(next).speed,.9)
})

test('live speech preserves mixed Unicode with a short first clause and bounded following requests',()=>{
 for(const text of ['欢迎，先看看这件事。'.repeat(30),'CloudBase helps developers build Agent apps. '.repeat(15),'中🙂英API123，'.repeat(60)]){
  const parts=splitLiveSpeech(text);assert.equal(parts.join(''),text);assert.ok(Array.from(parts[0]).length<=24);assert.ok(parts.every(p=>Array.from(p).length<=40&&Buffer.byteLength(p)<=120))
 }
})

test('speech uses one bounded pool and promotes live chunks ahead of waiting future paragraphs',async t=>{
 const pending=[],order=[];let active=0,maximum=0
 const config={tts:{provider:'openai',baseUrl:'https://speech.test/v1',voice:'same',timeoutMs:2000}}
 const providers=new Providers({dataDir:await directory(t),store:fakeStore(config,{ttsKey:'fixture-key'}),fetchImpl:async(url,options)=>{const text=JSON.parse(options.body).input;active++;maximum=Math.max(maximum,active);order.push(text);await new Promise(resolve=>pending.push(()=>{active--;resolve()}));return new Response(Buffer.alloc(100),{headers:{'Content-Type':'audio/mpeg'}})}})
 const wait=async fn=>{for(let i=0;!fn();i++){assert.ok(i<300);await new Promise(r=>setTimeout(r,2))}}
 const first=providers.synthesize('future one',{priority:1}),second=providers.synthesize('future two',{priority:1});await wait(()=>pending.length===2)
 const future=providers.synthesize('future three',{priority:1}),live=providers.synthesize('live continuation',{priority:0});await wait(()=>providers.speechTasks.length===2)
 pending.shift()();await wait(()=>order.length===3);assert.equal(order[2],'live continuation');assert.equal(maximum,2)
 while(order.length<4||pending.length){if(pending.length)pending.shift()();await new Promise(r=>setTimeout(r,2))}
 await Promise.all([first,second,future,live]);assert.equal(maximum,2);assert.equal(providers.speechTasks.length,0)
})

test('waiting in the shared speech queue does not consume the provider deadline, and cancellation never submits stale text',async t=>{
 const pending=[],submitted=[],config={tts:{provider:'openai',baseUrl:'https://speech.test/v1',voice:'same',timeoutMs:30}}
 const providers=new Providers({dataDir:await directory(t),store:fakeStore(config,{ttsKey:'fixture-key'}),fetchImpl:async(url,options)=>{submitted.push(JSON.parse(options.body).input);return new Response(Buffer.alloc(100),{headers:{'Content-Type':'audio/mpeg'}})}})
 const wait=async fn=>{for(let i=0;!fn();i++){assert.ok(i<300);await new Promise(r=>setTimeout(r,2))}}
 const a=providers.speechAttempt(()=>new Promise(resolve=>pending.push(resolve))),b=providers.speechAttempt(()=>new Promise(resolve=>pending.push(resolve)));await wait(()=>pending.length===2)
 const c=providers.synthesize('live queued'),controller=new AbortController(),cancelled=providers.synthesize('stale future',{signal:controller.signal,priority:1});const rejected=assert.rejects(cancelled,/caller cancelled/);await wait(()=>providers.speechTasks.length===2);controller.abort(new Error('caller cancelled'));await rejected
 await new Promise(r=>setTimeout(r,70));pending.forEach(resolve=>resolve());await Promise.all([a,b,c]);assert.deepEqual(submitted,['live queued']);assert.equal(providers.speechCooldowns.size,0)
})
