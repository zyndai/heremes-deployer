# Zynd Persona Memory — Hermes Deployer × memory-layer

**What it does:** lets any user give their deployed Hermes agent a personal,
persistent memory tied to their Zynd account. After a one-click **Connect Zynd
Persona**, everything the user types (dashboard chat *and* Telegram) is ingested
into their private ZYND memory, and the agent can recall it. Off by default —
nothing changes for an agent until its owner opts in.

Built 2026-07-08.

---

## 1. The idea in one picture

```
 Owner clicks "Connect Zynd Persona" on a running agent
        │
        ▼
 apps/web ──▶ memory-layer OAuth2 (reuses the existing Zynd/Google sign-in)
        │           client_id = "hermes-deployer"
        ▼
 90-day ZYND token ──▶ stored (encrypted) in the agent's secret
        │
        ▼
 deployer-worker redeploys the agent with:
   • ZYND_MEMORY_TOKEN / ZYND_MEMORY_URL in the container env
   • an mcp_servers.zynd block in config.yaml   → agent can RECALL memory
        │
        ▼
 Every user turn is INGESTED into that owner's ZYND memory:
   • Telegram  → telegram-gateway tee
   • Dashboard → in-image patch (dashboard chat is a websocket)
```

Each agent is single-tenant: only its owner's messages go into that owner's
memory, authenticated by the owner's token.

---

## 2. User experience

1. Create an agent → it boots → status **running**.
2. A **Connect Zynd Persona** button appears on the agent card.
3. Click → sign in with Google (same Zynd identity) → redirected back.
4. Banner: *"Zynd Persona connected — your agent is redeploying with memory
   enabled."* The agent restarts once to wire memory in.
5. From then on, messages are captured to memory and the agent can recall them.
   The button becomes **Reconnect** (rotates the token).

Failure at any step bounces back with a visible `?zynd_error=…` banner — never a
silent failure.

---

## 3. How capture works (two paths)

Messages arrive two ways, so there are two tees. Both are **fire-and-forget**
(a memory outage never breaks the chat), short turns (<40 chars) are dropped
server-side as noise, and duplicates are ignored.

| Channel | How it's captured |
|---|---|
| **Telegram** | `telegram-gateway` reads the agent's `ZYND_MEMORY_TOKEN` (via `docker inspect`) and POSTs each linked user turn to `/ingest`. |
| **Dashboard** | The dashboard chat is a WebSocket the outside can't tap, so an in-image patch (`patch-ingest-tee.py`) hooks the agent's `sanitize_api_messages` and POSTs the latest user turn on a daemon thread. Covers dashboard + cron too. |

Recall (both channels) is via the MCP server wired into `config.yaml`: the agent
gets `remember` (save a fact) and `get_my_context` (what do you know about me)
tools, bearer-scoped to the owner.

---

## 4. What changed, by repo

### `memory-layer` (Python)
- **`app/config.py`** — added a second OAuth client (`hermes-deployer` +
  secret) and deployer redirect-origin allowlist.
- **`app/oauth.py`** — accept both clients; the deployer's `authorization_code`
  exchange returns a **90-day personal token** (no refresh loop needed in a
  container). Security hardening: constant-time client check; `redirect_uri`
  bound to the auth code and re-validated at `/token` (RFC 6749 §4.1.3).
- **`tests/test_oauth_clients.py`** — new unit tests (client logic + redirect_uri
  binding).

### `hermes-deployer` — web (`apps/web`, TypeScript)
- **`src/lib/zynd.ts`** *(new)* — memory-layer URL / client id / secret helpers +
  a proxy-safe origin helper (does **not** trust `x-forwarded-host`).
- **`src/components/AgentCard.tsx`** — the Connect / Reconnect button + connected
  state.
- **`src/app/api/agents/[id]/zynd/connect/route.ts`** *(new)* — starts the OAuth
  flow with an HMAC-signed `state` (binds agent + owner → login-CSRF safe).
- **`src/app/api/agents/[id]/zynd/callback/route.ts`** *(new)* — verifies state +
  session, exchanges the code, merges `ZYND_MEMORY_TOKEN`/`ZYND_MEMORY_URL` into
  the agent's encrypted secret, sets `personaLinked` + re-queues the redeploy.
- **`page.tsx` / `Dashboard.tsx` / `types.ts` / `api/agents/*`** — thread the new
  `personaLinked` flag through + the success/error banner.

### `hermes-deployer` — worker (`packages/deployer-worker`, TypeScript)
- **`prisma/schema.prisma`** — new `Agent.personaLinked` field.
- **`src/secrets.ts`** — `buildAgentEnv` injects the ZYND env; `buildZyndMcpBlock`
  + `mergeZyndMcpBlock` build/merge the `mcp_servers.zynd` config (idempotent,
  rotates on reconnect, refuses a foreign `mcp_servers`).
- **`src/lifecycle.ts`** — `ensureZyndMcpConfig` merges the MCP block into
  `config.yaml` on every deploy of a linked agent; gracefully skips if the file
  is sealed to the container uid.
- **tests** — new ZYND/MCP tests; fixed 2 pre-existing stale Cloudflare-model
  tests + a pre-existing TS strictness error.

### `hermes-deployer` — Telegram (`packages/telegram-gateway`, TypeScript)
- **`src/zynd-ingest.ts`** *(new)* — the `/ingest` client.
- **`src/types.ts` / `src/agent-resolver.ts`** — `AgentEndpoint` carries the ZYND
  token/URL, read from container env.
- **`src/dispatch.ts` / `bin/gateway.ts`** — tee every linked user turn.
- **`test/dispatch.test.ts`** — new tee tests.

### `hermes-deployer` — agent image (`infra/hermes-image`)
- **`patch-ingest-tee.py`** *(new)* — the dashboard-capture patch.
- **`Dockerfile`** — runs the patch (after `patch-empty-assistant.py`).
- **`README.md`** — documents the patch + the anchor re-verify step.

---

## 5. What it affects

- **Unlinked agents:** no change — behave exactly as before.
- **Linked agents:** one brief redeploy when connected, to wire memory in.
- **Privacy/security:** single-user per agent; the token is stored **encrypted**
  (AES-GCM in the DB secret), never logged, never returned to the browser.
- **memory-layer:** `persona_enabled` stays off — the flow works without it
  (persona only gates profile seeding/matching).

---

## 6. Deploy checklist (one-time config)

1. **Shared secret must match:** deployer `ZYND_OAUTH_CLIENT_SECRET` ⇄
   memory-layer `DEPLOYER_OAUTH_CLIENT_SECRET`.
2. Set deployer `ZYND_MEMORY_URL` (e.g. `https://api.zynd.ai`) and
   `DEPLOYER_PUBLIC_URL` (prod). `DEPLOYER_WS_SECRET` (already required) is reused
   to sign the OAuth state.
3. Ensure the deployer's callback origin is in memory-layer
   `deployer_allowed_redirect_prefixes` (defaults cover `deployer.zynd.ai` +
   localhost:3100).
4. `prisma db push` in `packages/deployer-worker` (adds `personaLinked`).
5. Rebuild + push the Hermes image (now carries `patch-ingest-tee.py`), bump
   `HERMES_IMAGE`.

### The one live check (needs Docker + the pinned image)
Confirm the in-image patch anchor after any base-image bump:
```bash
docker run --rm --entrypoint cat <image> /opt/hermes/agent/agent_runtime_helpers.py
```
The patch **fails the build loudly** if the `sanitize_api_messages` anchor
moved, so an unpatched image can never ship silently.

---

## 7. Security

Adversarial review passed. Verified safe against login-CSRF, code replay,
cross-owner linking, token leakage, and open redirect. Three issues found and
fixed: a timing side-channel in the client check, an open-redirect via a
spoofable host header, and the missing `redirect_uri` binding at `/token`.

---

## 8. Test status

| Package | Result |
|---|---|
| memory-layer | 76 unit tests pass (154 collected, no import breakage) |
| deployer-worker | 147/147 pass · typecheck clean |
| telegram-gateway | 27 pass · typecheck clean |
| apps/web | typecheck clean |
| in-image patch | compiles, composes with existing patches, idempotent, fails-loud, behavioral test (real POST / dedup / no-token) all pass |
