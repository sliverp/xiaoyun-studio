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
test('the encoder maps real video and stereo audio and records both outputs without ignoring stream failures',()=>{
 const args=buildOutputArgs({width:1280,height:720,fps:15,videoBitrate:'2500k',audioBitrate:'128k',destination:'rtmp://example.test/live/key',recordPath:'/tmp/output.mp4'})
 assert.ok(args.includes('pipe:0'));assert.ok(args.includes('pipe:3'));assert.ok(args.includes('libx264'));assert.ok(args.includes('aac'))
 assert.match(args.at(-1),/\[f=flv\]rtmp:.*\|\[f=mp4/);assert.doesNotMatch(args.at(-1),/onfail=ignore/)
})
test('tee output keeps quotes and backslashes inside destination and recording filenames',()=>{
 const args=buildOutputArgs({width:640,height:360,fps:10,videoBitrate:'800k',audioBitrate:'96k',destination:"rtmp://example.test/live/quote'and\\slash",recordPath:"/tmp/record'with|separator.mp4"})
 assert.equal(args.at(-1),"[f=flv]rtmp://example.test/live/quote\\'and\\\\slash|[f=mp4:movflags=+frag_keyframe+empty_moov]/tmp/record\\'with\\|separator.mp4")
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

test('manual stop cancels queued reconnects and cannot revive an old output generation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const dataDir=mkdtempSync(join(tmpdir(),'studio-media-retry-')),engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}})})
 t.after(async()=>{await engine.close();rmSync(dataDir,{recursive:true,force:true})})
 let starts=0;engine.startEncoder=async()=>{starts++};engine.outputWanted=true;engine.outputGeneration=1
 assert.equal(engine.queueReconnect({generation:1,destination:'rtmp://example.test/live',recordPath:null}),true)
 assert.equal(engine.status().output.active,false);assert.equal(engine.status().output.state,'reconnecting')
 await engine.stopOutput();t.mock.timers.tick(10000)
 assert.equal(starts,0);assert.equal(engine.queueReconnect({generation:1,destination:'rtmp://example.test/live'}),false)
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
test('closing the engine cancels browser recovery before another browser can launch',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const dataDir=mkdtempSync(join(tmpdir(),'studio-browser-recover-')),engine=new MediaEngine({dataDir,baseUrl:'http://localhost:18359',renderToken:'private-render',getSettings:()=>({output:{fps:15}})})
 t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
 let initialized=0;engine.initialize=async()=>{initialized++}
 const recovery=engine.recoverBrowser();await engine.close();t.mock.timers.tick(10000);await recovery
 assert.equal(initialized,0);assert.equal(engine.status().browserRecovering,false)
})
