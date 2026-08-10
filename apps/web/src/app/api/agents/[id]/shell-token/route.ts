import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ownerWhere, healOwnership } from "@/lib/ownership";
import { mintWsToken } from "@/lib/ws-token";

// crypto (HMAC) needs the Node runtime, not edge.
export const runtime = "nodejs";

// Short-lived: only has to survive the client opening the WebSocket right
// after fetching this. The socket itself doesn't re-check the token once
// connected (same as the deploy socket, ws.ts handleSession).
const SHELL_TOKEN_TTL_SEC = 60;

// Owner-only mint for the terminal WebSocket. Unlike /open (which redirects
// through the dashboard gate cookie), this returns JSON: the caller is
// browser JS building a `new WebSocket(...)` URL, not a top-level navigation.
// The URL is built from the agent's OWN subdomain (hostUrl), not the worker's
// raw wsPort — cross-origin WSS straight to the worker's port is unreliable
// in prod (see useDeploySocket.ts's polling fallback); routing through Caddy
// on 443 is the path that's actually proven to work (the dashboard's own
// WS endpoints already rely on it).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const agent = await prisma.agent.findFirst({
    where: { id, ...ownerWhere(user) },
    select: { id: true, userId: true, hostUrl: true, status: true },
  });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (agent.userId !== user.id) await healOwnership(user, agent.id);
  if (!agent.hostUrl) {
    return NextResponse.json({ error: "agent has no dashboard yet" }, { status: 409 });
  }
  if (agent.status !== "running") {
    return NextResponse.json({ error: "agent is not running" }, { status: 409 });
  }

  const token = mintWsToken(agent.id, user.id, SHELL_TOKEN_TTL_SEC);
  const wsUrl = new URL(`/v1/agents/${agent.id}/shell`, agent.hostUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("token", token);

  return NextResponse.json({ wsUrl: wsUrl.toString() });
}
