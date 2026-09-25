import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "https://raw.githubusercontent.com/SheIITear/baileys-caller/36c6e0a03d7d80723b4f203a45d4cb9e1a4b86f6/assets/wasm";
const FILES = {
  "whatsapp.wasm": "5f1350997c0bf3213782a7bdd3c846529d328552bfa7b87f10224f021346ce35",
  "loader.js": "f26ed41f30313d790b3022476b7e88c6d99941909c30d0a35c15619d98826bad",
  "worker-modules.js": "4f52cd02c8310a19820176362d292687b02c4a9cf81cc78fbf8e5cc4a28f4e99",
};

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "wasm");
mkdirSync(dir, { recursive: true });
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

for (const [name, digest] of Object.entries(FILES)) {
  const target = join(dir, name);
  if (existsSync(target) && sha256(readFileSync(target)) === digest) {
    console.log(`ok       ${name} (already present)`);
    continue;
  }
  const res = await fetch(`${UPSTREAM}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== digest) throw new Error(`${name}: SHA-256 mismatch (got ${got})`);
  writeFileSync(target, buf);
  console.log(`fetched  ${name} (${buf.length} bytes, SHA-256 verified)`);
}
