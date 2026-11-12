/** Two-tab owned browser, restored Studio login, scoped import and truthful next steps. Offline fixtures only. */
import assert from 'node:assert/strict'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import puppeteer from 'puppeteer-core'
import {createStudio} from '../server/http.mjs'
import {PlatformChatCollector} from '../server/platform-chat.mjs'
import {createLocalBrowserHelper} from './local-browser-helper.mjs'
import {detectTools} from '../server/media.mjs'
const directory=await mkdtemp(join(tmpdir(),'studio-edge-workspace-')),owned=[],errors=[]
const fixture=`<!doctype html><meta charset="utf-8"><body><nav data-studio-authenticated="true">视频号助手</nav><iframe src="/micro/live/liveBuild" style="width:100%;height:650px;border:0"></iframe>`
const liveFixture=`<!doctype html><meta charset="utf-8"><body><h1>直播设置</h1><label>直播标题<input id="title"></label><button id="start" onclick="document.getElementById('stream').hidden=false">模拟用户完成平台开播</button><div id="stream" hidden><div class="live-config-line"><span>推流地址</span><span>rtmp://stream.fixture.test/live</span><span data-clipboard-text="rtmp://stream.fixture.test/live">复制地址</span></div><div class="live-config-line"><span>推流密钥</span><span>workspace-fixture-stream</span><span data-clipboard-text="workspace-fixture-stream">复制密钥</span></div><p>1.复制上方直播码，粘贴到推流软件对应位置</p><p>3.点击【开始直播】后，即开始本账号的正式直播，可在视频号直播中进行收看</p></div>`
async function launchFixture(options){
 const browser=await puppeteer.launch(options),newPage=browser.newPage.bind(browser);owned.push(browser)
 browser.newPage=async()=>{const page=await newPage();page.on('pageerror',error=>errors.push(error.message));await page.setRequestInterception(true);page.on('request',request=>{if(request.isInterceptResolutionHandled())return;const url=new URL(request.url());if(url.hostname==='channels.weixin.qq.com')void request.respond({status:200,contentType:'text/html',body:url.pathname==='/micro/live/liveBuild'?liveFixture:fixture});else void request.continue()});return page};return browser
}
let fixtureOutput={running:false,active:false,state:'stopped',platforms:[]}
const fakeMedia=()=>({async initialize(){},async openPresentation(){},async readSlide(){return {pageNumber:1,pageCount:1,pageKey:'fixture',text:'测试',title:'测试',notes:''}},setBgm(){},stopAudio(){},getFrame(){return null},getSlideFrame(){return null},status:()=>({ready:false,slide:{},output:fixtureOutput}),async close(){}})
const app=await createStudio({root:resolve(import.meta.dirname,'..'),dataDir:join(directory,'server'),port:0,password:'Edge-workspace-fixture-2026',env:{},mediaFactory:fakeMedia,providerFactory:()=>({status:()=>({demo:true})}),platformCollectorFactory:options=>new PlatformChatCollector({...options,launch:launchFixture})})
let helper,studio,source
try{
 const login=await fetch(app.baseUrl+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'Edge-workspace-fixture-2026'})}),cookie=login.headers.get('set-cookie').split(';')[0]
 const api=async(path,value)=>{const r=await fetch(app.baseUrl+path,{method:value?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json'},body:value?JSON.stringify(value):undefined});assert.ok(r.ok,'fixture API '+path);return r.json()}
 const connection=(await api('/api/platforms',{platform:'wechat',name:'Edge 测试连接'})).connection,grant=await api('/api/platforms/'+connection.id+'/local-workspace',{browser:'edge'})
 const helperOptions={servers:[app.baseUrl],port:0,dataDir:join(directory,'helper'),headless:true,launch:launchFixture,browserPaths:{edge:detectTools().chromium.path}}
 helper=await createLocalBrowserHelper(helperOptions)
 const {id,workspace}=await helper.pair({serverUrl:app.baseUrl,token:grant.token,workspaceTicket:grant.workspaceTicket,browser:'edge',intent:'open'},{seed:{version:1,platform:'wechat',entryUrl:'https://channels.weixin.qq.com/platform/live/home',userAgent:'Workspace-fixture',cookies:[{name:'fixture_login',value:'owned-fixture',domain:'channels.weixin.qq.com',path:'/',httpOnly:true,secure:true}],origins:[]}})
 assert.equal(workspace,true);assert.equal((await helper.status(id)).browser,'edge')
 const browser=owned[0],pages=await browser.pages();assert.equal(pages.length,2,'exactly Studio and official platform tabs')
 studio=pages.find(page=>page.url().startsWith(app.baseUrl));source=pages.find(page=>page.url().startsWith('https://channels.weixin.qq.com/'));assert.ok(studio&&source)
 await studio.waitForSelector(`[data-connection="${connection.id}"]`,{visible:true});assert.equal(await studio.evaluate(async()=> (await(await fetch('/api/session')).json()).authenticated),true)
 assert.equal(await studio.$eval('#section-connections-platforms',node=>!node.hidden),true)
 await studio.waitForFunction(()=>document.body.innerText.includes('本机已登录，请继续开播设置'),{polling:100})
 assert.equal(app.media.status().output.running,false)
 await source.waitForSelector('#xiaoyun-workspace-dock');const live=await(await source.waitForSelector('iframe')).contentFrame();await live.type('#title','测试直播标题');await live.click('#start')
 await studio.waitForFunction(()=>document.body.innerText.includes('推流信息，等待同步'),{timeout:15000,polling:100})
 const syncDock=async()=>{const point=await source.$eval('#xiaoyun-workspace-dock',node=>{const r=node.shadowRoot.getElementById('sync').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}});await source.mouse.click(point.x,point.y)}
 await syncDock();await studio.waitForFunction(()=>document.body.innerText.includes('准备完成，可以开始推流'),{timeout:30000,polling:100})
 await source.waitForFunction(()=>!document.querySelector('#xiaoyun-workspace-dock').shadowRoot.getElementById('sync').disabled,{polling:100})
 assert.equal(app.store.platformSecret(connection.id),'workspace-fixture-stream');assert.equal(app.store.get().platforms[0].rtmpUrl,'rtmp://stream.fixture.test/live');assert.equal(app.media.status().output.running,false,'sync must never start a stream')
 assert.ok(!JSON.stringify(app.snapshot()).includes('workspace-fixture-stream'));assert.ok(!JSON.stringify(app.snapshot()).includes('owned-fixture'))
 const firstVerified=app.platforms.status().connections[0].preparation.serverVerifiedAt
 await helper.sync(id);assert.ok(app.platforms.status().connections[0].preparation.serverVerifiedAt>=firstVerified,'repeat sync uses a fresh limited grant')
 // Media events can arrive before an older platform snapshot. Both must show the same output action.
 const stalePlatforms=structuredClone(app.platforms.status());stalePlatforms.connections[0].name='旧状态快照测试'
 fixtureOutput={running:true,active:true,state:'streaming',platforms:[{id:connection.id,active:true,state:'streaming'}]};app.events.publish('media',app.media.status())
 const card=`[data-connection="${connection.id}"]`
 await studio.waitForSelector(card+' [data-platform-action="output.platform.stop"]',{visible:true})
 app.events.publish('platforms',stalePlatforms);await studio.waitForFunction(selector=>document.querySelector(selector+' h3')?.textContent==='旧状态快照测试',{},card)
 assert.equal(await studio.$eval(card+' .video-setup-summary>strong',node=>node.textContent),'正在推流')
 assert.equal(await studio.$(card+' [data-platform-action="output.platform.start"]'),null,'a stale setup snapshot must never offer a duplicate start')
 assert.ok(await studio.$(card+' .video-chat-status'),'chat collection has its own visible status')
 fixtureOutput={running:false,active:false,state:'error',platforms:[{id:connection.id,active:false,state:'error',error:'fixture previous EOF <details>'}]};app.events.publish('media',app.media.status());app.events.publish('platforms',app.platforms.status())
 await studio.waitForSelector(card+' .platform-card-error',{visible:true});const staleError=structuredClone(app.platforms.status())
 fixtureOutput={running:false,active:false,state:'stopped',platforms:[{id:connection.id,active:false,state:'stopped',error:'fixture previous EOF <details>'}]};app.events.publish('media',app.media.status());app.events.publish('platforms',staleError)
 await studio.waitForSelector(card+' [data-platform-action="output.platform.start"]',{visible:true})
 assert.equal(await studio.$(card+' .platform-card-error'),null,'stopped errors must no longer look like current faults, even after a stale platform event')
 assert.equal(await studio.$eval(card+' .platform-previous-error',node=>node.open),false)
 assert.match(await studio.$eval(card+' .platform-previous-error p',node=>node.textContent),/fixture previous EOF <details>/)
 const loginExpired=structuredClone(app.platforms.status());Object.assign(loginExpired.connections[0].chat,{state:'login-required',loginRequired:true,label:'后台登录已失效'});app.events.publish('platforms',loginExpired)
 await studio.waitForFunction(selector=>document.querySelector(selector+' .video-chat-status p')?.textContent.includes('不影响推流'),{},card)
 assert.ok(await studio.$(card+' [data-platform-action="output.platform.start"]'),'expired chat login must not block the push action')
 await studio.setViewport({width:390,height:844});assert.ok(await studio.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await studio.setViewport({width:1440,height:1050});await studio.screenshot({path:join(directory,'workspace-ready.png'),fullPage:true})
 await helper.close({keepBrowsers:true});helper=await createLocalBrowserHelper(helperOptions)
 const html=await(await fetch(helper.baseUrl+'/')).text(),nonce=/<meta name="local-token" content="([a-f0-9]+)">/.exec(html)[1]
 const reopen=await fetch(helper.baseUrl+'/api/open',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':nonce},body:JSON.stringify({id})});assert.equal(reopen.status,200);assert.equal((await reopen.json()).ok,true)
 assert.equal((await helper.status(id)).needsPair,false,'owned Studio login survives helper restart')
 // Use the reattached controller to exercise a fresh binding, including the existing platform dock.
 const portFile=await import('node:fs/promises').then(fs=>fs.readFile(join(directory,'helper',id+'-edge','DevToolsActivePort'),'utf8')),inspection=await puppeteer.connect({browserURL:'http://127.0.0.1:'+portFile.split('\n')[0],defaultViewport:null})
 const restored=(await inspection.pages()).find(page=>page.url().startsWith(app.baseUrl));await restored.evaluate(id=>window.__xiaoyunLocalWorkspace({connectionId:id,action:'open'}),connection.id);await helper.sync(id);assert.equal((await inspection.pages()).length,2);inspection.disconnect()
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({passed:true,artifactDirectory:directory,fixtureOnly:true,twoTabs:true,restoredStudioLogin:true,currentSceneAndConnection:true,edgeSelected:true,truthfulThreeStepStatus:true,scopedCookieAndStreamInfoSync:true,syncNeverStartsBroadcast:true,repeatSync:true,mediaAndPlatformEventRace:true,visibleChatStatus:true,helperRestartPreservesWorkspace:true,mobileNoOverflow:true,pageErrors:errors,actualBroadcastStarted:false},null,2))
}catch(error){await studio?.screenshot({path:join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error('Workspace fixture diagnostics: '+directory);throw error}
finally{await helper?.close();await app.close()}
