#!/usr/bin/env python3
"""Drop empty assistant turns from the LLM message history before every call.

Why: Hermes's scheduled-job (cron) loop can leave a trailing assistant message
with empty content and no tool_calls in the conversation — the model returned an
"empty turn" (no text, no tool call). Hermes then retries and re-sends the whole
history *including* that empty message. Strict providers reject it:

  * Cloudflare Mistral  → 400 "invalid assistant message: content=''"
  * Cloudflare Llama    → 413 (history bloated by the dead turn)
  * Cloudflare gpt-oss  → empty again ("No reply")

The interactive path doesn't hit this (smaller context, no retry-with-empty),
which is why running the steps by hand works but the scheduler falls over.

Fix: the pre-call sanitizer ``sanitize_api_messages`` in agent_runtime_helpers.py
runs unconditionally before every LLM call. We add a pass there that strips
assistant messages which carry no usable content AND no tool_calls, so the empty
turn never reaches the provider and the retry sees clean history.

Build-time only; idempotent. Fails loudly if the upstream anchor disappears so a
version bump can't silently ship an unpatched image.
"""

import sys

MARKER = "UA patch: drop empty assistant turns"

# Upstream v>0.16.0 added repair_empty_non_final_messages which heals
# non-final empty turns with a placeholder. Insert our drop pass AFTER
# that healing so it catches any remaining empty assistant turns
# (e.g. final empty turns that upstream leaves untouched).
NEEDLE = "    messages = repair_empty_non_final_messages(messages)\n\n    # --- Drop empty / malformed tool_calls arrays on assistant messages ---"

REPLACEMENT = '''    messages = repair_empty_non_final_messages(messages)

    # UA patch: drop empty assistant turns (no text, no tool_calls) before any
    # LLM call. The cron loop can leave a trailing empty assistant message in
    # history; re-sending it makes strict providers fail every retry (Cloudflare
    # Mistral 400 "content=''", Llama 413, gpt-oss "No reply"). Tool-call turns
    # legitimately have empty content and are preserved. This runs after
    # repair_empty_non_final_messages (which heals mid-transcript empty messages
    # with a placeholder) so we only drop what upstream intentionally left alone.
    def _ua_assistant_is_empty(_m):
        if _m.get("role") != "assistant":
            return False
        if _m.get("tool_calls"):
            return False
        _c = _m.get("content")
        if _c is None:
            return True
        if isinstance(_c, str):
            return not _c.strip()
        if isinstance(_c, list):
            for _part in _c:
                if isinstance(_part, dict):
                    if (_part.get("text") or "").strip():
                        return False
                elif str(_part).strip():
                    return False
            return True
        return False

    _ua_before = len(messages)
    messages = [_m for _m in messages if not _ua_assistant_is_empty(_m)]
    if len(messages) != _ua_before:
        _ra().logger.debug(
            "Pre-call sanitizer: dropped %d empty assistant turn(s)",
            _ua_before - len(messages),
        )

    # --- Drop empty / malformed tool_calls arrays on assistant messages ---'''

path = sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes/agent/agent_runtime_helpers.py"

with open(path, "r", encoding="utf-8") as f:
    src = f.read()

if MARKER in src:
    print(f"[patch] already applied to {path}")
    sys.exit(0)

count = src.count(NEEDLE)
if count == 0:
    print(
        f"[patch] FATAL: anchor not found in {path}; Hermes changed "
        f"sanitize_api_messages — re-check the patch.",
        file=sys.stderr,
    )
    sys.exit(1)

src = src.replace(NEEDLE, REPLACEMENT, 1)
with open(path, "w", encoding="utf-8") as f:
    f.write(src)

print(f"[patch] added empty-assistant-turn drop to {path}")
