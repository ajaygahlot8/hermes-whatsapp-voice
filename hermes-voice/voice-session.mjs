import { EventEmitter } from 'node:events'
import wrtc from '@roamhq/wrtc'
import { Resampler, SampleFifo, float32ToInt16, int16ToFloat32, pacedTimer } from './audio.mjs'

const { RTCPeerConnection, nonstandard: { RTCAudioSource, RTCAudioSink } } = wrtc

const RATE = 16000
const FRAME = RATE / 100
const LINE_GAP_MS = 3500

export class LiveVoiceSession extends EventEmitter {
  #pc = null
  #dc = null
  #source = null
  #track = null
  #sink = null
  #stopPump = null
  #resampler = null
  #input = new SampleFifo(RATE * 2)
  #lines = { user: null, bot: null }
  #lastLine = { user: '', bot: '' }
  #lineTimer = null
  #closed = false

  threadId = null
  handoff = 'client'
  botName = 'Hermes'
  audioMs = 0
  currentBotTurnId = ''

  constructor({ broker, voice = 'cove', profile = null, note = '', log = () => {} }) {
    super()
    this.broker = broker
    this.voice = voice
    this.profile = profile
    this.note = note
    this.log = log
  }

  get open() { return !this.#closed && this.#dc?.readyState === 'open' }

  async start() {
    const pc = new RTCPeerConnection()
    this.#pc = pc
    this.#source = new RTCAudioSource()
    this.#track = this.#source.createTrack()
    pc.addTrack(this.#track)
    const dc = pc.createDataChannel('oai-events')
    this.#dc = dc
    dc.onmessage = (ev) => this.#onMessage(ev.data)
    dc.onclose = () => this.#fail('event channel closed')
    pc.ontrack = (ev) => this.#attachSink(ev.track)
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      this.emit('rtc-state', state)
      if (state === 'failed' || state === 'closed') this.#fail(`webrtc ${state}`)
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const res = await this.broker.request('start', {
      offer: pc.localDescription.sdp,
      voice: this.voice,
      profile: this.profile || null,
      note: this.note,
    }, 90_000)
    this.threadId = res.threadId || null
    this.handoff = res.handoff === 'server' ? 'server' : 'client'
    this.botName = res.botName || this.botName
    if (res.warning) this.log(`voice: ${res.warning}`)
    await pc.setRemoteDescription({ type: 'answer', sdp: res.answer })

    await new Promise((resolve, reject) => {
      if (dc.readyState === 'open') return resolve()
      const timer = setTimeout(() => reject(new Error('event channel did not open in 20s')), 20_000)
      dc.onopen = () => { clearTimeout(timer); resolve() }
    })
    this.#stopPump = pacedTimer(10, () => this.#pumpFrame())
    this.#lineTimer = setInterval(() => this.#flushLines(false), 2000)
  }

  pushCallerAudio(pcm16k) {
    this.#input.push(pcm16k)
  }

  send(obj) {
    if (!this.open) return false
    try {
      this.#dc.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }

  appendContext(text) {
    return this.send({ type: 'session.context.append', content: [{ type: 'input_text', text: String(text) }] })
  }

  respondDelegation(itemId, text) {
    return this.send({
      type: 'delegation.context.append',
      delegation_item_id: itemId,
      content: [{ type: 'input_text', text: String(text || '').slice(0, 3500) }],
    })
  }

  async interrupt() {
    const turnId = this.currentBotTurnId
    this.currentBotTurnId = ''
    if (!turnId || !this.threadId) return
    try {
      await this.broker.request('interrupt', { threadId: this.threadId, turnId }, 8000)
    } catch (err) {
      if (!/no active turn/i.test(err.message)) this.log(`voice: interrupt failed: ${err.message}`)
    }
  }

  async close(reason = 'closed') {
    if (this.#closed) return
    this.#closed = true
    this.#flushLines(true)
    clearInterval(this.#lineTimer)
    this.#stopPump?.()
    try { this.#sink?.stop() } catch {}
    try { this.#track?.stop() } catch {}
    try { this.#dc?.close() } catch {}
    try { this.#pc?.close() } catch {}
    if (this.threadId) {
      try { await this.broker.request('stop', { threadId: this.threadId }, 12_000) } catch {}
    }
    this.emit('closed', reason)
  }

  #fail(reason) {
    if (this.#closed) return
    this.log(`voice: ${reason}`)
    void this.close(reason)
  }

  #pumpFrame() {
    if (this.#closed || !this.#source) return
    const frame = this.#input.read(FRAME) ?? new Float32Array(FRAME)
    this.#source.onData({
      samples: float32ToInt16(frame),
      sampleRate: RATE,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: FRAME,
    })
  }

  #attachSink(track) {
    if (track.kind !== 'audio' || this.#sink) return
    this.#sink = new RTCAudioSink(track)
    this.#sink.ondata = (data) => {
      if (this.#closed) return
      const mono = int16ToFloat32(data.samples, data.channelCount || 1)
      if (!this.#resampler || this.#resampler.fromRate !== data.sampleRate) {
        this.#resampler = new Resampler(data.sampleRate, RATE)
      }
      const pcm = this.#resampler.process(mono)
      if (pcm.length) this.emit('audio', pcm)
    }
  }

  #onMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    const type = msg?.type
    if (!type) return
    this.emit('event', msg)
    switch (type) {
      case 'input_transcript.added':
        this.#delta('user', msg.item?.text)
        break
      case 'output_transcript.added':
        this.#delta('bot', msg.item?.text)
        break
      case 'turn.created': {
        const turn = msg.turn || {}
        if (turn.role === 'assistant' && turn.id) this.currentBotTurnId = String(turn.id)
        this.emit('turn', { role: turn.role, id: turn.id })
        break
      }
      case 'turn.done': {
        const turn = msg.turn || {}
        const role = turn.role === 'user' ? 'user' : turn.role === 'assistant' ? 'bot' : ''
        if (role && turn.transcript) this.#final(role, turn.transcript)
        break
      }
      case 'session.usage.updated': {
        const ms = Number(msg.usage?.audio_duration_ms) || 0
        if (ms > this.audioMs) this.audioMs = ms
        break
      }
      case 'delegation.created': {
        const item = msg.item || {}
        const text = Array.isArray(item.content) ? item.content.map((c) => c?.text || '').join('') : ''
        this.#flushLines(true)
        this.emit('delegation', { itemId: String(item.id || ''), text: text.trim() })
        break
      }
      case 'error':
        this.log(`voice: server error: ${JSON.stringify(msg.error || msg).slice(0, 300)}`)
        break
      default:
        break
    }
  }

  #delta(role, text) {
    if (!text) return
    const now = Date.now()
    this.emit('activity', role)
    const other = role === 'user' ? 'bot' : 'user'
    if (this.#lines[other]) this.#flushLine(other)
    const line = this.#lines[role]
    if (line && now - line.at < LINE_GAP_MS) {
      line.text += text
      line.at = now
    } else {
      if (line) this.#flushLine(role)
      this.#lines[role] = { text, at: now }
    }
  }

  #final(role, transcript) {
    const line = this.#lines[role]
    if (line) {
      if (transcript.length > line.text.length) line.text = transcript
      this.#flushLine(role)
      return
    }
    const text = transcript.trim()
    const last = this.#lastLine[role]
    if (!text || (last && (last.includes(text) || (text.includes(last) && text.length - last.length < 8)))) return
    this.#lastLine[role] = text
    this.emit('line', { role, text })
  }

  #flushLines(all = false) {
    const now = Date.now()
    for (const role of ['user', 'bot']) {
      const line = this.#lines[role]
      if (line && (all || now - line.at > LINE_GAP_MS)) this.#flushLine(role)
    }
  }

  #flushLine(role) {
    const line = this.#lines[role]
    this.#lines[role] = null
    const text = line?.text?.trim()
    if (!text) return
    this.#lastLine[role] = text
    this.emit('line', { role, text })
  }
}
