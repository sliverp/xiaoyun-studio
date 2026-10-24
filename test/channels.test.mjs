import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {EventEmitter} from 'node:events'
import {runInNewContext} from 'node:vm'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ChannelsCollector,loginClickAllowed,readChannelsLoginState} from '../server/channels.mjs'
import {isChannelsLiveResponse,isChannelsMessageResponse,parseChannelNumber,extractChannelsComments,extractChannelsMetrics,extractChannelsDomMetrics} from '../server/channels-parser.mjs'

test('only official live routes are inspected, including backend path prefixes',()=>{
 for(const prefix of ['', '/cgi-bin', '/micro/live/cgi-bin']){
  const url='https://channels.weixin.qq.com'+prefix+'/mmfinderassistant-bin/live/msg'
  assert.equal(isChannelsLiveResponse(url),true);assert.equal(isChannelsMessageResponse(url),true)
 }
 for(const url of ['https://evil.test/mmfinderassistant-bin/live/msg','https://channels.weixin.qq.com/mmfinderassistant-bin/login','http://channels.weixin.qq.com/mmfinderassistant-bin/live/msg'])assert.equal(isChannelsLiveResponse(url),false)
 assert.equal(isChannelsMessageResponse('https://channels.weixin.qq.com/mmfinderassistant-bin/live/msg_extra'),false)
})

test('official login wording and login.html remain login-required while the app route alone does not',()=>{
 const read=(pathname,innerText)=>runInNewContext('('+readChannelsLoginState.toString()+')()',{document:{body:{innerText}},location:{pathname}})
 assert.equal(read('/platform/live/liveBuild','登录视频号助手\n使用微信扫描二维码').loginRequired,true)
 assert.equal(read('/login.html','').loginRequired,true)
 assert.equal(read('/platform/login','').loginRequired,true)
 assert.equal(read('/platform/live/liveBuild','直播数据\n当前在线人数 12').loginRequired,false)
})

test('message extraction omits cookies, login headers and private viewer account ids',()=>{
 const value=extractChannelsComments({liveId:'room-a',token:'private'},{data:{liveInfo:{liveStatus:1},msgList:[{type:1,clientMsgId:'comment-a',nickname:'观众甲',content:'你好',username:'private-viewer-id',cookie:'private-cookie'},{type:10005,clientMsgId:'entry',nickname:'进场用户'},{type:1,clientMsgId:'invalid',content:'没有昵称'}],appMsgList:[{secret:'private'}]}},1000)
 assert.deepEqual(value,{liveId:'room-a',platformState:'live',comments:[{id:'comment-a',nickname:'观众甲',content:'你好',at:1000}]})
 assert.doesNotMatch(JSON.stringify(value),/private|token|cookie|username/)
})

test('missing counters stay absent, zero stays zero, rounded values retain provenance',()=>{
 assert.equal(parseChannelNumber(0),0);assert.equal(parseChannelNumber('--'),null);assert.equal(parseChannelNumber(null),null);assert.equal(parseChannelNumber('1.2万'),12000)
 assert.equal(parseChannelNumber('01:02:03','durationSeconds'),3723);assert.equal(parseChannelNumber('02:99','durationSeconds'),null)
 const metrics=extractChannelsMetrics({data:{liveInfo:{liveId:'a',liveStatus:1,onlineCnt:0,totalViewerCnt:123,watchCnt:456,likeCnt:9,authCount:999,tokenCount:999,cookie:'secret'}}},1000)
 assert.equal(metrics.fields.onlineUsers.value,0);assert.equal(metrics.fields.totalViewers.value,123);assert.equal(metrics.fields.views.value,456)
 assert.equal(metrics.platformState,'live');assert.doesNotMatch(JSON.stringify(metrics),/secret|authCount|tokenCount/)
 const dom=extractChannelsDomMetrics([{label:'热度',value:'2.6万'},{label:'在线人数',value:'--'}],1000)
 assert.equal(dom.fields.heat.value,26000);assert.equal(dom.fields.heat.approximate,true);assert.equal(dom.fields.onlineUsers,undefined)
})

test('constructor and status never launch a browser, and login clicks cannot operate live controls',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'studio-channels-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 let launched=0
 const collector=new ChannelsCollector({dataDir:dir,launch:async()=>{launched++;throw new Error('not called')}})
 assert.equal(launched,0);assert.equal(collector.status().state,'disconnected');assert.equal(collector.getFrame(),null)
 await assert.rejects(collector.click({x:20,y:20}),/只能在扫码登录页/)
 assert.equal(loginClickAllowed('receiving',{x:10,y:10}),false);assert.equal(loginClickAllowed('login-required',{x:1100,y:10}),false);assert.equal(loginClickAllowed('login-required',{x:10,y:10}),true)
 await collector.close();assert.equal(launched,0)
})

test('fresh API metrics outrank DOM approximations and stale fields do not get delivered',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'studio-channels-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 let now=100000;t.mock.method(Date,'now',()=>now)
 const delivered=[],collector=new ChannelsCollector({dataDir:dir,onMetrics:value=>delivered.push(value)})
 collector._mergeMetrics(extractChannelsMetrics({data:{liveInfo:{liveId:'a',onlineCnt:34,likeCnt:100}}},now))
 now+=1000;collector._mergeMetrics(extractChannelsDomMetrics([{label:'在线人数',value:'30'}],now));assert.equal(collector.fields.onlineUsers.value,34)
 await collector._deliverMetrics();assert.equal(delivered[0].fields.onlineUsers.value,34)
 now+=31000;await collector._deliverMetrics();assert.equal(delivered.length,1)
 collector._mergeMetrics(extractChannelsMetrics({data:{liveInfo:{liveId:'b',onlineCnt:2}}},now));assert.equal(collector.fields.likes,undefined)
 await collector.close()
})

test('explicit connection owns an isolated headless login browser and never exposes its profile contents',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'studio-channels-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const executable=join(dir,'fixture-chromium');await writeFile(executable,'fixture')
 const previous=process.env.CHROMIUM_PATH;process.env.CHROMIUM_PATH=executable
 t.after(()=>{if(previous===undefined)delete process.env.CHROMIUM_PATH;else process.env.CHROMIUM_PATH=previous})
 const page=new EventEmitter();let navigated='',launchOptions
 Object.assign(page,{isClosed:()=>false,goto:async url=>{navigated=url},evaluate:async()=>({path:'/platform/login',loginRequired:true}),screenshot:async()=>Buffer.from('login-qr')})
 const browser=new EventEmitter();Object.assign(browser,{connected:true,newPage:async()=>page,close:async()=>{browser.connected=false;browser.emit('disconnected')}})
 const collector=new ChannelsCollector({dataDir:dir,launch:async options=>{launchOptions=options;return browser}});t.after(()=>collector.close())
 assert.equal(launchOptions,undefined)
 const status=await collector.connect()
 assert.equal(launchOptions.headless,true);assert.equal(launchOptions.userDataDir,join(dir,'channels-profile'))
 assert.equal(navigated,'https://channels.weixin.qq.com/platform/live/liveBuild');assert.equal(status.state,'login-required')
 assert.equal(collector.getFrame().toString(),'login-qr');assert.doesNotMatch(JSON.stringify(status),/cookie|storage|userDataDir|fixture-chromium/)
 await collector.disconnect();assert.equal(collector.getFrame(),null);assert.equal(browser.connected,false)
})

test('disconnect discards a delayed network body without delivering comments or reviving status',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'studio-channels-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const comments=[],page=new EventEmitter(),collector=new ChannelsCollector({dataDir:dir,onComments:items=>comments.push(...items)})
 collector.wanted=true;collector.generation=1;collector._attach(page,1)
 let release
 const response={url:()=> 'https://channels.weixin.qq.com/mmfinderassistant-bin/live/msg',headers:()=>({}),request:()=>({postData:()=>'{"liveId":"room"}'}),text:()=>new Promise(resolve=>{release=resolve})}
 const pending=page.listeners('response')[0](response)
 await collector.disconnect()
 release(JSON.stringify({data:{liveInfo:{liveStatus:1},msgList:[{type:1,clientMsgId:'late',nickname:'观众',content:'不应送入已断开采集器'}]}}))
 await pending
 assert.deepEqual(comments,[]);assert.equal(collector.status().state,'disconnected');assert.equal(collector.messageResponses,0)
 await collector.close()
})
