#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HERMES_HOME = process.env.HERMES_HOME ?? join(homedir(), ".hermes");
const ENV_FILE = join(HERMES_HOME, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const env = process.env;
const AUTH = env.WHATSAPP_CALLER_AUTH ?? join(HERMES_HOME, "platforms/whatsapp/caller-session");
const RING_MS = Number(env.WHATSAPP_CALLER_RING_TIMEOUT_MS) || 45_000;
const VOICE = env.WHATSAPP_CALLER_VOICE ?? "Samantha";
const CONTROL = `http://127.0.0.1:${env.WHATSAPP_VOICE_CONTROL_PORT || 3910}`;
const [, , cmd, target, ...rest] = process.argv;

// libsignal prints whole session records, private keys included, on console.log/info.
for (const k of ["log", "info"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { if (typeof a[0] === "string" && /^(Closing (open )?session|Opening session|Removing old closed session|Migrating session)/.test(a[0])) return; orig(...a); };
}
const silent = { level: "silent", child: () => silent, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

const link = async () => {
  const { default: makeWASocket, useMultiFileAuthState } = await import("@whiskeysockets/baileys");
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  if (state.creds.registered) {
    console.log(`already linked (${AUTH})`);
    process.exit(0);
  }
  const num = (target ?? env.WHATSAPP_CALLER_NUMBER ?? "").replace(/\D/g, "");
  if (!num) {
    console.error("no number: pass the bot number or set WHATSAPP_CALLER_NUMBER");
    process.exit(1);
  }
  const start = () => {
    let asked = false;
    const sock = makeWASocket({ auth: state, logger: silent, markOnlineOnConnect: false });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (u) => {
      if (u.qr && !asked) {
        asked = true;
        console.log(`PAIRING CODE for +${num}: ${await sock.requestPairingCode(num)}`);
      }
      if (u.connection === "open") {
        console.log(`linked as ${sock.user?.id}`);
        setTimeout(() => process.exit(0), 3000);
      }
      if (u.connection === "close") {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === 515) start();
        else if (code === 408 && !state.creds.registered) start();
        else {
          console.error(`closed: ${code}`);
          process.exit(1);
        }
      }
    });
  };
  start();
};

const call = async () => {
  const message = rest.join(" ");
  const daemonUp = await fetch(`${CONTROL}/status`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  let result;
  if (daemonUp) {
    result = await fetch(`${CONTROL}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: target, message, voice: VOICE, ringTimeoutMs: RING_MS }),
    }).then((r) => r.json(), (e) => ({ to: target, answered: false, reason: `daemon_error: ${e.message}` }));
  } else {
    const { VoipClient } = await import("../dist/index.mjs");
    const { placeMessageCall } = await import("../hermes-voice/outbound.mjs");
    const client = new VoipClient({ authDir: AUTH, socketOptions: { markOnlineOnConnect: false } });
    await client.connect();
    result = await placeMessageCall(client, {
      to: target.replace(/\D/g, ""),
      message,
      ttsVoice: VOICE,
      ringTimeoutMs: RING_MS,
      log: (m) => console.error(m),
    });
    client.disconnect();
  }
  console.log(JSON.stringify(result));
  process.exit(result.answered ? 0 : 2);
};

if (cmd === "link") await link();
else if (cmd === "call" && target && rest.length) await call();
else {
  console.error("usage: hermes-call.mjs link [bot-number] | call <number> <text|audio-file>");
  process.exit(1);
}
