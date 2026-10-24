import {spawn} from 'node:child_process'
import {basename} from 'node:path'

export const SAMPLE_RATE=48000
export const CHANNELS=2
export const FRAME_SAMPLES=960
export const FRAME_BYTES=FRAME_SAMPLES*CHANNELS*2
const HIGH_WATER=1024*1024

/** Decode a local asset to a bounded PCM queue; pausing consumption also pauses the child pipe. */
export class PcmSource {
  constructor(ffmpeg,path,{loop=false,onError=()=>{}}={}){
    this.parts=[];this.offset=0;this.bytes=0;this.ended=false;this.error=null;this.closed=false
    const args=['-hide_banner','-loglevel','error',...(loop?['-stream_loop','-1']:[]),'-i',path,'-vn','-f','s16le','-ar',String(SAMPLE_RATE),'-ac',String(CHANNELS),'pipe:1']
    this.child=spawn(ffmpeg,args,{stdio:['ignore','pipe','pipe'],windowsHide:true})
    let detail=''
    this.child.stderr.on('data',chunk=>{detail=(detail+chunk.toString()).slice(-1200)})
    this.child.stdout.on('data',chunk=>{this.parts.push(chunk);this.bytes+=chunk.length;if(this.bytes>=HIGH_WATER)this.child.stdout.pause()})
    this.child.once('error',()=>{this.error=new Error('无法启动音频解码器');this.ended=true;onError(this.error)})
    this.child.once('close',code=>{
      this.ended=true
      if(!this.closed&&code!==0){this.error=new Error('音频无法解码：'+basename(path));onError(this.error)}
    })
  }
  read(bytes){
    const result=Buffer.alloc(bytes);let used=0
    while(used<bytes&&this.parts.length){const chunk=this.parts[0],count=Math.min(bytes-used,chunk.length-this.offset);chunk.copy(result,used,this.offset,this.offset+count);used+=count;this.offset+=count;this.bytes-=count;if(this.offset===chunk.length){this.parts.shift();this.offset=0}}
    if(this.bytes<HIGH_WATER/2&&!this.ended)this.child.stdout.resume()
    return {buffer:result,used,done:this.ended&&this.bytes===0}
  }
  close(){this.closed=true;this.parts=[];this.bytes=0;this.child.stdout.destroy();this.child.kill('SIGTERM')}
}

/** Mix continuous PCM frames, resolve speech only after consumption, and duck BGM beneath speech. */
export class AudioMixer {
  constructor({ffmpeg,onPcm=()=>{},canOutput=()=>true,onMeter=()=>{}}){
    this.ffmpeg=ffmpeg;this.onPcm=onPcm;this.canOutput=canOutput;this.onMeter=onMeter;this.queue=[];this.bgm=null;this.paused=false;this.closed=false;this.samples=0;this.tickCount=0;this.volume=.12;this.ducking=.25;this.meter={rms:0,voiceRms:0,bgmRms:0}
    this.timer=setInterval(()=>this.tick(),20)
  }
  play(path,{signal}={}){
    if(this.closed)return Promise.reject(new Error('音频引擎已关闭'))
    if(signal?.aborted)return Promise.reject(signal.reason||new DOMException('已取消','AbortError'))
    if(this.queue.length>=16)return Promise.reject(new Error('语音队列已满，请稍后重试'))
    return new Promise((resolve,reject)=>{
      const entry={source:null,resolve,reject,signal,abort:null,path}
      const failed=error=>{const index=this.queue.indexOf(entry);if(index>=0){this.queue.splice(index,1);entry.source?.close();this.release(entry);reject(error)}}
      entry.source=new PcmSource(this.ffmpeg,path,{onError:failed})
      entry.abort=()=>failed(signal.reason||new DOMException('已取消','AbortError'))
      signal?.addEventListener('abort',entry.abort,{once:true});this.queue.push(entry)
    })
  }
  release(entry){entry.signal?.removeEventListener('abort',entry.abort)}
  setBgm(path,{volume=.12,ducking=.25}={}){
    this.bgm?.close();this.bgm=null
    this.volume=Math.max(0,Math.min(1,Number(volume)||0));this.ducking=Math.max(0,Math.min(1,Number(ducking)||0))
    if(path)this.bgm=new PcmSource(this.ffmpeg,path,{loop:true,onError:()=>{this.bgm?.close();this.bgm=null}})
  }
  tick(){
    if(this.closed||!this.canOutput())return
    const current=this.queue[0]
    let voice={buffer:Buffer.alloc(FRAME_BYTES),used:0,done:false},music={buffer:Buffer.alloc(FRAME_BYTES),used:0}
    if(!this.paused){if(current)voice=current.source.read(FRAME_BYTES);if(this.bgm)music=this.bgm.read(FRAME_BYTES)}
    const mix=Buffer.alloc(FRAME_BYTES),gain=this.volume*(voice.used?this.ducking:1)
    let voicePower=0,musicPower=0,mixPower=0
    for(let offset=0;offset<FRAME_BYTES;offset+=2){const speech=voice.buffer.readInt16LE(offset),bgm=music.buffer.readInt16LE(offset)*gain,sample=Math.max(-32768,Math.min(32767,Math.round(speech+bgm)));mix.writeInt16LE(sample,offset);voicePower+=(speech/32768)**2;musicPower+=(bgm/32768)**2;mixPower+=(sample/32768)**2}
    this.samples+=FRAME_SAMPLES;this.onPcm(mix)
    if(++this.tickCount%5===0){this.meter={rms:Math.sqrt(mixPower/(FRAME_BYTES/2)),voiceRms:Math.sqrt(voicePower/(FRAME_BYTES/2)),bgmRms:Math.sqrt(musicPower/(FRAME_BYTES/2)),paused:this.paused,queued:this.queue.length,seconds:this.samples/SAMPLE_RATE};this.onMeter(this.meter)}
    if(current&&!this.paused&&voice.done){this.queue.shift();current.source.close();this.release(current);current.resolve({played:true})}
  }
  pause(){this.paused=true}
  resume(){this.paused=false}
  stop(){for(const entry of this.queue.splice(0)){entry.source.close();this.release(entry);entry.reject(new DOMException('已停止播报','AbortError'))}}
  close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);this.stop();this.bgm?.close();this.bgm=null}
}
