/** Verify visible gesture changes during a continuous lecture and preserve the current pose while replacements load. */
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import puppeteer from 'puppeteer-core'
import {createStudio} from '../server/http.mjs'
import {detectTools} from '../server/media.mjs'
const dir=await mkdtemp(join(tmpdir(),'studio-gestures-')),work=resolve(process.env.AVATAR_MOTION_WORK_DIR||'.data/avatar-motion'),errors=[]
await mkdir(work,{recursive:true})
const app=await createStudio({dataDir:dir,host:'127.0.0.1',port:0,password:'Avatar-motion-smoke-only-2026',env:{},mediaFactory:options=>({options,initialize:async()=>{},getFrame:()=>null,getSlideFrame:()=>null,setBgm(){},stopAudio(){},status:()=>({ready:false,slide:{},output:{running:false,active:false}}),close:async()=>{}}),providerFactory:()=>({status:()=>({demo:true})})})
let browser,fixture={scene:{title:'测试',layout:{mode:'standard',showCaptions:false,showCommunity:false}},avatarState:'explain',speaking:true,audio:{voiceRms:.03},slide:{revision:1}},failWink=false
try{
 const args=['--mute-audio','--disable-dev-shm-usage'];if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
 browser=await puppeteer.launch({executablePath:detectTools().chromium.path,headless:true,args});let page=await browser.newPage();await page.setViewport({width:1280,height:720});await page.setExtraHTTPHeaders({'X-Render-Token':app.media.options.renderToken});page.on('pageerror',e=>errors.push(e.message));await page.setCacheEnabled(false);await page.setRequestInterception(true)
 let releaseWink
 page.on('request',r=>{const path=new URL(r.url()).pathname;if(path==='/internal/program')return void r.respond({status:200,contentType:'application/json',body:JSON.stringify(fixture)});if(path==='/internal/avatar/wink.png'&&failWink){releaseWink=()=>r.respond({status:503,body:'Unavailable'});return}void r.continue()})
 await page.evaluateOnNewDocument(()=>{window.__avatarTestNow=1000;performance.now=()=>window.__avatarTestNow;window.requestAnimationFrame=fn=>{window.__avatarTestFrame=fn;return 1};window.cancelAnimationFrame=()=>{window.__avatarTestFrame=null}})
 await page.goto(app.baseUrl+'/program',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__studioProgram?.version==='avatar-motion-1',{polling:20,timeout:5000})
 const visible=()=>page.evaluate(()=>{const e=document.getElementById('avatar-image');return{pose:e.dataset.avatarPose,visible:getComputedStyle(e).visibility==='visible',mouthHidden:document.getElementById('avatar-mouth').hidden,visibleCount:[...document.querySelectorAll('#avatar-art image')].filter(i=>getComputedStyle(i).visibility==='visible').length}})
 const step=async(time,pose,kind=fixture.avatarState,speaking=fixture.speaking)=>{fixture={...fixture,avatarState:kind,speaking};await page.evaluate(({time,value})=>{window.__avatarTestNow=time;window.__studioProgram.update(value);window.__avatarTestFrame(time)},{time,value:fixture});await page.waitForFunction(p=>document.getElementById('avatar-image').dataset.avatarPose===p,{polling:20,timeout:5000},pose);const view=await visible();assert.equal(view.visibleCount,1);assert.ok(view.visible);return view}
 const lecture=[];for(const [at,pose]of [[1000,'explain'],[9100,'ponder'],[12100,'explain'],[19100,'listen'],[22100,'explain'],[29100,'wink'],[31100,'explain']]){lecture.push((await step(at,pose)).pose);if(['ponder','listen','wink'].includes(pose))await(await page.$('.avatar-card')).screenshot({path:join(work,pose+'.png')})}
 await step(32100,'happy','happy',true);await step(37200,'listen');await step(40300,'explain');await step(45300,'wink')
 await step(47000,'greeting','greeting',true);await step(54100,'rest');await step(57100,'greeting');await step(63100,'wink')
 assert.ok((await step(65000,'thinking','thinking',false)).mouthHidden);assert.ok(!(await step(71100,'ponder')).mouthHidden)
 await step(76000,'rest','explain',false);await step(86100,'listen');await step(90200,'rest');await step(98300,'ponder')
 // A fresh document must keep the current pose if its next asset is slow or unavailable.
 const originalPage=page;failWink=true;fixture={...fixture,avatarState:'explain',speaking:true};
 page=await browser.newPage();await page.setViewport({width:1280,height:720});await page.setExtraHTTPHeaders({'X-Render-Token':app.media.options.renderToken});page.on('pageerror',e=>errors.push(e.message));await page.setCacheEnabled(false);await page.setRequestInterception(true);
 page.on('request',r=>{const path=new URL(r.url()).pathname;if(path==='/internal/program')return void r.respond({status:200,contentType:'application/json',body:JSON.stringify(fixture)});if(path==='/internal/avatar/wink.png'){releaseWink=()=>r.respond({status:503,body:'Unavailable'});return}void r.continue()});
 await page.evaluateOnNewDocument(()=>{window.__avatarTestNow=99000;performance.now=()=>window.__avatarTestNow;window.requestAnimationFrame=fn=>{window.__avatarTestFrame=fn;return 1};window.cancelAnimationFrame=()=>{window.__avatarTestFrame=null}});
 await page.goto(app.baseUrl+'/program',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__studioProgram?.version==='avatar-motion-1',{polling:20,timeout:5000});
 await step(99000,'explain','explain',true);await step(126900,'explain');await page.evaluate(value=>{window.__avatarTestNow=127500;window.__studioProgram.update(value);window.__avatarTestFrame(window.__avatarTestNow)},fixture);
 assert.ok(releaseWink);const waiting=await visible();assert.equal(waiting.pose,'explain');assert.ok(waiting.visible);releaseWink();await new Promise(r=>setTimeout(r,100));assert.equal((await visible()).pose,'explain');
 assert.equal(await originalPage.evaluate(()=>performance.getEntriesByType('navigation').length),1);

 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>performance.getEntriesByType('navigation').length),1);assert.equal(app.media.status().output.running,false)
 const result={passed:true,lecturePoses:lecture,openingAndCommentGestures:true,idleAndThinkingGestures:true,pausedStopsTalking:true,loadingAndFailedPoseKeepPreviousVisible:true,noNavigationOrOutputStarted:true};await writeFile(join(work,'ui-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await browser?.close();await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
