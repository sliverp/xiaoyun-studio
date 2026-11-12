/** Exercise the visible next-step sale control against real scheduling and PCM playback. */
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import puppeteer from 'puppeteer-core'
import {createStudio} from '../server/http.mjs'
import {detectTools} from '../server/media.mjs'
import {pcmWav} from '../server/providers.mjs'
const work=resolve(process.env.MANUAL_SALE_WORK_DIR||'.data/manual-sale'),dir=await mkdtemp(join(tmpdir(),'studio-sale-ui-')),password='Manual-sale-smoke-only-2026',played=[],actions=[],errors=[]
await mkdir(work,{recursive:true})
const pcm=Buffer.alloc(48000*8*4)
for(let n=0;n<48000*8;n++){const sample=Math.round(Math.sin(n*2*Math.PI*440/48000)*2000);pcm.writeInt16LE(sample,n*4);pcm.writeInt16LE(sample,n*4+2)}
const audio=join(dir,'speech.wav');await writeFile(audio,pcmWav(pcm,48000,2))
const app=await createStudio({dataDir:join(dir,'server'),port:0,password,env:{},providerFactory:()=>({status:()=>({demo:false,modelConfigured:true}),redact:e=>e.message,generate:async messages=>{const p=JSON.parse(messages[1].content);return JSON.stringify({speech:'介绍当前页的具体能力。',navigation:'stay'})},synthesize:async()=>audio})})
// A built-in image stands in for the configured entry image in this isolated fixture.
app.store.update({bgm:{asset:''},output:{width:640,height:360,fps:5},program:{opening:false,closing:false,enabled:{source:true,sale:true,comment:false,engagement:false,lottery:false}},sale:{enabled:true,startAt:Date.now()+86400000,endAt:Date.now()+90000000,link:'https://example.test/sale',qrUrl:'/assets/builtin/avatar/rest.png',durationSeconds:1800,announcement:'手动秒杀提醒，入口展示{{minutes}}分钟。'}})
app.events.on('event',e=>{if(e.type==='speech')played.push(e.payload)})
const wait=async fn=>{const end=Date.now()+20000;while(!fn()){if(Date.now()>end)throw Error('Timed out waiting for sale UI');await new Promise(r=>setTimeout(r,25))}}
let browser
try{
 browser=await puppeteer.launch({executablePath:detectTools().chromium.path,headless:true,args:['--mute-audio',...(process.env.CHROMIUM_NO_SANDBOX==='1'?['--no-sandbox']:[])]})
 const page=await browser.newPage();await page.setViewport({width:1440,height:1000});await page.evaluateOnNewDocument(()=>localStorage.setItem('xiaoyun-local-sound','muted'))
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('/api/action')&&r.postData())actions.push(JSON.parse(r.postData()).action)})
 await page.goto(app.baseUrl);await page.type('#login-password',password);await page.click('#login-form button');await page.waitForSelector('#open-current-project',{visible:true});await page.click('#open-current-project');await page.waitForSelector('#live-sale-insert',{visible:true});assert.equal(await page.$eval('#live-sale-insert',e=>e.disabled),true)
 await app.director.start();await wait(()=>app.director.stage==='source'&&app.director.currentSpeech&&app.director.status().production.ready>=1);await page.waitForFunction(()=>!document.querySelector('#live-sale-insert').disabled)
 const speech=app.director.currentSpeech.id,number=app.media.slide.pageNumber
 await page.click('#live-sale-insert');await page.$eval('#live-sale-insert',e=>e.click());await page.waitForFunction(()=>document.querySelector('#live-sale-insert').textContent==='秒杀已排队'&&document.querySelector('#live-sale-insert').disabled)
 assert.equal(app.director.status().sale.queued,true);assert.equal(app.director.status().sale.active,false);assert.equal(app.director.currentSpeech.id,speech);assert.equal(actions.filter(x=>x==='sale.queue').length,1);assert.match(await page.$eval('#sale-status',e=>e.textContent),/下一环节：秒杀/)
 await page.screenshot({path:join(work,'queued-desktop.png'),fullPage:true})
 await page.click('#live-sale-cancel');await wait(()=>!app.director.status().sale.queued);await page.waitForFunction(()=>!document.querySelector('#live-sale-insert').disabled);assert.equal(app.director.currentSpeech.id,speech)
 app.director.pause();await page.waitForFunction(()=>document.querySelector('#live-sale-insert').disabled&&document.querySelector('#sale-status').textContent.includes('继续 AI'))
 app.director.resume();await page.waitForFunction(()=>!document.querySelector('#live-sale-insert').disabled);await page.click('#live-sale-insert');await wait(()=>app.director.stage==='sale'&&app.director.currentSpeech?.kind==='sale')
 assert.match(app.director.currentSpeech.text,/30分钟/);assert.equal(app.media.slide.pageNumber,number);assert.deepEqual(played.slice(0,2).map(x=>x.kind),['source','sale']);assert.equal(app.director.record.sale.expiresAt-app.director.record.sale.startedAt,1800000)
 await page.waitForFunction(()=>document.querySelector('#live-sale-insert').textContent==='秒杀码展示中'&&document.querySelector('#live-sale-insert').disabled);assert.match(await page.$eval('#sale-status',e=>e.textContent),/剩余 29:|剩余 30:/);assert.equal(await page.$eval('#live-sale-cancel',e=>e.textContent),'收起秒杀码')
 await page.setViewport({width:390,height:844});await page.$eval('.manual-sale-controls',e=>e.scrollIntoView({block:'center'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.screenshot({path:join(work,'active-mobile.png')})
 await page.click('#live-sale-cancel');await wait(()=>!app.director.status().sale.active);await page.waitForFunction(()=>document.querySelector('#live-sale-cancel').hidden)
 assert.equal(app.media.outputGraph.status().running,false);assert.deepEqual(errors,[])
 console.log(JSON.stringify({passed:true,visibleOnDirectorPage:true,queuedForNextWholeTurn:true,noInterruption:true,noDuplicate:true,cancelQueued:true,pausedDisabled:true,preparedLecturePreempted:true,pagePreserved:true,qrThirtyMinutes:true,activeCountdownAndHide:true,mobileFits:true,outputNeverStarted:true}))
}finally{await browser?.close();await app.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
