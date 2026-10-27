import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {Store} from '../server/store.mjs'
import {normalizeRoomUrl,validateStreamAddress} from '../server/platform-catalog.mjs'
import {createStudio} from '../server/http.mjs'

const root=resolve(import.meta.dirname,'..')
function folder(t){const path=mkdtempSync(join(tmpdir(),'studio-platform-api-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path}
function mediaFactory(){return {started:null,destinations:[],initialized:false,status(){return {ready:this.initialized,slide:{pageNumber:1},output:{running:this.destinations.length>0,active:false,platforms:this.destinations.map(d=>({id:d.id,state:'starting',active:false}))}}},async initialize(){this.initialized=true},async startOutput(value,options){this.started=value;this.preparation=options?.prepare;this.destinations=value.destinations},async addDestination(value){this.destinations.push(value)},async stopDestination(id){this.destinations=this.destinations.filter(item=>item.id!==id)},async stopOutput(){this.destinations=[]},async retryDestination(id){this.retried=id},setBgm(){},getFrame(){return null},getSlideFrame(){return null},close:async()=>{}}}
async function fixture(t){
 const collectors=[],dir=folder(t),app=await createStudio({root,dataDir:dir,port:0,password:'Platform-fixture-password-2026',env:{},mediaFactory,providerFactory:()=>({status:()=>({})}),directorFactory:()=>({status:()=>({}),programState:()=>({}),settingsChanged(){},addComments(items){this.comments=items},ingestMetrics(value){this.metrics=value},audioProgress(){},close:async()=>{}}),platformCollectorFactory:options=>{const value={options,state:'disconnected',status(){return {state:this.state,commentCount:0}},getFrame:()=>Buffer.from('private-qr-image'),async connect(){this.state='connected-no-live-data';options.onStatus();return this.status()},async login(){this.state='login-required';options.onStatus();return this.status()},async disconnect(){this.state='disconnected'},async close(){this.closed=true},async click(point){this.point=point}};collectors.push(value);return value}})
 t.after(()=>app.close());const request=(path,{method='GET',body,auth=true}={})=>fetch(app.baseUrl+path,{method,headers:{...(auth&&cookie?{Cookie:cookie}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
 let cookie='';const login=await request('/api/login',{method:'POST',auth:false,body:{password:'Platform-fixture-password-2026'}});cookie=login.headers.get('set-cookie').split(';')[0]
 const create=async(platform='bilibili',value={})=>{const response=await request('/api/platforms',{method:'POST',body:{platform,roomUrl:platform==='wechat'?'':platform==='custom'?'':'12345',...value}});assert.equal(response.status,201);const data=await response.json();return data.platforms.connections.at(-1)}
 const action=(action,id)=>request('/api/action',{method:'POST',body:{action,id}})
 return {app,request,create,action,collectors,dir}
}

test('platform rooms accept official HTTPS links and IDs but reject unrelated and private addresses',()=>{
 assert.equal(normalizeRoomUrl('bilibili','123'),'https://live.bilibili.com/123')
 assert.equal(normalizeRoomUrl('kuaishou','3xabc'),'https://live.kuaishou.com/u/3xabc')
 for(const value of ['http://live.bilibili.com/123','https://127.0.0.1/','https://live.bilibili.com.evil.test/123','https://u:p@live.bilibili.com/1','https://live.bilibili.com:8080/1','file:///etc/passwd'])assert.throws(()=>normalizeRoomUrl('bilibili',value))
 assert.throws(()=>validateStreamAddress('rtsp://stream.test/live'),/RTMP/)
 assert.throws(()=>validateStreamAddress('rtmp://stream.test/live|other'))
})
test('platform credentials stay server-side, survive blank edits and cannot cross another connection',t=>{
 const dataDir=folder(t),store=new Store({root,dataDir,env:{}}),first=store.savePlatform({platform:'bilibili',streamKey:'fixture-private-stream-A',roomUrl:'1'}),second=store.savePlatform({platform:'bilibili',streamKey:'fixture-private-stream-B',roomUrl:'2'})
 assert.notEqual(first.id,second.id);store.savePlatform({streamKey:'',name:'改名'},first.id)
 assert.equal(store.platformSecret(first.id),'fixture-private-stream-A');assert.equal(store.platformSecret(second.id),'fixture-private-stream-B')
 assert.ok(!JSON.stringify(store.get()).includes('fixture-private-stream'))
 store.savePlatform({streamKey:null},first.id);assert.equal(store.platformSecret(first.id),'')
 const copy=new Store({root,dataDir,env:{}});assert.equal(copy.get().platforms.length,2);assert.equal(copy.platformSecret(second.id),'fixture-private-stream-B')
 store.removePlatform(second.id);assert.equal(store.platformSecret(second.id),'')
})
test('legacy single output migrates into a custom destination without exposing its stream key',t=>{
 const dataDir=folder(t),store=new Store({root,dataDir,env:{}});store.update({output:{rtmpUrl:'rtmp://legacy.test/live'}});store.setSecrets({streamKey:'fixture-legacy-stream-key'})
 const reloaded=new Store({root,dataDir,env:{}});assert.equal(reloaded.get().platforms[0].platform,'custom');assert.equal(reloaded.get().output.rtmpUrl,'');assert.equal(reloaded.platformSecret('legacy-output'),'fixture-legacy-stream-key');assert.ok(!readFileSync(join(dataDir,'settings.json'),'utf8').includes('fixture-legacy-stream-key'))
})
test('platform API requires administrator authentication and never returns stored stream keys',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/platforms',{auth:false})).status,401)
 const c=await f.create('douyin',{streamKey:'fixture-platform-api-private-key'});assert.equal(c.streamKeySaved,true);assert.equal(c.chat.state,'disconnected');assert.equal(f.collectors.length,0)
 const text=await(await f.request('/api/state')).text();assert.ok(!text.includes('fixture-platform-api-private-key'))
 assert.equal((await f.request('/api/platforms/'+c.id+'/frame.jpg',{auth:false})).status,401)
 assert.equal((await f.request('/api/config',{method:'PUT',body:{patch:{platforms:[]}}})).status,400)
})
test('each connection has an isolated login browser and messages retain their platform provenance',async t=>{
 const f=await fixture(t),a=await f.create('bilibili'),b=await f.create('wechat')
 assert.equal((await f.action('platform.chat.login',a.id)).status,200);assert.equal((await f.action('platform.chat.connect',b.id)).status,200)
 assert.equal(f.collectors.length,2);assert.equal(f.collectors[0].options.connection.id,a.id);assert.equal(f.collectors[1].options.connection.id,b.id)
 f.collectors[0].options.onComments([{id:'same-comment',nickname:'观众甲',content:'你好'}]);assert.equal(f.app.director.comments[0].connectionId,a.id);assert.equal(f.app.director.comments[0].platform,'bilibili')
 const image=await f.request('/api/platforms/'+a.id+'/frame.jpg');assert.equal(await image.text(),'private-qr-image')
 await f.request('/api/platforms/'+a.id,{method:'DELETE'});assert.equal(f.collectors[0].closed,true);assert.equal(f.collectors[1].closed,undefined)
})
test('multi-output actions resolve only selected private keys and stop one destination independently',async t=>{
 const f=await fixture(t),a=await f.create('bilibili',{rtmpUrl:'rtmp://localhost:19359/live',streamKey:'fixture-destination-A'}),b=await f.create('douyin',{rtmpUrl:'rtmp://localhost:19360/live',streamKey:'fixture-destination-B'})
 assert.equal((await f.action('output.start')).status,200);assert.equal(f.app.media.started.destinations.length,2);assert.equal(f.app.media.started.destinations[0].streamKey,'fixture-destination-A')
 assert.equal((await f.action('output.platform.stop',a.id)).status,200);assert.deepEqual(f.app.media.destinations.map(d=>d.id),[b.id])
 assert.equal((await f.request('/api/platforms/'+b.id,{method:'DELETE'})).status,409)
 assert.equal((await f.request('/api/platforms/'+b.id,{method:'PUT',body:{streamKey:'other'}})).status,409)
 assert.equal((await f.action('output.platform.start',a.id)).status,200);assert.equal(f.app.media.destinations.length,2)
})
test('connection limits and cross-platform URLs fail before a browser or stream is started',async t=>{
 const f=await fixture(t);const response=await f.request('/api/platforms',{method:'POST',body:{platform:'douyin',roomUrl:'https://live.bilibili.com/1'}});assert.equal(response.status,400);assert.equal(f.collectors.length,0)
 for(let i=0;i<8;i++)await f.create('bilibili',{name:'测试 '+i})
 assert.equal((await f.request('/api/platforms',{method:'POST',body:{platform:'bilibili'}})).status,400)
 assert.equal((await f.action('platform.chat.connect','../../bad')).status,404)
})

test('invalid room edits do not disconnect a currently connected browser',async t=>{
 const f=await fixture(t),c=await f.create('bilibili');await f.action('platform.chat.connect',c.id)
 const response=await f.request('/api/platforms/'+c.id,{method:'PUT',body:{roomUrl:'https://unrelated.test/room'}})
 assert.equal(response.status,400);assert.equal(f.collectors[0].closed,undefined);assert.equal(f.collectors[0].state,'connected-no-live-data')
})
test('deleting a connection and starting it from another controller cannot leave an orphan stream',async t=>{
 const f=await fixture(t),c=await f.create('bilibili',{rtmpUrl:'rtmp://localhost:19359/live'});await f.action('platform.chat.connect',c.id)
 let release;const closing=new Promise(done=>release=done);f.collectors[0].close=async()=>closing
 const removal=f.app.platforms.remove(c.id);await new Promise(done=>setImmediate(done));const starting=f.app.platforms.start(c.id)
 release();await removal;await assert.rejects(starting,/不存在/);assert.equal(f.app.media.destinations.length,0)
})

test('retry uses newly saved credentials and removal clears an exhausted output intent',async t=>{
 const f=await fixture(t),a=await f.create('bilibili',{rtmpUrl:'rtmp://localhost:19359/live',streamKey:'fixture-old-key'}),b=await f.create('douyin',{rtmpUrl:'rtmp://localhost:19360/live'})
 await f.action('output.start');const original=f.app.media.status.bind(f.app.media)
 f.app.media.status=()=>{const value=original();value.output.platforms=value.output.platforms.map(row=>row.id===a.id?{...row,state:'error'}:row);return value}
 assert.equal((await f.request('/api/platforms/'+a.id,{method:'PUT',body:{rtmpUrl:'rtmp://localhost:19361/live',streamKey:'fixture-new-key'}})).status,200)
 assert.equal((await f.action('output.platform.retry',a.id)).status,200)
 const updated=f.app.media.destinations.find(d=>d.id===a.id);assert.equal(updated.streamKey,'fixture-new-key');assert.equal(updated.rtmpUrl,'rtmp://localhost:19361/live')
 assert.equal((await f.request('/api/platforms/'+a.id,{method:'DELETE'})).status,200)
 assert.deepEqual(f.app.media.destinations.map(d=>d.id),[b.id]);assert.equal(f.app.store.platformSecret(a.id),'')
})

for(const stopAll of [false,true])test(`${stopAll?'global':'single-platform'} stop cancels a start queued behind an unfinished login`,async t=>{
 const f=await fixture(t),c=await f.create('bilibili',{rtmpUrl:'rtmp://localhost:19359/live'})
 let release;const gate=new Promise(done=>release=done),login=f.app.platforms.withConnection(c.id,()=>gate)
 const starting=assert.rejects(f.app.platforms.start(c.id),/已取消/)
 assert.equal((await f.action(stopAll?'output.stop':'output.platform.stop',c.id)).status,200)
 release();await login;await starting;assert.equal(f.app.media.started,null);assert.deepEqual(f.app.media.destinations,[])
})

test('application shutdown stops reserved output before awaiting platform operations',async t=>{
 const f=await fixture(t),c=await f.create('bilibili',{rtmpUrl:'rtmp://localhost:19359/live'})
 let entered,release,stopped=false;const started=new Promise(done=>entered=done),pending=new Promise(done=>release=done)
 f.app.media.startOutput=async()=>{entered();await pending}
 f.app.media.stopOutput=async()=>{stopped=true;release()}
 const starting=f.app.platforms.start(c.id);await started
 const closing=f.app.close();await new Promise(done=>setImmediate(done));const stopBeforeWait=stopped;release();await closing;await starting
 assert.equal(stopBeforeWait,true)
})
