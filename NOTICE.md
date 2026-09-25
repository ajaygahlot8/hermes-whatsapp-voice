# Third-party notices

## baileys-caller

`src/`, `examples/call.mts` and `scripts/fetch-wasm-from-browser.mjs` are derived from
[SheIITear/baileys-caller](https://github.com/SheIITear/baileys-caller) (commit `36c6e0a`),
MIT © 2025 ShellTear. This repository adds incoming-call support and push-mode audio (see the
README).

## hermes-live-voice

`hermes-voice/voice_broker.py` imports, at runtime, the backend of
[Synero/hermes-live-voice](https://github.com/Synero/hermes-live-voice) (MIT © 2026 Synero, with parts
derived from [TheSmokeDev/hermes-talk](https://github.com/TheSmokeDev/hermes-talk), MIT). No code
from it is copied here; it must be installed separately as a Hermes plugin.

## WhatsApp Web VoIP assets

`assets/wasm/` (`whatsapp.wasm`, `loader.js`, `worker-modules.js`) is WhatsApp's code. It is **not**
included in this repository and is not covered by its license. `npm run fetch-wasm` downloads it to
your machine from the pinned baileys-caller commit and checks it against SHA-256 digests.
`npm run fetch-wasm:browser` pulls the current build from a WhatsApp Web tab you have open.

## Other dependencies

Installed from npm under their own licenses, including `@whiskeysockets/baileys` (MIT),
`@roamhq/wrtc` (BSD-2-Clause) and `typescript` (Apache-2.0).

WhatsApp is a trademark of Meta Platforms, Inc. GPT-Live-1 and Codex are OpenAI products. This
project is not affiliated with or endorsed by Meta, OpenAI or Nous Research.
