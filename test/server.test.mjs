import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {Store} from '../server/store.mjs'
import {Assets} from '../server/assets.mjs'
import {Auth,checkOrigin} from '../server/auth.mjs'
import {createStudio} from '../server/http.mjs'
import {getPersonaPreset} from '../public/personas.mjs'
const root=resolve(import.meta.dirname,'..')
function temporary(t){const d=mkdtempSync(join(tmpdir(),'studio-api-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d}
function fakeMedia(options){return {options,initialize:async()=>{},getFrame:()=>null,getSlideFrame:()=>null,setBgm(){},stopAudio(){},pauseAudio(){},resumeAudio(){},status:()=>({ready:false,slide:{},output:{active:false,state:'stopped'}}),close:async()=>{}}}
function fakeDirector(){return {status:()=>({running:false,paused:false}),programState:()=>({speaking:false}),audioProgress(){},settingsChanged(){},close:async()=>{},addComments(items){this.comments=items},ingestMetrics(){},report:()=>({ok:true})}}
async function fixture(t){const dataDir=temporary(t),app=await createStudio({dataDir,root,host:'127.0.0.1',port:0,password:'Fixture-password-Only-2026',env:{},mediaFactory:fakeMedia,providerFactory:()=>({status:()=>({demo:true})}),directorFactory:fakeDirector});t.after(()=>app.close());const request=(path,options={})=>fetch(app.baseUrl+path,options);const login=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'Fixture-password-Only-2026'})});const cookie=login.headers.get('set-cookie').split(';')[0];return {app,request,cookie}}

test('configuration, stream credentials, uploads and the encoder require authentication',async t=>{
 const {request}=await fixture(t)
 for(const path of ['/api/state','/api/assets','/api/frame.jpg','/internal/program'])assert.equal((await request(path)).status,401)
 assert.equal((await request('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"output.start"}'})).status,401)
 assert.equal((await request('/')).status,200)
})
test('persona templates load publicly but applying and editing a saved persona requires administrator access',async t=>{
 const {app,request,cookie}=await fixture(t)
 const templates=await request('/personas.mjs');assert.equal(templates.status,200);assert.match(await templates.text(),/带货主播/)
 const options={method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({patch:{identity:{personaId:'commerce'}}})}
 assert.equal((await request('/api/config',options)).status,401)
 const saved=await request('/api/config',{...options,headers:{...options.headers,Cookie:cookie}})
 assert.equal(saved.status,200)
 assert.equal((await saved.json()).config.identity.systemPrompt,getPersonaPreset('commerce').prompt)
 const state=await(await request('/api/state',{headers:{Cookie:cookie}})).json()
 assert.equal(state.config.identity.personaId,'commerce')
 assert.equal(app.store.get().identity.systemPrompt,getPersonaPreset('commerce').prompt)
})
test('server secrets persist separately and never appear in state, events or errors',async t=>{
 const {app,request,cookie}=await fixture(t),key='fixture-stream-secret-hidden-123456'
 const result=await request('/api/config',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({patch:{identity:{name:'测试主播'}},secrets:{streamKey:key,llmKey:'fixture-model-secret-987654'}})})
 assert.equal(result.status,200);const text=await result.text();assert.ok(!text.includes(key));assert.match(text,/"streamKey":true/)
 assert.ok(!readFileSync(app.store.file,'utf8').includes(key))
 assert.ok(readFileSync(app.store.secretFile,'utf8').includes(key))
 assert.equal(app.store.redact('bad '+key),'bad [redacted]')
})
test('multiple provider settings preserve private credentials, validate credential sharing, and keep test APIs administrator-only',async t=>{
 const {app,request,cookie}=await fixture(t)
 app.providers.test=async(kind,route)=>({kind,route,elapsedMs:20,path:join(app.runtimeDataDir,'audio','a'.repeat(64)+'.wav')})
 const settings={patch:{llm:{timeoutMs:10000,thinking:'disabled',fallbacks:[{baseUrl:'https://backup.test/v1',model:'backup',keyName:'fallbackKey4'}]},tts:{provider:'tencent',timeoutMs:5000,fallbacks:[{slot:4,provider:'tencent',voice:'501001',speed:1,usePrimaryCredentials:true}]}},secrets:{fallbackKey4:'fixture-model-backup-secret',ttsFallbackSecretId4:'fixture-voice-id',ttsFallbackSecretKey4:'fixture-voice-secret'}}
 const headers={Cookie:cookie,'Content-Type':'application/json','X-Studio-Project':app.projects.activeId}
 const saved=await request('/api/config',{method:'PUT',headers,body:JSON.stringify(settings)});assert.equal(saved.status,200)
 const text=await saved.text();assert.ok(!text.includes('fixture-'));assert.equal(app.store.secret('ttsFallbackSecretKey4'),'fixture-voice-secret')
 const options={method:'POST',headers,body:JSON.stringify({kind:'speech',route:1})}
 assert.equal((await request('/api/providers/test',{...options,headers:{'Content-Type':'application/json'}})).status,401)
 const response=await request('/api/providers/test',options);assert.equal(response.status,200);const result=await response.json();assert.equal(result.path,undefined);assert.equal(result.audioUrl,'/assets/audio/'+'a'.repeat(64)+'.wav');assert.doesNotMatch(JSON.stringify(result),/studio-api-/)
 assert.equal((await request('/api/providers/test',{...options,headers:{...headers,'X-Studio-Project':'stale-project'}})).status,409)
 assert.throws(()=>app.store.update({tts:{fallbacks:[{slot:1,provider:'openai',voice:'alloy',baseUrl:'https://other.test/v1',speed:1,usePrimaryCredentials:true}]}}),/仅腾讯云/)
 assert.throws(()=>app.store.update({llm:{timeoutMs:0}}),/超时/)
 assert.throws(()=>app.store.update({tts:{fallbacks:[{slot:1,provider:'tencent',voice:'501001',speed:1,usePrimaryCredentials:false},{slot:1,provider:'tencent',voice:'602003',speed:1,usePrimaryCredentials:false}]}}),/通道无效/)
})
test('voice audition is private, project-bound and returns a named audio URL without saving draft configuration',async t=>{
 const {app,request,cookie}=await fixture(t),before=app.store.get(),calls=[]
 app.providers.previewSpeech=async data=>{calls.push(data);return {voice:data.voice,voiceName:'云小团',slot:data.slot,elapsedMs:10,path:join(app.runtimeDataDir,'audio','b'.repeat(64)+'.wav')}}
 const headers={Cookie:cookie,'Content-Type':'application/json','X-Studio-Project':app.projects.activeId},body=JSON.stringify({slot:0,voice:'402001',speed:1,text:'试听。',provider:'tencent'})
 assert.equal((await request('/api/providers/preview',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401)
 assert.equal((await request('/api/providers/preview',{method:'POST',headers:{...headers,'X-Studio-Project':'stale-scene'},body})).status,409)
 assert.equal(calls.length,0)
 const response=await request('/api/providers/preview',{method:'POST',headers,body});assert.equal(response.status,200);const result=await response.json()
 assert.equal(result.voiceName,'云小团');assert.equal(result.audioUrl,'/assets/audio/'+'b'.repeat(64)+'.wav');assert.equal(result.path,undefined);assert.deepEqual(app.store.get(),before)
 for(const data of [{slot:5,voice:'402001'},{slot:0,voice:'402001',baseUrl:'https://unexpected.test'}])assert.equal((await request('/api/providers/preview',{method:'POST',headers,body:JSON.stringify(data)})).status,400)
 assert.equal((await request(result.audioUrl)).status,401)
})
test('the prompt viewer returns actual saved stage instructions only to administrators without exposing provider secrets',async t=>{
 const {app,request,cookie}=await fixture(t)
 app.store.update({identity:{systemPrompt:'当前保存的人格提示词。',welcome:'这是保存的欢迎词。'},live:{pageSeconds:25,commentSeconds:9,engagementPrompt:'围绕刚讲的例子提问。'}})
 app.store.setSecrets({llmKey:'fixture-prompt-viewer-private-key'})
 assert.equal((await request('/api/prompts')).status,401)
 const response=await request('/api/prompts',{headers:{Cookie:cookie}}),data=await response.json()
 assert.equal(response.status,200);assert.ok(data.system.startsWith('当前保存的人格提示词。'))
 assert.match(data.stages.find(stage=>stage.id==='source').instruction,/25秒/);assert.match(data.stages.find(stage=>stage.id==='comment').instruction,/9秒/)
 assert.match(data.stages.find(stage=>stage.id==='engagement').instruction,/围绕刚讲的例子提问/)
 assert.equal(data.stages.find(stage=>stage.id==='opening').instruction,'这是保存的欢迎词。');assert.equal(data.stages.find(stage=>stage.id==='lottery').mode,'fixed')
 assert.ok(!JSON.stringify(data).includes('fixture-prompt-viewer-private-key'))
})
test('render tokens grant only scene and asset reads, never administrator APIs',async t=>{
 const {app,request}=await fixture(t),headers={'X-Render-Token':app.media.options.renderToken}
 assert.equal((await request('/internal/program',{headers})).status,200)
 assert.equal((await request('/assets/builtin/slides/index.html',{headers})).status,200)
 assert.equal((await request('/api/state',{headers})).status,401)
 assert.equal((await request('/api/action',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"action":"output.start"}'})).status,401)
})
test('cross-origin mutations and prototype action names are rejected',async t=>{
 const {request,cookie}=await fixture(t)
 for(const origin of ['https://elsewhere.test','null'])assert.equal((await request('/api/config',{method:'PUT',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,403)
 for(const action of ['constructor','toString','__proto__']){const response=await request('/api/action',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({action})});assert.equal(response.status,400);assert.match(await response.text(),/操作不存在/)}
})
test('uploads retain Chinese display names, disallow executable formats and attach uploaded HTML for controllers',async t=>{
 const {request,cookie}=await fixture(t),headers={Cookie:cookie,'X-Filename':encodeURIComponent('直播材料.html'),'X-Asset-Type':'html','Content-Type':'text/html'}
 const upload=await request('/api/upload',{method:'POST',headers,body:'<html><body>自己的演示内容</body></html>'});assert.equal(upload.status,201)
 const data=await upload.json();assert.equal(data.asset.name,'直播材料.html');const content=await request(data.url,{headers:{Cookie:cookie}});assert.match(content.headers.get('content-disposition'),/attachment/)
 const bad=await request('/api/upload',{method:'POST',headers:{...headers,'X-Filename':'unsafe.svg','X-Asset-Type':'image'},body:'<svg></svg>'});assert.equal(bad.status,400)
})
test('comment ingress key only permits incoming comments and metrics',async t=>{
 const {app,request}=await fixture(t),headers={'X-Ingest-Key':app.store.secret('commentIngestKey'),'Content-Type':'application/json'}
 const response=await request('/api/comments',{method:'POST',headers,body:JSON.stringify({comments:[{nickname:'观众',content:'支持独立部署吗',id:'1'}]})});assert.equal(response.status,200);assert.equal(app.director.comments.length,1)
 assert.equal((await request('/api/state',{headers})).status,401)
})
test('settings reject prototype pollution, invalid scene/cue data, arbitrary demo paths and oversized QR duration',t=>{
 const store=new Store({dataDir:temporary(t),root,env:{}})
 assert.throws(()=>store.update(JSON.parse('{"__proto__":{"polluted":true}}')),/无效|未知/)
 assert.equal({}.polluted,undefined)
 assert.throws(()=>store.update({cues:[null]}),/固定口播/)
 assert.throws(()=>store.update({scene:{layout:{mode:'bad'}}}),/布局/)
 assert.throws(()=>store.update({tts:{demoAsset:'/etc/passwd'}}),/不可/)
 assert.throws(()=>store.update({sale:{durationSeconds:1801}}),/1–30/)
 store.update({sale:{durationSeconds:1800}});assert.equal(store.get().sale.durationSeconds,1800)
})
test('asset paths and symlinks cannot escape their owned directory',t=>{
 const dir=temporary(t),assets=new Assets({root,dataDir:dir});writeFileSync(join(dir,'private.txt'),'not an asset')
 assert.throws(()=>assets.resolveUrl('/assets/uploads/../../private.txt'))
 symlinkSync(join(dir,'private.txt'),join(dir,'assets/escape.txt'));assert.throws(()=>assets.resolveUrl('/assets/uploads/escape.txt'))
})
test('password attempts are limited and logout revokes the current controller session',t=>{
 const auth=new Auth({dataDir:temporary(t),password:'Long-fixture-password-2026'}),req={headers:{},socket:{remoteAddress:'test'}}
 for(let i=0;i<10;i++)assert.throws(()=>auth.login(req,'wrong'),/不正确/)
 assert.throws(()=>auth.login(req,'Long-fixture-password-2026'),/次数/)
 const other={headers:{},socket:{remoteAddress:'other'}},cookie=auth.login(other,'Long-fixture-password-2026');other.headers.cookie=cookie.split(';')[0]
 assert.equal(auth.isAuthenticated(other),true);auth.logout(other);assert.equal(auth.isAuthenticated(other),false)
 assert.throws(()=>checkOrigin({method:'POST',headers:{origin:'null',host:'localhost'}}),e=>e.status===403)
})

test('closing an app with live SSE subscribers removes event listeners before shutdown publications',async t=>{
 const dataDir=temporary(t),app=await createStudio({dataDir,root,port:0,password:'Fixture-password-Only-2026',env:{},mediaFactory:fakeMedia,providerFactory:()=>({status:()=>({demo:true})}),directorFactory:fakeDirector,channelsFactory:options=>({status:()=>({state:'disconnected'}),close:async()=>options.onStatus({state:'disconnected'})})})
 t.after(()=>app.close())
 const login=await fetch(app.baseUrl+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'Fixture-password-Only-2026'})}),cookie=login.headers.get('set-cookie').split(';')[0]
 const response=await fetch(app.baseUrl+'/api/events',{headers:{Cookie:cookie}}),reader=response.body.getReader()
 await reader.read();assert.equal(app.events.listenerCount('event'),1)
 await app.close();assert.equal(app.events.listenerCount('event'),0);await reader.cancel()
})


test('authenticated manual page actions are accepted while AI speech is playing',async t=>{
 const {app,request,cookie}=await fixture(t),directions=[]
 app.media.openPresentation=async()=>{}
 app.director.status=()=>({running:true,paused:false})
 app.director.navigatePresentation=async direction=>{directions.push(direction)}
 for(const [action,direction]of [['presentation.next','next'],['presentation.prev','prev'],['presentation.first','first']]){
  const r=await request('/api/action',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({action})})
  assert.equal(r.status,200);assert.equal(directions.at(-1),direction)
 }
})
