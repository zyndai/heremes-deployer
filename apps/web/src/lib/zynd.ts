// Config for the "Connect Zynd Persona" OAuth flow against the memory-layer
// (ZYND). These env values MUST match memory-layer's oauth settings:
//   ZYND_OAUTH_CLIENT_ID     ⇄ deployer_oauth_client_id
//   ZYND_OAUTH_CLIENT_SECRET ⇄ deployer_oauth_client_secret
// The client secret is confidential and used only server-side (route handlers).

export function zyndMemoryBaseUrl(): string {
  return (process.env.ZYND_MEMORY_URL ?? "https://api.zynd.ai").replace(/\/+$/, "");
}

export function zyndOauthClientId(): string {
  return process.env.ZYND_OAUTH_CLIENT_ID ?? "hermes-deployer";
}

// Empty when unconfigured — callers must treat that as "connect disabled" and
// fail with a clear error rather than sending an empty secret to the token
// endpoint (which would 401).
export function zyndOauthClientSecret(): string {
  return process.env.ZYND_OAUTH_CLIENT_SECRET ?? "";
}

// The PUBLIC deployer origin, used both to build the OAuth redirect_uri and for
// the post-auth browser redirects. Prefer an explicit DEPLOYER_PUBLIC_URL; else
// fall back to the request's OWN origin.
//
// SECURITY: we deliberately do NOT read x-forwarded-host / host. A reverse proxy
// that forwards a client-supplied x-forwarded-host would let an attacker steer
// the post-auth redirect to their domain (open redirect) and forge the
// redirect_uri. Prod MUST set DEPLOYER_PUBLIC_URL; behind a proxy without it the
// redirect_uri falls back to the request origin and memory-layer's allowlist
// fails the flow closed rather than trusting a spoofable header.
export function deployerOrigin(req: Request): string {
  const configured = process.env.DEPLOYER_PUBLIC_URL;
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(req.url).origin;
}

// The redirect_uri sent to /oauth/authorize and echoed at /oauth/token. Built
// from the request origin so it works for both localhost:3100 and the prod
// deployer host — both are allowlisted in memory-layer.
export function zyndCallbackUrl(origin: string, agentId: string): string {
  return `${origin.replace(/\/+$/, "")}/api/agents/${agentId}/zynd/callback`;
}
