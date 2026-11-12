/** Bounded, grounded conversation shared by all live stages. Plans never count as spoken turns. */
const requestPattern=/[?？]|能不能|能否|可否|可以.*吗|怎么|如何|为什么|是什么|多少钱|价格|区别|举.*例|例子|讲.*(?:慢|快|详细|通俗|简单|清楚)|详细|听不懂|没听懂|先讲|再讲|重点|想(?:看|听|了解|知道)|关心|讲讲|说说|能用|换个|打个比方|希望|麻烦|请|不要|别讲|新手|小白|初学|零基础|预算|更关心|太快|太专业|展开|解释|介绍|说一下|看不清|\b(?:how|why|what|could|please)\b/i
const preferencePattern=/慢|快|通俗|简单|听不懂|没听懂|新手|小白|初学|零基础|少.*术语|以后.*(?:都|一直)|后面.*都|全程|小学生|听得懂|不要.*术语|别.*术语|多.*例子|\b(?:slow|simple|beginner)\b/i
const noise=/^(?:666+|谢谢(?:主播)?|来了|支持(?:主播)?|哈哈+|点赞|赞|👍+|你好(?:呀|啊|小云|主播)?|小云你好|主播你好|大家好|hello|hi)[!！。,.，\s]*$/iu
const followThroughPattern=/举.*例|例子|解释|讲讲|说说|讲解|讲.*(?:慢|快|详细|通俗|简单|清楚)|通俗|听不懂|没听懂|先讲|再讲|重点|想(?:看|听|了解)|更关心|预算|换个|展开|新手|小白|零基础|少.*术语|看不清|\b(?:explain|example|slow|simple|beginner)\b/i
const choicePattern=/我选|选择|先看|先听|^(?:[ABCabc123一二三](?:项|个)?)[吧呀。！!\s]*$/u
const copy=value=>structuredClone(value)
export class Conversation {
 constructor(){this.turns=[];this.requests=[];this.revision=0}
 reset(){this.turns=[];this.requests=[];this.revision++}
 prune(){const cutoff=Date.now()-20*60000;this.requests=this.requests.filter(row=>row.at>=cutoff).slice(-12)}
 acceptComments(rows){
  this.prune();let changed=false
  const lastInteraction=this.turns.findLast(turn=>turn.kind==='engagement'),answerWindow=lastInteraction&&Date.now()-lastInteraction.at<180000
  for(const row of rows){
   if(row.lotteryId||Date.now()-row.at>120000||noise.test(row.content)||this.requests.some(item=>item.id===row.id))continue
   if(!requestPattern.test(row.content)&&!(answerWindow&&choicePattern.test(row.content)))continue
   const preferenceText=row.content.split(/[，,。；;]/u).filter(part=>preferencePattern.test(part)).join('；').slice(0,500)
   const choice=Boolean(answerWindow&&choicePattern.test(row.content)),followThrough=Boolean(preferenceText||followThroughPattern.test(row.content)||choice)
   this.requests.push({id:row.id,source:'comment',nickname:row.nickname,content:row.content.slice(0,500),...(row.platformName?{platformName:row.platformName}:{}),at:row.at,status:'pending',followThrough,preference:Boolean(preferenceText),preferenceText,...(choice?{replyTo:lastInteraction.text.slice(0,300)}:{})});changed=true
  }
  this.prune();if(changed)this.revision++;return changed
 }
 acceptHost(id,text){this.prune();this.requests.push({id,source:'host',nickname:'主持人',content:text.slice(0,1000),at:Date.now(),status:'pending',followThrough:followThroughPattern.test(text)||preferencePattern.test(text),preference:preferencePattern.test(text),preferenceText:text.split(/[，,。；;]/u).filter(part=>preferencePattern.test(part)).join('；').slice(0,500)});this.prune();this.revision++}
 outstanding(){this.prune();return this.requests.filter(row=>row.status==='pending'||row.status==='answered'&&row.followThrough)}
 pending(ids){this.prune();return this.requests.filter(row=>row.status==='pending'&&(!ids||ids.includes(row.id)))}
 allowedIds(){return new Set(this.outstanding().map(row=>row.id))}
 aired(turn,pageNumber){
  this.turns.push({id:turn.id,kind:turn.kind,text:turn.text.slice(0,900),pageNumber,at:Date.now(),...(turn.question?{question:turn.question.slice(0,1000)}:{})});this.turns=this.turns.slice(-10)
  if(['comment','question'].includes(turn.kind))for(const row of this.requests)if(turn.audienceIds?.includes(row.id)&&row.status==='pending'){row.status='answered';row.answeredAt=Date.now()}
  if(turn.kind==='source')for(const row of this.requests)if(turn.appliedRequestIds?.includes(row.id)){row.status='incorporated';row.appliedAt=Date.now()}
 }
 context(){
  this.prune()
  return {recentTurns:copy(this.turns),lastSource:copy(this.turns.findLast(turn=>turn.kind==='source')||null),lastInteraction:copy(this.turns.findLast(turn=>turn.kind==='engagement')||null),audienceRequests:copy(this.outstanding()),activePreferences:copy(this.requests.filter(row=>row.preference).map(row=>({...row,content:row.preferenceText||row.content}))),recentlyApplied:copy(this.requests.filter(row=>row.status==='incorporated').slice(-4))}
 }
}
