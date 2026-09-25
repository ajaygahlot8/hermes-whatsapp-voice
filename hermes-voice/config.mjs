import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const hermesHome = process.env.HERMES_HOME || join(homedir(), '.hermes')
const envFile = join(hermesHome, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const env = process.env
const number = (value, fallback) => {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const MODEL_LABELS = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-opus-5': 'Claude Opus 5', 'claude-sonnet-5': 'Claude Sonnet 5' }

export const parseAllowlist = (raw) => String(raw || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [id, ...name] = entry.split(':')
    const lid = id.endsWith('@lid')
    return { id: lid ? id.split('@')[0].replace(/\D/g, '') : id.replace(/\D/g, ''), lid, name: name.join(':').trim() }
  })
  .filter((entry) => entry.id)

const chatModel = env.WHATSAPP_VOICE_CHAT_MODEL || 'claude-opus-5-5'

export const config = {
  hermesHome,
  authDir: env.WHATSAPP_CALLER_AUTH || join(hermesHome, 'platforms/whatsapp/caller-session'),
  allowlist: parseAllowlist(env.WHATSAPP_VOICE_ALLOWED),
  voice: env.WHATSAPP_VOICE_VOICE || 'cove',
  language: (env.WHATSAPP_VOICE_LANGUAGE || 'en').toLowerCase(),
  profile: env.WHATSAPP_VOICE_PROFILE || '',
  chatModel,
  chatModelLabel: MODEL_LABELS[chatModel] || chatModel,
  chatProvider: env.WHATSAPP_VOICE_CHAT_PROVIDER || 'anthropic',
  answerDelayMs: number(env.WHATSAPP_VOICE_ANSWER_DELAY_MS, 1500),
  idleHangupMs: number(env.WHATSAPP_VOICE_IDLE_HANGUP_S, 180) * 1000,
  maxCallMs: number(env.WHATSAPP_VOICE_MAX_CALL_MIN, 30) * 60_000,
  taskWaitMs: number(env.WHATSAPP_VOICE_TASK_WAIT_S, 150) * 1000,
  lateResultText: env.WHATSAPP_VOICE_LATE_RESULT_TEXT !== '0',
  bargeRms: number(env.WHATSAPP_VOICE_BARGE_RMS, 0.04),
  controlPort: number(env.WHATSAPP_VOICE_CONTROL_PORT, 3910),
  ttsVoice: env.WHATSAPP_CALLER_VOICE || 'Samantha',
  ringTimeoutMs: number(env.WHATSAPP_CALLER_RING_TIMEOUT_MS, 45_000),
  python: env.WHATSAPP_VOICE_PYTHON || join(hermesHome, 'hermes-agent/venv/bin/python'),
  hermesBin: env.WHATSAPP_VOICE_HERMES_BIN || join(homedir(), '.local/bin/hermes'),
  workdir: join(hermesHome, 'workspace'),
  debug: env.WHATSAPP_VOICE_DEBUG === '1',
}
