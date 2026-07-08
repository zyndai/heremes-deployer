// Tee user turns into the owner's ZYND memory (memory-layer /ingest). The token
// is the owner's 90-day ZYND personal token, injected into the agent container
// at deploy time and read back off the endpoint; every turn ingests under that
// user. conversation_id groups a chat; the memory-layer derives the USER from
// the bearer token, not from this field.

export interface ZyndIngestConfig {
  baseUrl: string;
  token: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

// POST one user turn. Throws on network/HTTP error so the caller can log; the
// caller MUST treat this as fire-and-forget (a memory outage must never break
// the chat relay). Short turns (<40 chars) are dropped server-side as noise, so
// we don't pre-filter.
export async function ingestUserTurn(
  cfg: ZyndIngestConfig,
  conversationId: string,
  text: string,
  timestamp: string,
): Promise<void> {
  const f = cfg.fetchFn ?? fetch;
  const res = await f(`${cfg.baseUrl.replace(/\/+$/, "")}/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({
      source_system: "hermes",
      conversation_id: conversationId,
      turns: [{ role: "user", content: text, timestamp }],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 5000),
  });
  if (!res.ok) {
    throw new Error(`ZYND /ingest returned ${res.status}`);
  }
}
