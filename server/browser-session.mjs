/** Portable state from an operator-owned, dedicated video-channel browser only. */
export const CHANNEL_ENTRY='https://channels.weixin.qq.com/platform/live/liveBuild'
/** The management landing page does not join the room or poll live messages. */
export function channelsLiveRoomPath(path){return path==='/platform/live/liveBuild'||path?.startsWith('/platform/live/liveBuild/')===true}
export const SESSION_ORIGINS=new Set(['https://channels.weixin.qq.com','https://open.weixin.qq.com'])
export function sessionAddressAllowed(address){try{const u=new URL(address);return u.protocol==='https:'&&u.hostname==='channels.weixin.qq.com'&&!u.username&&!u.password&&!u.port&&u.href.length<4096}catch{return false}}
export function sessionCookieAllowed(domain){return ['channels.weixin.qq.com','open.weixin.qq.com','weixin.qq.com'].includes(String(domain||'').replace(/^\./,''))}
const invalid=()=>new Error('视频号登录状态格式无效，请从本机助手重新同步')
export function normalizeBrowserSession(input){
 if(!input||input.version!==1||input.platform!=='wechat'||typeof input.userAgent!=='string'||!input.userAgent||input.userAgent.length>512||!sessionAddressAllowed(input.entryUrl)||!Array.isArray(input.cookies)||!input.cookies.length||input.cookies.length>200||!Array.isArray(input.origins)||input.origins.length>2||Buffer.byteLength(JSON.stringify(input))>768*1024)throw invalid()
 const cookies=input.cookies.map(cookie=>{
  if(!cookie||!sessionCookieAllowed(cookie.domain)||typeof cookie.name!=='string'||!cookie.name||cookie.name.length>200||/[\s;=\x00-\x1f]/.test(cookie.name)||typeof cookie.value!=='string'||cookie.value.length>16384||/[\x00-\x1f]/.test(cookie.value)||typeof cookie.path!=='string'||!cookie.path.startsWith('/')||cookie.path.length>1024)throw invalid()
  const value={name:cookie.name,value:cookie.value,domain:cookie.domain,path:cookie.path,httpOnly:cookie.httpOnly===true,secure:cookie.secure===true}
  if(Number.isFinite(cookie.expires)&&cookie.expires>0)value.expires=cookie.expires
  if(['Strict','Lax','None'].includes(cookie.sameSite))value.sameSite=cookie.sameSite
  return value
 })
 const seen=new Set(),origins=input.origins.map(item=>{
  if(!item||!SESSION_ORIGINS.has(item.origin)||seen.has(item.origin))throw invalid();seen.add(item.origin)
  const entries=values=>{if(!Array.isArray(values)||values.length>200)throw invalid();return values.map(pair=>{if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||typeof pair[1]!=='string'||pair[0].length>1024||pair[1].length>256*1024)throw invalid();return [pair[0],pair[1]]})}
  return {origin:item.origin,localStorage:entries(item.localStorage),sessionStorage:entries(item.sessionStorage)}
 })
 return {version:1,platform:'wechat',entryUrl:input.entryUrl,userAgent:input.userAgent,cookies,origins}
}
export async function captureBrowserSession(browser,page){
 if(!sessionAddressAllowed(page?.url?.()))throw new Error('请先在本机打开并登录视频号助手')
 const origins=[]
 for(const frame of page.frames()){
  let origin;try{origin=new URL(frame.url()).origin}catch{continue}
  if(!SESSION_ORIGINS.has(origin)||origins.some(item=>item.origin===origin))continue
  origins.push(await frame.evaluate(()=>({origin:location.origin,localStorage:Object.entries(localStorage),sessionStorage:Object.entries(sessionStorage)})))
 }
 const cookies=(await browser.defaultBrowserContext().cookies()).filter(cookie=>sessionCookieAllowed(cookie.domain))
 return normalizeBrowserSession({version:1,platform:'wechat',entryUrl:page.url(),userAgent:await page.evaluate(()=>navigator.userAgent),cookies,origins})
}
export async function seedBrowserSession(browser,page,state){
 if(state.userAgent)await page.setUserAgent(state.userAgent)
 if(state.cookies?.length)await browser.defaultBrowserContext().setCookie(...state.cookies)
 await page.evaluateOnNewDocument(origins=>{
  const values=origins.find(item=>item.origin===location.origin);if(!values)return
  for(const [key,value] of values.localStorage)if(localStorage.getItem(key)===null)localStorage.setItem(key,value)
  for(const [key,value] of values.sessionStorage)if(sessionStorage.getItem(key)===null)sessionStorage.setItem(key,value)
 },state.origins||[])
}
export async function backendSessionReady(page){
 if(!sessionAddressAllowed(page.url()))return false
 return page.evaluate(()=>{const text=document.body?.innerText||'';return location.pathname.startsWith('/platform')&&!/扫码登录|登录视频号助手|微信扫一扫登录|请选择.{0,12}(视频号|账号|身份|子用户)/.test(text)&&Boolean([...document.querySelectorAll('.finder-ui-desktop-menu__link,[data-studio-authenticated="true"]')].find(n=>n.getClientRects().length))})
}
