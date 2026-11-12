/** Real Chromium and PCM: several paragraphs per page, comments between paragraphs, independent engagement. */
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createStudio} from '../server/http.mjs'
import {pcmWav} from '../server/providers.mjs'
const dir=await mkdtemp(join(tmpdir(),'studio-live-pacing-')),work=resolve(process.env.LIVE_PACING_WORK_DIR||'.data/live-pacing'),audio=join(dir,'tone.wav'),pcm=Buffer.alloc(48000*4*.8),started=[],completed=[]
await mkdir(work,{recursive:true});for(let n=0;n<pcm.length/4;n++){const v=Math.round(Math.sin(n*2*Math.PI*440/48000)*6000);pcm.writeInt16LE(v,n*4);pcm.writeInt16LE(v,n*4+2)}await writeFile(audio,pcmWav(pcm,48000,2))
const app=await createStudio({dataDir:join(dir,'server'),port:0,password:'Live-pacing-smoke-only-2026',env:{},providerFactory:()=>({status:()=>({demo:false,modelConfigured:true}),generate:async messages=>{const p=JSON.parse(messages[1].content);if(p.stage==='source'){assert.ok(p.pageProgress);return JSON.stringify({speech:'第'+p.page.number+'页第'+p.pageProgress.turnNumber+'段重点。',navigation:'next'})}return JSON.stringify({speech:p.stage==='comment'?'看到大家的留言，接着讲这个细节。':'你更想了解哪一个细节？',navigation:'stay',...(p.stage==='comment'?{answeredIds:p.candidates.filter(c=>c.canReply).map(c=>c.id)}:{})})},synthesize:async()=>audio})})
app.store.update({bgm:{asset:''},presentation:{autoAdvance:true,loop:true},program:{opening:false,enabled:{source:true,comment:true,engagement:true,lottery:false,sale:false}},live:{minPageTurns:4,commentFrequency:50,engagementMinTurns:5,engagementCooldownSeconds:0},output:{width:640,height:360,fps:5}})
const record=app.director.onRecord;app.director.onRecord=(type,payload)=>{if(type==='speech')completed.push(payload);record(type,payload)}
app.events.on('event',e=>{if(e.type==='speech'){const turn=app.director.currentSpeech;started.push({kind:e.payload.kind,page:app.media.status().slide.pageNumber,paragraph:turn.kind==='source'?turn.projection.memory.turns+1:null,at:Date.now()});if(turn.kind==='source'&&turn.projection.page.pageNumber===1&&[1,3].includes(turn.projection.memory.turns+1))app.director.addComments([{id:'test-'+turn.projection.memory.turns,content:'开启秒杀'}])}})
const wait=async fn=>{const end=Date.now()+35000;while(!fn()){if(Date.now()>end)throw Error('Live pacing did not reach the expected paragraph');await new Promise(r=>setTimeout(r,25))}}
try{
 await app.director.start();await wait(()=>started.some(e=>e.kind==='source'&&e.page===2&&e.paragraph===2))
 assert.deepEqual(started.filter(e=>e.kind==='source'&&e.page===1).map(e=>e.paragraph),[1,2,3,4]);assert.equal(started.filter(e=>e.kind==='comment'&&e.page===1).length,2)
 assert.deepEqual(started.slice(0,7).map(e=>e.kind),['source','source','comment','source','source','comment','source'])
 assert.equal(started.find(e=>e.kind==='engagement').page,2);assert.equal(completed.filter(e=>e.kind==='source'&&e.pageNumber===1).length,4)
 assert.equal(app.media.status().output.running,false)
 const result={passed:true,realChromiumAndPcm:true,fourWholeParagraphsOnFirstPage:true,twoCommentRepliesWithinFirstPage:true,engagementIndependentOnSecondPage:true,earlyModelNextBlocked:true,outputNeverStarted:true,sequence:started.map(({kind,page,paragraph})=>({kind,page,paragraph}))};await writeFile(join(work,'media-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await app.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
