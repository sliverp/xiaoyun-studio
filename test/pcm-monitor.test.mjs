import test from 'node:test'
import assert from 'node:assert/strict'
import {PcmMonitorPlayer} from '../public/pcm-monitor.mjs'

function fixture(){
  const sources=[],context={state:'running',currentTime:0,destination:{}}
  context.createBuffer=(channels,length,rate)=>{const data=Array.from({length:channels},()=>new Float32Array(length));return {duration:length/rate,getChannelData:channel=>data[channel]}}
  context.createBufferSource=()=>{const source={connect(){},disconnect(){this.disconnected=true},start(at){this.at=at},stop(){this.stopped=true}};sources.push(source);return source}
  return {context,sources,player:new PcmMonitorPlayer(context)}
}
function pcm(left=10000,right=-10000,frames=960){const buffer=new ArrayBuffer(frames*4),view=new DataView(buffer);for(let index=0;index<frames;index++){view.setInt16(index*4,left,true);view.setInt16(index*4+2,right,true)}return buffer}

test('monitor batches packets and keeps a sample-continuous timeline through arrival jitter',()=>{
  const {player,context,sources}=fixture()
  for(let index=0;index<20;index++){context.currentTime=index*.02+(index%4>=2?.015:0);player.push(pcm())}
  assert.equal(sources.length,5)
  assert.equal(player.underruns,0)
  for(let index=1;index<sources.length;index++)assert.equal(sources[index].at,sources[index-1].at+sources[index-1].buffer.duration)
  assert.equal(sources[0].buffer.getChannelData(0)[0],0,'a fresh buffer fades in')
  assert.equal(sources[0].buffer.getChannelData(0)[200],10000/32768)
  assert.equal(sources[0].buffer.getChannelData(1)[200],-10000/32768)
})

test('late playback rebuffers once rather than inserting a gap into every subsequent packet',()=>{
  const {player,context,sources}=fixture()
  for(let index=0;index<4;index++)player.push(pcm())
  context.currentTime=.5
  for(let index=0;index<4;index++)player.push(pcm())
  assert.equal(player.underruns,1);assert.equal(sources[0].stopped,true);assert.ok(Math.abs(sources[1].at-.68)<1e-9)
  context.currentTime=.58
  for(let index=0;index<4;index++)player.push(pcm())
  assert.equal(player.underruns,1);assert.equal(sources[2].at,sources[1].at+.08)
})

test('muting and changing projects clear pending samples and scheduled audio',()=>{
  const {player,context,sources}=fixture()
  for(let index=0;index<5;index++)player.push(pcm())
  player.clear();assert.equal(player.bytes,0);assert.equal(player.nodes.size,0);assert.equal(sources[0].stopped,true)
  player.push(pcm());context.state='suspended';player.push(pcm())
  assert.equal(player.bytes,0);assert.equal(player.nextTime,null)
})

test('oversized and misaligned packets cannot queue stale or invalid audio',()=>{
  const {player,sources}=fixture()
  player.push(new ArrayBuffer(3));assert.equal(player.bytes,0)
  player.push(pcm(1,1,48000));assert.equal(player.bytes,0);assert.equal(player.overruns,1);assert.equal(sources.length,0)
})
