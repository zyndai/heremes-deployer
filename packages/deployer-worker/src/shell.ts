// Owner-only interactive dev shell for an agent (spec: give each agent owner
// a terminal to set env/config and do real dev work themselves, scoped to
// that agent's own data — never the EC2 host, never another agent).
//
// Path:   /v1/agents/<agentId>/shell?token=<short-lived owner token>
// Wire:   client -> server: JSON text frames {type:"data",data} | {type:"resize",cols,rows}
//         server -> client: raw binary frames (the container's combined
//         stdout+stderr, Tty:true so Docker does NOT multiplex — unlike the
//         non-TTY logs() path in docker.ts, no 8-byte frame headers to strip)
//
// Reuses the exact deploy-WS trust model (ws-auth.ts HMAC token, agent+user
// bound) rather than Caddy's forward_auth cookie: this socket is reached
// either through Caddy (agent subdomain, reliable — see caddy.ts) or,
// same as the deploy socket, directly on the worker's wsPort, so the token
// check must hold on its own regardless of transport path.
//
// One EPHEMERAL container per session (docker.ts runToolboxContainer), not
// an exec into the gateway container: a separate, richer image
// (infra/hermes-toolbox-image — git/vim/nano/pip/build-essential) bind-
// mounted at the SAME /opt/data the gateway uses, so owners get a real dev
// environment and the terminal never touches the image that actually runs
// their agent. Scoping is otherwise identical to the exec approach: runs as
// HERMES_UID:HERMES_GID (never root), read-only rootfs (can't persist
// anything outside /opt/data + tmpfs /tmp,/run), isolated network (can't
// reach any other agent's container, gateway or toolbox). Torn down
// (stopAndRemove) when the WS closes — this container exists for exactly one
// terminal session.

import type { WebSocket } from "ws";

import { prisma } from "./db";
import { docker, runToolboxContainer, stopAndRemove } from "./docker";
import { config, paths } from "./config";
import { verifyToken } from "./ws-auth";

export interface ShellPath {
  agentId: string;
  token: string;
}

/** Mirrors ws.ts's parseDeployPath, same URL shape, different last segment. */
export function parseShellPath(url: string | undefined): ShellPath | null {
  if (!url) return null;
  const u = new URL(url, "http://placeholder");
  const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 4) return null;
  if (parts[0] !== "v1" || parts[1] !== "agents" || parts[3] !== "shell") return null;
  const agentId = decodeURIComponent(parts[2] ?? "");
  if (!agentId) return null;
  const token = u.searchParams.get("token");
  if (!token) return null;
  return { agentId, token };
}

type ClientFrame =
  | { type: "data"; data: string }
  | { type: "resize"; cols: number; rows: number };

function parseClientFrame(raw: string): ClientFrame | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type === "data" && typeof m.data === "string") {
    return { type: "data", data: m.data };
  }
  if (
    m.type === "resize" &&
    typeof m.cols === "number" &&
    typeof m.rows === "number" &&
    Number.isFinite(m.cols) &&
    Number.isFinite(m.rows) &&
    m.cols > 0 &&
    m.rows > 0
  ) {
    return { type: "resize", cols: Math.floor(m.cols), rows: Math.floor(m.rows) };
  }
  return null;
}

export async function handleShellSession(
  ws: WebSocket,
  agentId: string,
  token: string,
): Promise<void> {
  const verdict = verifyToken(token, agentId);
  if (!verdict.ok) {
    // Never echo the reason — same rationale as the deploy socket: don't let
    // an attacker distinguish "expired" from "forged" by response shape.
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
  if (agent.userId !== verdict.userId) {
    ws.close(4403, "forbidden");
    return;
  }
  if (agent.status !== "running") {
    // 4409: agent exists and is owned, but isn't running (stopped/crashed/
    // still deploying) — the frontend only offers the Terminal tab when
    // running, but the server enforces it independently.
    ws.close(4409, "not_running");
    return;
  }
  if (!config.toolboxImage) {
    ws.close(4501, "toolbox_not_configured");
    return;
  }

  let toolboxId: string | null = null;
  let attachStream: NodeJS.ReadWriteStream | null = null;
  const cleanup = (): void => {
    const id = toolboxId;
    toolboxId = null;
    if (!id) return;
    stopAndRemove(id).catch((e) => {
      console.error(`[shell] agent=${agentId} toolbox=${id.slice(0, 12)} cleanup failed:`, e);
    });
  };

  try {
    toolboxId = await runToolboxContainer({ agentId, dataDir: paths.agentData(agentId) });
    const container = docker.getContainer(toolboxId);
    attachStream = await container.attach({
      hijack: true,
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
    });

    attachStream.on("data", (chunk: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    attachStream.on("error", () => {
      try {
        ws.close(1011, "attach_stream_error");
      } catch {
        // Socket already gone.
      }
    });
    attachStream.on("close", () => {
      try {
        ws.close(1000, "session_ended");
      } catch {
        // Socket already gone.
      }
      cleanup();
    });

    ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary || !attachStream) return;
      // Text frames only reach here; the ws library reassembles them into a
      // single Buffer by default (no fragmentation option is set anywhere in
      // this codebase), so this is exhaustive in practice — the fallback
      // just guards the RawData union rather than assuming it.
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : Buffer.concat(
        Array.isArray(raw) ? raw : [Buffer.from(raw)],
      ).toString("utf8");
      const frame = parseClientFrame(text);
      if (!frame) return;
      if (frame.type === "data") {
        attachStream.write(frame.data);
      } else {
        container.resize({ h: frame.rows, w: frame.cols }).catch(() => {
          // Resize is cosmetic (reflow) — a failure here shouldn't kill the
          // session, the shell just keeps the previous dimensions.
        });
      }
    });

    ws.on("close", () => {
      try {
        attachStream?.end();
      } catch {
        // Stream already gone.
      }
      cleanup();
    });
  } catch (e) {
    console.error(`[shell] agent=${agentId} toolbox session failed:`, (e as Error).message);
    try {
      attachStream?.end();
    } catch {
      // Stream never opened or already gone — nothing to clean up.
    }
    cleanup();
    try {
      ws.close(1011, "internal");
    } catch {
      // Socket already gone.
    }
  }
}
