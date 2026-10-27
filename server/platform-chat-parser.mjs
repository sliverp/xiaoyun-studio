/** Passive public-page chat decoders. MIT source references and omissions are recorded in docs/platform-chat-sources.md. */
import { createHash } from 'node:crypto'
import { inflateSync, brotliDecompressSync, gunzipSync } from 'node:zlib'
import protobuf from 'protobufjs'
import { parseChannelNumber } from './channels-parser.mjs'

const MAX_FRAME=2*1024*1024,MAX_EXPANDED=8*1024*1024,MAX_MESSAGES=2000
const schema=`syntax="proto3";
message DyHeader { optional string key=1; optional string value=2; }
message BiUser { optional uint64 id=1; optional string name=2; }
message BiDm { optional string id=1; optional string content=6; BiUser user=20; }
message DyFrame { repeated DyHeader headers=5; optional string encoding=6; optional string type=7; optional bytes payload=8; }
message DyResponse { repeated DyMessage messages=1; }
message DyMessage { optional string method=1; optional bytes payload=2; optional int64 id=3; }
message DyCommon { optional uint64 id=2; optional uint64 roomId=3; optional uint64 createTime=4; }
message DyUser { optional uint64 id=1; optional string nickname=3; optional string idStr=1029; }
message DyChat { DyCommon common=1; DyUser user=2; optional string content=3; }
message DyLikes { optional uint64 count=2; optional uint64 total=3; }
message DyRoom { optional int64 onlineUsers=3; optional int64 popularity=6; optional int64 totalViewers=7; }
message DyControl { optional uint32 status=2; }
message KsFrame { optional uint32 type=1; optional uint32 compression=2; optional bytes payload=3; }
message KsUser { optional string id=1; optional string nickname=2; }
message KsComment { optional string id=1; KsUser user=2; optional string content=3; }
message KsFeed { optional string watching=1; optional string likes=2; repeated KsComment comments=5; }
`
const root=protobuf.parse(schema).root
const decode=(name,bytes)=>{if(bytes.length>MAX_EXPANDED)throw new Error('弹幕解码数据过大');const type=root.lookupType(name);return type.toObject(type.decode(bytes),{longs:String,bytes:Buffer,defaults:false})}
const fresh=()=>({recognized:false,comments:[],fields:{},platformState:'unknown'})
const warning=(result,text)=>{result.warnings||=[];if(!result.warnings.includes(text))result.warnings.push(text)}
const expectedWire=(bytes,fields)=>{const reader=protobuf.Reader.create(bytes);while(reader.pos<reader.len){const tag=reader.uint32(),field=tag>>>3,wire=tag&7;if(Object.hasOwn(fields,field)&&fields[field]!==wire)throw new Error('平台消息字段格式已变化');reader.skipType(wire)}}
const identity=(value,fallback)=>value&&String(value)!=='0'?String(value).slice(0,160):createHash('sha256').update(fallback).digest('hex')
const userId=value=>typeof value==='string'&&value&&value!=='0'?value.slice(0,160):Number.isSafeInteger(value)&&value>0?String(value):undefined
const comment=(id,nickname,content,at,uid,fallback)=>{
 if(typeof nickname!=='string'||typeof content!=='string'||!nickname.trim()||!content.trim())return null
 const row={id:identity(id,fallback),nickname:nickname.trim().slice(0,100),content:content.trim().slice(0,500),at}
 const account=userId(uid);if(account)row.userId=account
 return row
}
const metric=(result,key,value,at,source,path)=>{
 const number=parseChannelNumber(value,key)
 if(number!==null)result.fields[key]={value:number,raw:String(value).slice(0,80),at,source,path,approximate:/[万亿kKwWmM]/.test(String(value))}
}
const checkedPayload=bytes=>{const data=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);if(!data.length||data.length>MAX_FRAME)throw new Error('弹幕帧为空或超过2MiB');return data}

/** Only known platform chat sockets are observed; query tokens are never returned. */
export function isPlatformChatSocket(platform,address){
 try{
  const url=new URL(address)
  if(url.protocol!=='wss:'||url.username||url.password)return false
  if(platform==='bilibili')return (url.hostname==='chat.bilibili.com'||url.hostname.endsWith('.chat.bilibili.com'))&&url.pathname==='/sub'
  if(platform==='douyin')return url.hostname.endsWith('.douyin.com')&&/^\/webcast\/im\/push\//.test(url.pathname)
  if(platform==='kuaishou')return /(?:^|\.)kuaishou\.(?:com|cn)$/.test(url.hostname)&&(url.pathname.startsWith('/websocket')||/^livejs.*-ws\./.test(url.hostname))
  return false
 }catch{return false}
}

function biliCommand(result,value,at){
 const command=String(value.cmd||'').split(':')[0],source='bilibili-websocket',data=value.data||{}
 if(command==='DANMU_MSG'){
  const info=value.info
  let row=null
  if(typeof value.dm_v2==='string'&&value.dm_v2.length){
   try{if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value.dm_v2))throw new Error('Invalid base64');const bytes=Buffer.from(value.dm_v2,'base64');expectedWire(bytes,{1:2,6:2,20:2});const dm=decode('BiDm',bytes);row=comment(dm.id,dm.user?.name,dm.content,at,dm.user?.id,bytes)}catch{warning(result,'B站收到 DANMU_MSG，但 dm_v2 弹幕格式暂不支持')}
  }
  if(!row&&Array.isArray(info))row=comment(null,info[2]?.[1],info[1],at,info[2]?.[0],JSON.stringify(value))
  if(row)result.comments.push(row)
  else warning(result,'B站收到 DANMU_MSG，但没有可读取的昵称和正文')
 }else if(command==='WATCHED_CHANGE')metric(result,'totalViewers',data.num,at,source,'WATCHED_CHANGE.data.num')
 else if(command==='LIKE_INFO_V3_UPDATE')metric(result,'likes',data.click_count,at,source,'LIKE_INFO_V3_UPDATE.data.click_count')
 else if(command==='ROOM_REAL_TIME_MESSAGE_UPDATE')metric(result,'followers',data.fans,at,source,'ROOM_REAL_TIME_MESSAGE_UPDATE.data.fans')
 else if(command==='LIVE')result.platformState='live'
 else if(command==='PREPARING')result.platformState='ended'
}
function biliPackets(bytes,result,at,depth=0,budget={expanded:0,packets:0}){
 if(depth>4)throw new Error('弹幕压缩嵌套过深')
 let offset=0
 while(offset<bytes.length){
  if(++budget.packets>4000||bytes.length-offset<16)throw new Error('B站弹幕包头无效')
  const length=bytes.readUInt32BE(offset),header=bytes.readUInt16BE(offset+4),version=bytes.readUInt16BE(offset+6),operation=bytes.readUInt32BE(offset+8)
  if(header<16||header>length||length>bytes.length-offset)throw new Error('B站弹幕包长度无效')
  const body=bytes.subarray(offset+header,offset+length);offset+=length
  if(operation===5){
   if(version===2||version===3){const remaining=MAX_EXPANDED-budget.expanded;if(remaining<=0)throw new Error('弹幕解压数据过大');const expanded=(version===2?inflateSync:brotliDecompressSync)(body,{maxOutputLength:remaining});budget.expanded+=expanded.length;biliPackets(expanded,result,at,depth+1,budget)}
   else if(version===0||version===1){const value=JSON.parse(body.toString('utf8'));result.recognized=true;biliCommand(result,value,at)}
  }else if(operation===3&&body.length===4){result.recognized=true;metric(result,'heat',body.readUInt32BE(0),at,'bilibili-websocket','heartbeat.popularity')}
  else if(operation===8){const value=JSON.parse(body.toString('utf8'));if(value.code===0)result.recognized=true}
  if(result.comments.length>MAX_MESSAGES)throw new Error('单帧弹幕过多')
 }
}

/** Decode Bilibili packet framing, compressed batches and known JSON chat/counter commands. */
export function decodeBilibiliChat(bytes,at=Date.now()){
 const result=fresh();biliPackets(checkedPayload(bytes),result,at);return result
}

/** Decode observed Douyin PushFrame/Response messages without generating signatures or acknowledgements. */
export function decodeDouyinChat(bytes,at=Date.now()){
 const result=fresh(),frame=decode('DyFrame',checkedPayload(bytes))
 if(!['msg','push'].includes(frame.type)||!frame.payload?.length)return result
 let payload=frame.payload
 const compressed=frame.headers?.some(item=>item.key==='compress_type'&&item.value==='gzip')||frame.encoding==='gzip'||payload[0]===0x1f&&payload[1]===0x8b
 if(compressed)payload=gunzipSync(payload,{maxOutputLength:MAX_EXPANDED})
 const response=decode('DyResponse',payload),messages=response.messages||[]
 if(messages.length>MAX_MESSAGES)throw new Error('单帧弹幕过多')
 result.recognized=true
 for(const message of messages){
  if(message.method==='WebcastChatMessage'){
   const chat=decode('DyChat',message.payload||Buffer.alloc(0)),row=comment(message.id||chat.common?.id,chat.user?.nickname,chat.content,at,chat.user?.idStr||chat.user?.id,message.payload||Buffer.alloc(0))
   if(row)result.comments.push(row)
  }else if(message.method==='WebcastLikeMessage'){
   try{const bytes=message.payload||Buffer.alloc(0);expectedWire(bytes,{2:0,3:0});const likes=decode('DyLikes',bytes);metric(result,'likes',likes.total,at,'douyin-websocket','WebcastLikeMessage.total')}catch{warning(result,'部分抖音点赞指标格式已变化，已跳过该指标')}
  }else if(message.method==='WebcastRoomUserSeqMessage'){
   try{const bytes=message.payload||Buffer.alloc(0);expectedWire(bytes,{3:0,6:0,7:0});const room=decode('DyRoom',bytes);metric(result,'onlineUsers',room.onlineUsers,at,'douyin-websocket','WebcastRoomUserSeqMessage.total');metric(result,'heat',room.popularity,at,'douyin-websocket','WebcastRoomUserSeqMessage.popularity');metric(result,'totalViewers',room.totalViewers,at,'douyin-websocket','WebcastRoomUserSeqMessage.totalUser')}catch{warning(result,'部分抖音房间指标格式已变化，已跳过该指标')}
  }else if(message.method==='WebcastControlMessage'){
   const control=decode('DyControl',message.payload||Buffer.alloc(0));if(control.status===3)result.platformState='ended'
  }
 }
 return result
}

/** Decode Kuaishou feed comments and visible counters; encrypted payloads fail explicitly. */
export function decodeKuaishouChat(bytes,at=Date.now()){
 const result=fresh(),frame=decode('KsFrame',checkedPayload(bytes))
 if(frame.compression===3)throw new Error('快手返回加密弹幕，当前适配器不支持解密')
 if(frame.type!==310||!frame.payload?.length)return result
 if(frame.compression!=null&&![0,1,2].includes(frame.compression))throw new Error('快手弹幕压缩格式不受支持')
 const payload=frame.compression===2?gunzipSync(frame.payload,{maxOutputLength:MAX_EXPANDED}):frame.payload,feed=decode('KsFeed',payload)
 if((feed.comments?.length||0)>MAX_MESSAGES)throw new Error('单帧弹幕过多')
 result.recognized=true
 for(const item of feed.comments||[]){const row=comment(item.id,item.user?.nickname,item.content,at,item.user?.id,JSON.stringify(item));if(row)result.comments.push(row)}
 metric(result,'onlineUsers',feed.watching,at,'kuaishou-websocket','SCWebFeedPush.displayWatchingCount');metric(result,'likes',feed.likes,at,'kuaishou-websocket','SCWebFeedPush.displayLikeCount')
 return result
}

/** Return only normalized chat/counters. Login tokens and unknown protocol fields are discarded. */
export function decodePlatformChat(platform,bytes,at=Date.now()){
 if(platform==='bilibili')return decodeBilibiliChat(bytes,at)
 if(platform==='douyin')return decodeDouyinChat(bytes,at)
 if(platform==='kuaishou')return decodeKuaishouChat(bytes,at)
 throw new Error('该平台没有 WebSocket 弹幕解码器')
}
