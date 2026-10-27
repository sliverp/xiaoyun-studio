import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {Store} from '../server/store.mjs'
import {Assets} from '../server/assets.mjs'
import {Auth,checkOrigin} from '../server/auth.mjs'
import {createStudio} from '../server/http.mjs'
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
test('server secrets persist separately and never appear in state, events or errors',async t=>{
 const {app,request,cookie}=await fixture(t),key='fixture-stream-secret-hidden-123456'
 const result=await request('/api/config',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({patch:{identity:{name:'测试主播'}},secrets:{streamKey:key,llmKey:'fixture-model-secret-987654'}})})
 assert.equal(result.status,200);const text=await result.text();assert.ok(!text.includes(key));assert.match(text,/"streamKey":true/)
 assert.ok(!readFileSync(app.store.file,'utf8').includes(key))
 assert.ok(readFileSync(app.store.secretFile,'utf8').includes(key))
 assert.equal(app.store.redact('bad '+key),'bad [redacted]')
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
