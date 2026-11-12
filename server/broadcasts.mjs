/** Durable records of actual output runs, separate from reusable scene configuration. */
import {randomUUID} from 'node:crypto'
import {appendFileSync,existsSync,mkdirSync,readFileSync,openSync,readSync,closeSync,truncateSync} from 'node:fs'
import {createReadStream} from 'node:fs'
import {createInterface} from 'node:readline'
import {join} from 'node:path'
import {atomicJson} from './store.mjs'

const ID=/^[a-f0-9-]{36}$/
const clone=value=>structuredClone(value)
const fail=(status,message)=>Object.assign(new Error(message),{status})
const maximum=(...values)=>{const known=values.filter(Number.isFinite);return known.length?Math.max(...known):null}
function *savedEvents(path){
 const fd=openSync(path,'r'),buffer=Buffer.alloc(65536);let tail=Buffer.alloc(0),read=0
 try{let size;while((size=readSync(fd,buffer,0,buffer.length,null))){read+=size;tail=Buffer.concat([tail,buffer.subarray(0,size)]);let end;while((end=tail.indexOf(10))!==-1){const line=tail.subarray(0,end).toString('utf8');tail=tail.subarray(end+1);if(line.trim())yield JSON.parse(line)}}}finally{closeSync(fd)}
 // A partial final line after a crash was never a complete recorded event.
 if(tail.length)truncateSync(path,read-tail.length)
}
export const BROADCAST_SCOPE='时长按本次本地输出或手动记录计时。人数仅展示开播后采集到的平台指标；不同平台不去重、不相加，未采集显示“未采集”。平台累计观看人数保留其原始口径。'

export class BroadcastSessions {
 constructor({dataDir,sceneId,getScene,now=Date.now,onChange=()=>{},onStart=()=>{}}){
  Object.assign(this,{sceneId,getScene,now,onChange,onStart});this.dir=join(dataDir,'broadcasts');this.file=join(this.dir,'index.json');this.records=new Map();this.activeId=null;this.outputSignature='';this.closed=false;this.ending=false
  mkdirSync(this.dir,{recursive:true,mode:0o700})
  const index=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{version:1,ids:[]}
  if(index.version!==1||!Array.isArray(index.ids)||new Set(index.ids).size!==index.ids.length||index.ids.some(id=>typeof id!=='string'||!ID.test(id)))throw new Error('直播场次目录格式无效')
  for(const id of index.ids){
   const record=JSON.parse(readFileSync(join(this.dir,id,'session.json'),'utf8'))
   if(record.id!==id||record.sceneId!==sceneId||!['live','ended','interrupted'].includes(record.status)||!Number.isFinite(record.startedAt)||!Number.isFinite(record.lastSeenAt)||!Array.isArray(record.platforms))throw new Error('直播场次记录格式无效')
   this.records.set(id,record)
   // A crashed process cannot know when output actually stopped. Never count offline time.
   if(record.status==='live'){
    for(const event of savedEvents(join(this.dir,id,'events.ndjson')))if(event.sequence>record.eventCount){this.applyData(record,event.type,event.data,event.at);record.eventCount=event.sequence;record.lastSeenAt=Math.max(record.lastSeenAt,event.at)}
    record.status='interrupted';record.endedAt=record.lastSeenAt;record.endReason='service-interrupted';this.append(record,'session.interrupted',{reason:record.endReason},record.endedAt);this.write(record)
   }
  }
  this.timer=setInterval(()=>this.checkpoint(),5000);this.timer.unref?.()
 }
 get active(){return this.records.get(this.activeId)||null}
 write(record){atomicJson(join(this.dir,record.id,'session.json'),record)}
 checkpoint(){if(this.active){this.active.lastSeenAt=this.now();this.write(this.active)}}
 append(record,type,data,at=this.now()){
  const event={sequence:++record.eventCount,at,type,data}
  appendFileSync(join(this.dir,record.id,'events.ndjson'),JSON.stringify(event)+'\n',{mode:0o600});return event
 }
 summary(record){return {...clone(record),durationSeconds:Math.max(0,Math.floor(((record.status==='live'?this.now():record.endedAt)-record.startedAt)/1000))}}
 state(){return {active:this.active?this.summary(this.active):null,total:this.records.size}}
 list({offset=0,limit=20}={}){return {...this.state(),items:[...this.records.values()].reverse().slice(offset,offset+limit).map(record=>this.summary(record)),offset,limit}}
 get(id){if(typeof id!=='string'||!ID.test(id)||!this.records.has(id))throw fail(404,'直播场次不存在');return this.summary(this.records.get(id))}
 start(mode='external'){
  if(this.closed)throw fail(409,'场景已关闭')
  if(this.active)return this.summary(this.active)
  const scene=this.getScene(),at=this.now(),id=randomUUID()
  const record={version:1,id,sceneId:this.sceneId,sceneName:scene.name,number:this.records.size+1,status:'live',mode,startedAt:at,lastSeenAt:at,endedAt:null,endReason:null,eventCount:0,commentCount:0,metricCount:0,peakOnline:null,platforms:[],recordings:[],configuration:clone(scene.configuration),scope:BROADCAST_SCOPE}
  mkdirSync(join(this.dir,id),{mode:0o700});this.append(record,'session.started',{mode});this.write(record)
  atomicJson(this.file,{version:1,ids:[...this.records.keys(),id]});this.records.set(id,record);this.activeId=id;this.outputSignature='';this.onStart();this.onChange(this.state());return this.summary(record)
 }
 finish(reason='user-ended',status='ended'){
  const record=this.active;if(!record)return null
  record.lastSeenAt=this.now();record.endedAt=record.lastSeenAt;record.status=status;record.endReason=reason
  this.append(record,'session.ended',{reason,status});this.write(record);this.activeId=null;this.outputSignature='';this.onChange(this.state());return this.summary(record)
 }
 observeOutput(output={}){
  if(this.closed)return
  // Preparation, an encoder without a working sink, and failed starts are not broadcasts.
  const working=output.active===true||output.recording===true||output.platforms?.some(item=>item.active)||output.recordingStatus?.active===true
  if(!this.active&&working)this.start(output.platforms?.some(item=>item.active)?'output':'recording')
  if(!this.active)return
  const record=this.active
  if(working&&record.mode==='recording'&&output.platforms?.some(item=>item.active))record.mode='output'
  const targets=(output.platforms||[]).map(item=>({id:item.id,platform:item.platform,name:item.name,state:item.state,active:item.active===true,reconnects:item.reconnects||0}))
  const safe={state:output.state||'stopped',platforms:targets,recording:output.recording===true||output.recordingStatus?.active===true,recordingFile:output.recordingFile||null}
  for(const target of targets){if(!record.platforms.some(item=>item.connectionId===target.id))record.platforms.push({connectionId:target.id,platform:target.platform,connectionName:target.name,commentCount:0,metricCount:0,peakOnline:null,latest:{}})}
  if(safe.recordingFile&&!record.recordings.includes(safe.recordingFile))record.recordings.push(safe.recordingFile)
  const signature=JSON.stringify(safe)
  if(signature!==this.outputSignature){this.outputSignature=signature;this.append(record,'output',safe);this.write(record);this.onChange(this.state())}
  if(!this.ending&&record.mode!=='external'&&!output.running&&!working)this.finish(output.state==='error'?'output-error':'output-stopped',output.state==='error'?'interrupted':'ended')
 }
 capture(type,payload){
  const record=this.active;if(!record||this.closed)return
  // Ignore delayed pre-broadcast comments/metrics rather than assigning them to a later run.
  if(['comment','metrics'].includes(type)&&Number.isFinite(payload.at)&&payload.at<record.startedAt)return
  if(!['comment','metrics','start','pause','resume','stop','speech','lottery','recovery','error'].includes(type))return
  record.lastSeenAt=this.now();this.applyData(record,type,payload,record.lastSeenAt);this.append(record,type,clone(payload))
 }
 applyData(record,type,payload,at){
  let platform
  if(type==='comment'||type==='metrics'){
   const id=payload.connectionId||'ingest';platform=record.platforms.find(item=>item.connectionId===id)
   if(!platform){platform={connectionId:id,platform:payload.platform||'ingest',connectionName:payload.connectionName||'外部数据接入',commentCount:0,metricCount:0,peakOnline:null,latest:{}};record.platforms.push(platform)}
  }
  if(type==='comment'){record.commentCount++;platform.commentCount++}
  if(type==='metrics'){
   record.metricCount++;platform.metricCount++
   platform.peakOnline=maximum(platform.peakOnline,payload.onlineUsers,payload.peakOnlineUsers)
   record.peakOnline=maximum(...record.platforms.map(item=>item.peakOnline))
   for(const key of ['onlineUsers','peakOnlineUsers','totalViewers','totalViews','views','likes','heat','newFollowers','shares','groupJoins','giftCoins'])if(Number.isFinite(payload[key]))platform.latest[key]=payload[key]
   platform.lastMetricAt=at
  }
  if(type==='output'&&payload.recordingFile&&!record.recordings.includes(payload.recordingFile))record.recordings.push(payload.recordingFile)
 }
 async *events(id){
  this.get(id)
  const lines=createInterface({input:createReadStream(join(this.dir,id,'events.ndjson'),{encoding:'utf8'}),crlfDelay:Infinity})
  try{for await(const line of lines){if(line.trim())yield JSON.parse(line)}}finally{lines.close();lines.input.destroy()}
 }
 async detail(id,{offset=0,limit=100,type='all'}={}){
  const session=this.get(id),rows=[];let matched=0,more=false
  for await(const event of this.events(id)){
   if(type!=='all'&&(type==='activity'?['comment','metrics'].includes(event.type):event.type!==type))continue
   if(matched++<offset)continue
   if(rows.length===limit){more=true;break}rows.push(event)
  }
  return {session,events:rows,offset,nextOffset:more?offset+rows.length:null}
 }
 close(reason='service-stopped'){if(this.closed)return;clearInterval(this.timer);this.finish(reason,reason==='user-ended'||reason==='scene-switched'?'ended':'interrupted');this.closed=true}
}
