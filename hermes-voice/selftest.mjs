import { writeFileSync } from 'node:fs'
import { config } from './config.mjs'
import { VoiceBroker } from './broker.mjs'
import { LiveVoiceSession } from './voice-session.mjs'
import { HermesChat } from './hermes-chat.mjs'
import { renderMessage } from './outbound.mjs'
import { float32ToInt16 } from './audio.mjs'
import { plainForVoice } from './call-session.mjs'

const [, , spoken = 'Please ask the agent what the date and day of the week are today, and tell me.', outWav = '/tmp/hermes-voice-selftest.wav', ttsVoice = 'Samantha'] = process.argv
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const t0 = Date.now()
const log = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${m}`)

const writeWav = (path, chunks, rate = 16000) => {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const pcm = new Float32Array(total)
  let offset = 0
  for (const c of chunks) { pcm.set(c, offset); offset += c.length }
  const data = Buffer.from(float32ToInt16(pcm).buffer)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
  return total / rate
}

const broker = new VoiceBroker({ python: config.python, log })
const voice = new LiveVoiceSession({
  broker,
  voice: config.voice,
  profile: config.profile || null,
  note: 'SELF-TEST: this is an automated test of the phone bridge. Keep answers very short.',
  language: config.language,
  log,
})
const chat = new HermesChat({
  hermesBin: config.hermesBin,
  model: config.chatModel,
  provider: config.chatProvider,
  title: `WhatsApp voice self-test ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
  cwd: config.workdir,
  log,
})
const botAudio = []
let delegations = 0
let results = 0
voice.on('audio', (pcm) => botAudio.push(pcm))
voice.on('line', ({ role, text }) => log(`${role === 'user' ? 'CALLER' : 'BOT'}: ${text}`))
voice.on('delegation', async ({ itemId, text }) => {
  delegations += 1
  log(`DELEGATION: ${text || '(empty)'}`)
  const res = await chat.ask(`[voice self-test] Begin your reply with 1-2 short spoken sentences in the language of the request, then a line with only --- and any details.\n\nRequest: ${text || spoken}`)
  results += 1
  log(`CHAT RESULT (${res.sessionId}): ${plainForVoice(res.text).slice(0, 300)}${res.error ? ` ERROR ${res.error}` : ''}`)
  voice.respondDelegation(itemId, `Task result (answer the user with this, briefly and naturally): ${plainForVoice(res.text) || res.error}`)
})

log('starting realtime session through the talk-desktop broker…')
await voice.start()
log(`realtime session up (thread ${voice.threadId}, handoff ${voice.handoff})`)
voice.appendContext('The phone call is now connected. Greet the caller in one short sentence.')
await sleep(7000)

const pcm = renderMessage(spoken, ttsVoice)
log(`speaking as caller (${(pcm.length / 16000).toFixed(1)}s): "${spoken}"`)
for (let i = 0; i < pcm.length; i += 320) {
  voice.pushCallerAudio(pcm.slice(i, i + 320))
  await sleep(20)
}

const deadline = Date.now() + 150_000
while (Date.now() < deadline && !(delegations && results >= delegations && Date.now() - t0 > 20_000)) await sleep(500)
await sleep(12_000)
const seconds = writeWav(outWav, botAudio)
log(`bot audio captured: ${seconds.toFixed(1)}s → ${outWav}`)
log(`delegations ${delegations}, chat results ${results}, chat session ${chat.sessionId || '-'}, audio ms ${voice.audioMs}`)
await voice.close('selftest_done')
broker.close()
setTimeout(() => process.exit(0), 1500)
