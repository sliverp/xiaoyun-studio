/** Verify fixed-recording monitoring through the actual controller Web Audio graph, without speaker output. */
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import puppeteer from 'puppeteer-core'
import {createStudio} from '../server/http.mjs'
import {detectTools} from '../server/media.mjs'

const root=fileURLToPath(new URL('../',import.meta.url)),directory=mkdtempSync(join(tmpdir(),'studio-monitor-real-'))
const tools=detectTools(),password='Isolated-monitor-smoke-2026',delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
if(!tools.ready)throw new Error('Install Chromium and FFmpeg before the browser audio monitor smoke')
const app=await createStudio({root,dataDir:directory,port:0,host:'127.0.0.1',password,env:{}})
let browser,page,closed=false
const cleanup=async()=>{if(closed)return;closed=true;await browser?.close();await app.close()}
process.once('SIGTERM',()=>{void cleanup().finally(()=>process.exit(143))})
async function waitFor(read,predicate,message,timeout=15000){const until=Date.now()+timeout;while(Date.now()<until){const value=await read();if(predicate(value))return value;await delay(50)}throw new Error(message)}

try{
 console.error('audio-monitor-smoke: isolated controller, trusted click and native Web Audio rendering')
 const args=['--mute-audio','--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']
 if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
 browser=await puppeteer.launch({executablePath:tools.chromium.path,userDataDir:join(directory,'controller-profile'),headless:true,protocolTimeout:30000,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,args})
 page=await browser.newPage();const pageErrors=[]
 page.on('pageerror',error=>pageErrors.push(error.message))
 await page.setRequestInterception(true)
 page.on('request',request=>{const url=new URL(request.url());if(url.origin===app.baseUrl||['data:','blob:','about:'].includes(url.protocol))void request.continue();else void request.abort()})
 await page.evaluateOnNewDocument(()=>{
  const probe={contexts:[],scheduledChunks:0,sourcePeak:0,renderedRms:0,renderedNonzeroFrames:0,pcmBytes:0,pcmPeak:0,handshakes:0,lastFormatAt:0,cueRequests:[],scheduleLeadMin:Infinity,scheduleLeadMax:0}
  window.__studioAudioProbe=probe
  const NativeAudioContext=window.AudioContext||window.webkitAudioContext
  class ObservedContext extends NativeAudioContext{
   constructor(options){
    super(options);probe.contexts.push(this)
    const analyser=this.createAnalyser();analyser.fftSize=2048;analyser.connect(this.destination)
    const samples=new Float32Array(analyser.fftSize),originalCreate=this.createBufferSource.bind(this)
    this.createBufferSource=()=>{
     const source=originalCreate(),originalConnect=source.connect.bind(source),originalStart=source.start.bind(source)
     source.connect=(destination,...rest)=>originalConnect(destination===this.destination?analyser:destination,...rest)
     source.start=(when,...rest)=>{
      probe.scheduledChunks++;const lead=(when||this.currentTime)-this.currentTime;probe.scheduleLeadMin=Math.min(probe.scheduleLeadMin,lead);probe.scheduleLeadMax=Math.max(probe.scheduleLeadMax,lead)
      if(source.buffer)for(let channel=0;channel<source.buffer.numberOfChannels;channel++)for(const value of source.buffer.getChannelData(channel))probe.sourcePeak=Math.max(probe.sourcePeak,Math.abs(value))
      return originalStart(when,...rest)
     }
     return source
    }
    const timer=setInterval(()=>{analyser.getFloatTimeDomainData(samples);let power=0;for(const value of samples)power+=value*value;const rms=Math.sqrt(power/samples.length);probe.renderedRms=Math.max(probe.renderedRms,rms);if(rms>.001)probe.renderedNonzeroFrames++},20)
    this.addEventListener('statechange',()=>{if(this.state==='closed')clearInterval(timer)})
   }
  }
  window.AudioContext=ObservedContext
  if(window.webkitAudioContext)window.webkitAudioContext=ObservedContext
  const NativeWebSocket=window.WebSocket
  window.WebSocket=class extends NativeWebSocket{
   constructor(url,protocols){
    super(url,...(protocols===undefined?[]:[protocols]))
    if(new URL(url,location.href).pathname!=='/api/monitor')return
    this.addEventListener('message',event=>{
     if(typeof event.data==='string'){try{const value=JSON.parse(event.data);if(value.format==='s16le'&&value.sampleRate===48000&&value.channels===2){probe.handshakes++;probe.lastFormatAt=performance.now()}}catch{/* Only diagnostic format observations are retained. */}return}
     if(!(event.data instanceof ArrayBuffer))return
     probe.pcmBytes+=event.data.byteLength;const view=new DataView(event.data);for(let at=0;at+1<view.byteLength;at+=2)probe.pcmPeak=Math.max(probe.pcmPeak,Math.abs(view.getInt16(at,true)/32768))
    })
   }
  }
  const originalFetch=window.fetch.bind(window)
  window.fetch=(input,options)=>{
   if(new URL(typeof input==='string'?input:input.url,location.href).pathname==='/api/action'&&typeof options?.body==='string'){
    try{if(JSON.parse(options.body).action==='cue.play')probe.cueRequests.push({at:performance.now(),formatAt:probe.lastFormatAt,contextState:probe.contexts.at(-1)?.state||'missing'})}catch{/* Non-JSON fetch bodies are not cue requests. */}
   }
   return originalFetch(input,options)
  }
 })
 await page.goto(app.baseUrl,{waitUntil:'domcontentloaded'})
 await page.waitForSelector('#login-password',{visible:true});await page.type('#login-password',password);await page.click('#login-form button[type="submit"]')
 const entry=await waitFor(()=>page.evaluate(()=>({cueVisible:!!document.querySelector('#cue-list [data-cue="audience-interaction"]')?.getClientRects().length,open:document.querySelector('#open-current-project')?.getClientRects().length?'#open-current-project':document.querySelector('[data-project-open]')?.getClientRects().length?'[data-project-open]':''})),value=>value.cueVisible||value.open,'the authenticated controller did not show a studio or project selector')
 if(!entry.cueVisible)await page.click(entry.open)
 await page.waitForSelector('#cue-list [data-cue="audience-interaction"]',{visible:true})
 const cookies=await page.cookies(),cookie=cookies.map(value=>value.name+'='+value.value).join('; ')
 const closeMonitor=async()=>{const separate=await page.$eval('body',()=>!!document.querySelector('#monitor-mute')?.getClientRects().length);await page.click(separate?'#monitor-mute':'#monitor-toggle')}
 async function request(path,{method='GET',value}={}){const projectId=app.snapshot().projects?.activeId,response=await fetch(app.baseUrl+path,{method,headers:{Cookie:cookie,...(value?{'Content-Type':'application/json'}:{}),...(method!=='GET'&&projectId?{'X-Studio-Project':projectId}:{})},body:value?JSON.stringify(value):undefined});if(!response.ok)throw new Error(`${method} ${path} failed (${response.status})`);return response.json()}
 const action=(name,value={})=>request('/api/action',{method:'POST',value:{action:name,...value}}),state=()=>request('/api/state')
 await request('/api/config',{method:'PUT',value:{patch:{output:{width:640,height:360,fps:10,videoBitrate:800,audioBitrate:96,record:true,rtmpUrl:''},bgm:{asset:''}}}})
 assert.equal((await state()).media.output.running,false)
 assert.equal(await page.$eval('#monitor-toggle',element=>element.getAttribute('aria-pressed')),'false')
 await page.click('#cue-list [data-cue="audience-interaction"]')
 const readProbe=()=>page.evaluate(()=>{const p=window.__studioAudioProbe;return {scheduledChunks:p.scheduledChunks,sourcePeak:p.sourcePeak,renderedRms:p.renderedRms,renderedNonzeroFrames:p.renderedNonzeroFrames,pcmBytes:p.pcmBytes,pcmPeak:p.pcmPeak,handshakes:p.handshakes,cueRequests:p.cueRequests,contexts:p.contexts.map(context=>({state:context.state,currentTime:context.currentTime})),scheduleLeadMin:Number.isFinite(p.scheduleLeadMin)?p.scheduleLeadMin:null,scheduleLeadMax:p.scheduleLeadMax}})
 const noOutput=await waitFor(readProbe,value=>value.pcmPeak>.01&&value.renderedRms>.001&&value.renderedNonzeroFrames>=3,'fixed cue did not render nonzero browser audio without an output')
 assert.equal((await state()).media.output.running,false)
 assert.ok(noOutput.cueRequests.length===1&&noOutput.cueRequests[0].formatAt>0&&noOutput.cueRequests[0].at>=noOutput.cueRequests[0].formatAt&&noOutput.cueRequests[0].contextState==='running','the first cue must be requested only after the listener is ready')
 await closeMonitor();await waitFor(readProbe,value=>value.contexts.every(context=>context.state==='closed'),'closing monitoring did not release its AudioContext')
 await waitFor(state,value=>value.director.running&&value.media.audio.voiceRms>.001,'closing local monitoring stopped server speech',3000)
 await action('live.stop')
 console.error('audio-monitor-smoke: recording continues after local monitor is closed')
 await action('output.start');const recordingStarted=await waitFor(state,value=>value.media.output.recording&&value.media.output.encodedFrames>3,'the isolated recording did not start')
 await page.click('#cue-list [data-cue="audience-interaction"]')
 await waitFor(readProbe,value=>value.cueRequests.length===2,'the second fixed cue was not requested')
 assert.equal(await page.$eval('#monitor-toggle',element=>element.getAttribute('aria-pressed')),'false','an explicit local mute must be respected by the next cue')
 await waitFor(state,value=>value.media.audio.voiceRms>.01,'the second fixed cue did not produce real speech PCM')
 await page.click('#monitor-toggle')
 await waitFor(readProbe,value=>value.contexts.length>=2&&value.contexts.at(-1).state==='running'&&value.handshakes>=2,'an explicit monitor click did not reopen the local audio')
 await closeMonitor();await delay(400)
 const recordingContinued=await waitFor(state,value=>value.media.audio.voiceRms>.001,'monitor shutdown stopped the shared voice bus',3000)
 assert.ok(recordingContinued.media.output.recording&&recordingContinued.media.output.encodedFrames>recordingStarted.media.output.encodedFrames,'monitor shutdown stopped or stalled the shared recording')
 await action('live.stop');await action('output.stop')
 const after=await state(),recording=join(app.runtimeDataDir||directory,'recordings',after.media.output.recordingFile),probe=await readProbe()
 assert.ok(statSync(recording).size>10000);assert.equal(pageErrors.length,0)
 const decoded=spawnSync(tools.ffmpeg.path,['-hide_banner','-loglevel','error','-i',recording,'-vn','-f','s16le','-ar','16000','-ac','1','pipe:1'],{maxBuffer:16*1024*1024})
 assert.equal(decoded.status,0);let recordedPower=0;for(let at=0;at+1<decoded.stdout.length;at+=2)recordedPower+=(decoded.stdout.readInt16LE(at)/32768)**2
 const recordingRms=Math.sqrt(recordedPower/(decoded.stdout.length/2));assert.ok(recordingRms>.001,'the actual recorded voice track must remain nonzero')
 await page.screenshot({path:join(directory,'controller.png'),fullPage:true})
 await cleanup()
 const result={passed:true,artifactDirectory:directory,fixedCue:'audience-interaction',paidApiUsed:false,externalStreamingDestinationUsed:false,hardwareAudioMuted:true,trustedClickAutomaticallyOpenedMonitor:true,firstCueWaitedForListener:true,explicitLocalMuteRespected:true,monitorWorkedWithoutOutput:true,closingMonitorPreservedSpeech:true,closingMonitorPreservedRecording:true,recordedBytes:statSync(recording).size,recordingRms,webAudio:probe,pageErrors}
 writeFileSync(join(directory,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2))
}catch(error){
 let diagnostic=null
 if(page&&!page.isClosed()){
  try{diagnostic=await page.evaluate(()=>({cueCount:document.querySelectorAll('#cue-list [data-cue]').length,workspaceHidden:document.querySelector('#project-workspace')?.hidden,alert:document.querySelector('#global-alert')?.textContent||'',monitorState:document.querySelector('#monitor-state')?.textContent||'',audio:window.__studioAudioProbe?{contexts:window.__studioAudioProbe.contexts.map(context=>({state:context.state,currentTime:context.currentTime})),handshakes:window.__studioAudioProbe.handshakes,pcmBytes:window.__studioAudioProbe.pcmBytes,pcmPeak:window.__studioAudioProbe.pcmPeak,renderedRms:window.__studioAudioProbe.renderedRms,cueRequests:window.__studioAudioProbe.cueRequests}:null}));await page.screenshot({path:join(directory,'controller-failure.png'),fullPage:true})}catch{/* A disconnected test browser has no remaining page diagnostics. */}
 }
 writeFileSync(join(directory,'verification.json'),JSON.stringify({passed:false,error:String(error.message),artifactDirectory:directory,diagnostic},null,2)+'\n');console.error('Audio monitor diagnostic: '+join(directory,'verification.json'));throw error
}finally{await cleanup()}
