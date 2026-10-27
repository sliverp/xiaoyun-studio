/** Platform-owned room addresses and safe metadata shared by the console and server. */
export const PLATFORM_CATALOG = [
 {id:'bilibili',name:'哔哩哔哩',description:'B 站直播间弹幕与独立推流',roomPlaceholder:'直播间号或 https://live.bilibili.com/12345',loginDescription:'在服务器浏览器中打开 B 站登录页，使用哔哩哔哩 App 扫码；登录态仅保存在此连接。',chatSupported:true,verification:'requires-live-account'},
 {id:'douyin',name:'抖音',description:'抖音直播间弹幕与独立推流',roomPlaceholder:'直播间号或 https://live.douyin.com/12345',loginDescription:'在服务器浏览器中登录抖音；扫码或安全验证要求以平台页面为准。',chatSupported:true,verification:'requires-live-account'},
 {id:'kuaishou',name:'快手',description:'快手直播间弹幕与独立推流',roomPlaceholder:'主播 ID 或 https://live.kuaishou.com/u/主播ID',loginDescription:'在服务器浏览器中使用快手 App 扫码；平台要求额外验证时按页面完成。',chatSupported:true,verification:'requires-live-account'},
 {id:'wechat',name:'视频号',description:'视频号助手后台弹幕与独立推流',roomPlaceholder:'留空使用视频号助手直播后台',loginDescription:'在服务器浏览器中打开视频号助手，使用微信扫码，再保持直播后台连接。',chatSupported:true,verification:'requires-live-account'},
 {id:'custom',name:'自定义 RTMP',description:'其他平台或原有推流配置',roomPlaceholder:'此类型不内置弹幕采集',loginDescription:'自定义推流不需要扫码；弹幕可通过受保护接入口接入。',chatSupported:false,verification:'stream-only'},
]
export const CONNECTION_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export function platformInfo(id){const value=PLATFORM_CATALOG.find(item=>item.id===id);if(!value)throw new Error('不支持的直播平台');return value}
/** Accept official desktop live rooms only; server login/navigation uses separate fixed URLs. */
export function normalizeRoomUrl(platform,value=''){
 platformInfo(platform)
 if(typeof value!=='string'||value.length>2048)throw new Error('直播间地址过长或无效')
 const input=value.trim();if(!input)return ''
 if(platform==='custom')throw new Error('自定义推流请通过弹幕接入口接入消息')
 const prefixes={bilibili:'https://live.bilibili.com/',douyin:'https://live.douyin.com/',kuaishou:'https://live.kuaishou.com/u/'}
 const candidate=/^[A-Za-z0-9_-]{1,120}$/.test(input)&&prefixes[platform]?prefixes[platform]+input:input
 let url;try{url=new URL(candidate)}catch{throw new Error('请填写直播间号或该平台的官方直播间地址')}
 const hosts={bilibili:['live.bilibili.com'],douyin:['live.douyin.com'],kuaishou:['live.kuaishou.com'],wechat:['channels.weixin.qq.com']}
 if(url.protocol!=='https:'||url.username||url.password||url.port||!hosts[platform].includes(url.hostname))throw new Error('直播间地址必须是所选平台的官方 HTTPS 地址')
 if(platform==='wechat'&&!url.pathname.startsWith('/platform/'))throw new Error('视频号请使用视频号助手后台地址')
 url.hash='';return url.href
}
export function validateStreamAddress(value){
 if(typeof value!=='string'||value.length>2048)throw new Error('推流地址无效')
 if(!value)return ''
 let url;try{url=new URL(value)}catch{throw new Error('请填写 RTMP/RTMPS 服务器地址，密钥另填')}
 if(!['rtmp:','rtmps:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||/[|\r\n\0]/.test(value))throw new Error('推流使用 RTMP/RTMPS 地址，密钥另填；不支持 RTSP')
 return value
}
export function validateConnection(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!CONNECTION_ID.test(value.id||''))throw new Error('平台连接 ID 无效')
 const fields=['id','platform','name','enabled','roomUrl','rtmpUrl'];if(Object.keys(value).some(key=>!fields.includes(key)))throw new Error('未知的平台连接字段')
 platformInfo(value.platform)
 if(typeof value.name!=='string'||!value.name.trim()||value.name.length>100||typeof value.enabled!=='boolean')throw new Error('平台名称或启用状态无效')
 normalizeRoomUrl(value.platform,value.roomUrl);validateStreamAddress(value.rtmpUrl)
 return value
}
