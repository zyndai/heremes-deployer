# Zynd Persona Memory — Hermes Deployer × memory-layer

**What it does:** a one-click **Connect Zynd Persona** gives a deployed Hermes
agent its owner's ZYND memory over **MCP** — the agent can save durable facts
(`remember`) and recall them (`get_my_context`), scoped privately to that owner.
Off by default; nothing changes for an agent until its owner connects.

> Design note: this is the **MCP-per-agent** approach. We deliberately did *not*
> add deterministic ingest tees or an image patch — see
> [ZYND_MEMORY_APPROACH_REVIEW.md](./ZYND_MEMORY_APPROACH_REVIEW.md) for why
> (fragility of patching the black-box Nous image vs. idiomatic MCP).

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
   • an mcp_servers.zynd block in config.yaml (url + Bearer token)
        │
        ▼
 Agent has memory over MCP: remember (write) + get_my_context (read),
 bearer-scoped to the owner. No ingest endpoint, no image patch.
```

Each agent is single-tenant: the token scopes memory to that one owner.

---

## 2. User experience

1. Create an agent → it boots → status **running**.
2. A **Connect Zynd Persona** button appears on the agent card.
3. Click → sign in with Google (same Zynd identity) → redirected back.
4. Banner: *"Zynd Persona connected — your agent is redeploying with memory
   enabled."* The agent restarts once to wire the MCP server in.
5. The agent can now recall/save memory via its ZYND MCP tools. Button becomes
   **Reconnect** (rotates the token).

Failure at any step bounces back with a visible `?zynd_error=…` banner.

---

## 3. How memory works (MCP)

memory-layer already ships an authenticated MCP server (`/mcp`, streamable-HTTP,
bearer-scoped per user). The Nous Hermes agent natively supports `mcp_servers` in
`config.yaml`, so the worker just seeds that block with the owner's token:

```yaml
mcp_servers:
  zynd:
    url: "https://api.zynd.ai/mcp"
    headers:
      Authorization: "Bearer <owner 90-day token>"
```

The agent then has the memory-layer MCP toolset — chiefly:
- **`remember`** — save a durable fact the user shared.
- **`get_my_context`** — recall what ZYND knows about the user.

Memory is **agent-driven**: the model calls `remember` for salient facts. To make
it proactive, nudge it via the agent's system prompt (e.g. *"save durable facts
to ZYND memory; check get_my_context each session"*). memory-layer's extraction
pipeline turns saved turns into a structured, decaying assertion graph.

---

## 4. What changed, by repo

### `memory-layer` (Python)
- **`app/config.py`** — second OAuth client (`hermes-deployer` + secret) and
  deployer redirect-origin allowlist.
- **`app/oauth.py`** — the deployer's `authorization_code` exchange returns a
  **90-day personal token**; constant-time client check; redirect_uri bound to
  the auth code and re-validated at `/token` for confidential clients (RFC 6749
  §4.1.3), while PKCE clients (Claude) keep their `code_verifier` binding.
- **`tests/test_oauth_clients.py`** — client + binding unit tests.

### `hermes-deployer` — web (`apps/web`, TypeScript)
- **`src/lib/zynd.ts`** — memory-layer URL / client creds + a proxy-safe origin
  helper (never trusts `x-forwarded-host`).
- **`src/components/AgentCard.tsx`** — Connect / Reconnect button + connected
  indicator.
- **`src/app/api/agents/[id]/zynd/connect|callback/route.ts`** — the OAuth flow
  (HMAC-signed state = login-CSRF safe; exchange code; merge token into the
  encrypted agent secret; set `personaLinked` + re-queue the redeploy).
- **`page.tsx` / `Dashboard.tsx` / `types.ts` / `api/agents/*`** — thread the
  `personaLinked` flag + the success/error banner.

### `hermes-deployer` — worker (`packages/deployer-worker`, TypeScript)
- **`prisma/schema.prisma`** — `Agent.personaLinked`.
- **`src/secrets.ts`** — inject the ZYND token/URL env; `buildZyndMcpBlock` +
  `mergeZyndMcpBlock` build/merge the `mcp_servers.zynd` config (idempotent,
  rotates on reconnect, refuses a foreign `mcp_servers`).
- **`src/lifecycle.ts`** — `ensureZyndMcpConfig` merges the MCP block into
  `config.yaml` on every deploy of a linked agent; skips gracefully if the file
  is sealed to the container uid.
- **`bin/agents-status.ts`** — ops script: fleet + who's linked.

> **No `telegram-gateway` or `infra/hermes-image` changes.** No ingest tee, no
> image patch, no image rebuild — the stock Nous image is used as-is.

---

## 5. What it affects

- **Unlinked agents:** no change.
- **Linked agents:** one brief redeploy when connected, to seed the MCP config.
- **Privacy/security:** single-user per agent; the token is stored **encrypted**
  (AES-GCM in the DB secret), never logged, never returned to the browser. The
  token value is written into `config.yaml` on the agent's private bind mount
  (0660, worker + container uid only — same tier as the Telegram bot token).
- **memory-layer:** unchanged behavior for existing clients; the deployer is just
  a new OAuth client.

---

## 6. Deploy checklist (one-time config)

1. **Shared secret must match:** deployer `ZYND_OAUTH_CLIENT_SECRET` ⇄
   memory-layer `DEPLOYER_OAUTH_CLIENT_SECRET`.
2. Deployer env: `ZYND_MEMORY_URL` (e.g. `https://api.zynd.ai`),
   `DEPLOYER_PUBLIC_URL`. `DEPLOYER_WS_SECRET` (already required) signs the state.
3. memory-layer: add the deployer callback origin to
   `DEPLOYER_ALLOWED_REDIRECT_PREFIXES`.
4. `prisma db push` in `packages/deployer-worker` (adds `personaLinked`).
5. Deploy `apps/web` (Vercel) + memory-layer (Render). **No image rebuild.**

---

## 7. Security

Adversarial review passed. Fixed: timing side-channel in the client check,
open-redirect via a spoofable host header, and the `redirect_uri` binding at
`/token`. Verified safe against login-CSRF, code replay, and cross-owner linking.

---

## 8. Test status

| Package | Result |
|---|---|
| memory-layer | oauth client + binding unit tests pass |
| deployer-worker | ZYND/MCP unit tests pass · typecheck clean |
| telegram-gateway | unchanged (back to stock) · tests pass |
| apps/web | typecheck clean |
