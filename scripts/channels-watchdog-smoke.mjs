/** Real Chromium and same-origin iframe long polling, served only by a local TLS fixture. */
import assert from 'node:assert/strict'
import https from 'node:https'
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import puppeteer from 'puppeteer-core'
import {detectTools} from '../server/media.mjs'
import {installChannelsWatchdog} from '../server/channels-watchdog.mjs'
import {createChannelsWatchdogBridge} from './channels-watchdog-bridge.mjs'

const directory=await mkdtemp(join(tmpdir(),'studio-channel-health-')),navigations={a:0,b:0},polls={a:0,b:0},lastPollAt={a:0,b:0},errors=[]
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=channels.weixin.qq.com'],{stdio:'ignore'})
const server=https.createServer({key:await readFile(join(directory,'key.pem')),cert:await readFile(join(directory,'cert.pem'))},(request,response)=>{
 const url=new URL(request.url,'https://channels.weixin.qq.com'),room=url.searchParams.get('fixture')==='b'?'b':'a'
 response.setHeader('Cache-Control','no-store')
 if(url.pathname.endsWith('/live/msg')){polls[room]++;lastPollAt[room]=Date.now();response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:{msgList:[],liveInfo:{liveStatus:1}}}));return}
 response.setHeader('Content-Type','text/html; charset=utf-8')
 if(url.pathname==='/platform/live/liveBuild'){
  navigations[room]++;const live=room==='b'||navigations.a>1
  response.end('<!doctype html><meta charset="utf-8"><body><h1>'+(live?'直播中':'创建直播')+'</h1><script>window.name='+JSON.stringify(room)+';</script>'+(live?'<iframe src="/micro/live/liveBuild?fixture='+room+'"></iframe>':''));return
 }
 if(url.pathname==='/micro/live/liveBuild'){response.end('<!doctype html><body>直播中<script>window.fixturePolling=true;setInterval(()=>{if(window.fixturePolling)fetch("/micro/live/cgi-bin/mmfinderassistant-bin/live/msg?fixture='+room+'").then(r=>r.json()).then(()=>{if('+JSON.stringify(room)+'==="a")performance.clearResourceTimings()})},100)</script>');return}
 response.end('')
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const args=['--ignore-certificate-errors','--no-proxy-server','--disable-background-timer-throttling','--host-resolver-rules=MAP channels.weixin.qq.com 127.0.0.1:'+server.address().port]
if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
let browser,otherBrowser,child,otherChild,bridge,controllerAvailable=true
const wait=async(fn,label)=>{const end=Date.now()+12000;while(!await fn()){if(Date.now()>end)throw Error('Timed out: '+label);await new Promise(done=>setTimeout(done,100))}}
try{
 const profile=join(directory,'projects','scene','platforms','account-a','channels-profile'),otherProfile=join(directory,'projects','scene','platforms','account-b','channels-profile');await mkdir(profile,{recursive:true});await mkdir(otherProfile,{recursive:true})
 browser=await puppeteer.launch({executablePath:detectTools().chromium.path,userDataDir:profile,headless:true,args});child=browser.process()
 otherBrowser=await puppeteer.launch({executablePath:detectTools().chromium.path,userDataDir:otherProfile,headless:true,args});otherChild=otherBrowser.process()
 const endpoint=browser.wsEndpoint(),page=await browser.newPage(),other=await otherBrowser.newPage(),settings={expectLive:true,graceMs:1200,staleMs:1200,idleMs:500,tickMs:100,retryBaseMs:1200}
 for(const tab of [page,other]){tab.on('pageerror',error=>errors.push(error.message));await tab.evaluateOnNewDocument(installChannelsWatchdog,settings)}
 await other.goto('https://channels.weixin.qq.com/platform/live/liveBuild?fixture=b');await page.goto('https://channels.weixin.qq.com/platform/live/liveBuild?fixture=a')
 bridge=await createChannelsWatchdogBridge({dataDir:directory,getSnapshot:async()=>{if(!controllerAvailable)throw Error('Fixture controller session expired');return {projects:{activeId:'scene'},platforms:{connections:['a','b'].map(room=>({id:'account-'+room,platform:'wechat',chat:{browserOpen:true,lastMessageAt:lastPollAt[room]}}))},media:{output:{platforms:['a','b'].map(room=>({id:'account-'+room,active:true,state:'streaming'}))}}}},pollMs:100,monitorOptions:settings})
 await wait(()=>navigations.a>=2&&polls.a>=3,'entering the live room after streaming begins')
 await wait(()=>page.evaluate(()=>window.__xiaoyunChannelsWatchdog?.status.state==='healthy'),'iframe heartbeat')
 const stable=navigations.a;controllerAvailable=false;await new Promise(done=>setTimeout(done,1500));assert.equal(navigations.a,stable,'quiet collection remains healthy even if the controller session expires')
 const frame=page.frames().find(frame=>frame.url().includes('/micro/live/liveBuild'));await frame.evaluate(()=>{window.fixturePolling=false})
 // Registration must survive disconnection of the one-shot hot installer used during a live broadcast.
 await browser.disconnect();await wait(()=>navigations.a>stable,'stalled polling recovering after the installer disconnects')
 browser=await puppeteer.connect({browserWSEndpoint:endpoint,defaultViewport:null})
 const restored=(await browser.pages()).find(tab=>tab.url()==='https://channels.weixin.qq.com/platform/live/liveBuild')
 assert.ok(restored);await wait(()=>restored.evaluate(()=>window.__xiaoyunChannelsWatchdog?.status.state==='healthy'),'monitor survives its own reload')
 assert.equal(navigations.b,1,'recovery of one tab must not reload another account')
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({passed:true,fixtureOnly:true,preLivePageRecovered:true,officialIframeHeartbeat:true,quietRoomDoesNotReload:true,controllerSessionCanExpire:true,stalledPollingRecovered:true,hotInstallerCanDisconnect:true,monitorSurvivesReload:true,otherAccountUntouched:true,actualPlatformTraffic:false}))
}finally{
 await bridge?.close();await browser?.close();await otherBrowser?.close();for(const process of [child,otherChild])for(const stream of process?.stdio||[])stream?.unref?.()
 await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100})
}
