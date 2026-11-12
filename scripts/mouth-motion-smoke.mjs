/** Compare rendered mouth motion at broadcast size, independent of voice volume, including a no-navigation hot handoff. */
import assert from 'node:assert/strict'
import {readFile,mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import puppeteer from 'puppeteer-core'
import {createStudio} from '../server/http.mjs'
import {detectTools} from '../server/media.mjs'
const dir=await mkdtemp(join(tmpdir(),'studio-mouth-')),work=resolve(process.env.MOUTH_MOTION_WORK_DIR||'.data/mouth-motion'),baseline=await readFile(process.env.BASELINE_PROGRAM_FILE||'.data/mouth-motion/before/program.mjs','utf8'),errors=[]
await mkdir(work,{recursive:true})
const app=await createStudio({dataDir:dir,host:'127.0.0.1',port:0,password:'Mouth-motion-smoke-only-2026',env:{},mediaFactory:options=>({options,initialize:async()=>{},getFrame:()=>null,getSlideFrame:()=>null,setBgm(){},stopAudio(){},status:()=>({ready:false,slide:{},output:{running:false,active:false}}),close:async()=>{}}),providerFactory:()=>({status:()=>({demo:true})})})
let browser,useBaseline=true,blockPoll=false,fixture={scene:{title:'测试',subtitle:'测试',layout:{mode:'standard',showCaptions:false,showCommunity:false}},avatarState:'explain',speaking:true,audio:{voiceRms:.03},slide:{revision:1}}
try{
 const args=['--mute-audio','--disable-dev-shm-usage'];if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox');browser=await puppeteer.launch({executablePath:detectTools().chromium.path,headless:true,args});const page=await browser.newPage();await page.setViewport({width:1280,height:720});await page.setExtraHTTPHeaders({'X-Render-Token':app.media.options.renderToken});page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true)
 page.on('request',r=>{const path=new URL(r.url()).pathname;if(path==='/internal/program'){if(blockPoll)return void r.abort();return void r.respond({status:200,contentType:'application/json',body:JSON.stringify(fixture)})}if(path==='/program.mjs'&&useBaseline)return void r.respond({status:200,contentType:'text/javascript',body:baseline});void r.continue()})
 await page.evaluateOnNewDocument(()=>{window.__mouthTestNow=1000;performance.now=()=>window.__mouthTestNow;window.requestAnimationFrame=fn=>{window.__mouthTestFrame=fn;return 1};window.cancelAnimationFrame=()=>{window.__mouthTestFrame=null}});await page.goto(app.baseUrl+'/program',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__studioProgram?.ready);await new Promise(r=>setTimeout(r,250))
 const fixtureFor=(rms,speaking=true,bgm=0)=>({...fixture,speaking,audio:{voiceRms:rms,bgmRms:bgm,rms:Math.max(rms,bgm)}});
 const level=async(rms,speaking=true,bgm=0,offset=180)=>{fixture=fixtureFor(rms,speaking,bgm);return page.evaluate(({value,offset})=>{window.__mouthTestNow+=1000;window.__studioProgram.update({...value,speaking:false});window.__studioProgram.update(value);window.__mouthTestNow+=offset;for(let n=0;n<20;n++)window.__mouthTestFrame(window.__mouthTestNow);const e=document.getElementById('mouth-open');return{height:e.getBoundingClientRect().height,opacity:Number(e.getAttribute('opacity')),transform:e.getAttribute('transform')}} ,{value:fixture,offset})}
 const before={};for(const rms of [.01,.03,.07])before[rms]=await level(rms);await level(.03);await(await page.$('.avatar-card')).screenshot({path:join(work,'before.png')})
 useBaseline=false;await page.evaluate(async()=>{if(window.__studioProgram?.dispose)window.__studioProgram.dispose();else dispatchEvent(new Event('pagehide'));await import('/program.mjs?mouth-motion-smoke=large')});await page.waitForFunction(()=>window.__studioProgram?.version==='avatar-motion-1')
 const after={};for(const rms of [0,.01,.03,.07,.9])after[rms]=await level(rms);assert.ok(after[.03].height>before[.03].height*3);assert.equal(after[0].transform,after[.9].transform);assert.ok(after[.03].height>7 && after[.03].height<10)
 await level(.03);await(await page.$('.avatar-card')).screenshot({path:join(work,'after.png')})
 assert.equal((await level(.1,false,.8)).opacity,0);assert.equal(await page.$eval('#mouth-closed',e=>e.getAttribute('opacity')),'1');
 assert.equal((await level(.03,true,0,0)).opacity,0);assert.equal((await level(.03,true,0,180)).opacity,1);assert.equal((await level(.03,true,0,360)).opacity,0);
 await level(.03);await page.evaluate(()=>{window.__mouthTestNow+=700;window.__mouthTestFrame(window.__mouthTestNow)});assert.equal(await page.$eval('#mouth-open',e=>e.getAttribute('opacity')),'0');

 assert.equal(await page.evaluate(()=>performance.getEntriesByType('navigation').length),1);assert.deepEqual(errors,[]);assert.equal(app.media.status().output.running,false)
 const result={passed:true,renderedAt:'1280x720',beforeHeights:before,afterHeights:after,normalSpeechHeightGain:Math.round(after[.03].height/before[.03].height*10)/10,fullOpeningIndependentOfVolume:true,visibleOpenAndCloseCycle:true,speakingFalseClosesMouth:true,staleMeterClosesMouth:true,hotHandoffWithoutNavigation:true,noAiOrOutputStarted:true};await writeFile(join(work,'ui-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await browser?.close();await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
