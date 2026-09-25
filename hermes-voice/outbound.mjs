import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const renderMessage = (message, ttsVoice) => {
  const dir = mkdtempSync(join(tmpdir(), 'wavoice-'))
  try {
    let src = message
    if (!existsSync(message)) {
      src = join(dir, 'msg.aiff')
      execFileSync('say', ['-v', ttsVoice, '-o', src, message])
    }
    const raw = join(dir, 'msg.f32')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-af', 'adelay=1000:all=1,apad=pad_dur=1', '-ar', '16000', '-ac', '1', '-f', 'f32le', raw])
    const buf = readFileSync(raw)
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const placeMessageCall = async (client, { to, message, ttsVoice, ringTimeoutMs, log }) => {
  const pcm = renderMessage(message, ttsVoice)
  const audioMs = (pcm.length / 16000) * 1000
  const call = await client.call(to, { audioSource: 'push', durationMs: ringTimeoutMs + audioMs + 20_000 })
  log(`outbound call ${call.callId} to ${to} (${Math.round(audioMs / 1000)}s message)`)
  let answered = false
  let timedOut = false
  const ring = setTimeout(() => {
    if (answered) return
    timedOut = true
    call.end()
  }, ringTimeoutMs)
  call.once('ringing', () => log('outbound: ringing'))
  call.once('connected', async () => {
    answered = true
    clearTimeout(ring)
    log('outbound: answered, playing message')
    let offset = 0
    while (!call.ended && offset < pcm.length) {
      if (call.uplinkQueuedMs < 800) {
        const next = pcm.subarray(offset, offset + 3200)
        call.pushAudio(next, 16000)
        offset += next.length
      } else {
        await sleep(100)
      }
    }
    while (!call.ended && call.uplinkQueuedMs > 0) await sleep(100)
    await sleep(800)
    if (!call.ended) call.end()
  })
  const reason = await call.waitForEnd()
  clearTimeout(ring)
  log(`outbound call ended (${reason}), answered=${answered}`)
  return { to, answered, reason: timedOut ? 'timeout' : reason }
}
