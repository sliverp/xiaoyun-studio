/** Real HTML/PDF preview navigation must never send on-air controls or change the saved source. */
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createStudio} from '../server/http.mjs'
import {detectTools} from '../server/media.mjs'
import {launchLocalBrowser} from './local-browser-launch.mjs'
import {closePlatformBrowser} from '../server/platform-browser.mjs'

const directory=await mkdtemp(join(tmpdir(),'studio-presentation-preview-')),errors=[],actions=[]
const image=await readFile(new URL('../public/builtin/avatar/greeting.png',import.meta.url))
let slide={pageNumber:1,pageCount:5,title:'正在播出的第一页',pageKey:'fixture|1'},cycle=2
const mediaFactory=()=>({async initialize(){},setBgm(){},getFrame:()=>image,getSlideFrame:()=>image,status:()=>({ready:true,slide,output:{running:false,active:false,platforms:[]}}),async close(){}})
const directorFactory=()=>({status:()=>({running:true,stage:'source',stageLabel:'内容讲解',page:{...slide,turns:2},cycle,history:[{from:'advancing',to:'source',at:Date.now()-10000}],comments:{recent:[]}}),programState:()=>({}),settingsChanged(){},async close(){}})
const app=await createStudio({root:resolve(import.meta.dirname,'..'),dataDir:join(directory,'server'),port:0,password:'Presentation-preview-fixture-2026',env:{},mediaFactory,directorFactory,providerFactory:()=>({status:()=>({demo:true})})})
app.store.update({presentation:{url:'/assets/builtin/slides/index.html',autoAdvance:true,loop:true}})
let browser,page
try{
 const login=await fetch(app.baseUrl+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'Presentation-preview-fixture-2026'})}),cookie=login.headers.get('set-cookie').split(';')[0]
 const args=[];if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
 browser=await launchLocalBrowser({executablePath:detectTools().chromium.path,userDataDir:join(directory,'controller'),headless:true,args})
 await browser.defaultBrowserContext().setCookie({name:'studio_session',value:cookie.split('=')[1],url:app.baseUrl,httpOnly:true})
 page=await browser.newPage();await page.setViewport({width:1440,height:1000});page.on('pageerror',e=>errors.push(e.message))
 page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/action')actions.push(r.postData())})
 await page.goto(app.baseUrl);await page.waitForSelector('#open-current-project',{visible:true});await page.click('#open-current-project');await page.click('#nav-visuals')
 await page.waitForSelector('#content-slide-preview:not([hidden])',{visible:true})
 assert.equal(await page.$eval('#content-page-count',n=>n.textContent),'共 5 页')
 assert.match(await page.$eval('#content-loop-status',n=>n.textContent),/第 2 轮/)
 await page.click('#content-preview-browse');await page.waitForSelector('#content-preview-next:not([disabled])')
 await page.select('#content-preview-page','5');await page.waitForFunction(()=>document.getElementById('content-preview-frame').contentDocument.querySelector('#counter').dataset.slideNumber==='5')
 assert.equal(slide.pageNumber,1,'preview navigation never changes the on-air page')
 slide={...slide,pageNumber:2,pageKey:'fixture|2'};app.events.publish('state',app.snapshot())
 await page.waitForFunction(()=>document.getElementById('content-live-position').textContent.includes('第 2 / 5 页'))
 assert.equal(await page.$eval('#content-preview-frame',f=>f.contentDocument.querySelector('#counter').dataset.slideNumber),'5','live updates cannot reset the independent preview')
 await page.setViewport({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'preview controls fit mobile')
 await page.setViewport({width:1440,height:1000});await page.click('#content-preview-live');assert.equal(await page.$eval('#content-preview-frame',f=>f.getAttribute('src')),null)
 // A separate PDF viewer uses the same private asset session and local-only page controls.
 const printer=await browser.newPage();await printer.setContent('<style>.page{page-break-after:always}</style><div class="page">PDF preview page one</div><div>PDF preview page two</div>')
 const pdf=await printer.pdf({format:'A4'});await printer.close();const asset=app.assets.upload(pdf,{filename:'preview-fixture.pdf',type:'pdf'})
 app.store.update({presentation:{url:asset.url}});slide={pageNumber:1,pageCount:2,title:'PDF 第 1 页',pageKey:'pdf-fixture|1'};app.events.publish('state',app.snapshot())
 await page.waitForFunction(()=>document.getElementById('content-page-count').textContent==='共 2 页')
 await page.click('#content-preview-browse');await page.waitForSelector('#content-preview-next:not([disabled])',{timeout:20000});await page.click('#content-preview-next')
 await page.waitForFunction(()=>document.getElementById('content-preview-frame').contentDocument.querySelector('#counter').dataset.slideNumber==='2')
 assert.equal(slide.pageNumber,1)
 await page.$eval('[data-config="presentation.url"]',n=>{n.value='/assets/builtin/slides/index.html';n.dispatchEvent(new Event('input',{bubbles:true}))})
 assert.equal(await page.$eval('#content-preview-draft',n=>n.hidden),false)
 assert.equal(app.store.get().presentation.url,asset.url,'preview does not save a draft or load it on air')
 await page.click('#nav-director');await page.waitForFunction(()=>!document.getElementById('content-preview-frame').getAttribute('src'))
 assert.deepEqual(actions,[]);assert.deepEqual(errors,[])
 console.log(JSON.stringify({passed:true,htmlFivePages:true,independentHtmlNavigation:true,liveUpdatesPreservePreviewPage:true,independentPdfNavigation:true,visibleAutoAdvanceAndLoop:true,draftsNotLoadedOrSaved:true,mobileNoOverflow:true,noLiveActionsSent:true,pageErrors:errors}))
}catch(e){await page?.screenshot({path:join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error('Preview fixture artifacts: '+directory);throw e}
finally{await closePlatformBrowser(browser);await app.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
