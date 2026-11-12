import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,appendFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BroadcastSessions} from '../server/broadcasts.mjs'

function fixture(t){
 const dataDir=mkdtempSync(join(tmpdir(),'studio-broadcast-'));let clock=100000
 const options={dataDir,sceneId:'scene-a',getScene:()=>({name:'带货场景',configuration:{presenter:'小云',personaId:'commerce'}}),now:()=>clock}
 const sessions=new BroadcastSessions(options),instances=[sessions];t.after(()=>{for(const item of instances)item.close();rmSync(dataDir,{recursive:true,force:true})})
 return {sessions,options,instances,advance:ms=>clock+=ms,dataDir}
}
const output=(value={})=>({running:true,active:true,state:'streaming',platforms:[{id:'bili',platform:'bilibili',name:'B站账号',active:true,state:'streaming'}],...value})

test('only an actual output sink starts a run; reconnecting and adding platforms keep one run',t=>{
 const {sessions,advance}=fixture(t)
 sessions.observeOutput({running:true,state:'preparing'});sessions.observeOutput({running:true,encodingActive:true,state:'starting'})
 assert.equal(sessions.state().total,0)
 sessions.observeOutput(output());const first=sessions.active.id
 advance(4000);sessions.observeOutput(output({active:false,state:'reconnecting',platforms:[]}));assert.equal(sessions.active.id,first)
 sessions.observeOutput(output({platforms:[{id:'wechat',name:'视频号',platform:'wechat',active:true,state:'streaming'}]}));assert.equal(sessions.state().total,1)
 advance(6000);sessions.observeOutput({running:false,active:false,state:'stopped'})
 const ended=sessions.get(first);assert.equal(ended.status,'ended');assert.equal(ended.durationSeconds,10);assert.equal(ended.platforms.length,2)
 sessions.observeOutput(output());assert.notEqual(sessions.active.id,first);assert.equal(sessions.active.number,2)
})

test('run metrics retain per-platform zero and unknown values without adding platform audiences',async t=>{
 const {sessions,advance}=fixture(t);sessions.start('external')
 sessions.capture('metrics',{at:100000,connectionId:'bili',platform:'bilibili',connectionName:'B站',onlineUsers:12,totalViewers:100,likes:0})
 sessions.capture('metrics',{at:100000,connectionId:'wechat',platform:'wechat',connectionName:'视频号',onlineUsers:20,peakOnlineUsers:25})
 sessions.capture('comment',{id:'a',at:100000,connectionId:'bili',nickname:'观众',content:'第一场'})
 advance(1000);const first=sessions.finish();assert.equal(first.peakOnline,25);assert.equal(first.commentCount,1);assert.equal(first.metricCount,2)
 assert.equal(first.platforms[0].latest.likes,0);assert.equal(first.platforms[1].latest.totalViewers,undefined)
 sessions.start('external');assert.equal(sessions.active.commentCount,0);assert.equal(sessions.active.peakOnline,null)
 sessions.capture('comment',{at:100000,content:'旧场次延迟弹幕'});assert.equal(sessions.active.commentCount,0)
 sessions.observeOutput(output());sessions.observeOutput({running:false,state:'stopped'});assert.ok(sessions.active,'manual external recording ends explicitly')
 const detail=await sessions.detail(first.id);assert.equal(detail.events.filter(event=>event.type==='comment').length,1)
})

test('archived events survive reload and support bounded pages and type filters',async t=>{
 const {sessions,options,instances}=fixture(t);sessions.start();const id=sessions.active.id
 for(let i=0;i<205;i++)sessions.capture('comment',{id:String(i),content:'弹幕 '+i})
 sessions.finish();sessions.close()
 const reloaded=new BroadcastSessions(options);instances.push(reloaded)
 assert.equal(reloaded.get(id).commentCount,205)
 let page=await reloaded.detail(id,{offset:100,limit:100,type:'comment'})
 assert.equal(page.events.length,100);assert.equal(page.events[0].data.content,'弹幕 100');assert.equal(page.nextOffset,200)
 page=await reloaded.detail(id,{offset:200,limit:100,type:'comment'});assert.equal(page.events.length,5);assert.equal(page.nextOffset,null)
 assert.throws(()=>reloaded.get('../settings'),error=>error.status===404)
})

test('crash recovery replays events after the checkpoint without counting server downtime',async t=>{
 const {sessions,options,instances,advance,dataDir}=fixture(t);sessions.start();const id=sessions.active.id
 advance(2300);sessions.capture('comment',{content:'检查点后的弹幕'});sessions.capture('metrics',{onlineUsers:7})
 appendFileSync(join(dataDir,'broadcasts',id,'events.ndjson'),'{"partial":')
 clearInterval(sessions.timer);sessions.closed=true
 advance(3600000)
 const recovered=new BroadcastSessions(options);instances.push(recovered)
 const record=recovered.get(id);assert.equal(record.status,'interrupted');assert.equal(record.durationSeconds,2);assert.equal(record.commentCount,1);assert.equal(record.metricCount,1);assert.equal(record.peakOnline,7)
 assert.equal((await recovered.detail(id)).events.at(-1).type,'session.interrupted')
 assert.equal(recovered.state().active,null)
 recovered.start();assert.equal(recovered.active.number,2)
})

test('local recording has an independent run and retains multiple recording files after recovery',t=>{
 const {sessions}=fixture(t)
 sessions.observeOutput(output({platforms:[],mode:'record',recording:true,recordingFile:'first.mp4'}))
 assert.equal(sessions.active.mode,'recording')
 sessions.observeOutput(output({platforms:[],recording:true,recordingFile:'first.retry1.mp4'}))
 const result=sessions.finish();assert.deepEqual(result.recordings,['first.mp4','first.retry1.mp4'])
})
