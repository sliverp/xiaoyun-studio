/** One operator-owned, read-only platform account/room with an isolated headless browser. */
import { existsSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { ChannelsCollector } from './channels.mjs'
import { decodePlatformChat, isPlatformChatSocket } from './platform-chat-parser.mjs'
import { browserDeadline, closePlatformBrowser } from './platform-browser.mjs'
import { normalizeRoomUrl, CONNECTION_ID } from './platform-catalog.mjs'
export { normalizeRoomUrl as normalizePlatformRoom } from './platform-catalog.mjs'

const WIDTH=1280,HEIGHT=820
const PLATFORMS={
 bilibili:{name:'哔哩哔哩',home:'https://live.bilibili.com/',login:'https://passport.bilibili.com/login',cookies:['SESSDATA'],metrics:['heat','totalViewers','likes','followers']},
 douyin:{name:'抖音',home:'https://live.douyin.com/',login:'https://live.douyin.com/',cookies:['sessionid','sessionid_ss','sid_guard','sid_tt'],metrics:['onlineUsers','totalViewers','heat','likes']},
 kuaishou:{name:'快手',home:'https://live.kuaishou.com/',login:'https://live.kuaishou.com/',cookies:['kuaishou.live.web_st','kuaishou.server.web_st'],metrics:['onlineUsers','likes']},
 wechat:{name:'视频号',home:'https://channels.weixin.qq.com/platform/live/liveBuild',login:'https://channels.weixin.qq.com/platform/live/liveBuild',cookies:[],metrics:['onlineUsers','peakOnlineUsers','heat','totalViewers','views','likes']},
}
const LABELS={disconnected:'未连接',connecting:'正在打开平台页面','login-required':'请扫码登录','connected-no-live-data':'页面已打开，等待真实弹幕',receiving:'正在接收真实直播数据',ended:'平台显示直播已结束',reconnecting:'浏览器断开，正在重连',error:'平台连接需要处理'}
const safeError=error=>String(error?.message||error||'').replace(/https?:\/\/[^\s'"<>]+/g,'[平台地址]').replace(/(?:sk-|AKID)[A-Za-z0-9_-]{8,}/g,'[redacted]').replace(/\/(?:Users|home|tmp)\/[^\s'"<>]+/g,'[本地路径]').slice(0,240)
const chromePath=()=>[process.env.CHROMIUM_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean).find(existsSync)
const visiblePage=page=>Boolean(page&&!page.isClosed())
const delay=ms=>new Promise(done=>setTimeout(done,ms))

/** Restrict top-level navigation to that platform's own account and live sites. */
export function platformNavigationAllowed(platform,address){
 try{
  const url=new URL(address)
  if(url.protocol!=='https:'||url.username||url.password||url.port)return false
  if(platform==='bilibili')return url.hostname==='bilibili.com'||url.hostname.endsWith('.bilibili.com')
  if(platform==='douyin')return url.hostname==='douyin.com'||url.hostname.endsWith('.douyin.com')
  if(platform==='kuaishou')return /(?:^|\.)kuaishou\.(?:com|cn)$/.test(url.hostname)
  return platform==='wechat'&&url.hostname==='channels.weixin.qq.com'
 }catch{return false}
}

/** Browser-side login signals only; page text and cookies are not returned to a controller. */
export function readPlatformLoginState(platform){
 const text=document.body?.innerText||'',visible=element=>{const style=getComputedStyle(element);return style.display!=='none'&&style.visibility!=='hidden'&&element.getClientRects().length>0}
 const panels=[...document.querySelectorAll('[role="dialog"],[class*="login-panel"],[class*="loginPanel"],[class*="login-modal"],[class*="loginModal"],[class*="passport"],.bili-mini-login-wrapper')].filter(visible)
 const loginText=/扫码登录|二维码登录|登录视频号助手|请使用.{0,12}扫码|请用.{0,12}扫码|微信扫码登录|登录后.{0,10}(?:观看|查看|互动)/
 const loginVisible=/\/login(?:[./]|$)/.test(location.pathname)||loginText.test(text)||panels.some(element=>/登录/.test(element.innerText||''))
 const qrVisible=loginVisible&&[...document.querySelectorAll('img,canvas')].some(element=>{
  if(!visible(element))return false
  const rect=element.getBoundingClientRect(),side=Math.min(rect.width,rect.height)
  if(side<80||Math.max(rect.width,rect.height)/side>1.3)return false
  if(!/\/login(?:[./]|$)/.test(location.pathname)&&!element.closest('[role="dialog"],[class*="login"],[class*="Login"],[class*="passport"],[class*="qrcode"],[class*="qr-code"],[id*="qrcode"]'))return false
  if(element.tagName==='IMG'&&(!element.complete||element.naturalWidth<80||element.naturalHeight<80))return false
  // Text and placeholder logos do not prove that a QR image has loaded.
  try{
   const canvas=document.createElement('canvas');canvas.width=96;canvas.height=96
   const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)return false
   context.fillStyle='#fff';context.fillRect(0,0,96,96);context.drawImage(element,0,0,96,96)
   const pixels=context.getImageData(0,0,96,96).data;let dark=0,light=0
   for(let i=0;i<pixels.length;i+=4){const low=Math.min(pixels[i],pixels[i+1],pixels[i+2]),high=Math.max(pixels[i],pixels[i+1],pixels[i+2]);if(high-low>35)continue;if(high<80)dark++;else if(low>215)light++}
   const count=96*96;return dark/count>.10&&dark/count<.65&&light/count>.20&&(dark+light)/count>.80
  }catch{return false} // Cross-origin or not-yet-decoded images remain unverified.
 })
 const verificationRequired=/请完成安全验证|拖动滑块|安全验证中|请依次点击|请验证后继续|访问过于频繁|操作过于频繁/.test(text)
 const ended=/^(直播已结束|主播已下播|直播结束了|主播暂未开播|本场直播已结束)$/.test(text.trim())||[...document.querySelectorAll('[class*="live-end"],[class*="liveEnd"],[class*="offline"]')].some(element=>visible(element)&&/直播已结束|主播已下播|暂未开播/.test(element.innerText||''))
 return {path:location.pathname,host:location.hostname,loginVisible,qrVisible,verificationRequired,ended,platform}
}

/** Select only visible login/QR controls on an official page; never a live interaction control. */
export function openPlatformQrLogin(){
 const visible=element=>element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden'
 const candidates=[...document.querySelectorAll('button,a,[role="button"],span,div')].filter(element=>visible(element)&&element.children.length<4)
 const inLoginPanel=/扫码登录|二维码登录|验证码登录|密码登录|手机号登录|快手APP登录/.test(document.body?.innerText||'')
 const patterns=[/^(?:扫码登录|二维码登录|快手APP登录)$/]
 if(!inLoginPanel)patterns.push(/^(?:登录|立即登录|登录\s*[\/／]\s*注册|登录后观看)$/)
 for(const pattern of patterns){
  const found=candidates.find(element=>pattern.test((element.innerText||element.getAttribute('aria-label')||'').trim()))
  if(found){found.scrollIntoView({block:'center',inline:'center'});const rect=found.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}}
 }
 return false
}

/** Validate a screenshot click against the actual login control under that point. */
export function allowedPlatformLoginClick({x,y}){
 const hit=document.elementFromPoint(x,y),control=hit?.closest('button,a,[role="button"],label,[class*="qrcode"],[class*="qr-code"],[class*="refresh"],[class*="login-tab"],[class*="loginTab"]')
 if(!control||control.closest('input,textarea,[contenteditable="true"]'))return false
 const text=(control.innerText||control.getAttribute('aria-label')||control.getAttribute('title')||'').trim()
 if(/发送|开播|结束直播|发布|点赞|关注|分享|购买|支付|领取|举报|删除|绑定/.test(text))return false
 return /登录|扫码|二维码|刷新|重新获取|重新加载|同意/.test(text)||/qrcode|qr-code|refresh/i.test(String(control.className))
}

export class PlatformChatCollector {
 constructor({connection,dataDir,onComments=()=>{},onMetrics=()=>{},onStatus=()=>{},launch=options=>puppeteer.launch(options)}){
  if(!connection||!CONNECTION_ID.test(connection.id||'')||!Object.hasOwn(PLATFORMS,connection.platform))throw new Error('平台连接信息无效')
  this.connection={id:connection.id,platform:connection.platform,name:String(connection.name||PLATFORMS[connection.platform].name).slice(0,100),roomUrl:normalizeRoomUrl(connection.platform,connection.roomUrl)}
  this.definition=PLATFORMS[this.connection.platform];this.dataDir=join(resolve(dataDir),'platforms',this.connection.id);this.onComments=onComments;this.onMetrics=onMetrics;this.onStatus=onStatus;this.launch=launch
  this.browser=null;this.page=null;this.frame=null;this.timer=null;this.pending=null;this.wanted=false;this.closed=false;this.generation=0;this.capturing=false;this.navigating=false;this.loginRequested=false;this.mode='room';this.authenticated=false
  this.state='disconnected';this.reason='等待连接';this.error='';this.loginRequired=false;this.qrVisible=false;this.messageResponses=0;this.commentCount=0;this.lastMessageAt=0;this.lastDataAt=0;this.lastCommentAt=0;this.lastMetricsAt=0;this.capturedAt=0;this.pagePath='';this.fields={};this.platformState='unknown';this.verificationRequired=false;this.captureFailed=false;this.decodeWarning=''
  this.delegateQrVisible=null;this.attached=new WeakSet();this.sessions=new Set();this.seen=new Set();this.pendingFrames=0;this.reconnects=0;this.reconnectTimer=null;this.lastDeliveryAt=0
  if(this.connection.platform==='wechat')this.delegate=new ChannelsCollector({dataDir:this.dataDir,launch,onComments:items=>this.onComments(items),onMetrics:value=>this.onMetrics(value),onStatus:()=>this.emit()})
 }
 status(){
  const base=this.delegate?.status()||{state:this.state,label:LABELS[this.state],reason:this.reason,browserOpen:Boolean(this.browser?.connected&&visiblePage(this.page)),loginRequired:this.loginRequired,authenticated:this.authenticated,qrVisible:this.qrVisible,messageResponses:this.messageResponses,commentCount:this.commentCount,lastMessageAt:this.lastMessageAt,lastCommentAt:this.lastCommentAt,lastMetricsAt:this.lastMetricsAt,error:this.error,capturedAt:this.capturedAt,pagePath:this.pagePath,width:WIDTH,height:HEIGHT,platformState:this.platformState,reconnects:this.reconnects,metrics:Object.fromEntries(Object.entries(this.fields).filter(([,entry])=>Date.now()-entry.at<=30000))}
  return {...base,...(this.delegate?{qrVisible:this.delegateQrVisible}:{}),connectionId:this.connection.id,platform:this.connection.platform,name:this.connection.name,roomUrl:this.connection.roomUrl,capability:{mode:this.delegate?'official-backend-responses':'passive-browser-cdp',readOnly:true,qrLogin:true,metrics:this.definition.metrics,liveAccountVerified:false,note:this.delegate?'需要扫码进入实际直播后台；公开后台响应可能调整。':'按平台实际返回读取弹幕；匿名昵称可能打码，验证码或平台限制需要操作者处理。'}}
 }
 getFrame(){return this.delegate?this.delegate.getFrame():this.frame}
 emit(){this.onStatus(this.status())}
 _state(state,reason=this.reason){this.state=state;this.reason=reason;this.emit()}
 async connect(){
  if(this.closed)throw new Error('平台采集器已关闭')
  if(this.delegate){await this.delegate.connect();await this._probeDelegateQr();return this.status()}
  if(this.captureFailed){await this.disconnect();this.captureFailed=false}
  this.mode='room';this.loginRequested=false;this.reconnects=0;this.wanted=true
  return this._open()
 }
 async login(){
  if(this.closed)throw new Error('平台采集器已关闭')
  if(this.delegate){await this.delegate.connect();await this._probeDelegateQr();return this.status()}
  if(this.captureFailed){await this.disconnect();this.captureFailed=false}
  this.mode='login';this.loginRequested=true;this.reconnects=0;this.wanted=true
  return this._open()
 }
 async _open(){
  if(this.pending)return this.openingMode===this.mode?this.pending:this.pending.then(()=>this._open())
  const generation=++this.generation
  this.openingMode=this.mode
  this.pending=this._openBrowser(generation,this.openingMode).finally(()=>{this.pending=null})
  return this.pending
 }
 async _openBrowser(generation,mode){
  this.error='';this._state('connecting',this.mode==='login'?'正在打开官方扫码登录页面':'正在打开直播间并监听真实消息')
  try{
   if(!this.browser?.connected){
    const executablePath=chromePath();if(!executablePath)throw new Error('未检测到 Chromium，请安装服务器浏览器依赖')
    mkdirSync(this.dataDir,{recursive:true,mode:0o700})
    const args=['--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding','--mute-audio','--autoplay-policy=no-user-gesture-required']
    if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
    const browser=await this.launch({executablePath,userDataDir:join(this.dataDir,'browser-profile'),headless:true,protocolTimeout:30000,timeout:30000,defaultViewport:{width:WIDTH,height:HEIGHT,deviceScaleFactor:1},args,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false})
    if(generation!==this.generation||!this.wanted){await closePlatformBrowser(browser);return this.status()}
    this.browser=browser;browser.studioChatGeneration=generation;this.page=await browser.newPage();await this._attach(this.page,generation)
    browser.on('targetcreated',async target=>{
     const active=browser.studioChatGeneration
     if(target.type()!=='page'||browser!==this.browser||active!==this.generation||!this.wanted)return
     try{const page=await target.page();if(!page)return;await this._attach(page,active);if(this.mode==='login'&&platformNavigationAllowed(this.connection.platform,page.url()))this.page=page}catch(error){if(active===this.generation&&this.wanted){this.error=safeError(error);this.emit()}}
    })
    browser.once('disconnected',()=>this._browserDisconnected(browser.studioChatGeneration))
   }else if(visiblePage(this.page)){this.browser.studioChatGeneration=generation;await this._attach(this.page,generation)}
   else{this.browser.studioChatGeneration=generation;this.page=await this.browser.newPage();await this._attach(this.page,generation)}
   if(generation!==this.generation||!this.wanted)return this.status()
   clearInterval(this.timer);this.timer=setInterval(()=>this.capture().catch(error=>{if(generation===this.generation&&this.wanted){this.error=safeError(error);this._state('error','平台页面暂时无法读取')}}),3000);this.timer.unref?.()
   await this._navigate(mode==='login'?this.definition.login:this.connection.roomUrl||this.definition.home,generation)
   if(generation!==this.generation||!this.wanted)return this.status()
   if(mode==='login')await this._showQr(generation)
   await this.capture();return this.status()
  }catch(error){if(generation!==this.generation||!this.wanted)return this.status();this.error=safeError(error);this._state('error','连接失败，可以查看登录截图后重试');throw new Error(this.definition.name+'连接失败：'+this.error)}
 }
 async _attach(page,generation){
  if(this.attached.has(page)){
   // A new operation retains the page's original listeners; their token is renewed explicitly.
   page.studioChatGeneration=generation;return
  }
  this.attached.add(page);page.studioChatGeneration=generation
  await page.setRequestInterception(true)
  page.on('request',request=>{
   if(request.isInterceptResolutionHandled?.())return
   const top=request.isNavigationRequest()&&request.frame()===page.mainFrame()
   const allowed=!top||request.url()==='about:blank'||platformNavigationAllowed(this.connection.platform,request.url())
   const operation=allowed?request.continue():request.abort('blockedbyclient');operation.catch(()=>{})
  })
  const session=await page.createCDPSession();this.sessions.add(session);await session.send('Network.enable')
  const sockets=new Set()
  session.on('Network.webSocketCreated',event=>{if(isPlatformChatSocket(this.connection.platform,event.url))sockets.add(event.requestId)})
  session.on('Network.webSocketClosed',event=>{sockets.delete(event.requestId)})
  session.on('Network.webSocketFrameReceived',event=>{
   const active=page.studioChatGeneration
   if(active!==this.generation||!this.wanted||!sockets.has(event.requestId)||this.pendingFrames>=10)return
   const data=event.response?.payloadData,opcode=event.response?.opcode
   if(typeof data!=='string'||data.length>3*1024*1024||![1,2].includes(opcode))return
   this.pendingFrames++
   const bytes=Buffer.from(data,opcode===2?'base64':'utf8')
   this._acceptFrame(bytes,active).catch(error=>{if(active===this.generation&&this.wanted){this.decodeWarning=safeError(error);this.error=this.decodeWarning;this._state('error','收到平台消息，但解码暂未完成')}}).finally(()=>{this.pendingFrames--})
  })
 }
 async _navigate(address,generation){
  if(!platformNavigationAllowed(this.connection.platform,address))throw new Error('平台页面地址不受支持')
  this.navigating=true
  try{await this.page.goto(address,{waitUntil:'domcontentloaded',timeout:30000})}
  finally{if(generation===this.generation)this.navigating=false}
 }
 async _showQr(generation){
  const token={cancelled:false}
  const scan=async()=>{
   for(let attempt=0;attempt<16;attempt++){
    if(token.cancelled||generation!==this.generation||!this.wanted||!visiblePage(this.page))return
    for(const frame of (this.page.frames?.()||[this.page]).slice(0,6)){
     if(token.cancelled||generation!==this.generation||!this.wanted)return
     if(!platformNavigationAllowed(this.connection.platform,frame.url()))continue
     const state=await frame.evaluate(readPlatformLoginState,this.connection.platform)
     if(token.cancelled||generation!==this.generation||!this.wanted)return
     if(state?.qrVisible)return
     if(state?.verificationRequired)return
     const point=await frame.evaluate(openPlatformQrLogin)
     if(token.cancelled||generation!==this.generation||!this.wanted)return
     if(point&&typeof point==='object'&&Number.isFinite(point.x)&&Number.isFinite(point.y))await this._clickFrameLogin(frame,point)
    }
    await delay(400)
   }
  }
  try{await browserDeadline(scan(),10000,'平台扫码登录页面准备超时，请查看页面提示')}
  finally{token.cancelled=true}
 }
 async _clickFrameLogin(frame,point){
  let global=point
  if(frame!==this.page.mainFrame()){
   const element=await frame.frameElement()
   try{const box=await element.boundingBox(),border=await element.evaluate(node=>({x:node.clientLeft,y:node.clientTop}));if(!box)return;global={x:box.x+border.x+point.x,y:box.y+border.y+point.y}}finally{await element.dispose()}
  }
  if(global.x>=0&&global.y>=0&&global.x<WIDTH&&global.y<HEIGHT)await this.page.mouse.click(global.x,global.y)
 }
 async _probeDelegateQr(){
  const page=this.delegate?.page
  if(this.closed||!page||page.isClosed()||!platformNavigationAllowed('wechat',page.url?.()||''))return
  const state=await browserDeadline(page.evaluate(readPlatformLoginState,'wechat'),10000,'视频号登录状态读取超时')
  if(!this.closed&&this.delegate.page===page){this.delegateQrVisible=Boolean(state.qrVisible);this.emit()}
 }
 async _isAuthenticated(){
  if(!this.browser?.connected)return false
  const cookies=await this.browser.defaultBrowserContext().cookies()
  return cookies.some(cookie=>this.definition.cookies.includes(cookie.name)&&Boolean(cookie.value)&&platformNavigationAllowed(this.connection.platform,'https://'+cookie.domain.replace(/^\./,'')))
 }
 async _acceptFrame(bytes,generation){
  if(this.mode!=='room'||!this.connection.roomUrl)return
  const result=decodePlatformChat(this.connection.platform,bytes)
  if(generation!==this.generation||!this.wanted||!result.recognized)return
  const now=Date.now();this.messageResponses++;this.lastMessageAt=now
  if(result.platformState!=='unknown')this.platformState=result.platformState
  for(const [key,entry]of Object.entries(result.fields))this.fields[key]=entry
  const fresh=result.comments.filter(item=>{if(this.seen.has(item.id))return false;this.seen.add(item.id);return true})
  if(this.seen.size>10000)this.seen=new Set([...this.seen].slice(-5000))
  if(fresh.length){this.decodeWarning='';this.platformState='live';this.commentCount+=fresh.length;this.lastCommentAt=now;await this.onComments(fresh)}
  if(generation!==this.generation||!this.wanted)return
  if(fresh.length||Object.keys(result.fields).length||result.platformState!=='unknown')this.lastDataAt=now
  if(result.warnings?.length)this.decodeWarning=result.warnings.join('；').slice(0,240)
  this.error=this.decodeWarning;this._updateState();await this._deliverMetrics()
 }
 async _deliverMetrics(){
  const now=Date.now(),fields=Object.fromEntries(Object.entries(this.fields).filter(([,entry])=>now-entry.at<=30000))
  if(!Object.keys(fields).length||now-this.lastDeliveryAt<5000)return
  this.lastDeliveryAt=now;this.lastMetricsAt=now
  await this.onMetrics({at:now,fields,source:this.connection.platform+'-browser',connectionId:this.connection.id,platform:this.connection.platform,platformState:this.platformState})
 }
 _updateState(){
  if(!this.browser?.connected)return
  if(this.navigating)return this._state('connecting','正在打开官方平台页面')
  if(this.decodeWarning&&!this.commentCount)return this._state('error','收到平台消息，但弹幕格式需要适配')
  if(this.verificationRequired)return this._state('error','平台要求人工安全验证；本工具不绕过验证码')
  if(this.loginRequired)return this._state('login-required',this.qrVisible?'请用平台手机应用扫描页面二维码':'请点击登录或扫码切换控件；若平台要求验证码，请在截图中查看提示')
  if(this.platformState==='ended')return this._state('ended','平台消息显示本场直播已结束')
  if(this.lastDataAt&&Date.now()-this.lastDataAt<30000)return this._state('receiving','已收到可解码的实际弹幕或指标')
  this._state('connected-no-live-data',this.connection.roomUrl?'尚未收到真实直播消息；确认房间已开播，完整昵称可能需要登录':'请先扫码登录，再配置目标直播间地址')
 }
 async capture(){
  if(this.delegate){await this.delegate.capture();await this._probeDelegateQr();return this.status()}
  if(this.capturing||this.captureFailed||!this.wanted||!this.browser?.connected||!visiblePage(this.page))return
  this.capturing=true
  const generation=this.generation
  try{
   const page=this.page
   if(!platformNavigationAllowed(this.connection.platform,page.url()))return
   const state=await page.evaluate(readPlatformLoginState,this.connection.platform),authenticated=await this._isAuthenticated()
   if(generation!==this.generation||!this.wanted)return
   this.authenticated=authenticated;this.verificationRequired=Boolean(state.verificationRequired);this.pagePath=String(state.path||'').slice(0,180);this.qrVisible=Boolean(state.qrVisible);this.loginRequired=!authenticated&&(this.loginRequested||state.loginVisible)
   const frame=await browserDeadline(page.screenshot({type:'jpeg',quality:78,optimizeForSpeed:true}),10000,'平台登录截图超时，请重新连接')
   if(generation!==this.generation||!this.wanted)return
   this.frame=Buffer.from(frame);this.capturedAt=Date.now()
   if(state.verificationRequired){this.error='平台要求人工安全验证，采集尚未就绪';this._state('error','请在平台完成验证后重试；本工具不绕过验证码');return}
   if(state.ended)this.platformState='ended'
   if(authenticated&&this.loginRequested){
    this.loginRequested=false
    if(this.connection.roomUrl&&this.mode==='login'){this.mode='room';await this._navigate(this.connection.roomUrl,generation);return}
   }
   this.error=this.decodeWarning;this._updateState();await this._deliverMetrics()
  }catch(error){if(error.code==='STUDIO_BROWSER_TIMEOUT'&&generation===this.generation&&this.wanted){this.captureFailed=true;clearInterval(this.timer);this.timer=null;this.error=safeError(error);this._state('error','登录截图暂时无法生成，请重新连接')}throw error}
  finally{this.capturing=false}
 }
 async click({x,y}){
  if(this.delegate){await this.delegate.click({x,y});return this.status()}
  if(!this.wanted||!this.loginRequired||!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=WIDTH||y>=HEIGHT||!visiblePage(this.page)||!platformNavigationAllowed(this.connection.platform,this.page.url()))throw new Error('只能在官方扫码登录页面点击有效的登录或二维码控件')
  const generation=this.generation,allowed=await this._loginClickAllowed(this.page,{x,y})
  if(!allowed)throw new Error('该位置不是允许的登录或二维码刷新控件')
  if(generation!==this.generation||!this.wanted)return this.status()
  await this.page.mouse.click(x,y);await this.capture();return this.status()
 }
 async _loginClickAllowed(page,point){
  let frame=page.mainFrame(),local=point
  for(let depth=0;depth<5;depth++){
   if(!platformNavigationAllowed(this.connection.platform,frame.url()))return false
   if(!frame.evaluateHandle)return frame.evaluate(allowedPlatformLoginClick,local)
   const handle=await frame.evaluateHandle(({x,y})=>document.elementFromPoint(x,y),local)
   try{
    const element=handle.asElement();if(!element)return false
    const location=await element.evaluate(node=>{const rect=node.getBoundingClientRect();return {iframe:/^(IFRAME|FRAME)$/.test(node.tagName),left:rect.left,top:rect.top,borderLeft:node.clientLeft,borderTop:node.clientTop,width:node.clientWidth,height:node.clientHeight}})
    if(!location.iframe)return frame.evaluate(allowedPlatformLoginClick,local)
    const child=await element.contentFrame();if(!child)return false
    local={x:local.x-location.left-location.borderLeft,y:local.y-location.top-location.borderTop}
    if(local.x<0||local.y<0||local.x>=location.width||local.y>=location.height)return false
    frame=child
   }finally{await handle.dispose()}
  }
  return false
 }
 _browserDisconnected(generation){
  if(generation!==this.generation)return
  this.browser=null;this.page=null;this.frame=null;this.attached=new WeakSet();this.sessions.clear();clearInterval(this.timer);this.timer=null
  if(this.wanted&&!this.closed&&this.reconnects<3){this.error='平台浏览器意外断开';this._state('reconnecting','正在恢复这个连接自己的浏览器');const timeout=1000*2**this.reconnects++;this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;if(this.wanted&&!this.closed)this._open().catch(()=>{})},timeout);this.reconnectTimer.unref?.()}
  else this._state(this.wanted?'error':'disconnected','平台浏览器已关闭')
 }
 async disconnect(){
  if(this.delegate){await this.delegate.disconnect();return this.status()}
  this.wanted=false;this.generation++;clearInterval(this.timer);clearTimeout(this.reconnectTimer);this.timer=null;this.reconnectTimer=null
  const browser=this.browser;this.browser=null;this.page=null;this.frame=null;this.loginRequired=false;this.qrVisible=false;this.authenticated=false;this.attached=new WeakSet();this.sessions.clear()
  if(browser)await closePlatformBrowser(browser)
  await this.pending?.catch(()=>{})
  this._state('disconnected','场控已断开连接');return this.status()
 }
 async close(){this.closed=true;if(this.delegate)return this.delegate.close();await this.disconnect()}
}
