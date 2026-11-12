/** Delayed local speech responses exercise real progressive PCM, ordering and resource bounds. */
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createStudio} from '../server/http.mjs'
import {Providers,pcmWav,splitLiveSpeech} from '../server/providers.mjs'
const work=resolve(process.env.SPEECH_PIPELINE_WORK_DIR||'.data/speech-pipeline'),dir=await mkdtemp(join(tmpdir(),'studio-speech-pipeline-')),frames=[],submitted=[],speeches=[],text='先从一个具体任务出发，解释当前产品怎样帮助你。然后看部署方式和用量限制，再决定是否适合自己的项目。'.repeat(3)
await mkdir(work,{recursive:true});const requests=[];let active=0,maxActive=0,firstVoiceAt=0,maxDecoderQueue=0
const rate=24000,pcm=Buffer.alloc(rate*1.2*2)
for(let n=0;n<pcm.length/2;n++)pcm.writeInt16LE(Math.round(Math.sin(n*2*Math.PI*440/rate)*6000),n*2)
const app=await createStudio({dataDir:join(dir,'server'),port:0,password:'Speech-pipeline-smoke-only-2026',env:{},providerFactory:options=>new Providers({...options,fetchImpl:async(url,options)=>{
 if(url.endsWith('/chat/completions'))return Response.json({choices:[{message:{content:JSON.stringify({speech:text,navigation:'stay'})}}]})
 const input=JSON.parse(options.body).input,record={text:input,started:performance.now(),done:0};submitted.push(record);requests.push(input);active++;maxActive=Math.max(maxActive,active)
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,150);options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason)},{once:true})});record.done=performance.now();return new Response(pcmWav(pcm,rate),{headers:{'content-type':'audio/wav'}})}finally{active--}
}})})
app.store.update({llm:{baseUrl:'https://fixture.test/v1',model:'fixture'},tts:{provider:'openai',baseUrl:'https://fixture.test/v1',voice:'fixture',fallbacks:[]},program:{opening:false,closing:false,enabled:{source:true,comment:false,engagement:false,sale:false,lottery:false}},presentation:{autoAdvance:false},bgm:{asset:''},output:{width:640,height:360,fps:5}});app.store.setSecrets({ttsKey:'fixture-speech-key',llmKey:'fixture-model-key'})
app.events.on('event',e=>{if(e.type==='speech')speeches.push({...e.payload,at:performance.now()})})
const relay=app.media.onAudio;app.media.onAudio=buffer=>{let power=0;for(let n=0;n<buffer.length;n+=2)power+=(buffer.readInt16LE(n)/32768)**2;const rms=Math.sqrt(power/(buffer.length/2)),at=performance.now();if(rms>.01&&!firstVoiceAt)firstVoiceAt=at;frames.push({at,rms});maxDecoderQueue=Math.max(maxDecoderQueue,app.media.mixer.queue.length);relay(buffer)}
const wait=async fn=>{const deadline=performance.now()+30000;while(!fn()){if(performance.now()>deadline)throw Error('Progressive playback timed out');await new Promise(r=>setTimeout(r,20))}}
try{
 await app.director.start();await wait(()=>firstVoiceAt>0);const turn=app.director.currentSpeech,parts=splitLiveSpeech(text);assert.ok(turn.audioProgress.ready<turn.audioProgress.total,'audio begins before the tail is synthesized');assert.equal(app.director.memory.turns,0)
 await wait(()=>speeches.length>1);assert.equal(turn.audioProgress.completed,parts.length);assert.equal(app.director.memory.turns,1)
 const last=frames.findLastIndex(f=>f.at<speeches[1].at&&f.rms>.01),first=frames.findIndex(f=>f.rms>.01),timeline=frames.slice(first,last+1);let silence=0,maxSilence=0
 for(const f of timeline){silence=f.rms<.001?silence+20:0;maxSilence=Math.max(maxSilence,silence)}
 assert.ok(maxSilence<=100,'chunk joins must not add audible stalls: '+maxSilence+'ms');assert.ok(maxActive<=2);assert.ok(maxDecoderQueue<=3)
 assert.equal(parts.join(''),turn.text);assert.ok(parts.every(part=>requests.includes(part)),'every source chunk was synthesized');assert.ok(submitted.some(r=>r.started>firstVoiceAt),'the tail continues synthesis after voice begins');assert.equal(app.media.outputGraph.status().running,false)
 const result={passed:true,chunks:parts.length,firstChunkCharacters:Array.from(parts[0]).length,maximumChunkCharacters:Math.max(...parts.map(p=>Array.from(p).length)),firstAudioBeforeWholeSynthesis:true,tailGeneratedDuringPlayback:true,wholeTurnRememberedOnlyAfterAllChunks:true,maxConcurrentSpeech:maxActive,maxDecodedQueue:maxDecoderQueue,maximumSilenceAtJoinsMs:maxSilence,firstAudioAfterFirstRequestMs:Math.round(firstVoiceAt-submitted[0].started),outputNeverStarted:true};await writeFile(join(work,'pcm-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await app.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
