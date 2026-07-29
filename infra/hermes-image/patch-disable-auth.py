#!/usr/bin/env python3
"""Disable Hermes's own dashboard auth gate.

Why: Hermes >=0.16.1 hardened should_require_auth() so that any non-loopback
bind (including 0.0.0.0 used by container deployments) ALWAYS requires OAuth
or password auth — the HERMES_DASHBOARD_INSECURE env var was removed as part
of the June 2026 hermes-0day mitigation. For self-hosted containers behind
Caddy, Caddy's forward_auth gate is the real trust boundary; the internal
Hermes auth gate is redundant and blocks the dashboard.

Fix: patch should_require_auth to always return False. The function's single
return statement is the only change; the rest of the auth machinery is left
intact so login/OAuth routes (used for provider auth, not dashboard access)
are unaffected.

Build-time only; idempotent.
"""

import sys

MARKER = "UA patch: auth gate disabled"

NEEDLE = "    return host not in _LOOPBACK_HOST_VALUES"
REPLACEMENT = "    return False  # UA patch: auth gate disabled; Caddy forward_auth is the real trust boundary"

path = sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes/hermes_cli/web_server.py"

with open(path, "r", encoding="utf-8") as f:
    src = f.read()

if MARKER in src:
    print(f"[patch] already applied to {path}")
    sys.exit(0)

count = src.count(NEEDLE)
if count == 0:
    print(
        f"[patch] FATAL: anchor not found in {path}; Hermes changed "
        f"should_require_auth — re-check the patch.",
        file=sys.stderr,
    )
    sys.exit(1)

src = src.replace(NEEDLE, REPLACEMENT, 1)
with open(path, "w", encoding="utf-8") as f:
    f.write(src)

print(f"[patch] disabled auth gate in {path}")
