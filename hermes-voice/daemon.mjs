import http from 'node:http'
import { config } from './config.mjs'
import { VoiceBroker } from './broker.mjs'
import { CallSession } from './call-session.mjs'
import { placeMessageCall } from './outbound.mjs'
import { VoipClient } from '../dist/index.mjs'

const LIBSIGNAL_NOISE = /^(Closing (open )?session|Opening session|Removing old closed session|Migrating session|Session already|Decrypted message with closed session|Failed to decrypt|Session error)/i
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {}
const originalError = console.error.bind(console)
console.error = (...args) => {
  if (typeof args[0] === 'string' && LIBSIGNAL_NOISE.test(args[0])) return
  originalError(...args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : '[object]')))
}

const log = (message) => {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().replace('T', ' ').slice(0, 23)
  process.stdout.write(`${local} ${message}\n`)
}

const state = {
  startedAt: Date.now(),
  connected: false,
  session: null,
  lastCall: null,
  sessions: new Set(),
  shuttingDown: false,
}

const callerProfile = (info) => {
  const lidUser = info.from.endsWith('@lid') ? info.from.split('@')[0] : ''
  const number = info.callerPn || lidUser
  const match = config.allowlist.find((entry) => (entry.lid ? entry.id === lidUser : entry.id === info.callerPn))
  if (match) {
    return { known: true, verified: match.verified, tasks: match.tasks, name: match.name || info.pushName || 'there', number, language: match.language, note: match.note, pushName: info.pushName || '' }
  }
  if (!config.answerEveryone) return null
  return { known: false, verified: false, tasks: config.unknownTasks, name: info.pushName || 'the caller', number, language: '', note: '', pushName: info.pushName || '' }
}

const screenIncomingCall = (info) => {
  const caller = callerProfile(info)
  if (!caller) {
    log(`ignoring call from ${info.callerPn || info.from} (not in the callers list)`)
    return false
  }
  if (state.session && state.session.active) {
    log(`ignoring call from ${caller.name}: another call is active`)
    return false
  }
  return true
}

const broker = new VoiceBroker({ python: config.python, log })
const client = new VoipClient({
  authDir: config.authDir,
  screenIncomingCall,
  socketOptions: {
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
  },
})

client.on('incoming', (call) => {
  const session = new CallSession({
    call,
    info: call.incoming,
    config,
    broker,
    client,
    log,
    caller: callerProfile(call.incoming),
  })
  state.session = session
  state.sessions.add(session)
  session.run()
    .catch((err) => log(`call session crashed: ${err.stack || err.message}`))
    .finally(() => {
      state.lastCall = {
        callId: call.callId,
        from: session.name,
        startedAt: new Date(session.startedAt).toISOString(),
        durationS: session.connectedAt ? Math.round(((session.endedAt || Date.now()) - session.connectedAt) / 1000) : 0,
        tasks: session.tasks,
        chatSession: session.chat.sessionId,
      }
      if (state.session === session) state.session = null
      const release = setInterval(() => {
        if (session.pendingTasks > 0) return
        clearInterval(release)
        state.sessions.delete(session)
      }, 5000)
    })
})
client.on('incoming-busy', (info) => log(`second call from ${info.callerPn || info.from} while busy; left for the phone`))
client.on('incoming-offer', (info) => log(`call offer ${info.callId} from ${info.callerPn || info.from}${info.isVideo ? ' (video)' : ''}${info.isGroup ? ' (group, ignored)' : ''}${info.offline ? ' (offline, ignored)' : ''}`))
client.on('call-node', (tag, attrs) => config.debug && log(`wa <call> ${tag} ${JSON.stringify(attrs)}`))
client.on('debug', (kind, detail) => config.debug && log(`debug ${kind} ${JSON.stringify(detail)}`))
client.on('call-event', (type, data) => config.debug && type !== 156 && log(`wa event ${type} ${String(data || '').slice(0, 300)}`))
client.on('wasm-log', (level, message) => config.debug && level !== 'debug' && log(`wasm ${level}: ${String(message).slice(0, 300)}`))
client.on('disconnected', ({ statusCode, loggedOut }) => {
  state.connected = false
  if (state.shuttingDown) return
  if (loggedOut) {
    log('WhatsApp logged this device out. Relink with: node hermes-call.mjs link — not restarting.')
    void shutdown(0)
    return
  }
  const wait = statusCode === 440 ? 30_000 : 2000
  log(`WhatsApp connection closed (${statusCode}); restarting in ${wait / 1000}s`)
  setTimeout(() => void shutdown(1), wait)
})

const readBody = (req) => new Promise((resolve, reject) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > 1_000_000) req.destroy()
  })
  req.on('end', () => {
    try { resolve(body ? JSON.parse(body) : {}) } catch (err) { reject(err) }
  })
  req.on('error', reject)
})

const reply = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (req, res) => {
  const host = String(req.headers.host || '')
  if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return reply(res, 403, { error: 'forbidden' })
  try {
    if (req.method === 'GET' && req.url === '/status') {
      const s = state.session
      return reply(res, 200, {
        connected: state.connected,
        device: client.user?.id || null,
        uptimeS: Math.round((Date.now() - state.startedAt) / 1000),
        answers: config.answerEveryone ? `everyone (strangers: ${config.unknownTasks ? 'tasks allowed' : 'conversation only'})` : 'known callers only',
        knownCallers: [...new Set(config.allowlist.map((e) => `${e.name || e.id}${e.verified ? ' (verified)' : ''}`))],
        chatModel: `${config.chatProvider}/${config.chatModel}`,
        activeCall: client.activeCall ? { callId: client.activeCall.callId, direction: client.activeCall.direction, with: s?.name } : null,
        lastCall: state.lastCall,
        pendingTasks: [...state.sessions].reduce((n, x) => n + x.pendingTasks, 0),
      })
    }
    if (req.method === 'POST' && req.url === '/call') {
      const body = await readBody(req)
      const to = String(body.to || '').replace(/\D/g, '')
      const message = String(body.message || body.text || '').trim()
      if (!to || !message) return reply(res, 400, { error: 'to and message are required' })
      if (client.activeCall) return reply(res, 409, { to, answered: false, reason: 'busy' })
      const result = await placeMessageCall(client, {
        to,
        message,
        ttsVoice: String(body.voice || config.ttsVoice),
        ringTimeoutMs: Number(body.ringTimeoutMs) || config.ringTimeoutMs,
        log,
      })
      return reply(res, 200, result)
    }
    return reply(res, 404, { error: 'not found' })
  } catch (err) {
    log(`control API error: ${err.message}`)
    return reply(res, 500, { error: err.message })
  }
})

const shutdown = async (code) => {
  if (state.shuttingDown) return
  state.shuttingDown = true
  log(`shutting down (${code})`)
  try { client.activeCall?.end() } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1500))
  try { server.close() } catch {}
  try { broker.close() } catch {}
  try { client.disconnect() } catch {}
  setTimeout(() => process.exit(code), 500)
}

process.on('SIGTERM', () => void shutdown(0))
process.on('SIGINT', () => void shutdown(0))

log(`starting WhatsApp voice daemon (device auth ${config.authDir})`)
if (config.callersError) log(`WARNING: callers file ignored: ${config.callersError}`)
if (!config.allowlist.length && !config.answerEveryone) log('WARNING: no callers configured and WHATSAPP_VOICE_ANSWER is not "everyone", so no call will be answered')
const describeCaller = (e) => `${e.name || '?'} (${e.lid ? 'lid ' : ''}${e.id}${e.verified ? ', verified' : ''}${e.tasks ? '' : ', no tasks'}${e.language ? `, ${e.language}` : ''})`
log(`known callers: ${config.allowlist.map(describeCaller).join(', ') || 'none'}; everyone else: ${config.answerEveryone ? `answered, ${config.unknownTasks ? 'tasks allowed' : 'conversation only'}` : 'ignored'}`)
log(`chat model ${config.chatProvider}/${config.chatModel}; voice ${config.voice}; language ${config.language}`)

try {
  await client.connect()
} catch (err) {
  log(`WhatsApp connect failed: ${err?.message || err}`)
  process.exit(1)
}
state.connected = true
process.on('uncaughtException', (err) => log(`uncaught: ${err?.stack || err}`))
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack || err}`))
log(`WhatsApp connected as ${client.user?.id}; VoIP stack ready`)

server.on('error', (err) => log(`control API unavailable: ${err.message}`))
server.listen(config.controlPort, '127.0.0.1', () => log(`control API on http://127.0.0.1:${config.controlPort}`))

broker.request('warm', {}, 60_000)
  .then((r) => log(`voice broker warm (codex thread ${r.threadId})`))
  .catch((err) => log(`voice broker warm-up failed: ${err.message}`))
