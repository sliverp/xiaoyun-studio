import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MediaEngine} from '../server/media.mjs'
import {containerMemory,renderMaintenance} from '../server/render-resources.mjs'
const flush=()=>new Promise(setImmediate)
function engineFor(t,options={}){
 const dataDir=mkdtempSync(join(tmpdir(),'studio-render-recovery-')),engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'fixture-private-render',getSettings:()=>({output:{fps:15}}),...options})
 t.after(async()=>{await engine.close();rmSync(dataDir,{recursive:true,force:true})});return engine
}
const page=()=>Object.assign(new EventEmitter(),{isClosed:()=>false,viewport:()=>({width:1280,height:720})})

test('a closed or disconnected render page is never advertised as ready',async t=>{
 const engine=engineFor(t),p=page(),b={connected:true,async close(){}}
 engine.browser=b;engine.programPage=p;engine.browserHealthy=true;assert.equal(engine.status().ready,true)
 p.isClosed=()=>true;assert.equal(engine.status().ready,false)
 p.isClosed=()=>false;b.connected=false;assert.equal(engine.status().ready,false)
})
test('page crashes retire one owned browser, preserve the last frame, and ignore old-page events',async t=>{
 const engine=engineFor(t),p=page();let closes=0,recoveries=0
 const old={connected:true,async close(){closes++}};engine.browser=old;engine.programPage=p;engine.browserHealthy=true;engine.frame=Buffer.from('last-good-frame');engine.recoverBrowser=async()=>{recoveries++};engine.watchPage(p,old)
 p.emit('error',new Error('Page crashed'));p.emit('close');p.emit('error',new Error('Session closed'))
 await engine.browserCleanup;assert.equal(closes,1);assert.equal(recoveries,1);assert.equal(engine.status().ready,false);assert.equal(engine.frame.toString(),'last-good-frame')
 const fresh={connected:true,async close(){}};engine.browser=fresh;engine.programPage=page();engine.browserHealthy=true
 engine.loseBrowser(old,'late crash from old process');await engine.releaseBrowser(old)
 assert.equal(engine.browser,fresh);assert.equal(engine.status().ready,true);assert.equal(closes,1)
})
test('a replacement waits for the old browser to release its profile',async t=>{
 const engine=engineFor(t);let finishClose,closeEntered,launches=0
 const closing=new Promise(resolve=>{finishClose=resolve}),entered=new Promise(resolve=>{closeEntered=resolve})
 engine.browser={async close(){closeEntered();await closing}};engine.programPage=page()
 engine.openBrowser=async()=>{launches++;engine.browser={connected:true,async close(){}};engine.programPage=page();engine.browserHealthy=true}
 const initializing=engine.initialize();await entered;assert.equal(launches,0)
 finishClose();await initializing;assert.equal(launches,1);assert.equal(engine.status().ready,true)
})
test('a retired screenshot timing out cannot report a new failure or kill the recovered browser',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const engine=engineFor(t);let kills=0
 const old={async close(){},process:()=>({kill(){kills++}})},p={isClosed:()=>false,async bringToFront(){},screenshot:()=>new Promise(()=>{})}
 engine.browser=old;const pending=engine.snapshotPage(p,{}),rejected=assert.rejects(pending,error=>error.name==='AbortError');await flush()
 const fresh={async close(){},process:()=>({kill(){kills++}})};engine.browser=fresh;engine.programPage=page();engine.browserHealthy=true;engine.frame=Buffer.from('recovered frame')
 t.mock.timers.tick(10000);await rejected;assert.equal(kills,0);assert.equal(engine.status().ready,true);assert.equal(engine.status().error,'');assert.equal(engine.frame.toString(),'recovered frame')
})
test('a closed session during initialization is cleaned up and reported without raw protocol details',async t=>{
 let closes=0;const p=Object.assign(page(),{url:()=> 'about:blank',async setRequestInterception(){},async setBypassServiceWorker(){throw new Error('Protocol error (Network.setBypassServiceWorker): Session closed. Most likely the page has been closed.')}})
 const b={connected:true,pages:async()=>[p],once(){},async close(){closes++}},engine=engineFor(t,{launch:async()=>b});engine.tools={ready:true,chromium:{path:'fixture-only'}}
 await assert.rejects(engine.initialize(),/渲染页面意外退出/)
 assert.equal(closes,1);assert.equal(engine.browser,null);assert.equal(engine.status().ready,false);assert.doesNotMatch(engine.status().error,/Protocol error|Network\.setBypassServiceWorker/)
 await engine.close()
})
test('renderer teardown has a deadline and terminates only its own stuck child',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const engine=engineFor(t),child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});const signals=[]
 child.kill=signal=>{signals.push(signal);child.signalCode=signal;child.emit('exit',null,signal)}
 const b={connected:true,process:()=>child,close:()=>new Promise(()=>{})};engine.browser=b;engine.programPage=page()
 const releasing=engine.releaseBrowser(b);await flush();t.mock.timers.tick(5000);await releasing
 assert.deepEqual(signals,['SIGKILL']);assert.equal(engine.browser,null)
})
test('exhausted recovery retries later even when no controller browser is open',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const engine=engineFor(t);let attempts=0
 engine.initialize=async()=>{attempts++;throw new Error('fixture resource pressure')}
 const first=engine.recoverBrowser()
 for(const duration of [1000,2000,4000]){t.mock.timers.tick(duration);await flush()}
 await first;assert.equal(attempts,3);assert.equal(engine.status().browserRecovering,false);assert.match(engine.status().error,/30秒/)
 t.mock.timers.tick(30000);await flush();t.mock.timers.tick(1000);await flush();assert.equal(attempts,4)
 await engine.close();t.mock.timers.tick(60000);await flush();assert.equal(attempts,4)
})
test('memory pressure reclaims browser caches during output without stopping the output graph or mixer',async t=>{
 const engine=engineFor(t);let stopped=0,closed=0
 engine.browser={connected:true,async close(){closed++}};engine.programPage=page();engine.browserHealthy=true;engine.frame=Buffer.from('last-output-frame')
 engine.outputGraph.stop=async()=>{stopped++};engine.mixer.stop=()=>{stopped++};engine.recoverBrowser=async()=>{}
 engine.loseBrowser(engine.browser,'memory maintenance');await engine.browserCleanup
 assert.equal(stopped,0);assert.equal(closed,1);assert.equal(engine.frame.toString(),'last-output-frame')
})
test('container memory guards support finite cgroup v2 and v1 budgets without using host-wide memory',()=>{
 const read=values=>path=>{if(!(path in values))throw new Error('missing');return values[path]}
 assert.deepEqual(containerMemory(read({'/sys/fs/cgroup/memory.current':'123\n','/sys/fs/cgroup/memory.max':'1024\n'})),{used:123,limit:1024})
 assert.deepEqual(containerMemory(read({'/sys/fs/cgroup/memory/memory.usage_in_bytes':'200','/sys/fs/cgroup/memory/memory.limit_in_bytes':'2048'})),{used:200,limit:2048})
 assert.deepEqual(containerMemory(read({'/sys/fs/cgroup/memory.current':'900','/sys/fs/cgroup/memory.max':'1000','/sys/fs/cgroup/memory.stat':'anon 200\ninactive_file 700\n'})),{used:200,limit:1000},'reclaimable recording-file cache must not repeatedly restart an otherwise healthy renderer')
 assert.equal(containerMemory(read({'/sys/fs/cgroup/memory.current':'123','/sys/fs/cgroup/memory.max':'max'})),null)
 assert.equal(containerMemory(read({})),null)
})
test('memory maintenance is throttled and age-based refresh waits for output and speech to become idle',()=>{
 const base={now:3*60*60*1000,openedAt:1000,lastMaintenanceAt:0,outputRunning:false,voiceActive:false,memory:null}
 assert.match(renderMaintenance(base),/维护/)
 assert.equal(renderMaintenance({...base,outputRunning:true}),'');assert.equal(renderMaintenance({...base,voiceActive:true}),'')
 assert.match(renderMaintenance({...base,outputRunning:true,memory:{used:85,limit:100}}),/内存/)
 assert.equal(renderMaintenance({...base,lastMaintenanceAt:base.now-1000,memory:{used:95,limit:100}}),'')
 assert.equal(renderMaintenance({...base,openedAt:0,memory:{used:95,limit:100}}),'')
})
