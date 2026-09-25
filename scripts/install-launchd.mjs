import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "ai.hermes.whatsapp-voice";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hermesHome = process.env.HERMES_HOME || join(homedir(), ".hermes");
const logs = join(hermesHome, "logs");
const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = `gui/${process.getuid()}`;
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

try { execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" }); } catch {}

if (process.argv.includes("--uninstall")) {
  rmSync(plist, { force: true });
  console.log(`removed ${LABEL}`);
  process.exit(0);
}

mkdirSync(logs, { recursive: true });
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(join(repo, "hermes-voice", "daemon.mjs"))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HERMES_HOME</key><string>${xml(hermesHome)}</string>
    <key>PATH</key><string>${xml(process.env.PATH || "/usr/bin:/bin")}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>StandardOutPath</key><string>${xml(join(logs, "whatsapp-voice.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logs, "whatsapp-voice.error.log"))}</string>
</dict>
</plist>
`);
execFileSync("launchctl", ["bootstrap", domain, plist]);
console.log(`installed ${LABEL} (${plist})`);
console.log(`logs: ${join(logs, "whatsapp-voice.log")}`);
