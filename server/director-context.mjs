/** Per-stage allowlists. History and archived comments are never a work queue. */
export const STAGE_CONTEXTS={
 source:{model:true,fields:['page','aired','planned','followThroughRequests','activePreferences','onAir','lastSource','oneHopTransition'],excluded:['answeredQuestions','greetings','commentCandidates','metrics','sale','lottery']},
 comment:{model:true,fields:['currentCandidates','page','lastSource','lastInteraction','onAir','relevantMetrics','relevantActivity'],excluded:['otherComments','archivedReplies','futurePagePlans']},
 engagement:{model:true,fields:['lastSource','lastInteraction','activePreferences','currentPageSummary','onAir'],excluded:['commentCandidates','answeredQuestions','sale','lottery','metrics','futurePagePlans']},
 question:{model:true,fields:['hostQuestion','page','lastSource','onAir','activePreferences','relevantMetrics','relevantActivity'],excluded:['unrelatedAudienceQuestions','archivedReplies','futurePagePlans']},
 opening:{model:false,fields:['identity.welcome']},sale:{model:false,fields:['sale.announcement','sale.durationSeconds','sale.qrUrl']},closing:{model:false,fields:['identity.goodbye']},cue:{model:false,fields:['selectedCue.text','selectedCue.audioUrl']},lottery:{model:false,fields:['currentDraw']},
};
const MODEL_FIELDS={
 source:['stage','page','pageProgress','aired','planned','plannedPredecessor','conversation','onAir','interactionAllowed','pageEnd','loopEnabled','note'],
 comment:['stage','page','aired','conversation','onAir','candidates','metrics','sale','lottery'],
 engagement:['stage','page','aired','conversation','onAir'],
 question:['stage','page','aired','conversation','onAir','question','metrics','sale','lottery'],
};
const trimTurn=turn=>turn?{id:turn.id,kind:turn.kind,text:String(turn.text||'').slice(-420),pageNumber:turn.pageNumber}:null;
export function projectStageContext(kind,input){
 if(!STAGE_CONTEXTS[kind]?.model)throw new Error('该环节使用固定编排，不接受大模型上下文：'+kind);
 const p=structuredClone(input),c=p.conversation,planned=new Set(c.plannedRequestIds||[]),candidateIds=new Set((p.candidates||[]).filter(row=>row.canReply!==false).map(row=>row.id));
 c.recentTurns=c.recentTurns.filter(t=>t.kind==='source').slice(-3).map(trimTurn);
 c.lastSource=trimTurn(c.lastSource);c.lastInteraction=c.lastInteraction&&Date.now()-c.lastInteraction.at<180000?trimTurn(c.lastInteraction):null;
 c.activePreferences=c.activePreferences.map(row=>({id:row.id,content:row.preferenceText||row.content,status:row.status}));
 c.recentlyApplied=[];
 if(kind==='source'){
  c.audienceRequests=c.audienceRequests.filter(row=>row.followThrough&&!planned.has(row.id));
  c.currentTransition=c.previousStage==='source'?null:c.currentTransition;
  if(c.currentTransition?.kind==='comment'||c.currentTransition?.kind==='question'){
   const requests=c.audienceRequests.filter(row=>c.currentTransition.audienceIds?.includes(row.id));
   c.currentTransition=requests.length?{kind:c.currentTransition.kind,audienceIds:requests.map(row=>row.id),requirements:requests.map(row=>row.content)}:null;
  }
  if(p.onAir?.current?.kind!=='source'){if(p.onAir?.current)delete p.onAir.current.text;delete p.currentlyPlaying;}
  if(c.previousStage!=='source')delete p.plannedPredecessor;
  if(!c.audienceRequests.some(row=>row.replyTo))c.lastInteraction=null;
  delete p.candidates;delete p.question;
 }else{
  delete p.planned;delete p.plannedPredecessor;
  p.page.text=p.page.text.slice(0,kind==='engagement'?600:3000);p.page.notes=p.page.notes.slice(0,kind==='engagement'?0:4000);
  c.currentTransition=null;c.plannedRequestIds=[];
  if(kind==='comment')c.audienceRequests=c.audienceRequests.filter(row=>candidateIds.has(row.id));
  else {c.audienceRequests=[];delete p.candidates;}
  if(kind==='comment')c.activePreferences=[];
  if(kind==='question')c.lastInteraction=null;
  if(kind==='engagement')delete p.question;
 }
 const query=kind==='comment'?(p.candidates||[]).filter(row=>row.canReply!==false).map(row=>row.content).join('\n'):kind==='question'?p.question||'':'';
 if(!/在线|人数|热度|点赞|观众数|人气/.test(query))delete p.metrics;
 if(!/秒杀|活动|二维码|商品|优惠/.test(query))delete p.sale;
 if(!/抽奖|中奖|奖品/.test(query))delete p.lottery;
 // Construct from the stage allowlist so newly added payload fields cannot silently leak to every stage.
 return Object.fromEntries(MODEL_FIELDS[kind].filter(key=>p[key]!==undefined).map(key=>[key,p[key]]));
}
