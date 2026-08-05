// Owner-only gate for the per-agent dashboard (spec §5, decision 1).
//
// The agent container is configured with HERMES_DASHBOARD_BASIC_AUTH_USERNAME/PASSWORD
// (v>0.16.0 requires an auth provider). Caddy injects the Authorization header
// transparently so the owner never sees the Hermes login screen. Caddy is still
// the real trust boundary. Each agent route
// runs a forward_auth subrequest to the worker before proxying to the
// container; this module answers those subrequests.
//
// Two endpoints, both reached on the agent's OWN subdomain (Caddy routes
// /__hermes_* to the worker and injects X-Hermes-Agent: <agentId>):
//
//   GET /__hermes_gate?token=<short-lived owner token>
//     Verifies the token was minted (by the web app) for THIS agent, then
//     sets a longer-lived signed cookie scoped host-only to this subdomain and
//     302s to "/". This is where the browser lands when the owner clicks Open.
//
//   GET /__hermes_check   (called by Caddy forward_auth, never by the client)
//     Verifies the cookie's signature/expiry and that it was minted for THIS
//     agent. 204 → Caddy proceeds to the container; 401 → Caddy blocks.
//
// Security model: tokens are HMAC-signed over the agentId (ws-auth.ts), so a
// token/cookie minted for one agent cannot authorize another. The cookie is
// host-only (no Domain attribute) so it never leaks across subdomains, and the
// forward_auth check re-binds it to the agentId Caddy declares for the host —
// closing the "set a valid cookie for my own agent, replay on another's
// subdomain" path.

import { mintToken, verifyToken } from "./ws-auth";
import { config } from "./config";

export const GATE_COOKIE_NAME = "hermes_gate";

// Paths the worker http server answers for the gate. /__hermes_check is only
// ever called by Caddy's forward_auth subrequest, but routing it through the
// same prefix keeps the Caddy config to a single match.
export const GATE_OPEN_PATH = "/__hermes_gate";
export const GATE_CHECK_PATH = "/__hermes_check";

export interface GateResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

// HttpOnly: JS can't read it. Secure: TLS only. SameSite=Lax: still sent on the
// top-level navigation that arrives from the web app's open redirect. Host-only
// (no Domain): the browser scopes it to this exact subdomain.
function setCookieHeader(value: string, ttlSec: number): string {
  return [
    `${GATE_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${ttlSec}`,
  ].join("; ");
}

/**
 * Handle GET /__hermes_gate. `token` is the short-lived owner token from the
 * web app's open redirect; `agentId` is what Caddy declares for this host.
 * On success mints a fresh host-only cookie for this agent and 302s to "/".
 */
export function handleGateOpen(opts: { token: string | null; agentId: string }): GateResponse {
  if (!opts.token || !opts.agentId) {
    return { status: 400, headers: {}, body: "missing token" };
  }
  const verdict = verifyToken(opts.token, opts.agentId);
  if (!verdict.ok) {
    // Never echo the reason — it would let an attacker tell expiry from forgery.
    return { status: 401, headers: {}, body: "unauthorized" };
  }
  const cookie = mintToken(opts.agentId, verdict.userId, config.gateCookieTtlSec);
  return {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": setCookieHeader(cookie, config.gateCookieTtlSec),
      "Cache-Control": "no-store",
    },
    body: "",
  };
}

/**
 * Handle Caddy's forward_auth subrequest. 204 authorizes the proxy to the
 * container; 401 blocks it. Verifies the cookie was minted for THIS agent.
 */
export function handleGateCheck(opts: {
  cookieHeader: string | undefined;
  agentId: string;
}): GateResponse {
  const cookie = parseCookie(opts.cookieHeader, GATE_COOKIE_NAME);
  if (!cookie || !opts.agentId) {
    return { status: 401, headers: {}, body: "unauthorized" };
  }
  const verdict = verifyToken(cookie, opts.agentId);
  if (!verdict.ok) {
    return { status: 401, headers: {}, body: "unauthorized" };
  }
  return { status: 204, headers: {}, body: "" };
}
