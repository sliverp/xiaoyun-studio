/** Real Chrome cookie/storage transfer through the local helper, using offline official-site fixtures. */
import assert from 'node:assert/strict'
import {mkdtemp,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import puppeteer from 'puppeteer-core'
import {createStudio} from '../server/http.mjs'
import {PlatformChatCollector} from '../server/platform-chat.mjs'
import {ChannelsCollector} from '../server/channels.mjs'
import {createLocalBrowserHelper} from './local-browser-helper.mjs'
import {CHANNEL_ENTRY,captureBrowserSession,backendSessionReady} from '../server/browser-session.mjs'
import {detectTools} from '../server/media.mjs'
const directory=await mkdtemp(join(tmpdir(),'studio-local-session-')),launches=[],diagnostics=[]
const args=['--disable-dev-shm-usage'];if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
const options={executablePath:detectTools().chromium.path,headless:true,args}
async function launchFixture(options){
 launches.push(options.userDataDir);const browser=await puppeteer.launch(options),newPage=browser.newPage.bind(browser),close=browser.close.bind(browser)
 browser.close=async()=>{for(const page of await browser.pages())if(page.url().startsWith('https://channels.weixin.qq.com/'))try{diagnostics.push(await page.evaluate(()=>({path:location.pathname,local:localStorage.getItem('fixture-local')==='local-ready',session:sessionStorage.getItem('fixture-session')==='session-ready',authenticated:Boolean(document.querySelector('[data-studio-authenticated="true"]')),login:document.body.innerText.includes('登录视频号助手')})))}catch{}return close()}
 browser.newPage=async()=>{const page=await newPage();await page.setRequestInterception(true);page.on('request',request=>{if(request.isInterceptResolutionHandled())return;const url=new URL(request.url());if(url.hostname!=='channels.weixin.qq.com')return void request.continue();const cookie=(request.headers().cookie||'').includes('fixture_login=portable-auth');void request.respond({status:200,contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><body><script>const valid='+cookie+'&&localStorage.getItem("fixture-local")==="local-ready"&&sessionStorage.getItem("fixture-session")==="session-ready";document.body.innerHTML=valid?\'<nav data-studio-authenticated="true">视频号 · 助手</nav><h1>直播管理</h1>\':\'<h1>登录视频号助手</h1><p>请使用微信扫码登录</p>\';</script>'})});return page};return browser
}
const fakeMedia=()=>({async initialize(){},status:()=>({ready:false,slide:{},output:{running:false,platforms:[]}}),setBgm(){},stopAudio(){},getFrame(){return null},getSlideFrame(){return null},async close(){}})
const app=await createStudio({root:resolve(import.meta.dirname,'..'),dataDir:join(directory,'server'),port:0,password:'Session-transfer-fixture-2026',env:{},mediaFactory:fakeMedia,providerFactory:()=>({status:()=>({})}),platformCollectorFactory:options=>new PlatformChatCollector({...options,launch:launchFixture})})
let helper,source,reopened
try{
 const login=await fetch(app.baseUrl+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'Session-transfer-fixture-2026'})}),cookie=login.headers.get('set-cookie').split(';')[0]
 const api=async(path,value)=>{const r=await fetch(app.baseUrl+path,{method:value?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json'},body:value?JSON.stringify(value):undefined});assert.ok(r.ok,'fixture API '+path);return r.json()}
 const first=(await api('/api/platforms',{platform:'wechat',name:'同步账号甲'})).connection,second=(await api('/api/platforms',{platform:'wechat',name:'独立账号乙'})).connection
 await api('/api/action',{action:'platform.chat.login',id:second.id})
 source=await launchFixture({...options,userDataDir:join(directory,'source')});const page=await source.newPage();await source.defaultBrowserContext().setCookie({name:'fixture_login',value:'portable-auth',domain:'channels.weixin.qq.com',path:'/',httpOnly:true,secure:true});await page.evaluateOnNewDocument(()=>{if(location.origin==='https://channels.weixin.qq.com'){localStorage.setItem('fixture-local','local-ready');sessionStorage.setItem('fixture-session','session-ready')}});await page.goto(CHANNEL_ENTRY)
 const seed=await captureBrowserSession(source,page);assert.equal(seed.cookies[0].httpOnly,true);assert.equal(await backendSessionReady(page),true)
 const grant=await api('/api/platforms/'+first.id+'/local-login',{})
 helper=await createLocalBrowserHelper({servers:[app.baseUrl],port:0,dataDir:join(directory,'helper'),headless:true,launch:launchFixture});const {id}=await helper.pair({serverUrl:app.baseUrl,token:grant.token},{seed});assert.equal((await helper.status(id)).loggedIn,true);await helper.sync(id)
 const collector=app.platforms.collectors.get(first.id),target=collector.delegate;assert.equal(await backendSessionReady(target.page),true);assert.equal(app.platforms.collectors.get(second.id).status().loginRequired,true)
 assert.equal((await fetch(app.baseUrl+'/api/local-login/pair',{method:'POST',headers:{Authorization:'Bearer '+grant.token}})).status,401)
 assert.ok(!JSON.stringify(app.snapshot()).includes('portable-auth'));const metadata=await readFile(join(target.dataDir,'active-browser.json'),'utf8');assert.ok(!metadata.includes('portable-auth'))
 const original=collector.delegate,originalBrowser=original.browser,bad=structuredClone(seed);bad.cookies[0].value='expired'
 await assert.rejects(collector.importSession(bad),/原登录记录已保留/);assert.equal(collector.delegate,original);assert.equal(originalBrowser.connected,true)
 await collector.disconnect();await collector.connect();assert.equal(await backendSessionReady(collector.delegate.page),true,'reconnecting the existing collector restores session cookies')
 await collector.disconnect();reopened=new ChannelsCollector({dataDir:target.dataDir,launch:launchFixture});await reopened.connect();assert.equal(await backendSessionReady(reopened.page),true)
 assert.equal(new Set(launches).size,launches.length-2,'only the deliberately reconnected server profile is reused')
 console.log(JSON.stringify({passed:true,fixtureOnly:true,httpOnlyCookieTransferred:true,localAndSessionStorageTransferred:true,serverVerified:true,oneTimeGrant:true,independentAccounts:true,failedImportPreservesOriginal:true,reconnectPreservesImportedLogin:true,restartPreservesImportedLogin:true,rawCookiesOmittedFromSnapshots:true,actualAccountAuthenticated:false},null,2))
}catch(error){console.error(JSON.stringify({fixtureDiagnostics:diagnostics,launchCount:launches.length}));throw error}finally{await reopened?.close();await helper?.close();await source?.close();await app.close()}
