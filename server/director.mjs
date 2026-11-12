/** Standalone live director. Only fully played utterances advance source, comment and prize state. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {platformInfo} from './platform-catalog.mjs'
import {hasSpeechContent,splitLiveSpeech} from './providers.mjs'
import {programOf,lotteryTriggersOf,commentGap} from '../public/program-config.mjs'
import {Conversation} from './conversation.mjs'
import {modelSystemPrompt} from './director-prompts.mjs'
import {projectStageContext} from './director-context.mjs'
import {pageProgress,mayAdvancePage,minimumPageTurns} from './live-pacing.mjs'
import {commentWindow,modelComments,commentReferences,fitCommentText,expandCommentIds,COMMENT_WINDOW_LIMIT} from './comment-window.mjs'

const LABELS = { idle: '准备就绪', opening: '开场欢迎', source: '内容讲解', comment: '弹幕回应', engagement: '互动引导', sale: '秒杀提醒', 'lottery-announcement': '抽奖说明', 'lottery-wait': '抽奖参与', 'lottery-result': '开奖播报', question: '人机对话', cue: '固定口播', advancing: '翻页', closing: '收尾告别', ended: '已结束', error: '异常等待恢复' }
const COMMENT_REPLY_RETRY_MS = 30000
const GENERATED_SPEECH = new Set(['source','comment','engagement','question'])
const clone = value => JSON.parse(JSON.stringify(value))
const asTime = value => value == null || value === '' ? null : typeof value === 'number' ? value : Date.parse(value)
const clipped = (text, limit) => {
  const source = String(text || '').trim()
  if (source.length <= limit) return source
  const head = source.slice(0, limit), end = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'))
  return end > limit / 2 ? head.slice(0, end + 1) : head + '。'
}
const aborted = signal => { if (signal?.aborted) throw signal.reason || new Error('操作已取消') }
const winnerFromComment=row=>({id:row.id,nickname:row.nickname,...(row.connectionId?{connectionId:row.connectionId,platform:row.platform,platformName:row.platformName,connectionName:row.connectionName,userId:row.userId||''}:{})})
const abortError = () => new DOMException('操作已取消', 'AbortError')
const cancellable = (promise,signal) => {
  aborted(signal)
  return new Promise((resolvePromise,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason||abortError())}
    signal.addEventListener('abort',abort,{once:true})
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolvePromise(value)},error=>{signal.removeEventListener('abort',abort);reject(error)})
  })
}
const sleep = (ms, signal) => new Promise((resolvePromise, reject) => {
  if (signal?.aborted) return reject(signal.reason || abortError())
  const abort = () => { clearTimeout(timer); reject(signal.reason || abortError()) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolvePromise() }, ms)
  signal?.addEventListener('abort', abort, { once: true })
})

/** Validate model text at the JSON boundary; a page may contain many complete spoken turns. */
export function parseTurn(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  let value
  try { value = JSON.parse(text) }
  catch { const start = text.indexOf('{'), end = text.lastIndexOf('}'); if (start < 0 || end <= start) throw new Error('模型未返回口播 JSON'); try { value = JSON.parse(text.slice(start, end + 1)) } catch { throw new Error('模型口播 JSON 格式无效') } }
  if (!value || typeof value.speech !== 'string' || !hasSpeechContent(value.speech)) throw new Error('模型未返回可播报文字')
  const interaction = value.interaction
  if (interaction != null && (!interaction || !['question', 'like', 'share'].includes(interaction.type) || typeof interaction.speech !== 'string' || !interaction.speech.trim() || interaction.speech.length > 120)) throw new Error('互动引导格式无效')
  if(value.appliedRequestIds!==undefined&&(!Array.isArray(value.appliedRequestIds)||value.appliedRequestIds.length>12||value.appliedRequestIds.some(id=>typeof id!=='string'||!id||id.length>200)))throw new Error('观众请求引用格式无效')
  if(value.answeredIds!==undefined&&(!Array.isArray(value.answeredIds)||value.answeredIds.length>COMMENT_WINDOW_LIMIT||value.answeredIds.some(id=>typeof id!=='string'||!id||id.length>200)))throw new Error('弹幕回应引用格式无效')
  return {appliedRequestIds:value.speech.length<=600?(value.appliedRequestIds||[]):[],answeredIds:value.answeredIds, text: clipped(value.speech, 600), navigation: value.navigation === 'next' ? 'next' : 'stay', selectedId: value.selectedId == null ? null : String(value.selectedId), ...(interaction ? { interaction: { type: interaction.type, text: interaction.speech.trim() } } : {}) }
}

/** Select page-specific supplemental notes while retaining a bounded global introduction. */
export function notesForPage(source,pageNumber){
  const text=String(source||''),sections=[...text.matchAll(/^#{1,6}[ \t]+(?:幻灯片[ \t]*(\d+)|第[ \t]*(\d+)[ \t]*页)(?:[：:][^\n]*)?[ \t]*$/gm)]
  if(!sections.length)return text.slice(0,4000)
  const index=sections.findIndex(item=>Number(item[1]||item[2])===pageNumber)
  const introduction=text.slice(0,sections[0].index).trim().slice(0,1200)
  if(index<0)return introduction
  const section=text.slice(sections[index].index+sections[index][0].length,sections[index+1]?.index??text.length).trim().slice(0,4000)
  return [introduction,section].filter(Boolean).join('\n\n')
}

export class LiveDirector {
  constructor({ store, media, providers, events, dataDir, onRecord=()=>{} }) {
    this.store = store; this.media = media; this.providers = providers; this.events = events
    this.onRecord=onRecord
    this.dataDir = resolve(dataDir); mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    this.file = join(this.dataDir, 'director-history.json'); this.log = join(this.dataDir, 'broadcast-events.ndjson')
    this.record = { version: 1, cycle: 1, recoveries: 0, sale: null, saleClaims: [], lottery: null, lotteryHistory: [], triggerClaims: [], lastStop: '', sessions: [] }
    try { this.record = { ...this.record, ...JSON.parse(readFileSync(this.file, 'utf8')) } } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (this.record.version !== 1 || !Array.isArray(this.record.saleClaims) || !Array.isArray(this.record.lotteryHistory) || !Array.isArray(this.record.triggerClaims)) throw new Error('直播历史格式无效')
    if (this.record.lottery && !['completed', 'cancelled'].includes(this.record.lottery.state)) { this.record.lottery.state = 'cancelled'; this.record.lottery.reason = '服务重启，旧参与窗口已取消，历史奖品保留' }
    if (this.record.sale?.state === 'queued') this.record.sale.state = 'cancelled'
    this.running = false; this.paused = false; this.wanted = false; this.phase = 'stopped'; this.stage = 'idle'; this.since = Date.now(); this.reason = '等待开播'; this.error = ''
    this.productionQueue=[];this.queueProducer=null;this.queueRevision=0;this.epoch = 0; this.loopPromise = null; this.controller = null; this.prepared = null; this.currentSpeech = null
    this.opening = false; this.closing = false; this.manualOnly = false; this.manualQueue = []; this.pendingInteraction = null; this.pendingNavigation = false
    this.conversation=new Conversation();this.comments = []; this.seen = new Set(); this.serial = 0; this.reviewed = 0; this.commentRetryAt = 0
    this.page = { pageNumber: 0, pageCount: 0, pageKey: '', title: '', text: '', notes: '' }; this.memory = { pageKey: '', turns: 0, notes: [], outline: [] }
    this.sourceSinceComment = 0; this.sourceSinceInteraction = 0; this.lastCommentAt = Date.now(); this.lastInteractionAt = Date.now(); this.lastAudioAt = Date.now(); this.startedAt = null
    this.metrics = {}; this.platformMetrics = {}; this.snapshots = []; this.history = []; this.demo = false; this.recovering = false; this.lastCompletedText = ''
    this.programCursor=0;this.pendingLotteryComment=null;this.scheduleStartedAt=null
    this._persist()
    this.supervisor = setInterval(() => this._supervise(), 1000); this.supervisor.unref?.()
  }

  _persist() { writeFileSync(this.file + '.tmp', JSON.stringify(this.record, null, 2) + '\n', { mode: 0o600 }); renameSync(this.file + '.tmp', this.file) }
  _log(type, payload) { appendFileSync(this.log, JSON.stringify({ at: Date.now(), sessionId: this.sessionId || null, type, ...payload }) + '\n', { mode: 0o600 });this.onRecord(type,payload) }
  _transition(stage, reason, phase = this.phase) {
    if (this.stage !== stage) { this.history.push({ from: this.stage, to: stage, at: Date.now(), reason }); this.history = this.history.slice(-30); this.since = Date.now() }
    this.stage = stage; this.phase = phase; this.reason = reason; this._publish()
  }
  _publish() { this.events.publish('director', this.status()) }
  _freshComments() { const cutoff = Date.now() - 120000; return this.comments.filter(item => !item.respondedAt && item.at >= cutoff && !item.lotteryId&&!item.resolvedInSource).slice(-100) }
  _commentWindow(){return commentWindow(this.comments)}
  _commentDue(fresh,{ahead=0,navigating=this.pendingNavigation}={}){const frequency=Number(this.store.get().live?.commentFrequency??50),quota=commentGap(frequency);return Date.now()>=(this.commentRetryAt||0)&&frequency>0&&fresh.length>0&&(this.sourceSinceComment+ahead>=1&&(this.sourceSinceComment+ahead>=quota||this.conversation.pending(fresh.map(row=>row.id)).length>0||Date.now()-this.lastCommentAt>=90000-frequency*650)||!this._enabled('source'))}
  _deferCommentReply(error) {
    this.commentRetryAt = Date.now() + COMMENT_REPLY_RETRY_MS
    this._log('comment-reply-skipped', { reason: this.providers.redact?.(error) || String(error.message || error) })
    return null
  }
  _skipRejectedSpeech(turn, error) {
    if (!GENERATED_SPEECH.has(turn.kind)) throw error
    if (turn.kind === 'comment') this._deferCommentReply(error)
    else {
      this.rejectedSpeechTurns = (this.rejectedSpeechTurns || 0) + 1
      if (this.rejectedSpeechTurns > 2) throw error
      if (turn.kind === 'engagement') {
        this.pendingInteraction = null
        this.lastInteractionAt = Date.now()
      }
      this._log('speech-text-skipped', { kind: turn.kind, reason: this.providers.redact?.(error) || error.message })
    }
    turn.speechRejected = true
    this.currentSpeech = null
    this._dropPrepared()
  }
  _nextInterlude({ahead=0,interaction=this.pendingInteraction,navigating=this.pendingNavigation}={}){
    const program=programOf(this.store.get()),fresh=this._freshComments(),choices=[]
    for(const kind of program.order){
      if(!program.enabled[kind])continue
      if(kind==='comment'&&this._commentDue(fresh,{ahead,navigating}))choices.push({kind,candidates:this._commentWindow(),programKind:kind})
      if(kind==='engagement'&&(interaction||this._interactionDue(ahead)))choices.push({kind,...(interaction?{text:interaction.text}:{}),programKind:kind})
      if(kind==='lottery'&&this.record.lottery?.state==='queued')choices.push({kind:'lottery-announcement',programKind:kind})
    }
    if(choices.length>1){const last=this.conversation.turns.findLast(t=>['comment','engagement'].includes(t.kind));return choices.find(choice=>choice.kind!==last?.kind)||choices[0]}
    return choices[0]||null
  }
  _dropPrepared() { this.queueRevision++;this.queueProducer?.abort(abortError());this.queueProducer=null;for(const entry of this.productionQueue)entry.controller.abort(abortError());this.productionQueue=[];this.prepared=null }
  _saleActive() { return this.record.sale?.state === 'displaying' && this.record.sale.expiresAt > Date.now() }
  _lotteryActive() { return this.record.lottery && !['completed', 'cancelled'].includes(this.record.lottery.state) }
  _prizeCount() { return this.record.lotteryHistory.filter(item => item.winner).length }
  _enabled(kind){return programOf(this.store.get()).enabled[kind]===true}
  _interactionDue(ahead=0){const c=this.store.get();return this._enabled('engagement')&&(this.sourceSinceInteraction+ahead>=(c.live?.engagementMinTurns??3)||!this._enabled('source'))&&Date.now()-this.lastInteractionAt>=(c.live?.engagementCooldownSeconds??90)*1000}
  _freshMetrics() {
    const fresh=source=>{const fields={},provenance={};for(const [key,entry]of Object.entries(source.provenance||{}))if(Date.now()-entry.at<=30000){fields[key]=source[key];provenance[key]=entry}return Object.keys(fields).length?{...fields,provenance,at:source.at,source:source.source,available:true}:{available:false}}
    const result=fresh(this.metrics),platforms=Object.values(this.platformMetrics).map(source=>({...fresh(source),connectionId:source.connectionId,platform:source.platform,platformName:source.platformName,connectionName:source.connectionName})).filter(value=>value.available)
    return platforms.length?{...result,available:true,platforms}:result
  }
  removePlatformMetrics(id){delete this.platformMetrics[id]}
  _savePage(page) {
    const key = page.pageKey || `${page.pageNumber}:${page.title}`
    if (this.memory.pageKey !== key) { this.memory = { pageKey: key, turns: 0, notes: [], outline: [] }; this.pendingInteraction = null }
    this.page = { ...page, pageKey: key }
  }

  status() {
    const config = this.store.get(), sale = this.record.sale
    return {
      running: this.running, paused: this.paused, wanted: this.wanted, phase: this.phase, stage: this.stage, stageLabel: LABELS[this.stage] || this.stage, since: this.since, reason: this.reason, error: this.error,
      page: { pageNumber: this.page.pageNumber, pageCount: this.page.pageCount, pageKey: this.page.pageKey, title: this.page.title, turns: this.memory.turns,minimumTurns:minimumPageTurns(config) }, cycle: this.record.cycle,
      currentSpeech: this.currentSpeech ? { id: this.currentSpeech.id, text: this.currentSpeech.text, kind: this.currentSpeech.kind,pageNumber:this.currentSpeech.projection?.page?.pageNumber,paragraphNumber:this.currentSpeech.kind==='source'?(this.currentSpeech.projection?.memory?.turns||0)+1:null, startedAt: this.currentSpeech.startedAt,voice:this.currentSpeech.voice||null,audio:this.currentSpeech.audioProgress?{ready:this.currentSpeech.audioProgress.ready,total:this.currentSpeech.audioProgress.total,playing:this.currentSpeech.audioProgress.playing,completed:this.currentSpeech.audioProgress.completed}:null } : null,
      continuity:{revision:this.conversation.revision,rememberedTurns:this.conversation.turns.length,pendingRequests:this.conversation.outstanding().length,followThroughRequests:this.conversation.outstanding().filter(row=>row.followThrough).length},
      production:{capacity:3,working:Boolean(this.queueProducer),ready:this.productionQueue.filter(entry=>entry.phase==='ready'&&!entry.turn?.audioProgress?.error).length,pending:this.productionQueue.filter(entry=>entry.phase==='generating').length,items:this.productionQueue.map(entry=>({kind:entry.kind,pageNumber:entry.page?.pageNumber,paragraphNumber:entry.paragraphNumber,phase:entry.phase,audioReady:entry.turn?.audioProgress?.ready||entry.turn?.audioReady||0,audioTotal:entry.turn?.audioProgress?.total||entry.turn?.audioTotal||0,error:entry.turn?.audioProgress?.error||entry.error||''}))},
      preparation: this.prepared ? { kind: this.prepared.kind, phase: this.prepared.phase, error: this.prepared.error || '' } : null,
      sale: { active: this._saleActive(), queued: sale?.state === 'queued', current: sale ? clone(sale) : null, remainingSeconds: this._saleActive() ? Math.ceil((sale.expiresAt - Date.now()) / 1000) : 0, durationSeconds: config.sale?.durationSeconds || 300, intervalMinutes: config.sale?.intervalMinutes || 60, nextAt: this._nextSaleAt(), timezone: 'Asia/Shanghai' },
      lottery: { current: this.record.lottery ? clone(this.record.lottery) : null, drawsUsed: this._prizeCount(), prizesTotal: config.lottery?.prizes?.length || 0, history: this.record.lotteryHistory.slice(-30) },
      comments: { unread: this._freshComments().length, buffered: this.comments.length, limit: 100, recent: this.comments.slice(-8) }, metrics: clone({...this.metrics,...(Object.keys(this.platformMetrics).length?{platforms:this.platformMetrics}:{})}), history: this.history.slice(), model: this.providers.status?.() || {},
      startedAt: this.startedAt, lastAudioAt: this.lastAudioAt, silentSeconds: Math.floor((Date.now() - this.lastAudioAt) / 1000), recoveries: this.record.recoveries, demo: this.demo,
    }
  }

  programState() {
    const sale = this.record.sale, config = this.store.get()
    return { avatarState: this.currentSpeech ? this.stage === 'opening' ? 'greeting' : this.stage === 'comment' || this.stage === 'question' ? 'happy' : 'explain' : this.phase === 'generating' ? 'thinking' : 'rest', speaking: Boolean(this.currentSpeech && !this.paused), caption: this.currentSpeech?.text || '', sale: this._saleActive() ? { active: true, id: sale.id, expiresAt: sale.expiresAt, serverAt: Date.now(), link: config.sale.link, qrUrl: config.sale.qrUrl } : { active: false }, demo: this.demo }
  }

  async start() { return this._begin(false) }
  beginBroadcast(){
    this.conversation.reset();this._dropPrepared();this.comments=[];this.seen.clear();this.reviewed=this.serial;this.commentRetryAt=0;this.metrics={};this.platformMetrics={};this.snapshots=[];this.pendingLotteryComment=null;this.scheduleStartedAt=Date.now();this._publish()
  }
  async _begin(manualOnly, { recovery = false, closing = false } = {}) {
    if (this.running) return this.status()
    const version = ++this.epoch
    this.running = true; this.wanted = !manualOnly; this.paused = false; this.manualOnly = manualOnly; this.error = ''; this.opening = !manualOnly && !recovery && programOf(this.store.get()).opening; this.closing = closing
    if(!recovery){this.programCursor=0;this.scheduleStartedAt=Date.now();if(!this._enabled('source'))this.lastInteractionAt=0}
    this.demo = this.providers.status?.().demo === true
    this.startedAt ||= Date.now(); this.lastAudioAt = Date.now(); this.sessionId ||= randomUUID()
    this._transition('idle', '正在准备后台渲染与音频', 'initializing')
    try {
      await this.media.initialize()
      if (version !== this.epoch) return this.status()
      const config = this.store.get()
      if (config.presentation?.url && !recovery) await this.media.openPresentation(config.presentation.url)
      if (version !== this.epoch) return this.status()
      this._savePage(await this.media.readSlide())
      if (!recovery) { this.record.sessions.push({ id: this.sessionId, startedAt: this.startedAt, demo: this.demo }); this.record.sessions = this.record.sessions.slice(-100); this._persist(); this._log('start', { demo: this.demo }) }
      this.loopPromise = this._loop(version)
    } catch (error) { if (version === this.epoch) this._failed(error) }
    return this.status()
  }

  pause() {
    if (!this.running) throw new Error('请先开始讲解再暂停')
    if (!this.paused) { this.paused = true; this.pausedAt = Date.now(); this.media.pauseAudio(); this._dropPrepared(); this._log('pause', {}); this._publish() }
    return this.status()
  }
  resume() {
    if (!this.running) throw new Error('讲解已停止，请重新开始')
    if (this.paused) {
      const elapsed = Date.now() - this.pausedAt
      this.paused = false; this.lastAudioAt = Date.now(); this.media.resumeAudio()
      if (this.record.lottery?.state === 'waiting') { this.record.lottery.deadlineAt += elapsed; this._persist() }
      this._log('resume', {}); this._publish()
    }
    return this.status()
  }
  stop(reason = '场控停止讲解') {
    this.epoch++; this.running = false; this.wanted = false; this.paused = false; this.controller?.abort(abortError()); this.controller = null; this._dropPrepared(); this.media.stopAudio()
    this.currentSpeech = null;this.manualSourcePending=false; this.opening = false; this.closing = false; this.manualQueue = []; this.pendingInteraction = null; this.pendingNavigation = false
    if (this._lotteryActive()) { this.record.lottery.state = 'cancelled'; this.record.lottery.reason = reason }
    if (this.record.sale && ['queued', 'displaying'].includes(this.record.sale.state)) this.record.sale.state = 'cancelled'
    this.record.lastStop = reason; this._persist(); this._log('stop', { reason }); this._transition('ended', reason, 'stopped')
    return this.status()
  }
  async restart() {
    this.stop('从头开播，保留奖品与活动触发历史'); this.record.cycle++; this._persist()
    this.conversation.reset();this.comments = []; this.reviewed = this.serial; this.commentRetryAt = 0; this.memory = { pageKey: '', turns: 0, notes: [], outline: [] }; this.sourceSinceComment = 0; this.sourceSinceInteraction = 0
    this.startedAt = null; this.sessionId = null
    await this.media.initialize(); await this.media.firstSlide()
    return this._begin(false)
  }
  finish() {
    if (!this.running) return this.status()
    if (this.paused) throw new Error('请先继续讲解，再结束并告别')
    this.closing = true; this._dropPrepared(); this.pendingInteraction = null; this.pendingNavigation = false; this.manualQueue = []
    if (!this.currentSpeech) this.controller?.abort(abortError())
    this._publish(); return this.status()
  }

  async playRecording({text,path}) {
    if(typeof text!=='string'||!text.trim()||text.length>4000||typeof path!=='string'||!path)throw new Error('固定录音与对应逐字稿不能为空')
    if(this.manualQueue.length>=20)throw new Error('固定口播队列已满，请等待当前口播播完')
    this.manualQueue.push({kind:'cue',text:text.trim(),audio:path});this._dropPrepared()
    if(!this.running)return this._begin(true)
    this._publish();return this.status()
  }
  async say(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('固定口播应为1–4000字')
    this.manualQueue.push({ kind: 'cue', text: text.trim() }); this._dropPrepared()
    if (!this.running) return this._begin(true)
    this._publish(); return this.status()
  }
  async ask(text,{interrupt=false}={}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('对话内容应为1–4000字')
    const requestId='host:'+randomUUID();this.conversation.acceptHost(requestId,text.trim());
    this.manualQueue.unshift({kind:'question',question:text.trim(),audienceIds:[requestId],interrupt:Boolean(interrupt)});this._dropPrepared()
    if(this.running){
      if(interrupt){
        if((this.currentSpeech?.kind||this.stage)==='lottery-announcement'&&this.record.lottery?.state==='announcing'){this.record.lottery.state='queued';this._persist()}
        this.controller?.abort(abortError());this.media.stopAudio();this.currentSpeech=null
      }
      this._publish();return this.status()
    }
    return this._begin(true)
  }

  queueSale(options = {}) {
    if(!this._enabled('sale'))throw new Error('本场未启用秒杀环节，请在节目编排中启用')
    if (!this.running || this.paused || this.closing) throw new Error('请先开始或继续讲解，再安排秒杀')
    if (this._saleActive() || this.record.sale?.state === 'queued') throw new Error('秒杀已排队或正在展示')
    const config = this.store.get().sale || {}, duration = Number(config.durationSeconds || 300)
    if (!Number.isInteger(duration) || duration < 60 || duration > 1800) throw new Error('秒杀展示时间应为1–30分钟')
    if (!config.link || !config.qrUrl) throw new Error('请先配置秒杀链接与二维码')
    if (options.claim && this.record.saleClaims.includes(options.claim)) return this.status()
    if (options.claim) { this.record.saleClaims.push(options.claim); this.record.saleClaims = this.record.saleClaims.slice(-10000) }
    this.record.sale = { id: randomUUID(), state: 'queued', queuedAt: Date.now(), reason: options.reason || '场控安排', automatic: Boolean(options.claim), durationSeconds: duration, startedAt: null, expiresAt: null }
    this._persist(); this._dropPrepared(); this._publish(); return this.status()
  }
  hideSale() {
    if (this.record.sale) { this.record.sale.state = 'cancelled'; this._persist(); this._publish() }
    return this.status()
  }
  queueLottery(options = {}) {
    if(!this._enabled('lottery'))throw new Error('本场未启用抽奖环节，请在节目编排中启用')
    if (!this.running || this.paused || this.closing) throw new Error('请先开始或继续讲解，再安排抽奖')
    if (this._lotteryActive()) throw new Error('抽奖已排队或正在进行')
    const cfg = this.store.get().lottery || {}, prizes = cfg.prizes || [], index = this._prizeCount()
    const keyword = String(options.keyword || cfg.keyword || '').trim(), waitSeconds = Number(options.waitSeconds || cfg.waitSeconds || 10), prize = prizes[index]
    if (!keyword || keyword.length > 100 || !Number.isInteger(waitSeconds) || waitSeconds < 5 || waitSeconds > 120) throw new Error('请设置有效抽奖口令与5–120秒参与时间')
    if (!prize) throw new Error('奖品池为空或奖品已发完，请补充奖品')
    this.record.lottery = { id: randomUUID(), state: 'queued', keyword, waitSeconds, prize: String(prize).slice(0, 200), queuedAt: Date.now(), reason: options.reason || '场控安排', automatic:options.automatic===true, winner: null }
    this._persist(); this._dropPrepared(); this._publish(); return this.status()
  }

  addComments(items) {
    if (!Array.isArray(items)) throw new Error('弹幕必须是列表')
    const incoming=[]
    for (const item of items.slice(-1000)) {
      if (!item || typeof item.content !== 'string' || !item.content.trim()) continue
      const connection=item.connectionId?(this.store.get().platforms||[]).find(c=>c.id===item.connectionId):null
      if(item.connectionId&&!connection)continue
      const rawId=String(item.id||item.msgId||randomUUID()),id=(connection?connection.id+':':'')+rawId.slice(0,connection?130:160)
      if (this.seen.has(id)) continue
      this.seen.add(id); this.serial++
      const row = { id, serial: this.serial, nickname: String(item.nickname || item.user || '观众').slice(0, 100), content: item.content.trim().slice(0, 500), at: Number.isFinite(item.at) ? Math.min(Date.now(), item.at) : Date.now(),...(connection?{connectionId:connection.id,platform:connection.platform,platformName:platformInfo(connection.platform).name,connectionName:connection.name,userId:String(item.userId||'').slice(0,120)}:{}) }
      const draw=this.record.lottery
      if(draw?.state==='waiting'&&row.serial>draw.startSerial&&row.at>=draw.startedAt&&row.at<=draw.deadlineAt&&row.content===draw.keyword){row.lotteryId=draw.id;if(!draw.candidate){draw.candidate=winnerFromComment(row);this._persist()}}
      this.comments.push(row);incoming.push(row);this._log('comment', row)
      const lottery=this.store.get().lottery||{}
      if(lottery.enabled&&this._enabled('lottery')&&lotteryTriggersOf(lottery).includes('comment')&&!this._lotteryActive()&&row.content===(lottery.commentTriggerKeyword||'抽奖').trim())this.pendingLotteryComment=row
    }
    this.comments = this.comments.slice(-100)
    const changed=this.conversation.acceptComments(incoming)
    if(changed||incoming.length&&this._enabled('comment')&&this._commentDue(this._freshComments(),{ahead:this.currentSpeech?.kind==='source'?1:0,navigating:this.pendingNavigation||this.currentSpeech?.navigation==='next'})){this._dropPrepared();if(this.currentSpeech&&this.running&&!this.paused)this._prepare(this.currentSpeech,this.epoch)}
    if (this.seen.size > 5000) this.seen = new Set(this.comments.map(row => row.id))
    this._publish(); return this.status()
  }
  ingestMetrics(value) {
    if (!value || typeof value !== 'object') throw new Error('指标数据应为对象')
    const source=value.fields||value,fields={},provenance={}
    for (const key of ['onlineUsers','peakOnlineUsers','heat','likes','totalViews','totalViewers','views','newFollowers','shares','groupJoins','followers','comments','giftCoins','durationSeconds','startedAtMs','endedAtMs']) {
      const number = typeof source[key] === 'object' && source[key] !== null ? source[key].value : source[key]
      if(Number.isFinite(number)&&number>=0){fields[key]=number;const entry=source[key]&&typeof source[key]==='object'?source[key]:{};provenance[key]={raw:String(entry.raw??number).slice(0,80),source:String(entry.source||value.source||'ingest').slice(0,80),path:String(entry.path||key).slice(0,160),approximate:entry.approximate===true,at:Number.isFinite(entry.at)?Math.min(Date.now(),entry.at):Date.now()}}
    }
    if (!Object.keys(fields).length) return this.status()
    const connection=value.connectionId?(this.store.get().platforms||[]).find(c=>c.id===value.connectionId):null
    if(value.connectionId&&!connection)throw new Error('指标来源平台连接不存在')
    const metadata=connection?{connectionId:connection.id,platform:connection.platform,platformName:platformInfo(connection.platform).name,connectionName:connection.name}:{}
    const previous=connection?this.platformMetrics[connection.id]||{}:this.metrics
    const next={...previous,...fields,...metadata,provenance:{...(previous.provenance||{}),...provenance},at:Date.now(),source:String(value.source||'ingest').slice(0,80)}
    if(connection)this.platformMetrics[connection.id]=next;else this.metrics=next
    const row = { at: Date.now(), ...metadata,...fields,provenance, pageNumber: this.page.pageNumber, stage: this.stage }
    this.snapshots.push(row); this.snapshots = this.snapshots.slice(-50000); this._log('metrics', row); this._publish()
    return this.status()
  }
  settingsChanged(){
    this._dropPrepared();this.programCursor=0;this.pendingLotteryComment=null
    if(!this._enabled('engagement'))this.pendingInteraction=null
    if(!this._enabled('lottery')&&this._lotteryActive()){this.record.lottery.state='cancelled';this.record.lottery.reason='节目编排已关闭抽奖';this._persist()}
    if(!this._enabled('sale')&&this.record.sale&&!['completed','cancelled'].includes(this.record.sale.state)){this.record.sale.state='cancelled';this._persist()}
    this._publish();return this.status()
  }
  /** Switch the picture now; let the currently audible whole turn finish. */
  navigatePresentation(direction) {
    if(!['next','prev','first'].includes(direction))throw new Error('翻页方向无效')
    this.manualNavigating=(this.manualNavigating||0)+1
    this._dropPrepared()
    if(!this.currentSpeech)this.controller?.abort(abortError())
    const task=(this.manualNavigationTail||Promise.resolve()).catch(()=>{}).then(async()=>{
      try{
        if(direction==='next')await this.media.nextSlide();else if(direction==='prev')await this.media.previousSlide();else await this.media.firstSlide()
        await this.refreshPresentation()
        this.manualRevision=(this.manualRevision||0)+1
        this.memory={pageKey:this.page.pageKey,turns:0,notes:[],outline:[]};this.pendingNavigation=false;this.pendingInteraction=null;this.opening=false;this.manualSourcePending=this.running
        this._publish();return this.status()
      }finally{
        this.manualNavigating--
        if(!this.manualNavigating&&this.currentSpeech&&this.manualSourcePending)this._prepare(this.currentSpeech,this.epoch)
      }
    })
    this.manualNavigationTail=task;return task
  }
  async refreshPresentation() {
    const next=await this.media.readSlide()
    if(next.pageKey&&(next.pageKey!==this.page.pageKey||next.text!==this.page.text||next.notes!==this.page.notes)){this._dropPrepared();this.pendingNavigation=false;this._savePage(next);this._publish()}
    return this.status()
  }
  audioProgress(meter) { if (this.running && !this.paused && this.currentSpeech && Number(meter?.voiceRms) > .0001) this.lastAudioAt = Date.now() }

  async _loop(version) {
    try {
      while (this.running && version === this.epoch) {
        if (this.paused) { await sleep(100); continue }
        const controller = new AbortController(); this.controller = controller
        try {
          if(this.store.get().presentation?.url)await this.refreshPresentation()
          aborted(controller.signal)
          const choice = this._choose()
          if (choice.kind === 'wait') {if(this.phase!=='waiting')this._transition('idle','等待已启用环节的弹幕、活动或互动时间','waiting');await sleep(choice.ms || 200, controller.signal); continue }
          if (choice.kind === 'ended') { this.stop(this.demo ? '演示试听结束，请配置模型与语音服务后持续开播' : '本次口播已完成'); break }
          if (choice.kind === 'advancing') { await this._advance(controller.signal); continue }
          const turn = await this._turn(choice, controller.signal, version)
          aborted(controller.signal)
          if (this.paused) { while (this.paused && this.running && version === this.epoch) await sleep(100, controller.signal) }
          if (!this.running || version !== this.epoch) break
          await this._speak(turn, controller.signal, version)
          if (!this.running || version !== this.epoch) break
          this._aired(turn)
        } catch (error) {
          if (version !== this.epoch || !this.running) break
          if(controller.signal.aborted)continue
          if(error.code==='STALE_CONVERSATION'){controller.abort(error);continue}
          throw error
        } finally { if (this.controller === controller) this.controller = null }
      }
    } catch (error) { if (version === this.epoch) this._failed(error) }
  }

  _choose() {
    if(this.manualNavigating)return {kind:'wait',ms:25}
    if(this.manualQueue[0]?.interrupt)return this.manualQueue.shift()
    const program=programOf(this.store.get())
    if(this.closing)return {kind:program.closing?'closing':'ended'}
    if(program.enabled.sale&&this.record.sale?.state==='queued')return {kind:'sale',programKind:'sale'}
    if(this.manualSourcePending&&this._enabled('source'))return {kind:'source',programKind:'source'}
    if(this.opening&&program.opening)return {kind:'opening'}
    this.opening=false
    const draw=this.record.lottery
    if(program.enabled.lottery&&this._lotteryActive()){
      if(draw.state==='queued'&&!draw.automatic)return {kind:'lottery-announcement'}
      if(draw.state==='waiting'){
        if(Date.now()>=draw.deadlineAt){this._settleLottery();return {kind:'lottery-result',programKind:draw.programKind}}
        if(!draw.interactionDone)return {kind:'lottery-wait'}
        return {kind:'wait',ms:Math.min(1000,draw.deadlineAt-Date.now())}
      }
      if(draw.state==='result')return {kind:'lottery-result',programKind:draw.programKind}
    }
    if(this.manualQueue.length)return this.manualQueue.shift()
    if(this.manualOnly||this.demo&&!this.providers.status?.().modelConfigured)return {kind:'ended'}
    if(program.enabled.source){
      const last=this.conversation.turns.at(-1)?.kind,resume=['comment','engagement','question'].includes(last)
      if(!resume||this.memory.finished&&!this.pendingNavigation){
        const interlude=this._nextInterlude();if(interlude)return interlude
        if(program.enabled.lottery&&draw?.state==='queued')return {kind:'lottery-announcement',programKind:'lottery'}
      }
      if(this.pendingNavigation)return {kind:'advancing'}
      if(!this.memory.finished)return {kind:'source',programKind:'source'}
      return {kind:'wait',ms:250}
    }
    const frequency=Number(this.store.get().live?.commentFrequency??50)
    const fresh=this._freshComments(),due=this._commentDue(fresh)
    for(let offset=0;offset<program.order.length;offset++){
      const index=(this.programCursor+offset)%program.order.length,kind=program.order[index]
      if(!program.enabled[kind])continue
      if(kind==='comment'&&frequency>0&&due)return {kind,candidates:this._commentWindow(),programKind:kind}
      if(kind==='engagement'&&(this.pendingInteraction||this._interactionDue()))return {kind,...(this.pendingInteraction?{text:this.pendingInteraction.text}:{}),programKind:kind}
      if(kind==='lottery'&&draw?.state==='queued')return {kind:'lottery-announcement',programKind:kind}
      if(kind==='sale'&&this.record.sale?.state==='queued')return {kind,programKind:kind}
      if(kind==='source'&&!this.pendingNavigation&&!this.memory.finished)return {kind,programKind:kind}
    }
    if(this.pendingNavigation)return {kind:'advancing'}
    return {kind:'wait',ms:250}
  }

  _messages(kind, { candidates = [], question = '', after = '',context } = {}) {
    const c = this.store.get(), page = context?.page||this.page, pool = this.record.lotteryHistory.filter(item => item.winner)
    const candidatesCopy=modelComments(candidates),refs=commentReferences(candidates,candidatesCopy),conversation=this.conversation.context()
    if(kind==='comment')conversation.audienceRequests=conversation.audienceRequests.filter(row=>candidatesCopy.some(c=>c.canReply&&refs.get(c.id)?.id===row.id)).map(row=>({...row,id:candidatesCopy.find(c=>refs.get(c.id)?.id===row.id).id}))
    const system=modelSystemPrompt(c,kind)
    const interactionAllowed = this._interactionDue()
    const payload = projectStageContext(kind,{
      stage:kind,...(kind==='source'?{pageProgress:pageProgress(c,context?.memory||this.memory,page.pageKey===this.page.pageKey?this.memory.turns:0)}:{}),conversation:{...conversation,currentTransition:context?.bridge?clone(context.bridge):null,previousStage:context?.previousKind||this.conversation.turns.at(-1)?.kind||null,plannedRequestIds:context?.plannedRequestIds||[]},page: { number: page.pageNumber, total: page.pageCount, title: page.title, text: String(page.text || '').slice(0, 6000), notes: [String(page.notes||'').slice(0,4000),notesForPage(c.presentation?.notes,page.pageNumber)].filter(Boolean).join('\n\n') },
      aired: page.pageKey===this.page.pageKey?{turns:this.memory.turns,outline:[...this.memory.outline],recent:[...this.memory.notes]}:{turns:0,outline:[],recent:[]},...(context?{planned:{turns:context.memory.turns,outline:[...context.memory.outline],recent:[...context.memory.notes]}}:{}), question, candidates: candidatesCopy,
      metrics: this._freshMetrics(), sale: { enabled:Boolean(c.sale?.enabled&&this._enabled('sale')),nextAt:this._nextSaleAt(),serverAt:Date.now(),active: this._saleActive(), remainingSeconds: this._saleActive() ? Math.ceil((this.record.sale.expiresAt - Date.now()) / 1000) : 0, link: c.sale?.link, qrPosition: '屏幕右上角', durationSeconds: c.sale?.durationSeconds || 300 },
      lottery: { awarded: pool.length, prizesTotal: c.lottery?.prizes?.length || 0, recentWinners: pool.slice(-3).map(item => ({ nickname: item.winner.nickname,platformName:item.winner.platformName||'',prize: item.prize })) },
      interactionAllowed: kind === 'source' && interactionAllowed, pageEnd: page.pageCount > 0 && page.pageNumber === page.pageCount, loopEnabled: c.presentation?.loop !== false,
      onAir:{pageNumber:this.page.pageNumber,current:this.currentSpeech?{id:this.currentSpeech.id,kind:this.currentSpeech.kind,text:this.currentSpeech.text.slice(-420)}:null,lastCompletedText:this.conversation.turns.findLast(turn=>turn.kind==='source')?.text.slice(-420)||''},
      ...(this.currentSpeech?{currentlyPlaying:this.currentSpeech.text.slice(-420)}:{}),
      ...(after ? { plannedPredecessor:after,note:'plannedPredecessor 是尚未确认播完的前序计划；onAir 才是此刻正在播的内容，recentTurns 才是实际播出历史。' } : {}),
    })
    // Keep new requests and the last spoken point even in a busy room with a large saved persona.
    const bytes=()=>Buffer.byteLength(JSON.stringify([{role:'system',content:system},{role:'user',content:JSON.stringify(payload)}]))
    const arrays=[payload.conversation.recentTurns,payload.planned?.recent,payload.planned?.outline,payload.aired.recent,payload.aired.outline,payload.conversation.recentlyApplied,payload.conversation.audienceRequests,payload.conversation.activePreferences,payload.conversation.currentTransition?.audienceComments].filter(Array.isArray)
    for(const rows of arrays)while(bytes()>114000&&rows.length>1)rows.shift()
    const texts=[[payload.page,'notes'],[payload.page,'text'],[payload,'currentlyPlaying'],[payload,'plannedPredecessor'],[payload,'question'],[payload.onAir?.current,'text'],[payload.onAir,'lastCompletedText'],[payload.conversation.currentTransition,'text'],[payload.conversation.currentTransition,'question']]
    for(const turn of payload.conversation.recentTurns)texts.push([turn,'text'],[turn,'question'])
    for(const turn of [payload.conversation.lastSource,payload.conversation.lastInteraction])if(turn)texts.push([turn,'text'])
    for(const [object,key] of texts)if(object&&typeof object[key]==='string')while(bytes()>114000&&object[key].length>200)object[key]=object[key].slice(0,Math.max(200,Math.floor(object[key].length/2)))
    if(kind==='comment')fitCommentText(payload.candidates,()=>bytes()>114000)
    return [{role:'system',content:system},{role:'user',content:JSON.stringify(payload)}]
  }

  async _turn(choice, signal, version, { preparing = false, after = '',context } = {}) {
    const kind=choice.kind,config=this.store.get(),contextRevision=this.conversation.revision
    let turn = { ...choice, navigationRevision:this.manualRevision||0, id: randomUUID(), pageKey:(context?.page||this.page).pageKey,projection:context||{page:clone(this.page),memory:clone(this.memory),bridge:null},navigation: 'stay', cutoff: this.reviewed }
    if (!preparing && this.prepared) {
      const ready = this.prepared
      if (['source','comment','engagement'].includes(kind)&&ready.kind===kind&&ready.contextRevision===this.conversation.revision && ready.pageKey === this.page.pageKey && ready.page.text===this.page.text && ready.page.notes===this.page.notes && ready.parent === this.lastAiredId&&!ready.turn?.audioProgress?.error) {
        const cancelPrepared=()=>ready.controller.abort(signal.reason||abortError())
        signal.addEventListener('abort',cancelPrepared,{once:true})
        try { return {...await cancellable(ready.promise,signal),programKind:choice.programKind,productionController:ready.controller} }
        catch (error) {
          aborted(signal)
          if (kind === 'comment' && error.code === 'MODEL_OUTPUT_REJECTED') return this._deferCommentReply(error)
          // Transient failures in a prepared turn can retry on the live turn.
        }
        finally {signal.removeEventListener('abort',cancelPrepared);if(this.productionQueue[0]===ready)this.productionQueue.shift();this.prepared=this.productionQueue[0]||null}
      } else this._dropPrepared()
    }
    if (!preparing) this._transition(kind, '正在生成本轮口播', 'generating')
    if (kind === 'opening') turn.text = this.demo ? config.tts?.demoText : config.identity?.welcome
    else if (kind === 'closing') turn.text = config.identity?.goodbye
    else if (kind === 'sale') {
      const sale = this.record.sale
      const end = asTime(config.sale?.endAt), start = asTime(config.sale?.startAt)
      if (sale.automatic && (end != null && Date.now() >= end || start != null && Date.now() < start)) { sale.state = 'cancelled'; this._persist(); return null }
      sale.state = 'displaying'; sale.startedAt = Date.now(); sale.expiresAt = Date.now() + sale.durationSeconds * 1000; this._persist(); this._publish()
      turn.text = config.sale?.announcement?.trim()?.replaceAll('{{minutes}}',String(Math.round(sale.durationSeconds/60))).replaceAll('{{time}}',new Date(Date.now()+8*3600000).toISOString().slice(11,16)) || `秒杀时间到啦！想参与的朋友，请扫描屏幕右上角的二维码，查看本轮秒杀商品。二维码会保留${Math.round(sale.durationSeconds / 60)}分钟，大家可以边听边扫码，具体商品和参与条件以活动页面为准。`
    } else if (kind === 'lottery-announcement') {
      const draw = this.record.lottery; draw.state = 'announcing';draw.programKind=choice.programKind;this._persist()
      turn.text = `给大家送一份礼物，这一轮是${draw.prize}！参与方式很简单：请在弹幕区完整输入“${draw.keyword}”。参与时间大约${draw.waitSeconds}秒，第一条符合口令的新弹幕用户将中奖，大家准备好了吗？`
    } else if (kind === 'lottery-wait') turn.text = `想参与的朋友记得在弹幕区输入“${this.record.lottery.keyword}”，我正在关注大家的新消息。我们稍等一下，一起看看这次是哪位朋友最先参与！`
    else if (kind === 'lottery-result') {
      const draw = this.record.lottery
      turn.text = draw.winner ? `恭喜${draw.winner.platformName?'来自'+draw.winner.platformName+'的':''}${draw.winner.nickname}，你中奖了！这一轮送出的是${draw.prize}。请扫描屏幕右下方的二维码，加入用户交流群，联系工作人员领取奖励。` : '这一轮参与时间已经结束，暂时没有收到符合口令的有效新弹幕，本轮没有产生中奖者，礼物会保留到后续活动。'
    }
    if (!turn.text) {
      const candidates=choice.candidates||[];if(kind==='comment'){turn.audienceIds=[];turn.audienceComments=candidates.slice(-COMMENT_WINDOW_LIMIT).map(row=>({id:row.id,nickname:row.nickname,content:row.content,...(row.platformName?{platformName:row.platformName}:{})}))}
      const messages=this._messages(kind,{candidates,question:choice.question,after,context}),provided=JSON.parse(messages[1].content),providedIds=new Set((provided.candidates||[]).filter(row=>row.canReply).map(row=>row.id)),refs=commentReferences(candidates,provided.candidates||[])
      const defaultId=provided.candidates?.find(row=>row.canReply)?.id
      const commentLimit=Math.max(60,Math.min(180,(config.live?.commentSeconds||12)*6))
      const validate=raw=>{
        const parsed=parseTurn(raw)
        if(parsed.selectedId&&!providedIds.has(parsed.selectedId))throw new Error('模型选择了不在候选列表中的弹幕')
        if(kind==='comment'){
          parsed.answeredIds=expandCommentIds(parsed.answeredIds)
          const ids=parsed.answeredIds??[parsed.selectedId||defaultId]
          if(!ids.length||ids.some(id=>!providedIds.has(id)))throw new Error('模型引用了未提供的待回应弹幕')
          if(new Set(ids).size>1&&parsed.text.length>commentLimit)throw new Error('合并弹幕回应超长，无法确认每条均已播出')
        }
        return parsed
      }
      try {
        turn = { ...turn, ...validate(await this.providers.generate(messages, { signal,validate })) }
      } catch (error) {
        aborted(signal)
        if (kind === 'comment' && !preparing) return this._deferCommentReply(error)
        throw error
      }
      const allowed=new Set(kind==='source'?provided.conversation.audienceRequests.map(row=>row.id):[]);turn.appliedRequestIds=(turn.appliedRequestIds||[]).filter(id=>allowed.has(id))
      if (kind === 'comment') {
        const limit=Math.max(60,Math.min(180,(config.live?.commentSeconds||12)*6)),ids=turn.answeredIds??[turn.selectedId||defaultId]
        turn.audienceIds=[...new Set(ids.map(id=>refs.get(id).id))];turn.answeredIds=turn.audienceIds
        turn.selectedId=turn.selectedId?refs.get(turn.selectedId).id:null
        turn.audienceComments=turn.audienceComments.filter(row=>turn.audienceIds.includes(row.id))
        turn.cutoff=Math.max(this.reviewed,...candidates.filter(row=>turn.audienceIds.includes(row.id)).map(row=>row.serial));turn.text=clipped(turn.text,limit)
      }
      if (kind !== 'source') { turn.navigation = 'stay'; delete turn.interaction }
      if (kind === 'source' && (preparing||!this._interactionDue())) delete turn.interaction
      if(kind==='engagement')turn.text=clipped(turn.text,120)
      if(kind==='source'&&!mayAdvancePage(config,(context?.memory||this.memory).turns+1))turn.navigation='stay'
    }
    if(kind==='source'&&contextRevision!==this.conversation.revision)throw Object.assign(new Error('观众需求已更新，正在重新准备讲解'),{code:'STALE_CONVERSATION'})
    aborted(signal)
    if (!preparing) this._transition(kind, '口播已生成，正在合成声音', 'synthesizing')
    if(!turn.audio){
      const parts=config.tts?.provider==='demo'?[turn.text]:splitLiveSpeech(turn.text).filter(hasSpeechContent)
      if(!parts.length)throw new Error('本段没有可朗读的文字')
      turn.audioProgress={ready:0,total:parts.length,playing:0,completed:0,priority:preparing?1:0,waiters:new Set(),error:''}
      try { turn.audio=await this._synthesizeSpeech(parts[0],{signal,priority:()=>turn.audioProgress.priority}) }
      catch(error) {
        aborted(signal)
        if(preparing||error?.code!=='SPEECH_TEXT_REJECTED')throw error
        this._skipRejectedSpeech(turn,error)
        return null
      }
      aborted(signal)
      if (!turn.audio) { turn.speechTimedOut = true; return turn }
      turn.audioTotal=parts.length;turn.audioReady=1;turn.audioProgress.ready=1;turn.audioParts=[Promise.resolve(turn.audio),...this._audioJobs(parts.slice(1),signal,turn)]
    }
    if(kind==='source'&&contextRevision!==this.conversation.revision)throw Object.assign(new Error('观众需求已更新，正在重新准备讲解'),{code:'STALE_CONVERSATION'})
    turn.voice=this.providers.speechInfo?.(turn.audio)||(choice.audio?{source:'recording',voiceName:'固定录音'}:null)
    aborted(signal)
    if (version !== this.epoch) throw abortError()
    return turn
  }

  async _speak(turn, signal, version) {
    if (!turn || !turn.audio) return
    if(turn.kind==='source'&&turn.pageKey===this.page.pageKey)this.manualSourcePending=false
    turn.startedAt = Date.now(); this.currentSpeech = turn; this.lastAudioAt = Date.now()
    const progress=turn.audioProgress
    if(progress){progress.priority=0;this.providers.drainSpeech?.()}
    this._transition(turn.kind, progress?.total>1?'正在分块播报，后续语音同步合成；整段讲完后处理弹幕与活动':'正在播放完整口播，播完后重新检查弹幕与活动', 'playing')
    this.events.publish('speech', { text: turn.text, kind: turn.kind, id: turn.id, demo: this.demo,voice:turn.voice })
    const playback=[];let playbackError=null,completed=false
    const enqueue=(path,index)=>{
      const voice=this.providers.speechInfo?.(path)||turn.voice
      const done=this.media.playAudio(path,{signal,onStart:()=>{if(this.currentSpeech?.id===turn.id&&!signal.aborted){turn.voice=voice;if(progress)progress.playing=index+1;this._publish()}}}).then(value=>{if(progress){progress.completed++;for(const wake of [...progress.waiters])wake();if(this.currentSpeech?.id===turn.id)this._publish()}return value})
      done.catch(error=>{playbackError=error});playback.push(done)
    }
    const cancel=()=>turn.productionController?.abort(signal.reason||abortError());signal.addEventListener('abort',cancel,{once:true})
    try{
      enqueue(turn.audio,0)
      if(turn.kind==='source'&&!this.manualSourcePending&&turn.pageKey===this.page.pageKey){const next=this._nextInterlude({ahead:1,interaction:turn.interaction||this.pendingInteraction});if(next&&this.prepared&&this.prepared.kind!==next.kind)this._dropPrepared()}
      this._prepare(turn,version)
      const parts=turn.audioParts||[Promise.resolve(turn.audio)]
      for(let index=1;index<parts.length;index++){
        // Keep at most the audible chunk plus two decoded chunks ahead.
        if(index>=3)await cancellable(playback[index-3],signal)
        const path=await cancellable(parts[index],signal);aborted(signal)
        if(playbackError)throw playbackError
        if(!path){
          turn.speechTimedOut=true
          playback.push(Promise.resolve())
          if(progress){progress.completed++;for(const wake of [...progress.waiters])wake();this._publish()}
          continue
        }
        enqueue(path,index)
      }
      await Promise.all(playback)
      aborted(signal);completed=true;this.lastAudioAt=Date.now();this.currentSpeech=null
    }catch(error){
      aborted(signal)
      if(error?.code!=='SPEECH_TEXT_REJECTED')throw error
      await cancellable(Promise.all(playback),signal)
      this._skipRejectedSpeech(turn,error)
    }finally{signal.removeEventListener('abort',cancel);if(!completed)turn.cancelAudio?.(signal.reason||abortError());if(signal.aborted)cancel()}
  }

  /** A timed-out chunk has no audio. Other chunks retain their own queued results. */
  async _synthesizeSpeech(text,options){
    try{return await this.providers.synthesize(text,{...options,skipOnTimeout:true})}
    catch(error){aborted(options.signal);if(error?.code==='SPEECH_TIMEOUT')return null;throw error}
  }
  /** Prepare a bounded four-chunk window; live and future turns share the provider pool. */
  _audioJobs(parts,signal,turn){
    if(!parts.length)return []
    const controller=new AbortController(),progress=turn.audioProgress,jobs=parts.map(()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});promise.catch(()=>{});return {promise,resolve,reject}})
    let cursor=0,workers=Math.min(2,parts.length),failed=false
    const fail=error=>{if(failed)return;failed=true;progress.error=this.providers.redact?.(error)||String(error.message||error);controller.abort(error);for(const job of jobs)job.reject(error)}
    turn.cancelAudio=fail
    const cancel=()=>fail(signal.reason||abortError());signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()
    const window=number=>new Promise((resolve,reject)=>{
      const cleanup=()=>{progress.waiters.delete(wake);controller.signal.removeEventListener('abort',abort)}
      const wake=()=>{if(number<progress.completed+4){cleanup();resolve()}}
      const abort=()=>{cleanup();reject(controller.signal.reason||abortError())}
      if(controller.signal.aborted){reject(controller.signal.reason);return}
      progress.waiters.add(wake);controller.signal.addEventListener('abort',abort,{once:true});wake()
    })
    const run=async()=>{try{while(!failed&&cursor<parts.length){const index=cursor++;await window(index+1);aborted(controller.signal);const path=await this._synthesizeSpeech(parts[index],{signal:controller.signal,priority:()=>progress.priority});aborted(controller.signal);if(path){turn.audioReady++;progress.ready++}jobs[index].resolve(path);this._publish()}}catch(error){fail(error)}finally{if(--workers===0)signal.removeEventListener('abort',cancel)}}
    for(let index=0;index<Math.min(2,parts.length);index++)void run()
    return jobs.map(job=>job.promise)
  }

  async _futureContext(seed,{advance=true}={}){
    const config=this.store.get(),projection=seed.projection||{page:clone(this.page),memory:clone(this.memory)},page=clone(projection.page),memory=clone(projection.memory)
    const bridge=!['source','opening'].includes(seed.kind)?{kind:seed.kind,text:seed.text,question:seed.question||'',audienceIds:seed.audienceIds||[],audienceComments:seed.audienceComments||[]}:null
    const plannedRequestIds=[...new Set([...(projection.plannedRequestIds||[]),...(seed.kind==='source'?seed.appliedRequestIds||[]:[])])].slice(-12)
    if(seed.kind==='source'){memory.turns++;if(seed.navigation==='next'&&mayAdvancePage(config,memory.turns))memory.finished=true;memory.notes=[...memory.notes,seed.text.slice(0,220)].slice(-4);const point=seed.text.split(/[。！？!?]/)[0].slice(0,80);if(point)memory.outline=[...memory.outline,point].slice(-32)}
    if(advance&&memory.finished){
      if(config.presentation?.autoAdvance===false)return null
      let next=page.pageNumber+1
      if(next>page.pageCount){if(config.presentation?.loop===false)return null;next=1}
      const future=await this.media.readSlideAt?.(next)
      if(!future?.pageKey)return null
      return {page:future,memory:{pageKey:future.pageKey,turns:0,notes:[],outline:[]},bridge,previousKind:seed.kind,plannedRequestIds}
    }
    return {page,memory,bridge,previousKind:seed.kind,plannedRequestIds}
  }

  /** Produce up to three future paragraphs, including future slides, without moving the on-air deck. */
  _prepare(turn,version){
    if(this.manualNavigating||this.queueProducer||this.productionQueue.length>=3||this.paused||this.closing||this.manualOnly||this.demo||!this._enabled('source'))return
    if(!this.manualSourcePending&&(!['opening','source','comment','engagement','cue','question'].includes(turn.kind)||this.manualQueue.length||this.record.sale?.state==='queued'||this._lotteryActive()))return
    const controller=new AbortController(),revision=this.queueRevision;this.queueProducer=controller
    const produce=async()=>{
      let seed=this.productionQueue.at(-1)?.turn||turn
      while(this.productionQueue.length<3&&!controller.signal.aborted&&version===this.epoch&&revision===this.queueRevision){
        const interlude=!this.manualSourcePending&&this.productionQueue.length===0&&seed.id===turn.id&&turn.kind==='source'?this._nextInterlude({ahead:1,interaction:turn.interaction||this.pendingInteraction}):null
        const kind=interlude?.kind||'source',context=this.manualSourcePending&&seed.id===turn.id?{page:clone(this.page),memory:clone(this.memory),bridge:{kind:turn.kind,text:turn.text},previousKind:turn.kind,plannedRequestIds:[]}:await this._futureContext(seed,{advance:!interlude})
        if(!context||controller.signal.aborted||revision!==this.queueRevision)return
        const entry={kind,contextRevision:this.conversation.revision,phase:'generating',controller:new AbortController(),parent:seed.id,pageKey:context.page.pageKey,page:context.page,paragraphNumber:kind==='source'?context.memory.turns+1:null}
        this.productionQueue.push(entry);this.prepared=this.productionQueue[0];this._publish()
        entry.promise=this._turn({kind,...(interlude||{})},entry.controller.signal,version,{preparing:true,after:seed.text,context}).then(value=>{entry.phase='ready';entry.turn=value;this._publish();return value},error=>{entry.phase='error';entry.error=this.providers.redact?.(error)||String(error.message||error);this._publish();throw error})
        entry.promise.catch(()=>{});seed=await entry.promise
      }
    }
    void produce().catch(()=>{}).finally(()=>{if(this.queueProducer===controller)this.queueProducer=null;this._publish()})
  }

  _aired(turn) {
    if (!turn || turn.speechRejected) return
    this.rejectedSpeechTurns = 0
    if(turn.speechTimedOut){
      this._dropPrepared()
      this._log('speech-timeout-skipped',{kind:turn.kind,pageNumber:turn.projection?.page?.pageNumber||this.page.pageNumber})
      if(turn.kind==='source'){this.manualSourcePending=false;return}
      if(turn.kind==='comment'){this._deferCommentReply(new Error('语音合成超时'));return}
      if(turn.kind==='lottery-announcement'){
        this.record.lottery.state='cancelled';this.record.lottery.reason='抽奖说明语音超时';this._persist();this._publish();return
      }
    }else{
      this.lastAiredId=turn.id;this.lastCompletedText=turn.text;this.conversation.aired(turn,turn.projection?.page?.pageNumber||this.page.pageNumber)
      if(turn.kind==='source')for(const row of this.comments)if(turn.appliedRequestIds?.includes(row.id))row.resolvedInSource=true
      this._log('speech', { kind: turn.kind, text: turn.text, pageNumber: turn.projection?.page?.pageNumber||this.page.pageNumber, demo: this.demo,voice:turn.voice })
    }
    if(turn.kind==='source'&&(turn.pageKey!==this.page.pageKey||turn.navigationRevision!==(this.manualRevision||0)))return
    if (turn.kind === 'opening') this.opening = false
    else if (turn.kind === 'closing') { this.stop(turn.speechTimedOut?'告别语音超时，已结束口播':'告别整段播完'); return }
    else if (turn.kind === 'comment') { for(const row of this.comments)if(turn.audienceIds?.includes(row.id))row.respondedAt=Date.now();this.reviewed = Math.max(this.reviewed, turn.cutoff); this.sourceSinceComment = 0; this.lastCommentAt = Date.now() }
    else if (turn.kind === 'engagement') { this.pendingInteraction = null; this.sourceSinceInteraction = 0; this.lastInteractionAt = Date.now() }
    else if (turn.kind === 'source') {
      this.memory.turns++; this.memory.notes.push(turn.text.slice(0, 220)); this.memory.notes = this.memory.notes.slice(-4)
      const point = turn.text.split(/[。！？!?]/)[0].slice(0, 80); if (point) this.memory.outline.push(point); this.memory.outline = this.memory.outline.slice(-32)
      this.sourceSinceComment++; this.sourceSinceInteraction++
      if (turn.interaction&&this._enabled('engagement')) this.pendingInteraction = turn.interaction
      if (turn.navigation === 'next'&&mayAdvancePage(this.store.get(),this.memory.turns)){this.memory.finished=true;if(this.store.get().presentation?.autoAdvance!==false)this.pendingNavigation=true}
    } else if (turn.kind === 'lottery-announcement') {
      const draw = this.record.lottery; draw.state = 'waiting'; draw.startedAt = Date.now(); draw.deadlineAt = Date.now() + draw.waitSeconds * 1000; draw.startSerial = this.serial; draw.interactionDone = false; this._persist()
    } else if (turn.kind === 'lottery-wait') { this.record.lottery.interactionDone = true; this._persist() }
    else if (turn.kind === 'lottery-result') {
      const draw = this.record.lottery; draw.state = 'completed'; draw.completedAt = Date.now(); this.record.lotteryHistory.push(clone(draw)); this.record.lotteryHistory = this.record.lotteryHistory.slice(-1000); this._persist(); this._log('lottery', draw)
    }
    if(turn.programKind&&(!turn.kind.startsWith('lottery-')||turn.kind==='lottery-result')){const order=programOf(this.store.get()).order,index=order.indexOf(turn.programKind);if(index>=0)this.programCursor=(index+1)%order.length}
    this._publish()
  }

  async _advance(signal) {
    this._transition('advancing', '当前页讲解完毕，正在确认下一页', 'navigating')
    const config = this.store.get()
    if (this.page.pageCount > 0 && this.page.pageNumber >= this.page.pageCount) {
      if (config.presentation?.loop === false) { this.closing = true; this.pendingNavigation = false; return }
      await this.media.firstSlide();this.memory={pageKey:'',turns:0,notes:[],outline:[]};this.record.cycle++; this._persist()
    } else await this.media.nextSlide()
    aborted(signal); this.pendingNavigation = false; this._savePage(await this.media.readSlide());if(this.prepared&&this.prepared.pageKey!==this.page.pageKey)this._dropPrepared();this._publish()
  }
  _settleLottery() {
    const draw = this.record.lottery
    if (draw?.state !== 'waiting') return
    const eligible = this.comments.filter(item => item.serial > draw.startSerial && item.at >= draw.startedAt && item.at <= draw.deadlineAt && item.content.trim() === draw.keyword).sort((a, b) => a.serial - b.serial)
    draw.winner = draw.candidate || (eligible[0] ? winnerFromComment(eligible[0]) : null); draw.state = 'result'
    for (const item of eligible) item.lotteryId = draw.id
    this._persist(); this._publish()
  }
  _nextSaleAt() {
    const cfg = this.store.get().sale || {}, period = Number(cfg.intervalMinutes || 60) * 60000
    if (!cfg.enabled || !Number.isFinite(period) || period <= 0) return null
    const end = asTime(cfg.endAt), start = asTime(cfg.startAt), now = Date.now()
    let target = Math.ceil(now / period) * period
    if (start != null) target = Math.max(target, Math.ceil(start / period) * period)
    while (this.record.saleClaims.includes('sale:' + target)) target += period
    return end != null && target >= end ? null : target
  }
  _automatic() {
    const c = this.store.get(), now = Date.now(), cfg = c.sale || {}, start = asTime(cfg.startAt), end = asTime(cfg.endAt), period = Number(cfg.intervalMinutes || 60) * 60000
    if (this._enabled('sale')&&cfg.enabled && Number.isFinite(period) && period >= 60000 && (start == null || now >= start) && (end == null || now < end) && !this._saleActive() && this.record.sale?.state !== 'queued') {
      const at = Math.floor(now / period) * period, claim = 'sale:' + at
      if (now - at < 120000 && (start == null || at >= start) && !this.record.saleClaims.includes(claim)) this.queueSale({ claim, reason: '北京时间定时秒杀' })
    }
    const lottery=c.lottery||{},triggers=lotteryTriggersOf(lottery),claims=[],anchor=this.scheduleStartedAt||this.startedAt,elapsed=anchor?now-anchor:0
    if (!this._enabled('lottery')||!lottery.enabled || this._lotteryActive() || this._prizeCount() >= (lottery.prizes?.length || 0)) return
    if(triggers.includes('interval')&&lottery.intervalMinutes&&elapsed>=lottery.intervalMinutes*60000)claims.push('lottery:interval:'+anchor+':'+Math.floor(elapsed/(lottery.intervalMinutes*60000)))
    const freshMetrics=this._freshMetrics(),heatSources=[freshMetrics,...(freshMetrics.platforms||[])]
    const metric=lottery.popularityMetric||'heat'
    if(triggers.includes('popularity'))for(const source of heatSources)if(lottery.popularityThreshold&&Number.isFinite(source[metric])&&source[metric]>=lottery.popularityThreshold)claims.push('lottery:'+metric+':'+anchor+':'+(source.connectionId||'legacy')+':'+lottery.popularityThreshold)
    if(triggers.includes('comment')&&this.pendingLotteryComment&&now-this.pendingLotteryComment.at<=120000)claims.push('lottery:comment:'+anchor+':'+this.pendingLotteryComment.id)
    const date = new Date(now + 8 * 3600000).toISOString().slice(0, 10)
    if(triggers.includes('fixed'))for (const time of lottery.fixedTimes || []) { const at = Date.parse(date + 'T' + time + ':00+08:00'); if (now >= at && now - at < 120000) claims.push('lottery:fixed:' + date + ':' + time) }
    const unclaimed = claims.filter(claim => !this.record.triggerClaims.includes(claim))
    if(unclaimed.length){this.queueLottery({reason:'自动抽奖条件已达到',automatic:true});this.record.triggerClaims.push(...unclaimed);this.record.triggerClaims=this.record.triggerClaims.slice(-10000);this.pendingLotteryComment=null;this._persist()}
  }
  _supervise() {
    if (this.record.sale?.state === 'displaying' && this.record.sale.expiresAt <= Date.now()) { this.record.sale.state = 'completed'; this._persist(); this._publish() }
    if (!this.wanted || this.paused) return
    try { if (this.running&&!this.closing) this._automatic() } catch (error) { this.error = this.providers.redact?.(error) || error.message; this._publish() }
    if(this.running&&this.phase==='waiting'&&!this.currentSpeech)return
    const silence = Math.max(120, Number(this.store.get().live?.silenceSeconds) || 120) * 1000
    if (Date.now() - this.lastAudioAt >= silence && !this.recovering) {
      const closing=this.closing
      this.recovering = true; this.record.recoveries++; this._persist(); this.controller?.abort(abortError()); this._dropPrepared(); this.media.stopAudio(); this.epoch++; this.running = false; this.currentSpeech = null
      this._log('recovery', { reason: '超过静音阈值，保留当前页和奖品记录恢复' })
      this._begin(false, { recovery: true,closing }).finally(() => { this.recovering = false })
    }
  }
  _failed(error) {
    this.running = false; this.currentSpeech = null; this._dropPrepared(); this.media.stopAudio(); this.error = this.providers.redact?.(error) || String(error?.message || error).slice(0, 350)
    this._log('error', { message: this.error }); this._transition('error', this.error, 'error')
  }

  report(format = 'json') {
    const sources=[...new Set(this.snapshots.map(row=>row.connectionId||'legacy'))]
    const values = key => (sources.length<=1?this.snapshots:this.snapshots.filter(row=>!row.connectionId)).map(row => row[key]).filter(Number.isFinite)
    const platformSummaries=sources.filter(id=>id!=='legacy').map(id=>{const rows=this.snapshots.filter(row=>row.connectionId===id),latest=rows.at(-1),max=key=>{const values=rows.map(row=>row[key]).filter(Number.isFinite);return values.length?Math.max(...values):null},online=[max('onlineUsers'),max('peakOnlineUsers')].filter(Number.isFinite);return {connectionId:id,platform:latest.platform,platformName:latest.platformName,connectionName:latest.connectionName,snapshotCount:rows.length,peakOnline:online.length?Math.max(...online):null,sampledPeakOnline:max('onlineUsers'),platformPeakOnline:max('peakOnlineUsers'),peakHeat:max('heat'),latest:this.platformMetrics[id]||latest}})
    const online = values('onlineUsers'), platformOnline = values('peakOnlineUsers'), heat = values('heat')
    const sampledPeakOnline=online.length?Math.max(...online):null,platformPeakOnline=platformOnline.length?Math.max(...platformOnline):null
    const observedPeaks=[sampledPeakOnline,platformPeakOnline].filter(Number.isFinite)
    const data = {
      generatedAt: new Date().toISOString(), timezone: 'Asia/Shanghai', sessionId: this.sessionId || null, startedAt: this.startedAt,
      durationSeconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      summary: { peakOnline: observedPeaks.length?Math.max(...observedPeaks):null,sampledPeakOnline,platformPeakOnline,peakHeat: heat.length ? Math.max(...heat) : null, latest: {...this.metrics,...(Object.keys(this.platformMetrics).length?{platforms:this.platformMetrics}:{})}, awards: this._prizeCount(), snapshotCount: this.snapshots.length, scope: '仅统计已采集的实际指标；最高在线取采样在线峰值与已取得的平台峰值中较大值；未采集值为null，不推算完整平台观看人数。多平台分别统计；整体不相加不同时间或不同平台的峰值。' },
      platforms:clone(platformSummaries),snapshots: clone(this.snapshots), lottery: clone(this.record.lotteryHistory), recentTransitions: this.history.slice(), limits: { snapshots: 50000, comments: 100, commentAgeSeconds: 120 },
    }
    if (format === 'json') return data
    if (format === 'csv') {
      const columns = ['at','connectionId','platform','connectionName','pageNumber','stage','onlineUsers','peakOnlineUsers','heat','likes','totalViewers','views','totalViews','newFollowers','shares','groupJoins','giftCoins','durationSeconds']
      return '\uFEFF' + columns.join(',') + '\n' + this.snapshots.map(row => columns.map(key => { const value = row[key] == null ? '' : String(row[key]); return '"' + value.replaceAll('"', '""') + '"' }).join(',')).join('\n') + '\n'
    }
    if (format === 'md') return `# 直播数据报告\n\n生成时间：${data.generatedAt}\n\n已记录时长：${data.durationSeconds} 秒\n\n最高在线：${data.summary.peakOnline ?? '未采集'}（已采集来源的较大值）\n\n采样最高在线：${data.summary.sampledPeakOnline ?? '未采集'}\n\n平台报告最高在线：${data.summary.platformPeakOnline ?? '未采集'}\n\n最高热度：${data.summary.peakHeat ?? '未采集'}\n\n指标切片：${data.summary.snapshotCount} 条\n\n已发奖品：${data.summary.awards} 份\n\n${data.summary.scope}\n${platformSummaries.map(item=>'\n## '+String(item.connectionName).replace(/[\r\n#]/g,' ')+'（'+item.platformName+'）\n\n最高在线：'+(item.peakOnline??'未采集')+'\n\n最高热度：'+(item.peakHeat??'未采集')+'\n').join('')}`
    throw new Error('导出格式仅支持json、csv、md')
  }
  async close() { clearInterval(this.supervisor); this.stop('服务退出，未自动开播'); await this.loopPromise?.catch(() => {}) }
}
