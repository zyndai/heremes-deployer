// Worker WebSocket server for the live deploy view (spec §2).
//
// Path:  /v1/agents/<agentId>/deploy?token=<short-lived owner token>
// Frames (JSON, type-tagged): hello | step | log | ready | done | error
//
// Independent of Next.js for the same reason as the zynd logs server: App
// Router route handlers can't upgrade a request to a WebSocket. Differs from
// zynd's open logs socket in two ways (spec §5): the upgrade is gated on an
// owner token, and on connect we backfill the step ring + DB status so a
// reconnect mid-deploy lands on the right checklist step.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import { prisma } from "./db";
import { config } from "./config";
import { verifyToken } from "./ws-auth";
import {
  GATE_OPEN_PATH,
  GATE_CHECK_PATH,
  handleGateOpen,
  handleGateCheck,
} from "./dashboard-gate";
import { subscribe, snapshotSteps, type Frame } from "./events";
import { parseShellPath, handleShellSession } from "./shell";

// The deploy socket sends the events.ts Frame union plus a `hello` handshake
// frame that only the WS layer emits.
export type DeployFrame = Frame | { type: "hello"; agentId: string; status: string };

const PING_MS = 25_000;

// Terminal statuses end a deploy session: the worker sends `done` and closes.
// `running` is the success terminal but stays OPEN (logs keep streaming) — it
// is deliberately NOT in this set.
const TERMINAL_STATUSES = ["failed", "stopped", "crashed"] as const;

export interface DeployPath {
  agentId: string;
  token: string;
}

export function parseDeployPath(url: string | undefined): DeployPath | null {
  if (!url) return null;
  const u = new URL(url, "http://placeholder");
  // Expect exactly /v1/agents/<agentId>/deploy
  const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 4) return null;
  if (parts[0] !== "v1" || parts[1] !== "agents" || parts[3] !== "deploy") return null;
  const agentId = decodeURIComponent(parts[2] ?? "");
  if (!agentId) return null;
  const token = u.searchParams.get("token");
  if (!token) return null;
  return { agentId, token };
}

export function buildHello(agentId: string, status: string): DeployFrame {
  return { type: "hello", agentId, status };
}

function send(ws: WebSocket, frame: DeployFrame): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(frame));
}

function isTerminal(status: string): status is (typeof TERMINAL_STATUSES)[number] {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

async function handleSession(ws: WebSocket, agentId: string, token: string): Promise<void> {
  const verdict = verifyToken(token, agentId);
  if (!verdict.ok) {
    // 4401 = unauthorized (private use range). Never echo the reason to the
    // client — it would let an attacker distinguish expiry from forgery.
    ws.close(4401, "unauthorized");
    return;
  }

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { userId: true, status: true },
  });
  if (!agent) {
    ws.close(4404, "not_found");
    return;
  }
  // Tenancy: the token user must own the row (spec §3 — every :id is owner-checked).
  if (agent.userId !== verdict.userId) {
    ws.close(4403, "forbidden");
    return;
  }

  // DB is source of truth: hello carries the persisted status so a reconnect
  // lands on the real current step even if the in-memory ring was cleared.
  send(ws, buildHello(agentId, agent.status));

  // Replay the steps emitted before this socket attached.
  for (const frame of snapshotSteps(agentId)) send(ws, frame);

  // If we reconnected after the deploy already finished, close it out now —
  // no live frames will ever arrive for a terminal agent.
  if (isTerminal(agent.status)) {
    send(ws, { type: "done", status: agent.status });
    ws.close(1000, "done");
    return;
  }

  const unsubscribe = subscribe(agentId, (frame) => {
    send(ws, frame);
    if (frame.type === "done") {
      try {
        ws.close(1000, "done");
      } catch {
        // Already closing — nothing to do.
      }
    }
  });

  // ws keepalive: terminate a peer that misses a pong (dead TCP, sleeping tab).
  let alive = true;
  const pingHandle = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      // Socket gone between the readyState check and ping — the close handler cleans up.
    }
  }, PING_MS);
  ws.on("pong", () => {
    alive = true;
  });

  ws.on("close", () => {
    clearInterval(pingHandle);
    unsubscribe();
  });
}

// Caddy routes /__hermes_* on each agent subdomain to this server and injects
// the agent id via X-Hermes-Agent. Returns true when the request was a gate
// request (and a response was written), false to fall through to the WS hint.
function handleGateHttp(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const agentId = headerValue(req, "x-hermes-agent");

  if (url.pathname === GATE_OPEN_PATH) {
    const r = handleGateOpen({ token: url.searchParams.get("token"), agentId });
    res.writeHead(r.status, r.headers);
    res.end(r.body);
    return true;
  }
  if (url.pathname === GATE_CHECK_PATH) {
    const r = handleGateCheck({ cookieHeader: req.headers.cookie, agentId });
    res.writeHead(r.status, r.headers);
    res.end(r.body);
    return true;
  }
  return false;
}

function headerValue(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export interface WsHandle {
  address(): ReturnType<import("node:net").Server["address"]>;
  close(): void;
}

export function startWsServer(): Promise<WsHandle | null> {
  const port = config.wsPort;
  if (!port || port <= 0) {
    console.log("[ws] disabled (DEPLOYER_WS_PORT<=0)");
    return Promise.resolve(null);
  }

  const httpServer = createServer((req, res) => {
    if (handleGateHttp(req, res)) return;
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end(
      "Upgrade required: connect with ws(s)://<host>/v1/agents/<agentId>/deploy?token=<t> " +
        "or ws(s)://<host>/v1/agents/<agentId>/shell?token=<t>\n",
    );
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const deployPath = parseDeployPath(req.url);
    if (deployPath) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleSession(ws, deployPath.agentId, deployPath.token).catch((err) => {
          // Never surface internals to the client; an Agent row lookup can fail.
          console.error(`[ws] session ${deployPath.agentId} failed:`, err);
          try {
            send(ws, { type: "error", code: "internal", message: "internal error" });
            ws.close(1011, "internal");
          } catch {
            // Socket already gone.
          }
        });
      });
      return;
    }

    const shellPath = parseShellPath(req.url);
    if (shellPath) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleShellSession(ws, shellPath.agentId, shellPath.token).catch((err) => {
          console.error(`[ws] shell session ${shellPath.agentId} failed:`, err);
          try {
            ws.close(1011, "internal");
          } catch {
            // Socket already gone.
          }
        });
      });
      return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const addr = httpServer.address();
      const shown = typeof addr === "object" && addr ? addr.port : port;
      console.log(`[ws] listening on :${shown} (path /v1/agents/<agentId>/deploy)`);
      resolve({
        address: () => httpServer.address(),
        close: () => {
          wss.close();
          httpServer.close();
        },
      });
    });
  });
}
