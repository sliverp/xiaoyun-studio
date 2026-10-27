/** Assess official headless login pages without accounts, room joins, comment posting or RTMP output. */
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import puppeteer from 'puppeteer-core'
import {PlatformChatCollector} from '../server/platform-chat.mjs'
import {createLoginNetworkDiagnostics,observeLoginEvidence} from './platform-login-diagnostics.mjs'

const dataDir=await mkdtemp(join(tmpdir(),'xiaoyun-platform-login-')),evidenceDirectory=process.env.STUDIO_LOGIN_SMOKE_DIR?resolve(process.env.STUDIO_LOGIN_SMOKE_DIR):dataDir,results=[]
await mkdir(evidenceDirectory,{recursive:true,mode:0o700})
const safeError=error=>String(error?.message||error||'').replace(/https?:\/\/[^\s'"<>]+/g,'[platform address]').replace(/(?:sk-|AKID)[A-Za-z0-9_-]{8,}/g,'[redacted]').slice(0,240)
let fatal=null,cleanupFailed=false
for(const platform of ['bilibili','douyin','kuaishou','wechat']){
 const id='login-smoke-'+platform,network=createLoginNetworkDiagnostics(),collector=new PlatformChatCollector({connection:{id,platform,name:'No-account login assessment',roomUrl:''},dataDir,launch:async options=>network.bindBrowser(await puppeteer.launch(options))})
 let error='',observation=null,result={platform,liveAccountVerified:false}
 try{
  try{await collector.login();observation=await observeLoginEvidence(collector)}
  catch(cause){error=safeError(cause);try{await collector.capture()}catch(captureError){error=safeError(captureError)}}
  const state=collector.status(),frame=collector.getFrame()
  Object.assign(result,{state:state.state,loginRequired:Boolean(state.loginRequired),qrVisible:typeof state.qrVisible==='boolean'?state.qrVisible:null,browserOpen:Boolean(state.browserOpen),pagePath:state.pagePath||'',frameBytes:frame?.length||0,error:state.error||error,messageResponses:state.messageResponses||0,commentCount:state.commentCount||0,authenticated:state.authenticated===true,loginPage:state.loginPage||{},observation,network:network.snapshot(),assessment:state.qrVisible===true&&frame?.length?'qr-visible':frame?.length?'page-visible-needs-inspection':'page-unavailable'})
  if(frame){result.screenshot=join(evidenceDirectory,platform+'.jpg');await writeFile(result.screenshot,frame,{mode:0o600})}
  if(result.authenticated){fatal=new Error('A fresh login assessment unexpectedly contained authenticated account state');result.error=safeError(fatal)}
 }catch(cause){fatal=cause;result.harnessError=safeError(cause)}
 finally{
  try{await collector.close();result.closed=collector.status().state;await rm(join(dataDir,'platforms',id),{recursive:true,force:true})}
  catch(cause){result.cleanupError=safeError(cause);fatal=cause;cleanupFailed=true}
 }
 results.push(result);console.log(JSON.stringify(result))
}
if(evidenceDirectory!==dataDir&&!cleanupFailed)await rm(dataDir,{recursive:true,force:true})
const report={generatedAt:new Date().toISOString(),purpose:'Official login page assessment only; no account authenticated, no target room configured and no stream started',evidenceDirectory,platforms:results,completedAssessment:!fatal,liveAccountVerified:false}
await writeFile(join(evidenceDirectory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
console.log(JSON.stringify({report:join(evidenceDirectory,'report.json'),completedAssessment:report.completedAssessment,liveAccountVerified:false}))
if(fatal)process.exitCode=1
