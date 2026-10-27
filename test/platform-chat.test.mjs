import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {runInNewContext} from 'node:vm'
import {deflateSync,gzipSync,brotliCompressSync} from 'node:zlib'
import {PlatformChatCollector,platformNavigationAllowed,normalizePlatformRoom,readPlatformLoginState,openPlatformQrLogin,allowedPlatformLoginClick} from '../server/platform-chat.mjs'
import {decodePlatformChat,isPlatformChatSocket} from '../server/platform-chat-parser.mjs'

const vi=value=>{let number=BigInt(value),bytes=[];do{let byte=Number(number&127n);number>>=7n;if(number)byte|=128;bytes.push(byte)}while(number);return Buffer.from(bytes)}
const field=(id,value)=>{const data=typeof value==='string'?Buffer.from(value):value;return Buffer.isBuffer(data)?Buffer.concat([vi(id*8+2),vi(data.length),data]):Buffer.concat([vi(id*8),vi(value)])}
const pb=(...parts)=>Buffer.concat(parts)
const packet=(body,operation=5,version=0)=>{const bytes=Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body)),header=Buffer.alloc(16);header.writeUInt32BE(bytes.length+16);header.writeUInt16BE(16,4);header.writeUInt16BE(version,6);header.writeUInt32BE(operation,8);header.writeUInt32BE(1,12);return Buffer.concat([header,bytes])}
const biliChat=(content='真实弹幕',nickname='观众甲',uid=123)=>packet({cmd:'DANMU_MSG:4:0:2',info:[[0,1,2,3,123456,789],content,[uid,nickname]],privateCookie:'never-return-this-field'})
const dyMessage=(method,payload,id='8765432109876543210')=>pb(field(1,method),field(2,payload),field(3,BigInt(id)))
const dyFrame=messages=>pb(field(5,pb(field(1,'compress_type'),field(2,'gzip'))),field(7,'msg'),field(8,gzipSync(pb(...messages.map(message=>field(1,message))))))
const dyChat=(text='你好',nickname='抖音观众')=>dyMessage('WebcastChatMessage',pb(field(2,pb(field(1,1234567890123456789n),field(3,nickname),field(99,'private-account-info'))),field(3,text)))
const ksFrame=(compression=2)=>pb(field(1,310),field(2,compression),field(3,gzipSync(pb(field(1,'1.2万'),field(2,'0'),field(5,pb(field(1,'comment-ks-1'),field(2,pb(field(1,'ks-user'),field(2,'快手观众'))),field(3,'一起聊聊')))))))
const until=async predicate=>{const deadline=performance.now()+1500;while(!predicate()){if(performance.now()>deadline)throw new Error('Expected collector state was not reached');await new Promise(done=>setTimeout(done,2))}}

async function fixture(t,{platform='bilibili',id='account-1',roomUrl='12345',launchDelay=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'studio-platform-chat-')),executable=join(dir,'fixture-browser');await writeFile(executable,'fixture')
 const original=process.env.CHROMIUM_PATH;process.env.CHROMIUM_PATH=executable
 const deliveries=[],metrics=[],states=[],launches=[];let release
 const launch=async options=>{
  launches.push(options);if(launchDelay)await new Promise(done=>{release=done})
  const browser=new EventEmitter(),session=new EventEmitter(),page=new EventEmitter()
  session.send=async()=>({})
  page.address='about:blank';page.loginState={loginVisible:false,qrVisible:false,verificationRequired:false,ended:false};page.loginClicks=0;page.allowClick=true;page.mouse={click:async()=>{page.clicked=true}}
  Object.assign(page,{url:()=>page.address,isClosed:()=>!browser.connected,setRequestInterception:async()=>{},mainFrame:()=>page,createCDPSession:async()=>session,goto:async address=>{page.address=address},screenshot:async()=>Buffer.from('private-login-frame'),evaluate:async fn=>{if(fn===readPlatformLoginState)return {...page.loginState,path:new URL(page.address).pathname};if(fn===allowedPlatformLoginClick)return page.allowClick;page.loginClicks++;page.loginState.loginVisible=true;page.loginState.qrVisible=true;return true}})
  Object.assign(browser,{connected:true,cookies:[],newPage:async()=>page,defaultBrowserContext:()=>({cookies:async()=>browser.cookies}),close:async()=>{browser.connected=false;browser.emit('disconnected')}})
  browser.page=page;browser.session=session;launches[launches.length-1].fixture=browser;return browser
 }
 const collector=new PlatformChatCollector({connection:{id,platform,name:'独立连接',roomUrl},dataDir:dir,launch,onComments:items=>deliveries.push(...items),onMetrics:value=>metrics.push(value),onStatus:value=>states.push(value)})
 t.after(async()=>{await collector.close();if(original===undefined)delete process.env.CHROMIUM_PATH;else process.env.CHROMIUM_PATH=original;await rm(dir,{recursive:true,force:true})})
 return {dir,collector,launches,deliveries,metrics,states,release:()=>release?.(),browser:()=>launches.at(-1)?.fixture}
}

test('room normalization and navigation never accept unrelated or credential-bearing hosts',()=>{
 assert.equal(normalizePlatformRoom('bilibili','12345'),'https://live.bilibili.com/12345')
 assert.equal(normalizePlatformRoom('douyin','12345'),'https://live.douyin.com/12345')
 assert.equal(normalizePlatformRoom('kuaishou','anchor-123'),'https://live.kuaishou.com/u/anchor-123')
 for(const address of ['file:///etc/passwd','http://live.bilibili.com/1','https://live.bilibili.com.evil.test/1','https://user:secret@live.bilibili.com/1','https://127.0.0.1/'])assert.throws(()=>normalizePlatformRoom('bilibili',address))
 assert.equal(platformNavigationAllowed('bilibili','https://passport.bilibili.com/login'),true);assert.equal(platformNavigationAllowed('douyin','https://live.bilibili.com/1'),false)
})

test('only known secure chat sockets are inspected',()=>{
 assert.equal(isPlatformChatSocket('bilibili','wss://broadcastlv.chat.bilibili.com/sub?token=private'),true)
 assert.equal(isPlatformChatSocket('douyin','wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/?signature=private'),true)
 assert.equal(isPlatformChatSocket('kuaishou','wss://livejs-ws.kuaishou.cn/websocket'),true)
 for(const address of ['ws://broadcastlv.chat.bilibili.com/sub','wss://chat.bilibili.com.evil.test/sub','wss://frontier-im.douyin.com/ws','wss://unrelated.test/websocket'])for(const platform of ['bilibili','douyin','kuaishou'])assert.equal(isPlatformChatSocket(platform,address),false)
})

test('Bilibili compressed batched frames retain all comments and distinguish popularity from audience',()=>{
 const heat=Buffer.alloc(4);heat.writeUInt32BE(0)
 const batch=pb(biliChat('第一条','一号'),biliChat('第二条','二号'),packet(heat,3,1),packet({cmd:'WATCHED_CHANGE',data:{num:501}}))
 for(const [version,compress]of [[2,deflateSync],[3,brotliCompressSync]]){
  const result=decodePlatformChat('bilibili',packet(compress(batch),5,version),1000)
  assert.deepEqual(result.comments.map(row=>row.content),['第一条','第二条']);assert.equal(result.comments[0].userId,'123');assert.equal(result.fields.heat.value,0);assert.equal(result.fields.totalViewers.value,501);assert.equal(result.fields.onlineUsers,undefined)
  assert.doesNotMatch(JSON.stringify(result),/never-return|privateCookie/)
 }
})

test('Douyin protobuf batches preserve 64-bit identities without reading unknown account fields',()=>{
 const room=dyMessage('WebcastRoomUserSeqMessage',pb(field(3,34),field(6,1234),field(7,501)),'2')
 const likes=dyMessage('WebcastLikeMessage',pb(field(3,0)),'3')
 const result=decodePlatformChat('douyin',dyFrame([dyChat(),dyChat('第二条','另一位'),room,likes]),1000)
 assert.equal(result.comments.length,2);assert.equal(result.comments[0].id,'8765432109876543210');assert.equal(result.comments[0].userId,'1234567890123456789')
 assert.equal(result.fields.onlineUsers.value,34);assert.equal(result.fields.totalViewers.value,501);assert.equal(result.fields.likes.value,0)
 assert.doesNotMatch(JSON.stringify(result),/private-account-info/)
 const missing=decodePlatformChat('douyin',dyFrame([dyMessage('WebcastLikeMessage',pb(field(2,1)))]));assert.equal(missing.fields.likes,undefined)
})

test('Kuaishou feed decoder reads rounded counters as approximations and refuses encrypted payloads',()=>{
 const result=decodePlatformChat('kuaishou',ksFrame(),1000)
 assert.deepEqual(result.comments,[{id:'comment-ks-1',nickname:'快手观众',content:'一起聊聊',at:1000,userId:'ks-user'}])
 assert.equal(result.fields.onlineUsers.value,12000);assert.equal(result.fields.onlineUsers.approximate,true);assert.equal(result.fields.likes.value,0)
 assert.throws(()=>decodePlatformChat('kuaishou',ksFrame(3)),/加密/)
})

test('malformed lengths and compressed expansion cannot exceed decoder limits',()=>{
 const broken=biliChat();broken.writeUInt32BE(broken.length+100)
 assert.throws(()=>decodePlatformChat('bilibili',broken),/长度/)
 assert.throws(()=>decodePlatformChat('bilibili',packet(deflateSync(Buffer.alloc(9*1024*1024)),5,2)))
 assert.throws(()=>decodePlatformChat('douyin',Buffer.alloc(2*1024*1024+1)),/2MiB/)
})

test('constructors never launch a browser, and each connection owns a separate profile',async t=>{
 const f=await fixture(t);assert.equal(f.launches.length,0);assert.equal(f.collector.status().state,'disconnected');assert.equal(f.collector.getFrame(),null)
 await f.collector.connect();assert.equal(f.launches.length,1);assert.equal(f.launches[0].headless,true);assert.equal(f.launches[0].userDataDir,join(f.dir,'platforms/account-1/browser-profile'))
 assert.equal(f.collector.status().connectionId,'account-1');assert.equal(f.collector.status().capability.liveAccountVerified,false)
 const second=new PlatformChatCollector({connection:{id:'account-2',platform:'bilibili',name:'第二账号',roomUrl:'12345'},dataDir:f.dir,launch:async()=>{throw new Error('must remain inert')}})
 assert.notEqual(second.dataDir,f.collector.dataDir);await second.close()
})

test('CDP reads only an allowlisted chat connection and suppresses duplicate messages',async t=>{
 const f=await fixture(t);await f.collector.connect();const session=f.browser().session
 session.emit('Network.webSocketCreated',{requestId:'wrong',url:'wss://unrelated.test/sub'})
 session.emit('Network.webSocketFrameReceived',{requestId:'wrong',response:{opcode:2,payloadData:biliChat().toString('base64')}})
 assert.equal(f.deliveries.length,0)
 session.emit('Network.webSocketCreated',{requestId:'chat',url:'wss://broadcastlv.chat.bilibili.com/sub?token=private-session'})
 for(let i=0;i<2;i++)session.emit('Network.webSocketFrameReceived',{requestId:'chat',response:{opcode:2,payloadData:biliChat().toString('base64')}})
 await until(()=>f.collector.messageResponses===2)
 assert.equal(f.deliveries.length,1);assert.equal(f.collector.status().state,'receiving');assert.doesNotMatch(JSON.stringify(f.collector.status()),/private-session|never-return-this-field/)
})

test('QR login uses the official page and keeps cookies entirely server-side',async t=>{
 const f=await fixture(t,{roomUrl:''});await f.collector.login()
 assert.equal(f.browser().page.address,'https://passport.bilibili.com/login');assert.equal(f.collector.status().state,'login-required');assert.equal(f.collector.status().qrVisible,true)
 assert.ok(f.browser().page.loginClicks>=1);assert.ok(f.collector.getFrame().length)
 f.browser().cookies=[{name:'SESSDATA',value:'private-cookie-value',domain:'.bilibili.com'}];await f.collector.capture()
 assert.equal(f.collector.status().authenticated,true);assert.doesNotMatch(JSON.stringify(f.collector.status()),/private-cookie-value|SESSDATA/)
})

test('login screenshot controls cannot post comments, start live, like or follow',()=>{
 for(const text of ['发送评论','开始直播','点赞','关注','分享','购买','绑定账号']){
  const control={innerText:text,closest:()=>null,getAttribute:()=>null,className:'button'}
  const allowed=runInNewContext('('+allowedPlatformLoginClick.toString()+')({x:1,y:1})',{document:{elementFromPoint:()=>({closest:()=>control})}})
  assert.equal(allowed,false)
 }
 const state=runInNewContext('('+readPlatformLoginState.toString()+')("douyin")',{document:{body:{innerText:'请使用抖音扫码登录'},querySelectorAll:()=>[]},location:{pathname:'/',hostname:'live.douyin.com'},getComputedStyle:()=>({display:'block',visibility:'visible'})})
 assert.equal(state.loginVisible,true);assert.equal(state.qrVisible,false)
})

test('QR visibility requires a loaded monochrome image rather than login text or a placeholder logo',()=>{
 const element={tagName:'IMG',complete:true,naturalWidth:200,naturalHeight:200,getClientRects:()=>[1],getBoundingClientRect:()=>({width:200,height:200}),closest:()=>({})}
 let darkRatio=.02,blocked=false
 const context={fillRect:()=>{},drawImage:()=>{if(blocked)throw new Error('Image is not readable')},getImageData:()=>{const data=new Uint8ClampedArray(96*96*4);for(let i=0;i<data.length;i+=4){data[i]=data[i+1]=data[i+2]=i/4<96*96*darkRatio?0:255;data[i+3]=255}return {data}}}
 const environment={document:{body:{innerText:'登录视频号助手'},querySelectorAll:selector=>selector==='img,canvas'?[element]:[],createElement:()=>({getContext:()=>context})},location:{pathname:'/login.html',hostname:'channels.weixin.qq.com'},getComputedStyle:()=>({display:'block',visibility:'visible'})}
 const inspect=()=>runInNewContext('('+readPlatformLoginState.toString()+')("wechat")',environment)
 assert.equal(inspect().qrVisible,false);darkRatio=.30;assert.equal(inspect().qrVisible,true)
 element.complete=false;assert.equal(inspect().qrVisible,false);element.complete=true;blocked=true;assert.equal(inspect().qrVisible,false)
})

test('opening a QR tab never submits the generic login button inside an existing login dialog',()=>{
 const button={innerText:'登录',children:[],getClientRects:()=>[1],getAttribute:()=>null}
 const environment={document:{body:{innerText:'验证码登录 手机号登录'},querySelectorAll:()=>[button]},getComputedStyle:()=>({visibility:'visible'})}
 assert.equal(runInNewContext('('+openPlatformQrLogin.toString()+')({panelOpen:true})',environment),false)
})

test('QR login retries an unresponsive entry after hydration and stops toggling an open panel',async t=>{
 const f=await fixture(t,{platform:'douyin'});t.mock.timers.enable({apis:['Date','setTimeout'],now:100000})
 let panelOpen=false;const entryClicks=[],tabClicks=[]
 const frame={url:()=> 'https://live.douyin.com/',evaluate:async(fn,options)=>fn===readPlatformLoginState?{qrVisible:Date.now()>=107000,loginPanelVisible:panelOpen}:options.panelOpen?{x:20,y:20}:{x:10,y:10}}
 f.collector.page={isClosed:()=>false,frames:()=>[frame]};f.collector.wanted=true;f.collector.generation=1
 f.collector._clickFrameLogin=async(_frame,point)=>{if(point.x===10){entryClicks.push(Date.now());if(entryClicks.length===3)panelOpen=true}else tabClicks.push(Date.now())}
 const pending=f.collector._showQr(1)
 for(let step=0;step<18;step++){for(let flush=0;flush<12;flush++)await Promise.resolve();t.mock.timers.tick(500)}
 await pending
 assert.deepEqual(entryClicks,[100000,102000,104000]);assert.equal(tabClicks.length,1)
})

test('disconnect during browser startup closes only the late owned browser and never revives collection',async t=>{
 const f=await fixture(t,{launchDelay:true});const pending=f.collector.connect();await until(()=>f.launches.length===1)
 const stopped=f.collector.disconnect();f.release();await stopped;await pending
 assert.equal(f.browser().connected,false);assert.equal(f.collector.status().state,'disconnected');assert.equal(f.collector.getFrame(),null)
})

test('login and reconnect reuse this account profile while updating cancellation listeners',async t=>{
 const f=await fixture(t);await f.collector.connect();await f.collector.login()
 assert.equal(f.launches.length,1);const browser=f.browser();browser.connected=false;browser.emit('disconnected')
 assert.equal(f.collector.status().state,'reconnecting')
 await f.collector.disconnect();assert.equal(f.collector.status().state,'disconnected');assert.equal(f.collector.reconnectTimer,null)
})

test('a platform safety challenge is never presented as successful chat readiness',async t=>{
 const f=await fixture(t);await f.collector.connect();f.browser().page.loginState.verificationRequired=true;await f.collector.capture()
 assert.equal(f.collector.status().state,'error');assert.match(f.collector.status().error,/安全验证/)
 await f.collector._acceptFrame(biliChat(),f.collector.generation)
 assert.equal(f.collector.status().state,'error')
})

test('WeChat uses its established reader inside this connection own directory',async t=>{
 const f=await fixture(t,{platform:'wechat',roomUrl:''})
 assert.equal(f.collector.delegate.dataDir,join(f.dir,'platforms/account-1'));assert.equal(f.launches.length,0)
 const state=f.collector.status();assert.equal(state.platform,'wechat');assert.equal(state.connectionId,'account-1');assert.equal(state.capability.mode,'official-backend-responses')
 await f.collector.disconnect();assert.equal(f.collector.status().state,'disconnected')
})

test('Bilibili dm_v2 supplies real chat fields and preserves a 64-bit account id',()=>{
 const bytes=pb(field(1,'upstream-comment-v2'),field(6,'新版协议弹幕'),field(20,pb(field(1,9007199254740993n),field(2,'完整昵称'),field(4,'private-avatar-url'))),field(19,pb(field(1,'private-check-token'))))
 const result=decodePlatformChat('bilibili',packet({cmd:'DANMU_MSG',info:[[0],'旧正文',[0,'***']],dm_v2:bytes.toString('base64')}),1000)
 assert.deepEqual(result.comments,[{id:'upstream-comment-v2',nickname:'完整昵称',content:'新版协议弹幕',at:1000,userId:'9007199254740993'}])
 assert.doesNotMatch(JSON.stringify(result),/private-check-token|private-avatar-url/)
})

test('unsupported chat formats do not mark an open socket as successful comment collection',async t=>{
 const f=await fixture(t);await f.collector.connect()
 await f.collector._acceptFrame(packet({cmd:'DANMU_MSG',dm_v2:'not valid protobuf'}),f.collector.generation)
 assert.equal(f.collector.commentCount,0);assert.equal(f.collector.status().state,'error');assert.match(f.collector.status().error,/DANMU_MSG/)
 await f.collector.capture();assert.equal(f.collector.status().state,'error')
})

test('a changed or negative room-counter field never discards valid Douyin chat in the same batch',()=>{
 const changed=dyMessage('WebcastRoomUserSeqMessage',pb(field(3,34),field(6,'new-wire-type'),field(7,501)),'4')
 const result=decodePlatformChat('douyin',dyFrame([dyChat(),changed]))
 assert.equal(result.comments.length,1);assert.equal(result.fields.onlineUsers,undefined);assert.match(result.warnings[0],/指标格式已变化/)
 const negative=dyMessage('WebcastRoomUserSeqMessage',pb(field(3,18446744073709551615n)),'5')
 assert.equal(decodePlatformChat('douyin',dyFrame([negative])).fields.onlineUsers,undefined)
})

test('trusted login iframes receive transformed coordinates while unrelated frames are refused',async t=>{
 const f=await fixture(t);let received
 const child={url:()=> 'https://passport.bilibili.com/login',evaluate:async(fn,point)=>{received=point;return true}}
 const handle={asElement:()=>({evaluate:async()=>({iframe:true,left:100,top:200,borderLeft:2,borderTop:3,width:400,height:300}),contentFrame:async()=>child}),dispose:async()=>{}}
 const main={url:()=> 'https://live.bilibili.com/12345',evaluateHandle:async()=>handle},page={mainFrame:()=>main}
 assert.equal(await f.collector._loginClickAllowed(page,{x:150,y:250}),true);assert.deepEqual(received,{x:48,y:47})
 child.url=()=> 'https://unrelated.test/login';received=null
 assert.equal(await f.collector._loginClickAllowed(page,{x:150,y:250}),false);assert.equal(received,null)
})

test('a stalled screenshot fails after ten seconds and explicit reconnect creates a clean owned browser',async t=>{
 const f=await fixture(t);await f.collector.connect();assert.equal(f.launches[0].protocolTimeout,30000)
 let entered=false;f.browser().page.screenshot=()=>{entered=true;return new Promise(()=>{})}
 t.mock.timers.enable({apis:['setTimeout']})
 const pending=f.collector.capture(),rejected=assert.rejects(pending,/截图超时/)
 for(let i=0;i<12&&!entered;i++)await Promise.resolve()
 assert.equal(entered,true);t.mock.timers.tick(10000);await rejected
 assert.equal(f.collector.status().state,'error');assert.equal(f.collector.captureFailed,true);assert.equal(f.collector.timer,null)
 await f.collector.connect();assert.equal(f.launches.length,2);assert.equal(f.collector.captureFailed,false)
})

test('WeChat close waits for its late browser launch before callers may remove the profile',async t=>{
 const f=await fixture(t,{platform:'wechat',roomUrl:'',launchDelay:true});const pending=f.collector.connect();await until(()=>f.launches.length===1)
 let stopped=false;const closing=f.collector.close().then(()=>{stopped=true})
 await Promise.resolve();assert.equal(stopped,false);f.release();await closing;await pending
 assert.equal(f.browser().connected,false);assert.equal(f.collector.status().state,'disconnected')
})
