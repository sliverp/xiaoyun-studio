import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {buildOutputArgs,joinStreamDestination,redactMediaError,MediaEngine,detectTools} from '../server/media.mjs'
import {AudioMixer,FRAME_BYTES} from '../server/audio-mixer.mjs'
import {blockedPresentationAddress,createPresentationNetworkPolicy} from '../server/media-network.mjs'

const sample=value=>{const buffer=Buffer.alloc(FRAME_BYTES);for(let at=0;at<buffer.length;at+=2)buffer.writeInt16LE(value,at);return buffer}
function controlledMixer(t){const frames=[],meters=[],mixer=new AudioMixer({ffmpeg:'not-spawned',onPcm:pcm=>frames.push(pcm),onMeter:meter=>meters.push(meter)});clearInterval(mixer.timer);t.after(()=>mixer.close());return {mixer,frames,meters}}

test('joining RTMP server and key preserves key parameters and rejects output injection',()=>{
 assert.equal(joinStreamDestination('rtmp://example.test/live/','stream?token=value'),'rtmp://example.test/live/stream?token=value')
 assert.equal(joinStreamDestination('rtmps://example.test/live/key',''),'rtmps://example.test/live/key')
 for(const [url,key] of [['https://example.test','key'],['rtmp://user:password@example.test/live','key'],['rtmp://example.test/live','a|b'],['rtmp://example.test/live','a\nb']])assert.throws(()=>joinStreamDestination(url,key))
})
test('diagnostics do not disclose stream destinations, query tokens or configured secrets',()=>{
 const error=redactMediaError('failure rtmp://host/live/private?auth=hidden https://host/program?renderToken=renderSecret secret-key',['secret-key','renderSecret'])
 assert.doesNotMatch(error,/private|hidden|renderSecret|secret-key/)
 assert.match(error,/RTMP destination/)
})
test('one encoder produces encoded MPEG-TS without owning any platform destination',()=>{
 const args=buildOutputArgs({width:1280,height:720,fps:15,videoBitrate:'2500k',audioBitrate:'128k'})
 assert.ok(args.includes('pipe:0'));assert.ok(args.includes('pipe:3'));assert.ok(args.includes('libx264'));assert.ok(args.includes('aac'))
 assert.equal(args.at(-1),'pipe:1');assert.equal(args.at(-2),'mpegts');assert.equal(args.filter(value=>value==='libx264').length,1)
 assert.ok(!args.includes('tee'))
})
test('speech completes only after its last PCM frame is consumed, and pause does not advance it',async t=>{
 const {mixer,frames}=controlledMixer(t);let reads=0,completed=false
 const entry={source:{read(){reads++;return {buffer:sample(1000),used:FRAME_BYTES,done:true}},close(){}},resolve(){completed=true},reject(){},signal:null}
 mixer.queue.push(entry);mixer.pause();mixer.tick();assert.equal(reads,0);assert.equal(completed,false);assert.equal(frames[0].readInt16LE(0),0)
 mixer.resume();mixer.tick();assert.equal(reads,1);assert.equal(completed,true);assert.equal(frames[1].readInt16LE(0),1000)
})
test('BGM is ducked under real speech, mixed without clipping and restored afterward',t=>{
 const {mixer,frames}=controlledMixer(t)
 mixer.volume=.5;mixer.ducking=.2;mixer.bgm={read:()=>({buffer:sample(10000),used:FRAME_BYTES}),close(){}}
 mixer.queue.push({source:{read:()=>({buffer:sample(30000),used:FRAME_BYTES,done:true}),close(){}},resolve(){},reject(){}})
 mixer.tick();assert.equal(frames[0].readInt16LE(0),31000)
 mixer.tick();assert.equal(frames[1].readInt16LE(0),5000)
})
test('output backpressure retains voice position and immediate stop settles waiting speech',t=>{
 const {mixer}=controlledMixer(t);let reads=0,rejected=false
 mixer.canOutput=()=>false;mixer.queue.push({source:{read(){reads++;return {buffer:sample(5),used:FRAME_BYTES}},close(){}},resolve(){},reject(error){rejected=error.name==='AbortError'}})
 mixer.tick();assert.equal(reads,0);mixer.stop();assert.equal(rejected,true);assert.equal(mixer.queue.length,0)
})
test('remote slides cannot reach link-local metadata or private hosts without deployment authorization',async()=>{
 for(const host of ['127.0.0.1','10.1.2.3','172.16.2.3','192.168.1.1','169.254.169.254','100.100.100.200','::1','fc00::1','fd00:ec2::254','::ffff:7f00:1','::ffff:a9fe:a9fe'])assert.equal(blockedPresentationAddress(host),true,host)
 assert.equal(blockedPresentationAddress('169.254.169.254',{allowPrivate:true}),true)
 assert.equal(blockedPresentationAddress('100.100.100.200',{allowPrivate:true}),true)
 assert.equal(blockedPresentationAddress('::ffff:a9fe:a9fe',{allowPrivate:true}),true)
 assert.equal(blockedPresentationAddress('8.8.8.8'),false)
 const policy=createPresentationNetworkPolicy('http://127.0.0.1:18359');assert.deepEqual(await policy('http://127.0.0.1:18359/assets/deck.html'),{local:true})
 await assert.rejects(policy('http://169.254.169.254/latest/meta-data'))
 await assert.rejects(policy('file:///etc/passwd'))
 await assert.rejects(policy('javascript:alert(1)'))
})
test('configuration rejects invalid dimensions before launching a browser or contacting a destination',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'studio-media-test-')),engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}})})
 t.after(async()=>{await engine.close();rmSync(dataDir,{recursive:true,force:true})})
 assert.throws(()=>engine.validateOutput({width:1279}),/分辨率/)
 assert.throws(()=>engine.validateOutput({fps:60}),/帧率/)
 assert.throws(()=>engine.validateOutput({videoBitrate:'arbitrary'}),/码率/)
 await assert.rejects(engine.startOutput({rtmpUrl:'https://example.test'}))
 assert.equal(engine.status().output.active,false);assert.doesNotMatch(JSON.stringify(engine.status()),/private-render/)
 assert.equal(typeof detectTools().ready,'boolean')
})

test('stopping during output preparation promptly cancels encoding and ignores late preparation completion',{timeout:5000},async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'studio-prepare-cancel-')),engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}})})
 t.after(async()=>{await engine.close();rmSync(dataDir,{recursive:true,force:true})})
 let entered,release,encoderStarts=0,viewportChanges=0,captures=0,signal
 const prepared=new Promise(resolve=>{entered=resolve}),pending=new Promise(resolve=>{release=resolve})
 engine.initialize=async()=>{};engine.programPage={viewport:()=>({width:640,height:360}),async setViewport(){viewportChanges++}};engine.capture=async()=>{captures++};engine.outputGraph.startEncoder=()=>{encoderStarts++}
 const starting=engine.startOutput({destinations:[{id:'one',platform:'custom',name:'本地测试',rtmpUrl:'rtmp://example.test/live',streamKey:'fixture-only'}],record:false},{prepare:async options=>{signal=options.signal;entered();await pending}})
 const rejected=assert.rejects(starting,error=>error.name==='AbortError')
 await prepared;assert.equal(engine.status().output.running,true);assert.equal(engine.status().output.state,'preparing')
 await engine.stopOutput();await rejected;assert.equal(signal.aborted,true);assert.equal(encoderStarts,0)
 release();await Promise.resolve();await Promise.resolve();await Promise.resolve()
 assert.equal(viewportChanges,0);assert.equal(captures,0);assert.equal(engine.status().output.running,false);assert.ok(engine.status().output.platforms.every(item=>!item.active))
})

test('render authentication is attached to local reads and stripped on external redirects',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'studio-render-auth-')),engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}})})
 t.after(async()=>{await engine.close();rmSync(dataDir,{recursive:true,force:true})})
 engine.networkPolicy=async url=>({local:new URL(url).origin==='http://localhost:18359'})
 let handler;await engine.authenticateLocalRequests({async setRequestInterception(){},on(name,fn){handler=fn}})
 for(const [url,method,expected] of [['http://localhost:18359/assets/test.pdf','GET','private-render'],['https://external.test/redirect','GET',undefined],['http://localhost:18359/api/action','POST',undefined]]){
  let options;await handler({url:()=>url,method:()=>method,headers:()=>({'x-render-token':'stale'}),async continue(value){options=value},async abort(){assert.fail('valid request was unexpectedly blocked')}})
  assert.equal(options.headers['x-render-token'],expected)
 }
})
test('an operator audio callback receives PCM without an output and cannot stop broadcast on disconnect',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'studio-audio-monitor-'));let bytes=0
 const engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}}),onAudio:pcm=>{bytes+=pcm.length;throw new Error('monitor disconnected')}})
 t.after(async()=>{await engine.close();rmSync(dataDir,{recursive:true,force:true})})
 engine.writePcm(Buffer.alloc(FRAME_BYTES));assert.equal(bytes,FRAME_BYTES);assert.equal(engine.status().output.active,false)
})
test('closing still releases the mixer and browser when output teardown rejects',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'studio-close-failure-')),engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}})}),failure=new Error('fixture output close failure')
 t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
 let browserClosed=false;engine.mixer||={closed:false,close(){this.closed=true}};engine.browser={async close(){browserClosed=true}};engine.programPage={};engine.deckPage={};engine.outputGraph.close=async()=>{throw failure}
 await assert.rejects(engine.close(),error=>error===failure)
 assert.equal(engine.mixer.closed,true);assert.equal(browserClosed,true);assert.equal(engine.browser,null);assert.equal(engine.programPage,null);assert.equal(engine.deckPage,null)
 await assert.rejects(engine.close(),error=>error===failure)
})
test('close callers wait until a delayed browser launch releases its profile',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'studio-late-browser-'));let finishLaunch,finishBrowserClose,enteredClose,firstClosed=false,secondClosed=false,closeCalls=0,profileHeld=false
 const launched=new Promise(resolve=>{finishLaunch=resolve}),browserClosed=new Promise(resolve=>{finishBrowserClose=resolve}),closeEntered=new Promise(resolve=>{enteredClose=resolve})
 const browser={async close(){closeCalls++;enteredClose();await browserClosed;profileHeld=false}}
 const engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}}),launch:()=>launched})
 engine.tools={ready:true,chromium:{path:'fixture-chromium'},ffmpeg:{path:null,available:false}}
 t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
 const initializing=engine.initialize(),rejected=assert.rejects(initializing,/取消/),first=engine.close().then(()=>{firstClosed=true}),second=engine.close().then(()=>{secondClosed=true})
 await Promise.resolve();assert.equal(firstClosed,false);assert.equal(secondClosed,false)
 profileHeld=true;finishLaunch(browser);await closeEntered
 assert.equal(profileHeld,true);assert.equal(firstClosed,false);assert.equal(secondClosed,false)
 finishBrowserClose();await Promise.all([first,second,rejected])
 assert.equal(profileHeld,false);assert.equal(closeCalls,1);assert.equal(engine.browser,null);assert.equal(engine.initializing,null)
 engine.startCapture();assert.equal(engine.captureTimer,null)
 await assert.rejects(engine.initialize(),/已关闭/)
})
test('concurrent initialization waits for setup even after the browser page exists',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'studio-initialize-ready-')),engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}})});let finishSetup,ready=false
 const setup=new Promise(resolve=>{finishSetup=resolve})
 engine.openBrowser=async()=>{engine.browser={async close(){}};engine.programPage={viewport:()=>({width:640,height:360})};await setup}
 t.after(async()=>{await engine.close();rmSync(dataDir,{recursive:true,force:true})})
 const first=engine.initialize(),second=engine.initialize().then(()=>{ready=true})
 await Promise.resolve();await Promise.resolve();assert.equal(ready,false)
 finishSetup();await Promise.all([first,second]);assert.equal(ready,true)
})
test('closing the engine cancels browser recovery before another browser can launch',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const dataDir=mkdtempSync(join(tmpdir(),'studio-browser-recover-')),engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}})})
 t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
 let initialized=0;engine.initialize=async()=>{initialized++}
 const recovery=engine.recoverBrowser();await engine.close();t.mock.timers.tick(10000);await recovery
 assert.equal(initialized,0);assert.equal(engine.status().browserRecovering,false)
})

test('a tab remains active until its screenshot completes before another tab can be activated',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'studio-capture-order-')),engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}})})
 t.after(async()=>{await engine.close();rmSync(dataDir,{recursive:true,force:true})})
 engine.browser={async close(){}};const calls=[];let complete
 const pending=new Promise(resolve=>{complete=resolve})
 const page=(name,wait)=>({isClosed:()=>false,async bringToFront(){calls.push('activate '+name)},async screenshot(){calls.push('capture '+name);if(wait)await pending;calls.push('complete '+name);return Buffer.from(name)}})
 const first=engine.snapshotPage(page('program',true),{}),second=engine.snapshotPage(page('slide',false),{})
 await Promise.resolve();await Promise.resolve();assert.deepEqual(calls,['activate program','capture program'])
 complete();await Promise.all([first,second]);assert.deepEqual(calls,['activate program','capture program','complete program','activate slide','capture slide','complete slide'])
})

test('a stuck screenshot has a deadline, keeps the last frame and terminates only its owned browser',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'studio-capture-timeout-')),engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}})})
 t.after(async()=>{await engine.close();rmSync(dataDir,{recursive:true,force:true})})
 t.mock.timers.enable({apis:['setTimeout']});let kills=0
 engine.browser={async close(){},process:()=>({kill(signal){assert.equal(signal,'SIGKILL');kills++}})};engine.frame=Buffer.from('last valid composite')
 const page={isClosed:()=>false,async bringToFront(){},screenshot:()=>new Promise(()=>{})}
 const pending=engine.snapshotPage(page,{}),rejection=assert.rejects(pending,/截图超过10秒/)
 await Promise.resolve();await Promise.resolve();t.mock.timers.tick(10000);await rejection
 assert.equal(kills,1);assert.equal(engine.frame.toString(),'last valid composite')
})

test('an asynchronous deck operation keeps focus until rendering finishes and serializes another controller',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'studio-deck-focus-')),engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}})})
 t.after(async()=>{await engine.close();rmSync(dataDir,{recursive:true,force:true})})
 engine.browser={async close(){}};engine.programPage={viewport:()=>({width:640,height:360})};let captures=0,complete
 engine.snapshotPage=async()=>{captures++;return Buffer.from('program')};const calls=[],pending=new Promise(resolve=>{complete=resolve})
 const first=engine.withDeck(async()=>{calls.push('render first');await pending;calls.push('finish first')})
 const second=engine.withDeck(async()=>{calls.push('render second')})
 await Promise.resolve();await Promise.resolve();await engine.capture()
 assert.equal(captures,0);assert.equal(engine.deckBusy,true);assert.deepEqual(calls,['render first'])
 complete();await Promise.all([first,second]);assert.equal(engine.deckBusy,false);assert.deepEqual(calls,['render first','finish first','render second'])
 await engine.capture();assert.equal(captures,1)
})
