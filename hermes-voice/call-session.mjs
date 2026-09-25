import { LiveVoiceSession } from './voice-session.mjs'
import { HermesChat } from './hermes-chat.mjs'
import { rms } from './audio.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const FILLER_WORDS = new Set(['hello', 'hey', 'hi', 'no', 'nope', 'eh', 'emm', 'mmm', 'ah', 'ok', 'okay', 'thanks', 'yeah', 'yes', 'yep', 'hmm', 'um', 'uh', 'right', 'cool', 'great', 'nice', 'sure', 'alright', 'got', 'it', 'can', 'you', 'hear', 'me', 'are', 'there', 'wait', 'so', 'fine', 'good', 'what', 'and', 'the', 'same'])

export const isJunkDelegation = (text) => {
  const s = String(text || '').trim()
  if (!s) return true
  if (s.length > 90) return false
  const words = s.toLowerCase().replace(/[?!.,;:…()"']/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return true
  return words.filter((w) => FILLER_WORDS.has(w)).length / words.length >= 0.8
}

export const plainForVoice = (text) => String(text || '')
  .split(/\n\s*-{3,}\s*(?:\n|$)/)[0]
  .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const BYE_USER = /\b(bye|goodbye|good night|hang up|end (the |this )?call|that'?s all|nothing else)\b/i
const BYE_BOT = /\b(bye|goodbye|take care|talk (to you )?(soon|later)|good night|have a (good|great|nice))\b/i

const clock = (d = new Date()) => d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

export class CallSession {
  #barge = { botUntil: 0, botSince: 0, loudMs: 0, last: 0 }
  #transcript = []
  #contextFrom = 0
  #busy = false
  #queued = null
  #timers = []
  #byeAt = 0
  #ending = false
  #lastActivity = Date.now()

  connectedAt = 0
  endedAt = 0
  tasks = 0
  pendingTasks = 0

  constructor({ call, info, config, broker, client, log, callerName }) {
    this.call = call
    this.info = info
    this.config = config
    this.broker = broker
    this.client = client
    this.log = log
    this.name = callerName || 'the caller'
    this.startedAt = Date.now()
    this.title = `WhatsApp call ${this.name} ${clock()}`
    this.chat = new HermesChat({
      hermesBin: config.hermesBin,
      model: config.chatModel,
      provider: config.chatProvider,
      title: this.title,
      cwd: config.workdir,
      log,
    })
  }

  get active() { return !!this.connectedAt && !this.call.ended }
  get replyJid() { return this.info.callerPn ? `${this.info.callerPn}@s.whatsapp.net` : this.info.from }

  async run() {
    const { call, config } = this
    this.log(`incoming call ${call.callId} from ${this.name} (${this.info.callerPn || this.info.from})`)
    const voice = new LiveVoiceSession({
      broker: this.broker,
      voice: config.voice,
      profile: config.profile || null,
      note: this.#phoneNote(),
      log: this.log,
    })
    this.voice = voice
    this.#wire()

    let voiceError = null
    await Promise.all([
      voice.start().catch((err) => { voiceError = err }),
      sleep(config.answerDelayMs),
    ])
    if (call.ended) {
      this.log('caller hung up before the voice session was ready')
      await voice.close('caller_gone')
      return
    }
    if (voiceError) {
      this.log(`voice session failed: ${voiceError.message}`)
      call.reject()
      await voice.close('start_failed')
      await this.#text(`I couldn't start the voice session, so I declined the call. Reason: ${String(voiceError.message).slice(0, 300)}`)
      return
    }
    this.log(`voice ready (thread ${voice.threadId}, handoff ${voice.handoff}); answering`)
    voice.appendContext(`The phone call is now connected. Greet ${this.name} in one short, friendly sentence and ask what they need.`)

    try {
      await call.accept()
    } catch (err) {
      this.log(`accept failed: ${err.message}`)
      await voice.close('accept_failed')
      call.end()
      return
    }

    const connected = await Promise.race([
      new Promise((resolve) => call.connected ? resolve(true) : call.once('connected', () => resolve(true))),
      call.waitForEnd().then(() => false),
      sleep(20_000).then(() => false),
    ])
    if (!connected) {
      this.log('call did not become active after accept; hanging up')
      call.end()
      await voice.close('not_connected')
      return
    }
    this.connectedAt = Date.now()
    this.#lastActivity = Date.now()
    this.log('call connected')
    this.#startWatchdogs()

    const reason = await call.waitForEnd()
    await this.#finish(reason)
  }

  #phoneNote() {
    return [
      `PHONE CALL: ${this.name} called the Hermes WhatsApp bot number and you answered. It is a phone line, so keep every reply short and natural, and if you did not catch something, ask them to repeat it.`,
      `Tasks you delegate run in a new Hermes chat (${this.config.chatModelLabel}) opened just for this call; when a result comes back, read only the key facts aloud.`,
      'If they say goodbye, say a short goodbye back; the call ends after that.',
    ].join(' ')
  }

  #wire() {
    const { call, voice } = this
    call.on('audio', (pcm) => {
      if (!this.connectedAt) return
      voice.pushCallerAudio(pcm)
      this.#callerLevel(pcm)
    })
    voice.on('audio', (pcm) => {
      if (call.ended) return
      const level = rms(pcm)
      if (level < 0.002 && call.uplinkQueuedMs > 120) return
      call.pushAudio(pcm, 16000)
      this.#botLevel(level)
    })
    voice.on('activity', () => { this.#lastActivity = Date.now() })
    voice.on('line', ({ role, text }) => this.#onLine(role, text))
    voice.on('turn', ({ role }) => {
      if (role === 'user' && Date.now() < this.#barge.botUntil) call.clearUplink()
    })
    voice.on('delegation', (d) => this.#onDelegation(d))
    voice.on('closed', (reason) => {
      if (!call.ended && this.connectedAt && !this.#ending) {
        this.log(`voice session closed mid-call (${reason}); hanging up`)
        call.end()
      }
    })
    call.on('state', (state) => this.config.debug && this.log(`wa state ${state}`))
    call.on('accepting', (offered) => this.log(`accepting (offer state ${offered ? 'reported' : 'not reported'})`))
  }

  #onLine(role, text) {
    this.#transcript.push({ role, text, at: Date.now() })
    if (this.#transcript.length > 200) this.#transcript.splice(0, 50)
    this.log(`${role === 'user' ? this.name : this.voice.botName}: ${text}`)
    if (role === 'user' && BYE_USER.test(text)) this.#byeAt = Date.now()
    if (role === 'bot' && this.#byeAt && Date.now() - this.#byeAt < 20_000 && BYE_BOT.test(text)) {
      this.#byeAt = 0
      void this.#hangUpWhenQuiet('goodbye')
    }
  }

  #botLevel(level) {
    const now = Date.now()
    if (level < 0.008) return
    if (now > this.#barge.botUntil) this.#barge.botSince = now
    this.#barge.botUntil = now + 300
  }

  #callerLevel(pcm) {
    const b = this.#barge
    const now = Date.now()
    if (now > b.botUntil || now - b.botSince < 600) {
      b.loudMs = 0
      return
    }
    const ms = (pcm.length / 16000) * 1000
    b.loudMs = rms(pcm) > this.config.bargeRms ? b.loudMs + ms : Math.max(0, b.loudMs - ms / 2)
    if (b.loudMs >= 240 && now - b.last > 1500) {
      b.last = now
      b.loudMs = 0
      b.botUntil = 0
      this.call.clearUplink()
      this.log('barge-in: caller spoke over the reply')
      void this.voice.interrupt()
    }
  }

  #onDelegation({ itemId, text }) {
    let request = text
    if (!request) request = [...this.#transcript].reverse().find((l) => l.role === 'user')?.text || ''
    this.log(`delegation: ${request || '(empty)'}`)
    if (this.voice.handoff === 'server') return
    if (isJunkDelegation(request)) {
      this.voice.respondDelegation(itemId, 'The user was just chatting, not asking for work. Reply briefly and naturally; if they were asking about something in progress, tell them you are still on it. Nothing to run.')
      return
    }
    if (this.#busy) {
      this.#queued = { itemId, request, at: Date.now() }
      this.voice.respondDelegation(itemId, 'A task is already in progress. Tell the user you are still on it; if what they said is a correction it will be reflected in the result, if it is something new, it will run right after the current one.')
      return
    }
    void this.#runDelegation(itemId, request)
  }

  async #runDelegation(itemId, request) {
    this.#busy = true
    this.tasks += 1
    this.pendingTasks += 1
    const prompt = this.#buildPrompt(request)
    const task = this.chat.ask(prompt)
    try {
      const first = await Promise.race([task, sleep(this.config.taskWaitMs).then(() => null)])
      if (first) {
        this.#deliver(first, itemId)
      } else {
        this.log('task still running; telling the caller')
        this.voice.respondDelegation(itemId, 'The task is still running in the Hermes chat. Tell the user it is taking a little longer and that you will tell them the result as soon as it is ready; if they hang up, it will be sent to them on WhatsApp.')
        this.#deliver(await task, null)
      }
    } catch (err) {
      this.log(`task failed: ${err.message}`)
      this.#deliver({ text: '', error: err.message }, itemId)
    } finally {
      this.pendingTasks -= 1
      this.#busy = false
      const queued = this.#queued
      this.#queued = null
      if (queued && Date.now() - queued.at < 10 * 60_000) {
        this.log(`running queued request: ${queued.request}`)
        void this.#runDelegation(this.active ? queued.itemId : null, queued.request)
      }
    }
  }

  #buildPrompt(request) {
    const lines = this.#transcript.slice(this.#contextFrom).slice(-10)
    this.#contextFrom = this.#transcript.length
    const context = lines
      .map((l) => `${l.role === 'user' ? this.name : 'Voice assistant'}: ${l.text}`)
      .join('\n')
      .slice(-1800)
    const note = `[voice call] ${this.name} is on a live WhatsApp voice call; a realtime voice assistant is talking with them and handed you this request. The speech transcript may contain errors, so act on the most likely intent. If it is ambiguous, or the action is irreversible or outward-facing (send, post, delete, pay, merge), do not act: ask ONE short question instead. Begin your reply with what they will hear: 1-3 short spoken sentences in English with no markdown, code, URLs, file paths or long IDs, and numbers rounded. Only say something is done once it is. Then put a line containing only --- and any details for the chat below it.`
    return [note, context ? `Recent call transcript:\n${context}` : '', `Request: ${request}`].filter(Boolean).join('\n\n')
  }

  #deliver(result, itemId) {
    const spoken = plainForVoice(result?.text || '') || (result?.error ? `The task failed: ${result.error}` : 'The task finished without a visible answer.')
    this.log(`result: ${spoken.slice(0, 300)}`)
    this.#lastActivity = Date.now()
    if (this.active && itemId) {
      this.voice.respondDelegation(itemId, `Task result (answer the user with this, briefly and naturally): ${spoken}`)
    } else if (this.active) {
      this.voice.appendContext(`The earlier task just finished. Tell the user the result, briefly and naturally: ${spoken.slice(0, 3500)}`)
    } else if (this.config.lateResultText) {
      void this.#text(`Result from our call:\n\n${spoken}\n\n(Full answer is in the Hermes chat "${this.title}".)`)
    }
  }

  async #text(message) {
    try {
      await this.client.sendText(this.replyJid, message)
      this.log('sent WhatsApp text to the caller')
    } catch (err) {
      this.log(`could not send WhatsApp text: ${err.message}`)
    }
  }

  #startWatchdogs() {
    const { config } = this
    this.#timers.push(setInterval(() => {
      if (!this.active || this.#ending) return
      const idle = Date.now() - this.#lastActivity
      if (!this.#busy && idle > config.idleHangupMs) {
        this.log(`no conversation for ${Math.round(idle / 1000)}s; hanging up`)
        this.voice.appendContext('Nobody has said anything for a while. Say a one-sentence goodbye; the call is ending.')
        void this.#hangUpWhenQuiet('idle', 2500)
      }
    }, 5000))
    if (config.maxCallMs > 0) {
      this.#timers.push(setTimeout(() => {
        if (!this.active) return
        this.voice.appendContext('The call has reached its time limit. Tell the user in one sentence that you have to hang up now and say goodbye.')
        void this.#hangUpWhenQuiet('time_limit', 3000)
      }, config.maxCallMs))
    }
  }

  async #hangUpWhenQuiet(reason, minWaitMs = 1200) {
    if (this.#ending) return
    this.#ending = true
    await sleep(minWaitMs)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && (Date.now() < this.#barge.botUntil || this.call.uplinkQueuedMs > 150)) await sleep(200)
    await sleep(this.call.uplinkQueuedMs + 600)
    if (!this.call.ended) {
      this.log(`hanging up (${reason})`)
      this.call.end()
    }
  }

  async #finish(reason) {
    this.endedAt = Date.now()
    for (const t of this.#timers) { clearInterval(t); clearTimeout(t) }
    this.#timers = []
    const durationMs = this.connectedAt ? this.endedAt - this.connectedAt : 0
    await this.voice.close('call_ended')
    if (durationMs > 0) {
      try { await this.broker.request('usage', { durationMs, audioMs: this.voice.audioMs }, 5000) } catch {}
    }
    this.log(`call ended (${reason}) after ${Math.round(durationMs / 1000)}s; tasks ${this.tasks}${this.pendingTasks ? `, ${this.pendingTasks} still running` : ''}${this.chat.sessionId ? `; chat ${this.chat.sessionId}` : ''}`)
  }
}
