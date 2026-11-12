import {readFileSync} from 'node:fs'

/** Read only this container's memory budget; never infer a limit from host-wide memory. */
export function containerMemory(read=path=>readFileSync(path,'utf8')){
 for(const [usagePath,limitPath,statPath,cacheKey]of [
  ['/sys/fs/cgroup/memory.current','/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory.stat','inactive_file'],
  ['/sys/fs/cgroup/memory/memory.usage_in_bytes','/sys/fs/cgroup/memory/memory.limit_in_bytes','/sys/fs/cgroup/memory/memory.stat','total_inactive_file']
 ])try{
  const used=Number(read(usagePath).trim()),limit=Number(read(limitPath).trim())
  if(Number.isFinite(used)&&used>=0&&Number.isFinite(limit)&&limit>0&&limit<Number.MAX_SAFE_INTEGER){
   let cache=0;try{cache=Number(new RegExp('^'+cacheKey+' (\\d+)$','m').exec(read(statPath))?.[1])||0}catch{}
   return {used:Math.max(0,used-cache),limit}
  }
 }catch{/* Non-container hosts do not have a readable cgroup memory budget. */}
 return null
}

/** Reclaim browser caches before OOM; age-based maintenance waits for an idle broadcast. */
export function renderMaintenance({now,openedAt,lastMaintenanceAt,outputRunning,voiceActive,memory}){
 if(!openedAt||now-lastMaintenanceAt<60000)return ''
 if(memory&&memory.used>=memory.limit*.82)return '后台渲染内存较高，正在释放缓存并重建画面'
 if(!outputRunning&&!voiceActive&&now-openedAt>=2*60*60*1000)return '正在维护后台渲染，稍后自动恢复画面'
 return ''
}
