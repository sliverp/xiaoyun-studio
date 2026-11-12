import {randomBytes,createHash} from 'node:crypto'
const fail=message=>Object.assign(new Error(message),{status:401})
/** Short-lived, single-use grants can import only one connection in the currently active scene. */
export class LocalLoginGrants{
 constructor({now=Date.now}={}){this.now=now;this.entries=new Map()}
 hash(token){return createHash('sha256').update(token).digest('hex')}
 create({projectId,connectionId,name}){
  for(const [key,value] of this.entries)if(value.expiresAt<=this.now()||value.used)this.entries.delete(key)
  if(this.entries.size>=32)throw new Error('待同步连接过多，请稍后重试')
  const token=randomBytes(32).toString('base64url'),expiresAt=this.now()+20*60*1000
  this.entries.set(this.hash(token),{projectId,connectionId,name,expiresAt,used:false})
  return {token,expiresAt,projectId,connectionId,name}
 }
 get(token,projectId){
  if(typeof token!=='string'||!/^[\w-]{43}$/.test(token))throw fail('本机同步授权无效，请在小云重新连接')
  const value=this.entries.get(this.hash(token))
  if(!value||value.used||value.expiresAt<=this.now())throw fail('本机同步授权已失效，请在小云重新连接')
  if(value.projectId!==projectId)throw Object.assign(new Error('场景已切换，请在当前场景重新连接本机浏览器'),{status:409})
  return value
 }
 consume(token,projectId){const value=this.get(token,projectId);value.used=true;return value}
 clear(){this.entries.clear()}
}
