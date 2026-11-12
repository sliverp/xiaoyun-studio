import {randomBytes,createHash} from 'node:crypto'
/** A separate, short-lived ticket preserves Studio login in the user-requested local workspace. */
export class LocalWorkspaceTickets{
 constructor({now=Date.now}={}){this.now=now;this.entries=new Map()}
 create({projectId,connectionId,browser='edge'}){
  for(const [key,item] of this.entries)if(item.expiresAt<=this.now())this.entries.delete(key)
  if(this.entries.size>=32)throw new Error('待打开的工作区过多，请稍后重试')
  const ticket=randomBytes(32).toString('base64url'),expiresAt=this.now()+120000
  this.entries.set(this.hash(ticket),{projectId,connectionId,browser,expiresAt});return {workspaceTicket:ticket,expiresAt}
 }
 hash(value){return createHash('sha256').update(value).digest('hex')}
 consume(ticket,projectId){
  if(typeof ticket!=='string'||!/^[\w-]{43}$/.test(ticket))throw Object.assign(new Error('工作区登录授权无效，请从小云重新打开'),{status:401})
  const key=this.hash(ticket),entry=this.entries.get(key)
  if(!entry||entry.expiresAt<=this.now())throw Object.assign(new Error('工作区登录授权已过期，请从小云重新打开'),{status:401})
  if(entry.projectId!==projectId)throw Object.assign(new Error('场景已切换，请从当前场景重新打开工作区'),{status:409})
  this.entries.delete(key);return entry
 }
}
