/** Reusable program vocabulary shared by the editor and server scheduler. */
export const PROGRAM_STAGES=[
 {id:'source',name:'内容讲解',description:'讲解演示稿与本场主题'},
 {id:'comment',name:'弹幕回应',description:'有新弹幕且达到回应频率时进入'},
 {id:'engagement',name:'互动引导',description:'按互动节奏提问、邀请点赞或分享'},
 {id:'lottery',name:'抽奖',description:'选中的抽奖规则满足后进入'},
 {id:'sale',name:'秒杀提醒',description:'手动安排或到达定时时间后进入'},
]
export const LOTTERY_TRIGGERS=['comment','popularity','interval','fixed']
export function defaultProgram(){return {opening:true,closing:true,order:PROGRAM_STAGES.map(stage=>stage.id),enabled:Object.fromEntries(PROGRAM_STAGES.map(stage=>[stage.id,true]))}}
export function programOf(config){const fallback=defaultProgram();return {...fallback,...config.program,enabled:{...fallback.enabled,...config.program?.enabled}}}
export function lotteryTriggersOf(lottery={}){
 if(Array.isArray(lottery.triggers))return lottery.triggers
 return [...(lottery.intervalMinutes?['interval']:[]),...(lottery.popularityThreshold?['popularity']:[]),...(lottery.fixedTimes?.length?['fixed']:[])]
}

/** The percentage is a user-facing frequency control, not a probability or a page boundary. */
export function commentGap(frequency){return frequency>=80?1:frequency>=30?2:3}
