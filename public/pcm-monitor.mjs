/** Batch interleaved PCM and schedule an unbroken Web Audio timeline behind a small jitter buffer. */
const RATE=48000,CHANNELS=2,BYTES_PER_FRAME=4
const BATCH_FRAMES=3840 // 80 ms, rather than one AudioBufferSource for every 20 ms network packet.
const BATCH_BYTES=BATCH_FRAMES*BYTES_PER_FRAME
const TARGET_LATENCY=.18,MAX_LATENCY=.6

export class PcmMonitorPlayer {
  constructor(context){
    this.context=context;this.nodes=new Set();this.parts=[];this.offset=0;this.bytes=0;this.nextTime=null
    this.underruns=0;this.overruns=0
  }
  clearScheduled(){
    for(const source of this.nodes){source.onended=null;try{source.stop()}catch{/* Already finished. */}source.disconnect()}
    this.nodes.clear();this.nextTime=null
  }
  clear(){this.clearScheduled();this.parts=[];this.offset=0;this.bytes=0}
  push(data){
    if(!(data instanceof ArrayBuffer)||!data.byteLength||data.byteLength%BYTES_PER_FRAME)return
    if(this.context.state!=='running'){this.clear();return}
    // Never retain seconds of stale audio after a stalled connection or controller.
    if(data.byteLength+this.bytes>RATE*BYTES_PER_FRAME*MAX_LATENCY){this.overruns++;this.clear();return}
    this.parts.push(new Uint8Array(data));this.bytes+=data.byteLength
    while(this.bytes>=BATCH_BYTES){
      const bytes=new Uint8Array(BATCH_BYTES);let used=0
      while(used<BATCH_BYTES){const part=this.parts[0],count=Math.min(BATCH_BYTES-used,part.length-this.offset);bytes.set(part.subarray(this.offset,this.offset+count),used);used+=count;this.offset+=count;this.bytes-=count;if(this.offset===part.length){this.parts.shift();this.offset=0}}
      this.schedule(bytes)
    }
  }
  schedule(bytes){
    const context=this.context,now=context.currentTime
    if(this.nextTime!==null&&this.nextTime<now+.01){this.underruns++;this.clearScheduled()}
    if(this.nextTime!==null&&this.nextTime>now+MAX_LATENCY){this.overruns++;this.clearScheduled()}
    const fresh=this.nextTime===null
    if(fresh)this.nextTime=now+TARGET_LATENCY
    const buffer=context.createBuffer(CHANNELS,BATCH_FRAMES,RATE),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
    for(let channel=0;channel<CHANNELS;channel++){
      const samples=buffer.getChannelData(channel)
      for(let index=0;index<BATCH_FRAMES;index++)samples[index]=view.getInt16((index*CHANNELS+channel)*2,true)/32768*(fresh?Math.min(1,index/128):1)
    }
    const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);this.nodes.add(source)
    source.onended=()=>{this.nodes.delete(source);source.disconnect()}
    source.start(this.nextTime);this.nextTime+=BATCH_FRAMES/RATE
  }
}
