/**
 * baileys-caller — WhatsApp voice calling for Node.js.
 *
 * Wraps WhatsApp Web's official VoIP WASM stack and routes signaling through
 * Baileys. Public surface:
 *
 *   const client = new VoipClient({ authDir })
 *   await client.connect()
 *   const call = await client.call("12345678901", { audioSource: "./hi.mp3" })
 *
 * @author ShellTear
 */
import { EventEmitter } from "node:events";
import { randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";

import { WasmEngine } from "./wasm-engine.mjs";
import { RelayRtcTransport, type RelayListUpdatePayload } from "./relay-transport.mjs";
import { SignalingBridge } from "./signaling.mjs";
import { AudioFeeder, PushAudioFeeder, PcmQueue, resampleLinear } from "./audio-feeder.mjs";
import { CallState, type IncomingCallInfo, type VoipSdkConfig } from "./types.mjs";

export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig, IncomingCallInfo } from "./types.mjs";
export { CallState } from "./types.mjs";
export { PcmQueue, resampleLinear } from "./audio-feeder.mjs";

const SHA256_LEN = 32;
const OFFER_WAIT_MS = 6_000;
const LOCAL_HANGUP_GRACE_MS = 4_000;
const UPLINK_MAX_SECONDS = 4;

const loadBaileys = async (): Promise<any> => {
  try {
    return await import("@whiskeysockets/baileys");
  } catch {
    throw new Error(
      "Could not import @whiskeysockets/baileys. Install it as a peer dependency.",
    );
  }
};

const toBareJid = (jid: string): string => {
  if (!jid) return jid;
  const at = jid.indexOf("@");
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(":")[0];
  return `${user}@${jid.slice(at + 1)}`;
};

const computeHkdf = (
  key: Uint8Array,
  salt: Uint8Array | null,
  info: Uint8Array,
  length: number,
): Uint8Array => {
  const effectiveSalt = salt && salt.length > 0 ? Buffer.from(salt) : Buffer.alloc(SHA256_LEN, 0);
  const prk = createHmac("sha256", effectiveSalt).update(key).digest();
  const blocks = Math.ceil(length / SHA256_LEN);
  const okm = Buffer.alloc(blocks * SHA256_LEN);
  let prev = Buffer.alloc(0);
  for (let i = 1; i <= blocks; i += 1) {
    prev = createHmac("sha256", prk)
      .update(prev)
      .update(info)
      .update(Buffer.from([i]))
      .digest();
    prev.copy(okm, (i - 1) * SHA256_LEN);
  }
  return new Uint8Array(okm.buffer, okm.byteOffset, length);
};

const computeHmacSha256 = (data: Uint8Array, key: Uint8Array): Uint8Array => {
  const result = createHmac("sha256", Buffer.from(key)).update(data).digest();
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
};

const isCallReceiptNode = (node: any): boolean => {
  if (node?.tag !== "receipt") return false;
  const child = Array.isArray(node.content) ? node.content[0] : null;
  return !!(child?.attrs?.["call-id"] || child?.attrs?.call_id);
};

const callIdOf = (node: any): string => {
  const child = Array.isArray(node?.content) ? node.content[0] : null;
  return String(child?.attrs?.["call-id"] ?? child?.attrs?.call_id ?? "");
};

const digitsOf = (jid: string | undefined): string => String(jid ?? "").split("@")[0]!.split(":")[0]!.replace(/\D/g, "");

/** A live or recently-ended call. */
export class ActiveCall extends EventEmitter {
  #state: CallState = CallState.Idle;
  #endResolver!: (reason: string) => void;
  readonly #endPromise: Promise<string>;
  #endTimer: NodeJS.Timeout | null = null;
  #ended = false;
  #seenLiveState = false;
  #connected = false;
  #offeredResolver!: () => void;
  readonly #offered: Promise<void>;
  readonly #uplink = new PcmQueue(16000 * UPLINK_MAX_SECONDS);
  #captureRate = 16000;

  /** @internal mirrors the source path for the audio feeder */
  _audioSource: string = "silence";

  constructor(
    public readonly callId: string,
    private readonly engine: WasmEngine,
    durationMs: number,
    public readonly direction: "outgoing" | "incoming" = "outgoing",
    public readonly incoming: IncomingCallInfo | null = null,
  ) {
    super();
    this.#endPromise = new Promise((res) => { this.#endResolver = res; });
    this.#offered = new Promise((res) => { this.#offeredResolver = res; });
    if (durationMs > 0) {
      this.#endTimer = setTimeout(() => this.end(), durationMs);
    }
  }

  get state(): CallState { return this.#state; }
  get ended(): boolean { return this.#ended; }
  get connected(): boolean { return this.#connected; }

  accept = async (): Promise<void> => {
    if (this.direction !== "incoming") throw new Error("Only incoming calls can be accepted.");
    if (this.#ended) throw new Error("Call already ended.");
    const offered = await Promise.race([
      this.#offered.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), OFFER_WAIT_MS)),
    ]);
    if (this.#ended) throw new Error("Call ended before it could be accepted.");
    this.emit("accepting", offered);
    this.engine.acceptCall(true, false);
  };

  reject = (): void => {
    if (this.#ended) return;
    try { this.engine.rejectCall(); } catch {}
    this._forceEnd("rejected");
  };

  end = (): void => {
    if (this.#ended) return;
    if (this.#endTimer) { clearTimeout(this.#endTimer); this.#endTimer = null; }
    try { this.engine.endCall(0, true); } catch {}
    setTimeout(() => this._forceEnd("hangup"), LOCAL_HANGUP_GRACE_MS).unref?.();
  };

  mute = (muted: boolean): void => {
    try { this.engine.setMute(muted); } catch {}
  };

  pushAudio = (pcm: Float32Array, sampleRate = 16000): void => {
    if (this.#ended || !pcm.length) return;
    this.#uplink.push(resampleLinear(pcm, sampleRate, this.#captureRate));
  };

  clearUplink = (): void => { this.#uplink.clear(); };

  get uplinkQueuedMs(): number { return (this.#uplink.length / this.#captureRate) * 1000; }

  waitForEnd = (): Promise<string> => this.#endPromise;

  /** @internal */
  _pullUplink = (frames: number): Float32Array | null => this.#uplink.read(frames);

  /** @internal */
  _setCaptureRate = (rate: number): void => {
    if (rate > 0) this.#captureRate = rate;
  };

  /** @internal — called by VoipClient on WASM call-state change */
  _updateState = (state: number): void => {
    this.#state = state as CallState;
    this.emit("state", state);
    if (state !== CallState.Idle && state !== CallState.Ending) this.#seenLiveState = true;
    if (state === CallState.ReceivedCall) {
      this.#offeredResolver();
      this.emit("offered");
    } else if (state === CallState.PreacceptReceived) {
      this.emit("ringing");
    } else if (state === CallState.Active) {
      if (!this.#connected) {
        this.#connected = true;
        this.emit("connected");
      }
    } else if (state === CallState.ActiveElsewhere) {
      this._forceEnd("answered_elsewhere");
    } else if (state === CallState.Idle || state === CallState.Ending) {
      if (this.direction === "incoming" && !this.#seenLiveState) return;
      this._forceEnd("ended");
    }
  };

  /** @internal */
  _emitAudio = (pcm: Float32Array): void => { this.emit("audio", pcm); };

  /** @internal */
  _forceEnd = (reason: string): void => {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#endTimer) { clearTimeout(this.#endTimer); this.#endTimer = null; }
    this.#uplink.clear();
    this.emit("ended", reason);
    this.#endResolver(reason);
  };
}

/** Top-level client. Connects to WhatsApp and lets you place and answer calls. */
export class VoipClient extends EventEmitter {
  readonly #config: VoipSdkConfig;
  #engine: WasmEngine | null = null;
  #relay: RelayRtcTransport | null = null;
  #signaling: SignalingBridge | null = null;
  #sock: any = null;
  #activeCall: ActiveCall | null = null;
  #baileys: any = null;
  #callNodeQueue: Promise<void> = Promise.resolve();

  // Capture state populated when WASM negotiates audio params
  #capturePtr = 0;
  #captureChunkBytes = 0;
  #captureSampleRate = 16000;
  #captureChannels = 1;
  #captureFramesPerChunk = 320;
  #feeder: AudioFeeder | PushAudioFeeder | null = null;

  constructor(config: VoipSdkConfig) {
    super();
    this.#config = config;
  }

  get activeCall(): ActiveCall | null { return this.#activeCall; }
  get user(): { id?: string; lid?: string } | null { return this.#sock?.authState?.creds?.me ?? null; }

  /** Connect to WhatsApp and bring up the WASM VoIP stack. */
  connect = async (): Promise<void> => {
    this.#baileys = await loadBaileys();
    const { useMultiFileAuthState, default: makeWASocket, DisconnectReason } = this.#baileys;
    const makeSocket: (opts: any) => any =
      makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys;

    const authDir = resolve(this.#config.authDir);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const silentLogger: any = {
      level: "silent",
      child: () => silentLogger,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };

    const createSocket = () => makeSocket({
      auth: state,
      emitOwnEvents: true,
      logger: silentLogger,
      ...(this.#config.socketOptions ?? {}),
    });

    // Connect with auto-reconnect on the post-QR 515 stream-error path.
    await new Promise<void>((resolveOpen, rejectOpen) => {
      let opened = false;
      let retries = 0;
      const maxRetries = 5;

      const connectSocket = () => {
        this.#sock = createSocket();
        this.#sock.ev.on("creds.update", saveCreds);

        process.removeAllListeners("uncaughtException");
        process.on("uncaughtException", (err: any) => {
          const code = err?.output?.statusCode ?? err?.data?.attrs?.code;
          if ((code === 515 || code === "515") && !opened && retries < maxRetries) {
            retries += 1;
            setTimeout(connectSocket, 1500);
          } else if (!opened) {
            rejectOpen(err);
          }
        });

        this.#sock.ev.on("connection.update", (update: any) => {
          if (update.qr) {
            void import("qrcode-terminal")
              .then((qrt) => (qrt.default ?? qrt).generate(update.qr, { small: true }))
              .catch(() => {
                console.log("Scan this QR code in WhatsApp > Linked Devices:");
                console.log(update.qr);
              });
          }
          if (update.connection === "open") {
            opened = true;
            process.removeAllListeners("uncaughtException");
            resolveOpen();
            return;
          }
          if (update.connection === "close" && opened) {
            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
            this.emit("disconnected", {
              statusCode,
              loggedOut: statusCode === DisconnectReason?.loggedOut,
              error: update.lastDisconnect?.error,
            });
            return;
          }
          if (update.connection === "close" && !opened) {
            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect =
              statusCode === 515 || statusCode === DisconnectReason?.restartRequired;
            if (shouldReconnect && retries < maxRetries) {
              retries += 1;
              setTimeout(connectSocket, 1000);
            } else {
              rejectOpen(update.lastDisconnect?.error ?? new Error("socket closed before open"));
            }
          }
        });
      };

      connectSocket();
    });

    this.#signaling = new SignalingBridge({ sock: this.#sock });
    await this.#signaling.init();

    this.#relay = new RelayRtcTransport({
      onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
      onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port),
    });

    this.#engine = new WasmEngine({
      emitSilentPlayback: true,
      callbacks: {
        onSignalingXmpp: (peerJid, callId, xmlPayload) =>
          this.#signaling!.sendSignaling(peerJid, callId, xmlPayload),
        onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
        sendDataToRelay: (data, ip, port) => this.#relay!.send(data, ip, port),
        onAudioCaptureInit: (config) => this.#handleAudioCaptureInit(config),
        onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
        onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
        onAudioPlaybackInit: (config) => this.emit("debug", "playback-init", config),
        onAudioPlaybackData: (audioData) => this.#activeCall?._emitAudio(audioData),
        onLog: (level, message) => this.emit("wasm-log", level, message),
        cryptoHkdf: computeHkdf,
        hmacSha256: computeHmacSha256,
      },
    });

    await this.#engine.initialize();
    this.#signaling.attachEngine(this.#engine);

    const selfPnJid = this.#sock.authState.creds.me?.id;
    const selfLidJid = this.#sock.authState.creds.me?.lid;
    this.#engine.initVoipStack(selfPnJid, toBareJid(selfPnJid), selfLidJid);
    await this.#engine.waitForVoipStackReady();
    try { this.#engine.updateNetworkMedium(2, 0); } catch {}

    this.#sock.ws.on("CB:call", (node: any) => {
      this.#callNodeQueue = this.#callNodeQueue
        .then(() => this.#handleCallNode(node))
        .catch((err) => { this.emit("debug", "call-node-error", String(err?.message ?? err)); });
    });
    this.#sock.ws.on("CB:receipt", (node: any) => {
      if (!isCallReceiptNode(node)) return;
      const call = this.#activeCall;
      if (!call) return;
      const callId = callIdOf(node);
      if (callId && callId !== call.callId) return;
      if (call.direction === "incoming") this.#alignCallCreator(node, Array.isArray(node.content) ? node.content[0] : null);
      this.#signaling!.processIncomingReceipt(node, this.#engine!, call.callId);
    });
  };

  /** Place an outbound voice call. */
  call = async (
    phoneNumber: string,
    opts: { audioSource?: string; durationMs?: number } = {},
  ): Promise<ActiveCall> => {
    if (!this.#engine || !this.#signaling) throw new Error("Not connected. Call connect() first.");
    if (this.#activeCall) throw new Error("A call is already active.");

    const targetNumber = phoneNumber.replace(/\D/g, "");
    const targetPnJid = `${targetNumber}@s.whatsapp.net`;
    const durationMs = opts.durationMs ?? 120_000;
    const audioSource = opts.audioSource ?? "silence";

    const peerLid = await this.#signaling.resolveLid(targetPnJid);
    if (!peerLid) throw new Error(`Could not resolve LID for ${targetPnJid}`);

    for (const jid of [targetPnJid, peerLid]) {
      try { await this.#sock.presenceSubscribe(jid); } catch {}
    }
    await new Promise((r) => setTimeout(r, 750));

    const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid);
    const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)];

    await this.#signaling.ensureSessionsForPeers(deviceList);

    await new Promise((r) => setTimeout(r, 500));
    await this.#signaling.issueTcToken(peerLid);
    const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid);

    const callId = ("00" + randomBytes(16).toString("hex").slice(2)).toUpperCase();

    const call = new ActiveCall(callId, this.#engine, durationMs);
    call._audioSource = audioSource;
    this.#trackCall(call);

    this.#engine.startCall({
      peerJid: peerLid,
      peerPn: targetPnJid,
      peerList: deviceList,
      callId,
      isVideo: false,
      isLidCall: true,
      isFromDialer: false,
      extraData: tcToken,
    });

    return call;
  };

  resolvePhoneNumber = async (jid: string): Promise<string> => {
    if (!jid) return "";
    if (!jid.endsWith("@lid")) return digitsOf(jid);
    try {
      const pn = await this.#sock?.signalRepository?.lidMapping?.getPNForLID?.(toBareJid(jid));
      return digitsOf(pn);
    } catch {
      return "";
    }
  };

  sendText = async (jid: string, text: string): Promise<void> => {
    if (!this.#sock) throw new Error("Not connected.");
    await this.#sock.sendMessage(jid, { text });
  };

  /** Tear down the WhatsApp socket and release resources. */
  disconnect = (): void => {
    this.#activeCall?._forceEnd("disconnect");
    this.#activeCall = null;
    this.#feeder?.stop();
    this.#feeder = null;
    this.#relay?.closeAll();
    this.#engine?.destroy();
    this.#sock?.end?.();
    this.#engine = null;
    this.#relay = null;
    this.#signaling = null;
    this.#sock = null;
  };

  // ─── private ──────────────────────────────────────────────────────────────

  #trackCall = (call: ActiveCall): void => {
    this.#activeCall = call;
    call.once("ended", () => {
      if (this.#activeCall !== call) return;
      this.#activeCall = null;
      this.#feeder?.stop();
      this.#feeder = null;
      try { this.#engine?.stopPlayback(); } catch {}
    });
  };

  #handleCallNode = async (node: any): Promise<void> => {
    const child = Array.isArray(node?.content) ? node.content[0] : null;
    this.emit("call-node", child?.tag ?? "?", { from: node?.attrs?.from, t: node?.attrs?.t, offline: node?.attrs?.offline, callId: callIdOf(node) });
    if (!child || !this.#engine || !this.#signaling) return;
    const callId = callIdOf(node);

    if (child.tag === "offer" && !this.#activeCall) {
      const info = await this.#describeOffer(node, child, callId);
      this.emit("incoming-offer", info);
      if (info.isGroup || info.offline || !callId) return;
      let answer = false;
      try { answer = !!(await this.#config.screenIncomingCall?.(info)); } catch {}
      if (!answer || this.#activeCall) return;
      const call = new ActiveCall(callId, this.#engine, 0, "incoming", info);
      call._audioSource = "push";
      this.#trackCall(call);
      this.emit("debug", "offer-attrs", {
        call: node.attrs,
        offer: child.attrs,
        children: Array.isArray(child.content) ? child.content.map((c: any) => c?.tag) : [],
      });
      this.#alignCallCreator(node, child);
      this.#signaling.processIncomingCall(node, this.#engine, callId);
      this.emit("incoming", call);
      return;
    }

    const call = this.#activeCall;
    if (!call) return;
    if (callId && callId !== call.callId) {
      if (child.tag === "offer") this.emit("incoming-busy", await this.#describeOffer(node, child, callId));
      return;
    }
    if (call.direction === "incoming") this.#alignCallCreator(node, child);
    this.#signaling.processIncomingCall(node, this.#engine, call.callId);
  };

  // A bare "<lid>@lid" call-creator re-encodes as a JID pair the WASM reads as s.whatsapp.net, so it drops the
  // stanza ("mismatched peer id and creator id"); the device form "<lid>:<n>@lid" encodes as an AD JID it reads right.
  #alignCallCreator = (node: any, child: any): void => {
    const from = String(node?.attrs?.from ?? "");
    if (!child?.attrs || !from.endsWith("@lid")) return;
    const fromJid = this.#baileys.jidDecode(from);
    const creator = String(child.attrs["call-creator"] ?? "");
    const creatorJid = creator ? this.#baileys.jidDecode(creator) : null;
    const user = creatorJid?.server === "lid" ? creatorJid.user : fromJid?.user;
    if (!user) return;
    const device = creatorJid?.server === "lid" && creatorJid.device != null ? creatorJid.device : (fromJid?.device ?? 0);
    const aligned = `${user}:${device}@lid`;
    if (creator === aligned) return;
    child.attrs["call-creator"] = aligned;
    this.emit("debug", "call-creator-aligned", { tag: child.tag, from: creator || "(none)", to: aligned });
  };

  #describeOffer = async (node: any, child: any, callId: string): Promise<IncomingCallInfo> => {
    const fromDevice = String(node.attrs?.from ?? "");
    const creator = String(child.attrs?.["call-creator"] ?? "") || fromDevice;
    let callerPn = digitsOf(String(child.attrs?.caller_pn ?? node.attrs?.caller_pn ?? ""));
    if (!callerPn) callerPn = await this.resolvePhoneNumber(creator);
    return {
      callId,
      from: toBareJid(creator),
      fromDevice,
      callerPn: callerPn || undefined,
      pushName: String(node.attrs?.notify ?? "") || undefined,
      isVideo: Array.isArray(child.content) && child.content.some((c: any) => c?.tag === "video"),
      isGroup: child.attrs?.type === "group" || !!child.attrs?.["group-jid"],
      offline: !!(node.attrs?.offline ?? child.attrs?.offline),
      timestamp: Number(node.attrs?.t ?? child.attrs?.t ?? 0),
    };
  };

  #handleCallEvent = (eventType: number, eventData?: string): void => {
    this.emit("call-event", eventType, eventData);
    if (eventType === 16 && eventData) {
      try {
        const parsed = JSON.parse(eventData);
        const info = parsed.call_info ?? parsed.callInfo ?? {};
        const callState = Number(info.call_state ?? info.callState ?? 0);
        const eventCallId = String(info.call_id ?? info.callId ?? "").toUpperCase();
        const call = this.#activeCall;
        if (call && (!eventCallId || eventCallId === call.callId.toUpperCase())) call._updateState(callState);
      } catch {}
    } else if (eventType === 156 && eventData) {
      try {
        const update = JSON.parse(eventData) as RelayListUpdatePayload;
        this.#relay?.updateRelayList(update);
      } catch {}
    }
  };

  #handleAudioCaptureInit = (config: {
    sampleRate: number; channels: number; bitsPerSample: number; framesPerChunk: number;
  }): void => {
    if (!this.#engine) return;
    this.emit("debug", "capture-init", config);
    this.#captureSampleRate = config.sampleRate || 16000;
    this.#captureChannels = config.channels || 1;
    this.#captureFramesPerChunk = config.framesPerChunk || 320;
    const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
    this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
    if (this.#capturePtr) {
      try { this.#engine.free(this.#capturePtr); } catch {}
    }
    this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
    this.#activeCall?._setCaptureRate(this.#captureSampleRate);
  };

  #handleAudioCaptureStart = (): void => {
    if (!this.#engine || !this.#capturePtr) return;
    this.#feeder?.stop();
    const call = this.#activeCall;
    const audioSource = call?._audioSource ?? "silence";
    const sendChunk = (chunk: Float32Array): void => {
      if (this.#engine && this.#capturePtr) this.#engine.sendAudioData(chunk, this.#capturePtr);
    };
    this.#feeder = audioSource === "push" && call
      ? new PushAudioFeeder(
        this.#captureSampleRate,
        this.#captureChannels,
        this.#captureFramesPerChunk,
        sendChunk,
        (frames) => call._pullUplink(frames),
      )
      : new AudioFeeder(
        this.#captureSampleRate,
        this.#captureChannels,
        this.#captureFramesPerChunk,
        sendChunk,
        audioSource,
      );
    this.#feeder.start();
  };

  #handleAudioCaptureStop = (): void => {
    this.#feeder?.stop();
    this.#feeder = null;
    if (this.#engine && this.#capturePtr) {
      try { this.#engine.free(this.#capturePtr); } catch {}
      this.#capturePtr = 0;
    }
  };
}
