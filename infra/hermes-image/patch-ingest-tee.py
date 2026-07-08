#!/usr/bin/env python3
"""Tee every user turn into ZYND memory (memory-layer /ingest) from inside the agent.

Why: the Hermes dashboard web chat streams over a WebSocket (port 9119), not the
HTTP /v1/chat/completions API, so an external HTTP proxy tee cannot see dashboard
messages. Hooking the pre-call sanitizer ``sanitize_api_messages`` — which runs
unconditionally before EVERY LLM call and holds the full message history —
captures user turns from ALL channels (dashboard, Telegram, cron) in one place.

For each call we take the most recent user turn and POST it to /ingest on a daemon
thread with a short timeout, so memory capture never delays or breaks the reply.
A process-local seen-hash set suppresses the re-send that would otherwise happen
on every call (the sanitizer sees the whole history each time); the memory-layer
also dedups by content hash as a backstop. No-op unless the agent is
persona-linked (ZYND_MEMORY_TOKEN is injected into the container env only then).

Ordering: this MUST run AFTER patch-empty-assistant.py. That patch's anchor spans
``messages = filtered`` … ``surviving_call_ids: set = set()``; we insert BEFORE the
``surviving_call_ids`` line only, leaving that anchor intact for either patch order.

Build-time only; idempotent. Fails loudly if the upstream anchor disappears so a
version bump can't silently ship an unpatched image.
"""

import sys

MARKER = "ZYND ingest tee"

# The typed local init that follows the sanitizer's message-filtering block. It
# survives patch-empty-assistant.py (that patch re-emits this exact line), so
# anchoring here composes regardless of which patch ran first.
NEEDLE = "    surviving_call_ids: set = set()"

REPLACEMENT = '''    # ZYND ingest tee: capture the latest user turn into ZYND memory so dashboard
    # (WebSocket) chats are ingested too, not only the HTTP/Telegram path. Runs on
    # a daemon thread with a short timeout so it never delays or breaks the LLM
    # call; no-op unless the agent is persona-linked (ZYND_MEMORY_TOKEN present).
    try:
        import os as _zynd_os
        _zynd_tok = _zynd_os.environ.get("ZYND_MEMORY_TOKEN")
        if _zynd_tok:
            _zynd_text = None
            for _zm in reversed(messages):
                if _zm.get("role") == "user":
                    _zc = _zm.get("content")
                    if isinstance(_zc, str):
                        _zynd_text = _zc
                    elif isinstance(_zc, list):
                        _zynd_text = " ".join(
                            (_zp.get("text") or "") for _zp in _zc if isinstance(_zp, dict)
                        ).strip()
                    break
            if _zynd_text and _zynd_text.strip():
                import hashlib as _zynd_hl
                _zynd_seen = globals().setdefault("_ZYND_SEEN", set())
                _zynd_h = _zynd_hl.sha256(_zynd_text.encode("utf-8")).hexdigest()
                if _zynd_h not in _zynd_seen:
                    if len(_zynd_seen) > 500:
                        _zynd_seen.clear()
                    _zynd_seen.add(_zynd_h)
                    import json as _zynd_json, threading as _zynd_th
                    import urllib.request as _zynd_ur
                    _zynd_url = (_zynd_os.environ.get("ZYND_MEMORY_URL") or "https://api.zynd.ai").rstrip("/")
                    _zynd_conv = (_zynd_os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN") or "hermes")[:64]

                    def _zynd_send(_t, _tok, _url, _conv):
                        try:
                            _b = _zynd_json.dumps({
                                "source_system": "hermes",
                                "conversation_id": _conv,
                                "turns": [{"role": "user", "content": _t}],
                            }).encode("utf-8")
                            _rq = _zynd_ur.Request(
                                _url + "/ingest", data=_b, method="POST",
                                headers={"content-type": "application/json",
                                         "authorization": "Bearer " + _tok},
                            )
                            _zynd_ur.urlopen(_rq, timeout=5).read()
                        except Exception:
                            pass

                    _zynd_th.Thread(
                        target=_zynd_send, args=(_zynd_text, _zynd_tok, _zynd_url, _zynd_conv),
                        daemon=True,
                    ).start()
    except Exception:
        pass

    surviving_call_ids: set = set()'''

path = sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes/agent/agent_runtime_helpers.py"

with open(path, "r", encoding="utf-8") as f:
    src = f.read()

if MARKER in src:
    print(f"[patch] already applied to {path}")
    sys.exit(0)

count = src.count(NEEDLE)
if count != 1:
    print(
        f"[patch] FATAL: expected exactly one anchor in {path}, found {count}; "
        f"Hermes changed sanitize_api_messages — re-check the patch.",
        file=sys.stderr,
    )
    sys.exit(1)

src = src.replace(NEEDLE, REPLACEMENT, 1)
with open(path, "w", encoding="utf-8") as f:
    f.write(src)

print(f"[patch] added ZYND ingest tee to {path}")
