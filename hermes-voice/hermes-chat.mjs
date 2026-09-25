import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export class HermesChat {
  sessionId = null
  #running = null

  constructor({ hermesBin, model, provider, title, cwd, log = () => {} }) {
    this.hermesBin = hermesBin
    this.model = model
    this.provider = provider
    this.title = title
    this.cwd = cwd
    this.log = log
  }

  get busy() { return !!this.#running }

  ask(text) {
    if (this.#running) return Promise.reject(new Error('a Hermes turn is already running for this call'))
    const args = ['chat', '--query-file', '-', '--format', 'stream-json', '-m', this.model, '--provider', this.provider, '--source', 'cli']
    if (this.sessionId) args.push('--resume', this.sessionId)
    else args.push('-c', this.title, '--create-if-missing')
    const started = Date.now()
    this.#running = new Promise((resolve) => {
      const proc = spawn(this.hermesBin, args, { cwd: this.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
      let streamed = ''
      let result = null
      let stderrTail = ''
      createInterface({ input: proc.stdout }).on('line', (line) => {
        let evt
        try { evt = JSON.parse(line) } catch { return }
        if (evt.session_id && !this.sessionId) {
          this.sessionId = evt.session_id
          this.log(`chat: session ${this.sessionId} (${this.model} via ${this.provider})`)
        }
        if (evt.type === 'text' && evt.text) streamed += evt.text
        else if (evt.type === 'tool_use') this.log(`chat: tool ${evt.name}`)
        else if (evt.type === 'result') result = evt
      })
      proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000) })
      proc.on('error', (err) => resolve({ text: '', error: `could not start hermes: ${err.message}` }))
      proc.on('close', (code) => {
        const sid = stderrTail.match(/session_id:\s*(\S+)/)?.[1]
        if (sid && !this.sessionId) this.sessionId = sid
        const text = String(result?.text || streamed || '').trim()
        const error = result?.error || (code !== 0 && !text ? `hermes exited ${code}: ${stderrTail.trim().split('\n').slice(-3).join(' | ')}` : '')
        this.log(`chat: turn done in ${((Date.now() - started) / 1000).toFixed(1)}s (exit ${code}, ${text.length} chars)`)
        resolve({ text, error, sessionId: this.sessionId })
      })
      proc.stdin.end(text)
    }).finally(() => { this.#running = null })
    return this.#running
  }
}
