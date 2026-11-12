/** Server-owned video-channel collection and an operator-controlled official backend. */
import { existsSync, mkdirSync,readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {writeFile,mkdir,rm} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import puppeteer from 'puppeteer-core'
import {browserDeadline,closePlatformBrowser} from './platform-browser.mjs'
import {focusedChannelsInput,selectFocusedChannelsInput,CHANNEL_KEYS,coverExtension,readChannelsPageStreamInfo} from './channels-controls.mjs'
import {normalizeBrowserSession,captureBrowserSession,seedBrowserSession,backendSessionReady,CHANNEL_ENTRY,channelsLiveRoomPath} from './browser-session.mjs'
import {atomicJson} from './store.mjs'
import { CHANNEL_METRICS, isChannelsLiveResponse, isChannelsMessageResponse, extractChannelsComments, extractChannelsMetrics, extractChannelsDomMetrics, readChannelsMetricTiles } from './channels-parser.mjs'
import {installChannelsWatchdog} from './channels-watchdog.mjs'

const ENTRY=CHANNEL_ENTRY
const WIDTH=1100,HEIGHT=820
const MODIFIER=process.platform==='darwin'?'Meta':'Control'
const LABELS={disconnected:'未连接视频号',connecting:'正在打开视频号后台','login-required':'请使用微信扫描后台二维码','account-selection-required':'请选择视频号或子用户','backend-home':'已登录视频号，尚未进入直播管理','connected-no-live-data':'弹幕采集尚未就绪',receiving:'正在接收直播消息',ended:'平台显示直播已结束',reconnecting:'后台连接中断，正在重连',error:'后台连接需要处理'}
const safeError=error=>String(error?.message||error||'').replace(/https?:\/\/[^\s'"<>]+/g,'[后台页面地址]').replace(/(?:sk-|AKID)[A-Za-z0-9_-]{8,}/g,'[redacted]').slice(0,240)
const chromiumPath=()=>[process.env.CHROMIUM_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean).find(existsSync)
export function channelsAddressAllowed(address){try{const url=new URL(address);return url.protocol==='https:'&&url.hostname==='channels.weixin.qq.com'&&!url.port&&!url.username&&!url.password}catch{return false}}
/** WeChat embeds its official QR page; this does not broaden top-level backend navigation. */
export function channelsLoginFrameAllowed(address){try{const url=new URL(address);return channelsAddressAllowed(address)||(url.protocol==='https:'&&url.hostname==='open.weixin.qq.com'&&url.pathname==='/connect/qrconnect'&&!url.port&&!url.username&&!url.password)}catch{return false}}
export async function channelsLoginFrames(page){
 const main=page.mainFrame?.()||page,frames=[]
 for(const frame of (page.frames?.()||[main]).slice(0,6)){
  if(frame===main){frames.push(frame);continue}
  if(!channelsLoginFrameAllowed(frame.url?.()))continue
  const element=await frame.frameElement()
  try{if(await element.isVisible())frames.push(frame)}finally{await element.dispose()}
 }
 return frames
}

/** Coordinates always refer to the owned browser viewport. */
export function channelsPointAllowed({x,y}){
  return Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&x<WIDTH&&y>=0&&y<HEIGHT
}

/** Evaluate only the visible login state; page text does not leave the browser. */
export function readChannelsLoginState(){
  const text=document.body?.innerText||''
  const visible=element=>element.getClientRects?.().length&&getComputedStyle(element).visibility!=='hidden'
  const selection=/选择(?:您|你|您的|你的|要登录的|要使用的)?(?:视频号|账号|帐号|身份|子用户|子账号|子帐号)|请选择.{0,12}(?:视频号|账号|帐号|身份|子用户)|身份选择|子用户列表/
  const panels=[...(document.querySelectorAll?.('[role="dialog"],[class*="account-select"],[class*="account_select"],[class*="identity-select"],[role="menu"],[role="listbox"],[class*="account-switch"],h1,h2,h3,h4')||[])].filter(visible)
  const accountSelectionRequired=panels.some(element=>/(?:选择|切换|以下).{0,12}(?:视频号|账号|帐号|身份|子用户)|子用户列表/.test(element.innerText||''))||(text.length<2400&&selection.test(text))
  return {path:location.pathname,accountSelectionRequired,loginRequired:accountSelectionRequired||/登录视频号助手|微信扫码登录|使用微信扫码|使用微信扫一扫登录|扫码登录|请用微信扫描|请使用微信扫描/.test(text)||/\/login(?:[./]|$)/.test(location.pathname)}
}

export class ChannelsCollector {
  constructor({dataDir,onComments=()=>{},onMetrics=()=>{},onStatus=()=>{},launch=options=>puppeteer.launch(options),profileName,seed,expectLive=()=>false}){
    this.dataDir=resolve(dataDir);this.onComments=onComments;this.onMetrics=onMetrics;this.onStatus=onStatus;this.launch=launch
    this.browser=null;this.page=null;this.pages=new Set();this.frame=null;this.timer=null;this.connecting=null;this.capturing=false;this.wanted=false;this.closed=false;this.generation=0
    this.state='disconnected';this.error='';this.loginRequired=false;this.accountSelectionRequired=false;this.capturedAt=0;this.pagePath='';this.messageResponses=0;this.commentCount=0;this.lastMessageAt=0;this.lastMetricsAt=0;this.liveId='';this.platformState='unknown'
    this.seen=new Set();this.pendingResponses=0;this.fields={};this.stateAt=0;this.stateSource='';this.lastDomAt=0;this.lastDeliveryAt=0;this.reconnects=0;this.reconnectTimer=null;this.captureFailed=false
    this.fileChooser=null;this.uploadPaths=[];this.expectLive=expectLive;this.monitor=null
    let saved
    if(!profileName)try{saved=JSON.parse(readFileSync(join(this.dataDir,'active-browser.json'),'utf8'));if(!/^channels-session-[a-f0-9-]{36}$/.test(saved.profileName))throw new Error('invalid profile')}catch(error){if(error.code!=='ENOENT')throw new Error('视频号本机登录记录无法读取，请重新连接本机浏览器')}
    this.profileName=profileName||saved?.profileName||'channels-profile'
    this.sessionFile=this.profileName==='channels-profile'?null:join(this.dataDir,this.profileName+'-state.json');this.lastSessionSaved=0
    this.seed=seed||saved?.seed||null
    if(!this.seed&&this.sessionFile)try{this.seed=normalizeBrowserSession(JSON.parse(readFileSync(this.sessionFile,'utf8')))}catch(error){if(error.code!=='ENOENT')throw new Error('视频号同步会话无法读取，请从本机重新同步')}
    this.uploadDirectory=join(this.dataDir,this.profileName==='channels-profile'?'browser-uploads':this.profileName+'-uploads')
  }
  status(){const livePageReady=!this.loginRequired&&channelsLiveRoomPath(this.pagePath);return {state:this.state,label:LABELS[this.state],reason:this.state==='reconnecting'?'实时消息心跳中断，正在自动恢复此账号采集；推流与录制继续。':this.state==='backend-home'?(this.expectLive()?'正在自动进入本场直播并检查实时消息。':'已登录视频号助手，尚未进入本场直播。'):this.state==='connected-no-live-data'?(this.expectLive()?'正在等待本场直播的消息心跳；45秒未收到响应会自动恢复采集。':'已登录后台，等待开播后的实时消息；尚未验证弹幕采集。'):'',livePageReady,fileUploadRequested:Boolean(this.fileChooser),browserOpen:Boolean(this.browser?.connected&&this.page&&!this.page.isClosed()),loginRequired:this.loginRequired,accountSelectionRequired:this.accountSelectionRequired,messageResponses:this.messageResponses,commentCount:this.commentCount,lastMessageAt:this.lastMessageAt,lastMetricsAt:this.lastMetricsAt,capturedAt:this.capturedAt,pagePath:this.pagePath,error:this.error,width:WIDTH,height:HEIGHT,platformState:this.platformState,liveId:this.liveId,reconnects:this.reconnects,health:this.monitor?{...this.monitor}:null,metrics:Object.fromEntries(Object.entries(this.fields).filter(([,item])=>Date.now()-item.at<=30000))}}
  getFrame(){return this.frame}
  emit(){this.onStatus(this.status())}
  _state(value){this.state=value;this.emit()}

  async connect({openLiveRoom=true}={}){
    if(this.closed)throw new Error('视频号采集器已关闭')
    if(this.captureFailed){await this.disconnect();this.captureFailed=false}
    this.wanted=true
    if(this.connecting)return this.connecting
    if(this.browser?.connected&&this.page&&!this.page.isClosed()){
      this.connecting=(async()=>{try{const state=await this._loginState(this.page);if(openLiveRoom&&!state.loginRequired&&(!channelsLiveRoomPath(state.path)||this.state==='error')){this._state('connecting');await this.page.goto(ENTRY,{waitUntil:'domcontentloaded',timeout:30000})}await this.capture();return this.status()}catch(error){this.error=safeError(error);this._state('error');throw error}})().finally(()=>{this.connecting=null})
      return this.connecting
    }
    const generation=++this.generation
    this.connecting=this._connect(generation).finally(()=>{this.connecting=null})
    return this.connecting
  }
  async _connect(generation){
    this.error='';this._state('connecting')
    if(this.sessionFile&&existsSync(this.sessionFile))try{this.seed=normalizeBrowserSession(JSON.parse(readFileSync(this.sessionFile,'utf8')))}catch{this.error='视频号同步会话无法读取，请从本机重新同步';this._state('error');throw new Error(this.error)}
    const executablePath=chromiumPath()
    if(!executablePath){this.error='未检测到 Chromium，请完成服务器依赖安装';this._state('error');throw new Error(this.error)}
    const profile=join(this.dataDir,this.profileName);mkdirSync(profile,{recursive:true,mode:0o700})
    const args=['--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--mute-audio']
    if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
    try{
      const browser=await this.launch({executablePath,userDataDir:profile,headless:true,protocolTimeout:30000,timeout:30000,defaultViewport:{width:WIDTH,height:HEIGHT,deviceScaleFactor:1},handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,args})
      if(generation!==this.generation||!this.wanted){await closePlatformBrowser(browser);return this.status()}
      this.browser=browser;this.page=await browser.newPage();await this._attach(this.page,generation)
      browser.on('targetcreated',async target=>{if(target.type()!=='page'||generation!==this.generation)return;try{const page=await target.page();if(page)await this._attach(page,generation)}catch(error){if(generation===this.generation&&this.wanted){this.error=safeError(error);this.emit()}}})
      browser.once('disconnected',()=>{
        if(generation!==this.generation)return
        this.browser=null;this.page=null;this.pages.clear();clearInterval(this.timer);this.timer=null
        if(this.wanted&&!this.closed&&this.reconnects<3){this.error='视频号浏览器意外断开';this._state('reconnecting');const delay=1000*2**this.reconnects++;this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;if(this.wanted&&!this.closed)this.connect().catch(()=>{})},delay);this.reconnectTimer.unref?.()}
        else this._state(this.wanted?'error':'disconnected')
      })
      const destination=this.seed?.entryUrl&&channelsLiveRoomPath(new URL(this.seed.entryUrl).pathname)?this.seed.entryUrl:ENTRY
      await this.page.goto(destination,{waitUntil:'domcontentloaded',timeout:30000})
      if(generation!==this.generation||!this.wanted)return this.status()
      await this.capture();this.timer=setInterval(()=>this.capture().catch(error=>{if(generation===this.generation&&this.wanted){this.error=safeError(error);this._state('error')}}),3000);this.timer.unref?.()
      return this.status()
    }catch(error){if(generation!==this.generation||!this.wanted)return this.status();this.error=safeError(error);this._state('error');throw new Error('视频号后台连接失败：'+this.error)}
  }

  async _attach(page,generation){
    if(this.pages.has(page))return;this.pages.add(page)
    if(this.seed){await seedBrowserSession(this.browser,page,this.seed);delete this.seed.cookies}
    if(page.evaluateOnNewDocument)await page.evaluateOnNewDocument(installChannelsWatchdog,{expectLive:this.expectLive()})
    page.on('framenavigated',frame=>{if(generation!==this.generation||!this.wanted||frame!==page.mainFrame?.()||!channelsAddressAllowed(page.url?.()))return;if(this.page===page||[...this.pages].at(-1)===page){this.page=page;this.frame=null;this.fileChooser=null;this.emit()}})
    page.on('close',()=>{this.pages.delete(page);if(this.page===page&&generation===this.generation){this.page=[...this.pages].findLast(candidate=>!candidate.isClosed()&&channelsAddressAllowed(candidate.url?.()))||null;this.frame=null;this.emit()}})
    page.on('response',async response=>{
      if(generation!==this.generation||!isChannelsLiveResponse(response.url())||this.pendingResponses>=10)return
      this.pendingResponses++
      try{
        if(Number(response.headers()['content-length'])>2*1024*1024)return
        const raw=await response.text();if(generation!==this.generation||!this.wanted||Buffer.byteLength(raw)>2*1024*1024)return
        let value;try{value=JSON.parse(raw)}catch{return}
        const now=Date.now()
        if(isChannelsMessageResponse(response.url())){
          let request={};try{request=JSON.parse(response.request().postData()||'{}')}catch{/* Missing non-JSON request ids do not prevent response parsing. */}
          const parsed=extractChannelsComments(request,value,now)
          if(parsed){
            this.messageResponses++;this.lastMessageAt=now
            if(parsed.liveId&&this.liveId&&this.liveId!==parsed.liveId){this.seen.clear();this.commentCount=0;this.fields={}}
            if(parsed.liveId)this.liveId=parsed.liveId
            this._mergeMetrics({at:now,fields:{},liveId:parsed.liveId,platformState:parsed.platformState,stateSource:'api'})
            const fresh=parsed.comments.filter(item=>{const identity=this.liveId+':'+item.id;if(this.seen.has(identity))return false;this.seen.add(identity);return true})
            if(this.seen.size>10000)this.seen=new Set([...this.seen].slice(-5000))
            if(fresh.length){this.commentCount+=fresh.length;await this.onComments(fresh)}
          }
        }
        if(generation!==this.generation||!this.wanted)return
        this._mergeMetrics(extractChannelsMetrics(value,now));this._updateState();await this._deliverMetrics()
      }catch(error){if(generation===this.generation){this.error='读取直播数据暂未完成：'+safeError(error);this.emit()}}
      finally{this.pendingResponses--}
    })
    if(channelsAddressAllowed(page.url?.())&&generation===this.generation&&this.wanted&&[...this.pages].at(-1)===page){this.page=page;this.frame=null}
    if(page.setRequestInterception){await page.setRequestInterception(true);page.on('request',request=>{if(request.isInterceptResolutionHandled?.())return;const top=request.isNavigationRequest()&&request.frame()===page.mainFrame(),allowed=!top||request.url()==='about:blank'||channelsAddressAllowed(request.url());(allowed?request.continue():request.abort('blockedbyclient')).catch(()=>{})})}
  }

  _mergeMetrics(snapshot){
    if(!snapshot)return
    if(snapshot.liveId&&this.liveId&&snapshot.liveId!==this.liveId){this.fields={};this.platformState='unknown';this.stateAt=0;this.seen.clear();this.commentCount=0}
    if(snapshot.liveId)this.liveId=snapshot.liveId
    if(['live','ended'].includes(snapshot.platformState)&&!(this.stateSource==='api'&&snapshot.stateSource==='dom'&&snapshot.at-this.stateAt<30000)){this.platformState=snapshot.platformState;this.stateAt=snapshot.at;this.stateSource=snapshot.stateSource}
    for(const [key,entry]of Object.entries(snapshot.fields||{})){
      const current=this.fields[key]
      if(current?.source==='api'&&entry.source==='dom'&&entry.at-current.at<30000)continue
      this.fields[key]=entry
    }
  }
  async _deliverMetrics(){
    const now=Date.now(),fields=Object.fromEntries(Object.entries(this.fields).filter(([,entry])=>now-entry.at<=30000))
    if(!Object.keys(fields).length||now-this.lastDeliveryAt<5000)return
    this.lastDeliveryAt=now;this.lastMetricsAt=now
    await this.onMetrics({at:now,fields,liveId:this.liveId,platformState:this.platformState,source:'channels-backend'})
  }
  _updateState(){
    if(!this.browser?.connected)return
    if(this.accountSelectionRequired)this.state='account-selection-required'
    else if(this.loginRequired)this.state='login-required'
    else if(!channelsLiveRoomPath(this.pagePath)&&!(this.lastMessageAt&&Date.now()-this.lastMessageAt<30000))this.state='backend-home'
    else if(this.platformState==='ended'||this.monitor?.state==='ended')this.state='ended'
    else if(this.lastMessageAt&&Date.now()-this.lastMessageAt<30000&&(this.platformState==='live'||this.commentCount>0))this.state='receiving'
    else if(this.monitor?.state==='reconnecting')this.state='reconnecting'
    else this.state='connected-no-live-data'
    this.emit()
  }
  async capture(){
    if(this.capturing||this.captureFailed||!this.page||this.page.isClosed()||!this.browser?.connected)return
    this.capturing=true
    const generation=this.generation,page=this.page
    try{
      const state=await this._loginState(page)
      if(generation!==this.generation||!this.wanted||page!==this.page)return
      this.pagePath=String(state.path||'').slice(0,180);this.loginRequired=Boolean(state.loginRequired);this.accountSelectionRequired=Boolean(state.accountSelectionRequired)
      this.monitor=await page.evaluate(installChannelsWatchdog,{expectLive:this.expectLive(),acknowledgedAt:this.lastMessageAt,blocked:this.loginRequired||this.accountSelectionRequired||Boolean(this.fileChooser)||this.platformState==='ended'})
      const frame=await browserDeadline(page.screenshot({type:'jpeg',quality:78,optimizeForSpeed:true}),10000,'视频号登录截图超时，请重新连接')
      if(generation!==this.generation||!this.wanted||page!==this.page)return
      this.frame=Buffer.from(frame);this.capturedAt=Date.now()
      if(!this.loginRequired&&Date.now()-this.lastDomAt>=5000&&(channelsLiveRoomPath(this.pagePath)||Date.now()-this.lastMessageAt<30000)){
        this.lastDomAt=Date.now();const labels=CHANNEL_METRICS.flatMap(metric=>metric.labels)
        const rows=await page.evaluate(readChannelsMetricTiles,labels)
        if(generation!==this.generation||!this.wanted)return
        this._mergeMetrics(extractChannelsDomMetrics(rows))
      }
      this.error='';this._updateState();await this._deliverMetrics()
      if(this.sessionFile&&!this.loginRequired&&Date.now()-this.lastSessionSaved>30000)await this._saveSession().catch(()=>{})
    }catch(error){if(generation!==this.generation||!this.wanted||page!==this.page)return;if(error.code==='STUDIO_BROWSER_TIMEOUT'&&generation===this.generation&&this.wanted){this.captureFailed=true;clearInterval(this.timer);this.timer=null;this.error=safeError(error);this._state('error')}throw error}
    finally{this.capturing=false}
  }

  async _loginState(page){
    const state=await page.evaluate(readChannelsLoginState),main=page.mainFrame?.()||page
    for(const frame of await channelsLoginFrames(page)){
      if(frame===main)continue
      const child=await frame.evaluate(readChannelsLoginState)
      state.loginRequired||=child.loginRequired;state.accountSelectionRequired||=child.accountSelectionRequired
    }
    return state
  }
  async click({x,y}){
    const page=this._controlPage({x,y}),generation=this.generation
    await this._controlFrame(page,{x,y})
    if(generation!==this.generation||page!==this.page||!this.wanted)return this.status()
    if(this.fileChooser){await this.fileChooser.cancel().catch(()=>{});this.fileChooser=null}
    const chooser=page.waitForFileChooser({timeout:700}).catch(()=>null)
    try{await page.mouse.click(x,y)}catch(error){if(!page.isClosed()||page===this.page)throw error}
    const selected=await chooser;if(selected&&page===this.page&&generation===this.generation)this.fileChooser=selected
    await this.capture();return this.status()
  }
  async scroll({x=WIDTH/2,y=HEIGHT/2,deltaY}){
    if(!Number.isFinite(deltaY)||Math.abs(deltaY)>600)throw new Error('后台画面滚动参数无效')
    const page=this._controlPage({x,y});await this._controlFrame(page,{x,y})
    await page.mouse.move(x,y);await page.mouse.wheel({deltaY});await this.capture();return this.status()
  }
  async drag({fromX,fromY,toX,toY}){
    const page=this._controlPage({x:fromX,y:fromY});this._controlPage({x:toX,y:toY});await this._controlFrame(page,{x:fromX,y:fromY});await this._controlFrame(page,{x:toX,y:toY})
    await page.mouse.move(fromX,fromY);await page.mouse.down();try{await page.mouse.move(toX,toY,{steps:12})}finally{await page.mouse.up()}await this.capture();return this.status()
  }
  _controlPage(point){if(!this.wanted||point&&!channelsPointAllowed(point)||!this.page||this.page.isClosed()||!channelsAddressAllowed(this.page.url?.()))throw new Error('只能在视频号官方后台操作有效位置');return this.page}
  async _controlFrame(page,point){
    let frame=page.mainFrame(),local=point
    for(let depth=0;depth<5;depth++){
      if(!channelsLoginFrameAllowed(frame.url()))throw new Error('只能操作视频号官方后台或微信登录页面')
      const handle=await frame.evaluateHandle(({x,y})=>document.elementFromPoint(x,y),local)
      try{const element=handle.asElement();if(!element)throw new Error('请选择画面中的有效位置');const box=await element.evaluate(node=>{const r=node.getBoundingClientRect();return {iframe:/^(IFRAME|FRAME)$/.test(node.tagName),x:r.x+node.clientLeft,y:r.y+node.clientTop}});if(!box.iframe)return frame;frame=await element.contentFrame();if(!frame)throw new Error('后台内嵌页面尚未就绪');local={x:local.x-box.x,y:local.y-box.y}}finally{await handle.dispose()}
    }
    throw new Error('后台内嵌页面层级过多')
  }
  async _focusedFrame(page){
    for(const frame of await channelsLoginFrames(page))if(await frame.evaluate(focusedChannelsInput))return frame
    throw new Error('请先点击后台画面中的标题或其他输入框')
  }
  async type({text,replace=false}){
    if(typeof text!=='string'||text.length>10000||!text.length||typeof replace!=='boolean')throw new Error('请输入 1 至 10000 字的文本')
    const page=this._controlPage(),frame=await this._focusedFrame(page)
    if(replace)await frame.evaluate(selectFocusedChannelsInput)
    await page.keyboard.sendCharacter(text);await this.capture();return this.status()
  }
  async key({key}){
    if(!CHANNEL_KEYS.has(key))throw new Error('后台按键无效')
    if(key==='SelectAll'){const page=this._controlPage(),frame=await this._focusedFrame(page);await frame.evaluate(selectFocusedChannelsInput);await this.capture();return this.status()}
    const page=this._controlPage(),frame=await page.evaluateHandle(()=>document.activeElement);try{const element=frame.asElement();const child=element&&await element.contentFrame();if(child&&!channelsLoginFrameAllowed(child.url()))throw new Error('只能操作视频号官方页面')}finally{await frame.dispose()}
    const combo={SelectAll:MODIFIER+'+A',Undo:MODIFIER+'+Z',Redo:MODIFIER+'+Shift+Z'}[key]||key
    await page.keyboard.press(combo);await this.capture();return this.status()
  }
  async upload(bytes){
    const extension=coverExtension(bytes),page=this._controlPage();let input
    if(!this.fileChooser){const frame=await this._focusedFrame(page).catch(()=>null);if(frame)input=await frame.$('input[type="file"]');if(!input)throw new Error('请先点击后台画面中的「上传封面」或选择图片按钮')}
    const directory=this.uploadDirectory;await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,'upload-'+randomUUID()+extension);await writeFile(path,bytes,{mode:0o600})
    try{if(this.fileChooser){await this.fileChooser.accept([path]);this.fileChooser=null}else await input.uploadFile(path);this.uploadPaths.push(path);while(this.uploadPaths.length>3)await rm(this.uploadPaths.shift(),{force:true});await this.capture();return this.status()}catch(error){await rm(path,{force:true});throw error}finally{await input?.dispose()}
  }
  async streamInfo(){const page=this._controlPage(),value=await readChannelsPageStreamInfo(page);if(!value.rtmpUrl||!value.streamKey)throw new Error('当前画面还没有完整的推流信息，请先完成直播设置并开播，再打开推流信息区域');return value}
  async importSession(value){
    const state=normalizeBrowserSession(value),profileName='channels-session-'+randomUUID();let committed=false,previousStopped=false
    const candidate=new ChannelsCollector({dataDir:this.dataDir,profileName,seed:state,launch:this.launch,expectLive:this.expectLive,onComments:items=>{if(committed)this.onComments(items)},onMetrics:items=>{if(committed)this.onMetrics(items)},onStatus:()=>{if(committed)this.onStatus()}})
    try{
      await candidate.connect();let ready=0
      for(let i=0;i<16;i++){if(await backendSessionReady(candidate.page))ready++;else ready=0;if(ready>=2)break;await new Promise(done=>setTimeout(done,750))}
      if(ready<2)throw new Error('session rejected')
      await candidate._saveSession();await this.disconnect();previousStopped=true
      atomicJson(join(this.dataDir,'active-browser.json'),{profileName})
      committed=true;return candidate
    }catch{
      await candidate.close().catch(()=>{});await rm(join(this.dataDir,profileName),{recursive:true,force:true}).catch(()=>{});await rm(candidate.sessionFile,{force:true}).catch(()=>{})
      if(previousStopped)await this.connect().catch(()=>{})
      throw new Error('服务器未能验证这次登录同步。请在本机完成扫码和账号选择后重新同步；原登录记录已保留。')
    }
  }
  async _saveSession(){if(!this.sessionFile||!this.browser?.connected||!this.page||this.page.isClosed()||!channelsAddressAllowed(this.page.url()))return;const session=await captureBrowserSession(this.browser,this.page);atomicJson(this.sessionFile,session);this.lastSessionSaved=Date.now()}
  async disconnect(){
    await this._saveSession().catch(()=>{})
    this.wanted=false;this.generation++;clearInterval(this.timer);this.timer=null;clearTimeout(this.reconnectTimer);this.reconnectTimer=null
    const browser=this.browser;this.browser=null;this.page=null;this.pages.clear();this.frame=null;this.loginRequired=false;this.accountSelectionRequired=false
    this.fileChooser=null;this.monitor=null
    if(browser)await closePlatformBrowser(browser)
    await rm(this.uploadDirectory,{recursive:true,force:true});this.uploadPaths=[]
    await this.connecting?.catch(()=>{})
    this._state('disconnected');return this.status()
  }
  async close(){this.closed=true;await this.disconnect()}
}
