/** Exercise editable single/batch test comments against an isolated server, without invoking AI or output. */
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import puppeteer from 'puppeteer-core'
import {createStudio} from '../server/http.mjs'
import {detectTools} from '../server/media.mjs'
const dir=await mkdtemp(join(tmpdir(),'studio-test-comments-')),work=resolve(process.env.TEST_COMMENT_WORK_DIR||'.data/editable-comment'),errors=[],requests=[]
await mkdir(work,{recursive:true})
const app=await createStudio({dataDir:dir,host:'127.0.0.1',port:0,password:'Test-comment-ui-only-2026',env:{},mediaFactory:()=>({initialize:async()=>{},getFrame:()=>null,getSlideFrame:()=>null,setBgm(){},stopAudio(){},pauseAudio(){},resumeAudio(){},status:()=>({ready:true,slide:{pageNumber:1,pageCount:1},output:{running:false,active:false,state:'stopped'}}),close:async()=>{}}),providerFactory:()=>({status:()=>({demo:true,modelConfigured:false})})})
let browser,failNext=false,holdNext=false,release
try{
 const args=['--mute-audio','--disable-dev-shm-usage'];if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
 browser=await puppeteer.launch({executablePath:detectTools().chromium.path,headless:true,args});const page=await browser.newPage();await page.setViewport({width:1440,height:1100});page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true)
 page.on('request',r=>{if(r.url().endsWith('/api/comments')&&r.method()==='POST'){requests.push({body:JSON.parse(r.postData()),scene:r.headers()['x-studio-project']});if(failNext){failNext=false;return void r.respond({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'测试发送失败，请重试'})})}if(holdNext){holdNext=false;release=()=>r.continue();return}}void r.continue()})
 const fill=async(id,value)=>page.$eval('#'+id,(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}))},value)
 const send=async()=>{const response=page.waitForResponse(r=>r.url().endsWith('/api/comments')&&r.request().method()==='POST');await page.click('#test-comment-send');return (await response).status()}
 await page.goto(app.baseUrl,{waitUntil:'domcontentloaded'});await page.type('#login-password','Test-comment-ui-only-2026');await page.click('#login-form button[type="submit"]');await page.waitForSelector('#open-current-project',{visible:true});await page.click('#open-current-project');await page.click('#demo-comment');await page.waitForSelector('#test-comment-form',{visible:true});assert.equal(requests.length,0);assert.equal(await page.$eval('#test-comment-send',e=>e.disabled),true)
 await fill('test-comment-nickname','李雷');await fill('test-comment-content','这个方案能用吗？')
 for(let n=0;n<3;n++){app.events.publish('state',app.snapshot());await new Promise(r=>setTimeout(r,80))}
 assert.equal(await page.$eval('#test-comment-nickname',e=>e.value),'李雷');assert.equal(await page.$eval('#test-comment-content',e=>e.value),'这个方案能用吗？');assert.equal(await page.$eval('#save-workspace-settings',e=>e.disabled),true)
 assert.equal(await send(),200);await page.waitForFunction(()=>document.querySelector('#test-comment-status').textContent.includes('已发送1条'))
 assert.equal(app.director.comments.at(-1).nickname,'李雷');assert.equal(app.director.comments.at(-1).content,'这个方案能用吗？');assert.equal(requests.at(-1).scene,app.projects.activeId)
 await fill('test-comment-content','失败后保留这段内容');failNext=true;assert.equal(await send(),503);await page.waitForFunction(()=>!document.querySelector('#test-comment-error').hidden);assert.match(await page.$eval('#test-comment-error',e=>e.textContent),/请重试/);assert.equal(await page.$eval('#test-comment-content',e=>e.value),'失败后保留这段内容');assert.equal(await send(),200)
 await page.waitForFunction(()=>!document.querySelector('#test-comment-send').disabled);await fill('test-comment-content','连续点击只发送一次');const count=requests.length;holdNext=true;await page.$eval('#test-comment-form',f=>{f.requestSubmit();f.requestSubmit()});await page.waitForFunction(()=>document.querySelector('#test-comment-send').textContent==='正在发送…');while(!release)await new Promise(r=>setTimeout(r,10));assert.equal(requests.length,count+1);assert.equal(await page.$eval('#test-comment-send',e=>e.disabled),true);release();await page.waitForFunction(()=>!document.querySelector('#test-comment-send').disabled)
 await page.click('#test-comment-batch');await fill('test-comment-content','小明｜开启秒杀\n\n小林｜开启秒杀\n你用什么模型？');assert.equal(await send(),200);assert.deepEqual(requests.at(-1).body.comments.map(c=>[c.nickname,c.content]),[['小明','开启秒杀'],['小林','开启秒杀'],['李雷','你用什么模型？']])
 await page.waitForFunction(()=>!document.querySelector('#test-comment-send').disabled);await fill('test-comment-content',Array.from({length:1000},(_,i)=>'观众'+i+'｜开启秒杀').join('\n'));assert.equal(await send(),200);assert.equal(requests.at(-1).body.comments.length,1000);assert.equal(new Set(requests.at(-1).body.comments.map(c=>c.id)).size,1000);assert.equal(app.director.comments.length,100);assert.equal(app.director.comments[0].nickname,'观众900');assert.equal(app.director.comments.at(-1).nickname,'观众999')
 await page.waitForFunction(()=>!document.querySelector('#test-comment-send').disabled);await fill('test-comment-content',Array(1001).fill('开启秒杀').join('\n'));assert.equal(await page.$eval('#test-comment-send',e=>e.disabled),true);assert.match(await page.$eval('#test-comment-error',e=>e.textContent),/最多发送1000条/)
 await fill('test-comment-content','字'.repeat(501));assert.equal(await page.$eval('#test-comment-send',e=>e.disabled),true);assert.match(await page.$eval('#test-comment-error',e=>e.textContent),/最多500字/)
 await fill('test-comment-content','小明｜开启秒杀\n小林｜你用的是什么模型？');await page.click('#test-comment-cancel');await page.click('#demo-comment');assert.match(await page.$eval('#test-comment-content',e=>e.value),/小明/)
 await(await page.$('.comment-panel')).screenshot({path:join(work,'composer-desktop.png')})
 for(const width of [1024,390]){await page.setViewport({width,height:1000});const rect=await page.$eval('#test-comment-form',e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,width:innerWidth}});assert.ok(rect.left>=0&&rect.right<=rect.width+1,JSON.stringify(rect))}
 await(await page.$('.comment-panel')).screenshot({path:join(work,'composer-mobile.png')});await page.focus('#test-comment-content');await page.keyboard.press('Escape');assert.equal(await page.$eval('#test-comment-form',e=>e.hidden),true);assert.equal(await page.evaluate(()=>document.activeElement.id),'demo-comment')
 assert.equal(app.director.running,false);assert.equal(app.media.status().output.running,false);assert.deepEqual(errors,[])
 const result={passed:true,singleNicknameAndTextEditable:true,batch1000:true,latest100Preserved:true,draftSurvivesLiveRefresh:true,retryPreservesDraft:true,doubleSubmitBlocked:true,projectScoped:true,responsive:true,aiAndOutputNeverStarted:true};await writeFile(join(work,'ui-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await browser?.close();await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
