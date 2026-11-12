/** Runs only inside the owned official backend tab; never starts/stops a platform broadcast. */
export function installChannelsWatchdog(options={}){
 const slot='__xiaoyunChannelsWatchdog',origin='https://channels.weixin.qq.com',entry=origin+'/platform/live/liveBuild',revision=2
 if(location.origin!==origin||window!==window.top)return null
 const previous=window[slot]
 if(previous?.revision===revision){Object.assign(previous.options,options);return previous.status}
 if(previous)clearInterval(previous.timer)
 const storageKey='xiaoyun.channels-watchdog.v1'
 let saved={};try{saved=JSON.parse(sessionStorage.getItem(storageKey)||'{}')}catch{}
 const now=Date.now(),state={revision,options:{expectLive:false,blocked:false,graceMs:45000,staleMs:45000,idleMs:30000,tickMs:5000,retryBaseMs:45000,...options},status:{state:'waiting',lastMessageAt:0,retries:Number(saved.retries)||0,lastReloadAt:Number(saved.lastReloadAt)||0,nextRetryAt:0},startedAt:now,lastInteractionAt:0,frames:new WeakSet(),reloading:false}
 window[slot]=state
 const persist=()=>{try{sessionStorage.setItem(storageKey,JSON.stringify({retries:state.status.retries,lastReloadAt:state.status.lastReloadAt}))}catch{}}
 const tick=()=>{
  if(state.reloading)return
  let last=0,login=false,ended=false
  const inspect=win=>{
   try{
    if(win.location.origin!==origin)return
    if(!state.frames.has(win.document)){
     state.frames.add(win.document)
     for(const name of ['pointerdown','keydown','input','change'])win.document.addEventListener(name,()=>{state.lastInteractionAt=Date.now()},{capture:true,passive:true})
    }
    const doc=win.document,text=doc.body?.innerText||''
    login||=/\/login(?:[./]|$)/.test(win.location.pathname)||/登录视频号助手|请选择.{0,12}(?:视频号|账号|身份|子用户)/.test(text)
    ended||=/^(?:直播已结束|本场直播已结束|直播结束)$/m.test(text)
    for(const item of win.performance.getEntriesByType('resource')){
     const url=new URL(item.name)
     if(url.origin===origin&&/\/mmfinderassistant-bin\/live\/msg(?:\/|$)/.test(url.pathname)&&item.responseEnd>0&&(!item.responseStatus||item.responseStatus>=200&&item.responseStatus<300))last=Math.max(last,win.performance.timeOrigin+item.responseEnd)
    }
    for(const frame of doc.querySelectorAll('iframe'))if(frame.getClientRects().length)inspect(frame.contentWindow)
   }catch{/* Ignore third-party frames and documents navigating between origins. */}
  }
  inspect(window)
  const at=Date.now(),settings=state.options,health=state.status
  if(Number.isFinite(settings.acknowledgedAt)&&settings.acknowledgedAt>0)last=Math.max(last,settings.acknowledgedAt)
  health.lastMessageAt=Math.max(health.lastMessageAt,last)
  if(login||ended||settings.blocked){health.state=login?'login-required':ended?'ended':'paused';health.nextRetryAt=0;return}
  if(last&&at-last<settings.staleMs){health.state='healthy';health.retries=0;health.nextRetryAt=0;persist();return}
  if(!settings.expectLive&&!health.lastMessageAt){health.state='waiting';health.nextRetryAt=0;return}
  const due=Math.max(health.lastMessageAt?health.lastMessageAt+settings.staleMs:state.startedAt+settings.graceMs,health.lastReloadAt+Math.min(300000,settings.retryBaseMs*2**Math.min(health.retries,3)),state.lastInteractionAt+settings.idleMs)
  health.state=health.retries?'reconnecting':'waiting';health.nextRetryAt=due
  if(at<due)return
  health.state='reconnecting';health.retries++;health.lastReloadAt=at;state.reloading=true;persist()
  location.replace(entry)
 }
 state.timer=setInterval(tick,state.options.tickMs);tick()
 return state.status
}
