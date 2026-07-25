import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ownerWhere, healOwnership } from "@/lib/ownership";
import { mintWsToken } from "@/lib/ws-token";

// crypto (HMAC) needs the Node runtime, not edge.
export const runtime = "nodejs";

// Short-lived: only has to survive the WS upgrade handshake. The live session
// persists after connect and is bounded by the worker's idle/lifetime caps.
const TERMINAL_TOKEN_TTL_SEC = 300;

// Owner-only: mint a token bound to this agent so the caller can open a shell
// into its container over the worker WS (/v1/agents/<id>/terminal). The worker
// re-verifies the token, re-checks ownership, and resolves the container id
// server-side — the client never names a container or command.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const agent = await prisma.agent.findFirst({
    where: { id, ...ownerWhere(user) },
    select: { id: true, userId: true, status: true },
  });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (agent.userId !== user.id) await healOwnership(user, agent.id);
  if (agent.status !== "running") {
    return NextResponse.json({ error: "agent is not running" }, { status: 409 });
  }

  const token = mintWsToken(agent.id, user.id, TERMINAL_TOKEN_TTL_SEC);
  return NextResponse.json({ token });
}
