export const int16ToFloat32 = (samples, channels = 1) => {
  const frames = Math.floor(samples.length / channels)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    for (let c = 0; c < channels; c += 1) sum += samples[i * channels + c]
    out[i] = sum / channels / 32768
  }
  return out
}

export const float32ToInt16 = (pcm) => {
  const out = new Int16Array(pcm.length)
  for (let i = 0; i < pcm.length; i += 1) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    out[i] = s < 0 ? s * 32768 : s * 32767
  }
  return out
}

export const rms = (pcm) => {
  if (!pcm.length) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i += 1) sum += pcm[i] * pcm[i]
  return Math.sqrt(sum / pcm.length)
}

const lowpassKernel = (cutoff, taps) => {
  const kernel = new Float32Array(taps)
  const mid = (taps - 1) / 2
  let sum = 0
  for (let i = 0; i < taps; i += 1) {
    const x = i - mid
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1))
    kernel[i] = sinc * blackman
    sum += kernel[i]
  }
  for (let i = 0; i < taps; i += 1) kernel[i] /= sum
  return kernel
}

export class Resampler {
  #kernel = null
  #history
  #buffer = new Float32Array(0)
  #pos = 0

  constructor(fromRate, toRate, taps = 48) {
    this.fromRate = fromRate
    this.toRate = toRate
    this.step = fromRate / toRate
    if (toRate < fromRate) this.#kernel = lowpassKernel((0.45 * toRate) / fromRate, taps)
    this.#history = new Float32Array(this.#kernel ? this.#kernel.length - 1 : 0)
  }

  process(input) {
    if (this.fromRate === this.toRate) return input
    const filtered = this.#kernel ? this.#filter(input) : input
    const buffer = new Float32Array(this.#buffer.length + filtered.length)
    buffer.set(this.#buffer)
    buffer.set(filtered, this.#buffer.length)
    const out = []
    while (this.#pos + 1 < buffer.length) {
      const i0 = Math.floor(this.#pos)
      const frac = this.#pos - i0
      out.push(buffer[i0] + (buffer[i0 + 1] - buffer[i0]) * frac)
      this.#pos += this.step
    }
    const consumed = Math.min(Math.floor(this.#pos), buffer.length)
    this.#buffer = buffer.slice(consumed)
    this.#pos -= consumed
    return Float32Array.from(out)
  }

  #filter(input) {
    const kernel = this.#kernel
    const taps = kernel.length
    const joined = new Float32Array(this.#history.length + input.length)
    joined.set(this.#history)
    joined.set(input, this.#history.length)
    const out = new Float32Array(input.length)
    for (let n = 0; n < input.length; n += 1) {
      let acc = 0
      for (let k = 0; k < taps; k += 1) acc += kernel[k] * joined[n + k]
      out[n] = acc
    }
    this.#history = joined.slice(joined.length - (taps - 1))
    return out
  }
}

export class SampleFifo {
  #chunks = []
  #head = 0
  #length = 0

  constructor(maxSamples) {
    this.maxSamples = maxSamples
  }

  get length() { return this.#length }

  push(pcm) {
    if (!pcm.length) return
    this.#chunks.push(pcm)
    this.#length += pcm.length
    while (this.#length > this.maxSamples && this.#chunks.length) {
      const drop = this.#chunks.shift().length - this.#head
      this.#head = 0
      this.#length -= drop
    }
  }

  read(count) {
    if (!this.#length) return null
    const out = new Float32Array(count)
    let written = 0
    while (written < count && this.#chunks.length) {
      const chunk = this.#chunks[0]
      const take = Math.min(count - written, chunk.length - this.#head)
      out.set(chunk.subarray(this.#head, this.#head + take), written)
      written += take
      this.#head += take
      this.#length -= take
      if (this.#head >= chunk.length) {
        this.#chunks.shift()
        this.#head = 0
      }
    }
    return out
  }

  clear() {
    this.#chunks = []
    this.#head = 0
    this.#length = 0
  }
}

export const pacedTimer = (intervalMs, tick) => {
  let next = performance.now()
  let timer = null
  let stopped = false
  const run = () => {
    if (stopped) return
    try { tick() } catch {}
    next += intervalMs
    const now = performance.now()
    if (next < now - intervalMs * 10) next = now
    timer = setTimeout(run, Math.max(0, next - now))
  }
  timer = setTimeout(run, 0)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
