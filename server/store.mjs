import { validateConnection, normalizeRoomUrl, platformInfo } from './platform-catalog.mjs'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const SECRET_NAMES = ['llmKey','ttsKey','tencentSecretId','tencentSecretKey','streamKey','commentIngestKey','fallbackKey1','fallbackKey2','fallbackKey3','llmFallbackKey']
const copy = value => structuredClone(value)
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const assert = (ok, message) => { if (!ok) throw new Error(message) }
const text = (value, max) => typeof value === 'string' && value.length <= max
const number = (value, min, max) => Number.isFinite(value) && value >= min && value <= max
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max
const bool = value => typeof value === 'boolean'

export function defaults(root) {
 return {
  identity:{name:'小云',systemPrompt:'你是小云，一位亲切、专业的 AI 主播。你是本场内容的主讲人，直接向观众分享观点和实践，演示稿只是讲解手段。只依据当前内容与已验证事实展开，不编造价格、库存、数据或观众反应。自然回应新弹幕，适量邀请点赞、分享和提问。',welcome:'欢迎来到小云 Studio。我们一起看看，AI 虚拟主播怎样在云端工作。',goodbye:'感谢大家的陪伴，我们下次再见！'},
  llm:{baseUrl:'https://api.openai.com/v1',model:'',fallbacks:[]},
  tts:{provider:'demo',baseUrl:'https://api.openai.com/v1',model:'tts-1',voice:'602003',speed:1,demoAsset:resolve(root,'public/demo/greeting.mp3'),demoText:'各位轻友，大家好！我是小云，Lighthouse 轻友团的 AI 伙伴。很开心来参加今晚的聚会！我的“AI 第六感”，就是对好点子特别敏感。虽然住在屏幕里，我也想和大家一起聊聊云、动动脑，让今晚多一点灵感，多一点快乐！'},
  asr:{baseUrl:''},
  presentation:{url:'/assets/builtin/slides/index.html',notes:'',autoAdvance:true,loop:true},
  live:{commentFrequency:50,pageSeconds:40,commentSeconds:12,engagementMinTurns:3,engagementCooldownSeconds:90,silenceSeconds:120},
  sale:{enabled:false,intervalMinutes:60,startAt:null,endAt:null,durationSeconds:300,link:'',qrUrl:''},
  lottery:{keyword:'小云开播',waitSeconds:10,prizes:['直播间礼物'],enabled:false,intervalMinutes:60,popularityThreshold:0,fixedTimes:[]},
  scene:{title:'云上 AI 直播间',subtitle:'AI 干货分享 · 云端 Agent 实践 · 实时弹幕互动',background:'#eaf5ff',avatarName:'小云',communityQrUrl:'',communityLabel:'欢迎加入交流社群',layout:{mode:'standard',showAvatar:true,showCommunity:true,showCaptions:true}},
  bgm:{asset:'/assets/builtin/bgm/upbeat-loop.mp3',volume:0.12,ducking:0.25},
  output:{width:1280,height:720,fps:15,videoBitrate:2500,audioBitrate:128,rtmpUrl:'',record:true},
  platforms:[],
  cues:JSON.parse(readFileSync(join(root,'public/demo/cues.json'),'utf8')),
 }
}
function merge(base, patch) {
 assert(plain(patch),'设置必须是对象')
 for (const [key,value] of Object.entries(patch)) {
  assert(!['__proto__','constructor','prototype'].includes(key),'无效的设置字段')
  assert(Object.hasOwn(base,key),'未知设置字段：'+key)
  base[key] = plain(value) && plain(base[key]) ? merge(base[key],value) : copy(value)
 }
 return base
}
export function validateConfig(c) {
 assert(text(c.identity.name,80) && c.identity.name.trim() && text(c.identity.systemPrompt,20000),'主播名称或系统提示词无效')
 assert(text(c.identity.welcome,2000) && text(c.identity.goodbye,2000),'开场或结束语过长')
 for(const url of [c.llm.baseUrl,c.tts.baseUrl,c.asr.baseUrl]) if(url){const u=new URL(url);assert(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password,'服务地址仅支持 HTTP/HTTPS')}
 assert(text(c.llm.model,160) && Array.isArray(c.llm.fallbacks) && c.llm.fallbacks.length<=3,'模型设置无效')
 for(const route of c.llm.fallbacks){assert(plain(route)&&text(route.baseUrl,2048)&&text(route.model,160)&&SECRET_NAMES.includes(route.keyName),'备用模型设置无效');const u=new URL(route.baseUrl);assert(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password,'备用服务地址无效')}
 assert(['tencent','openai','demo'].includes(c.tts.provider) && number(c.tts.speed,.6,2),'语音设置无效，语速应为0.6–2倍')
 assert(text(c.tts.voice,120)&&text(c.tts.model,120)&&text(c.tts.demoAsset,2048)&&text(c.tts.demoText,2000),'音色设置无效')
 assert(text(c.presentation.url,4096)&&text(c.presentation.notes,120000)&&bool(c.presentation.autoAdvance)&&bool(c.presentation.loop),'演示素材设置无效')
 if(c.presentation.url) validatePresentation(c.presentation.url)
 assert(integer(c.live.commentFrequency,0,100)&&integer(c.live.pageSeconds,10,90)&&integer(c.live.commentSeconds,5,30),'讲解或弹幕频率设置无效')
 assert(integer(c.live.engagementMinTurns,2,20)&&integer(c.live.engagementCooldownSeconds,30,1200)&&integer(c.live.silenceSeconds,120,600),'互动或恢复间隔无效')
 assert(bool(c.sale.enabled)&&integer(c.sale.intervalMinutes,5,1440)&&integer(c.sale.durationSeconds,60,1800),'秒杀间隔至少5分钟，展示时长应为1–30分钟')
 for(const at of [c.sale.startAt,c.sale.endAt])assert(at===null || Number.isSafeInteger(at)&&at>=0,'秒杀时间无效')
 if(c.sale.startAt!==null&&c.sale.endAt!==null)assert(c.sale.endAt>c.sale.startAt,'秒杀结束时间必须晚于开始时间')
 assert(text(c.sale.link,2048)&&text(c.sale.qrUrl,2048),'秒杀入口无效')
 if(c.sale.link){const u=new URL(c.sale.link);assert(u.protocol==='https:'&&!u.username&&!u.password,'秒杀入口需要 HTTPS')}
 assert(Array.isArray(c.lottery.fixedTimes)&&c.lottery.fixedTimes.length<=24&&c.lottery.fixedTimes.every(value=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)),'定时抽奖采用北京时间HH:mm')
 assert(text(c.lottery.keyword,100)&&integer(c.lottery.waitSeconds,5,120)&&Array.isArray(c.lottery.prizes)&&c.lottery.prizes.length<=1000&&c.lottery.prizes.every(p=>text(p,200)),'抽奖设置无效')
 assert(bool(c.lottery.enabled)&&integer(c.lottery.intervalMinutes,1,1440)&&number(c.lottery.popularityThreshold,0,1e12),'抽奖触发规则无效')
 for(const key of ['title','subtitle','avatarName','communityLabel'])assert(text(c.scene[key],300),'画面文案过长')
 assert(/^#[\da-f]{6}$/i.test(c.scene.background)&&plain(c.scene.layout)&&['standard','avatar','slides','green'].includes(c.scene.layout.mode),'画面布局无效')
 for(const key of ['showAvatar','showCommunity','showCaptions'])assert(bool(c.scene.layout[key]),'画面开关无效')
 for(const asset of [c.scene.communityQrUrl,c.sale.qrUrl,c.bgm.asset])assert(text(asset,2048)&&(!asset||asset.startsWith('/assets/')),'请先上传素材，再选择对应素材地址')
 assert(number(c.bgm.volume,0,1)&&number(c.bgm.ducking,0,1),'BGM 音量应为0–1')
 assert(integer(c.output.width,640,1920)&&c.output.width%2===0&&integer(c.output.height,360,1080)&&c.output.height%2===0&&integer(c.output.fps,5,30),'输出尺寸应为偶数，帧率5–30')
 assert(integer(c.output.videoBitrate,300,16000)&&integer(c.output.audioBitrate,64,320)&&bool(c.output.record),'编码参数无效')
 assert(text(c.output.rtmpUrl,2048),'推流地址无效')
 if(c.output.rtmpUrl){const u=new URL(c.output.rtmpUrl);assert(['rtmp:','rtmps:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash,'请填写 RTMP/RTMPS 服务器地址，密钥另填')}
 assert(Array.isArray(c.platforms)&&c.platforms.length<=8,'最多添加8个平台连接')
 const ids=new Set();for(const connection of c.platforms){validateConnection(connection);assert(!ids.has(connection.id),'平台连接 ID 重复');ids.add(connection.id)}
 assert(Array.isArray(c.cues)&&c.cues.length<=100,'固定口播数量过多')
 for(const cue of c.cues)assert(plain(cue)&&/^[a-zA-Z0-9_-]{1,100}$/.test(cue.id)&&text(cue.title,160)&&text(cue.text,4000)&&text(cue.audioUrl||'',2048)&&(cue.text?.trim()||cue.audioUrl)&&(!cue.audioUrl||cue.audioUrl.startsWith('/assets/')),'固定口播需要有效名称、文案或已上传的音频')
 return c
}
export function validatePresentation(address) {
 if(address.startsWith('/assets/'))return address
 const u=new URL(address)
 assert(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password,'演示页仅支持 HTTP/HTTPS 和已上传 HTML')
 assert(!['169.254.169.254','metadata.google.internal','metadata.tencentyun.com','100.100.100.200','0.0.0.0'].includes(u.hostname),'不能访问云实例元数据地址')
 return u.href
}
export function atomicJson(path, value) {
 mkdirSync(dirname(path),{recursive:true,mode:0o700})
 writeFileSync(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600})
 renameSync(path+'.tmp',path)
}
export class Store {
 constructor({dataDir,root,env=process.env}) {
  this.dataDir=dataDir;this.file=join(dataDir,'settings.json');this.secretFile=join(dataDir,'secrets.json')
  mkdirSync(dataDir,{recursive:true,mode:0o700})
  this.config=defaults(root);this.vault={}
  try{this.config=merge(this.config,JSON.parse(readFileSync(this.file,'utf8')))}catch(e){if(e.code!=='ENOENT')throw e}
  try{this.vault=JSON.parse(readFileSync(this.secretFile,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
  for(const [name,key] of Object.entries({llmKey:'STUDIO_LLM_KEY',ttsKey:'STUDIO_TTS_KEY',tencentSecretId:'TENCENT_SECRET_ID',tencentSecretKey:'TENCENT_SECRET_KEY',streamKey:'STUDIO_STREAM_KEY'}))if(env[key])this.vault[name]=env[key]
  if(env.STUDIO_ASR_BASE_URL)this.config.asr.baseUrl=env.STUDIO_ASR_BASE_URL
  if(!this.vault.commentIngestKey)this.vault.commentIngestKey=randomBytes(24).toString('hex')
  if(!this.config.platforms.length&&this.config.output.rtmpUrl){this.config.platforms=[{id:'legacy-output',platform:'custom',name:'原推流配置',enabled:true,roomUrl:'',rtmpUrl:this.config.output.rtmpUrl}];if(this.vault.streamKey)this.vault['platform.legacy-output.streamKey']=this.vault.streamKey;this.config.output.rtmpUrl='';atomicJson(this.file,this.config)}
  validateConfig(this.config);atomicJson(this.secretFile,this.vault)
 }
 get(){return copy(this.config)}
 secret(name){return this.vault[name]||''}
 presence(){return Object.fromEntries(SECRET_NAMES.map(key=>[key,Boolean(this.vault[key])]))}
 platformSecret(id){return this.secret('platform.'+id+'.streamKey')}
 preparePlatform(patch,id){
  assert(plain(patch),'平台设置必须是对象');const allowed=['platform','name','enabled','roomUrl','rtmpUrl','streamKey'];assert(Object.keys(patch).every(key=>allowed.includes(key)),'未知的平台设置字段')
  const existing=id?this.config.platforms.find(item=>item.id===id):null;if(id)assert(existing,'平台连接不存在')
  if(!existing)assert(this.config.platforms.length<8,'最多添加8个平台连接')
  const selected=platformInfo(existing?.platform||patch.platform);if(existing&&patch.platform!==undefined)assert(patch.platform===existing.platform,'请新建连接以切换平台')
  const connection={...(existing||{id:randomBytes(12).toString('hex'),platform:selected.id,name:selected.name,enabled:true,roomUrl:'',rtmpUrl:''}),...Object.fromEntries(Object.entries(patch).filter(([key])=>key!=='streamKey'))}
  connection.name=typeof connection.name==='string'?connection.name.trim():connection.name;connection.roomUrl=normalizeRoomUrl(connection.platform,connection.roomUrl);connection.rtmpUrl=typeof connection.rtmpUrl==='string'?connection.rtmpUrl.trim():connection.rtmpUrl
  validateConnection(connection);if(patch.streamKey!==undefined&&patch.streamKey!==null)assert(text(patch.streamKey,8192)&&!/[|\r\n\0]/.test(patch.streamKey),'推流密钥格式无效')
  const next=copy(this.config);next.platforms=existing?next.platforms.map(item=>item.id===id?connection:item):[...next.platforms,connection];validateConfig(next)
  const vault={...this.vault},key='platform.'+connection.id+'.streamKey';if(patch.streamKey===null)delete vault[key];else if(patch.streamKey)vault[key]=patch.streamKey
  return {connection,next,vault}
 }
 savePlatform(patch,id){const {connection,next,vault}=this.preparePlatform(patch,id);atomicJson(this.secretFile,vault);atomicJson(this.file,next);this.vault=vault;this.config=next;return copy(connection)}
 removePlatform(id){const next=copy(this.config);assert(next.platforms.some(item=>item.id===id),'平台连接不存在');next.platforms=next.platforms.filter(item=>item.id!==id);const vault={...this.vault};delete vault['platform.'+id+'.streamKey'];atomicJson(this.file,next);atomicJson(this.secretFile,vault);this.config=next;this.vault=vault}
 update(patch){if(patch?.tts&&Object.hasOwn(patch.tts,'demoAsset'))throw new Error('内置演示录音不可通过设置修改');const next=validateConfig(merge(copy(this.config),patch));atomicJson(this.file,next);this.config=next;return this.get()}
 setSecrets(patch){assert(plain(patch),'密钥设置无效');const next={...this.vault};for(const [key,value] of Object.entries(patch)){assert(SECRET_NAMES.includes(key),'未知密钥名称');if(value===null)delete next[key];else if(value!==''){assert(text(value,8192)&&!/[\r\n\0]/.test(value),'密钥格式无效');next[key]=value}}atomicJson(this.secretFile,next);this.vault=next}
 redact(value){let result=String(value||'');for(const secret of Object.values(this.vault))if(typeof secret==='string'&&secret.length>3)result=result.split(secret).join('[redacted]');return result.replace(/(?:sk-|AKID)[A-Za-z0-9_-]{8,}/g,'[redacted]')}
}
