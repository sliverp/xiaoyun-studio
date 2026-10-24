import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Providers, splitSpeech, pcmWav } from '../server/providers.mjs'

const fakeStore = (config, secrets = {}) => ({ get: () => config, secret: key => secrets[key] || '' })
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'studio-provider-')); t.after(() => rm(path, { recursive: true, force: true })); return path }

test('model failures use the configured fallback and redact provider credentials', async t => {
  const dataDir = await directory(t), calls = [], secret = 'private-primary-key'
  const store = fakeStore({ llm: { baseUrl: 'https://primary.test/v1', model: 'primary', fallbacks: [{ baseUrl: 'https://backup.test/v1', model: 'backup', keyName: 'backupKey' }] } }, { llmKey: secret, backupKey: 'private-backup-key' })
  const providers = new Providers({ store, dataDir, fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return url.includes('primary') ? Response.json({ error: { message: 'failed: ' + secret } }, { status: 503 }) : Response.json({ choices: [{ message: { content: '{"speech":"备用通道回复。"}' } }] })
  } })
  assert.match(await providers.generate([{ role: 'user', content: '你好' }]), /备用通道/)
  assert.equal(calls.length, 2); assert.match(calls[1].url, /backup.test\/v1\/chat\/completions/)
  assert.equal(providers.status().fallback, true); assert.doesNotMatch(JSON.stringify(providers.status()), /private-/)
  assert.equal(providers.redact('failed: ' + secret), 'failed: [redacted]')
})

test('missing credentials and caller cancellation do not submit a model request', async t => {
  const providers = new Providers({ store: fakeStore({ llm: {} }), dataDir: await directory(t), fetchImpl() { assert.fail('no request expected') } })
  await assert.rejects(providers.generate([{ role: 'user', content: 'hello' }]), /请配置模型/)
  const controller = new AbortController(); controller.abort(new Error('caller stopped'))
  await assert.rejects(providers.generate([{ role: 'user', content: 'hello' }], { signal: controller.signal }), /caller stopped/)
})

test('speech chunks preserve every character and fit both provider limits', () => {
  const text = ('完整的一句话，不可以读一半去回应弹幕。🙂').repeat(40), parts = splitSpeech(text)
  assert.equal(parts.join(''), text)
  assert.ok(parts.every(part => Array.from(part).length <= 150 && Buffer.byteLength(part) <= 450))
  const wav = pcmWav(Buffer.alloc(48000)); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt32LE(40), 48000)
})

test('compatible speech caches real audio privately and preserves the selected voice', async t => {
  const dataDir = await directory(t); let calls = 0
  const providers = new Providers({ dataDir, store: fakeStore({ tts: { provider: 'openai', baseUrl: 'https://speech.test/v1', voice: 'clear', speed: .95 } }, { ttsKey: 'speech-key' }), fetchImpl: async (url, options) => {
    calls++; assert.match(url, /audio\/speech$/); const request = JSON.parse(options.body); assert.equal(request.voice, 'clear'); assert.equal(request.speed, .95)
    return new Response(Buffer.alloc(100, 8), { headers: { 'Content-Type': 'audio/mpeg' } })
  } })
  const first = await providers.synthesize('完整的一段口播。'), second = await providers.synthesize('完整的一段口播。')
  assert.equal(first, second); assert.equal(calls, 1); assert.equal((await readFile(first)).length, 100); assert.equal((await stat(first)).mode & 0o777, 0o600)
})

test('demo audio can never be presented as newly synthesized arbitrary text', async t => {
  const dataDir = await directory(t), file = join(dataDir, 'demo.wav'); await writeFile(file, pcmWav(Buffer.alloc(100)))
  const providers = new Providers({ store: fakeStore({ tts: { provider: 'demo', demoAsset: file, demoText: '固定试听。' } }), dataDir })
  assert.equal(await providers.synthesize('固定试听。'), file)
  await assert.rejects(providers.synthesize('现场随便编造的一段内容。'), /只提供标注的固定试听录音/)
})

test('recognition uses the configured backend and returns only actual recognized text', async t => {
  const providers = new Providers({ dataDir: await directory(t), store: fakeStore({ asr: { baseUrl: 'https://asr.test/v1' } }), fetchImpl: async (url, options) => {
    assert.match(url, /audio\/transcriptions$/); assert.ok(options.body instanceof FormData)
    return Response.json({ text: '识别结果。' })
  } })
  assert.equal(await providers.transcribe(Buffer.from([1, 2, 3]), 'audio/webm'), '识别结果。')
})
