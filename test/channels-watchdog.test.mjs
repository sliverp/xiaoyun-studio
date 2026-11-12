import test from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {installChannelsWatchdog} from '../server/channels-watchdog.mjs'

function fixture({expectLive=true,storage=new Map(),text='创建直播',path='/platform/live/liveBuild'}={}){
 let now=100000;const timers=[],listeners={},navigations=[],resources=[],childResources=[]
 const doc={body:{innerText:text},addEventListener:(name,callback)=>{listeners[name]=callback},querySelectorAll:()=>[]}
 const location={origin:'https://channels.weixin.qq.com',pathname:path,replace:address=>navigations.push(address)}
 const window={document:doc,location,performance:{timeOrigin:1000,getEntriesByType:()=>resources}};window.top=window
 const context={window,location,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},Date:{now:()=>now},URL,WeakSet,setInterval:(fn,ms)=>{timers.push({fn,ms});return timers.length},Math,JSON}
 const install=(options={})=>runInNewContext('('+installChannelsWatchdog.toString()+')(options)',{...context,options:{expectLive,...options}})
 install()
 return {window,doc,resources,childResources,timers,listeners,navigations,storage,install,get health(){return window.__xiaoyunChannelsWatchdog.status},advance:ms=>{now+=ms;timers[0].fn()},poll:(age=0,status=200)=>resources.push({name:'https://channels.weixin.qq.com/micro/live/cgi-bin/mmfinderassistant-bin/live/msg',responseEnd:now-1000-age,responseStatus:status}),embed(){const childDoc={body:{innerText:''},addEventListener(){},querySelectorAll:()=>[]},child={location,document:childDoc,performance:{timeOrigin:1000,getEntriesByType:()=>childResources}};doc.querySelectorAll=()=>[{getClientRects:()=>[{}],contentWindow:child}];return child}}
}

test('a streaming account stuck before entering its live room reloads only its official collector tab after the grace period',()=>{
 const f=fixture();f.advance(44999);assert.equal(f.navigations.length,0);f.advance(1)
 assert.deepEqual(f.navigations,['https://channels.weixin.qq.com/platform/live/liveBuild']);assert.equal(f.health.retries,1)
 f.advance(10000);assert.equal(f.navigations.length,1,'no overlapping navigation while reload is pending')
})
test('empty but continuing message responses keep a quiet live room healthy',()=>{
 const f=fixture();for(let i=0;i<20;i++){f.poll();f.advance(10000)}
 assert.equal(f.health.state,'healthy');assert.equal(f.navigations.length,0)
 f.advance(45000);assert.equal(f.navigations.length,1,'a stalled long poll must recover without waiting for a comment')
})
test('the heartbeat is observed inside the same-origin official iframe',()=>{
 const f=fixture();f.embed();f.childResources.push({name:'https://channels.weixin.qq.com/micro/live/cgi-bin/mmfinderassistant-bin/live/msg',responseEnd:99000,responseStatus:200});f.advance(1000)
 assert.equal(f.health.state,'healthy');assert.equal(f.health.lastMessageAt,100000)
})
test('acknowledged collector responses remain healthy when the platform clears browser resource timings',()=>{
 const f=fixture();f.advance(44000);f.install({acknowledgedAt:144000});f.advance(1000)
 assert.equal(f.health.state,'healthy');assert.equal(f.navigations.length,0)
 f.advance(45000);assert.equal(f.navigations.length,1)
})
test('login, account selection, ended broadcasts and explicit operator controls suppress recovery',()=>{
 for(const text of ['登录视频号助手','请选择视频号身份','本场直播已结束']){const f=fixture({text});f.advance(90000);assert.equal(f.navigations.length,0)}
 const f=fixture();f.install({blocked:true});f.advance(90000);assert.equal(f.health.state,'paused');assert.equal(f.navigations.length,0)
 f.install({blocked:false});f.advance(1);assert.equal(f.navigations.length,1)
})
test('recent operator input delays recovery instead of interrupting backend interaction',()=>{
 const f=fixture();f.advance(44000);f.listeners.input();f.advance(1000);assert.equal(f.navigations.length,0)
 f.advance(29999);assert.equal(f.navigations.length,1)
})
test('pre-live accounts with no output or previous heartbeat are left alone',()=>{
 const f=fixture({expectLive:false});f.advance(120000);assert.equal(f.navigations.length,0)
 f.install({expectLive:true});f.advance(1);assert.equal(f.navigations.length,1)
})
test('retry backoff survives reload and a healthy response resets it',()=>{
 const f=fixture();f.advance(45000);const saved=JSON.parse(f.storage.get('xiaoyun.channels-watchdog.v1'));assert.equal(saved.retries,1)
 const g=fixture({storage:f.storage});g.advance(90000);assert.equal(g.navigations.length,0)
 g.advance(45000);assert.equal(g.navigations.length,1);assert.equal(g.health.retries,2)
 const h=fixture({storage:g.storage});h.poll();h.advance(1000);assert.equal(h.health.retries,0);assert.equal(h.health.state,'healthy')
})
test('refreshing monitor settings does not add duplicate timers and unrelated or unauthorized requests are not heartbeats',()=>{
 const f=fixture();f.install();f.install();assert.equal(f.timers.length,1)
 f.resources.push({name:'https://untrusted.invalid/mmfinderassistant-bin/live/msg',responseEnd:99000,responseStatus:200});f.poll(0,401);f.advance(45000)
 assert.equal(f.navigations.length,1)
})
