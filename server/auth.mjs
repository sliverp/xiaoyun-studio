import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicJson } from './store.mjs'
const equal=(a,b)=>{const l=Buffer.from(a),r=Buffer.from(b);return l.length===r.length&&timingSafeEqual(l,r)}
export class Auth {
 constructor({dataDir,password,secure=false}) {
  this.sessions=new Map();this.attempts=new Map();this.secure=secure;this.firstRun=false
  const file=join(dataDir,'auth.json');let record
  try{record=JSON.parse(readFileSync(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
  if(password&&password.length<12)throw new Error('管理员密码至少需要12个字符')
  if(!record||password){
   if(!password){password=randomBytes(18).toString('base64url');writeFileSync(join(dataDir,'first-login.txt'),password+'\n',{mode:0o600});this.firstRun=true}
   const salt=randomBytes(16).toString('hex');record={salt,hash:scryptSync(password,salt,64).toString('hex')};atomicJson(file,record)
  }
  if(!record||!/^([a-f0-9]{32})$/.test(record.salt)||!/^([a-f0-9]{128})$/.test(record.hash))throw new Error('管理员凭据文件格式无效')
  this.record=record
 }
 isAuthenticated(req){const match=/(?:^|;\s*)studio_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie||'');if(!match)return false;const expiry=this.sessions.get(match[1]);if(!expiry||expiry<Date.now()){this.sessions.delete(match[1]);return false}return true}
 login(req,password) {
  const key=req.socket.remoteAddress||'local',now=Date.now();let attempts=this.attempts.get(key)||{at:now,count:0};if(now-attempts.at>600000)attempts={at:now,count:0}
  if(this.attempts.size>5000){for(const [ip,item] of this.attempts)if(now-item.at>600000)this.attempts.delete(ip);if(this.attempts.size>5000)this.attempts.delete(this.attempts.keys().next().value)}
  if(attempts.count>=10)throw Object.assign(new Error('尝试次数过多，请十分钟后重试'),{status:429})
  if(typeof password!=='string'||password.length>1024||!equal(scryptSync(password,this.record.salt,64).toString('hex'),this.record.hash)){attempts.count++;this.attempts.set(key,attempts);throw Object.assign(new Error('密码不正确'),{status:401})}
  this.attempts.delete(key);const token=randomBytes(32).toString('base64url');this.sessions.set(token,now+24*3600000);if(this.sessions.size>1000)this.sessions.delete(this.sessions.keys().next().value)
  if(this.sessions.size>1000)for(const [k,expires] of this.sessions)if(expires<now)this.sessions.delete(k)
  return 'studio_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400'+(this.secure?'; Secure':'')
 }
 logout(req){const match=/(?:^|;\s*)studio_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie||'');if(match)this.sessions.delete(match[1]);return 'studio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(this.secure?'; Secure':'')}
}
export const equalToken=equal
export function checkOrigin(req){
 if(['GET','HEAD','OPTIONS'].includes(req.method))return
 const origin=req.headers.origin;if(!origin)return
 let u;try{u=new URL(origin)}catch{throw Object.assign(new Error('请求来源不匹配'),{status:403})}if(u.host!==req.headers.host||!['http:','https:'].includes(u.protocol))throw Object.assign(new Error('请求来源不匹配'),{status:403})
}
