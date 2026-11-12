import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LiveDirector, parseTurn, notesForPage } from '../server/director.mjs'
import { Providers } from '../server/providers.mjs'
import {getPersonaPreset} from '../public/personas.mjs'

const until = async predicate => { const deadline = performance.now() + 1500; while (!predicate()) { if (performance.now() > deadline) throw new Error('Expected asynchronous director state was not reached'); await new Promise(resolve => setTimeout(resolve, 2)) } }
async function fixture(t, { sourceNavigation = 'stay', demo = false, generate } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-director-')), sent = [], requests = [], audio = new Map()
  let now = Date.parse('2026-10-24T12:03:00+08:00'); t.mock.method(Date, 'now', () => now)
  const config = { identity: { name: '小云', systemPrompt: '你是小云，面向观众讲解。', welcome: '欢迎大家。', goodbye: '谢谢大家，再见。' }, llm: {}, tts: { provider: demo ? 'demo' : 'openai', demoText: '演示试听。' }, presentation: { url: 'https://example.test/deck', loop: true, autoAdvance: true }, live: { commentFrequency: 100, pageSeconds: 30, minPageTurns:1, commentSeconds: 12, engagementMinTurns: 3, engagementCooldownSeconds: 90, silenceSeconds: 120 }, sale: { enabled: false, intervalMinutes: 60, durationSeconds: 1800, link: 'https://example.test/sale', qrUrl: '/assets/qr.png' }, lottery: { enabled: false, keyword: '来玩', waitSeconds: 5, prizes: ['第一份礼物', '第二份礼物'] } }
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
  const complete = async () => {
    assert.ok(media.active, 'expected current audio');const id=director.currentSpeech?.id
    while(director.currentSpeech?.id===id&&director.running&&director.phase!=='error'){
      if(!media.active)await until(()=>media.active||director.currentSpeech?.id!==id||!director.running||director.phase==='error')
      if(director.currentSpeech?.id!==id||!director.running||director.phase==='error')break
      const active=media.active;active.resolve();await until(()=>media.active!==active||director.currentSpeech?.id!==id||!director.running||director.phase==='error')
    }
    await until(()=>media.active||!director.running||director.phase==='error');return media.active
  }
  return { director, media, config, store, providers, sent, requests, dir, start, complete, setTime: value => { now = value }, advance: ms => { now += ms } }
}

test('the saved commerce persona and user edits reach model requests without replacing the director protocol',async t=>{
  const f=await fixture(t),prompt=getPersonaPreset('commerce').prompt+'\n请优先介绍当前商品的使用场景。'
  f.config.identity.personaId='commerce';f.config.identity.systemPrompt=prompt
  const messages=f.director._messages('source')
  assert.ok(messages[0].content.startsWith(prompt))
  assert.match(messages[0].content,/只输出JSON/)
  assert.equal(JSON.parse(messages[1].content).stage,'source')
  f.config.identity.personaId='custom';f.config.identity.systemPrompt='改为冷静、简洁地说明产品。'
  assert.ok(f.director._messages('question')[0].content.startsWith(f.config.identity.systemPrompt))
})

test('only aired source turns become memory; following text and audio are prepared during playback', async t => {
  const f = await fixture(t); await f.start(); assert.equal(f.director.stage, 'opening')
  await f.complete(); assert.equal(f.director.stage, 'source'); assert.equal(f.director.memory.turns, 0)
  await until(() => f.director.prepared?.phase === 'ready'); const prepared = f.director.prepared
  assert.match(JSON.stringify(f.requests.at(-1)), /尚未确认播完/)
  assert.equal(f.director.memory.turns, 0); await f.complete()
  assert.equal(f.director.memory.turns, 1); assert.equal(f.media.active.path, (await prepared.promise).audio)
})

test('a queued sale waits for the full utterance and preserves the current page for thirty minutes', async t => {
  const f = await fixture(t); await f.start(); await f.complete()
  const before = f.media.active, page = f.media.page
  f.director.queueSale(); assert.equal(f.media.active, before); assert.equal(f.director.status().sale.queued, true)
  await f.complete(); assert.equal(f.director.stage, 'sale'); assert.match(f.director.currentSpeech.text, /30分钟/)
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
  assert.equal(f.director.stage, 'lottery-result'); assert.match(f.media.active.text, /第一个有效用户/); assert.match(f.director.currentSpeech.text, /用户交流群/)
  await f.complete(); assert.equal(f.director.status().lottery.drawsUsed, 1)
  await f.director.restart(); await until(() => f.media.active); assert.equal(f.director.status().lottery.drawsUsed, 1)
})

test('a host question interrupts audio explicitly without marking the interrupted source as aired', async t => {
  const f = await fixture(t); await f.start(); await f.complete(); assert.equal(f.director.memory.turns, 0)
  await f.director.ask('主持人的实时问题',{interrupt:true}); await until(() => f.director.stage === 'question' && f.media.active)
  assert.equal(f.director.memory.turns, 0); assert.ok(f.requests.some(messages=>JSON.parse(messages[1].content).question==='主持人的实时问题'))
  assert.doesNotMatch(JSON.stringify(JSON.parse(f.requests.at(-1)[1].content)),/主持人的实时问题/)
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

test('three future paragraphs and their audio are produced during the opening, including future pages without flipping the live deck',async t=>{
 const f=await fixture(t,{generate:payload=>JSON.stringify({speech:'这是第'+payload.page.number+'页提前准备的讲解。',navigation:'next'})})
 f.config.program={enabled:{engagement:false}}
 const reads=[];f.media.readSlideAt=async number=>{reads.push(number);return {pageNumber:number,pageCount:2,pageKey:'page-'+number,title:'主题'+number,text:'当前页'+number+'的事实。',notes:'只讲真实事实。'}}
 await f.start();await until(()=>f.director.productionQueue.length===3&&f.director.productionQueue.every(entry=>entry.phase==='ready'))
 const queued=await Promise.all(f.director.productionQueue.map(entry=>entry.promise))
 assert.equal(f.media.page,1);assert.equal(f.director.memory.turns,0);assert.deepEqual(queued.map(turn=>turn.projection.page.pageNumber),[1,2,1]);assert.deepEqual(reads,[2,1])
 assert.ok(queued.every(turn=>turn.audio));assert.equal(f.director.status().production.ready,3)
 const firstPayload=JSON.parse(f.requests[0][1].content),secondPayload=JSON.parse(f.requests[1][1].content)
 assert.equal(firstPayload.aired.turns,0);assert.equal(secondPayload.aired.turns,0,'planned material is never reported as already aired')
 await f.complete();assert.equal(f.media.active.path,queued[0].audio)
 await f.complete();assert.equal(f.media.page,2);assert.equal(f.media.active.path,queued[1].audio);assert.equal(f.director.memory.turns,0)
})

test('all live Tencent chunks are short and synthesis starts ahead of playback consumption',async t=>{
 const text='这是一段需要预先准备的完整讲解。'.repeat(16),f=await fixture(t,{generate:()=>JSON.stringify({speech:text,navigation:'stay'})})
 f.config.tts.provider='tencent';f.config.program={enabled:{engagement:false}}
 const original=f.providers.synthesize,submitted=[]
 f.providers.synthesize=async(value,options)=>{submitted.push(value);assert.ok(Array.from(value).length<=40);return original(value,options)}
 await f.start();await until(()=>f.director.prepared?.phase==='ready')
 const ready=await f.director.prepared.promise;await until(()=>ready.audioReady===4)
 assert.equal(f.director.stage,'opening');assert.ok(ready.audioTotal>4);assert.equal(ready.audioReady,4,'future speech stops at its bounded initial window')
 await f.complete();await f.complete();await Promise.all(ready.audioParts)
 assert.equal(ready.audioReady,ready.audioTotal)
 const chunks=[ready.audio,...await Promise.all(ready.audioParts.slice(1))];assert.equal(chunks.length,ready.audioTotal)
 f.director.pause();assert.equal(f.director.productionQueue.length,0);assert.equal(f.director.status().production.ready,0)
})

test('a new audience request replaces stale plans with a reply and a lecture that applies the request without interrupting current speech',async t=>{
 const f=await fixture(t,{generate:payload=>JSON.stringify(payload.stage==='comment'?{speech:'可以，我们就用租房的例子接着说明。',navigation:'stay'}:payload.conversation.audienceRequests.some(row=>row.id==='need-example')?{speech:'按租房的例子看，云服务器相当于按需租用一台电脑。',navigation:'stay',appliedRequestIds:['need-example']}:{speech:'原来准备的普通讲解。',navigation:'stay'})})
 f.config.program={enabled:{engagement:false}}
 await f.start();await until(()=>f.director.productionQueue.length===3);await f.complete()
 const current=f.director.currentSpeech.id,stale=f.director.productionQueue.slice()
 f.director.addComments([{id:'need-example',nickname:'新观众',content:'我没听懂，能用租房的例子解释云服务器吗？'}])
 await until(()=>f.director.productionQueue.length===3&&f.director.productionQueue.every(entry=>entry.phase==='ready'))
 assert.equal(f.director.currentSpeech.id,current);assert.ok(stale.every(entry=>entry.controller.signal.aborted));assert.equal(f.director.productionQueue[0].kind,'comment')
 const plannedSource=f.requests.map(messages=>JSON.parse(messages[1].content)).find(payload=>payload.stage==='source'&&payload.conversation.audienceRequests.some(row=>row.id==='need-example'))
 assert.match(plannedSource.conversation.audienceRequests[0].content,/租房/);assert.equal(plannedSource.conversation.currentTransition.kind,'comment')
 assert.equal(f.director.conversation.requests[0].status,'pending','preparing a promise or an example does not mean it has aired')
 await f.complete();assert.equal(f.director.stage,'comment')
 await f.complete();assert.equal(f.director.stage,'source');assert.match(f.media.active.text,/按需租用/);assert.equal(f.director.conversation.requests[0].status,'answered')
 await f.complete();assert.equal(f.director.conversation.requests[0].status,'incorporated')
 f.director._savePage({pageNumber:2,pageCount:2,pageKey:'page-2',title:'下一页',text:'下一页资料。',notes:''})
 const next=JSON.parse(f.director._messages('source')[1].content)
 assert.ok(next.conversation.recentTurns.every(turn=>turn.kind==='source'),'answered replies are not injected into subsequent source history')
 assert.ok(next.conversation.activePreferences.some(row=>row.id==='need-example'))
})

test('interaction is grounded in the last aired point and audience answers remain available for the next lecture',async t=>{
 const f=await fixture(t,{generate:payload=>JSON.stringify({speech:payload.stage==='engagement'?'你更想了解电脑怎么租，还是租完能做什么？':'云服务器就像一台可以按需租用的电脑。',navigation:'stay'})})
 f.config.program={opening:false};f.config.live.engagementMinTurns=1;f.config.live.engagementCooldownSeconds=0
 await f.start();await f.complete();assert.equal(f.director.stage,'engagement')
 const interaction=f.requests.map(messages=>JSON.parse(messages[1].content)).findLast(payload=>payload.stage==='engagement')
 assert.match((interaction.conversation.lastSource||interaction.onAir.current).text,/按需租用的电脑/);assert.match(f.director._messages('engagement')[0].content,/具体要点/);assert.equal(interaction.instruction,undefined)
 await f.complete();f.director.addComments([{id:'answer-choice',content:'我选第二个，租完能做什么'}])
 const next=JSON.parse(f.director._messages('source')[1].content)
 assert.match(next.conversation.lastInteraction.text,/租完能做什么/);assert.match(next.conversation.audienceRequests.find(row=>row.id==='answer-choice').replyTo,/你更想了解/)
})

test('an audience request received during model generation regenerates an unplayed lecture with the fresh context',async t=>{
 let release,calls=0
 const f=await fixture(t,{generate:async payload=>{if(++calls===1)return new Promise(resolve=>release=()=>resolve(JSON.stringify({speech:'已经过时的讲解。'})));return JSON.stringify({speech:'新的讲解使用具体例子。',appliedRequestIds:['fresh-request']})}})
 f.config.program={opening:false,enabled:{engagement:false}}
 await f.director.start();await until(()=>release)
 f.director.addComments([{id:'fresh-request',content:'请用具体的例子讲。'}]);release();await until(()=>f.media.active)
 assert.equal(f.media.active.text,'新的讲解使用具体例子。');assert.equal(f.media.played.length,1);assert.equal(f.director.phase,'playing')
 assert.ok(f.requests.map(messages=>JSON.parse(messages[1].content)).some(payload=>payload.stage==='source'&&payload.conversation.audienceRequests.some(row=>row.id==='fresh-request')))
})
test('large conversation context stays inside provider limits and keeps the latest request, last point and exact persona',async t=>{
 const f=await fixture(t);f.config.identity.systemPrompt='人'.repeat(20000);f.config.presentation.notes='背景'.repeat(4000)
 f.director._savePage({pageNumber:1,pageCount:2,pageKey:'page-1',title:'当前主题',text:'材料'.repeat(6000),notes:'备注'.repeat(4000)})
 for(let i=0;i<15;i++){f.director.conversation.aired({id:'spoken-'+i,kind:i%2?'source':'engagement',text:'最近已经播出的内容。'.repeat(100)},1);f.director.addComments([{id:'question-'+i,nickname:'观众',content:'请解释这个具体问题。'.repeat(45)}])}
 const messages=f.director._messages('comment',{candidates:f.director._freshComments()})
 assert.ok(Buffer.byteLength(JSON.stringify(messages))<120000);assert.ok(messages[0].content.startsWith(f.config.identity.systemPrompt))
 const payload=JSON.parse(messages[1].content);assert.ok(payload.conversation.audienceRequests.some(row=>row.id==='c15'));assert.ok(payload.conversation.lastSource);assert.ok(payload.conversation.lastInteraction)
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
 const payload=JSON.parse(f.director._messages('question',{question:'当前在线人数和点赞是多少？'})[1].content)
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

test('a program without opening or closing starts at content and finishes after the current whole turn',async t=>{
 const f=await fixture(t);f.config.program={opening:false,closing:false}
 await f.start();assert.equal(f.director.stage,'source');const playing=f.media.active
 f.director.finish();assert.equal(f.media.active,playing)
 await f.complete();assert.equal(f.director.running,false)
 assert.equal(f.media.played.some(item=>item.text===f.config.identity.welcome||item.text===f.config.identity.goodbye),false)
})

test('disabled program stages block manual activities, automatic activities and model-proposed engagement',async t=>{
 const f=await fixture(t,{generate:payload=>JSON.stringify({speech:'继续讲解。',navigation:'stay',interaction:{type:'like',speech:'来点个赞。'}})})
 f.config.program={enabled:{source:true,comment:false,engagement:false,lottery:false,sale:false}}
 f.config.live.engagementMinTurns=1;f.config.live.engagementCooldownSeconds=0
 f.config.lottery.enabled=true;f.config.lottery.triggers=['comment'];f.config.lottery.commentTriggerKeyword='抽奖'
 f.config.sale.enabled=true
 await f.start();await f.complete()
 assert.throws(()=>f.director.queueLottery(),/未启用抽奖/);assert.throws(()=>f.director.queueSale(),/未启用秒杀/)
 f.director.addComments([{id:'disabled-rule',content:'抽奖'}]);f.director._automatic()
 assert.equal(f.director.record.lottery,null);assert.equal(f.director.record.sale,null)
 await f.complete();assert.equal(f.director.stage,'source');assert.equal(f.director.pendingInteraction,null)
 assert.equal(JSON.parse(f.director._messages('source')[1].content).interactionAllowed,false)
})

test('program order changes actual whole-turn scheduling and interaction does not depend on a model proposal',async t=>{
 const f=await fixture(t)
 f.config.program={opening:false,order:['source','engagement','comment','lottery','sale']}
 f.config.live.engagementMinTurns=1;f.config.live.engagementCooldownSeconds=0
 await f.start();assert.equal(f.director.stage,'source')
 f.director.addComments([{id:'sequence-comment',content:'我想了解一下'}])
 await f.complete();assert.equal(f.director.stage,'engagement')
 assert.ok(f.requests.some(messages=>JSON.parse(messages[1].content).stage==='engagement'))
 await f.complete();assert.equal(f.director.stage,'source')
 await f.complete();assert.equal(f.director.stage,'comment')
 await f.complete();assert.equal(f.director.stage,'source')
 await f.complete();assert.equal(f.director.stage,'engagement')
})

test('comment-only lottery ignores saved timers and popularity settings that were not selected',async t=>{
 const f=await fixture(t);Object.assign(f.config.lottery,{enabled:true,triggers:['comment'],commentTriggerKeyword:'抽奖',intervalMinutes:1,popularityThreshold:10,fixedTimes:['12:04']})
 await f.start();f.advance(60000);f.director.ingestMetrics({heat:999});f.director._automatic();assert.equal(f.director.record.lottery,null)
 f.director.addComments([{id:'not-a-command',content:'不是抽奖触发词'}]);f.director._automatic();assert.equal(f.director.record.lottery,null)
 f.director.addComments([{id:'start-a-draw',content:'抽奖'}]);f.director._automatic()
 assert.equal(f.director.record.lottery.state,'queued');assert.equal(f.director.record.lottery.automatic,true)
 assert.equal(f.director.record.triggerClaims.length,1);assert.match(f.director.record.triggerClaims[0],/lottery:comment:/)
})

test('multiple selected lottery rules merge simultaneous triggers into one draw and persist all claims',async t=>{
 const f=await fixture(t);Object.assign(f.config.lottery,{enabled:true,triggers:['comment','popularity','interval','fixed'],commentTriggerKeyword:'抽奖',popularityMetric:'onlineUsers',popularityThreshold:10,intervalMinutes:1,fixedTimes:['12:04']})
 await f.start();f.advance(60000);f.director.ingestMetrics({onlineUsers:12});f.director.addComments([{id:'combined-draw',content:'抽奖'}])
 f.director._automatic();const id=f.director.record.lottery.id
 assert.equal(f.director.record.triggerClaims.length,4)
 f.director._automatic();assert.equal(f.director.record.lottery.id,id)
 f.director.record.lottery.state='cancelled';f.director._automatic();assert.equal(f.director.record.lottery.id,id);assert.equal(f.director.record.lottery.state,'cancelled')
 const saved=JSON.parse(await readFile(join(f.dir,'director-history.json'),'utf8'));assert.equal(saved.triggerClaims.length,4)
})

test('online-user lottery uses the selected actual metric and does not substitute heat',async t=>{
 const f=await fixture(t);Object.assign(f.config.lottery,{enabled:true,triggers:['popularity'],popularityMetric:'onlineUsers',popularityThreshold:10})
 await f.start();f.director.ingestMetrics({heat:900,onlineUsers:9});f.director._automatic();assert.equal(f.director.record.lottery,null)
 f.director.ingestMetrics({onlineUsers:10});f.director._automatic();assert.equal(f.director.record.lottery.state,'queued')
 assert.match(f.director.record.triggerClaims[0],/lottery:onlineUsers:/)
})

test('a comment trigger survives unrelated-message buffer overflow and is consumed only once',async t=>{
 const f=await fixture(t);Object.assign(f.config.lottery,{enabled:true,triggers:['comment'],commentTriggerKeyword:'抽奖'})
 await f.start();f.director.addComments([{id:'first-command',content:'抽奖'},...Array.from({length:999},(_,i)=>({id:'noise-'+i,content:'围观'}))]);f.director._automatic()
 assert.equal(f.director.record.lottery.state,'queued');assert.equal(f.director.record.triggerClaims.length,1)
 f.director.record.lottery.state='cancelled';f.director._automatic();assert.equal(f.director.record.lottery.state,'cancelled')
})

test('disabling a queued lottery cancels it without consuming a prize',async t=>{
 const f=await fixture(t);await f.start();f.director.queueLottery();f.config.program={enabled:{lottery:false}};f.director.settingsChanged()
 assert.equal(f.director.record.lottery.state,'cancelled');assert.equal(f.director._prizeCount(),0)
 await f.complete();assert.equal(f.director.stage,'source')
})

test('intentional waiting in an interaction-only program does not trigger silence recovery',async t=>{
 const f=await fixture(t);f.config.program={opening:false,enabled:{source:false,comment:false,engagement:true,lottery:false,sale:false}};f.config.live.engagementCooldownSeconds=600
 await f.start();assert.equal(f.director.stage,'engagement')
 f.media.active.resolve();await until(()=>f.director.phase==='waiting')
 f.advance(121000);f.director._supervise();assert.equal(f.director.record.recoveries,0)
})


test('manual page changes update the picture immediately, preserve speech and replace old queued narration',async t=>{
 const f=await fixture(t,{sourceNavigation:'next'});f.media.readSlideAt=async n=>({pageNumber:n,pageCount:2,pageKey:'page-'+n,title:'主题'+n,text:'当前页'+n+'的事实。',notes:'只讲真实事实。'});await f.start();await f.complete()
 const playing=f.media.active;await until(()=>f.director.prepared?.phase==='ready')
 await f.director.navigatePresentation('next')
 assert.equal(f.media.page,2);assert.equal(f.media.active,playing);assert.equal(f.director.paused,false)
 await until(()=>f.director.prepared?.phase==='ready')
 assert.equal(f.director.prepared.page.pageNumber,2)
 await f.complete();assert.equal(f.media.page,2,'the old speech must not advance past the selected page')
 assert.equal(f.director.currentSpeech.pageKey,'page-2');assert.equal(f.director.memory.turns,0)

})
test('rapid manual changes ending on the original page still discard the old turn navigation',async t=>{
 const f=await fixture(t,{sourceNavigation:'next'});await f.start();await f.complete();const playing=f.media.active
 await Promise.all([f.director.navigatePresentation('next'),f.director.navigatePresentation('first')])
 assert.equal(f.media.page,1);assert.equal(f.media.active,playing)
 await f.complete();assert.equal(f.media.page,1);assert.equal(f.director.memory.turns,0);assert.equal(f.director.currentSpeech.pageKey,'page-1')
})

test('manual navigation during model generation discards the old page result before playback',async t=>{
 let release,entered=false
 const f=await fixture(t,{generate:async payload=>{if(payload.page.number===1){entered=true;await new Promise(r=>release=r)}return JSON.stringify({speech:'讲解第'+payload.page.number+'页。',navigation:'stay'})}})
 await f.start();f.media.active.resolve();await until(()=>entered)
 await f.director.navigatePresentation('next');release();await until(()=>f.media.active)
 assert.equal(f.director.currentSpeech.pageKey,'page-2');assert.equal(f.media.played.filter(p=>p.text==='讲解第1页。').length,0)
})

test('an hourly sale preempts ordinary program order at the next whole paragraph with its configured speech',async t=>{
 const f=await fixture(t);f.config.program={opening:true,closing:false,order:['source','engagement','comment','sale','lottery'],enabled:{source:true,engagement:true,comment:true,sale:true,lottery:false}}
 const start=Date.parse('2026-11-11T10:00:00+08:00')
 f.setTime(start-1000);f.config.sale={...f.config.sale,enabled:true,startAt:start,endAt:start+13*3600000,durationSeconds:300,announcement:'{{time}}整点秒杀。右上角入口展示{{minutes}}分钟，以活动页为准。'}
 await f.start();await f.complete();await until(()=>f.director.prepared?.phase==='ready')
 const current=f.media.active,page=f.media.page
 f.setTime(start);f.director._automatic();assert.equal(f.media.active,current)
 await f.complete();assert.equal(f.director.stage,'sale');assert.equal(f.director.currentSpeech.text,'10:00整点秒杀。右上角入口展示5分钟，以活动页为准。');assert.equal(f.media.page,page)
 assert.equal(f.director.record.sale.expiresAt-start,300000)
 await f.complete();assert.equal(f.director.stage,'source');assert.equal(f.media.page,page)
})

test('double eleven has thirteen hourly sales including 22:00 without keyword draws or duplicate claims',async t=>{
 const f=await fixture(t),start=Date.parse('2026-11-11T10:00:00+08:00')
 f.config.sale={...f.config.sale,enabled:true,startAt:start,endAt:start+12*3600000+1800000,durationSeconds:1800}
 f.config.lottery.enabled=false
 f.setTime(start-1000);await f.start();await f.complete()
 for(let hour=0;hour<=12;hour++){
  f.setTime(start+hour*3600000);f.director._automatic();assert.equal(f.director.status().sale.queued,true)
  f.director.hideSale();f.director._automatic();assert.equal(f.director.status().sale.queued,false)
 }
 assert.equal(f.director.record.saleClaims.length,13);assert.equal(f.director.record.lottery,null)
 f.setTime(start+13*3600000);f.director._automatic();assert.equal(f.director.status().sale.queued,false)
})

test('a long compatible-provider turn plays progressively, and a manual sale follows the whole turn after a page change',async t=>{
 const text='先解释一个实际任务，说明选择条件和限制。'.repeat(14),f=await fixture(t,{generate:payload=>JSON.stringify({speech:payload.stage==='source'?text:'回答问题。',navigation:'stay'})})
 f.config.program={opening:false,enabled:{engagement:false,comment:false,sale:true,lottery:false,source:true}}
 await f.start();const turn=f.director.currentSpeech;assert.ok(turn.audioTotal>4);assert.ok(Array.from(f.media.active.text).length<=24)
 await until(()=>turn.audioReady===4);assert.equal(turn.audioProgress.completed,0);assert.ok(f.media.queue.length<=2,'decoding only buffers two chunks after the audible chunk')
 await f.director.navigatePresentation('next');f.director.queueSale();assert.equal(f.director.currentSpeech.id,turn.id);assert.equal(f.media.page,2);assert.equal(f.director.memory.turns,0)
 await f.complete();assert.equal(turn.audioProgress.completed,turn.audioTotal);assert.equal(f.director.stage,'sale');assert.equal(f.media.page,2)
 await f.complete();assert.equal(f.director.stage,'source');assert.equal(f.director.currentSpeech.pageKey,'page-2')
})

test('stopping a partially prepared turn cancels workers waiting for more playback without airing or advancing it',async t=>{
 const f=await fixture(t,{generate:()=>JSON.stringify({speech:'这一段只在完整播完后计入讲解历史。'.repeat(14),navigation:'next'})});f.config.program={opening:false,enabled:{engagement:false}}
 await f.start();const turn=f.director.currentSpeech;await until(()=>turn.audioReady===4);f.director.stop();const results=await Promise.allSettled(turn.audioParts)
 assert.ok(results.some(row=>row.status==='rejected'));assert.equal(turn.audioProgress.waiters.size,0);assert.equal(f.media.active,null);assert.equal(f.media.page,1);assert.equal(f.director.memory.turns,0)
})

test('answered greeting is consumed once and cannot leak through a chain of speculative lectures',async t=>{
 const f=await fixture(t,{generate:p=>JSON.stringify(p.stage==='comment'?{speech:'这位朋友你好。',answeredIds:['c1']}:{speech:'接着解释资源配置。'})})
 f.config.live.engagementMinTurns=100
 await f.start();await f.complete()
 f.director.addComments([{id:'hello',content:'你好'}])
 await until(()=>f.director.productionQueue.length===3&&f.director.productionQueue.every(row=>row.phase==='ready'))
 const reply=f.director.productionQueue[0].turn
 assert.equal(reply.kind,'comment');assert.equal(f.director._freshComments().length,1)
 const afterGreeting=f.requests.map(m=>JSON.parse(m[1].content)).filter(p=>p.stage==='source'&&p.conversation.previousStage==='comment')
 assert.ok(afterGreeting.length);for(const p of afterGreeting)assert.doesNotMatch(JSON.stringify(p),/这位朋友你好|"hello"|你好/)
 const projection=await f.director._futureContext(reply)
 assert.equal(projection.bridge.kind,'comment')
 await f.complete();assert.equal(f.director.stage,'comment');assert.equal(f.director._freshComments().length,1)
 await f.complete();assert.equal(f.director.stage,'source');assert.equal(f.director._freshComments().length,0)
 assert.equal(f.director.status().continuity.pendingRequests,0)
 f.director.addComments([{id:'hello',content:'你好'}]);assert.equal(f.director.comments.length,1)
})

test('batch acknowledgement consumes only answered IDs, including when an older comment remains',async t=>{
 const f=await fixture(t,{generate:p=>JSON.stringify({speech:'直接回答第二个问题。',answeredIds:['c2'],selectedId:'c2'})})
 f.director.addComments([{id:'earlier',content:'第一个问题？'},{id:'later',content:'第二个问题？'}])
 const turn=await f.director._turn({kind:'comment',candidates:f.director._freshComments()},new AbortController().signal,f.director.epoch,{preparing:true})
 assert.equal(f.director._freshComments().length,2)
 f.director._aired(turn)
 assert.deepEqual(f.director._freshComments().map(row=>row.id),['earlier'])
 assert.deepEqual(f.director.conversation.outstanding().map(row=>row.id),['earlier'])
})

test('unprovided acknowledgement IDs and clipped batch replies are rejected before consuming comments',async t=>{
 for(const response of [{speech:'回复。',answeredIds:['missing']},{speech:'长'.repeat(200),answeredIds:['c1','c2']}]){
  const f=await fixture(t,{generate:()=>JSON.stringify(response)})
  f.director.addComments([{id:'a',content:'问题一？'},{id:'b',content:'问题二？'}])
  await assert.rejects(f.director._turn({kind:'comment',candidates:f.director._freshComments()},new AbortController().signal,f.director.epoch,{preparing:true}),/弹幕|回应超长/)
  assert.equal(f.director._freshComments().length,2)
 }
})

test('an overlong prepared batch does not cool model routes or stop lecture, and can be answered later', async t => {
  const f = await fixture(t)
  f.config.program = { opening: false, enabled: { engagement: false } }
  f.config.llm = {
    baseUrl: 'https://primary.test/v1', model: 'primary',
    fallbacks: [{ baseUrl: 'https://backup.test/v1', model: 'backup' }],
  }
  let commentAttempts = 0, rejectBatch = true
  const providers = new Providers({ store: f.store, dataDir: f.dir, fetchImpl: async (_url, options) => {
    const { messages } = JSON.parse(options.body)
    const comment = JSON.parse(messages[1].content).stage === 'comment'
    if (comment) commentAttempts++
    const reply = comment
      ? { speech: rejectBatch ? '长'.repeat(200) : '看到大家在问部署方式。先选适合的实例，再部署应用。', answeredIds: ['c1', 'c2'] }
      : { speech: '继续讲解当前页。', navigation: 'stay' }
    return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] })
  } })
  f.providers.generate = providers.generate.bind(providers)
  f.director.addComments([{ id: 'first', content: '怎么部署？' }, { id: 'second', content: '部署怎么弄？' }])
  await f.start()
  await until(() => f.director.prepared?.phase === 'error')
  await f.complete()

  assert.equal(f.director.stage, 'source')
  assert.equal(f.director.running, true)
  assert.equal(commentAttempts, 2, 'the rejected prepared batch already tried both routes')
  assert.ok(providers.status().modelRoutes.every(route => route.cooldownUntil === 0))
  assert.deepEqual(f.director._freshComments().map(row => row.id), ['first', 'second'])

  rejectBatch = false
  f.advance(31000)
  await f.complete()
  assert.equal(f.director.stage, 'comment')
  assert.deepEqual(f.director.currentSpeech.answeredIds, ['first', 'second'])
  await f.complete()
  assert.equal(f.director.stage, 'source')
  assert.equal(f.director._freshComments().length, 0)
})

test('an unreadable later speech chunk lets the current audio finish and continues the lecture', async t => {
 let turns=0
 const f=await fixture(t,{generate:()=>JSON.stringify({speech:++turns===1?'先把这个要点讲清楚。这个后续片段被语音服务拒绝，无法合成。':'接着讲解当前页。',navigation:'stay'})})
 f.config.program={opening:false,enabled:{engagement:false,comment:false}}
 const synthesize=f.providers.synthesize.bind(f.providers)
 f.providers.synthesize=async(text,options)=>{
  if(text.includes('语音服务拒绝'))throw Object.assign(new Error('语音服务拒绝了这段文本'),{code:'SPEECH_TEXT_REJECTED'})
  return synthesize(text,options)
 }
 await f.start()
 const interrupted=f.director.currentSpeech,active=f.media.active
 await until(()=>interrupted.audioProgress.error)
 assert.equal(f.media.active,active)
 await f.complete()
 assert.ok(interrupted.speechRejected)
 assert.equal(f.director.memory.turns,0)
 assert.equal(f.director.stage,'source')
 assert.ok(f.director.running)
 assert.equal(f.media.active.text,'接着讲解当前页。')
})

test('a timed-out middle chunk does not discard ready audio after it',async t=>{
 const first='我们先把第一个要点讲清楚。',middle='这是会超时的片段，稍后我们会继续剩余的内容。',next='这是已经准备好的下一段，接着解释操作步骤。'
 let turns=0
 const f=await fixture(t,{generate:()=>JSON.stringify({speech:++turns===1?first+middle+next:'继续当前页的另一个要点。',navigation:'stay'})})
 f.config.program={opening:false,enabled:{engagement:false,comment:false}}
 const synthesize=f.providers.synthesize.bind(f.providers)
 f.providers.synthesize=async(text,options)=>{
  if(text.includes('会超时')){assert.ok(options.skipOnTimeout);throw Object.assign(new Error('语音合成超时'),{code:'SPEECH_TIMEOUT'})}
  return synthesize(text,options)
 }
 await f.start();const turn=f.director.currentSpeech
 await f.complete()
 assert.equal(turn.speechTimedOut,true)
 assert.deepEqual(f.media.played.slice(0,2).map(item=>item.text),[first,next])
 assert.equal(f.director.memory.turns,0)
 assert.equal(f.director.stage,'source');assert.ok(f.director.running)
})

test('a timed-out opening advances to the lecture without retrying the opening',async t=>{
 const f=await fixture(t);let openingAttempts=0
 const synthesize=f.providers.synthesize.bind(f.providers)
 f.providers.synthesize=async(text,options)=>{
  if(text===f.config.identity.welcome){openingAttempts++;throw Object.assign(new Error('语音合成超时'),{code:'SPEECH_TIMEOUT'})}
  return synthesize(text,options)
 }
 await f.start()
 assert.equal(openingAttempts,1);assert.equal(f.director.stage,'source');assert.ok(f.director.running)
})

test('per-stage contexts contain shared persona and only stage-relevant dynamic data',async t=>{
 const f=await fixture(t)
 f.director._savePage(await f.media.readSlide())
 f.director.ingestMetrics({onlineUsers:18})
 f.director.conversation.aired({id:'source',kind:'source',text:'刚讲了云端部署的资源配置。'},1)
 f.director.conversation.aired({id:'interaction',kind:'engagement',text:'想听部署还是计费？'},1)
 f.director.addComments([{id:'hello',content:'你好'},{id:'metrics',content:'现在在线人数是多少？'},{id:'example',content:'用租房举个例子'}])
 const payload=(kind,options)=>JSON.parse(f.director._messages(kind,options)[1].content)
 const source=payload('source')
 assert.deepEqual(source.conversation.audienceRequests.map(row=>row.id),['example'])
 assert.equal(source.metrics,undefined);assert.equal(source.sale,undefined);assert.equal(source.lottery,undefined);assert.equal(source.candidates,undefined)
 assert.equal(source.conversation.lastInteraction,null);assert.match(source.conversation.lastSource.text,/资源配置/)
 const comment=payload('comment',{candidates:f.director._freshComments().filter(row=>row.id==='metrics')})
 assert.deepEqual(comment.candidates.map(row=>row.id),['c1']);assert.equal(comment.metrics.onlineUsers,18)
 assert.deepEqual(comment.conversation.audienceRequests.map(row=>row.id),['c1'])
 const engagement=payload('engagement');assert.equal(engagement.candidates,undefined);assert.equal(engagement.metrics,undefined);assert.equal(engagement.sale,undefined);assert.deepEqual(engagement.conversation.audienceRequests,[])
 const question=payload('question',{question:'现在有什么秒杀活动？'})
 assert.ok(question.sale);assert.equal(question.metrics,undefined);assert.equal(question.candidates,undefined)
 for(const kind of ['source','comment','engagement','question'])assert.ok(f.director._messages(kind)[0].content.startsWith(f.config.identity.systemPrompt))
 for(const kind of ['opening','closing','sale','cue','lottery'])assert.throws(()=>f.director._messages(kind),/固定编排/)
})

test('actual playback, planned predecessor and one-hop requirements have distinct lifecycles',async t=>{
 const f=await fixture(t)
 f.director._savePage(await f.media.readSlide())
 f.director.currentSpeech={id:'actual',kind:'source',text:'此刻真正播放的内容。'}
 f.director.addComments([{id:'ex',content:'请用租房的例子解释'}])
 const transition={page:f.director.page,memory:f.director.memory,previousKind:'comment',bridge:{kind:'comment',text:'观众你好，我接着讲。',audienceIds:['ex']},plannedRequestIds:[]}
 const first=JSON.parse(f.director._messages('source',{after:'观众你好，我接着讲。',context:transition})[1].content)
 assert.equal(first.onAir.current.text,'此刻真正播放的内容。');assert.equal(first.plannedPredecessor,undefined)
 assert.deepEqual(first.conversation.currentTransition.requirements,['请用租房的例子解释']);assert.doesNotMatch(JSON.stringify(first),/观众你好/)
 const next=await f.director._futureContext({id:'future',kind:'source',text:'下一段计划举例。',projection:transition,appliedRequestIds:['ex'],navigation:'stay'})
 assert.equal(next.bridge,null)
 const second=JSON.parse(f.director._messages('source',{after:'下一段计划举例。',context:next})[1].content)
 assert.equal(second.onAir.current.text,'此刻真正播放的内容。');assert.equal(second.plannedPredecessor,'下一段计划举例。')
 assert.deepEqual(second.conversation.audienceRequests,[]);assert.equal(second.conversation.currentTransition,null)
 assert.equal(f.director.conversation.outstanding().length,1)
})

test('a thousand-comment burst sends the complete latest hundred and a common reply acknowledges all only after playback',async t=>{
 const f=await fixture(t,{generate:p=>JSON.stringify(p.stage==='comment'?{speech:'看到大家在催秒杀了，本轮入口已在PPT右上角展示，大家可以扫码参与。',answeredIds:['c1-c100'],selectedId:null}:{speech:'接着介绍当前产品的用途。'})})
 f.config.live.engagementMinTurns=100;await f.start();await f.complete()
 f.director.addComments(Array.from({length:1000},(_,i)=>({id:'burst-'+i,nickname:'观众'+i,content:'开启秒杀'})))
 await until(()=>f.director.productionQueue.length===3&&f.director.productionQueue.every(row=>row.phase==='ready'))
 const payload=f.requests.map(m=>JSON.parse(m[1].content)).findLast(p=>p.stage==='comment')
 assert.equal(payload.candidates.length,100);assert.equal(payload.candidates[0].nickname,'观众900');assert.equal(payload.candidates[99].nickname,'观众999')
 assert.equal(payload.candidates[99].id,'c100');assert.equal(f.director._freshComments().length,100)
 await f.complete();assert.equal(f.director.stage,'comment');assert.equal(f.director._freshComments().length,100)
 await f.complete();assert.equal(f.director._freshComments().length,0)
 assert.ok(f.director.comments.every(row=>row.respondedAt));assert.equal(f.director.comments.length,100)
 const nextWindow=f.director._commentWindow();assert.equal(nextWindow.length,100);assert.ok(nextWindow.every(row=>!row.canReply))
})

test('the model can select the last message in a hundred while all other messages stay unread',async t=>{
 const f=await fixture(t,{generate:()=>JSON.stringify({speech:'最后这位朋友问到了用途，我们直接说应用后端。',selectedId:'c100',answeredIds:['c100']})})
 f.director.addComments(Array.from({length:100},(_,i)=>({id:'point-'+i,nickname:'观众'+i,content:'问题'+i+'？'})))
 const turn=await f.director._turn({kind:'comment',candidates:f.director._commentWindow()},new AbortController().signal,f.director.epoch,{preparing:true})
 assert.equal(turn.selectedId,'point-99');assert.deepEqual(turn.audienceIds,['point-99']);assert.equal(turn.audienceComments[0].nickname,'观众99')
 f.director._aired(turn);assert.equal(f.director._freshComments().length,99);assert.equal(f.director._freshComments()[0].id,'point-0')
})

test('already answered and expired messages remain visible background but cannot be acknowledged again',async t=>{
 const f=await fixture(t,{generate:()=>JSON.stringify({speech:'重复答复。',answeredIds:['c1']})})
 f.director.addComments([{id:'old',nickname:'旧观众',content:'之前的提问？'},{id:'new',nickname:'新观众',content:'现在的提问？'}]);f.director.comments[0].respondedAt=Date.now()
 const window=f.director._commentWindow(),p=JSON.parse(f.director._messages('comment',{candidates:window})[1].content)
 assert.equal(p.candidates.length,2);assert.equal(p.candidates[0].canReply,false);assert.equal(p.candidates[1].canReply,true)
 await assert.rejects(f.director._turn({kind:'comment',candidates:window},new AbortController().signal,f.director.epoch,{preparing:true}),/未提供的待回应弹幕/)
 assert.deepEqual(f.director._freshComments().map(row=>row.id),['new'])
})

test('all hundred survive oversized persona, original IDs, nicknames, content and slide notes within the provider budget',async t=>{
 const f=await fixture(t);f.config.identity.systemPrompt='人'.repeat(20000);f.config.presentation.notes='背景'.repeat(4000)
 f.director._savePage({pageNumber:1,pageCount:2,pageKey:'page-1',title:'当前主题',text:'材料'.repeat(6000),notes:'备注'.repeat(4000)})
 f.director.addComments(Array.from({length:1000},(_,i)=>({id:'号'.repeat(130)+i,nickname:'名'.repeat(100),content:'长文字“测试”\\\n'.repeat(60)})))
 const messages=f.director._messages('comment',{candidates:f.director._commentWindow()}),p=JSON.parse(messages[1].content)
 assert.equal(p.candidates.length,100);assert.ok(Buffer.byteLength(JSON.stringify(messages))<120000)
 assert.ok(p.candidates.some(row=>row.contentTruncated));assert.equal(p.candidates[0].id,'c1');assert.equal(p.candidates.at(-1).id,'c100')
 assert.ok(messages[0].content.startsWith(f.config.identity.systemPrompt))
})

test('a response uses its own snapshot references after another hundred replace the window',async t=>{
 const f=await fixture(t,{generate:()=>JSON.stringify({speech:'回答这批共同问题。',answeredIds:['c1','c100']})})
 f.director.addComments(Array.from({length:100},(_,i)=>({id:'before-'+i,content:'同一问题？'})))
 const turn=await f.director._turn({kind:'comment',candidates:f.director._commentWindow()},new AbortController().signal,f.director.epoch,{preparing:true})
 f.director.addComments(Array.from({length:100},(_,i)=>({id:'after-'+i,content:'全新问题？'})))
 f.director._aired(turn);assert.equal(f.director._freshComments().length,100);assert.ok(f.director.comments.every(row=>!row.respondedAt))
 assert.deepEqual(turn.audienceIds,['before-0','before-99'])
})

test('compact acknowledgement permits one hundred references and rejects over-limit or malformed output',()=>{
 const ids=Array.from({length:100},(_,i)=>'c'+(i+1))
 assert.equal(parseTurn(JSON.stringify({speech:'统一回应。',answeredIds:ids})).answeredIds.length,100)
 assert.throws(()=>parseTurn(JSON.stringify({speech:'无效回应。',answeredIds:[...ids,'c101']})),/引用格式/)
})

test('three distinct paragraph slots are planned on one page and early model next requests cannot flip it',async t=>{
 const f=await fixture(t,{sourceNavigation:'next'});f.config.live.minPageTurns=3;f.config.program={enabled:{engagement:false}}
 const reads=[];f.media.readSlideAt=async n=>{reads.push(n);return{pageNumber:n,pageCount:2,pageKey:'page-'+n,title:'主题'+n,text:'第'+n+'页的事实。',notes:''}}
 await f.start();await until(()=>f.director.productionQueue.length===3&&f.director.productionQueue.every(e=>e.phase==='ready'))
 const queue=f.director.productionQueue;assert.deepEqual(queue.map(e=>e.page.pageNumber),[1,1,1]);assert.deepEqual(queue.map(e=>e.paragraphNumber),[1,2,3]);assert.deepEqual(queue.map(e=>e.turn.navigation),['stay','stay','next']);assert.equal(f.director.memory.turns,0)
 const first=f.requests.slice(0,3).map(m=>JSON.parse(m[1].content).pageProgress);assert.deepEqual(first.map(p=>p.turnNumber),[1,2,3]);assert.deepEqual(first.map(p=>p.canAdvanceAfterThisTurn),[false,false,true]);assert.equal(new Set(first.map(p=>p.focus)).size,3)
 await f.complete();assert.equal(f.director.stage,'source');await f.complete();assert.equal(f.media.page,1);assert.equal(f.director.memory.turns,1)
 await f.complete();assert.equal(f.media.page,1);assert.equal(f.director.memory.turns,2)
 await f.complete();assert.equal(f.media.page,2);assert.equal(f.director.memory.turns,0);assert.ok(reads.includes(2))
})

test('two separate comment replies interrupt the same page after two paragraphs each and are prepared while speech is playing',async t=>{
 const f=await fixture(t,{sourceNavigation:'next'});f.config.live.minPageTurns=6;f.config.live.commentFrequency=50;f.config.program={enabled:{engagement:false}}
 await f.start();await f.complete();f.director.addComments([{id:'first-batch',content:'开启秒杀'}])
 await f.complete();assert.equal(f.director.stage,'source');assert.equal(f.director.memory.turns,1)
 await until(()=>f.director.prepared?.kind==='comment'&&f.director.prepared.phase==='ready');const firstReady=f.director.prepared.turn.audio
 await f.complete();assert.equal(f.director.stage,'comment');assert.equal(f.media.active.path,firstReady);assert.equal(f.director.memory.turns,2);assert.equal(f.media.page,1)
 await f.complete();assert.equal(f.director.stage,'source');f.director.addComments([{id:'second-batch',content:'快开秒杀'}])
 await f.complete();assert.equal(f.director.stage,'source');assert.equal(f.director.memory.turns,3)
 await until(()=>f.director.prepared?.kind==='comment'&&f.director.prepared.phase==='ready');await f.complete()
 assert.equal(f.director.stage,'comment');assert.equal(f.director.memory.turns,4);assert.equal(f.media.page,1)
 assert.deepEqual(f.director.conversation.turns.filter(t=>t.kind!=='opening').map(t=>t.kind),['source','source','comment','source','source'])
 await f.complete();assert.equal(f.director.stage,'source');assert.equal(f.director.memory.turns,4)
})

test('continuous questions and proactive engagement have independent frequencies with narration between interludes',async t=>{
 const f=await fixture(t);f.config.live.minPageTurns=8;f.config.live.engagementMinTurns=3;f.config.live.engagementCooldownSeconds=0
 await f.start();await f.complete();f.director.addComments(Array.from({length:10},(_,i)=>({id:'many-'+i,content:'问题'+i+'？'})))
 for(let n=0;n<8;n++)await f.complete()
 const kinds=f.director.conversation.turns.filter(t=>t.kind!=='opening').map(t=>t.kind)
 assert.ok(kinds.filter(k=>k==='comment').length>kinds.filter(k=>k==='engagement').length)
 assert.ok(kinds.includes('engagement'));assert.equal(f.media.page,1)
 for(let n=1;n<kinds.length;n++)assert.ok(!(kinds[n]!=='source'&&kinds[n-1]!=='source'),kinds.join(','))
})

test('reaching the minimum does not force a page to advance before the model finishes its remaining points',async t=>{
 const f=await fixture(t,{generate:p=>JSON.stringify({speech:'展开当前页新的要点。',navigation:p.pageProgress?.turnNumber>=5?'next':'stay'})});f.config.live.minPageTurns=3;f.config.program={enabled:{engagement:false}}
 await f.start();await f.complete();for(let n=1;n<=4;n++){await f.complete();assert.equal(f.media.page,1);assert.equal(f.director.memory.turns,n)}
 await f.complete();assert.equal(f.media.page,2)
})

test('manual page changes bypass the minimum immediately and restart paragraph accounting on the selected page',async t=>{
 const f=await fixture(t,{sourceNavigation:'next'});f.config.live.minPageTurns=3;f.config.program={enabled:{engagement:false}}
 await f.start();await f.complete();const old=f.media.active;await f.director.navigatePresentation('next');assert.equal(f.media.page,2);assert.equal(f.media.active,old)
 await f.complete();assert.equal(f.media.page,2);assert.equal(f.director.memory.turns,0);assert.equal(f.director.currentSpeech.navigation,'stay');assert.equal(f.director.status().currentSpeech.paragraphNumber,1)
})

test('an eligible automatic lottery is not starved by repeated comments and proactive engagement',async t=>{
 const f=await fixture(t);f.config.live.engagementMinTurns=1;f.config.live.engagementCooldownSeconds=0;f.config.program={order:['source','lottery','comment','engagement','sale']}
 await f.start();await f.complete();f.director.addComments([{id:'q-before-draw',content:'如何使用？'}]);f.director.queueLottery({automatic:true})
 await f.complete();assert.equal(f.director.stage,'lottery-announcement')
})
