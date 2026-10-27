import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createStudio} from '../server/http.mjs'
import {LiveDirector} from '../server/director.mjs'

const root=resolve(import.meta.dirname,'..')
async function fixture(t,{directorFactory}={}){
 const dataDir=mkdtempSync(join(tmpdir(),'studio-project-api-')),runtimes=[]
 t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
 const app=await createStudio({root,dataDir,port:0,password:'Project-fixture-password-2026',env:{},mediaFactory:options=>{
  const media={options,output:{running:false,active:false,state:'stopped',platforms:[]},closed:false,ready:false,initialize:async()=>{media.ready=true},status:()=>({ready:media.ready,slide:{pageNumber:1},output:media.output}),setBgm(){},stopAudio(){},getFrame:()=>null,getSlideFrame:()=>null,async startOutput(){media.output={...media.output,running:true,active:true,state:'streaming'}},async stopOutput(){media.output={...media.output,running:false,active:false,state:'stopped'}},async close(){media.closed=true}}
  runtimes.push(media);return media
 },providerFactory:()=>({status:()=>({demo:true})}),directorFactory:directorFactory||(({store})=>({store,spoken:[],status:()=>({running:false}),programState:()=>({}),settingsChanged(){},audioProgress(){},async say(text){this.spoken.push(text)},async playRecording(value){this.spoken.push(value.text)},addComments(){},ingestMetrics(){},report:()=>({}),async close(){this.closed=true}}))})
 t.after(()=>app.close())
 let cookie=''
 const request=(path,{method='GET',body,headers={},authenticated=true}={})=>fetch(app.baseUrl+path,{method,headers:{...(authenticated&&cookie?{Cookie:cookie}:{}),...headers,...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)})
 const login=await request('/api/login',{method:'POST',body:{password:'Project-fixture-password-2026'},authenticated:false});cookie=login.headers.get('set-cookie').split(';')[0]
 const state=async()=>await(await request('/api/state')).json()
 const create=async(name,copyCurrent=false)=>{const response=await request('/api/projects',{method:'POST',body:{name,copyCurrent}});assert.equal(response.status,201);return(await response.json()).project}
 const activate=(id,body={})=>request('/api/projects/'+id+'/activate',{method:'POST',body})
 const save=patch=>request('/api/config',{method:'PUT',body:{patch}})
 return {app,request,state,create,activate,save,runtimes,dataDir}
}

test('broadcast project APIs require administrator access and retain the current configuration',async t=>{
 const f=await fixture(t),initial=await f.state()
 assert.equal((await f.request('/api/projects',{authenticated:false})).status,401)
 const before=initial.projects.activeId
 assert.equal(initial.projects.projects.length,1);assert.equal(initial.projects.projects[0].name,'原配置')
 await f.save({identity:{name:'本来的主播'},cues:[{id:'original-cue',title:'原来的口播',text:'原来的内容'}]})
 const next=await f.create('新产品发布会'),unchanged=await f.state()
 assert.equal(unchanged.projects.activeId,before);assert.equal(unchanged.config.identity.name,'本来的主播')
 assert.equal((await f.activate(next.id)).status,200)
 const current=await f.state();assert.equal(current.projects.activeId,next.id);assert.deepEqual(current.config.cues,[]);assert.deepEqual(current.config.platforms,[]);assert.equal(current.config.presentation.url,'')
 assert.equal((await f.activate(before)).status,200);assert.equal((await f.state()).config.cues[0].text,'原来的内容')
})

test('copying a project preserves independent private keys and configuration without returning secrets',async t=>{
 const f=await fixture(t),original=f.app.projects.activeId
 await f.request('/api/config',{method:'PUT',body:{patch:{identity:{welcome:'原场欢迎词'}},secrets:{llmKey:'fixture-original-model-key-123456'}}})
 const originalIngest=f.app.store.secret('commentIngestKey'),copy=await f.create('复制场次',true)
 await f.activate(copy.id)
 assert.equal(f.app.store.secret('llmKey'),'fixture-original-model-key-123456');assert.notEqual(f.app.store.secret('commentIngestKey'),originalIngest)
 await f.request('/api/config',{method:'PUT',body:{patch:{identity:{welcome:'复制场欢迎词'}},secrets:{llmKey:'fixture-copy-model-key-987654'}}})
 const response=await(await f.request('/api/state')).text();assert.ok(!response.includes('fixture-copy-model-key-987654'))
 await f.activate(original);assert.equal(f.app.store.get().identity.welcome,'原场欢迎词');assert.equal(f.app.store.secret('llmKey'),'fixture-original-model-key-123456')
})

test('switching a recording requires explicit stop and a stale controller cannot edit another broadcast',async t=>{
 const f=await fixture(t),before=f.app.projects.activeId,next=await f.create('下一场'),oldMedia=f.app.media
 await f.request('/api/action',{method:'POST',body:{action:'output.start'}})
 let response=await f.activate(next.id);assert.equal(response.status,409);assert.equal((await response.json()).code,'PROJECT_BUSY');assert.equal(oldMedia.closed,false)
 response=await f.activate(next.id,{stopCurrent:true});assert.equal(response.status,200);assert.equal(oldMedia.closed,true);assert.equal(oldMedia.output.active,false);assert.notEqual(f.app.media,oldMedia)
 response=await f.request('/api/config',{method:'PUT',headers:{'X-Studio-Project':before},body:{patch:{scene:{title:'旧页面误写'}}}})
 assert.equal(response.status,409);assert.equal((await response.json()).code,'PROJECT_CHANGED');assert.notEqual(f.app.store.get().scene.title,'旧页面误写')
 assert.equal((await f.request('/api/config',{method:'PUT',headers:{'X-Studio-Project':next.id},body:{patch:{scene:{title:'当前场标题'}}}})).status,200)
})

test('a delayed old cue cannot play in the new runtime or publish old media progress after a switch',async t=>{
 const f=await fixture(t),next=await f.create('异步切换场次'),oldMedia=f.app.media,oldDirector=f.app.director
 let entered,release;const started=new Promise(done=>entered=done),gate=new Promise(done=>release=done)
 oldMedia.initialize=async()=>{entered();await gate}
 const speaking=f.request('/api/action',{method:'POST',body:{action:'speech.say',text:'这是旧场次的口播'}});await started
 assert.equal((await f.activate(next.id,{stopCurrent:true})).status,200)
 release();const response=await speaking;assert.equal(response.status,409);assert.equal((await response.json()).code,'PROJECT_CHANGED')
 assert.deepEqual(oldDirector.spoken,[]);assert.deepEqual(f.app.director.spoken,[])
 const count=f.app.events.seq;oldMedia.options.onStatus({unexpected:'old media'});oldMedia.options.onAudio(Buffer.alloc(40));oldMedia.options.onMeter({rms:.8})
 assert.equal(f.app.events.seq,count)
})

test('uploads remain reusable but recordings and generated audio resolve inside the current broadcast',async t=>{
 const f=await fixture(t),original=f.app.projects.activeId
 const shared=f.app.assets.upload(Buffer.from('shared recording'),{filename:'共享录音.mp3',type:'audio'}),first=f.app.runtimeDataDir
 mkdirSync(join(first,'recordings'),{recursive:true});mkdirSync(join(first,'audio'),{recursive:true});writeFileSync(join(first,'recordings/same.mp4'),'first broadcast');writeFileSync(join(first,'audio/voice.mp3'),'first voice')
 assert.equal(readFileSync(f.app.assets.resolveUrl('/assets/recordings/same.mp4'),'utf8'),'first broadcast')
 const next=await f.create('独立录制');await f.activate(next.id)
 assert.equal(readFileSync(f.app.assets.resolveUrl(shared.url),'utf8'),'shared recording')
 assert.throws(()=>f.app.assets.resolveUrl('/assets/recordings/same.mp4'),/ENOENT/);assert.throws(()=>f.app.assets.resolveUrl('/assets/audio/voice.mp3'),/ENOENT/)
 const second=f.app.runtimeDataDir;assert.notEqual(first,second);mkdirSync(join(second,'recordings'),{recursive:true});writeFileSync(join(second,'recordings/same.mp4'),'second broadcast')
 assert.equal(readFileSync(f.app.assets.resolveUrl('/assets/recordings/same.mp4'),'utf8'),'second broadcast')
 await f.activate(original);assert.equal(readFileSync(f.app.assets.resolveUrl('/assets/recordings/same.mp4'),'utf8'),'first broadcast')
})

test('failed target history closes its partially created media and restores the original broadcast',async t=>{
 const f=await fixture(t,{directorFactory:options=>new LiveDirector(options)}),original=f.app.projects.activeId,next=await f.create('损坏的运行记录')
 writeFileSync(join(f.app.projects.directory(next.id),'director-history.json'),'{broken history')
 const response=await f.activate(next.id);assert.equal(response.status,400);assert.equal(f.app.projects.activeId,original)
 assert.equal(f.runtimes.length,3);assert.equal(f.runtimes[0].closed,true);assert.equal(f.runtimes[1].closed,true);assert.equal(f.runtimes[2].closed,false)
 await f.app.close();assert.ok(f.runtimes.every(runtime=>runtime.closed))
})

test('a failing preliminary stop still closes every resource before restoring the previous broadcast',async t=>{
 const f=await fixture(t),next=await f.create('下一场'),oldMedia=f.app.media,oldDirector=f.app.director,oldPlatforms=f.app.platforms,oldChannels=f.app.channels
 oldMedia.stopOutput=async()=>{throw new Error('fixture stop failed')}
 const response=await f.activate(next.id);assert.equal(response.status,400)
 assert.equal(oldMedia.closed,true);assert.equal(oldDirector.closed,true);assert.equal(oldPlatforms.closed,true);assert.equal(oldChannels.closed,true)
 assert.notEqual(f.app.media,oldMedia);assert.equal(f.app.media.closed,false)
})

test('switching invalidates the old renderer token and the old comment ingest key',async t=>{
 const f=await fixture(t),oldToken=f.app.media.options.renderToken,oldKey=f.app.store.secret('commentIngestKey'),next=await f.create('独立接入凭证')
 await f.activate(next.id)
 assert.equal((await f.request('/internal/program',{authenticated:false,headers:{'X-Render-Token':oldToken}})).status,401)
 assert.equal((await f.request('/internal/program',{authenticated:false,headers:{'X-Render-Token':f.app.media.options.renderToken}})).status,200)
 assert.equal((await f.request('/api/comments',{method:'POST',authenticated:false,headers:{'X-Ingest-Key':oldKey},body:{comments:[]}})).status,401)
 assert.equal((await f.request('/api/comments',{method:'POST',authenticated:false,headers:{'X-Ingest-Key':f.app.store.secret('commentIngestKey')},body:{comments:[]}})).status,200)
})

test('startup failure closes the already-listening HTTP server and partially initialized media',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'studio-project-startup-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
 let options,closed=false
 await assert.rejects(createStudio({root,dataDir,port:0,password:'Project-fixture-password-2026',env:{},mediaFactory:value=>{options=value;return {stopOutput:async()=>{},close:async()=>{closed=true}}},providerFactory:()=>({}),directorFactory:()=>{throw new Error('fixture invalid startup history')}}),/fixture invalid startup history/)
 assert.equal(closed,true);await assert.rejects(fetch(options.baseUrl+'/health'),/fetch failed/)
})

test('rename and deletion update metadata without deleting the current broadcast or shared assets',async t=>{
 const f=await fixture(t),current=f.app.projects.activeId,next=await f.create('旧名字')
 let response=await f.request('/api/projects/'+next.id,{method:'PUT',body:{name:'新的名字'}});assert.equal(response.status,200);assert.equal((await response.json()).project.name,'新的名字')
 assert.equal((await f.request('/api/projects/'+current,{method:'DELETE'})).status,409)
 assert.equal((await f.request('/api/projects/'+next.id,{method:'DELETE'})).status,200)
 assert.equal((await f.state()).projects.projects.length,1)
 assert.equal((await f.request('/api/projects/'+current,{method:'PUT',body:{name:'名字',unexpected:'ignored'}})).status,400)
})
