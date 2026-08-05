// Tiny Caddy admin API client. Routes are keyed by agent id (@id) so we
// can update/delete them without walking the config tree.
//
// Assumes Caddy is configured at boot with an HTTPS server (cfg.caddyServerName)
// that has an @id-addressable routes array. See infra/Caddyfile.

import { config as cfg } from "./config";
import { GATE_OPEN_PATH, GATE_CHECK_PATH } from "./dashboard-gate";

// Caddy handlers we emit. Loose enough to cover the rewrite/reverse_proxy
// proxy chain plus the forward_auth reverse_proxy (which carries header
// injection + a handle_response branch that lets a 2xx fall through to the
// next handler while a non-2xx is returned to the client).
type CaddyHandler =
  | { handler: "rewrite"; strip_path_prefix: string }
  | {
      handler: "reverse_proxy";
      upstreams: Array<{ dial: string }>;
      rewrite?: { method?: string; uri?: string };
      headers?: { request?: { set?: Record<string, string[]> } };
      handle_response?: Array<{
        match: { status_code: number[] };
        routes: Array<{ handle: Array<{ handler: string }> }>;
      }>;
    };

interface CaddyRoute {
  "@id": string;
  match: Array<{ host?: string[]; path?: string[] }>;
  handle: CaddyHandler[];
}

// Caddy forward_auth, hand-authored for the admin API: proxy a GET subrequest
// to the worker's gate check, injecting the agent id. A 2xx response makes
// Caddy continue to the NEXT handler (the real container proxy); any non-2xx is
// returned to the client verbatim, blocking the dashboard. Mirrors the JSON the
// Caddyfile `forward_auth` directive expands to.
function forwardAuthHandler(agentId: string): CaddyHandler {
  return {
    handler: "reverse_proxy",
    rewrite: { method: "GET", uri: GATE_CHECK_PATH },
    headers: { request: { set: { "X-Hermes-Agent": [agentId] } } },
    upstreams: [{ dial: `127.0.0.1:${cfg.wsPort}` }],
    handle_response: [{ match: { status_code: [2] }, routes: [{ handle: [{ handler: "headers" }] }] }],
  };
}

// The public /__hermes_gate route (token → cookie). Routed to the worker, not
// the container, and tagged with the agent id so the worker can bind the cookie
// to this agent. Lives at a separate @id so removeRoute can drop it too.
function gateRouteId(agentId: string): string {
  return `${agentId}::gate`;
}

function wsRouteId(agentId: string): string {
  return `${agentId}::ws`;
}

// The dashboard's WebSocket + event-stream endpoints. forward_auth strips the
// `Upgrade`/`Connection` headers, so a gated WS upgrade arrives at the dashboard
// as a plain GET → 401 → the browser sees "session ended (1006)" and a dead
// event feed. These must bypass forward_auth and proxy straight through (Caddy
// reverse_proxy preserves the upgrade). They are NOT unprotected: each requires
// the dashboard's per-process session token (`?token=`), which is injected only
// into the index page — and that page IS behind the gate, so only the owner
// ever receives the token.
const DASHBOARD_WS_PATHS = ["/api/ws", "/api/pub", "/api/pty", "/api/events"];

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  // Caddy's admin API rejects requests whose Origin header isn't on the
  // configured allowlist. Node's fetch doesn't set Origin by default, so
  // the server sees origin '' and returns 403. Pin it to the admin URL
  // itself, which matches Caddy's default loopback allowlist
  // (127.0.0.1, localhost, ::1).
  return fetch(`${cfg.caddyAdminUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: cfg.caddyAdminUrl,
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Ensure the target Caddy server exists and has a `routes: []` array we
 * can append to. On a freshly-booted Caddy with no config loaded, the
 * HTTP app and the named server don't exist yet, so POST .../routes/...
 * fails with 500 {"error":"final element is not an array"} and every
 * single deploy is torn down. Idempotent: a server that already has a
 * routes array makes this a no-op.
 */
export async function ensureServer(): Promise<void> {
  if (cfg.skipCaddy) return;

  // Probe first — if the server already has a routes array we're done.
  const probe = await adminFetch(
    `/config/apps/http/servers/${cfg.caddyServerName}`,
    { method: "GET" },
  );
  if (probe.ok) {
    try {
      const body = (await probe.json()) as { routes?: unknown };
      if (Array.isArray(body.routes)) {
        return;
      }
    } catch {
      // probe returned 200 but not JSON — fall through and rewrite
    }
  }

  // Push the whole apps.http.servers.<name> sub-tree via POST /load.
  // /load (replaces full config) is the documented way to bootstrap from
  // an empty config; PUT to a missing parent path returns 4xx. We fetch
  // the existing config first so we don't blow away other apps.
  const currentRes = await adminFetch(`/config/`, { method: "GET" });
  let current: Record<string, unknown> = {};
  if (currentRes.ok) {
    try {
      current = (await currentRes.json()) as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  const merged = structuredClone(current ?? {}) as {
    apps?: {
      http?: {
        servers?: Record<string, { listen?: unknown; routes?: unknown }>;
      };
    };
  };
  merged.apps ??= {};
  merged.apps.http ??= {};
  merged.apps.http.servers ??= {};
  const existing = merged.apps.http.servers[cfg.caddyServerName] ?? {};
  merged.apps.http.servers[cfg.caddyServerName] = {
    listen:
      Array.isArray(existing.listen) && existing.listen.length > 0
        ? existing.listen
        : [":443"],
    ...existing,
    routes: Array.isArray(existing.routes) ? existing.routes : [],
  };

  const load = await adminFetch(`/load`, {
    method: "POST",
    body: JSON.stringify(merged),
  });
  if (!load.ok) {
    const text = await load.text();
    throw new Error(
      `Caddy ensureServer failed: POST /load returned ${load.status} ${text}`,
    );
  }

  // Re-probe to confirm the shape before we let addRoute run.
  const verify = await adminFetch(
    `/config/apps/http/servers/${cfg.caddyServerName}`,
    { method: "GET" },
  );
  if (!verify.ok) {
    throw new Error(
      `Caddy ensureServer: post-load probe returned ${verify.status}`,
    );
  }
  const verifyBody = (await verify.json()) as { routes?: unknown };
  if (!Array.isArray(verifyBody.routes)) {
    throw new Error(
      `Caddy ensureServer: server "${cfg.caddyServerName}" has routes=${typeof verifyBody.routes} after /load — expected array`,
    );
  }
}

/**
 * Route the agent's dashboard port behind `/<slug>`.
 *
 * Hermes differs from zynd: a single path segment `/<slug>` (no
 * entityType prefix), @id is the agentId, and the upstream is the
 * dashboard host port (container 9119), not the API port.
 */
export async function addRoute(
  agentId: string,
  slug: string,
  dashboardPort: number,
  dashboardBasicAuth?: { username: string; password: string },
): Promise<void> {
  if (cfg.skipCaddy) return;

  // Subdomain mode: match the agent's own host (<slug>.<base>) and proxy to its
  // dashboard port at root — no path strip. The dashboard's absolute /assets/*
  // requests then hit this same host and resolve. Caddy on-demand TLS mints the
  // cert for the new subdomain on first request.
  if (cfg.agentSubdomainBase) {
    const host = `${slug}.${cfg.agentSubdomainBase}`;
    // Inject Basic auth header so the owner never sees Hermes's own login screen.
    // Caddy's forward_auth gate is the real auth boundary; these credentials are
    // only used by Hermes to satisfy its v>0.16.0 requirement for an auth provider.
    const containerProxy: CaddyHandler = dashboardBasicAuth
      ? {
          handler: "reverse_proxy",
          upstreams: [{ dial: `127.0.0.1:${dashboardPort}` }],
          headers: {
            request: {
              set: {
                Authorization: [
                  `Basic ${Buffer.from(`${dashboardBasicAuth.username}:${dashboardBasicAuth.password}`).toString("base64")}`,
                ],
              },
            },
          },
        }
      : {
          handler: "reverse_proxy",
          upstreams: [{ dial: `127.0.0.1:${dashboardPort}` }],
        };

    if (!cfg.dashboardAuth) {
      await prependRoutes([
        { "@id": agentId, match: [{ host: [host] }], handle: [containerProxy] },
      ]);
      return;
    }

    // Two routes, gate first: the /__hermes_gate exchange must NOT itself be
    // gated, so it precedes the forward_auth'd container route.
    const gateRoute: CaddyRoute = {
      "@id": gateRouteId(agentId),
      match: [{ host: [host], path: [GATE_OPEN_PATH, `${GATE_OPEN_PATH}/*`] }],
      handle: [
        {
          handler: "reverse_proxy",
          headers: { request: { set: { "X-Hermes-Agent": [agentId] } } },
          upstreams: [{ dial: `127.0.0.1:${cfg.wsPort}` }],
        },
      ],
    };
    // WebSocket/event paths proxy straight to the dashboard (no forward_auth)
    // so the upgrade survives; ordered before the gated catch-all.
    const wsRoute: CaddyRoute = {
      "@id": wsRouteId(agentId),
      match: [{ host: [host], path: DASHBOARD_WS_PATHS }],
      handle: [containerProxy],
    };
    const gatedRoute: CaddyRoute = {
      "@id": agentId,
      match: [{ host: [host] }],
      handle: [forwardAuthHandler(agentId), containerProxy],
    };
    await prependRoutes([gateRoute, wsRoute, gatedRoute]);
    return;
  }

  // Legacy path-prefix mode on the single wildcardDomain.
  const host = cfg.wildcardDomain;
  const prefix = `/${slug}`;
  // Match the prefix exactly (so /<slug> with no trailing slash still
  // routes) AND any subpath: Caddy's `/<slug>/*` matcher excludes the
  // bare /<slug>.
  const route: CaddyRoute = {
    "@id": agentId,
    match: [{ host: [host], path: [prefix, `${prefix}/*`] }],
    handle: [
      { handler: "rewrite", strip_path_prefix: prefix },
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: `127.0.0.1:${dashboardPort}` }],
      },
    ],
  };
  await prependRoutes([route]);
}

// Prepend one or more routes (already in evaluation order) at HEAD, dropping any
// existing entry that shares an @id with one we're adding so redeploys don't
// accumulate duplicates. Multiple routes (gate + gated container) are inserted
// in the given order, ahead of the Caddyfile catch-all that forwards the bare
// domain to the Next UI (Caddy is first-match-wins).
async function prependRoutes(toAdd: CaddyRoute[]): Promise<void> {
  const path = `/config/apps/http/servers/${cfg.caddyServerName}/routes`;

  const readCurrent = async (): Promise<CaddyRoute[]> => {
    const r = await adminFetch(path, { method: "GET" });
    if (!r.ok) return [];
    const body = (await r.json()) as unknown;
    return Array.isArray(body) ? (body as CaddyRoute[]) : [];
  };

  let current = await readCurrent();
  if (current.length === 0) {
    // Empty, or the server itself is missing — bootstrap and re-read.
    await ensureServer();
    current = await readCurrent();
  }

  const addedIds = new Set(toAdd.map((r) => r["@id"]));
  const deduped = current.filter((r) => !addedIds.has(r["@id"]));
  const next = [...toAdd, ...deduped];

  // PATCH replaces the value at the path. PUT errors 409 "key already
  // exists" whenever the array is already present (every case but a
  // brand-new server).
  const res = await adminFetch(path, {
    method: "PATCH",
    body: JSON.stringify(next),
  });
  if (!res.ok) {
    throw new Error(
      `Caddy addRoute failed: PATCH ${path} returned ${res.status} ${await res.text()}`,
    );
  }
}

export async function removeRoute(agentId: string): Promise<void> {
  if (cfg.skipCaddy) return;
  // Delete the container route plus the (possibly-absent) gate + ws routes. 404
  // on any means it already went away — idempotent for the §5 rollback path.
  for (const id of [agentId, gateRouteId(agentId), wsRouteId(agentId)]) {
    const res = await adminFetch(`/id/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Caddy removeRoute failed: ${res.status} ${await res.text()}`);
    }
  }
}

export { adminFetch };
export type { CaddyRoute };
