import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LiveDirector, parseTurn, notesForPage } from '../server/director.mjs'

const until = async predicate => { const deadline = performance.now() + 1500; while (!predicate()) { if (performance.now() > deadline) throw new Error('Expected asynchronous director state was not reached'); await new Promise(resolve => setTimeout(resolve, 2)) } }
async function fixture(t, { sourceNavigation = 'stay', demo = false, generate } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-director-')), sent = [], requests = [], audio = new Map()
  let now = Date.parse('2026-10-24T12:03:00+08:00'); t.mock.method(Date, 'now', () => now)
  const config = { identity: { name: '小云', systemPrompt: '你是小云，面向观众讲解。', welcome: '欢迎大家。', goodbye: '谢谢大家，再见。' }, llm: {}, tts: { provider: demo ? 'demo' : 'openai', demoText: '演示试听。' }, presentation: { url: 'https://example.test/deck', loop: true, autoAdvance: true }, live: { commentFrequency: 100, pageSeconds: 30, commentSeconds: 12, engagementMinTurns: 3, engagementCooldownSeconds: 90, silenceSeconds: 120 }, sale: { enabled: false, intervalMinutes: 60, durationSeconds: 1800, link: 'https://example.test/sale', qrUrl: '/assets/qr.png' }, lottery: { enabled: false, keyword: '来玩', waitSeconds: 5, prizes: ['第一份礼物', '第二份礼物'] } }
  const store = { get: () => config, secret: () => 'test-key' }
  const media = {
    page: 1, active: null, queue: [], played: [], opened: 0, advanced: 0, firsts: 0, paused: false,
    async initialize() {}, async openPresentation() { this.opened++; this.page = 1 },
    async readSlide() { return { pageNumber: this.page, pageCount: 2, pageKey: 'page-' + this.page, title: '主题' + this.page, text: '当前页' + this.page + '的事实。', notes: '只讲真实事实。' } },
    async nextSlide() { this.advanced++; this.page++ }, async previousSlide() { this.page-- }, async firstSlide() { this.firsts++; this.page = 1 },
    playAudio(path, { signal }) { return new Promise((resolve, reject) => { const item = { path, text: audio.get(path), resolve: () => { signal.removeEventListener('abort', abort); if(this.active===item)this.active=this.queue.shift()||null;else this.queue=this.queue.filter(row=>row!==item); resolve() }, reject: error => { signal.removeEventListener('abort', abort); if(this.active===item)this.active=this.queue.shift()||null;else this.queue=this.queue.filter(row=>row!==item); reject(error) } }; const abort = () => item.reject(signal.reason || new DOMException('stopped', 'AbortError')); signal.addEventListener('abort', abort, { once: true }); if(this.active)this.queue.push(item);else this.active=item; this.played.push(item) }) },
    stopAudio() { for(const item of [this.active,...this.queue].filter(Boolean))item.reject(new DOMException('stopped','AbortError')) }, pauseAudio() { this.paused = true }, resumeAudio() { this.paused = false },
  }
  const providers = {
    status: () => ({ demo, modelConfigured: !demo }), redact: error => String(error.message || error),
    async generate(messages, options) { requests.push(messages); const payload = JSON.parse(messages[1].content); if (generate) return generate(payload, messages, options); return JSON.stringify({ speech: payload.stage === 'comment' ? '回应大家的共同问题。' : payload.stage === 'question' ? '回答主持人的问题。' : '继续讲解当前主题。', navigation: payload.stage === 'source' ? sourceNavigation : 'stay' }) },
    async synthesize(text) { const file = '/audio/' + audio.size + '.wav'; audio.set(file, text); return file },
  }
  const director = new LiveDirector({ store, media, providers, events: { publish: (type, payload) => sent.push({ type, payload }) }, dataDir: dir })
  t.after(async () => { await director.close(); await rm(dir, { recursive: true, force: true }) })
  const start = async () => { await director.start(); await until(() => media.active); return media.active }
  const complete = async () => { assert.ok(media.active, 'expected current audio'); const before = media.played.length; media.active.resolve(); await until(() => media.played.length > before || !director.running || director.phase === 'error'); return media.active }
  return { director, media, config, store, providers, sent, requests, dir, start, complete, setTime: value => { now = value }, advance: ms => { now += ms } }
}

test('only aired source turns become memory; following text and audio are prepared during playback', async t => {
  const f = await fixture(t); await f.start(); assert.equal(f.director.stage, 'opening')
  await f.complete(); assert.equal(f.director.stage, 'source'); assert.equal(f.director.memory.turns, 0)
  await until(() => f.director.prepared?.phase === 'ready'); const prepared = f.director.prepared
  assert.match(JSON.stringify(f.requests.at(-1)), /正在播放的本段尚未确认播完/)
  assert.equal(f.director.memory.turns, 0); await f.complete()
  assert.equal(f.director.memory.turns, 1); assert.equal(f.media.active.path, (await prepared.promise).audio)
})

test('a queued sale waits for the full utterance and preserves the current page for thirty minutes', async t => {
  const f = await fixture(t); await f.start(); await f.complete()
  const before = f.media.active, page = f.media.page
  f.director.queueSale(); assert.equal(f.media.active, before); assert.equal(f.director.status().sale.queued, true)
  await f.complete(); assert.equal(f.director.stage, 'sale'); assert.match(f.media.active.text, /30分钟/)
  const expires = f.director.record.sale.expiresAt
  assert.equal(expires - f.director.record.sale.startedAt, 1800000)
  await f.complete(); assert.equal(f.director.stage, 'source'); assert.equal(f.media.page, page); assert.equal(f.media.advanced, 0)
  f.advance(16 * 60000); f.director._supervise(); assert.equal(f.director.status().sale.active, true)
  f.advance(14 * 60000); f.director._supervise(); assert.equal(f.director.status().sale.active, false)
})

test('new comments are answered between whole paragraphs before the next page', async t => {
  const f = await fixture(t, { sourceNavigation: 'next' }); await f.start(); await f.complete()
  const playing = f.media.active
  f.director.addComments([{ id: 'c1', nickname: '观众甲', content: '这个怎么使用？' }])
  assert.equal(f.media.active, playing)
  await f.complete(); assert.equal(f.director.stage, 'comment'); assert.equal(f.media.page, 1)
  assert.match(JSON.stringify(f.requests.at(-1)), /观众甲/)
  await f.complete(); assert.equal(f.media.page, 2); assert.equal(f.media.advanced, 1); assert.equal(f.director.stage, 'source')
})

test('normal full-deck looping has no closing speech and keeps the prize ledger', async t => {
  const f = await fixture(t, { sourceNavigation: 'next' }); await f.start(); await f.complete(); await f.complete()
  assert.equal(f.media.page, 2); await f.complete()
  assert.equal(f.media.page, 1); assert.equal(f.director.record.cycle, 2)
  assert.equal(f.media.played.some(item => item.text === f.config.identity.goodbye), false)
})

test('pause retains playback and suppresses silence recovery; manual stop is never restarted', async t => {
  const f = await fixture(t); await f.start(); const before = f.media.active
  f.director.pause(); f.advance(180000); f.director._supervise()
  assert.equal(f.media.active, before); assert.equal(f.director.record.recoveries, 0); assert.equal(f.media.paused, true)
  f.director.resume(); assert.equal(f.media.active, before)
  f.director.stop(); f.advance(180000); f.director._supervise()
  assert.equal(f.director.running, false); assert.equal(f.director.wanted, false); assert.equal(f.media.active, null)
})

test('the first valid lottery comment survives a thousand-comment buffer overflow', async t => {
  const f = await fixture(t); await f.start(); await f.complete(); f.director.queueLottery()
  await f.complete(); assert.equal(f.director.stage, 'lottery-announcement'); assert.equal(f.director.record.lottery.startedAt, undefined)
  await f.complete(); assert.equal(f.director.stage, 'lottery-wait')
  f.director.addComments([{ id: 'first-winner', nickname: '第一个有效用户', content: '来玩' }, ...Array.from({ length: 999 }, (_, i) => ({ id: 'later-' + i, nickname: '后来的用户' + i, content: '来玩' }))])
  assert.equal(f.director.comments.length, 100); f.advance(6000); await f.complete()
  assert.equal(f.director.stage, 'lottery-result'); assert.match(f.media.active.text, /第一个有效用户/); assert.match(f.media.active.text, /用户交流群/)
  await f.complete(); assert.equal(f.director.status().lottery.drawsUsed, 1)
  await f.director.restart(); await until(() => f.media.active); assert.equal(f.director.status().lottery.drawsUsed, 1)
})

test('a host question interrupts audio explicitly without marking the interrupted source as aired', async t => {
  const f = await fixture(t); await f.start(); await f.complete(); assert.equal(f.director.memory.turns, 0)
  await f.director.ask('主持人的实时问题',{interrupt:true}); await until(() => f.director.stage === 'question' && f.media.active)
  assert.equal(f.director.memory.turns, 0); assert.match(JSON.stringify(f.requests.at(-1)), /主持人的实时问题/)
  await f.complete(); assert.equal(f.director.stage, 'source')
})

test('comment contexts contain only recent bounded messages and reports do not invent missing indicators', async t => {
  const f = await fixture(t)
  f.director.addComments(Array.from({ length: 300 }, (_, i) => ({ id: 'comment-' + i, nickname: '用户' + i, content: '消息' + i })))
  assert.equal(f.director.comments.length, 100); assert.equal(f.director._freshComments().length, 100)
  f.advance(121000); assert.equal(f.director._freshComments().length, 0)
  f.director.ingestMetrics({ onlineUsers: 12, heat: 83 }); f.director.ingestMetrics({ onlineUsers: 5, likes: 10 })
  const report = f.director.report('json'); assert.equal(report.summary.peakOnline, 12); assert.equal(report.summary.peakHeat, 83); assert.equal(report.summary.latest.totalViews, undefined)
  assert.match(f.director.report('csv'), /onlineUsers/); assert.match(f.director.report('md'), /最高在线：12/)
})

test('demo greeting is labelled and stops without pretending to synthesize a lecture', async t => {
  const f = await fixture(t, { demo: true }); await f.start()
  assert.equal(f.media.active.text, '演示试听。'); assert.equal(f.director.status().demo, true)
  await f.complete(); assert.equal(f.director.running, false); assert.equal(f.requests.length, 0)
  assert.match(f.director.reason, /演示试听结束/)
})

test('the fixed closing waits for the current whole paragraph before stopping', async t => {
  const f = await fixture(t); await f.start(); await f.complete(); const before = f.media.active
  f.director.finish(); assert.equal(f.media.active, before)
  await f.complete(); assert.equal(f.director.stage, 'closing'); assert.equal(f.media.active.text, f.config.identity.goodbye)
  await f.complete(); assert.equal(f.director.running, false); assert.equal(f.director.wanted, false)
})

test('a service reload starts safely stopped while preserving previous prize history', async t => {
  const f = await fixture(t); f.director.record.lotteryHistory.push({ winner: { id: 'old', nickname: '历史用户' }, prize: '旧奖品', state: 'completed' }); f.director._persist()
  const saved = JSON.parse(await readFile(join(f.dir, 'director-history.json'), 'utf8')); assert.equal(saved.lotteryHistory.length, 1)
  const second = new LiveDirector({ store: f.store, media: f.media, providers: f.providers, events: { publish() {} }, dataDir: f.dir })
  assert.equal(second.running, false); assert.equal(second.wanted, false); assert.equal(second.status().lottery.drawsUsed, 1)
  await second.close()
})

test('invalid model JSON and oversized speech are rejected or clipped at sentence boundaries', () => {
  assert.throws(() => parseTurn('plain text'), /JSON/)
  assert.throws(() => parseTurn('{"speech":""}'), /可播报/)
  const turn = parseTurn(JSON.stringify({ speech: '完整内容。'.repeat(150), navigation: 'next' }))
  assert.ok(turn.text.length <= 600); assert.equal(turn.navigation, 'next')
})

test('fixed recordings queue at the utterance boundary and retain their exact transcript without synthesis', async t => {
  const f=await fixture(t);await f.start();await f.complete()
  const before=f.media.active
  f.providers.synthesize=async()=>{throw new Error('should not synthesize an existing recording')}
  await f.director.playRecording({text:'这是预先录制的准确逐字稿。',path:'/recordings/cue.mp3'})
  assert.equal(f.media.active,before)
  await f.complete();assert.equal(f.director.stage,'cue');assert.equal(f.media.active.path,'/recordings/cue.mp3')
  assert.equal(f.director.currentSpeech.text,'这是预先录制的准确逐字稿。')
})

test('Tencent starts the first sentence chunk before later synthesis, and comments wait for all audio chunks',async t=>{
 const text='这是一句需要完整听完的讲解内容，不可以在半句话中插入弹幕。'.repeat(8)
 const f=await fixture(t,{generate:payload=>JSON.stringify({speech:payload.stage==='source'?text:'统一回应弹幕。',navigation:'stay'})})
 f.config.tts.provider='tencent'
 const original=f.providers.synthesize
 let calls=0,release
 f.providers.synthesize=async value=>{calls++;if(calls===3)await new Promise(resolve=>{release=resolve});return original(value)}
 await f.start();await f.complete();await until(()=>release)
 const current=f.director.currentSpeech.id
 assert.equal(f.media.queue.length,0);assert.equal(f.director.memory.turns,0)
 f.director.addComments([{id:'chunk-comment',nickname:'观众',content:'完整讲完再回应好吗？'}])
 assert.equal(f.director.currentSpeech.id,current)
 release();await until(()=>f.media.queue.length>0)
 while(f.director.currentSpeech?.id===current){if(f.media.active)f.media.active.resolve();await new Promise(resolve=>setTimeout(resolve,2))}
 await until(()=>f.media.active&&f.director.stage==='comment')
 assert.equal(f.director.memory.turns,1);assert.equal(f.media.active.text,'统一回应弹幕。')
})

test('real voice progress suppresses recovery, while a stalled utterance recovers the same page',async t=>{
 const f=await fixture(t);await f.start();await f.complete()
 const turn=f.director.currentSpeech.id
 f.advance(119000);f.director.audioProgress({voiceRms:.1});f.advance(5000);f.director._supervise()
 assert.equal(f.director.record.recoveries,0);assert.equal(f.director.currentSpeech.id,turn)
 f.advance(121000);f.director._supervise();await until(()=>f.director.record.recoveries===1&&f.media.active&&f.director.stage==='source')
 assert.equal(f.media.page,1);assert.equal(f.media.opened,1);assert.equal(f.director.opening,false)
})

test('automatic sales align to their configured window and preserve claims after looping',async t=>{
 const f=await fixture(t);await f.start();await f.complete()
 const start=Date.parse('2026-10-24T13:00:00+08:00');f.config.sale={...f.config.sale,enabled:true,intervalMinutes:60,startAt:start,endAt:start+7200000}
 f.setTime(start-1000);f.director._automatic();assert.equal(f.director.record.sale,null)
 f.setTime(start);f.director._automatic();assert.equal(f.director.status().sale.queued,true)
 const claim=f.director.record.saleClaims[0];assert.equal(claim,'sale:'+start)
 await f.complete();assert.equal(f.director.stage,'sale')
 f.director.hideSale();f.director.record.cycle++;f.director._automatic()
 assert.equal(f.director.status().sale.queued,false);assert.equal(f.director.record.saleClaims.length,1)
 f.setTime(start+7200000);f.director._automatic();assert.equal(f.director.status().sale.queued,false)
})

test('typed host questions queue at a paragraph boundary unless interruption is requested',async t=>{
 const f=await fixture(t);await f.start();await f.complete();const current=f.media.active
 await f.director.ask('排在本段之后回答的问题')
 assert.equal(f.media.active,current);await f.complete()
 assert.equal(f.director.stage,'question');assert.equal(f.director.memory.turns,1)
})

test('a delayed model reply cancelled by microphone interruption never becomes spoken progress',async t=>{
 let release,initial=true
 const f=await fixture(t,{generate:payload=>{
  if(payload.stage==='source'&&initial){initial=false;return new Promise(resolve=>{release=()=>resolve(JSON.stringify({speech:'这段迟到旧稿不应播出。',navigation:'next'}))})}
  return JSON.stringify({speech:payload.stage==='question'?'回答刚识别到的人声问题。':'正常主线。',navigation:'stay'})
 }})
 await f.start();f.media.active.resolve();await until(()=>release)
 await f.director.ask('麦克风识别的问题',{interrupt:true});release()
 await until(()=>f.media.active&&f.director.stage==='question')
 assert.equal(f.director.memory.turns,0);assert.equal(f.media.played.some(row=>row.text==='这段迟到旧稿不应播出。'),false)
 assert.equal(f.media.page,1)
})

test('microphone interruption retries the lottery announcement without consuming a prize or starting its window early',async t=>{
 const f=await fixture(t);await f.start();await f.complete();f.director.queueLottery();await f.complete()
 assert.equal(f.director.record.lottery.state,'announcing')
 await f.director.ask('主持人临时问一下',{interrupt:true});await until(()=>f.media.active&&f.director.stage==='question')
 assert.equal(f.director.status().lottery.drawsUsed,0);assert.equal(f.director.record.lottery.startedAt,undefined)
 await f.complete();assert.equal(f.director.stage,'lottery-announcement')
 await f.complete();assert.equal(f.director.record.lottery.state,'waiting')
})

test('supplemental page notes are seen alongside deck notes while other pages stay out of context',async t=>{
 const f=await fixture(t)
 f.config.presentation.notes='全场背景。\n\n## 幻灯片 1：主题一\n第一页必须提到的重点。\n\n## 幻灯片 2：主题二\n第二页专属内容。'
 await f.start();await f.complete()
 const payload=JSON.parse(f.requests[0][1].content)
 assert.match(payload.page.notes,/只讲真实事实/);assert.match(payload.page.notes,/全场背景/);assert.match(payload.page.notes,/第一页必须提到/)
 assert.doesNotMatch(payload.page.notes,/第二页专属/)
 assert.equal(notesForPage('普通全局补充素材',3),'普通全局补充素材')
})

test('partial metric updates cannot make old audience counts or popularity current again',async t=>{
 const f=await fixture(t)
 f.director.ingestMetrics({onlineUsers:34,heat:1000})
 f.advance(31000);f.director.ingestMetrics({likes:80})
 const payload=JSON.parse(f.director._messages('source')[1].content)
 assert.equal(payload.metrics.likes,80);assert.equal(payload.metrics.onlineUsers,undefined);assert.equal(payload.metrics.heat,undefined)
 f.config.lottery={...f.config.lottery,enabled:true,popularityThreshold:500}
 f.director.running=true;f.director.startedAt=Date.now();f.director._automatic()
 assert.equal(f.director.record.lottery,null)
 const report=f.director.report('json');assert.equal(report.summary.peakOnline,34);assert.equal(report.summary.peakHeat,1000)
})

test('microphone interruption cancels a promoted speculative draft without waiting for its provider',async t=>{
 let sourceCalls=0,release
 const f=await fixture(t,{generate:payload=>{
  if(payload.stage==='source'&&++sourceCalls===2)return new Promise(resolve=>{release=()=>resolve(JSON.stringify({speech:'迟到的预生成稿不会播出。',navigation:'next'}))})
  return JSON.stringify({speech:payload.stage==='question'?'马上回答主持人的问题。':'完整的一段主线讲解。',navigation:'stay'})
 }})
 await f.start();await f.complete();await until(()=>release)
 f.media.active.resolve();await until(()=>f.director.memory.turns===1&&!f.media.active)
 await f.director.ask('我要马上打断预生成',{interrupt:true})
 await until(()=>f.media.active&&f.director.stage==='question')
 assert.equal(f.director.memory.turns,1);assert.equal(f.media.page,1)
 release();await new Promise(resolve=>setTimeout(resolve,5))
 assert.equal(f.media.played.some(item=>item.text==='迟到的预生成稿不会播出。'),false)
})

test('a stalled goodbye recovers the goodbye intent without reopening the lecture',async t=>{
 const f=await fixture(t);await f.start();await f.complete();f.director.finish();await f.complete()
 assert.equal(f.director.stage,'closing');f.advance(121000);f.director._supervise()
 await until(()=>f.director.record.recoveries===1&&f.media.active&&f.director.stage==='closing')
 assert.equal(f.media.active.text,f.config.identity.goodbye);assert.equal(f.director.closing,true);assert.equal(f.director.opening,false)
 await f.complete();assert.equal(f.director.running,false);assert.equal(f.director.wanted,false)
})

test('reports distinguish sampled online peak from an observed platform historical peak',async t=>{
 const f=await fixture(t)
 f.director.ingestMetrics({onlineUsers:12,peakOnlineUsers:34})
 f.advance(1000);f.director.ingestMetrics({onlineUsers:8})
 const summary=f.director.report('json').summary
 assert.equal(summary.sampledPeakOnline,12);assert.equal(summary.platformPeakOnline,34);assert.equal(summary.peakOnline,34)
 const markdown=f.director.report('md')
 assert.match(markdown,/最高在线：34（已采集来源的较大值）/);assert.match(markdown,/采样最高在线：12/);assert.match(markdown,/平台报告最高在线：34/)
})

test('cross-platform comments keep independent identities and source labels in model context',async t=>{
 const f=await fixture(t);f.config.platforms=[{id:'a',platform:'bilibili',name:'B站直播间'},{id:'b',platform:'douyin',name:'抖音直播间'}]
 f.director.addComments([{id:'same',connectionId:'a',nickname:'观众',content:'部署问题'},{id:'same',connectionId:'b',nickname:'观众',content:'语音问题'}])
 assert.equal(f.director.comments.length,2);assert.notEqual(f.director.comments[0].id,f.director.comments[1].id)
 const context=JSON.parse(f.director._messages('comment',{candidates:f.director._freshComments()})[1].content)
 assert.equal(context.candidates[0].platformName,'哔哩哔哩');assert.equal(context.candidates[1].platformName,'抖音')
})
test('metrics and report peaks stay separate for each platform and retain per-field freshness',async t=>{
 const f=await fixture(t);f.config.platforms=[{id:'a',platform:'bilibili',name:'B站直播间'},{id:'b',platform:'douyin',name:'抖音直播间'}]
 f.director.ingestMetrics({connectionId:'a',onlineUsers:12,peakOnlineUsers:34,heat:100});f.director.ingestMetrics({connectionId:'b',onlineUsers:20,heat:500})
 const fresh=f.director._freshMetrics();assert.equal(fresh.onlineUsers,undefined);assert.equal(fresh.platforms.length,2)
 const report=f.director.report('json');assert.equal(report.summary.peakOnline,null);assert.equal(report.platforms.find(p=>p.connectionId==='a').peakOnline,34);assert.equal(report.platforms.find(p=>p.connectionId==='b').peakOnline,20)
 assert.match(f.director.report('csv'),/connectionId,platform,connectionName/);assert.match(f.director.report('md'),/B站直播间/)
 f.advance(31000);f.director.ingestMetrics({connectionId:'a',likes:80});const after=f.director._freshMetrics().platforms;assert.equal(after.length,1);assert.equal(after[0].likes,80);assert.equal(after[0].onlineUsers,undefined)
 assert.throws(()=>f.director.ingestMetrics({connectionId:'missing',heat:1000}),/不存在/)
})

test('lottery winners retain the originating platform when the same nickname exists elsewhere',async t=>{
 const f=await fixture(t);f.config.platforms=[{id:'a',platform:'bilibili',name:'B站直播间'},{id:'b',platform:'douyin',name:'抖音直播间'}]
 const now=Date.now();f.director.record.lottery={id:'draw',state:'waiting',keyword:'来玩',prize:'文化衫',startedAt:now,deadlineAt:now+5000,startSerial:0}
 f.director.addComments([{id:'same',connectionId:'b',nickname:'同名观众',userId:'viewer-b',content:'来玩'},{id:'same',connectionId:'a',nickname:'同名观众',userId:'viewer-a',content:'来玩'}])
 f.director._settleLottery();const winner=f.director.record.lottery.winner;assert.equal(winner.connectionId,'b');assert.equal(winner.platformName,'抖音');assert.equal(winner.userId,'viewer-b')
 const turn=await f.director._turn({kind:'lottery-result'},new AbortController().signal,f.director.epoch);assert.match(turn.text,/来自抖音的同名观众/)
})
