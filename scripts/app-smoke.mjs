/** Verify the actual HTTP app, shared controls, composite pixels, speech monitoring and recording. */
import {mkdtempSync,writeFileSync,readFileSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {once} from 'node:events'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {WebSocket} from 'ws'
import {createStudio} from '../server/http.mjs'
import {detectTools} from '../server/media.mjs'

const root=fileURLToPath(new URL('../',import.meta.url)),directory=mkdtempSync(join(tmpdir(),'studio-app-real-'))
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),tools=detectTools()
if(!tools.ready)throw new Error('Install Chromium and FFmpeg before the application media smoke')
const app=await createStudio({root,dataDir:directory,port:0,host:'127.0.0.1',password:'Local-smoke-password-only-2026',env:{}})
let monitor,closed=false,ownedBrowser,ownedEncoder,pcmBytes=0,pcmPower=0,pcmSamples=0,sseCount=0
const streamAbort=new AbortController()
const cleanup=async()=>{if(closed)return;closed=true;streamAbort.abort();monitor?.terminate();await app.close()}
process.once('SIGTERM',()=>{void cleanup().finally(()=>process.exit(143))})
async function request(path,cookie,{method='GET',value,body,headers={}}={}){
 const response=await fetch(app.baseUrl+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(value?{'Content-Type':'application/json'}:{}),...headers},body:value?JSON.stringify(value):body})
 if(!response.ok)throw new Error(`${method} ${path} failed (${response.status}): ${(await response.text()).slice(0,300)}`)
 return response
}
const action=(name,cookie,data={})=>request('/api/action',cookie,{method:'POST',value:{action:name,...data}}).then(r=>r.json())
const state=cookie=>request('/api/state',cookie).then(r=>r.json())
async function waitFor(read,predicate,message,timeout=15000){const until=Date.now()+timeout;while(Date.now()<until){const value=await read();if(predicate(value))return value;await delay(75)}throw new Error(message)}
try{
 console.error('app-smoke: two authenticated controllers and shared preview')
 const login=async()=>{const response=await request('/api/login',null,{method:'POST',value:{password:'Local-smoke-password-only-2026'}});return response.headers.get('set-cookie').split(';')[0]}
 const first=await login(),second=await login();assert.notEqual(first,second)
 await request('/api/config',first,{method:'PUT',value:{patch:{output:{width:640,height:360,fps:10,videoBitrate:800,audioBitrate:96,record:true,rtmpUrl:''},bgm:{asset:''},scene:{title:'小云 Studio · 实际集成验证'}}}})
 assert.equal((await state(second)).config.scene.title,'小云 Studio · 实际集成验证')
 const eventResponse=await fetch(app.baseUrl+'/api/events',{headers:{Cookie:second},signal:streamAbort.signal})
 assert.equal(eventResponse.status,200)
 const reader=eventResponse.body.getReader(),events=(async()=>{try{for(;;){const result=await reader.read();if(result.done)break;sseCount+=(Buffer.from(result.value).toString().match(/data: /g)||[]).length}}catch(error){if(!streamAbort.signal.aborted)throw error}})()
 await action('preview.start',first);ownedBrowser=app.media.browser.process()
 await app.media.programPage.waitForFunction(()=>window.__studioProgram?.ready&&document.querySelector('#avatar-image')?.getAttribute('href')&&document.querySelector('#slide-image')?.naturalWidth>0,{timeout:15000})
 const avatar=await app.media.programPage.evaluate(async()=>{
  const element=document.querySelector('#avatar-image'),image=new Image();image.src=element.getAttribute('href');await image.decode()
  return {nativeWidth:image.naturalWidth,nativeHeight:image.naturalHeight,svgImageAttribute:element.hasAttribute('href')}
 })
 assert.ok(avatar.nativeWidth>100&&avatar.nativeHeight>100&&avatar.svgImageAttribute)
 await delay(350)
 const frame=Buffer.from(await (await request('/api/frame.jpg',second)).arrayBuffer());writeFileSync(join(directory,'program.jpg'),frame)
 const raw=spawnSync(tools.ffmpeg.path,['-hide_banner','-loglevel','error','-i','pipe:0','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{input:frame,maxBuffer:8*1024*1024})
 assert.equal(raw.status,0);assert.equal(raw.stdout.length,640*360*3)
 let dark=0,green=0,pixels=0
 for(let y=65;y<180;y++)for(let x=535;x<630;x++){const at=(y*640+x)*3,r=raw.stdout[at],g=raw.stdout[at+1],b=raw.stdout[at+2];pixels++;if(r<125&&g<125&&b<145)dark++;if(g>180&&g>r*1.3&&g>b*1.3)green++}
 assert.ok(dark>400,'the composited avatar region must contain actual character pixels, not only a blank card')
 assert.ok(green/pixels<.02,'the green background must be keyed out in the composed scene')
 console.error('app-smoke: shared deck navigation')
 await action('presentation.next',second);assert.equal((await state(first)).media.slide.pageNumber,2)
 await action('presentation.first',first);assert.equal((await state(second)).media.slide.pageNumber,1)
 const wave=join(directory,'speech.wav'),generated=spawnSync(tools.ffmpeg.path,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=523.25:duration=2.2','-ar','48000','-ac','2',wave]);assert.equal(generated.status,0)
 const upload=await (await request('/api/upload',first,{method:'POST',headers:{'X-Filename':'smoke-speech.wav','X-Asset-Type':'audio','Content-Type':'audio/wav'},body:readFileSync(wave)})).json()
 await request('/api/config',first,{method:'PUT',value:{patch:{cues:[{id:'integration-cue',title:'本地验证录音',text:'这一段使用实际上传录音，验证服务端共享播放和录制。',audioUrl:upload.url}]}}})
 console.error('app-smoke: actual cue, audio monitor and recording across controller logout')
 monitor=new WebSocket(app.baseUrl.replace('http:','ws:')+'/api/monitor',{headers:{Cookie:second}})
 monitor.on('message',(bytes,isBinary)=>{if(!isBinary)return;pcmBytes+=bytes.length;for(let at=0;at+1<bytes.length;at+=2){pcmPower+=(bytes.readInt16LE(at)/32768)**2;pcmSamples++}})
 await once(monitor,'open');await action('output.start',first);ownedEncoder=app.media.output.child
 const encoding=await waitFor(()=>state(second),s=>s.media.output.active&&s.media.output.encodedFrames>3,'actual recording encoder did not start')
 const started=performance.now();await action('cue.play',first,{id:'integration-cue'})
 await waitFor(()=>state(second),s=>s.director.phase==='playing'&&s.media.audio.voiceRms>0.01,'uploaded cue did not produce real PCM')
 await action('live.pause',second);assert.equal((await state(first)).director.paused,true);await delay(300)
 await action('live.resume',first);assert.equal((await state(second)).director.paused,false)
 await request('/api/logout',first,{method:'POST'});assert.equal((await fetch(app.baseUrl+'/api/state',{headers:{Cookie:first}})).status,401)
 const afterLogout=await state(second);assert.equal(afterLogout.media.output.active,true);assert.equal(monitor.readyState,WebSocket.OPEN)
 await waitFor(()=>state(second),s=>!s.director.running&&!s.director.currentSpeech,'fixed cue did not complete')
 const consumedMs=Math.round(performance.now()-started);assert.ok(consumedMs>=2400,'cue completion must wait for actual PCM plus the controller pause')
 await delay(1200);const progressed=await state(second);assert.ok(progressed.media.output.encodedFrames>encoding.media.output.encodedFrames)
 await action('output.stop',second);assert.equal((await state(second)).media.output.active,false)
 const recording=join(directory,'recordings',app.media.status().output.recordingFile),decoded=spawnSync(tools.ffmpeg.path,['-hide_banner','-loglevel','error','-i',recording,'-vn','-f','s16le','-ar','16000','-ac','1','pipe:1'],{maxBuffer:16*1024*1024})
 assert.equal(decoded.status,0);let energy=0;for(let at=0;at+1<decoded.stdout.length;at+=2)energy+=(decoded.stdout.readInt16LE(at)/32768)**2
 const recordingRms=Math.sqrt(energy/(decoded.stdout.length/2)),monitorRms=Math.sqrt(pcmPower/pcmSamples)
 assert.ok(recordingRms>.01&&monitorRms>.01&&pcmBytes>48000,'recording and authenticated operator monitoring must contain actual audio')
 assert.ok(sseCount>4,'the second controller must receive actual server events')
 console.error('app-smoke: close application with controller events open')
 await cleanup();await events
 assert.ok(ownedBrowser.exitCode!==null||ownedBrowser.signalCode!==null);assert.ok(ownedEncoder.exitCode!==null||ownedEncoder.signalCode!==null);assert.equal(app.server.listening,false);assert.equal(app.media.mixer.closed,true)
 const result={passed:true,artifactDirectory:directory,twoControllerSessions:true,sharedSlideControls:true,sharedPauseResume:true,outputSurvivedControllerLogout:true,compositeAvatarPixels:dark,keyedGreenPixels:green,avatarRegionPixels:pixels,recordedBytes:statSync(recording).size,decodedRecordingRms:recordingRms,authenticatedMonitorPcmBytes:pcmBytes,monitorRms,cuePlaybackWithPauseMs:consumedMs,sseEvents:sseCount,ownedBrowserExited:true,ownedEncoderExited:true,audioMixerClosed:true,externalStreamingDestinationUsed:false}
 writeFileSync(join(directory,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2))
}finally{await cleanup()}
