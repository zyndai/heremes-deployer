import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createAgentSchema } from "@/lib/validation";
import { uniqueSlug } from "@/lib/slug";
import { prisma } from "@/lib/db";
import { ownerWhere, healStale } from "@/lib/ownership";
import { writeSecret, generateApiKey } from "@/lib/secrets";
import { mintWsToken } from "@/lib/ws-token";
import { resolveCloudflareAccountId, CloudflareAccountError } from "@/lib/cloudflare";

// age/Prisma + node crypto require the Node runtime, not the edge runtime.
export const runtime = "nodejs";

// The deploy socket token is short-lived; the browser opens the socket
// immediately after create. 5 minutes covers a slow page load + boot.
const WS_TOKEN_TTL_SEC = 300;

const PROVIDER_TO_ENV = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  cloudflare: "CLOUDFLARE_API_KEY",
} as const;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await prisma.agent.findMany({
    where: ownerWhere(user),
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      userId: true,
      name: true,
      slug: true,
      status: true,
      hostUrl: true,
      personalityId: true,
      personaLinked: true,
      hermesVersion: true,
      createdAt: true,
    },
  });
  await healStale(user, rows);
  // Re-shape without the internal userId — the client never needs it.
  const agents = rows.map((a) => ({
    id: a.id,
    name: a.name,
    slug: a.slug,
    status: a.status,
    hostUrl: a.hostUrl,
    personalityId: a.personalityId,
    personaLinked: a.personaLinked,
    hermesVersion: a.hermesVersion,
    createdAt: a.createdAt,
  }));
  return NextResponse.json({ agents });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = createAgentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid input" },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // Cloudflare agents need an account id (the Workers AI endpoint URL embeds it).
  // If the user didn't paste one, auto-detect it from their token. Do this before
  // creating the row so a detection failure returns a clean 400 with no orphan.
  let cfAccountId = body.cfAccountId;
  if (body.llmProvider === "cloudflare" && !cfAccountId) {
    try {
      cfAccountId = await resolveCloudflareAccountId(body.llmKey);
    } catch (err) {
      if (err instanceof CloudflareAccountError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  const slug = uniqueSlug(body.name);
  const tenantId = `${user.id}-${body.name}`;

  try {
    // Insert first to get the cuid, then write the secret keyed by that id.
    // Status starts `queued` — the worker (single writer) drives it forward.
    const agent = await prisma.agent.create({
      data: {
        userId: user.id,
        // Anchor ownership on the stable email too, so this agent survives any
        // future session-id churn (see lib/ownership.ts).
        ownerEmail: user.email || null,
        name: body.name,
        slug,
        tenantId,
        status: "queued",
        llmProvider: body.llmProvider,
        secretRef: "", // filled in by the update below once we know the id
        ...(body.personalityId ? { personalityId: body.personalityId } : {}),
      },
      select: { id: true, slug: true, status: true },
    });

    // Encrypt {API_SERVER_KEY, <provider key>} to <dataRoot>/secrets/<id>.age
    // (spec §5). writeSecret takes a FLAT env record (see Shared-module
    // contract) — the same shape buildAgentEnv reads back at `starting`. The
    // raw key never lands on the Agent row; only the returned secretRef path does.
    // CF_ACCOUNT_ID rides in the secret blob: the worker needs it to build the
    // per-account Workers AI endpoint URL in the seeded config.yaml, and the
    // blob is the only worker-readable channel that never touches the Agent row.
    const secretRef = await writeSecret(agent.id, {
      API_SERVER_KEY: generateApiKey(),
      [PROVIDER_TO_ENV[body.llmProvider]]: body.llmKey,
      ...(body.llmProvider === "cloudflare" && cfAccountId
        ? { CF_ACCOUNT_ID: cfAccountId }
        : {}),
    });
    await prisma.agent.update({ where: { id: agent.id }, data: { secretRef } });

    const wsToken = mintWsToken(agent.id, user.id, WS_TOKEN_TTL_SEC);
    return NextResponse.json(
      { id: agent.id, slug: agent.slug, status: agent.status, wsToken },
      { status: 201 },
    );
  } catch (err) {
    // A unique-constraint collision (slug/tenantId) is the expected user-facing
    // conflict; everything else is a 500 with no key echo (the body holds the LLM key).
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json(
        { error: "an agent with that name already exists" },
        { status: 409 },
      );
    }
    console.error("agent create failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not create the agent." }, { status: 500 });
  }
}
