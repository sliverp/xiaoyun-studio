/** Paragraphs, page completion and interludes have independent counters. Plans are not aired progress. */
export function minimumPageTurns(config){return Math.max(1,Math.min(12,Number(config.live?.minPageTurns??3)||3))}
export function paragraphLimit(config){return Math.max(60,Math.min(450,Math.round((config.live?.pageSeconds||35)*4.5)))}
export function pageProgress(config,memory,actualTurns=0){
 const before=Number(memory.turns)||0,minimum=minimumPageTurns(config),turnNumber=before+1
 const focuses=['解释当前页的一个核心概念，以及它解决的具体问题','继续当前页的关键机制、流程或参数细节，推进新的要点','用当前页已有事实展开一个具体场景或例子，说明实际用途与取舍','补齐当前页还没展开的要点，回应相关的理解困难或选型问题']
 return {minimumTurns:minimum,turnNumber,targetSeconds:config.live?.pageSeconds||35,maxCharacters:paragraphLimit(config),actuallyAiredTurns:actualTurns,plannedTurnsBeforeThis:Math.max(0,before-actualTurns),canAdvanceAfterThisTurn:turnNumber>=minimum,focus:focuses[Math.min(before,focuses.length-1)],coveredOutline:[...(memory.outline||[])]}
}
export function mayAdvancePage(config,completedTurns){return completedTurns>=minimumPageTurns(config)}
