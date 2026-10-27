/** Server-owned, read-only video-channel collection with a private headless QR login view. */
import { existsSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import puppeteer from 'puppeteer-core'
import {browserDeadline,closePlatformBrowser} from './platform-browser.mjs'
import { CHANNEL_METRICS, isChannelsLiveResponse, isChannelsMessageResponse, extractChannelsComments, extractChannelsMetrics, extractChannelsDomMetrics, readChannelsMetricTiles } from './channels-parser.mjs'

const ENTRY='https://channels.weixin.qq.com/platform/live/liveBuild'
const WIDTH=1100,HEIGHT=820
const LABELS={disconnected:'未连接视频号',connecting:'正在打开后台登录页','login-required':'请使用微信扫描后台二维码','connected-no-live-data':'后台已连接，尚未收到直播消息',receiving:'正在接收直播消息',ended:'平台显示直播已结束',reconnecting:'后台连接中断，正在重连',error:'后台连接需要处理'}
const safeError=error=>String(error?.message||error||'').replace(/https?:\/\/[^\s'"<>]+/g,'[后台页面地址]').replace(/(?:sk-|AKID)[A-Za-z0-9_-]{8,}/g,'[redacted]').slice(0,240)
const chromiumPath=()=>[process.env.CHROMIUM_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean).find(existsSync)

/** Only known login/QR-refresh controls may receive console clicks. */
export function loginClickAllowed(state,{x,y}){
  return state==='login-required'&&Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&x<WIDTH&&y>=0&&y<HEIGHT
}

/** Evaluate only the visible login state; page text does not leave the browser. */
export function readChannelsLoginState(){
  const text=document.body?.innerText||''
  return {path:location.pathname,loginRequired:/登录视频号助手|微信扫码登录|使用微信扫码|扫码登录|请用微信扫描|请使用微信扫描/.test(text)||/\/login(?:[./]|$)/.test(location.pathname)}
}

export class ChannelsCollector {
  constructor({dataDir,onComments=()=>{},onMetrics=()=>{},onStatus=()=>{},launch=options=>puppeteer.launch(options)}){
    this.dataDir=resolve(dataDir);this.onComments=onComments;this.onMetrics=onMetrics;this.onStatus=onStatus;this.launch=launch
    this.browser=null;this.page=null;this.frame=null;this.timer=null;this.connecting=null;this.capturing=false;this.wanted=false;this.closed=false;this.generation=0
    this.state='disconnected';this.error='';this.loginRequired=false;this.capturedAt=0;this.pagePath='';this.messageResponses=0;this.commentCount=0;this.lastMessageAt=0;this.lastMetricsAt=0;this.liveId='';this.platformState='unknown'
    this.seen=new Set();this.pendingResponses=0;this.fields={};this.stateAt=0;this.stateSource='';this.lastDomAt=0;this.lastDeliveryAt=0;this.reconnects=0;this.reconnectTimer=null;this.captureFailed=false
  }
  status(){return {state:this.state,label:LABELS[this.state],browserOpen:Boolean(this.browser?.connected&&this.page&&!this.page.isClosed()),loginRequired:this.loginRequired,messageResponses:this.messageResponses,commentCount:this.commentCount,lastMessageAt:this.lastMessageAt,lastMetricsAt:this.lastMetricsAt,capturedAt:this.capturedAt,pagePath:this.pagePath,error:this.error,width:WIDTH,height:HEIGHT,platformState:this.platformState,liveId:this.liveId,reconnects:this.reconnects,metrics:Object.fromEntries(Object.entries(this.fields).filter(([,item])=>Date.now()-item.at<=30000))}}
  getFrame(){return this.frame}
  emit(){this.onStatus(this.status())}
  _state(value){this.state=value;this.emit()}

  async connect(){
    if(this.closed)throw new Error('视频号采集器已关闭')
    if(this.captureFailed){await this.disconnect();this.captureFailed=false}
    this.wanted=true
    if(this.connecting)return this.connecting
    if(this.browser?.connected&&this.page&&!this.page.isClosed()){
      if(this.state==='error')await this.page.goto(ENTRY,{waitUntil:'domcontentloaded',timeout:30000})
      await this.capture();return this.status()
    }
    const generation=++this.generation
    this.connecting=this._connect(generation).finally(()=>{this.connecting=null})
    return this.connecting
  }
  async _connect(generation){
    this.error='';this._state('connecting')
    const executablePath=chromiumPath()
    if(!executablePath){this.error='未检测到 Chromium，请完成服务器依赖安装';this._state('error');throw new Error(this.error)}
    const profile=join(this.dataDir,'channels-profile');mkdirSync(profile,{recursive:true,mode:0o700})
    const args=['--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--mute-audio']
    if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
    try{
      const browser=await this.launch({executablePath,userDataDir:profile,headless:true,protocolTimeout:30000,timeout:30000,defaultViewport:{width:WIDTH,height:HEIGHT,deviceScaleFactor:1},handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,args})
      if(generation!==this.generation||!this.wanted){await closePlatformBrowser(browser);return this.status()}
      this.browser=browser;this.page=await browser.newPage();this._attach(this.page,generation)
      browser.on('targetcreated',async target=>{if(target.type()!=='page'||generation!==this.generation)return;const page=await target.page();if(page)this._attach(page,generation)})
      browser.once('disconnected',()=>{
        if(generation!==this.generation)return
        this.browser=null;this.page=null;clearInterval(this.timer);this.timer=null
        if(this.wanted&&!this.closed&&this.reconnects<3){this.error='视频号浏览器意外断开';this._state('reconnecting');const delay=1000*2**this.reconnects++;this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;if(this.wanted&&!this.closed)this.connect().catch(()=>{})},delay);this.reconnectTimer.unref?.()}
        else this._state(this.wanted?'error':'disconnected')
      })
      await this.page.goto(ENTRY,{waitUntil:'domcontentloaded',timeout:30000})
      if(generation!==this.generation||!this.wanted)return this.status()
      await this.capture();this.timer=setInterval(()=>this.capture().catch(error=>{if(generation===this.generation&&this.wanted){this.error=safeError(error);this._state('error')}}),3000);this.timer.unref?.()
      return this.status()
    }catch(error){if(generation!==this.generation||!this.wanted)return this.status();this.error=safeError(error);this._state('error');throw new Error('视频号后台连接失败：'+this.error)}
  }

  _attach(page,generation){
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
            this.page=page;this.messageResponses++;this.lastMessageAt=now
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
    if(this.loginRequired)this.state='login-required'
    else if(this.platformState==='ended')this.state='ended'
    else if(this.lastMessageAt&&Date.now()-this.lastMessageAt<30000&&(this.platformState==='live'||this.commentCount>0))this.state='receiving'
    else this.state='connected-no-live-data'
    this.emit()
  }
  async capture(){
    if(this.capturing||this.captureFailed||!this.page||this.page.isClosed()||!this.browser?.connected)return
    this.capturing=true
    const generation=this.generation
    try{
      const page=this.page,state=await page.evaluate(readChannelsLoginState)
      if(generation!==this.generation||!this.wanted)return
      this.pagePath=String(state.path||'').slice(0,180);this.loginRequired=state.loginRequired
      const frame=await browserDeadline(page.screenshot({type:'jpeg',quality:78,optimizeForSpeed:true}),10000,'视频号登录截图超时，请重新连接')
      if(generation!==this.generation||!this.wanted)return
      this.frame=Buffer.from(frame);this.capturedAt=Date.now()
      if(!this.loginRequired&&Date.now()-this.lastDomAt>=5000&&(this.pagePath.includes('/platform/live/liveBuild')||Date.now()-this.lastMessageAt<30000)){
        this.lastDomAt=Date.now();const labels=CHANNEL_METRICS.flatMap(metric=>metric.labels)
        const rows=await page.evaluate(readChannelsMetricTiles,labels)
        if(generation!==this.generation||!this.wanted)return
        this._mergeMetrics(extractChannelsDomMetrics(rows))
      }
      this.error='';this._updateState();await this._deliverMetrics()
    }catch(error){if(error.code==='STUDIO_BROWSER_TIMEOUT'&&generation===this.generation&&this.wanted){this.captureFailed=true;clearInterval(this.timer);this.timer=null;this.error=safeError(error);this._state('error')}throw error}
    finally{this.capturing=false}
  }

  async click({x,y}){
    if(!loginClickAllowed(this.state,{x,y})||!this.page||this.page.isClosed())throw new Error('只能在扫码登录页点击有效的登录或二维码刷新控件')
    const allowed=await this.page.evaluate(({x,y})=>{
      const hit=document.elementFromPoint(x,y),control=hit?.closest('button,a,[role="button"],label,[class*="qrcode"],[class*="qr-code"],[class*="refresh"]')
      if(!control)return false
      const text=(control.innerText||control.getAttribute('aria-label')||control.getAttribute('title')||'').trim()
      if(/发送|开播|结束直播|删除|创建直播/.test(text))return false
      return /登录|刷新|重新加载|二维码|同意|授权|重新获取|重新扫码/.test(text)||/qrcode|qr-code|refresh/i.test(String(control.className))
    },{x,y})
    if(!allowed)throw new Error('该位置不是允许的登录或二维码刷新控件')
    await this.page.mouse.click(x,y);await this.capture();return this.status()
  }
  async disconnect(){
    this.wanted=false;this.generation++;clearInterval(this.timer);this.timer=null;clearTimeout(this.reconnectTimer);this.reconnectTimer=null
    const browser=this.browser;this.browser=null;this.page=null;this.frame=null;this.loginRequired=false
    if(browser)await closePlatformBrowser(browser)
    await this.connecting?.catch(()=>{})
    this._state('disconnected');return this.status()
  }
  async close(){this.closed=true;await this.disconnect()}
}
