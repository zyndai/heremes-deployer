# Zynd Memory Integration — Approach Review

**Question raised:** did we over-build? Should we have just configured the
memory-layer **MCP per agent** instead of the full OAuth + ingest-tee + image-patch
integration?

**Short answer:** half right. The MCP-per-agent piece is the clean core and we
already built it. The *deterministic capture* layer (telegram tee + image patch)
is the over-build — especially the image patch.

---

## The integration is really 3 layers

| Layer | What it is | Verdict |
|---|---|---|
| **Auth / Connect** | OAuth "Connect Zynd Persona" → per-user ZYND token → stored (encrypted) + injected into the agent | **Keep.** You need *some* way to get each user's token into their agent; one-click Google beats copy-pasting a token. |
| **MCP per agent** | `mcp_servers.zynd` block in the agent's `config.yaml` → agent gets `remember` + `get_my_context` (+ the other memory-layer MCP tools) | **This IS "configure the MCP per agent." Already built.** Native to the Nous image, zero fragility. Read *and* write memory through pure MCP — no ingest endpoint needed. |
| **Deterministic capture** | telegram tee + **image patch** on the Nous agent → POST *every* user turn to `/ingest` | **The over-build.** Buys "capture everything the model didn't choose to remember," at the cost of real fragility. |

So the thing the question describes — MCP scoped per agent by the user's token —
is exactly the clean core, and it's done.

---

## Where the concern is right — the capture layer

The **image patch (`patch-ingest-tee.py`) is the most fragile thing in the
system.** It text-edits a third-party black-box image's internals
(`sanitize_api_messages` in `agent_runtime_helpers.py`). It **will break on Nous
version bumps** (it fails the build loudly, but still needs re-anchoring each time).
It also forces a per-release image rebuild + push.

That fragility buys exactly one thing: guaranteed capture of **dashboard**
(WebSocket) messages the model doesn't choose to `remember`.

### The real product question
Is **"ingest literally everything the user types"** a hard requirement, or is
**"the agent remembers salient facts and can recall them"** enough?

- **Enough** → drop the image patch (and optionally the telegram tee). Pure MCP:
  the agent calls `remember` for durable facts (nudge it via the system prompt:
  *"save durable facts to ZYND memory; check get_my_context each session"*). This
  is the **standard MCP memory pattern** — how ChatGPT/Claude memory works.
- **Truly need every keystroke** → keep the tees. But the memory-layer extraction
  pipeline already filters noise (<40 chars) and extracts assertions, so capturing
  every turn mostly adds junk.

---

## Recommendation (senior-eng honest)

**Ship: Connect flow + MCP per agent. Drop the image patch.** Optionally keep the
telegram tee (it's clean — no black-box patching — but skippable).

- ~40% of the code, **none** of the fragility.
- Idiomatic MCP; per-user-token-scoped, so private per agent.
- **Removes the entire "rebuild + push the image" deploy step** — you can keep
  running the stock/existing Nous image.

### What changes to strip it down
1. Remove `infra/hermes-image/patch-ingest-tee.py` + its `Dockerfile` line
   (kills the fragile image dependency → no image rebuild needed).
2. Keep the `mcp_servers.zynd` config seed + the Connect (OAuth) flow.
3. Decide on the telegram tee:
   - **keep** → Telegram messages auto-saved to memory;
   - **drop** → agent-driven memory only (via `remember`).

The fragile parts are **isolated**: the image patch is 1 file + 1 Dockerfile line;
the telegram tee is ~4 small edits across the gateway. Nothing is deployed yet, so
this is the ideal moment to cut them.

---

## Minimal viable integration (if we simplify)

```
Owner clicks Connect ─▶ OAuth ─▶ 90-day ZYND token ─▶ agent secret (encrypted)
                                                          │
                                                          ▼
                        worker seeds config.yaml:  mcp_servers.zynd (url + Bearer token)
                                                          │
                                                          ▼
              Agent has memory: remember (write) + get_my_context (read) via MCP.
              No ingest endpoint, no telegram tee, no image patch, no image rebuild.
```

That's the clean version the original question points at.
