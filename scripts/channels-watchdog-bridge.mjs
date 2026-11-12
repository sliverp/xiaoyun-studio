/** Temporary in-container bridge for enabling the native collector watchdog without stopping a live encoder. */
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import puppeteer from 'puppeteer-core'
import {installChannelsWatchdog} from '../server/channels-watchdog.mjs'
import {isChannelsMessageResponse,extractChannelsComments} from '../server/channels-parser.mjs'

export async function createChannelsWatchdogBridge({dataDir,getSnapshot,pollMs=5000,monitorOptions={},onStatus=()=>{}}){
 const jobs=new Map();let busy=false,closed=false,lastError='',lastSnapshot=null
 const detach=async job=>{
  for(const [page,{script,listener}]of job.pages)if(!page.isClosed()){
   page.off('response',listener)
   await page.evaluate(()=>{const state=window.__xiaoyunChannelsWatchdog;if(state){clearInterval(state.timer);delete window.__xiaoyunChannelsWatchdog}}).catch(()=>{})
   await page.removeScriptToEvaluateOnNewDocument(script.identifier).catch(()=>{})
  }
  await job.browser.disconnect()
 }
 const tick=async()=>{
  if(busy||closed)return;busy=true
  try{
   let snapshot,stale=false
   try{snapshot=await getSnapshot();lastSnapshot=snapshot}catch(error){if(!lastSnapshot)throw error;snapshot=lastSnapshot;stale=true}
   const scene=snapshot.projects?.activeId
   if(!/^[a-zA-Z0-9_-]{1,80}$/.test(scene||''))throw Error('No active scene')
   const keep=new Set()
   for(const connection of snapshot.platforms?.connections||[]){
    if(connection.platform!=='wechat'||!connection.chat?.browserOpen||!/^[a-zA-Z0-9_-]{1,80}$/.test(connection.id))continue
    const key=scene+':'+connection.id;keep.add(key)
    let job=jobs.get(key)
    if(!job?.browser.connected){
     if(job){await detach(job);jobs.delete(key)}
     const directory=join(dataDir,'projects',scene,'platforms',connection.id)
     let profile='channels-profile'
     try{profile=JSON.parse(await readFile(join(directory,'active-browser.json'),'utf8')).profileName;if(!/^channels-session-[a-f0-9-]{36}$/.test(profile))throw Error('Invalid collector profile')}catch(error){if(error.code!=='ENOENT')throw error}
     const port=Number((await readFile(join(directory,profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid owned browser port')
     job={browser:await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,protocolTimeout:10000,defaultViewport:null}),pages:new Map()};jobs.set(key,job)
    }
    const stream=snapshot.media?.output?.platforms?.find(row=>row.id===connection.id),chat=connection.chat
    const settings={...monitorOptions,acknowledgedAt:Math.max(Number(chat.lastMessageAt)||0,job.lastMessageAt||0),expectLive:Boolean(stream&&(stream.active||['starting','streaming','reconnecting'].includes(stream.state))),blocked:Boolean(chat.loginRequired||chat.accountSelectionRequired||chat.fileUploadRequested||chat.platformState==='ended')}
    for(const page of await job.browser.pages()){
     if(!page.url().startsWith('https://channels.weixin.qq.com/'))continue
     if(!job.pages.has(page)){
      const listener=async response=>{if(!isChannelsMessageResponse(response.url()))return;try{if(Number(response.headers()['content-length'])>2*1024*1024)return;const raw=await response.text();if(Buffer.byteLength(raw)>2*1024*1024)return;if(extractChannelsComments({},JSON.parse(raw)))job.lastMessageAt=Date.now()}catch{/* A failed poll cannot acknowledge collection health. */}}
      page.on('response',listener);job.pages.set(page,{script:await page.evaluateOnNewDocument(installChannelsWatchdog,settings),listener})
     }
     job.health=await page.evaluate(installChannelsWatchdog,settings)
    }
   }
   for(const [key,job]of jobs)if(!keep.has(key)){await detach(job);jobs.delete(key)}
   lastError=stale?'控制状态暂不可达，继续独立守护现有采集连接':''
  }catch{lastError='采集守护状态检查失败，正在重试'}
  finally{busy=false;await onStatus({at:Date.now(),guardedConnections:jobs.size,connections:[...jobs].map(([key,job])=>({key,health:job.health||null})),error:lastError})}
 }
 await tick();const timer=setInterval(()=>void tick(),pollMs)
 return {async close(){closed=true;clearInterval(timer);while(busy)await new Promise(done=>setTimeout(done,20));await Promise.allSettled([...jobs.values()].map(detach));jobs.clear()},tick}
}

async function main(){
 const configPath=process.argv[process.argv.indexOf('--config')+1];if(!configPath||configPath===process.argv[0])throw Error('Missing private bridge configuration')
 const config=JSON.parse(await readFile(configPath,'utf8')),dataDir=resolve(config.dataDir)
 if(!/^studio_session=[\w-]{43}$/.test(config.cookie))throw Error('Invalid private controller session')
 const ops=join(dataDir,'ops');await mkdir(ops,{recursive:true,mode:0o700})
 const pidFile=join(ops,'channels-watchdog-bridge.pid')
 try{const pid=Number(await readFile(pidFile,'utf8'));if(pid>0){try{process.kill(pid,0);throw Error('Collector watchdog bridge already running')}catch(error){if(error.code!=='ESRCH')throw error}}}catch(error){if(error.code!=='ENOENT')throw error}
 await writeFile(pidFile,String(process.pid),{mode:0o600})
 const getSnapshot=async()=>{const response=await fetch('http://127.0.0.1:18080/api/state',{headers:{Cookie:config.cookie},signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Controller state unavailable');return response.json()}
 const bridge=await createChannelsWatchdogBridge({dataDir,getSnapshot,onStatus:value=>writeFile(join(ops,'channels-watchdog-status.json'),JSON.stringify(value),{mode:0o600})})
 const stop=async()=>{await bridge.close();await unlink(pidFile).catch(()=>{});process.exit(0)}
 process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop())
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('采集守护启动失败；现有推流与采集未停止。');process.exitCode=1})
