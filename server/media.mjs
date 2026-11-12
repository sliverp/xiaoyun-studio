import {existsSync, mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import puppeteer from 'puppeteer-core'
import ffmpegStatic from 'ffmpeg-static'
import {AudioMixer} from './audio-mixer.mjs'
import {OutputGraph,normalizeDestinations,joinStreamDestination,redactMediaError,buildEncoderArgs} from './media-output.mjs'
export {joinStreamDestination,redactMediaError}
export const buildOutputArgs=buildEncoderArgs
import {createPresentationNetworkPolicy} from './media-network.mjs'
import {closePlatformBrowser} from './platform-browser.mjs'
import {containerMemory,renderMaintenance} from './render-resources.mjs'

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const chromeCandidates=()=>[process.env.CHROMIUM_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean)
const ffmpegCandidates=()=>[process.env.FFMPEG_PATH,ffmpegStatic,'/usr/bin/ffmpeg','/usr/local/bin/ffmpeg'].filter(Boolean)
/** Discover installed executables without opening a browser or contacting a streaming platform. */
export function detectTools(){
  const chromium=chromeCandidates().find(existsSync)||null,ffmpeg=ffmpegCandidates().find(existsSync)||null
  return {chromium:{available:Boolean(chromium),path:chromium},ffmpeg:{available:Boolean(ffmpeg),path:ffmpeg},ready:Boolean(chromium&&ffmpeg)}
}
/** Own isolated browser rendering, continuous audio mixing, recording and RTMP output. */
export class MediaEngine {
  constructor({dataDir,baseUrl,renderToken,getSettings,onStatus=()=>{},onMeter=()=>{},onFrame=()=>{},onAudio=()=>{},launch=options=>puppeteer.launch(options)}){
    Object.assign(this,{dataDir,baseUrl,renderToken,getSettings,onStatus,onMeter,onFrame,onAudio,launch})
    this.networkPolicy=createPresentationNetworkPolicy(baseUrl)
    this.tools=detectTools();this.browser=null;this.programPage=null;this.deckPage=null;this.deckLastUrl='';this.browserHealthy=false;this.browserRecovery=null;this.browserRetryTimer=null;this.resolveBrowserRetry=null;this.initializing=null;this.closingPromise=null;this.closed=false;this.captureTimer=null;this.frame=null;this.slideFrame=null;this.slide={pageNumber:0,pageCount:0,pageKey:'',title:'',text:'',notes:'',revision:0};this.lastSlideHash='';this.captureCount=0;this.lastCaptureReport=performance.now();this.captureFps=0;this.droppedFrames=0;this.capturing=false;this.screenshotTail=Promise.resolve();this.deckTail=Promise.resolve();this.deckBusy=false;this.lastError='';this.meter={rms:0,voiceRms:0,bgmRms:0}
    this.browserCleanup=null;this.browserCleanups=new WeakMap();this.captureOwner=null;this.browserRetryAt=0;this.browserOpenedAt=0;this.lastMaintenanceAt=0;this.maintenanceTimer=null
    mkdirSync(dataDir,{recursive:true})
    this.outputGraph=new OutputGraph({ffmpeg:this.tools.ffmpeg.path,dataDir,getFrame:()=>this.frame,renderToken,onStatus:()=>this.emit(),onDrop:()=>{this.droppedFrames++}})
    if(this.tools.ffmpeg.available)this.mixer=new AudioMixer({ffmpeg:this.tools.ffmpeg.path,onPcm:buffer=>this.writePcm(buffer),canOutput:()=>!this.output?.audioBlocked,onMeter:meter=>{this.meter=meter;this.onMeter(meter)}})
  }
  get output(){return this.outputGraph.encoder}
  browserReady(){return Boolean(this.browserHealthy&&this.browser&&this.browser.connected!==false&&this.programPage&&!this.programPage.isClosed?.())}
  status(){return {ready:this.browserReady(),initialized:this.browserReady(),fps:this.getSettings().output?.fps||15,currentFps:this.captureFps,droppedFrames:this.droppedFrames,browserRecovering:Boolean(this.browserRecovery),rendering:Boolean(this.captureTimer&&this.browserReady()),captureFps:this.captureFps,width:this.programPage?.viewport()?.width||0,height:this.programPage?.viewport()?.height||0,slide:{...this.slide},audio:{...this.meter,queued:this.mixer?.queue.length||0},output:this.outputGraph.status(),error:this.lastError}}
  emit(){this.onStatus(this.status())}
  async initialize(){
    if(this.closed)throw new Error('渲染引擎已关闭')
    if(this.initializing)return this.initializing
    if(this.browserReady())return
    if(Date.now()<this.browserRetryAt)throw new Error('后台渲染暂未恢复，将在稍后自动重试')
    this.initializing=(async()=>{
      await this.browserCleanup
      if(this.closed)throw new DOMException('渲染启动已取消','AbortError')
      if(this.browser)await this.releaseBrowser(this.browser)
      await this.openBrowser()
    })().finally(()=>{this.initializing=null})
    return this.initializing
  }
  /** Detach references before closing; an old page event can never tear down a replacement. */
  releaseBrowser(owned){
    if(!owned)return this.browserCleanup||Promise.resolve()
    if(this.browserCleanups.has(owned))return this.browserCleanups.get(owned)
    if(this.browser===owned){this.browserHealthy=false;this.browser=null;this.programPage=null;this.deckPage=null;this.captureOwner=null;this.capturing=false;this.captureFps=0;this.captureCount=0;this.lastCaptureReport=performance.now();clearInterval(this.captureTimer);this.captureTimer=null;clearInterval(this.maintenanceTimer);this.maintenanceTimer=null;this.screenshotTail=Promise.resolve()}
    const cleanup=Promise.resolve(this.browserCleanup).then(()=>closePlatformBrowser(owned))
    const settled=cleanup.finally(()=>{if(this.browserCleanup===settled)this.browserCleanup=null})
    this.browserCleanups.set(owned,settled);this.browserCleanup=settled;return settled
  }
  loseBrowser(owned,reason){
    if(this.closed||owned!==this.browser)return
    const recover=this.browserHealthy
    this.lastError=reason
    const cleanup=this.releaseBrowser(owned)
    cleanup.catch(()=>{/* A later launch still waits for bounded cleanup of this owned browser. */})
    this.emit()
    if(recover)void this.recoverBrowser()
  }
  watchPage(page,owned){
    page.on('error',()=>this.loseBrowser(owned,'后台渲染页面意外退出，正在自动重建画面'))
    page.once('close',()=>this.loseBrowser(owned,'后台渲染页面已关闭，正在自动重建画面'))
  }
  maintainBrowser(){
    if(!this.browserReady()||this.initializing||this.browserRecovery)return
    const now=Date.now(),reason=renderMaintenance({now,openedAt:this.browserOpenedAt,lastMaintenanceAt:this.lastMaintenanceAt,outputRunning:this.outputGraph.status().running,voiceActive:Boolean(this.mixer?.queue.length),memory:containerMemory()})
    if(reason){this.lastMaintenanceAt=now;this.loseBrowser(this.browser,reason)}
  }
  async openBrowser(){
    if(!this.tools.ready)throw new Error('缺少 Chromium 或 FFmpeg，请先完成部署依赖安装')
    const settings=this.getSettings(),output=settings.output||{},width=output.width||1280,height=output.height||720
    const profile=join(this.dataDir,'renderer-profile');mkdirSync(profile,{recursive:true})
    const args=['--autoplay-policy=no-user-gesture-required','--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--mute-audio']
    if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
    const savedUrl=this.deckLastUrl,savedPage=this.slide.pageNumber;let owned
    try{
      owned=await this.launch({executablePath:this.tools.chromium.path,userDataDir:profile,headless:true,protocolTimeout:30000,defaultViewport:{width,height,deviceScaleFactor:1},handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,args})
      if(this.closed){throw new DOMException('渲染启动已取消','AbortError')}
      this.browser=owned
      owned.once('disconnected',()=>{
        this.loseBrowser(owned,'后台渲染浏览器断开，正在尝试恢复')
      })
      // Reuse Chromium's initial blank tab instead of keeping an unused renderer alive.
      this.programPage=(await owned.pages()).find(page=>!page.isClosed()&&page.url()==='about:blank')||await owned.newPage()
      this.watchPage(this.programPage,owned)
      await this.authenticateLocalRequests(this.programPage)
      await this.programPage.setBypassServiceWorker(true);await this.programPage.setCacheEnabled(false)
      const url=new URL('/program',this.baseUrl);url.searchParams.set('renderToken',this.renderToken)
      await this.programPage.goto(url.href,{waitUntil:'domcontentloaded',timeout:30000})
      await this.programPage.evaluate(()=>document.fonts.ready)
      await sleep(200);if(this.closed||this.browser!==owned)throw new DOMException('渲染启动已取消','AbortError')
      if(savedUrl)await this.withDeck(async()=>{await this.openDeck(savedUrl);if(savedPage>0&&this.slide.pageNumber!==savedPage)await this.restoreDeck(savedPage)})
      await this.capture();if(this.closed||this.browser!==owned||this.programPage.isClosed())throw new DOMException('渲染启动已取消','AbortError')
      this.browserHealthy=true;this.browserRetryAt=0;this.browserOpenedAt=Date.now();this.startCapture();this.lastError=''
      this.maintenanceTimer=setInterval(()=>this.maintainBrowser(),30000);this.maintenanceTimer.unref?.();this.emit()
    }catch(error){
      const detail=redactMediaError(error.message,[this.renderToken]),message=/Session closed|Target closed|Connection closed|Page crashed|page has been closed/i.test(detail)?'渲染页面意外退出，请稍后重试':detail
      await this.releaseBrowser(owned).catch(()=>{});if(!this.closed){this.lastError=message;this.browserRetryAt=Date.now()+1000;queueMicrotask(()=>{if(!this.closed&&!this.browserRecovery&&!this.browserReady())void this.recoverBrowser()})}
      if(error.name==='AbortError')throw error
      throw new Error('后台渲染初始化失败：'+message)
    }
  }
  async recoverBrowser(){
    if(this.closed||this.browserRecovery)return
    const recovery=(async()=>{
      for(let attempt=0;attempt<3&&!this.closed;attempt++){
        await new Promise(resolve=>{this.resolveBrowserRetry=resolve;this.browserRetryTimer=setTimeout(resolve,1000*2**attempt)});this.browserRetryTimer=null;this.resolveBrowserRetry=null;if(this.closed)return
        try{await this.initialize();this.lastError='';this.emit();return}
        catch(cause){this.lastError='渲染恢复失败：'+redactMediaError(cause.message,[this.renderToken]);this.emit()}
      }
      if(!this.closed){this.browserRetryAt=Date.now()+30000;this.lastError='后台渲染暂未恢复，将在30秒后自动重试';this.browserRetryTimer=setTimeout(()=>{this.browserRetryTimer=null;if(!this.closed&&!this.browserReady())void this.recoverBrowser()},30000);this.browserRetryTimer.unref?.();this.emit()}
    })()
    this.browserRecovery=recovery
    try{await recovery}finally{if(this.browserRecovery===recovery)this.browserRecovery=null;this.emit()}
  }
  startCapture(){
    if(this.closed)return
    if(this.captureTimer)clearInterval(this.captureTimer)
    const fps=Math.max(5,Math.min(30,this.getSettings().output?.fps||15))
    this.captureTimer=setInterval(()=>this.capture().catch(error=>{if(!this.closed&&error.name!=='AbortError'&&!this.browserRecovery){this.lastError=redactMediaError(error.message,[this.renderToken]);this.emit()}}),1000/fps)
  }
  async capture(){
    if(this.closed||!this.programPage||this.capturing||this.deckBusy)return
    this.capturing=true;const capture={},owned=this.browser,page=this.programPage;this.captureOwner=capture
    try{
      const frame=await this.snapshotPage(page,{type:'jpeg',quality:82,optimizeForSpeed:true})
      if(this.closed||this.browser!==owned||this.programPage!==page)return
      this.frame=Buffer.from(frame)
      this.onFrame(this.frame);this.captureCount++
      const now=performance.now();if(now-this.lastCaptureReport>=2000){this.captureFps=Math.round(this.captureCount*10000/(now-this.lastCaptureReport))/10;this.captureCount=0;this.lastCaptureReport=now;this.emit()}
    }finally{if(this.captureOwner===capture){this.captureOwner=null;this.capturing=false}}
  }
  /** Keep tab activation and screenshots sequential; a stuck capture restarts only the owned browser. */
  snapshotPage(page,options){
    const owned=this.browser
    const task=this.screenshotTail.then(async()=>{
      if(this.closed||!owned||owned!==this.browser||page.isClosed())throw new DOMException('渲染页面已关闭','AbortError')
      let timer
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('后台画面截图超过10秒，正在恢复渲染浏览器'),{code:'RENDER_TIMEOUT'})),10000)})
      try{
        return await Promise.race([(async()=>{await page.bringToFront();return page.screenshot(options)})(),deadline])
      }catch(error){
        if(this.closed||this.browser!==owned)throw new DOMException('旧渲染请求已取消','AbortError')
        if(error.code==='RENDER_TIMEOUT'&&this.browser===owned&&!this.closed){this.lastError=error.message;owned.process()?.kill('SIGKILL')}
        else if(/Session closed|Target closed|Connection closed|Page crashed|page has been closed/i.test(error.message))this.loseBrowser(owned,'后台渲染页面意外退出，正在自动重建画面')
        throw error
      }finally{clearTimeout(timer)}
    })
    this.screenshotTail=task.then(()=>{},()=>{})
    return task
  }
  /** Let asynchronous deck rendering finish in its active tab while the encoder repeats the last frame. */
  withDeck(operation){
    const task=this.deckTail.then(async()=>{
      if(this.closed)throw new DOMException('渲染引擎已关闭','AbortError')
      this.deckBusy=true
      try{await this.screenshotTail;return await operation()}finally{this.deckBusy=false}
    })
    this.deckTail=task.then(()=>{},()=>{})
    return task
  }
  getFrame(){return this.frame}
  getSlideFrame(){return this.slideFrame}
  async authenticateLocalRequests(page){
    const origin=new URL(this.baseUrl).origin
    await page.setRequestInterception(true)
    page.on('request',async request=>{
      try{
        const {local}=await this.networkPolicy(request.url())
        const authenticated=local&&['GET','HEAD'].includes(request.method()),headers={...request.headers()}
        delete headers['x-render-token'];if(authenticated)headers['x-render-token']=this.renderToken
        await request.continue({headers})
      }catch{await request.abort('blockedbyclient').catch(()=>{/* A closed page already discarded this intercepted request. */})}
    })
  }
  presentationUrl(value){
    const url=new URL(value,this.baseUrl)
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('演示稿只支持 HTTP/HTTPS 地址')
    return url
  }
  async openPresentation(url){
    await this.initialize();return this.withDeck(()=>this.openDeck(url))
  }
  async openDeck(url){
    let target=this.presentationUrl(url);await this.networkPolicy(target.href)
    const original=target
    if(original.origin===new URL(this.baseUrl).origin&&original.pathname.startsWith('/assets/')&&/\.pdf$/i.test(original.pathname)){
      target=new URL('/pdf-viewer',this.baseUrl);target.searchParams.set('file',original.href)
    }
    if(!this.deckPage||this.deckPage.isClosed()){this.deckPage=await this.browser.newPage();this.watchPage(this.deckPage,this.browser);await this.authenticateLocalRequests(this.deckPage)}
    await this.deckPage.bringToFront()
    await this.deckPage.setViewport({width:1280,height:720,deviceScaleFactor:1});await this.deckPage.setBypassServiceWorker(true);await this.deckPage.setCacheEnabled(false)
    await this.deckPage.goto(target.href,{waitUntil:'domcontentloaded',timeout:30000})
    await this.deckPage.evaluate(()=>document.fonts.ready)
    if(target.pathname==='/pdf-viewer'){
      await this.deckPage.waitForFunction(()=>window.studioPdfReady||window.studioPdfError,{timeout:30000})
      await this.deckPage.evaluate(async()=>{if(window.studioPdfReady)await window.studioPdfReady;if(window.studioPdfError)throw new Error(window.studioPdfError)})
    }
    await sleep(150);this.deckLastUrl=this.deckPage.url()
    return this.readDeck()
  }
  captureSlide(){return this.withDeck(()=>this.readDeck())}
  async readDeck(){
    if(!this.deckPage||this.deckPage.isClosed())return {...this.slide}
    await this.deckPage.bringToFront()
    const state=await this.deckPage.evaluate(()=>{
      const root=['.reveal .slides section.present','.remark-visible .remark-slide-content','.slide.active','[data-slide].active','[aria-current="step"]'].map(selector=>document.querySelector(selector)).find(Boolean)||document.body
      const numbered=document.querySelector('[data-slide-count]'),counter=document.querySelector('#counter'),all=[...document.querySelectorAll('.slide')]
      const match=counter?.textContent?.match(/(\d+)\s*\/\s*(\d+)/)
      const reveal=window.Reveal,remark=window.slideshow
      const reportedNumber=numbered?.getAttribute('data-slide-number')||match?.[1]||(typeof reveal?.getIndices==='function'?reveal.getIndices().h+1:0)||(typeof remark?.getCurrentSlideIndex==='function'?remark.getCurrentSlideIndex()+1:0)||(all.length?all.indexOf(root)+1:1)
      const pageNumber=Math.max(1,Math.min(5000,Number(reportedNumber)||1))
      const reportedCount=numbered?.getAttribute('data-slide-count')||match?.[2]||(typeof reveal?.getTotalSlides==='function'?reveal.getTotalSlides():0)||(typeof remark?.getSlideCount==='function'?remark.getSlideCount():0)||all.length
      const pageCount=Math.max(pageNumber,Math.min(5000,Number(reportedCount)||1))
      const copy=root.cloneNode(true);copy.querySelectorAll('script,style,.dsh-speaker-notes,[hidden]').forEach(node=>node.remove())
      const text=(copy.textContent||'').replace(/\s+/g,' ').trim().slice(0,12000)
      const identity=new URL(location.href);identity.hash='';identity.searchParams.delete('renderToken');identity.searchParams.delete('page')
      return {pageNumber,pageCount,title:document.title.slice(0,300),text,notes:(root.querySelector('.dsh-speaker-notes')?.textContent||'').trim().slice(0,6000),pageKey:identity.href+'|'+pageNumber}
    })
    this.slideFrame=Buffer.from(await this.snapshotPage(this.deckPage,{type:'jpeg',quality:88,optimizeForSpeed:true}))
    const hash=createHash('sha256').update(this.slideFrame).digest('hex')
    if(hash!==this.lastSlideHash){this.slide={...state,revision:this.slide.revision+1};this.lastSlideHash=hash}else this.slide={...this.slide,...state}
    this.deckLastUrl=this.deckPage.url();this.emit();return {...this.slide}
  }
  async readSlide(){return this.captureSlide()}
  /** Read ahead from deck DOM/PDF text without navigating or capturing the on-air slide. */
  async readSlideAt(number){
    if(!Number.isInteger(number)||number<1||number>this.slide.pageCount||!this.deckPage||this.deckPage.isClosed())return null
    return this.deckPage.evaluate(async({number,total})=>{
      let content
      if(typeof window.studioDeck?.readSlide==='function')content=await window.studioDeck.readSlide(number)
      else{
        const groups=['.slide','.remark-slide-content','.reveal .slides section','[data-slide]'].map(selector=>[...document.querySelectorAll(selector)].filter(root=>selector!=='.reveal .slides section'||!root.querySelector('section')))
        const all=groups.find(roots=>roots.length===total),root=all?.[number-1]
        if(!root)return null
        const copy=root.cloneNode(true);copy.querySelectorAll('script,style,.dsh-speaker-notes,[hidden]').forEach(node=>node.remove())
        content={title:document.title.slice(0,300),text:(copy.textContent||'').replace(/\s+/g,' ').trim().slice(0,12000),notes:(root.querySelector('.dsh-speaker-notes')?.textContent||'').trim().slice(0,6000)}
      }
      if(!content||typeof content.text!=='string')return null
      const identity=new URL(location.href);identity.hash='';identity.searchParams.delete('renderToken');identity.searchParams.delete('page')
      return {pageNumber:number,pageCount:total,pageKey:identity.href+'|'+number,title:String(content.title||document.title).slice(0,300),text:content.text.slice(0,12000),notes:String(content.notes||'').slice(0,6000)}
    },{number,total:this.slide.pageCount})
  }
  async waitForSlide(target){
    try{await this.deckPage.waitForFunction(target=>{
      const numbered=document.querySelector('[data-slide-count]'),counter=document.querySelector('#counter'),match=counter?.textContent?.match(/(\d+)\s*\/\s*(\d+)/)
      const current=Number(numbered?.getAttribute('data-slide-number')||match?.[1]||(typeof window.Reveal?.getIndices==='function'?window.Reveal.getIndices().h+1:0)||(typeof window.slideshow?.getCurrentSlideIndex==='function'?window.slideshow.getCurrentSlideIndex()+1:0))
      return current===target&&!window.studioPdfLoading
    },{timeout:10000},target)}catch{throw new Error('演示稿未确认目标页，请检查网页的翻页实现')}
  }
  restoreSlide(target){return this.withDeck(()=>this.restoreDeck(target))}
  async restoreDeck(target){
    const current=this.slide.pageNumber
    await this.deckPage.bringToFront()
    const handled=await this.deckPage.evaluate(async({target,current})=>{
      if(typeof window.studioDeck?.goToSlide==='function')return await window.studioDeck.goToSlide(target)!==false
      if(typeof window.dshLiveDeck?.goToSlide==='function')return await window.dshLiveDeck.goToSlide(target)!==false
      if(typeof window.Reveal?.slide==='function'){window.Reveal.slide(target-1);return true}
      if(typeof window.slideshow?.gotoSlide==='function'){window.slideshow.gotoSlide(target);return true}
      const select=document.querySelector('#pages');if(select){select.value=String(target);select.dispatchEvent(new Event('change',{bubbles:true}));return true}
      const direction=target>current?'nextSlide':'prevSlide',steps=Math.abs(target-current)
      if(steps<=100&&typeof window[direction]==='function'){for(let i=0;i<steps;i++)await window[direction]();return true}
      return false
    },{target,current})
    if(!handled)throw new Error('演示稿不支持恢复原页，请手动切换后继续')
    await this.waitForSlide(target);return this.readDeck()
  }
  moveSlide(direction){return this.withDeck(()=>this.moveDeck(direction))}
  async moveDeck(direction){
    if(!this.deckPage||this.deckPage.isClosed())throw new Error('请先打开演示稿')
    const before=this.slide.pageNumber
    await this.deckPage.bringToFront()
    const handled=await this.deckPage.evaluate(async direction=>{
      if(direction==='first'){
        if(typeof window.studioDeck?.goToSlide==='function')return await window.studioDeck.goToSlide(1)!==false
        if(typeof window.dshLiveDeck?.goToSlide==='function')return await window.dshLiveDeck.goToSlide(1)!==false
        if(typeof window.Reveal?.slide==='function'){window.Reveal.slide(0);return true}
        if(typeof window.slideshow?.gotoSlide==='function'){window.slideshow.gotoSlide(1);return true}
        const select=document.querySelector('#pages');if(select){select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));return true}
        return false
      }
      if(typeof window.Reveal?.[direction]==='function'){window.Reveal[direction]();return true}
      const remark=direction==='next'?'gotoNextSlide':'gotoPreviousSlide';if(typeof window.slideshow?.[remark]==='function'){window.slideshow[remark]();return true}
      const fn=direction==='next'?'nextSlide':'prevSlide';if(typeof window[fn]==='function')return await window[fn]()!==false
      const button=document.querySelector(direction==='next'?'#next':'#prev');if(button&&!button.disabled){button.click();return true}
      return false
    },direction)
    if(!handled)await this.deckPage.keyboard.press(direction==='first'?'Home':direction==='next'?'ArrowRight':'ArrowLeft')
    const target=direction==='first'?1:before+(direction==='next'?1:-1)
    if(target>=1&&target<=this.slide.pageCount&&target!==before){
      await this.waitForSlide(target)
    }
    await sleep(100)
    const result=await this.readDeck()
    if(direction==='next'&&before<this.slide.pageCount&&result.pageNumber===before)throw new Error('演示稿没有确认下一页，请使用支持翻页的 HTML 演示稿')
    if(direction==='first'&&result.pageNumber!==1)throw new Error('演示稿没有回到第一页')
    return result
  }
  nextSlide(){return this.moveSlide('next')}
  previousSlide(){return this.moveSlide('prev')}
  firstSlide(){return this.moveSlide('first')}
  playAudio(path,options){if(!this.mixer)return Promise.reject(new Error('缺少 FFmpeg 音频解码器'));return this.mixer.play(path,options)}
  pauseAudio(){this.mixer?.pause();this.emit()}
  resumeAudio(){this.mixer?.resume();this.emit()}
  stopAudio(){this.mixer?.stop();this.emit()}
  setBgm(path,options){this.mixer?.setBgm(path,options);this.emit()}
  writePcm(buffer){
    try{this.onAudio(buffer)}catch{/* A disconnected operator monitor must not interrupt the broadcast audio clock. */}
    this.outputGraph.writePcm(buffer)
  }
  validateOutput(value){
    const width=value.width||1280,height=value.height||720,fps=value.fps||15
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<640||height<360||width>3840||height>2160||width%2||height%2)throw new Error('输出分辨率应为偶数，范围640×360至3840×2160')
    if(!Number.isInteger(fps)||fps<5||fps>30)throw new Error('输出帧率应为5–30')
    const videoBitrate=typeof value.videoBitrate==='number'?value.videoBitrate+'k':value.videoBitrate||'2500k',audioBitrate=typeof value.audioBitrate==='number'?value.audioBitrate+'k':value.audioBitrate||'128k'
    if(!/^\d{2,5}k$/.test(videoBitrate)||!/^\d{2,3}k$/.test(audioBitrate))throw new Error('请输入有效的音视频码率，例如2500k和128k')
    return {width,height,fps,videoBitrate,audioBitrate}
  }
  /** Register cancellable output intent before preparing optional decks/BGM; a stopped prepare cannot start encoding. */
  async startOutput(value,{prepare}={}){
    if(prepare!==undefined&&typeof prepare!=='function')throw new Error('输出准备回调无效')
    const options=this.validateOutput(value),destinations=normalizeDestinations(value)
    await this.outputGraph.start({...options,destinations,record:value.record===true},async({signal})=>{
      signal.throwIfAborted();await this.initialize();signal.throwIfAborted();await prepare?.({signal});signal.throwIfAborted()
      await this.programPage.setViewport({width:options.width,height:options.height,deviceScaleFactor:1});signal.throwIfAborted();await this.capture()
    })
    return this.status()
  }
  async addDestination(value){
    if(!this.outputGraph.status().running)return this.startOutput({...this.getSettings().output,destinations:[value]})
    await this.outputGraph.addDestination(value);return this.status()
  }
  async stopDestination(id){await this.outputGraph.stopDestination(id);return this.status()}
  async retryDestination(id){await this.outputGraph.retryDestination(id);return this.status()}
  async stopOutput(){await this.outputGraph.stop();return this.status()}
  /** Wait for pending browser launches and all owned media cleanup before releasing the renderer profile. */
  async close(){
    if(this.closingPromise)return this.closingPromise
    this.closed=true;clearTimeout(this.browserRetryTimer);this.resolveBrowserRetry?.();this.resolveBrowserRetry=null;clearInterval(this.captureTimer);this.captureTimer=null;clearInterval(this.maintenanceTimer);this.maintenanceTimer=null
    const initializing=this.initializing,browser=this.browser;this.browser=null
    this.closingPromise=(async()=>{
      const closeBrowser=async()=>{
        const cleanup=await Promise.allSettled([Promise.resolve().then(()=>browser&&this.releaseBrowser(browser)),Promise.resolve(this.browserCleanup),Promise.resolve(initializing).catch(()=>{/* The initialization caller receives its startup error; shutdown still waits for late-launch cleanup. */})])
        if(this.browser&&this.browser!==browser){const late=this.browser;cleanup.push(...await Promise.allSettled([this.releaseBrowser(late)]))}
        const errors=cleanup.filter(result=>result.status==='rejected').map(result=>result.reason)
        if(errors.length===1)throw errors[0]
        if(errors.length>1)throw new AggregateError(errors,'渲染浏览器关闭失败')
      }
      const cleanup=await Promise.allSettled([Promise.resolve().then(()=>this.mixer?.close()),Promise.resolve().then(()=>this.outputGraph.close()),closeBrowser()])
      this.browser=null;this.programPage=null;this.deckPage=null;clearInterval(this.captureTimer);this.captureTimer=null
      const errors=cleanup.filter(result=>result.status==='rejected').map(result=>result.reason)
      if(errors.length===1)throw errors[0]
      if(errors.length>1)throw new AggregateError(errors,'媒体资源关闭失败')
    })()
    return this.closingPromise
  }
}
