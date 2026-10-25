import {createServer} from 'node:http'
import {spawn,spawnSync} from 'node:child_process'
import {mkdtempSync,readFileSync,existsSync,statSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import assert from 'node:assert/strict'
import {MediaEngine,detectTools} from '../server/media.mjs'
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const directory=mkdtempSync(join(tmpdir(),'studio-engine-real-')),tools=detectTools()
if(!tools.ready)throw new Error('Install Chromium and FFmpeg before the actual media smoke')
const ffmpeg=tools.ffmpeg.path,wave=join(directory,'voice.wav')
const generated=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=660:duration=2.2','-ar','48000','-ac','2',wave])
assert.equal(generated.status,0)
const program='<!doctype html><html><body style="margin:0;background:#e8f4ff;font-family:sans-serif"><div style="height:50px;background:#1665ce;color:white;font-size:28px;padding:12px">小云 Studio · 无界面推流验证</div><div style="margin:40px;padding:25px;background:white;border:4px solid #206fea;font-size:42px">后台 Chromium 画面 + PCM 语音 + FFmpeg</div></body></html>'
const deck='<!doctype html><html><body style="margin:0;background:#fff"><div id="counter" data-slide-count="2" data-slide-number="1">1 / 2</div><article class="slide active" style="font-size:50px">第一页：真实后台讲解</article><article class="slide" hidden style="font-size:50px">第二页：翻页确认</article><script>let n=1;function go(v){if(v<1||v>2)return false;const s=[...document.querySelectorAll(".slide")];s.forEach((x,i)=>{x.hidden=i!==v-1;x.classList.toggle("active",i===v-1)});n=v;counter.dataset.slideNumber=String(v);counter.textContent=v+" / 2";return true}window.nextSlide=()=>go(n+1);window.prevSlide=()=>go(n-1);window.studioDeck={goToSlide:go}</script></body></html>'
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.url.startsWith('/deck')?deck:program)})
server.listen(18359,'127.0.0.1');await once(server,'listening')
let receiverError='';const received=join(directory,'received.flv')
const receiver=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-listen','1','-i','rtmp://127.0.0.1:19359/live/test','-c','copy','-f','flv',received],{stdio:['ignore','ignore','pipe']});receiver.stderr.on('data',b=>receiverError+=b.toString())
const receivedClosed=once(receiver,'close')
await delay(400)
const statuses=[],engine=new MediaEngine({dataDir:directory,baseUrl:'http://127.0.0.1:18359',renderToken:'local-smoke-token',getSettings:()=>({output:{width:640,height:360,fps:10}}),onStatus:s=>statuses.push(s)})
process.once('SIGTERM',()=>{receiver.kill('SIGTERM');void engine.close().finally(()=>{server.close();process.exit(143)})})
try{
 console.error('engine-smoke: initialize owned browser')
 await engine.initialize();assert.ok(engine.getFrame()?.length>1000)
 console.error('engine-smoke: open and read HTML deck')
 await engine.openPresentation('http://127.0.0.1:18359/deck');assert.equal((await engine.readSlide()).pageNumber,1)
 console.error('engine-smoke: next and first page while composite capture runs')
 assert.equal((await engine.nextSlide()).pageNumber,2);assert.equal((await engine.firstSlide()).pageNumber,1)
 console.error('engine-smoke: simultaneous local RTMP and recording')
 await engine.startOutput({rtmpUrl:'rtmp://127.0.0.1:19359/live',streamKey:'test',record:true,width:640,height:360,fps:10,videoBitrate:'800k',audioBitrate:'96k'})
 const started=performance.now(),play=engine.playAudio(wave)
 await delay(300);engine.pauseAudio();await delay(350);engine.resumeAudio();await play
 const consumed=performance.now()-started;assert.ok(consumed>=2400,'paused PCM should not complete before audio consumption')
 await delay(1500);await engine.stopOutput();await Promise.race([receivedClosed,delay(5000)])
 const mp4=join(directory,'recordings',engine.status().output.recording?.name||engine.status().output.recordingFile||'')
 assert.ok(existsSync(mp4)&&statSync(mp4).size>2000,'MP4 recording must contain encoded frames')
 assert.ok(existsSync(received)&&statSync(received).size>2000,'local RTMP receiver must receive actual media')
 const decoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-i',mp4,'-vn','-f','s16le','-ar','16000','-ac','1','pipe:1'],{maxBuffer:16*1024*1024})
 assert.equal(decoded.status,0);let energy=0;for(let at=0;at<decoded.stdout.length;at+=2)energy+=(decoded.stdout.readInt16LE(at)/32768)**2
 const rms=Math.sqrt(energy/(decoded.stdout.length/2));assert.ok(rms>.01,'recording must contain non-silent decoded audio')
 const last=statuses.filter(s=>s.output.active).at(-1);assert.ok(last?.output.encodedFrames>10)
 console.error('engine-smoke: recover owned browser and restore current page')
 await engine.nextSlide();assert.equal((await engine.readSlide()).pageNumber,2)
 const previousBrowser=engine.browser;previousBrowser.process().kill('SIGKILL')
 const recoveryLimit=Date.now()+15000;while(Date.now()<recoveryLimit){await delay(200);if(engine.status().ready&&!engine.status().browserRecovering&&engine.status().slide.pageNumber===2&&engine.browser!==previousBrowser)break}
 assert.equal(engine.status().ready,true);assert.equal(engine.status().slide.pageNumber,2);assert.notEqual(engine.browser,previousBrowser)
 const result={browserRecoveryPreservedPage:true,passed:true,artifactDirectory:directory,actualRtmpReceivedBytes:statSync(received).size,mp4Bytes:statSync(mp4).size,decodedAudioRms:rms,playbackWithPauseMs:Math.round(consumed),encoderFrames:last.output.encodedFrames,captureFps:last.captureFps}
 writeFileSync(join(directory,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2))
}catch(error){console.error('Real smoke failed:',error.message);console.error('Encoder:',JSON.stringify(engine.status().output));console.error('Receiver:',receiverError.slice(-1200));throw error}
finally{await engine.close();receiver.kill('SIGTERM');server.close()}
