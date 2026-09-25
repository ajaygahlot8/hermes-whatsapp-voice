from __future__ import annotations

import inspect
import json
import os
import re
import sys
import threading
import time
import traceback
from pathlib import Path

PLUGIN_DIR = Path(os.environ.get("HERMES_LIVE_VOICE_DIR") or Path.home() / ".hermes" / "plugins" / "talk-desktop")
sys.path.insert(0, str(PLUGIN_DIR / "dashboard"))

import plugin_api as talk
import talk_identity

WHATSAPP_LANE_LINE = (
    "You are live on a WhatsApp voice call that the operator placed to the Hermes bot number; "
    "the operator hanging up ends the call."
)
AUTO_LANGUAGE_DIRECTIVE = (
    "LANGUAGE AND VOICE: Reply in the language the caller is speaking (for example Hindi or English) "
    "and switch when they switch. Sound like a native speaker of that language."
)
LANGUAGE = (os.environ.get("WHATSAPP_VOICE_LANGUAGE") or "en").strip().lower()

_out_lock = threading.Lock()
_base_persona = talk._codexlive_persona


def _accepts(fn, name: str) -> bool:
    try:
        return name in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


def _language_kwargs(fn) -> dict:
    if not _accepts(fn, "language"):
        return {}
    return {"language": "es" if LANGUAGE == "es" else "en"}


def _send(obj: dict) -> None:
    with _out_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def _phone_persona(note: str):
    def build(profile, *args, **kwargs):
        text = _base_persona(profile, *args, **kwargs)
        text = text.replace(talk_identity.lane_line("dashboard"), WHATSAPP_LANE_LINE)
        if LANGUAGE == "auto":
            text = re.sub(r"LANGUAGE AND VOICE:.*?(?=\n\n|\Z)", AUTO_LANGUAGE_DIRECTIVE, text, count=1, flags=re.S)
        return f"{text}\n\n{note}" if note else text
    return build


def _start(req: dict) -> dict:
    offer = str(req.get("offer") or "")
    if not offer:
        raise ValueError("missing SDP offer")
    with talk._CL_LOCK:
        talk._codexlive_persona = _phone_persona(str(req.get("note") or "").strip())
        try:
            result = talk._codexlive_start(
                req.get("profile") or None,
                str(req.get("voice") or "cove"),
                offer,
                **_language_kwargs(talk._codexlive_start),
            )
        finally:
            talk._codexlive_persona = _base_persona
    name = talk._bot_display_name(req["profile"]) if req.get("profile") else "Hermes"
    return {**result, "botName": name}


def _warm(req: dict) -> dict:
    with talk._CL_LOCK:
        talk._cl_ensure()
        thread_id = talk._cl_thread_ensure(**_language_kwargs(talk._cl_thread_ensure))
    return {"threadId": thread_id}


def _stop(req: dict) -> dict:
    thread_id = str(req.get("threadId") or talk._CL.get("thread_id") or "")
    with talk._CL_LOCK:
        talk._codexlive_stop(thread_id)
    return {}


def _interrupt(req: dict) -> dict:
    turn_id = str(req.get("turnId") or "")
    thread_id = str(req.get("threadId") or talk._CL.get("thread_id") or "")
    if not turn_id or not thread_id:
        raise ValueError("missing turnId/threadId")
    talk._cl_request("turn/interrupt", {"threadId": thread_id, "turnId": turn_id}, timeout=8)
    return {}


def _usage(req: dict) -> dict:
    duration_ms = max(0, int(req.get("durationMs") or 0))
    if duration_ms <= 0:
        return {"recorded": False}
    path = PLUGIN_DIR / "data" / "voice-usage.json"
    now_ms = int(time.time() * 1000)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        sessions = data.get("sessions") if isinstance(data, dict) else None
        if not isinstance(sessions, list):
            sessions = []
    except (OSError, ValueError):
        sessions = []
    sessions.append({"t": now_ms, "ms": duration_ms, "audio_ms": max(0, int(req.get("audioMs") or 0)), "src": "whatsapp"})
    keep = [s for s in sessions if isinstance(s, dict) and int(s.get("t") or 0) > now_ms - 8 * 24 * 3600 * 1000]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"sessions": keep[-2000:]}, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    return {"recorded": True}


HANDLERS = {
    "ping": lambda req: {"pong": True},
    "warm": _warm,
    "start": _start,
    "stop": _stop,
    "interrupt": _interrupt,
    "usage": _usage,
}


def _handle(req: dict) -> None:
    rid = req.get("id")
    handler = HANDLERS.get(str(req.get("cmd") or ""))
    if handler is None:
        _send({"id": rid, "ok": False, "error": f"unknown cmd {req.get('cmd')!r}"})
        return
    try:
        _send({"id": rid, "ok": True, **handler(req)})
    except Exception as exc:
        _send({"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"[:500],
               "trace": traceback.format_exc()[-1500:]})


def main() -> None:
    _send({"event": "ready", "pid": os.getpid()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            _send({"ok": False, "error": "bad json"})
            continue
        threading.Thread(target=_handle, args=(req,), daemon=True).start()
    proc = talk._CL.get("proc")
    if proc is not None and proc.poll() is None:
        talk._terminate(proc)


if __name__ == "__main__":
    main()
