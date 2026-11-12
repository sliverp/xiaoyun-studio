/** Non-secret provider metadata shared by the editor and server. */
export const MAX_PROVIDER_BACKUPS=4
export const MODEL_TIMEOUT_MS=10000
export const SPEECH_TIMEOUT_MS=5000
// Leave synthesis time below the five-second deadline for live 2.0 voices.
export const LIVE_SPEECH_CHARACTERS=40
export const LIVE_SPEECH_FIRST_CHARACTERS=24
export const TENCENT_VOICES=[
 // Basic TextToVoice voices, checked against the official voice list on 2026-10-29.
 {id:'402000',name:'云晓芙',style:'聊天女声',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'402001',name:'云小团',style:'温柔甜美女声',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'402002',name:'云大围',style:'磁性男声',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403009',name:'云嘉尔',style:'慵懒男声',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403010',name:'云嘉和',style:'温和男声',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403011',name:'云嘉瑜',style:'情感解说女声',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403012',name:'云嘉辉',style:'激情解说男声',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403013',name:'云小璇',style:'活力女青年',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403014',name:'云佳洁',style:'轻熟姐姐',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403000',name:'云小朵',style:'特色女童声',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403001',name:'云小和',style:'聊天女声',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403002',name:'云小帅',style:'解说男声',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403003',name:'云小天',style:'青春校园男声',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403004',name:'云大川',style:'活力男老师',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403005',name:'云雅琴',style:'沉稳女老师',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403006',name:'YunMia',style:'美音女助手',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403007',name:'YunLeo',style:'美音男助手',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'403008',name:'云小洋',style:'机灵男童',group:'超自然大模型音色 2.0',sampleRate:24000},
 {id:'602003',name:'爱小悠',style:'聊天女声',group:'超自然大模型音色',sampleRate:24000},
 {id:'602005',name:'专业梓欣',style:'聊天女声',group:'超自然大模型音色',sampleRate:24000},
 {id:'603004',name:'温柔小柠',style:'聊天女声',group:'超自然大模型音色',sampleRate:24000},
 {id:'603007',name:'邻家女孩',style:'聊天女声',group:'超自然大模型音色',sampleRate:24000},
 {id:'602004',name:'暖心阿灿',style:'聊天男声',group:'超自然大模型音色',sampleRate:24000},
 {id:'501001',name:'智兰',style:'资讯女声',group:'大模型音色',sampleRate:24000},
 {id:'501000',name:'智斌',style:'阅读男声',group:'大模型音色',sampleRate:24000},
 {id:'101001',name:'智瑜',style:'情感女声',group:'精品音色',sampleRate:16000},
]
export function voiceName(id,provider='tencent'){return provider==='tencent'?(TENCENT_VOICES.find(voice=>voice.id===String(id))?.name||(id?'自定义音色 '+id:'')):String(id||'')}
export function voiceLabel(id,provider='tencent'){const voice=provider==='tencent'&&TENCENT_VOICES.find(voice=>voice.id===String(id));return voice?voice.name+' · '+voice.style+(voice.group.endsWith('2.0')?' · 2.0':''):voiceName(id,provider)}
export function speechKeys(slot){return slot?{apiKey:'ttsFallbackKey'+slot,secretId:'ttsFallbackSecretId'+slot,secretKey:'ttsFallbackSecretKey'+slot}:{apiKey:'ttsKey',secretId:'tencentSecretId',secretKey:'tencentSecretKey'}}
