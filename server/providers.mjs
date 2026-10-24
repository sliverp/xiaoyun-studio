/** Direct model, speech and recognition clients; no harness or browser playback dependency. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const endpoint = (base, suffix) => {
  const url = new URL(String(base || '').replace(/\/$/, '') + suffix)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('服务地址必须是 HTTP/HTTPS 地址')
  return url.href
}
const combinedSignal = (signal, timeout) => AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])])
const checkAbort = signal => { if (signal?.aborted) throw signal.reason || new Error('操作已取消') }

/** Split at punctuation while preserving all spoken text within Tencent's byte/character limits. */
export function splitSpeech(text, maxCharacters = 150, maxBytes = 450) {
  const chars = Array.from(String(text)), parts = []
  let start = 0
  while (start < chars.length) {
    let end = start, bytes = 0, sentence = 0, clause = 0
    while (end < chars.length && end - start < maxCharacters) {
      const char = chars[end], size = Buffer.byteLength(char)
      if (bytes + size > maxBytes) break
      bytes += size; end++
      if (/[。！？!?；;\n]/u.test(char)) sentence = end
      else if (/[，,：:\s]/u.test(char)) clause = end
    }
    const cut = end === chars.length ? end : sentence || clause || end
    if (cut <= start) throw new Error('语音字符超出单段限制')
    const part = chars.slice(start, cut).join('')
    if (part.trim()) parts.push(part)
    start = cut
  }
  return parts
}

/** Build a PCM WAV container for Tencent's raw signed 16-bit audio. */
export function pcmWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Bound HTTP payloads and surface only non-secret provider errors. */
async function readBounded(response, limit = 24 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('服务响应过大')
  const chunks = []; let size = 0
  for await (const chunk of response.body || []) {
    size += chunk.length
    if (size > limit) throw new Error('服务响应过大')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export class Providers {
  constructor({ store, dataDir, fetchImpl = fetch }) {
    this.store = store; this.dataDir = resolve(dataDir); this.fetch = fetchImpl
    this.audioDir = join(this.dataDir, 'audio'); this.cooldowns = new Map(); this.preferred = 0
    this.modelState = { route: 0, label: '', fallback: false, error: '', changedAt: 0 }
  }

  redact(value) {
    let text = String(value?.message || value || '')
    const config = this.store.get()
    for (const name of ['llmKey', 'ttsKey', 'tencentSecretId', 'tencentSecretKey', 'streamKey', ...(config.llm?.fallbacks || []).map(item => item.keyName)]) {
      const secret = name && this.store.secret(name)
      if (secret) text = text.split(String(secret)).join('[redacted]')
    }
    return text.replace(/(?:sk-|AKID)[A-Za-z0-9_-]{8,}/g, '[redacted]').slice(0, 350)
  }

  status() {
    const c = this.store.get()
    return {
      ...this.modelState,
      modelConfigured: [{...c.llm,keyName:'llmKey'},...(c.llm?.fallbacks||[])].some(route=>Boolean(route.baseUrl&&route.model&&this.store.secret(route.keyName||'llmKey'))),
      speechConfigured: c.tts?.provider === 'demo' ? Boolean(c.tts?.demoAsset) : c.tts?.provider === 'tencent' ? Boolean(this.store.secret('tencentSecretId') && this.store.secret('tencentSecretKey')) : Boolean(c.tts?.baseUrl && this.store.secret('ttsKey')),
      recognitionConfigured: Boolean(c.asr?.baseUrl), demo: c.tts?.provider === 'demo',
    }
  }

  async generate(messages, { signal, json = true } = {}) {
    const cfg = this.store.get().llm || {}
    const routes = [{ ...cfg, keyName: 'llmKey', label: cfg.model || '主模型' }, ...(cfg.fallbacks || [])].slice(0, 5)
    if (!Array.isArray(messages) || !messages.length) throw new Error('模型消息不能为空')
    const bodySize = Buffer.byteLength(JSON.stringify(messages))
    if (bodySize > 120000) throw new Error('本轮模型上下文超出120KB限制')
    let failure = '请配置模型地址、模型名称和 API Key'
    const primaryReady = Date.now() >= (this.cooldowns.get(0) || 0)
    const order = [...new Set([primaryReady ? 0 : this.preferred, ...routes.map((_, index) => index)])]
    let attempted = false
    for (const index of order) {
      checkAbort(signal)
      const route = routes[index], key = this.store.secret(route.keyName || 'llmKey')
      if (!route.baseUrl || !route.model || !key) continue
      if ((this.cooldowns.get(index) || 0) > Date.now() && index !== this.preferred) continue
      attempted = true
      try {
        const timeout = Number(route.timeoutMs) || (index === 0 && routes.length > 1 ? 10000 : 30000)
        const response = await this.fetch(endpoint(route.baseUrl, '/chat/completions'), {
          method: 'POST', signal: combinedSignal(signal, Math.min(120000, Math.max(1000, timeout))),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: route.model, messages, stream: false, max_tokens: cfg.maxTokens || 1600, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
        })
        const raw = await readBounded(response, 2 * 1024 * 1024)
        if (!response.ok) {
          let detail = ''
          try { detail = JSON.parse(raw).error?.message || '' } catch { /* Non-JSON upstream errors use only their status. */ }
          throw new Error(`模型服务 HTTP ${response.status}${detail ? ': ' + detail.slice(0, 200) : ''}`)
        }
        let value
        try { value = JSON.parse(raw) } catch { throw new Error('模型返回了无效 JSON 响应') }
        const text = value.choices?.[0]?.message?.content
        if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回文本内容')
        this.preferred = index; this.cooldowns.delete(index)
        this.modelState = { route: index, label: route.label || route.model, model: route.model, fallback: index > 0, error: '', changedAt: Date.now() }
        return text.trim()
      } catch (error) {
        checkAbort(signal)
        failure = this.redact(error)
        this.cooldowns.set(index, Date.now() + 300000)
        this.modelState.error = failure
      }
    }
    throw new Error(attempted ? '所有模型通道均未完成：' + failure : failure)
  }

  async synthesize(text, { signal } = {}) {
    checkAbort(signal)
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('播报文本应为1–4000字')
    const cfg = this.store.get().tts || {}
    if (cfg.provider === 'demo') {
      if (!cfg.demoAsset || text.trim() !== String(cfg.demoText || '').trim()) throw new Error('演示模式只提供标注的固定试听录音；请配置语音服务后播报自定义文本')
      const path = isAbsolute(cfg.demoAsset) ? cfg.demoAsset : resolve(this.dataDir, cfg.demoAsset)
      await stat(path); return path
    }
    await mkdir(this.audioDir, { recursive: true, mode: 0o700 })
    const key = createHash('sha256').update(JSON.stringify({ text, provider: cfg.provider, voice: cfg.voice, speed: cfg.speed, model: cfg.model, baseUrl: cfg.baseUrl })).digest('hex')
    const output = join(this.audioDir, key + (cfg.provider === 'tencent' ? '.wav' : '.mp3'))
    try { const cached = await stat(output); if (cached.size > 44) return output } catch (error) { if (error.code !== 'ENOENT') throw error }
    let audio
    try {
      if (cfg.provider === 'tencent') audio = await this.tencentSpeech(text, cfg, signal)
      else if (cfg.provider === 'openai') {
        const apiKey = this.store.secret('ttsKey')
        if (!apiKey || !cfg.baseUrl) throw new Error('请配置语音服务地址和 API Key')
        const response = await this.fetch(endpoint(cfg.baseUrl, '/audio/speech'), {
          method: 'POST', signal: combinedSignal(signal, 60000),
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.model || 'tts-1', voice: cfg.voice || 'alloy', input: text, speed: Number(cfg.speed) || 1, response_format: 'mp3' }),
        })
        if (!response.ok) throw new Error(`语音服务 HTTP ${response.status}`)
        const type=response.headers.get('content-type')||''
        if(/(?:json|text\/)/i.test(type))throw new Error('语音服务返回了非音频响应')
        audio = await readBounded(response)
      } else throw new Error('请选择腾讯云或兼容的语音合成服务')
      checkAbort(signal)
      if (!audio?.length) throw new Error('语音服务没有返回音频')
      const temporary=output+'.'+randomUUID()+'.tmp'
      await writeFile(temporary,audio,{mode:0o600});await rename(temporary,output)
      await this.pruneAudio(output)
      return output
    } catch (error) { throw new Error(this.redact(error)) }
  }

  async tencentSpeech(text, cfg, signal) {
    const secretId = this.store.secret('tencentSecretId'), secretKey = this.store.secret('tencentSecretKey')
    if (!secretId || !secretKey) throw new Error('请配置腾讯云 SecretId 和 SecretKey')
    const voice = Number(cfg.voice) || 602003, rate = Number(cfg.speed) || 1
    if (rate < .6 || rate > 2.5) throw new Error('语速应为0.6–2.5倍')
    const speed = Math.round((rate < 1.2 ? (rate - 1) * 5 : rate < 1.5 ? 1 + (rate - 1.2) / .3 : 2 + (rate - 1.5) * 4) * 100) / 100
    const sdk = require('tencentcloud-sdk-nodejs-tts')
    const client = new sdk.tts.v20190823.Client({ credential: { secretId, secretKey }, region: cfg.region || 'ap-guangzhou', profile: { httpProfile: { endpoint: 'tts.tencentcloudapi.com', reqTimeout: 30 } } })
    const parts = []
    for (const part of splitSpeech(text)) {
      checkAbort(signal)
      const result = await new Promise((resolvePromise, reject) => {
        const abort = () => reject(signal.reason || new Error('语音合成已取消'))
        signal?.addEventListener('abort', abort, { once: true })
        client.TextToVoice({ Text: part, SessionId: randomUUID(), VoiceType: voice, SampleRate: 24000, Codec: 'pcm', Speed: speed, Volume: 0, ModelType: 1 }).then(resolvePromise, reject).finally(() => signal?.removeEventListener('abort', abort))
      })
      if (typeof result.Audio !== 'string' || !result.Audio) throw new Error('腾讯云未返回合成音频')
      parts.push(Buffer.from(result.Audio, 'base64'))
    }
    return pcmWav(Buffer.concat(parts))
  }

  async transcribe(buffer, mime = 'audio/webm', { signal } = {}) {
    const cfg = this.store.get().asr || {}
    if (!cfg.baseUrl) throw new Error('请先配置语音识别服务地址')
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error('录音为空或超过20MB')
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mime }), mime.includes('wav') ? 'speech.wav' : 'speech.webm')
    form.append('model', cfg.model || 'sensevoice')
    const response = await this.fetch(endpoint(cfg.baseUrl, '/audio/transcriptions'), { method: 'POST', body: form, signal: combinedSignal(signal, 45000) })
    if (!response.ok) throw new Error('语音识别 HTTP ' + response.status)
    const value = JSON.parse(await readBounded(response, 1024 * 1024))
    const text = value.text || value.result?.text
    if (typeof text !== 'string') throw new Error('识别服务没有返回文字')
    return text.trim().slice(0, 4000)
  }

  async pruneAudio(current) {
    const entries = await readdir(this.audioDir)
    if (entries.length <= 300) return
    const rows = (await Promise.all(entries.filter(name => /^[a-f0-9]{64}\.(mp3|wav)$/.test(name)).map(async name => { const path = join(this.audioDir, name); try{return {path,at:(await stat(path)).mtimeMs}}catch(error){if(error.code==='ENOENT')return null;throw error} }))).filter(Boolean)
    for (const row of rows.sort((a, b) => b.at - a.at).slice(250)) if (row.path !== current) await unlink(row.path).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
