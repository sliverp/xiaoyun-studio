/** Numeric/comment extraction adapted from MIT biliye/dsh-voice-call and sliverp/xiaoyun-live; see THIRD_PARTY_NOTICES.md. */
export const CHANNEL_METRICS = [
  { key:'onlineUsers',api:['onlineCnt','onlineCount'],labels:['在线人数','当前在线人数','当前在线','实时在线人数','实时在线'] },
  { key:'peakOnlineUsers',api:['maxOnlineCnt','peakOnlineCnt','maxOnlineCount'],labels:['最高在线人数','最高在线','峰值在线人数'] },
  { key:'heat',api:['heat','heatValue','hotValue','hotCnt'],labels:['直播热度','热度','人气值'] },
  { key:'totalViewers',api:['totalViewerCnt','totalAudienceCnt','totalWatchUserCnt'],labels:['累计观看人数','累计观众','观看人数','观看总人数'] },
  { key:'views',api:['watchCnt','viewCnt','totalViewCnt'],labels:['观看次数','观看人次','累计观看人次'] },
  { key:'likes',api:['likeCnt','likeCount'],labels:['点赞总数','点赞次数','点赞数','点赞'] },
  { key:'shares',api:['shareCnt','shareCount'],labels:['分享次数','分享数','转发次数'] },
  { key:'newFollowers',api:['newFollowCnt','newFansCnt'],labels:['新增关注人数','新增关注','新增粉丝','新增关注者'] },
  { key:'giftCoins',api:['rewardTotalAmountInWecoin'],labels:['礼物收入（微信币）','礼物收入(微信币)','微信币收入'] },
  { key:'durationSeconds',api:['durationSeconds','liveDurationSeconds'],labels:['直播时长','开播时长'] },
  { key:'startedAtMs',api:['startTime'],labels:[] },
  { key:'endedAtMs',api:['endTime'],labels:[] },
]

/** Restrict observation to official live-backend responses, including deployed path prefixes. */
export function isChannelsLiveResponse(address){
  try{const url=new URL(address);return url.protocol==='https:'&&url.hostname==='channels.weixin.qq.com'&&url.pathname.includes('/mmfinderassistant-bin/live/')}catch{return false}
}
export function isChannelsMessageResponse(address){
  try{return isChannelsLiveResponse(address)&&/\/live\/msg(?:\/|$)/.test(new URL(address).pathname)}catch{return false}
}

/** Keep unavailable counts missing; visible rounded values retain their approximation metadata. */
export function parseChannelNumber(input,key){
  if(typeof input!=='number'&&typeof input!=='string')return null
  const raw=String(input).trim()
  if(!raw||/^(?:--?|—|暂无|未开播|加载中|null|undefined)$/i.test(raw))return null
  if(key==='durationSeconds'){
    const clock=raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/)
    if(clock)return Number(clock[3])<60&&(!clock[1]||Number(clock[2])<60)?Number(clock[1]||0)*3600+Number(clock[2])*60+Number(clock[3]):null
    const duration=raw.match(/^(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分(?:钟)?)?\s*(?:(\d+)\s*秒)?$/)
    if(duration&&duration.slice(1).some(Boolean))return Number(duration[1]||0)*3600+Number(duration[2]||0)*60+Number(duration[3]||0)
  }
  const match=raw.replaceAll(',','').match(/^([0-9]+(?:\.[0-9]+)?)\s*(万|亿|[kKwWmM])?\s*(?:人|次|个|秒|微信币)?$/)
  if(!match)return null
  let value=Number(match[1])*({万:10000,亿:100000000,k:1000,K:1000,w:10000,W:10000,m:1000000,M:1000000}[match[2]]||1)
  if((key==='startedAtMs'||key==='endedAtMs')&&value>0&&value<1e12)value*=1000
  return Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER?value:null
}

/** Select only comment id, display name and text; login/account payloads are never emitted. */
export function extractChannelsComments(request,response,at=Date.now()){
  const data=response?.data
  if(!data||typeof data!=='object')return null
  return {liveId:String(data.liveInfo?.liveId||request?.liveId||request?.live_id||'').slice(0,120),platformState:String(data.liveInfo?.liveStatus||data.liveInfo?.status||'')==='1'?'live':String(data.liveInfo?.liveStatus||data.liveInfo?.status||'')==='2'?'ended':'unknown',comments:(Array.isArray(data.msgList)?data.msgList:[]).filter(item=>item?.type===1).slice(-2000).flatMap(item=>{
    const id=String(item.clientMsgId||'').slice(0,160),nickname=String(item.nickname||'').trim().slice(0,100),content=String(item.content||'').trim().slice(0,500)
    return id&&nickname&&content?[{id,nickname,content,at}]:[]
  })}
}

/** Parse known live counters only; neither unknown account numbers nor raw responses escape. */
export function extractChannelsMetrics(response,at=Date.now()){
  const data=response?.data
  if(!data||typeof data!=='object')return null
  const fields={}
  for(const [prefix,object]of [['data',data],['data.liveInfo',data.liveInfo],['data.statistics',data.statistics],['data.liveStats',data.liveStats],['data.liveStatistics',data.liveStatistics]]){
    if(!object||typeof object!=='object'||Array.isArray(object))continue
    for(const metric of CHANNEL_METRICS)for(const name of metric.api){
      const value=parseChannelNumber(object[name],metric.key)
      if(value===null)continue
      fields[metric.key]={value,raw:String(object[name]).slice(0,80),at,source:'api',path:prefix+'.'+name,approximate:false};break
    }
  }
  const state=String(data.liveInfo?.liveStatus??data.liveInfo?.status??data.liveStatus??'')
  return {at,fields,liveId:String(data.liveInfo?.liveId||data.liveId||'').slice(0,120),platformState:state==='1'?'live':state==='2'?'ended':'unknown',stateSource:'api'}
}

/** Match explicit metric tiles and preserve rounded values as estimates. */
export function extractChannelsDomMetrics(rows,at=Date.now()){
  const fields={}
  for(const metric of CHANNEL_METRICS){
    const tile=rows.find(item=>item&&typeof item==='object'&&metric.labels.includes(item.label))
    if(!tile)continue
    const value=parseChannelNumber(tile.value,metric.key)
    if(value!==null)fields[metric.key]={value,raw:String(tile.value).slice(0,80),at,source:'dom',path:String(tile.label),approximate:/[万亿kKwWmM]/.test(String(tile.value))}
  }
  return {at,fields,liveId:'',platformState:rows.some(item=>typeof item==='string'&&/^(直播已结束|本场直播已结束|直播结束)$/.test(item))?'ended':'unknown',stateSource:'dom'}
}

/** Evaluate inside the signed-in backend; exclude comments and unrelated numerical text. */
export function readChannelsMetricTiles(labels){
  const result=[],known=new Set(labels)
  const visible=element=>{const style=getComputedStyle(element);return style.display!=='none'&&style.visibility!=='hidden'&&element.getClientRects().length>0}
  for(const element of document.querySelectorAll('span,div,p,dt,dd,th,td,strong,label,h1,h2,h3,h4,h5')){
    if(element.children.length||!visible(element)||element.closest('[class*="comment"],[class*="chat"],[class*="message"],[role="log"],input,textarea'))continue
    const text=element.textContent.trim(),inline=labels.find(label=>text.startsWith(label+'：')||text.startsWith(label+':'))
    if(inline){result.push({label:inline,value:text.slice(inline.length).replace(/^[:：]\s*/,'')});continue}
    if(/^(直播已结束|本场直播已结束|直播结束)$/.test(text)){result.push(text);continue}
    if(!known.has(text))continue
    let parent=element.parentElement
    for(let level=0;parent&&level<4;level++,parent=parent.parentElement){
      const walker=document.createTreeWalker(parent,NodeFilter.SHOW_TEXT),lines=[]
      while(walker.nextNode()){const node=walker.currentNode,value=node.textContent.trim();if(value&&node.parentElement&&visible(node.parentElement))lines.push(value)}
      const labelCount=lines.filter(line=>known.has(line)).length
      if(labelCount>1)break
      const values=lines.filter(line=>!known.has(line)&&/^[0-9]/.test(line)&&line.length<80)
      if(labelCount===1&&values.length===1){result.push({label:text,value:values[0]});break}
    }
  }
  return result
}
