import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createStudio} from '../server/http.mjs'

const root=resolve(import.meta.dirname,'..'),password='Broadcast-test-password-2026'
async function fixture(t){
 const dataDir=mkdtempSync(join(tmpdir(),'studio-broadcast-api-'))
 const app=await createStudio({root,dataDir,password,port:0,env:{},mediaFactory:options=>{
  const media={output:{running:false,active:false,state:'stopped',platforms:[]},ready:false,setBgm(){},stopAudio(){},status(){return {ready:this.ready,output:this.output,slide:{pageNumber:1}}},async initialize(){this.ready=true},async close(){},async startOutput(){this.output={running:true,active:false,state:'starting',platforms:[]};options.onStatus(this.status())},async stopOutput(){this.output={running:false,active:false,state:'stopped',platforms:[]};options.onStatus(this.status())},confirm(){this.output={running:true,active:true,state:'streaming',platforms:[{id:'bili',platform:'bilibili',name:'直播账号',state:'streaming',active:true}]};options.onStatus(this.status())}}
  return media
 },providerFactory:()=>({status:()=>({demo:true})})})
 t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true})})
 let cookie=''
 const request=(path,{method='GET',body,auth=true,headers={}}={})=>fetch(app.baseUrl+path,{method,headers:{...(auth?{Cookie:cookie}:{}),...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined})
 const login=await request('/api/login',{method:'POST',body:{password},auth:false});cookie=login.headers.get('set-cookie').split(';')[0]
 const action=async name=>{const response=await request('/api/action',{method:'POST',body:{action:name}});assert.equal(response.status,200,await response.clone().text());return response.json()}
 return {app,request,action}
}

test('broadcast endpoints authenticate separately from the comment ingest key',async t=>{
 const {app,request}=await fixture(t)
 assert.equal((await request('/api/broadcasts',{auth:false})).status,401)
 assert.equal((await request('/api/broadcasts',{auth:false,headers:{'X-Ingest-Key':app.store.secret('commentIngestKey')}})).status,401)
 assert.equal((await request('/api/broadcasts?limit=201')).status,400)
 assert.equal((await request('/broadcasts-ui.mjs',{auth:false})).status,200)
})

test('preview and output preparation do not create runs; a confirmed sink creates one and stop archives it',async t=>{
 const {app,request,action}=await fixture(t)
 await action('preview.start');assert.equal(app.broadcasts.state().total,0)
 await action('output.start');assert.equal(app.broadcasts.state().total,0)
 app.media.confirm();const id=app.broadcasts.active.id
 await request('/api/comments',{method:'POST',body:{comments:[{id:'comment-a',nickname:'观众',content:'你好'}]}})
 await request('/api/metrics',{method:'POST',body:{onlineUsers:11,likes:0}})
 await action('output.stop')
 const detail=await(await request('/api/broadcasts/'+id)).json()
 assert.equal(detail.session.status,'ended');assert.equal(detail.session.commentCount,1);assert.equal(detail.session.peakOnline,11)
 assert.equal(detail.events.find(event=>event.type==='comment').data.content,'你好')
 const exported=await(await request('/api/broadcasts/'+id+'/export')).json();assert.equal(exported.session.id,id);assert.equal(exported.events.length,exported.session.eventCount)
})

test('two external runs in one scene isolate counters and accept fresh identical message IDs',async t=>{
 const {app,request,action}=await fixture(t)
 await action('broadcast.external.start');const first=app.broadcasts.active.id
 await request('/api/comments',{method:'POST',body:{comments:[{id:'repeat',content:'第一场'}]}})
 await request('/api/comments',{method:'POST',body:{comments:[{id:'repeat',content:'重复包'}]}})
 await action('broadcast.external.start');assert.equal(app.broadcasts.state().total,1)
 await action('broadcast.end');await action('broadcast.external.start')
 const second=app.broadcasts.active.id;assert.notEqual(second,first)
 await request('/api/comments',{method:'POST',body:{comments:[{id:'repeat',content:'第二场'}]}})
 await action('broadcast.end')
 assert.equal(app.broadcasts.get(first).commentCount,1);assert.equal(app.broadcasts.get(second).commentCount,1)
 const state=await(await request('/api/state')).json();assert.equal(state.broadcasts.total,2);assert.equal(state.projects.projects.length,1)
})

test('scene switching ends the current run and copying a scene never copies broadcast history',async t=>{
 const {app,request,action}=await fixture(t),original=app.projects.activeId
 await action('broadcast.external.start');const id=app.broadcasts.active.id
 const copy=await(await request('/api/projects',{method:'POST',body:{name:'副本场景',copyCurrent:true}})).json()
 assert.equal((await request(`/api/projects/${copy.project.id}/activate`,{method:'POST',body:{}})).status,409)
 assert.equal((await request(`/api/projects/${copy.project.id}/activate`,{method:'POST',body:{stopCurrent:true}})).status,200)
 assert.equal(app.broadcasts.state().total,0);assert.equal((await request('/api/broadcasts/'+id)).status,404)
 await request(`/api/projects/${original}/activate`,{method:'POST',body:{}})
 assert.equal(app.broadcasts.get(id).status,'ended');assert.equal(app.broadcasts.get(id).endReason,'scene-switched')
})
