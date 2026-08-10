import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise addRoute's subdomain + dashboard-auth branch. config reads these at
// import, so they must be set before the static import below.
vi.hoisted(() => {
  process.env.HERMES_IMAGE ??= "ghcr.io/test/hermes:latest";
  process.env.DEPLOYER_AGENT_SUBDOMAIN_BASE = "agents.example.io";
  process.env.DEPLOYER_DASHBOARD_AUTH = "true";
  process.env.DEPLOYER_WS_PORT = "7072";
});

import { addRoute, removeRoute } from "../src/caddy.js";

const ADMIN = "http://127.0.0.1:2019";
const SERVER = "srv0";

interface Call {
  path: string;
  method: string;
  init: RequestInit | undefined;
}
let calls: Call[];

function mockResponse(r: { ok: boolean; status: number; body: unknown }): Response {
  return {
    ok: r.ok,
    status: r.status,
    json: async () => r.body,
    text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
  } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.startsWith(ADMIN) ? url.slice(ADMIN.length) : url;
      const method = init?.method ?? "GET";
      calls.push({ path, method, init });
      if (method === "GET" && path.endsWith("/routes")) {
        return mockResponse({ ok: true, status: 200, body: [{ "@id": "other", match: [], handle: [] }] });
      }
      if (method === "PATCH" && path.endsWith("/routes")) {
        return mockResponse({ ok: true, status: 200, body: "" });
      }
      if (method === "DELETE") return mockResponse({ ok: true, status: 200, body: "" });
      return mockResponse({ ok: false, status: 404, body: "no route" });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("addRoute (subdomain + dashboard auth)", () => {
  it("prepends a gate route then a forward_auth'd container route", async () => {
    await addRoute("agent_1", "my-bot", 13002);

    const patch = calls.find((c) => c.method === "PATCH" && c.path.endsWith("/routes"));
    const next = JSON.parse(patch!.init!.body as string);

    // Order: gate route, ws-passthrough route, owner-shell WS route, gated
    // container route, "other".
    expect(next[0]["@id"]).toBe("agent_1::gate");
    expect(next[1]["@id"]).toBe("agent_1::ws");
    expect(next[2]["@id"]).toBe("agent_1::shellws");
    expect(next[3]["@id"]).toBe("agent_1");
    expect(next[4]["@id"]).toBe("other");

    // Gate route: matches /__hermes_gate on the agent host, proxies to the
    // worker port, and tags the request with the agent id.
    const host = "my-bot.agents.example.io";
    expect(next[0].match[0].host).toEqual([host]);
    expect(next[0].match[0].path).toContain("/__hermes_gate");
    expect(next[0].handle[0].upstreams[0].dial).toBe("127.0.0.1:7072");
    expect(next[0].handle[0].headers.request.set["X-Hermes-Agent"]).toEqual(["agent_1"]);

    // WS-passthrough route: the dashboard WS/event paths, proxied straight to
    // the dashboard with NO forward_auth (so the upgrade headers survive), and
    // ordered before the gated catch-all.
    const ws = next[1];
    expect(ws.match[0].host).toEqual([host]);
    expect(ws.match[0].path).toEqual(["/api/ws", "/api/pub", "/api/pty", "/api/events"]);
    expect(ws.handle).toHaveLength(1);
    expect(ws.handle[0].handler).toBe("reverse_proxy");
    expect(ws.handle[0].upstreams[0].dial).toBe("127.0.0.1:13002");

    // Owner-shell WS route: path-scoped to this agent's own shell path, no
    // forward_auth (same reasoning as the ws-passthrough route — upgrade
    // headers must survive), proxied to the WORKER (not the dashboard port).
    const shellWs = next[2];
    expect(shellWs.match[0].host).toEqual([host]);
    expect(shellWs.match[0].path).toEqual(["/v1/agents/agent_1/shell"]);
    expect(shellWs.handle).toHaveLength(1);
    expect(shellWs.handle[0].handler).toBe("reverse_proxy");
    expect(shellWs.handle[0].upstreams[0].dial).toBe("127.0.0.1:7072");

    // Container route: forward_auth FIRST (so a failed check blocks), then the
    // real proxy to the dashboard port.
    const gated = next[3];
    expect(gated.match[0].host).toEqual([host]);
    expect(gated.handle[0].handler).toBe("reverse_proxy");
    expect(gated.handle[0].rewrite.uri).toBe("/__hermes_check");
    expect(gated.handle[0].upstreams[0].dial).toBe("127.0.0.1:7072");
    expect(gated.handle[0].handle_response[0].match.status_code).toEqual([2]);
    expect(gated.handle[1].upstreams[0].dial).toBe("127.0.0.1:13002");
  });

  it("removeRoute deletes the container, gate, ws, and shellws routes", async () => {
    await removeRoute("agent_1");
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes).toContain("/id/agent_1");
    expect(deletes).toContain("/id/agent_1::gate");
    expect(deletes).toContain("/id/agent_1::ws");
    expect(deletes).toContain("/id/agent_1::shellws");
  });
});

describe("addRoute (subdomain, dashboard auth OFF)", () => {
  it("still registers the owner-shell WS route ahead of the open container catch-all", async () => {
    // #given dashboardAuth is off (module-level flag flipped for this block)
    process.env.DEPLOYER_DASHBOARD_AUTH = "false";
    vi.resetModules();
    const { addRoute: addRouteNoAuth } = await import("../src/caddy.js");

    // #when a route is added
    await addRouteNoAuth("agent_2", "open-bot", 13005);

    // #then the shell WS route precedes the open (ungated) container route —
    // shell access must never depend on the dashboard-cookie flag, and Caddy
    // is first-match-wins so ordering is what makes that true.
    const patch = calls.find((c) => c.method === "PATCH" && c.path.endsWith("/routes"));
    const next = JSON.parse(patch!.init!.body as string);
    expect(next[0]["@id"]).toBe("agent_2::shellws");
    expect(next[0].match[0].path).toEqual(["/v1/agents/agent_2/shell"]);
    expect(next[1]["@id"]).toBe("agent_2");

    process.env.DEPLOYER_DASHBOARD_AUTH = "true";
  });
});
