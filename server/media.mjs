import {spawn} from 'node:child_process'
import {existsSync, mkdirSync} from 'node:fs'
import {resolve,join,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import puppeteer from 'puppeteer-core'
import ffmpegStatic from 'ffmpeg-static'
import {AudioMixer,SAMPLE_RATE,CHANNELS} from './audio-mixer.mjs'
import {createPresentationNetworkPolicy} from './media-network.mjs'

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const chromeCandidates=()=>[process.env.CHROMIUM_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean)
const ffmpegCandidates=()=>[process.env.FFMPEG_PATH,ffmpegStatic,'/usr/bin/ffmpeg','/usr/local/bin/ffmpeg'].filter(Boolean)
/** Discover installed executables without opening a browser or contacting a streaming platform. */
export function detectTools(){
  const chromium=chromeCandidates().find(existsSync)||null,ffmpeg=ffmpegCandidates().find(existsSync)||null
  return {chromium:{available:Boolean(chromium),path:chromium},ffmpeg:{available:Boolean(ffmpeg),path:ffmpeg},ready:Boolean(chromium&&ffmpeg)}
}
/** Redact destination keys, URL credentials and render tokens from subprocess diagnostics. */
export function redactMediaError(text,secrets=[]){
  let value=String(text||'')
  for(const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length))value=value.split(String(secret)).join('[redacted]')
  return value.replace(/(?:rtmps?:\/\/)[^\s'"<>]+/gi,'[RTMP destination]').replace(/([?&](?:renderToken|token|key|secret)=)[^&\s]+/gi,'$1[redacted]').slice(-1800)
}
/** Validate the output destination without converting a private key into user-visible state. */
export function joinStreamDestination(rtmpUrl,streamKey=''){
  if(!rtmpUrl)return ''
  let url;try{url=new URL(rtmpUrl)}catch{throw new Error('请输入有效的 RTMP/RTMPS 推流地址')}
  if(!['rtmp:','rtmps:'].includes(url.protocol)||url.username||url.password)throw new Error('推流仅支持不含登录凭据的 RTMP/RTMPS 地址')
  if(/[|\r\n\0]/.test(streamKey)||/[|\r\n\0]/.test(rtmpUrl))throw new Error('推流密钥无效')
  return streamKey?rtmpUrl.replace(/\/+$/,'')+'/'+streamKey:rtmpUrl
}
/** Build an FFmpeg pipeline with independent video and continuous PCM audio inputs. */
export function buildOutputArgs({width,height,fps,videoBitrate,audioBitrate,destination,recordPath}){
  const args=['-hide_banner','-loglevel','warning','-y','-thread_queue_size','128','-probesize','32768','-analyzeduration','0','-f','image2pipe','-framerate',String(fps),'-vcodec','mjpeg','-i','pipe:0','-thread_queue_size','512','-f','s16le','-ar',String(SAMPLE_RATE),'-ac',String(CHANNELS),'-i','pipe:3','-map','0:v:0','-map','1:a:0','-vf',`scale=${width}:${height}:flags=fast_bilinear,format=yuv420p`,'-c:v','libx264','-preset','veryfast','-tune','zerolatency','-b:v',videoBitrate,'-maxrate',videoBitrate,'-bufsize',String(Number.parseInt(videoBitrate)*2)+'k','-g',String(fps*2),'-c:a','aac','-b:a',audioBitrate,'-ar',String(SAMPLE_RATE),'-progress','pipe:4','-stats_period','1']
  const teeUrl=value=>String(value).replace(/[\\'|]/g,character=>'\\'+character)
  if(destination&&recordPath)args.push('-f','tee',`[f=flv]${teeUrl(destination)}|[f=mp4:movflags=+frag_keyframe+empty_moov]${teeUrl(recordPath)}`)
  else if(destination)args.push('-f','flv',destination)
  else args.push('-movflags','+frag_keyframe+empty_moov','-f','mp4',recordPath)
  return args
}

/** Own isolated browser rendering, continuous audio mixing, recording and RTMP output. */
export class MediaEngine {
  constructor({dataDir,baseUrl,renderToken,getSettings,onStatus=()=>{},onMeter=()=>{},onFrame=()=>{},onAudio=()=>{}}){
    Object.assign(this,{dataDir,baseUrl,renderToken,getSettings,onStatus,onMeter,onFrame,onAudio})
    this.networkPolicy=createPresentationNetworkPolicy(baseUrl)
    this.tools=detectTools();this.browser=null;this.programPage=null;this.deckPage=null;this.deckLastUrl='';this.browserHealthy=false;this.browserRecovery=null;this.browserRetryTimer=null;this.resolveBrowserRetry=null;this.initializing=null;this.closed=false;this.captureTimer=null;this.frame=null;this.slideFrame=null;this.slide={pageNumber:0,pageCount:0,pageKey:'',title:'',text:'',notes:'',revision:0};this.lastSlideHash='';this.captureCount=0;this.lastCaptureReport=performance.now();this.captureFps=0;this.droppedFrames=0;this.capturing=false;this.screenshotTail=Promise.resolve();this.deckTail=Promise.resolve();this.deckBusy=false;this.output=null;this.outputWanted=false;this.outputGeneration=0;this.reconnectTimer=null;this.lastOutput={active:false,mode:null,state:'stopped',error:'',seconds:0,recording:false,recordingFile:null};this.lastError='';this.meter={rms:0,voiceRms:0,bgmRms:0};this.reconnects=0
    mkdirSync(dataDir,{recursive:true})
    if(this.tools.ffmpeg.available)this.mixer=new AudioMixer({ffmpeg:this.tools.ffmpeg.path,onPcm:buffer=>this.writePcm(buffer),canOutput:()=>!this.output?.audioBlocked,onMeter:meter=>{this.meter=meter;this.onMeter(meter)}})
  }
  status(){return {ready:Boolean(this.browser&&this.programPage),initialized:Boolean(this.browser&&this.programPage),fps:this.getSettings().output?.fps||15,currentFps:this.captureFps,droppedFrames:this.droppedFrames,browserRecovering:Boolean(this.browserRecovery),rendering:Boolean(this.captureTimer&&this.programPage),captureFps:this.captureFps,width:this.programPage?.viewport()?.width||0,height:this.programPage?.viewport()?.height||0,slide:{...this.slide},audio:{...this.meter,queued:this.mixer?.queue.length||0},output:this.output?{active:this.output.encodedFrames>0,mode:this.output.destination?(this.output.recordPath?'both':'rtmp'):'record',startedAt:this.output.wallStartedAt,state:this.output.state,error:this.output.error,seconds:this.output.seconds,fps:this.output.fps,bytes:this.output.bytes,encodedFrames:this.output.encodedFrames,reconnects:this.reconnects,recording:Boolean(this.output.recordPath),recordingFile:this.output.recordPath?this.output.recordPath.split(/[\\/]/).pop():null}:this.lastOutput,error:this.lastError}}
  emit(){this.onStatus(this.status())}
  async initialize(){
    if(this.closed)throw new Error('渲染引擎已关闭')
    if(this.browser&&this.programPage)return
    if(this.initializing)return this.initializing
    this.initializing=this.openBrowser().finally(()=>{this.initializing=null})
    return this.initializing
  }
  async openBrowser(){
    if(!this.tools.ready)throw new Error('缺少 Chromium 或 FFmpeg，请先完成部署依赖安装')
    const settings=this.getSettings(),output=settings.output||{},width=output.width||1280,height=output.height||720
    const profile=join(this.dataDir,'renderer-profile');mkdirSync(profile,{recursive:true})
    const args=['--autoplay-policy=no-user-gesture-required','--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--mute-audio']
    if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
    try{
      this.browser=await puppeteer.launch({executablePath:this.tools.chromium.path,userDataDir:profile,headless:true,protocolTimeout:30000,defaultViewport:{width,height,deviceScaleFactor:1},handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,args})
      if(this.closed){await this.browser.close();this.browser=null;throw new DOMException('渲染启动已取消','AbortError')}
      const owned=this.browser
      owned.once('disconnected',()=>{
        if(this.browser!==owned)return
        const recover=this.browserHealthy&&!this.closed
        this.browserHealthy=false;this.browser=null;this.programPage=null;this.deckPage=null
        if(recover){this.lastError='后台渲染浏览器断开，正在尝试恢复';this.emit();owned.process()?.kill('SIGTERM');void this.recoverBrowser()}
      })
      this.programPage=await this.browser.newPage()
      await this.authenticateLocalRequests(this.programPage)
      await this.programPage.setBypassServiceWorker(true);await this.programPage.setCacheEnabled(false)
      const url=new URL('/program',this.baseUrl);url.searchParams.set('renderToken',this.renderToken)
      await this.programPage.goto(url.href,{waitUntil:'domcontentloaded',timeout:30000})
      await this.programPage.evaluate(()=>document.fonts.ready)
      await sleep(200);await this.capture();this.startCapture();this.browserHealthy=true;this.lastError='';this.emit()
    }catch(error){this.browserHealthy=false;this.lastError=redactMediaError(error.message,[this.renderToken]);await this.browser?.close().catch(()=>{});this.browser=null;this.programPage=null;throw new Error('后台渲染初始化失败：'+this.lastError)}
  }
  async recoverBrowser(){
    if(this.closed||this.browserRecovery)return
    const targetPage=this.slide.pageNumber,lastUrl=this.deckLastUrl
    const recovery=(async()=>{
      for(let attempt=0;attempt<3&&!this.closed;attempt++){
        await new Promise(resolve=>{this.resolveBrowserRetry=resolve;this.browserRetryTimer=setTimeout(resolve,1000*2**attempt)});this.browserRetryTimer=null;this.resolveBrowserRetry=null;if(this.closed)return
        try{await this.initialize();if(lastUrl){await this.openPresentation(lastUrl);if(targetPage>0&&this.slide.pageNumber!==targetPage)await this.restoreSlide(targetPage)}this.lastError='';this.emit();return}
        catch(cause){this.lastError='渲染恢复失败：'+redactMediaError(cause.message,[this.renderToken]);this.emit()}
      }
    })()
    this.browserRecovery=recovery
    try{await recovery}finally{if(this.browserRecovery===recovery)this.browserRecovery=null;this.emit()}
  }
  startCapture(){
    if(this.captureTimer)clearInterval(this.captureTimer)
    const fps=Math.max(5,Math.min(30,this.getSettings().output?.fps||15))
    this.captureTimer=setInterval(()=>this.capture().catch(error=>{this.lastError=redactMediaError(error.message,[this.renderToken]);this.emit()}),1000/fps)
  }
  async capture(){
    if(this.closed||!this.programPage||this.capturing||this.deckBusy)return
    this.capturing=true
    try{
      this.frame=Buffer.from(await this.snapshotPage(this.programPage,{type:'jpeg',quality:82,optimizeForSpeed:true}))
      this.onFrame(this.frame);this.captureCount++
      const now=performance.now();if(now-this.lastCaptureReport>=2000){this.captureFps=Math.round(this.captureCount*10000/(now-this.lastCaptureReport))/10;this.captureCount=0;this.lastCaptureReport=now;this.emit()}
    }finally{this.capturing=false}
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
        if(error.code==='RENDER_TIMEOUT'&&this.browser===owned&&!this.closed){this.lastError=error.message;owned.process()?.kill('SIGKILL')}
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
    if(!this.deckPage||this.deckPage.isClosed()){this.deckPage=await this.browser.newPage();await this.authenticateLocalRequests(this.deckPage)}
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
    const out=this.output;if(!out||out.stopping||!out.child?.stdio[3]?.writable)return
    if(!out.child.stdio[3].write(buffer)){out.audioBlocked=true;out.audioBlockedSince=performance.now();out.child.stdio[3].once('drain',()=>{if(this.output===out)out.audioBlocked=false})}
  }
  validateOutput(value){
    const width=value.width||1280,height=value.height||720,fps=value.fps||15
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<640||height<360||width>3840||height>2160||width%2||height%2)throw new Error('输出分辨率应为偶数，范围640×360至3840×2160')
    if(!Number.isInteger(fps)||fps<5||fps>30)throw new Error('输出帧率应为5–30')
    const videoBitrate=value.videoBitrate||'2500k',audioBitrate=value.audioBitrate||'128k'
    if(!/^\d{2,5}k$/.test(videoBitrate)||!/^\d{2,3}k$/.test(audioBitrate))throw new Error('请输入有效的音视频码率，例如2500k和128k')
    return {width,height,fps,videoBitrate,audioBitrate}
  }
  async startOutput(value){
    if(this.output||this.outputWanted)throw new Error('输出已经启动，请先停止后再修改推流设置')
    const destination=joinStreamDestination(value.rtmpUrl,value.streamKey),options=this.validateOutput(value)
    if(!destination&&!value.record)throw new Error('请填写推流地址，或启用本地录制')
    const generation=++this.outputGeneration;this.outputWanted=true;this.lastOutput={...this.lastOutput,active:false,state:'preparing',error:''};this.emit()
    try{await this.initialize()}catch(error){if(this.outputGeneration===generation)this.outputWanted=false;throw error}
    if(!this.outputWanted||generation!==this.outputGeneration)throw new DOMException('推流启动已取消','AbortError')
    const directory=join(this.dataDir,'recordings');mkdirSync(directory,{recursive:true})
    const recordPath=value.record?join(directory,new Date().toISOString().replace(/[:.]/g,'-')+'.mp4'):null
    this.reconnects=0
    await this.startEncoder({...options,destination,recordPath,generation,secrets:[value.streamKey,this.renderToken]})
    return this.status()
  }
  async startEncoder(options){
    await this.programPage.setViewport({width:options.width,height:options.height,deviceScaleFactor:1});await this.capture()
    const args=buildOutputArgs(options),child=spawn(this.tools.ffmpeg.path,args,{stdio:['pipe','ignore','pipe','pipe','pipe'],windowsHide:true})
    const out={...options,child,state:'starting',error:'',seconds:0,encodedFrames:0,fps:0,bytes:null,audioBlocked:false,videoBlocked:false,stopping:false,startedAt:performance.now(),wallStartedAt:Date.now(),lastProgressAt:performance.now(),timer:null,watchdog:null,closed:null}
    this.output=out;this.lastError=''
    let errorText='',progress=''
    child.stderr.on('data',buffer=>{errorText=(errorText+buffer.toString()).slice(-6000)})
    child.stdio[4].on('data',buffer=>{progress+=buffer.toString();let line;while((line=progress.indexOf('\n'))>=0){const item=progress.slice(0,line);progress=progress.slice(line+1);const [key,val]=item.split('=');if(key==='frame'){out.encodedFrames=Number(val)||out.encodedFrames;if(out.encodedFrames)out.state='streaming';out.lastProgressAt=performance.now()}if(key==='fps')out.fps=Number(val)||0;if(key==='total_size')out.bytes=Number.isFinite(Number(val))?Number(val):null;if(key==='out_time_us')out.seconds=(Number(val)||0)/1000000;if(key==='progress')this.emit()}})
    for(const stream of [child.stdin,child.stdio[3]])stream.on('error',()=>{})
    child.once('error',()=>{out.error='无法启动 FFmpeg 推流进程';this.lastError=out.error;this.emit()})
    out.closed=new Promise(resolve=>child.once('close',(code,signal)=>{
      clearInterval(out.timer);clearInterval(out.watchdog)
      if(this.output===out)this.output=null
      const error=out.stopping?'':redactMediaError(errorText||'编码进程退出（'+(code??signal)+'）',options.secrets)
      this.lastOutput={active:false,mode:out.destination?(out.recordPath?'both':'rtmp'):'record',state:error?'error':'stopped',error,seconds:out.seconds,bytes:out.bytes,fps:out.fps,encodedFrames:out.encodedFrames,reconnects:this.reconnects,recording:false,recordingFile:out.recordPath?out.recordPath.split(/[\\/]/).pop():null};this.lastError=error;this.emit();resolve()
      if(error&&!this.queueReconnect(options)){this.outputWanted=false;this.emit()}
    }))
    out.timer=setInterval(()=>{
      if(this.output!==out||out.stopping||!this.frame)return
      if(out.videoBlocked){this.droppedFrames++;return}
      if(!child.stdin.write(this.frame)){out.videoBlocked=true;child.stdin.once('drain',()=>{if(this.output===out)out.videoBlocked=false})}
    },1000/options.fps)
    out.watchdog=setInterval(()=>{if(out.stopping)return;const now=performance.now();if(now-out.lastProgressAt>20000||out.audioBlocked&&now-out.audioBlockedSince>10000){errorText='编码器长时间没有输出进度，已停止并尝试重新连接';child.kill('SIGTERM')}},2000)
    this.emit()
    await Promise.race([out.closed.then(()=>{if(!out.stopping&&!this.reconnectTimer)throw new Error('推流启动失败：'+this.lastOutput.error)}),sleep(150)])
  }
  queueReconnect(options){
    if(!this.outputWanted||this.closed||options.generation!==this.outputGeneration||!options.destination||this.reconnects>=3)return false
    const delay=1000*2**this.reconnects;this.reconnects++
    this.lastOutput={...this.lastOutput,state:'reconnecting',reconnects:this.reconnects};this.emit()
    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=null
      if(!this.output&&this.outputWanted&&!this.closed&&options.generation===this.outputGeneration)this.startEncoder({...options,recordPath:options.recordPath?options.recordPath.replace(/\.mp4$/,'.retry'+this.reconnects+'.mp4'):null}).catch(cause=>{this.lastError=redactMediaError(cause.message,options.secrets);this.emit()})
    },delay)
    this.reconnectTimer.unref?.();return true
  }
  async stopOutput(){
    this.outputWanted=false;this.outputGeneration++;clearTimeout(this.reconnectTimer);this.reconnectTimer=null
    const out=this.output
    if(!out){this.lastOutput={...this.lastOutput,state:'stopped',active:false};this.emit();return}
    out.stopping=true;out.state='stopping';clearInterval(out.timer);clearInterval(out.watchdog);out.child.stdin.end();out.child.stdio[3].end();this.emit()
    const killer=setTimeout(()=>out.child.kill('SIGKILL'),5000);killer.unref()
    await out.closed;clearTimeout(killer)
  }
  async close(){if(this.closed)return;this.closed=true;clearTimeout(this.browserRetryTimer);this.resolveBrowserRetry?.();this.resolveBrowserRetry=null;clearInterval(this.captureTimer);this.captureTimer=null;this.mixer?.close();await this.stopOutput();await this.browser?.close().catch(()=>{});this.browser=null;this.programPage=null}
}
