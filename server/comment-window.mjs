/** Keep the complete bounded window; selection and common-topic recognition belong to the model. */
export const COMMENT_WINDOW_LIMIT=100
export const COMMENT_FRESHNESS_MS=120000
const shorten=(value,max)=>Array.from(String(value||'')).slice(0,max).join('')
export function commentWindow(rows,now=Date.now()){
 return rows.slice(-COMMENT_WINDOW_LIMIT).map(row=>{
  const status=row.respondedAt?'answered':row.resolvedInSource?'incorporated':row.lotteryId?'lottery':now-row.at>COMMENT_FRESHNESS_MS?'expired':'pending'
  return {...row,canReply:status==='pending',replyStatus:status}
 })
}
export function modelComments(rows,now=Date.now()){
 return rows.slice(-COMMENT_WINDOW_LIMIT).map((row,index)=>({id:'c'+(index+1),nickname:shorten(row.nickname||'观众',32),content:String(row.content||''),canReply:row.canReply!==false,replyStatus:row.replyStatus||'pending',ageSeconds:Math.max(0,Math.round((now-(row.at||now))/1000)),...(row.platformName?{platformName:shorten(row.platformName,24)}:{})}))
}
/** Compact response IDs keep a 100-message acknowledgement from exhausting the output token budget. */
export function commentReferences(rows,sent){
 const raw=rows.slice(-COMMENT_WINDOW_LIMIT)
 return new Map(sent.map((row,index)=>[row.id,raw[index]]).filter(([id,row])=>id&&row))
}
/** Trim exceptional long messages evenly, preserving every message and its reference. */
export function fitCommentText(rows,overBudget){
 let cap=Math.max(0,...rows.map(row=>Array.from(row.content).length))
 while(overBudget()&&cap>24){
  cap=Math.max(24,Math.floor(cap*.75))
  for(const row of rows)if(Array.from(row.content).length>cap){row.content=shorten(row.content,cap);row.contentTruncated=true}
 }
}
/** A contiguous group can be returned as c1-c100 instead of generating a hundred JSON strings. */
export function expandCommentIds(ids){
 if(ids===undefined)return undefined
 const result=new Set()
 for(const id of ids){
  const match=/^c(\d+)-c(\d+)$/.exec(id)
  if(match){const first=Number(match[1]),last=Number(match[2]);if(first<1||last>COMMENT_WINDOW_LIMIT||last<first)throw new Error('弹幕回应编号范围无效');for(let i=first;i<=last;i++)result.add('c'+i)}
  else result.add(id)
 }
 if(result.size>COMMENT_WINDOW_LIMIT)throw new Error('弹幕回应编号超出窗口上限')
 return [...result]
}
