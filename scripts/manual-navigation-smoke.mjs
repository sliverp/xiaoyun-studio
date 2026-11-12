/** Real renderer and PCM playback: switch the picture while retaining the whole audible turn. */
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createStudio} from '../server/http.mjs'
import {pcmWav} from '../server/providers.mjs'
const dir=await mkdtemp(join(tmpdir(),'studio-manual-navigation-')),played=[],duration=6
const tone=Buffer.alloc(48000*duration*4)
for(let i=0;i<48000*duration;i++){const n=Math.round(Math.sin(i*2*Math.PI*440/48000)*7000);tone.writeInt16LE(n,i*4);tone.writeInt16LE(n,i*4+2)}
const audio=join(dir,'speech.wav');await writeFile(audio,pcmWav(tone,48000,2))
const app=await createStudio({root:resolve(import.meta.dirname,'..'),dataDir:join(dir,'server'),port:0,password:'Manual-navigation-fixture-2026',env:{},providerFactory:()=>({status:()=>({demo:false,modelConfigured:true}),generate:async messages=>{const p=JSON.parse(messages[1].content);return JSON.stringify({speech:'现在讲解第'+p.page.number+'页的内容。',navigation:'stay'})},synthesize:async()=>audio})})
app.store.update({bgm:{asset:''},presentation:{url:'/assets/builtin/slides/index.html',autoAdvance:true,loop:true},program:{opening:false,enabled:{source:true,comment:false,engagement:false,lottery:false,sale:false}},output:{width:640,height:360,fps:5}})
app.events.on('event',e=>{if(e.type==='speech')played.push({at:Date.now(),...e.payload})})
const wait=async fn=>{const end=Date.now()+20000;while(!fn()){if(Date.now()>end)throw Error('Timed out waiting for narration');await new Promise(r=>setTimeout(r,30))}}
try{
 const login=await fetch(app.baseUrl+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'Manual-navigation-fixture-2026'})}),cookie=login.headers.get('set-cookie').split(';')[0]
 const action=async action=>{const r=await fetch(app.baseUrl+'/api/action',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({action})});const value=await r.json();assert.equal(r.status,200,value.error);return value}
 await action('live.start');await wait(()=>played.length===1&&app.media.mixer?.queue?.[0]?.started)
 const speech=app.director.currentSpeech,start=played[0].at
 await action('presentation.next')
 assert.equal(app.media.status().slide.pageNumber,2);assert.equal(app.director.currentSpeech.id,speech.id);assert.equal(app.director.paused,false)
 assert.ok(Date.now()-start<duration*1000,'the picture must switch before current audio finishes')
 await wait(()=>played.length>=2)
 assert.ok(played[1].at-start>=5500,'manual navigation must not truncate the six-second utterance')
 assert.match(played[1].text,/第2页/);assert.equal(app.director.currentSpeech.pageKey,app.media.status().slide.pageKey)
 assert.equal(app.media.status().output.running,false)
 console.log(JSON.stringify({passed:true,pictureSwitchedDuringSpeech:true,wholeSixSecondSpeechPreserved:true,nextSpeechUsesSelectedPage:true,automaticOutputNeverStarted:true,firstSpeechMilliseconds:played[1].at-start}))
}finally{await app.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
