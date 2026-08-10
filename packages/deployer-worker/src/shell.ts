// Owner-only interactive shell into an agent's OWN container (spec: give each
// agent owner a terminal to set env/config themselves, scoped to that one
// container — never the EC2 host, never another agent's container).
//
// Path:   /v1/agents/<agentId>/shell?token=<short-lived owner token>
// Wire:   client -> server: JSON text frames {type:"data",data} | {type:"resize",cols,rows}
//         server -> client: raw binary frames (exec's combined stdout+stderr,
//         Tty:true so Docker does NOT multiplex — unlike the non-TTY logs()
//         path in docker.ts, no 8-byte frame headers to strip here)
//
// Reuses the exact deploy-WS trust model (ws-auth.ts HMAC token, agent+user
// bound) rather than Caddy's forward_auth cookie: this socket is reached
// either through Caddy (agent subdomain, reliable — see caddy.ts) or,
// same as the deploy socket, directly on the worker's wsPort, so the token
// check must hold on its own regardless of transport path.
//
// Container-scoping (not host-scoping): dockerode's container.exec() runs
// INSIDE that container's namespaces by construction — there is no path from
// here to the host shell. The exec runs as HERMES_UID:HERMES_GID (not root),
// matching the main gateway process, so it inherits the same confinement as
// the app itself: read-only rootfs (can't touch the image), writable only in
// /opt/data and the tmpfs /tmp,/run (see docker.ts runContainer). Sibling
// agent containers are unreachable too (isolated network, see
// ensureAgentNetwork in docker.ts) — a compromised shell can't pivot to them.

import type { WebSocket } from "ws";

import { prisma } from "./db";
import { docker } from "./docker";
import { HERMES_UID, HERMES_GID } from "./config";
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
    select: { userId: true, status: true, containerId: true },
  });
  if (!agent) {
    ws.close(4404, "not_found");
    return;
  }
  if (agent.userId !== verdict.userId) {
    ws.close(4403, "forbidden");
    return;
  }
  if (agent.status !== "running" || !agent.containerId) {
    // 4409: agent exists and is owned, but there's no live container to exec
    // into (stopped/crashed/still deploying). Distinct from 4404/4403 so the
    // client can show "agent isn't running" instead of a generic error.
    ws.close(4409, "not_running");
    return;
  }

  let execStream: NodeJS.ReadWriteStream | null = null;
  try {
    const container = docker.getContainer(agent.containerId);
    const exec = await container.exec({
      // sh is the portable baseline (alpine images ship ash as /bin/sh, not
      // bash); prefer bash when present without hard-failing when it isn't.
      Cmd: ["/bin/sh", "-c", "exec bash 2>/dev/null || exec sh"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      // Same uid:gid as the gateway process itself (docker.ts runContainer) —
      // never root. Read-only rootfs + this uid caps what a shell can touch
      // to /opt/data and the /tmp,/run tmpfs, same as the app's own blast
      // radius. No new privilege the app doesn't already have.
      User: `${HERMES_UID}:${HERMES_GID}`,
      WorkingDir: "/opt/data",
    });
    execStream = await exec.start({ hijack: true, stdin: true, Tty: true });

    execStream.on("data", (chunk: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    execStream.on("error", () => {
      try {
        ws.close(1011, "exec_stream_error");
      } catch {
        // Socket already gone.
      }
    });
    execStream.on("close", () => {
      try {
        ws.close(1000, "exec_ended");
      } catch {
        // Socket already gone.
      }
    });

    ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary || !execStream) return;
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
        execStream.write(frame.data);
      } else {
        exec.resize({ h: frame.rows, w: frame.cols }).catch(() => {
          // Resize is cosmetic (reflow) — a failure here shouldn't kill the
          // session, the shell just keeps the previous dimensions.
        });
      }
    });

    ws.on("close", () => {
      try {
        execStream?.end();
      } catch {
        // Stream already gone.
      }
    });
  } catch (e) {
    console.error(`[shell] agent=${agentId} exec failed:`, (e as Error).message);
    try {
      execStream?.end();
    } catch {
      // Stream never opened or already gone — nothing to clean up.
    }
    try {
      ws.close(1011, "internal");
    } catch {
      // Socket already gone.
    }
  }
}
