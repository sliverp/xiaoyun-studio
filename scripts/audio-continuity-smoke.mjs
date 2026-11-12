/** Measure continuous PCM and browser scheduling under brief server/UI stalls, with hardware muted. */
import assert from 'node:assert/strict'
import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import puppeteer from 'puppeteer-core'
import {createStudio} from '../server/http.mjs'
import {detectTools} from '../server/media.mjs'
import {pcmWav} from '../server/providers.mjs'

const root=fileURLToPath(new URL('../',import.meta.url)),directory=mkdtempSync(join(tmpdir(),'studio-continuity-'))
const tools=detectTools(),password='Isolated-continuity-smoke-2026',duration=8,rate=48000
if(!tools.ready)throw new Error('Install Chromium and FFmpeg before the audio continuity smoke')
const app=await createStudio({root,dataDir:directory,port:0,host:'127.0.0.1',password,env:{}})
const pcm=Buffer.alloc(rate*duration*4)
for(let frame=0;frame<rate*duration;frame++){const value=Math.round(Math.sin(frame*2*Math.PI*997/rate)*8000);pcm.writeInt16LE(value,frame*4);pcm.writeInt16LE(value,frame*4+2)}
const asset=app.assets.upload(pcmWav(pcm,rate,2),{filename:'continuity-tone.wav',type:'audio'})
app.store.update({bgm:{asset:''},output:{width:640,height:360,fps:10},cues:[{id:'continuity-tone',title:'连续声音验证',text:'连续测试音',audioUrl:asset.url}]})
const frames=[],relay=app.media.onAudio
app.media.onAudio=buffer=>{
  let power=0;for(let at=0;at<buffer.length;at+=2)power+=(buffer.readInt16LE(at)/32768)**2
  frames.push({at:performance.now(),rms:Math.sqrt(power/(buffer.length/2))});relay(buffer)
}
let browser,page,load,report={passed:false,artifactDirectory:directory}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function waitFor(check,message,timeout=18000){const deadline=performance.now()+timeout;while(performance.now()<deadline){if(await check())return;await delay(40)}throw new Error(message)}
async function cleanup(){clearInterval(load);await browser?.close();await app.close()}
process.once('SIGTERM',()=>{void cleanup().finally(()=>process.exit(143))})
try{
  const args=['--mute-audio','--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding']
  if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
  browser=await puppeteer.launch({executablePath:tools.chromium.path,userDataDir:join(directory,'controller-profile'),headless:true,args,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false})
  page=await browser.newPage();await page.setViewport({width:1280,height:900})
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.setRequestInterception(true)
  page.on('request',request=>{const url=new URL(request.url());void(url.origin===app.baseUrl||['data:','blob:','about:'].includes(url.protocol)?request.continue():request.abort())})
  await page.evaluateOnNewDocument(()=>{
    const probe={scheduled:[]};window.__continuityProbe=probe
    const Native=window.AudioContext||window.webkitAudioContext
    window.AudioContext=class extends Native{
      constructor(options){
        super(options);const create=this.createBufferSource.bind(this)
        this.createBufferSource=()=>{
          const source=create(),start=source.start.bind(source)
          source.start=(when,...rest)=>{
            const data=source.buffer.getChannelData(0);let power=0
            for(const sample of data)power+=sample*sample
            probe.scheduled.push({start:when,end:when+source.buffer.duration/(source.playbackRate.value||1),rms:Math.sqrt(power/data.length)})
            return start(when,...rest)
          };return source
        }
      }
    }
  })
  await page.goto(app.baseUrl,{waitUntil:'domcontentloaded'})
  await page.waitForSelector('#login-password',{visible:true});await page.type('#login-password',password);await page.click('#login-form button[type="submit"]')
  await page.waitForSelector('#open-current-project',{visible:true});await page.click('#open-current-project')
  await page.waitForSelector('[data-cue="continuity-tone"]',{visible:true})
  load=setInterval(()=>{const end=performance.now()+8;while(performance.now()<end){}},83)
  await page.evaluate(()=>{window.__continuityLoad=setInterval(()=>{const end=performance.now()+55;while(performance.now()<end){}},490)})
  await page.click('[data-cue="continuity-tone"]')
  await waitFor(()=>frames.some(frame=>frame.rms>.02),'the test tone never reached the mixer')
  await waitFor(()=>!app.director.running&&!app.director.currentSpeech,'the test tone did not complete')
  clearInterval(load);await page.evaluate(()=>clearInterval(window.__continuityLoad));await delay(400)
  const scheduled=await page.evaluate(()=>window.__continuityProbe.scheduled)
  const first=frames.findIndex(frame=>frame.rms>.02),last=frames.findLastIndex(frame=>frame.rms>.02)
  const firstPlayed=scheduled.findIndex(frame=>frame.rms>.02),lastPlayed=scheduled.findLastIndex(frame=>frame.rms>.02)
  assert.ok(first>=0&&last>first&&firstPlayed>=0&&lastPlayed>firstPlayed)
  let gaps=0,maxGap=0
  for(let index=firstPlayed+1;index<=lastPlayed;index++){const gap=scheduled[index].start-scheduled[index-1].end;if(gap>.0005)gaps++;maxGap=Math.max(maxGap,gap)}
  const audioSpan=frames[last].at-frames[first].at+20
  const silentFrames=frames.slice(first,last+1).filter(frame=>frame.rms<.001).length
  report={...report,syntheticToneSeconds:duration,hardwareAudioMuted:true,briefServerStalls:true,briefBrowserStalls:true,serverAudioSpanMs:Math.round(audioSpan),serverClockErrorMs:Math.round(Math.abs(audioSpan-duration*1000)),silentFramesInsideTone:silentFrames,browserSchedulingGaps:gaps,maxBrowserGapMs:Math.round(maxGap*10000)/10,scheduledChunks:lastPlayed-firstPlayed+1,pageErrors:errors}
  console.error(`audio-continuity-smoke: clock error ${report.serverClockErrorMs} ms; ${gaps} browser gaps; ${silentFrames} silent PCM frames`)
  assert.equal(silentFrames,0,'decoded PCM must not contain silent holes inside a continuous tone')
  assert.ok(report.serverClockErrorMs<120,'mixer time must not drift away from elapsed time under short stalls')
  assert.equal(gaps,0,'browser audio chunks must form a continuous timeline under short stalls')
  assert.deepEqual(errors,[])
  report.passed=true;console.log(JSON.stringify(report,null,2))
}catch(error){report.error=error.message;throw error}
finally{writeFileSync(join(directory,'verification.json'),JSON.stringify(report,null,2)+'\n');await cleanup()}
