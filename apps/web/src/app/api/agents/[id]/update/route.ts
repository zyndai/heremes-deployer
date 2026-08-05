import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ownerWhere, healOwnership } from "@/lib/ownership";
import { mintWsToken } from "@/lib/ws-token";

export const runtime = "nodejs";

// Token TTL for the update progress WebSocket connection — long enough for the
// full update flow (pull + stop + start + health check = ~30-90s).
const WS_TOKEN_TTL_SEC = 300;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as { targetVersion?: string };
  if (!body.targetVersion || typeof body.targetVersion !== "string") {
    return NextResponse.json({ error: "targetVersion is required" }, { status: 400 });
  }

  const agent = await prisma.agent.findFirst({
    where: { id, ...ownerWhere(user) },
    select: { id: true, userId: true, status: true },
  });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (agent.userId !== user.id) await healOwnership(user, agent.id);

  // Only running agents can be updated — a stopped/crashed agent has no
  // container to swap, and a queued agent isn't deployed yet.
  if (agent.status !== "running") {
    return NextResponse.json(
      { error: "agent must be running to update (current status: " + agent.status + ")" },
      { status: 409 },
    );
  }

  // Prevent re-queuing an already-in-flight update.
  const alreadyUpdating = await prisma.agent.findFirst({
    where: { id, status: "updating" },
    select: { id: true },
  });
  if (alreadyUpdating) {
    return NextResponse.json({ error: "an update is already in progress" }, { status: 409 });
  }

  await prisma.agent.update({
    where: { id },
    data: {
      status: "updating",
      targetHermesVersion: body.targetVersion,
    },
  });

  const wsToken = mintWsToken(agent.id, user.id, WS_TOKEN_TTL_SEC);
  return NextResponse.json({ wsToken });
}
