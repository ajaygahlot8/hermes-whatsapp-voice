import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BROKER_PY = join(dirname(fileURLToPath(import.meta.url)), 'voice_broker.py')

export class VoiceBroker {
  #proc = null
  #ready = null
  #seq = 0
  #pending = new Map()

  constructor({ python, log = () => {} }) {
    this.python = python
    this.log = log
  }

  async request(cmd, payload = {}, timeoutMs = 30_000) {
    if (!this.#proc) this.#spawn()
    await this.#ready
    const id = ++this.#seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`voice broker: ${cmd} timed out`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      this.#proc.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n')
    })
  }

  close() {
    const proc = this.#proc
    if (!proc) return
    try { proc.stdin.end() } catch {}
    setTimeout(() => { try { proc.kill('SIGTERM') } catch {} }, 3000).unref()
  }

  #spawn() {
    const proc = spawn(this.python, [BROKER_PY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
    this.#proc = proc
    this.#ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('voice broker did not start in 30s')), 30_000)
      proc.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`voice broker exited during start (${code})`))
      })
      createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg
        try { msg = JSON.parse(line) } catch { return }
        if (msg.event === 'ready') {
          clearTimeout(timer)
          resolve()
          return
        }
        const pending = this.#pending.get(msg.id)
        if (!pending) return
        this.#pending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.ok) pending.resolve(msg)
        else pending.reject(Object.assign(new Error(msg.error || 'voice broker error'), { trace: msg.trace }))
      })
    })
    this.#ready.catch(() => {})
    createInterface({ input: proc.stderr }).on('line', (line) => {
      if (line.trim()) this.log(`broker: ${line.slice(0, 400)}`)
    })
    proc.on('exit', (code, signal) => {
      this.log(`voice broker exited (${code ?? signal})`)
      if (this.#proc === proc) this.#proc = null
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('voice broker exited'))
      }
      this.#pending.clear()
    })
  }
}
