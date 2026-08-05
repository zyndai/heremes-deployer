import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ownerWhere, healOwnership } from "@/lib/ownership";
import { updateAgentVersion } from "@/lib/provisioner";

export const runtime = "nodejs";
// Extend the timeout for the long-running ECS update (task swap + health check).
export const maxDuration = 120; // seconds (Vercel Pro)

const IS_AWS = process.env.HERMES_RUNTIME === "aws";

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
    select: { id: true, userId: true, status: true, name: true, slug: true, tenantId: true },
  });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (agent.userId !== user.id) await healOwnership(user, agent.id);

  // Allow retry from "failed" — a prior update may have set this status before
  // any ECS call succeeded, leaving the original task still running.
  if (agent.status !== "running" && agent.status !== "failed") {
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

  const targetVersion = body.targetVersion;
  // Derive the target Docker image tag from the version.
  // HERMES_IMAGE is e.g. "nousresearch/hermes-agent:latest" — swap the tag.
  const hermesImage = process.env.HERMES_IMAGE ?? "nousresearch/hermes-agent:latest";
  const imagePrefix = hermesImage.replace(/:[^:]+$/, "");
  const targetImage = `${imagePrefix}:${targetVersion}`;

  // Mark as updating so the frontend can poll for completion.
  await prisma.agent.update({
    where: { id },
    data: {
      status: "updating",
      targetHermesVersion: targetVersion,
    },
  });

  const tenantId = agent.tenantId;

  // Run the actual ECS update. If it fails, mark the agent as failed and
  // surface the error to the client. The frontend polls /api/agents/[id]
  // to pick up the running/failed status + updated hermesVersion.
  try {
    if (IS_AWS) {
      const result = await updateAgentVersion(user.id, tenantId, targetImage);
      await prisma.agent.update({
        where: { id },
        data: {
          status: "running",
          hermesVersion: targetVersion,
          targetHermesVersion: null,
        },
      });
      return NextResponse.json({
        ok: true,
        version: targetVersion,
        ip: result.ip,
      });
    }

    // Non-AWS (Docker) path: the worker drains "updating" status via drainUpdates().
    // Return immediately — the worker will handle the container swap.
    return NextResponse.json({ ok: true, version: targetVersion });
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    console.error(`[update] failed for agent ${agent.slug}:`, msg);
    await prisma.agent.update({
      where: { id },
      data: {
        status: "failed",
        errorMessage: `Update to ${targetVersion} failed: ${msg}`,
        targetHermesVersion: null,
      },
    });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
