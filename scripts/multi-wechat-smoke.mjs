/** Real isolated Chromium profiles and collectors; offline accounts, no actual platform or RTMP traffic. */
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import puppeteer from 'puppeteer-core'
import {createStudio} from '../server/http.mjs'
import {PlatformChatCollector} from '../server/platform-chat.mjs'
import {createLocalBrowserHelper} from './local-browser-helper.mjs'
import {CHANNEL_ENTRY,backendSessionReady} from '../server/browser-session.mjs'

const directory=await mkdtemp(join(tmpdir(),'studio-multi-wechat-')),browsers=[],profiles=[]
async function launchFixture(options){
 profiles.push(options.userDataDir)
 const browser=await puppeteer.launch(options);browsers.push(browser)
 const newPage=browser.newPage.bind(browser)
 browser.newPage=async()=>{
  const page=await newPage();await page.setRequestInterception(true)
  page.on('request',request=>{
   if(request.isInterceptResolutionHandled())return
   const url=new URL(request.url())
   if(url.hostname==='127.0.0.1')return void request.continue()
   if(url.hostname!=='channels.weixin.qq.com')return void request.abort()
   const account=/fixture_account=([ab])(?:;|$)/.exec(request.headers().cookie||'')?.[1]||''
   if(url.pathname.endsWith('/live/msg'))return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({data:{liveInfo:{liveId:'room-'+account,liveStatus:1,onlineCnt:account==='a'?11:22},msgList:[{type:1,clientMsgId:'same-id',nickname:'同名观众',content:'来自直播间'+account}]}})})
   void request.respond({status:200,contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><body><script>const account='+JSON.stringify(account)+';const valid=account&&localStorage.getItem("account")===account&&sessionStorage.getItem("account")===account;document.body.innerHTML=valid?\'<nav data-studio-authenticated="true">视频号助手</nav><h1>直播管理</h1>\':\'<h1>登录视频号助手</h1>\';</script>'})
  })
  return page
 }
 return browser
}
const seed=account=>({version:1,platform:'wechat',entryUrl:CHANNEL_ENTRY,userAgent:'Studio multi-account fixture',cookies:[{name:'fixture_account',value:account,domain:'channels.weixin.qq.com',path:'/',httpOnly:true,secure:true}],origins:[{origin:'https://channels.weixin.qq.com',localStorage:[['account',account]],sessionStorage:[['account',account]]}]})
const fakeMedia=()=>({destinations:[],async initialize(){},status(){return {ready:true,slide:{pageNumber:1},output:{running:this.destinations.length>0,platforms:this.destinations.map(({id})=>({id,active:true,state:'streaming'}))}}},async startOutput(value){this.destinations=value.destinations},async addDestination(value){this.destinations.push(value)},async stopDestination(id){this.destinations=this.destinations.filter(item=>item.id!==id)},async stopOutput(){this.destinations=[]},setBgm(){},stopAudio(){},getFrame(){return null},getSlideFrame(){return null},async close(){}})
let app,helper
try{
 app=await createStudio({root:resolve(import.meta.dirname,'..'),dataDir:join(directory,'server'),port:0,password:'Multi-account-fixture-2026',env:{},mediaFactory:fakeMedia,providerFactory:()=>({status:()=>({})}),platformCollectorFactory:options=>new PlatformChatCollector({...options,launch:launchFixture})})
 const login=await fetch(app.baseUrl+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'Multi-account-fixture-2026'})}),cookie=login.headers.get('set-cookie').split(';')[0]
 const api=async(path,value)=>{
  const response=await fetch(app.baseUrl+path,{method:value?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json'},body:value?JSON.stringify(value):undefined})
  assert.ok(response.ok,'fixture API '+path);return response.json()
 }
 const a=(await api('/api/platforms',{platform:'wechat',name:'视频号甲',rtmpUrl:'rtmp://stream.invalid/a',streamKey:'fixture-key-a'})).connection
 const b=(await api('/api/platforms',{platform:'wechat',name:'视频号乙',rtmpUrl:'rtmp://stream.invalid/b',streamKey:'fixture-key-b'})).connection
 helper=await createLocalBrowserHelper({servers:[app.baseUrl],port:0,dataDir:join(directory,'helper'),headless:true,launch:launchFixture})
 const jobs=[]
 for(const [connection,account] of [[a,'a'],[b,'b']]){
  const grant=await api('/api/platforms/'+connection.id+'/local-login',{})
  const job=await helper.pair({serverUrl:app.baseUrl,token:grant.token},{seed:seed(account)})
  jobs.push(job);assert.equal((await helper.status(job.id)).loggedIn,true);await helper.sync(job.id)
 }
 assert.notEqual(jobs[0].id,jobs[1].id)
 assert.equal(new Set(profiles).size,4,'two local profiles and two server profiles must be distinct')
 const collectors=[a,b].map(connection=>app.platforms.collectors.get(connection.id))
 const identity=async collector=>{
  const page=collector.delegate.page,values=await page.evaluate(()=>[localStorage.getItem('account'),sessionStorage.getItem('account')])
  return [(await collector.delegate.browser.defaultBrowserContext().cookies()).find(item=>item.name==='fixture_account').value,...values]
 }
 assert.deepEqual(await identity(collectors[0]),['a','a','a']);assert.deepEqual(await identity(collectors[1]),['b','b','b'])
 for(const collector of collectors){
  assert.equal(await backendSessionReady(collector.delegate.page),true)
  await collector.delegate.page.evaluate(()=>fetch('/micro/live/cgi-bin/mmfinderassistant-bin/live/msg',{method:'POST',body:JSON.stringify({liveId:'fixture'})}).then(response=>response.json()))
 }
 const deadline=Date.now()+5000
 while(app.director.comments.length<2&&Date.now()<deadline)await new Promise(done=>setTimeout(done,25))
 assert.deepEqual(app.director.comments.map(item=>[item.connectionId,item.content]),[[a.id,'来自直播间a'],[b.id,'来自直播间b']])
 assert.equal(new Set(app.director.comments.map(item=>item.id)).size,2,'same platform message IDs must not deduplicate across rooms')
 assert.equal(app.director.platformMetrics[a.id].onlineUsers,11);assert.equal(app.director.platformMetrics[b.id].onlineUsers,22)
 await api('/api/action',{action:'output.start'})
 assert.deepEqual(app.media.destinations.map(item=>[item.id,item.rtmpUrl,item.streamKey]),[[a.id,'rtmp://stream.invalid/a','fixture-key-a'],[b.id,'rtmp://stream.invalid/b','fixture-key-b']])
 assert.doesNotMatch(JSON.stringify(app.snapshot()),/fixture-key-[ab]|fixture_account/)
 const secondBrowser=collectors[1].delegate.browser
 await api('/api/action',{action:'platform.chat.disconnect',id:a.id});await api('/api/action',{action:'output.platform.stop',id:a.id})
 assert.equal(secondBrowser.connected,true);assert.deepEqual(await identity(collectors[1]),['b','b','b'])
 assert.deepEqual(app.media.destinations.map(item=>item.id),[b.id])
 console.log(JSON.stringify({passed:true,fixtureOnly:true,isolatedLocalBrowsers:2,isolatedServerBrowsers:2,cookiesAndStorageIsolated:true,bothRoomsDeliverComments:true,messageIdentityScopedToConnection:true,separateViewerMetrics:true,separateStreamCredentials:true,stoppingOnePreservesOther:true,actualAccountsUsed:false,actualRtmpTraffic:false},null,2))
}finally{
 await helper?.close();await app?.close()
 for(const browser of browsers){if(browser.connected)await browser.close();for(const stream of browser.process()?.stdio||[])stream?.unref?.()}
 await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100})
}
