/** Bind each configured stream destination to its own private read-only chat browser. */
import {rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {PLATFORM_CATALOG,platformInfo} from './platform-catalog.mjs'
import {PlatformChatCollector} from './platform-chat.mjs'

const busy=value=>Boolean(value&&(!['stopped','error','idle'].includes(value.state)||value.active))
export class PlatformManager{
 constructor({store,media,director,events,dataDir,collectorFactory,prepareOutput}){Object.assign(this,{store,media,director,events,dataDir,collectorFactory,prepareOutput});this.collectors=new Map();this.operations=new Map();this.configurationChanges=new Set();this.outputGeneration=0;this.streamGenerations=new Map();this.closed=false}
 withConnection(id,operation){
  const previous=this.operations.get(id)||Promise.resolve(),task=previous.catch(()=>{}).then(()=>{if(this.closed)throw new Error('平台管理器已关闭');return operation()});this.operations.set(id,task)
  return task.finally(()=>{if(this.operations.get(id)===task)this.operations.delete(id)})
 }
 connect(id,options){return this.withConnection(id,()=>this._connect(id,options))}
 disconnect(id){return this.withConnection(id,()=>this._disconnect(id))}
 click(id,point){return this.withConnection(id,()=>this._click(id,point))}
 async changeConfiguration(id,operation){this.configurationChanges.add(id);try{return await operation()}finally{this.configurationChanges.delete(id)}}
 update(id,value){return this.withConnection(id,()=>this.changeConfiguration(id,()=>this._update(id,value)))}
 remove(id){return this.withConnection(id,()=>this.changeConfiguration(id,()=>this._remove(id)))}
 outputIntent(id){const generation=this.outputGeneration,streamGeneration=this.streamGenerations.get(id)||0;return()=>{if(this.closed||generation!==this.outputGeneration||streamGeneration!==(this.streamGenerations.get(id)||0))throw Object.assign(new Error('推流启动已取消'),{status:409})}}
 cancelOutputStarts(){this.outputGeneration++}
 start(id){const assertWanted=this.outputIntent(id);return this.withConnection(id,()=>{assertWanted();return this._start(id,assertWanted)})}
 stop(id){this.streamGenerations.set(id,(this.streamGenerations.get(id)||0)+1);return this._stop(id)}
 retry(id){const assertWanted=this.outputIntent(id);return this.withConnection(id,()=>{assertWanted();return this._retry(id,assertWanted)})}
 connection(id){const c=this.store.get().platforms.find(item=>item.id===id);if(!c)throw Object.assign(new Error('平台连接不存在'),{status:404});return c}
 stream(id){return this.media.status().output?.platforms?.find(item=>item.id===id)||{id,active:false,state:'stopped',error:'',reconnects:0}}
 status(){return {catalog:PLATFORM_CATALOG,limit:8,connections:this.store.get().platforms.map(c=>({...c,streamKeySaved:Boolean(this.store.platformSecret(c.id)),chat:this.collectors.get(c.id)?.status()||{connectionId:c.id,platform:c.platform,state:'disconnected',label:platformInfo(c.platform).chatSupported?'未连接弹幕':'仅推流 · 可通过接入口接入弹幕',browserOpen:false,loginRequired:false,messageResponses:0,commentCount:0},stream:this.stream(c.id)}))}}
 publish(){this.events.publish('platforms',this.status())}
 collector(id){
  const connection=this.connection(id);if(!platformInfo(connection.platform).chatSupported)throw new Error('此类型不内置弹幕采集，请使用弹幕接入口')
  if(this.closed)throw new Error('平台管理器已关闭')
  if(!this.collectors.has(id)){
   const options={connection,dataDir:this.dataDir,onComments:items=>{if(this.closed||!this.store.get().platforms.some(item=>item.id===id))return;const c=this.connection(id);this.director.addComments(items.map(item=>{const raw=String(item.id||createHash('sha256').update(JSON.stringify([item.at,item.nickname,item.content])).digest('hex'));return {...item,id:raw,connectionId:id,platform:c.platform,platformName:platformInfo(c.platform).name,connectionName:c.name,roomUrl:c.roomUrl}}));this.publish()},onMetrics:value=>{if(this.closed||!this.store.get().platforms.some(item=>item.id===id))return;const c=this.connection(id);this.director.ingestMetrics({...value,connectionId:id,platform:c.platform,platformName:platformInfo(c.platform).name,connectionName:c.name});this.publish()},onStatus:()=>{if(!this.closed)this.publish()}}
   this.collectors.set(id,this.collectorFactory?.(options)||new PlatformChatCollector(options))
  }
  return this.collectors.get(id)
 }
 async _connect(id,{login=false}={}){const c=this.collector(id);try{return await(login?c.login():c.connect())}finally{this.publish()}}
 async _disconnect(id){this.connection(id);await this.collectors.get(id)?.disconnect();this.publish()}
 frame(id){this.connection(id);return this.collectors.get(id)?.getFrame()||null}
 async _click(id,point){return this.collector(id).click(point)}
 create(value){const c=this.store.savePlatform(value);this.publish();return c}
 async _update(id,value){
  const current=this.connection(id);this.store.preparePlatform(value,id)
  if(busy(this.stream(id))&&Object.keys(value).some(key=>!['name','roomUrl'].includes(key)))throw Object.assign(new Error('请先停止此平台推流，再修改推流配置'),{status:409})
  if(value.roomUrl!==undefined&&value.roomUrl!==current.roomUrl){await this.collectors.get(id)?.close();this.collectors.delete(id)}
  const result=this.store.savePlatform(value,id);this.publish();return result
 }
 async _remove(id){this.connection(id);if(busy(this.stream(id)))throw Object.assign(new Error('请先停止此平台推流，再移除连接'),{status:409});if(this.media.status().output?.platforms?.some(item=>item.id===id))await this.media.stopDestination(id);await this.collectors.get(id)?.close();this.collectors.delete(id);this.store.removePlatform(id);this.director.removePlatformMetrics?.(id);await rm(join(this.dataDir,'platforms',id),{recursive:true,force:true});this.publish()}
 destinations(ids){return(ids?ids.map(id=>this.connection(id)):this.store.get().platforms.filter(c=>c.enabled)).map(c=>{if(this.configurationChanges.has(c.id))throw Object.assign(new Error('平台连接正在修改，请完成后再开始推流'),{status:409});if(!c.rtmpUrl)throw new Error('请先填写「'+c.name+'」的推流地址，或取消参与同时推流');return {id:c.id,platform:c.platform,name:c.name,rtmpUrl:c.rtmpUrl,streamKey:this.store.platformSecret(c.id)}})}
 async _start(id,assertWanted=()=>{}){assertWanted();const destination=this.destinations([id])[0],output=this.media.status().output;if(output?.running||output?.encodingActive||output?.active)await this.media.addDestination(destination);else{const c=this.store.get();await this.media.startOutput({...c.output,videoBitrate:c.output.videoBitrate+'k',audioBitrate:c.output.audioBitrate+'k',destinations:[destination]},{prepare:this.prepareOutput})}this.publish()}
 async _stop(id){this.connection(id);if(this.media.status().output?.platforms?.some(item=>item.id===id))await this.media.stopDestination(id);this.publish()}
 async _retry(id,assertWanted){this.connection(id);if(this.stream(id).active)return;if(this.media.status().output?.platforms?.some(item=>item.id===id))await this.media.stopDestination(id);assertWanted();await this._start(id,assertWanted);this.publish()}
 async close(){if(this.closed)return;this.closed=true;this.cancelOutputStarts();await Promise.allSettled([...this.collectors.values()].map(c=>c.close()));await Promise.allSettled([...this.operations.values()]);this.collectors.clear()}
}
