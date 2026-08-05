import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ownerWhere, healOwnership } from "@/lib/ownership";

export const runtime = "nodejs";
export const maxDuration = 15;

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
    select: { id: true, userId: true, status: true, slug: true },
  });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (agent.userId !== user.id) await healOwnership(user, agent.id);

  if (agent.status !== "running" && agent.status !== "failed") {
    return NextResponse.json(
      { error: "agent must be running to update (current status: " + agent.status + ")" },
      { status: 409 },
    );
  }

  const alreadyUpdating = await prisma.agent.findFirst({
    where: { id, status: "updating" },
    select: { id: true },
  });
  if (alreadyUpdating) {
    return NextResponse.json({ error: "an update is already in progress" }, { status: 409 });
  }

  const targetVersion = body.targetVersion;

  // Set status to "updating" — the deployer-worker picks this up via
  // drainUpdates() in its main loop and handles the Docker container swap
  // (pull image, stop old, start new with same volume/ports, health check).
  await prisma.agent.update({
    where: { id },
    data: {
      status: "updating",
      targetHermesVersion: targetVersion,
      errorMessage: null,
    },
  });

  return NextResponse.json({ ok: true, version: targetVersion });
}
