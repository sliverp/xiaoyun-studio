/** Verify one encoder feeds two real RTMP receivers, survives one outage, and keeps recording. */
import {createServer} from 'node:http'
import {createServer as createTcpServer,connect} from 'node:net'
import {spawn,spawnSync} from 'node:child_process'
import {mkdtempSync,statSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import assert from 'node:assert/strict'
import {MediaEngine,detectTools} from '../server/media.mjs'

const directory=mkdtempSync(join(tmpdir(),'studio-multistream-real-')),tools=detectTools(),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
if(!tools.ready)throw new Error('Install Chromium and FFmpeg before the multi-platform media smoke')
const receiverProcesses=[]
async function receiverPorts(){
 const reservations=[]
 for(let i=0;i<3;i++){const server=createTcpServer();server.listen(0,'127.0.0.1');await once(server,'listening');reservations.push(server)}
 const ports=reservations.map(server=>server.address().port)
 await Promise.all(reservations.map(server=>new Promise(resolve=>server.close(resolve))))
 return ports
}
function receiver(port,name){
 const file=join(directory,name+'.flv'),child=spawn(tools.ffmpeg.path,['-hide_banner','-loglevel','warning','-listen','1','-i',`rtmp://127.0.0.1:${port}/live/test`,'-c','copy','-f','flv',file],{stdio:['ignore','ignore','pipe']})
 let error='';child.stderr.on('data',bytes=>{error=(error+bytes.toString()).slice(-2000)});const closed=once(child,'close');receiverProcesses.push(child)
 return {child,file,closed,error:()=>error}
}
const [firstPort,restoredPort,secondPort]=await receiverPorts()
let backendPort=firstPort
const sockets=new Set(),proxy=createTcpServer(socket=>{
 if(!backendPort){socket.destroy();return}
 const upstream=connect(backendPort,'127.0.0.1');sockets.add(socket);sockets.add(upstream)
 socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy())
 socket.on('close',()=>{sockets.delete(socket);upstream.destroy()});upstream.on('close',()=>{sockets.delete(upstream);socket.destroy()})
 socket.pipe(upstream).pipe(socket)
})
proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const ingressPort=proxy.address().port
const firstReceiver=receiver(firstPort,'platform-one-before-outage'),secondReceiver=receiver(secondPort,'platform-two')
const http=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><body style="margin:0;background:#eef5ff;color:#1658a7;font-family:sans-serif"><h1 style="padding:35px">小云 Studio · 多平台输出验证</h1><p style="padding:20px;font-size:28px">一份编码，独立发送与重连，持续本地录制。</p></body></html>')})
http.listen(0,'127.0.0.1');await once(http,'listening')
const senderChildren=new Set();let engine
engine=new MediaEngine({dataDir:directory,baseUrl:'http://127.0.0.1:'+http.address().port,renderToken:'multistream-local-smoke',getSettings:()=>({output:{width:640,height:360,fps:10}}),onStatus:()=>{for(const sink of engine?.outputGraph.allSinks()||[])if(sink.process)senderChildren.add(sink.process.child)}})
let closed=false
async function cleanup(){if(closed)return;closed=true;await engine.close();for(const child of receiverProcesses)child.kill('SIGTERM');for(const socket of sockets)socket.destroy();proxy.close();http.close()}
process.once('SIGTERM',()=>{void cleanup().finally(()=>process.exit(143))})
async function waitFor(predicate,message,timeout=30000){const until=Date.now()+timeout;while(Date.now()<until){const value=engine.status().output;if(predicate(value))return value;await delay(100)}throw new Error(message+'; '+JSON.stringify(engine.status().output))}
const destination=(id,port)=>({id,platform:'custom',name:id,rtmpUrl:'rtmp://127.0.0.1:'+port+'/live',streamKey:'test'})
try{
 console.error('multistream-smoke: initial platform and independent local recording')
 await engine.startOutput({destinations:[destination('one',ingressPort)],record:true,width:640,height:360,fps:10,videoBitrate:'800k',audioBitrate:'96k'})
 const encoder=engine.output.child,encoderPid=encoder.pid
 const wave=join(directory,'voice.wav'),generated=spawnSync(tools.ffmpeg.path,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=660:duration=20','-ar','48000','-ac','2',wave]);assert.equal(generated.status,0)
 engine.playAudio(wave).catch(error=>{if(error.name!=='AbortError')console.error('multistream-smoke audio:',error.message)})
 await waitFor(output=>output.platforms.find(item=>item.id==='one')?.active&&output.recording,'first actual RTMP sender did not start')
 console.error('multistream-smoke: add a second platform to the existing encoded transport')
 await engine.addDestination(destination('two',secondPort))
 const before=await waitFor(output=>output.platforms.every(item=>item.active),'second actual RTMP sender did not start')
 assert.equal(engine.output.child.pid,encoderPid)
 const secondPid=engine.outputGraph.sinks.get('two').process.child.pid,secondFrames=before.platforms.find(item=>item.id==='two').encodedFrames,recordedFrames=before.recordingStatus.encodedFrames
 console.error('multistream-smoke: disconnect only the first RTMP receiver')
 backendPort=0;firstReceiver.child.kill('SIGTERM');for(const socket of sockets)socket.destroy();await firstReceiver.closed
 await waitFor(output=>!output.platforms.find(item=>item.id==='one').active,'failed platform still appeared active')
 await delay(1200)
 const during=engine.status().output
 assert.equal(during.platforms.find(item=>item.id==='two').active,true);assert.equal(during.recording,true)
 assert.ok(during.platforms.find(item=>item.id==='two').encodedFrames>secondFrames);assert.ok(during.recordingStatus.encodedFrames>recordedFrames)
 assert.equal(engine.output.child.pid,encoderPid);assert.equal(engine.outputGraph.sinks.get('two').process.child.pid,secondPid)
 console.error('multistream-smoke: reconnect first platform without restarting the healthy sender')
 const restoredReceiver=receiver(restoredPort,'platform-one-after-outage');await delay(250);backendPort=restoredPort
 const restored=await waitFor(output=>output.platforms.find(item=>item.id==='one').active,'failed platform did not independently reconnect')
 assert.ok(restored.platforms.find(item=>item.id==='one').reconnects>0);assert.equal(engine.output.child.pid,encoderPid)
 assert.equal(engine.outputGraph.sinks.get('two').process.child.pid,secondPid)
 console.error('multistream-smoke: manually stop one platform while the other and recording continue')
 await engine.stopDestination('one');const stopped=engine.status().output
 assert.equal(stopped.platforms.find(item=>item.id==='one').state,'stopped');assert.equal(stopped.platforms.find(item=>item.id==='two').active,true);assert.equal(stopped.recording,true)
 await delay(700);await engine.stopOutput();await Promise.race([Promise.all([restoredReceiver.closed,secondReceiver.closed]),delay(5000)])
 const file=join(directory,'recordings',engine.status().output.recordingFile),decoded=spawnSync(tools.ffmpeg.path,['-hide_banner','-loglevel','error','-i',file,'-vn','-f','s16le','-ar','16000','-ac','1','pipe:1'],{maxBuffer:32*1024*1024})
 assert.equal(decoded.status,0);let power=0;for(let at=0;at+1<decoded.stdout.length;at+=2)power+=(decoded.stdout.readInt16LE(at)/32768)**2
 const rms=Math.sqrt(power/(decoded.stdout.length/2));assert.ok(rms>.01)
 for(const item of [firstReceiver,restoredReceiver,secondReceiver])assert.ok(statSync(item.file).size>2000,item.error())
 const result={passed:true,artifactDirectory:directory,sharedEncoderAcrossDestinations:true,liveDestinationAddition:true,healthySenderSurvivedPeerOutage:true,independentPeerRecovery:true,perDestinationStop:true,continuousRecording:true,encoderWasNotRestarted:true,firstReceiverBytes:statSync(firstReceiver.file).size,recoveredReceiverBytes:statSync(restoredReceiver.file).size,secondReceiverBytes:statSync(secondReceiver.file).size,recordingBytes:statSync(file).size,decodedRecordingRms:rms,reconnects:restored.platforms.find(item=>item.id==='one').reconnects,externalStreamingDestinationUsed:false}
 await cleanup();assert.ok(encoder.exitCode!==null||encoder.signalCode!==null);for(const child of senderChildren)assert.ok(child.exitCode!==null||child.signalCode!==null,'owned packet-copy sender did not exit');result.ownedSendersExited=true;writeFileSync(join(directory,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2))
}finally{await cleanup()}
