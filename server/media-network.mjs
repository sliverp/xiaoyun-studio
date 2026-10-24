import {lookup} from 'node:dns/promises'
import {isIP} from 'node:net'

/** Reject local infrastructure and metadata endpoints when rendering user-selected remote pages. */
export function blockedPresentationAddress(value,{allowPrivate=false}={}){
  const host=value.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'')
  if(host==='metadata.google.internal'||host==='metadata'||host==='100.100.100.200'||host==='fd00:ec2::254')return true
  if(host.startsWith('::ffff:')){
    const tail=host.slice(7)
    if(isIP(tail)===4)return blockedPresentationAddress(tail,{allowPrivate})
    const words=tail.split(':');if(words.length!==2||words.some(word=>!/^[0-9a-f]{1,4}$/.test(word)))return true
    const [high,low]=words.map(word=>parseInt(word,16))
    return blockedPresentationAddress([high>>8,high&255,low>>8,low&255].join('.'),{allowPrivate})
  }
  if(host.startsWith('169.254.')||/^fe[89ab]/.test(host))return true
  if(allowPrivate)return false
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host==='::1'||host==='::')return true
  if(host.startsWith('fc')&&isIP(host)===6||host.startsWith('fd')&&isIP(host)===6)return true
  if(isIP(host)===4){const [a,b]=host.split('.').map(Number);return a===0||a===10||a===127||a>=224||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127}
  return false
}

/** Resolve every remote host before a Chromium request, with a short bounded cache. */
export function createPresentationNetworkPolicy(baseUrl){
  const origin=new URL(baseUrl).origin,cache=new Map(),allowPrivate=process.env.ALLOW_PRIVATE_PRESENTATIONS==='1'
  return async value=>{
    const url=new URL(value)
    if(['data:','blob:','about:'].includes(url.protocol))return {local:false}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('演示稿只支持 HTTP/HTTPS 地址')
    if(url.origin===origin)return {local:true}
    const host=url.hostname.replace(/^\[|\]$/g,'')
    if(blockedPresentationAddress(host,{allowPrivate}))throw new Error('不能打开本机、内网或云元数据地址；内网演示稿需由部署者显式授权')
    const cached=cache.get(host)
    if(cached&&cached.expires>Date.now())return {local:false}
    const addresses=isIP(host)?[{address:host}]:await lookup(host,{all:true})
    if(!addresses.length||addresses.some(item=>blockedPresentationAddress(item.address,{allowPrivate})))throw new Error('演示稿域名指向受保护的网络地址')
    cache.set(host,{expires:Date.now()+30000});if(cache.size>256)cache.delete(cache.keys().next().value)
    return {local:false}
  }
}
