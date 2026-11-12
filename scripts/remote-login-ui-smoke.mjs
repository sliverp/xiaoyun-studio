/** Real controller + collector Chromium, using local-only simulated login pages. No account is authenticated. */
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import puppeteer from 'puppeteer-core'
import {createStudio} from '../server/http.mjs'
import {PlatformChatCollector} from '../server/platform-chat.mjs'
import {detectTools} from '../server/media.mjs'

const directory=await mkdtemp(join(tmpdir(),'studio-remote-login-')),password='Isolated-remote-login-fixture-2026',launches=[]
const qrFixture=`<!doctype html><html lang="zh"><meta charset="utf-8"><style>body{text-align:center;font:18px sans-serif}canvas{display:block;margin:15px auto}button{font:18px sans-serif;padding:10px}</style><body class="login"><p>使用微信扫一扫登录 · 仅测试图案</p><canvas id="qr" width="220" height="220"></canvas><button id="refresh-qr" class="qrcode-refresh" onclick="document.body.dataset.refreshed='yes'">刷新二维码</button><button id="scan" onclick="parent.postMessage('fixture-scanned','https://channels.weixin.qq.com')">模拟扫码完成</button><script>const context=qr.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,220,220);context.fillStyle='#111';for(let y=0;y<22;y++)for(let x=0;x<22;x++)if((x*7+y*3)%5<2)context.fillRect(x*10,y*10,10,10)</script></body></html>`
const fixture=`<!doctype html><html lang="zh"><meta charset="utf-8"><style>body{font-family:sans-serif;padding:40px;background:#f5f6fa;color:#26314b}h1{text-align:center}button{font:18px sans-serif;padding:15px;cursor:pointer}.login{text-align:center}.account-list{width:700px;height:420px;overflow:auto;margin:40px auto;border:1px solid #aaa}.account-card{display:block;width:100%;height:70px;text-align:left;border:0;border-bottom:1px solid #ddd;background:white}</style><body><div id="content" class="login"><h1>登录视频号助手</h1><iframe title="模拟微信二维码" src="https://open.weixin.qq.com/connect/qrconnect" width="800" height="400" style="border:5px solid #ccd"></iframe></div><script>
let started=0;function accounts(){content.innerHTML='<h1>请选择视频号身份</h1><div id="accounts" class="account-list" role="listbox">'+Array.from({length:10},(_,i)=>'<button role="option" class="account-card" id="account-'+i+'" onclick="choose('+i+')">'+(i===9?'子用户 · 测试运营同学':'测试视频号 '+i)+'</button>').join('')+'</div>'}
function home(){content.innerHTML='<h1>视频号后台首页</h1><p>尚未进入直播管理</p><button id="switch" onclick="accounts()">切换账号</button>'}
function setup(){content.innerHTML='<h1>直播管理</h1><p>尚未开播</p><label>直播标题<input id="live-title" value="旧标题"></label><button id="cover-button" onclick="uploadCover()">上传封面</button><input id="cover-file" type="file" accept="image/*" hidden onchange="coverChanged(this)"><label>裁剪缩放<input type="range" id="crop-range" min="0" max="100" value="20"></label><button id="start" onclick="begin()">开始直播</button><button id="switch" onclick="accounts()">切换账号</button>'}
function uploadCover(){document.getElementById('cover-file').click()}
function coverChanged(input){document.body.dataset.cover=input.files[0]?.name||''}
function begin(){if(!document.getElementById('live-title').value||!document.body.dataset.cover)return;started++;document.body.dataset.started='yes';content.innerHTML='<h1>直播推流信息</h1><label>服务器地址<input readonly value="rtmp://stream.fixture.test/live"></label><label>推流码<input readonly value="fixture-user-started-stream"></label><button id="switch" onclick="accounts()">切换账号</button>'}
function choose(i){document.body.dataset.selected=String(i);sessionStorage.setItem('fixture-account',String(i));history.replaceState({},'', '/platform');home()}
addEventListener('message',event=>{if(event.origin==='https://open.weixin.qq.com'&&event.data==='fixture-scanned')accounts()})
if(sessionStorage.getItem('fixture-account')!==null){if(location.pathname==='/platform/live/liveBuild')setup();else home()}
</script></body></html>`
async function launchFixture(options){
 launches.push(options.userDataDir)
 const browser=await puppeteer.launch(options),newPage=browser.newPage.bind(browser)
 browser.newPage=async()=>{const page=await newPage();await page.setRequestInterception(true);page.on('request',request=>{if(request.isInterceptResolutionHandled())return;void request.respond({status:200,contentType:'text/html; charset=utf-8',body:new URL(request.url()).hostname==='open.weixin.qq.com'?qrFixture:fixture})});return page}
 return browser
}
const fakeMedia=()=>({async initialize(){},async openPresentation(){},async readSlide(){return {pageNumber:1,pageCount:1,pageKey:'fixture',text:'测试',title:'测试',notes:''}},setBgm(){},getFrame(){return null},getSlideFrame(){return null},stopAudio(){},status:()=>({ready:false,slide:{},output:{running:false,active:false,state:'stopped',platforms:[]}}),async close(){}})
const app=await createStudio({root:resolve(import.meta.dirname,'..'),dataDir:directory,port:0,password,env:{},mediaFactory:fakeMedia,providerFactory:()=>({status:()=>({demo:true})}),platformCollectorFactory:options=>new PlatformChatCollector({...options,launch:launchFixture})})
let browser,page;const errors=[],external=[]
const cleanup=async()=>{await browser?.close();await app.close()}
process.once('SIGTERM',()=>{void cleanup().finally(()=>process.exit(143))})
try{
 const args=['--mute-audio','--disable-dev-shm-usage'];if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
 browser=await puppeteer.launch({executablePath:detectTools().chromium.path,headless:true,args});page=await browser.newPage();await page.setViewport({width:1440,height:1050})
 page.on('pageerror',error=>errors.push(error.message));await page.setRequestInterception(true);page.on('request',request=>{const url=new URL(request.url());if(url.origin===app.baseUrl||['data:','blob:','about:'].includes(url.protocol))void request.continue();else{external.push(url.origin);void request.abort()}})
 const click=async selector=>{await page.$eval(selector,element=>element.scrollIntoView({block:'center',behavior:'instant'}));await page.click(selector)}
 await page.goto(app.baseUrl);await page.waitForSelector('#login-password',{visible:true});await page.type('#login-password',password);await page.click('#login-form button');await page.waitForSelector('#open-current-project',{visible:true});await page.click('#open-current-project');await page.click('#nav-connections')
 const add=async name=>{await click('#add-platform');await click('[data-platform-kind="wechat"]');await page.$eval('#platform-name',(input,name)=>input.value=name,name);await click('#platform-scan-login');await page.waitForSelector('#channels-dialog',{visible:true});await page.waitForSelector('#channels-image:not([hidden])',{timeout:20000})}
 await add('扫码账号甲')
 assert.equal(app.store.get().platforms.length,1);assert.equal(launches.length,1)
 const first=app.store.get().platforms[0],collector=app.platforms.collectors.get(first.id)
 assert.equal(collector.status().loginRequired,true);assert.match(await page.$eval('#channels-status',node=>node.textContent),/扫码|二维码/)
 const remoteClick=async(selector,frame=collector.delegate.page)=>{
  let point=await frame.$eval(selector,node=>{const rect=node.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})
  if(frame!==collector.delegate.page){const element=await frame.frameElement();try{const box=await element.boundingBox(),border=await element.evaluate(node=>({x:node.clientLeft,y:node.clientTop}));point={x:point.x+box.x+border.x,y:point.y+box.y+border.y}}finally{await element.dispose()}}
  await page.$eval('.channels-frame',(frame,point)=>{const image=frame.querySelector('img');frame.scrollTop=Math.max(0,point.y*image.clientWidth/image.naturalWidth-180)},point)
  await page.$eval('.channels-frame',frame=>frame.scrollIntoView({block:'center',behavior:'instant'}))
  const position=await page.$eval('#channels-image',(image,point)=>{const rect=image.getBoundingClientRect();return {x:rect.x+point.x*rect.width/image.naturalWidth,y:rect.y+point.y*rect.height/image.naturalHeight}},point)
  const response=page.waitForResponse(response=>response.url().endsWith('/api/action')&&response.request().postData()?.includes('platform.chat.click'))
  await page.mouse.click(position.x,position.y);assert.equal((await response).status(),200)
 }
 const qrFrame=collector.delegate.page.frames().find(frame=>frame.url().startsWith('https://open.weixin.qq.com/connect/qrconnect'));assert.ok(qrFrame)
 await collector.capture();assert.equal(collector.status().qrVisible,true)
 await remoteClick('#refresh-qr',qrFrame);assert.equal(await qrFrame.evaluate(()=>document.body.dataset.refreshed),'yes')
 await remoteClick('#scan',qrFrame);await page.waitForFunction(()=>document.querySelector('#channels-status').textContent.includes('子用户'))
 assert.equal(collector.status().accountSelectionRequired,true)
 const scroll=page.waitForResponse(response=>response.url().endsWith('/api/action')&&response.request().postData()?.includes('platform.chat.scroll'));await click('#channels-scroll-down');assert.equal((await scroll).status(),200)
 await collector.delegate.page.waitForFunction(()=>document.querySelector('#accounts').scrollTop>0)
 await remoteClick('#account-9');await collector.delegate.page.waitForFunction(()=>document.body.dataset.selected==='9')
 await page.waitForFunction(()=>document.querySelector('#channels-status').textContent.includes('尚未进入'))
 assert.equal(collector.status().accountSelectionRequired,false);assert.equal(collector.status().state,'backend-home')
 assert.equal(await collector.delegate.page.evaluate(()=>started),0)
 const connect=page.waitForResponse(response=>response.url().endsWith('/api/action')&&response.request().postData()?.includes('platform.chat.connect'));await click('#connect-channels');assert.equal((await connect).status(),200)
 await collector.delegate.page.waitForSelector('#live-title');assert.equal(new URL(collector.delegate.page.url()).pathname,'/platform/live/liveBuild');assert.equal(launches.length,1,'connecting uses the already authenticated browser')
 await remoteClick('#live-title');await page.type('#channels-input-text','中文直播标题 · 第一场');const type=page.waitForResponse(response=>response.url().endsWith('/api/action')&&response.request().postData()?.includes('platform.chat.type'));await click('#channels-send-text');assert.equal((await type).status(),200);assert.equal(await collector.delegate.page.$eval('#live-title',node=>node.value),'中文直播标题 · 第一场')
 await click('[data-channel-key="Backspace"]');await collector.delegate.page.waitForFunction(()=>document.querySelector('#live-title').value==='中文直播标题 · 第一')
 await remoteClick('#cover-button');assert.equal(collector.status().fileUploadRequested,true)
 const cover=join(directory,'cover.png');await writeFile(cover,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=','base64'))
 const uploaded=page.waitForResponse(response=>response.url().includes('/browser/upload'));await(await page.$('#channels-upload-file')).uploadFile(cover);assert.equal((await uploaded).status(),200);await collector.delegate.page.waitForFunction(()=>Boolean(document.body.dataset.cover));assert.equal(await collector.delegate.page.evaluate(()=>started),0,'typing and cover upload must not start a broadcast')
 assert.deepEqual(Buffer.from(await collector.delegate.page.$eval('#cover-file',async node=>Array.from(new Uint8Array(await node.files[0].arrayBuffer())))),await readFile(cover),'the chosen cover bytes reach the platform file input intact')
 await page.$eval('.channels-frame',frame=>{frame.scrollTop=0;frame.scrollIntoView({block:'center',behavior:'instant'})})
 const range=await collector.delegate.page.$eval('#crop-range',node=>{const r=node.getBoundingClientRect();return {from:{x:r.x+r.width*.2,y:r.y+r.height/2},to:{x:r.x+r.width*.8,y:r.y+r.height/2}}})
 const positions=await page.$eval('#channels-image',(image,range)=>{const r=image.getBoundingClientRect(),map=p=>({x:r.x+p.x*r.width/image.naturalWidth,y:r.y+p.y*r.height/image.naturalHeight});return {from:map(range.from),to:map(range.to)}},range)
 const dragged=page.waitForResponse(response=>response.url().endsWith('/api/action')&&response.request().postData()?.includes('platform.chat.drag'));await page.mouse.move(positions.from.x,positions.from.y);await page.mouse.down();await page.mouse.move(positions.to.x,positions.to.y,{steps:8});await page.mouse.up();assert.equal((await dragged).status(),200);assert.ok(Number(await collector.delegate.page.$eval('#crop-range',node=>node.value))>70)
 await remoteClick('#start');await collector.delegate.page.waitForFunction(()=>document.body.dataset.started==='yes')
 const read=page.waitForResponse(response=>response.url().includes('/browser/stream-info'));await click('#channels-read-stream');assert.equal((await read).status(),200);await page.waitForSelector('#channels-stream-info:not([hidden])');assert.equal(await page.$eval('#channels-stream-key',node=>node.value),'fixture-user-started-stream')
 const save=page.waitForResponse(response=>response.url().endsWith('/api/platforms/'+first.id)&&response.request().method()==='PUT');await click('#channels-apply-stream');assert.equal((await save).status(),200);assert.equal(app.store.platformSecret(first.id),'fixture-user-started-stream');assert.ok(!JSON.stringify(app.snapshot()).includes('fixture-user-started-stream'))
 await remoteClick('#switch');assert.equal(collector.status().accountSelectionRequired,true)
 await page.screenshot({path:join(directory,'remote-account-selection.png'),fullPage:true})
 await click('#close-channels');assert.equal(collector.status().browserOpen,true,'closing the dialog must keep collection connected')
 await add('扫码账号乙');assert.equal(app.store.get().platforms.length,2);assert.equal(new Set(launches).size,2)
 assert.equal(app.platforms.collectors.get(app.store.get().platforms[1].id).status().loginRequired,true)
 await click('#close-channels');await click(`[data-connection="${first.id}"] [data-platform-ui="edit"]`);await click('#platform-scan-login');await page.waitForSelector('#channels-image:not([hidden])');assert.equal(app.store.get().platforms.length,2,'logging in from an existing connection must not create a duplicate')
 await click('#channels-size-toggle');assert.equal(await page.$eval('.channels-frame',element=>element.classList.contains('actual-size')),true)
 await page.evaluate(()=>{window.open=()=>({opener:null,location:{replace:url=>window.__localHandoff=url},close(){}})})
 await click('#local-browser-login');await page.waitForFunction(()=>Boolean(window.__localHandoff));const handoff=new URL(await page.evaluate(()=>window.__localHandoff)),grant=JSON.parse(decodeURIComponent(handoff.hash.slice(1)));assert.equal(handoff.origin,'http://127.0.0.1:18082');assert.equal(grant.serverUrl,app.baseUrl)
 const paired=await fetch(app.baseUrl+'/api/local-login/pair',{method:'POST',headers:{Authorization:'Bearer '+grant.token}});assert.equal(paired.status,200);assert.equal((await paired.json()).connectionId,first.id)
 await page.setViewport({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
 assert.deepEqual(errors,[]);assert.deepEqual(external,[])
 const result={passed:true,artifactDirectory:directory,fixtureOnly:true,actualAccountAuthenticated:false,localLoginButtonCreatesScopedHandoff:true,directScanButton:true,autoSavedConnection:true,embeddedOfficialQrFrame:true,embeddedQrRefresh:true,remoteAccountAndSubuserSelection:true,remoteScrolling:true,connectNavigatesAuthenticatedSession:true,chineseTitleInput:true,remoteKeyboard:true,coverUpload:true,cropDrag:true,startOnlyByExplicitOperatorClick:true,pushInfoReadAndSavedPrivately:true,existingConnectionNotDuplicated:true,twoIsolatedProfiles:true,closeKeepsConnection:true,mobileNoHorizontalOverflow:true,pageErrors:errors,externalNetworkUsed:false}
 await writeFile(join(directory,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
}catch(error){await page?.screenshot({path:join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error('Remote login UI diagnostics: '+directory);throw error}
finally{await cleanup()}
