/** Account-free login assessment helpers; retain only host/status counts and bounded observations. */
import {browserDeadline} from '../server/platform-browser.mjs'

/** Aggregate browser transport failures without retaining URLs, query strings, headers or bodies. */
export function createLoginNetworkDiagnostics(){
 const responses=new Map(),failures=new Map(),pages=new WeakSet()
 let responseCount=0,failedRequestCount=0,httpErrorCount=0,omittedGroups=0
 const host=address=>{try{const url=new URL(address);return ['https:','http:'].includes(url.protocol)?url.hostname:''}catch{return ''}}
 const record=(map,key,row)=>{const prior=map.get(key);if(prior){prior.count++;return}if(map.size>=64){omittedGroups++;return}map.set(key,{...row,count:1})}
 const attachPage=page=>{
  if(pages.has(page))return;pages.add(page)
  page.on('response',response=>{
   const domain=host(response.url()),status=response.status();if(!domain||!Number.isInteger(status)||status<100||status>599)return
   responseCount++;if(status>=400)httpErrorCount++
   record(responses,domain+':'+status,{host:domain,status})
  })
  page.on('requestfailed',request=>{
   const domain=host(request.url());if(!domain)return
   const failure=request.failure()?.errorText||'',code=/^net::ERR_[A-Z0-9_]+$/.test(failure)?failure:'request-failed'
   failedRequestCount++;record(failures,domain+':'+code,{host:domain,code})
  })
 }
 return {
  bindBrowser(browser){
   // Attach before the assessment's first navigation, including newly opened login windows.
   const newPage=browser.newPage.bind(browser)
   browser.newPage=async(...args)=>{const page=await newPage(...args);attachPage(page);return page}
   browser.on('targetcreated',async target=>{if(target.type()!=='page')return;try{const page=await target.page();if(page)attachPage(page)}catch{/* A target closed before inspection has no transport data to retain. */}})
   return browser
  },
  snapshot(){return {responseCount,failedRequestCount,httpErrorCount,omittedGroups,responses:[...responses.values()],failures:[...failures.values()]}}
 }
}

/** Poll the owned login page until a real QR pattern, verification request or finite deadline. */
export async function observeLoginEvidence(collector,{timeoutMs=25000,intervalMs=1000,now=Date.now,sleep=milliseconds=>new Promise(done=>setTimeout(done,milliseconds))}={}){
 const started=now(),deadline=started+timeoutMs;let captures=0,stopReason='deadline'
 while(now()<deadline){
  await browserDeadline(collector.capture(),Math.max(1,Math.min(10000,deadline-now())),'Login assessment observation deadline exceeded')
  captures++
  const state=collector.status()
  if(state.qrVisible===true){stopReason='qr-visible';break}
  if(state.loginPage?.verificationRequired){stopReason='security-verification';break}
  if(!state.browserOpen){stopReason='page-unavailable';break}
  await sleep(Math.max(1,Math.min(intervalMs,deadline-now())))
 }
 return {elapsedMs:Math.max(0,now()-started),captures,stopReason}
}
