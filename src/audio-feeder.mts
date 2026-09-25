/**
 * Audio feeder.
 *
 * Spawns ffmpeg to decode `source` into f32le PCM at the requested rate, then
 * meters frames out at chunk-cadence to the WASM uplink.
 *
 * @author ShellTear
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const LOW_WATERMARK_CHUNKS = 16;
const MAX_QUEUED_CHUNKS = 1024;
const DEFAULT_WARMUP_MS = 500;

export class AudioFeeder {
  #proc: ChildProcessWithoutNullStreams | null = null;
  #pending = Buffer.alloc(0);
  #queue: Float32Array[] = [];
  #emitTimer: NodeJS.Timeout | null = null;
  #nextEmitAtMs = 0;
  #warmupUntilMs = 0;

  droppedChunks = 0;
  underflowChunks = 0;
  bytesProduced = 0;
  chunksEmitted = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly channels: number,
    private readonly framesPerChunk: number,
    private readonly onChunk: (chunk: Float32Array) => void,
    private readonly source: string = "silence",
  ) {}

  start = (): void => {
    if (this.#proc) return;

    const chunkSamples = this.framesPerChunk * this.channels;
    const chunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
    const chunkIntervalMs = (this.framesPerChunk / this.sampleRate) * 1000;

    const inputArgs = this.#resolveInputArgs();

    this.#proc = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-thread_queue_size", "512",
      ...inputArgs,
      "-f", "f32le",
      "-ac", String(this.channels),
      "-ar", String(this.sampleRate),
      "pipe:1",
    ]);

    this.#proc.stdout.on("data", (chunk: Buffer) => {
      this.#pending = Buffer.concat([this.#pending, chunk]);
      while (this.#pending.length >= chunkBytes) {
        if (this.#queue.length >= MAX_QUEUED_CHUNKS) {
          this.#proc?.stdout.pause();
          break;
        }
        const frame = this.#pending.subarray(0, chunkBytes);
        this.#pending = this.#pending.subarray(chunkBytes);
        const out = new Float32Array(chunkSamples);
        out.set(new Float32Array(frame.buffer, frame.byteOffset, chunkSamples));
        this.bytesProduced += chunkBytes;
        this.#queue.push(out);
      }
    });

    this.#proc.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[AudioFeeder] ${chunk.toString().trim()}\n`);
    });

    this.#proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        process.stderr.write(`[AudioFeeder] ffmpeg exited with code=${code}\n`);
      }
      this.#proc = null;
    });

    this.#nextEmitAtMs = 0;
    this.#warmupUntilMs = Date.now() + DEFAULT_WARMUP_MS;
    this.#scheduleNext(chunkSamples, chunkIntervalMs);
  };

  stop = (): void => {
    if (this.#emitTimer) {
      clearTimeout(this.#emitTimer);
      this.#emitTimer = null;
    }
    this.#proc?.kill("SIGTERM");
    this.#proc = null;
    this.#pending = Buffer.alloc(0);
    this.#queue = [];
    this.#warmupUntilMs = 0;
  };

  #resolveInputArgs = (): string[] => {
    if (!this.source || this.source === "silence") {
      return ["-f", "lavfi", "-i", `aevalsrc=0:d=3600:s=${this.sampleRate}`];
    }
    if (this.source.startsWith("lavfi:")) {
      return ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)];
    }
    return ["-i", this.source];
  };

  #scheduleNext = (chunkSamples: number, chunkIntervalMs: number): void => {
    if (!this.#proc) return;
    const now = Date.now();
    if (this.#nextEmitAtMs === 0) this.#nextEmitAtMs = now;
    const delayMs = Math.max(0, this.#nextEmitAtMs - now);

    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = null;
      if (this.#queue.length < LOW_WATERMARK_CHUNKS && Date.now() < this.#warmupUntilMs) {
        this.#nextEmitAtMs = Date.now() + 10;
        this.#scheduleNext(chunkSamples, chunkIntervalMs);
        return;
      }
      this.#flushOne(chunkSamples);
      this.#nextEmitAtMs += chunkIntervalMs;
      this.#scheduleNext(chunkSamples, chunkIntervalMs);
    }, delayMs);
  };

  #flushOne = (chunkSamples: number): void => {
    let nextChunk = this.#queue.shift();
    if (!nextChunk) {
      nextChunk = new Float32Array(chunkSamples);
      this.underflowChunks += 1;
    }
    this.chunksEmitted += 1;
    this.onChunk(nextChunk);
    if (this.#proc?.stdout.isPaused() && this.#queue.length <= MAX_QUEUED_CHUNKS / 4) {
      this.#proc.stdout.resume();
    }
  };
}

export class PcmQueue {
  #chunks: Float32Array[] = [];
  #head = 0;
  #length = 0;

  constructor(private readonly maxSamples = 16000 * 5) {}

  get length(): number { return this.#length; }

  push = (pcm: Float32Array): void => {
    if (!pcm.length) return;
    this.#chunks.push(pcm);
    this.#length += pcm.length;
    if (this.#length > this.maxSamples) this.#drop(this.#length - this.maxSamples);
  };

  read = (count: number): Float32Array | null => {
    if (this.#length === 0) return null;
    const out = new Float32Array(count);
    let written = 0;
    while (written < count && this.#chunks.length) {
      const chunk = this.#chunks[0]!;
      const take = Math.min(count - written, chunk.length - this.#head);
      out.set(chunk.subarray(this.#head, this.#head + take), written);
      written += take;
      this.#head += take;
      this.#length -= take;
      if (this.#head >= chunk.length) {
        this.#chunks.shift();
        this.#head = 0;
      }
    }
    return out;
  };

  clear = (): void => {
    this.#chunks = [];
    this.#head = 0;
    this.#length = 0;
  };

  #drop = (count: number): void => {
    let left = count;
    while (left > 0 && this.#chunks.length) {
      const avail = this.#chunks[0]!.length - this.#head;
      if (avail <= left) {
        this.#chunks.shift();
        this.#head = 0;
        this.#length -= avail;
        left -= avail;
      } else {
        this.#head += left;
        this.#length -= left;
        left = 0;
      }
    }
  };
}

export const resampleLinear = (pcm: Float32Array, fromRate: number, toRate: number): Float32Array => {
  if (fromRate === toRate || !pcm.length) return pcm;
  const outLength = Math.max(1, Math.round((pcm.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const step = fromRate / toRate;
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = pcm[Math.min(i0, pcm.length - 1)]!;
    const b = pcm[Math.min(i0 + 1, pcm.length - 1)]!;
    out[i] = a + (b - a) * frac;
  }
  return out;
};

export class PushAudioFeeder {
  #timer: NodeJS.Timeout | null = null;
  #nextEmitAtMs = 0;
  #running = false;

  underflowChunks = 0;
  chunksEmitted = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly channels: number,
    private readonly framesPerChunk: number,
    private readonly onChunk: (chunk: Float32Array) => void,
    private readonly pull: (frames: number) => Float32Array | null,
  ) {}

  start = (): void => {
    if (this.#running) return;
    this.#running = true;
    const intervalMs = (this.framesPerChunk / this.sampleRate) * 1000;
    this.#nextEmitAtMs = performance.now();
    const tick = (): void => {
      this.#timer = null;
      if (!this.#running) return;
      const mono = this.pull(this.framesPerChunk);
      if (!mono) this.underflowChunks += 1;
      const chunk = new Float32Array(this.framesPerChunk * this.channels);
      if (mono) {
        for (let i = 0; i < this.framesPerChunk; i += 1) {
          for (let c = 0; c < this.channels; c += 1) chunk[i * this.channels + c] = mono[i] ?? 0;
        }
      }
      this.chunksEmitted += 1;
      try { this.onChunk(chunk); } catch {}
      this.#nextEmitAtMs += intervalMs;
      const now = performance.now();
      if (this.#nextEmitAtMs < now - intervalMs * 5) this.#nextEmitAtMs = now;
      this.#timer = setTimeout(tick, Math.max(0, this.#nextEmitAtMs - now));
    };
    this.#timer = setTimeout(tick, 0);
  };

  stop = (): void => {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  };
}
